use crate::parser::GenerationParams;
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION},
    StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::error::Error;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgePayload {
    pub prompt: String,
    pub negative_prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampler_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cfg_scale: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_settings: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub send_images: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_images: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alwayson_scripts: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n_iter: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeStatus {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeSendResult {
    pub ok: bool,
    pub images: Vec<String>,
    pub info: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeUpscalePayload {
    pub image: String,
    pub upscaler_1: String,
    pub upscaling_resize: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upscaler_2: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extras_upscaler_2_visibility: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeUpscaleResult {
    pub ok: bool,
    pub image: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ForgeTxt2ImgResponse {
    #[serde(default)]
    images: Vec<String>,
    info: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ForgeExtraSingleImageResponse {
    pub image: Option<String>,
    #[allow(dead_code)]
    pub html_info: Option<String>,
}

const SDAPI_PREFIX: &str = "/sdapi/v1";
const TEST_TIMEOUT_SECONDS: u64 = 60;
const SEND_TIMEOUT_SECONDS: u64 = 600;
const DEFAULT_ADETAILER_FACE_MODEL: &str = "face_yolov8n.pt";

pub async fn test_connection(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<ForgeStatus, Box<dyn Error + Send + Sync>> {
    let warning = validate_base_url(base_url).map_err(std::io::Error::other)?;
    let client = build_client(api_key, TEST_TIMEOUT_SECONDS)?;
    let endpoint = build_sdapi_endpoint(base_url, "samplers");

    let response = client.get(&endpoint).send().await?;
    if response.status().is_success() {
        let message = if let Some(w) = warning {
            format!("Connected to Forge/A1111 API. {}", w)
        } else {
            "Connected to Forge/A1111 API".to_string()
        };
        return Ok(ForgeStatus { ok: true, message });
    }

    let status = response.status();
    let message = if status == StatusCode::NOT_FOUND {
        format!(
            "Connection failed with status {} at {}. Start Forge with --api and use a base URL like http://127.0.0.1:7860 (without /sdapi/v1).",
            status, endpoint
        )
    } else {
        format!("Connection failed with status {} at {}", status, endpoint)
    };

    Ok(ForgeStatus { ok: false, message })
}

async fn read_bounded_bytes(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
    let mut buffer = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if buffer.len() + chunk.len() > max_bytes {
            return Err(std::io::Error::other(format!(
                "Response size exceeded limit of {} bytes",
                max_bytes
            ))
            .into());
        }
        buffer.extend_from_slice(&chunk);
    }
    Ok(buffer)
}

async fn extract_error_message(
    response: reqwest::Response,
    endpoint: &str,
    fallback_not_found: bool,
) -> String {
    let status = response.status();
    const MAX_ERROR_BODY_BYTES: usize = 4096;
    let err_text = match read_bounded_bytes(response, MAX_ERROR_BODY_BYTES).await {
        Ok(bytes) => {
            if let Ok(err_json) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                err_json
                    .get("message")
                    .or_else(|| err_json.get("detail"))
                    .or_else(|| err_json.get("error"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| String::from_utf8_lossy(&bytes).trim().to_string())
            } else {
                String::from_utf8_lossy(&bytes).trim().to_string()
            }
        }
        Err(_) => String::new(),
    };

    if status == StatusCode::NOT_FOUND && fallback_not_found {
        format!(
            "Forge request failed with status {} at {}. Start Forge with --api and use a base URL like http://127.0.0.1:7860 (without /sdapi/v1).",
            status, endpoint
        )
    } else if !err_text.is_empty() {
        format!(
            "Forge request failed with status {} at {}: {}",
            status, endpoint, err_text
        )
    } else {
        format!(
            "Forge request failed with status {} at {}",
            status, endpoint
        )
    }
}

pub async fn send_to_forge(
    payload: &ForgePayload,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<ForgeSendResult, Box<dyn Error + Send + Sync>> {
    let warning = match validate_base_url(base_url) {
        Ok(w) => w,
        Err(e) => {
            return Ok(ForgeSendResult {
                ok: false,
                images: Vec::new(),
                info: None,
                message: e,
            });
        }
    };
    if let Some(w) = warning {
        log::warn!("{}", w);
    }

    let client = build_client(api_key, SEND_TIMEOUT_SECONDS)?;
    let endpoint = build_sdapi_endpoint(base_url, "txt2img");

    let response = match client.post(&endpoint).json(payload).send().await {
        Ok(response) => response,
        Err(error) => {
            return Ok(ForgeSendResult {
                ok: false,
                images: Vec::new(),
                info: None,
                message: format_send_transport_error(&endpoint, &error),
            });
        }
    };
    if !response.status().is_success() {
        let message = extract_error_message(response, &endpoint, true).await;
        return Ok(ForgeSendResult {
            ok: false,
            images: Vec::new(),
            info: None,
            message,
        });
    }

    let n_iter = payload.n_iter.unwrap_or(1) as usize;
    let max_bytes = (128 * 1024 * 1024 * n_iter).clamp(128 * 1024 * 1024, 1024 * 1024 * 1024);
    let bytes = read_bounded_bytes(response, max_bytes).await?;
    let body: ForgeTxt2ImgResponse = serde_json::from_slice(&bytes)?;
    Ok(ForgeSendResult {
        ok: true,
        images: body.images,
        info: body.info,
        message: "Generation request sent successfully".to_string(),
    })
}

pub async fn list_samplers(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<String>, Box<dyn Error + Send + Sync>> {
    list_named_options(base_url, api_key, "samplers").await
}

pub async fn list_schedulers(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<String>, Box<dyn Error + Send + Sync>> {
    list_named_options(base_url, api_key, "schedulers").await
}

pub async fn list_models(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<String>, Box<dyn Error + Send + Sync>> {
    list_named_options(base_url, api_key, "sd-models").await
}

pub async fn list_upscalers(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<String>, Box<dyn Error + Send + Sync>> {
    list_named_options(base_url, api_key, "upscalers").await
}

pub async fn get_forge_options(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<serde_json::Value, Box<dyn Error + Send + Sync>> {
    let client = build_client(api_key, TEST_TIMEOUT_SECONDS)?;
    let endpoint = build_sdapi_endpoint(base_url, "options");
    let response = client.get(&endpoint).send().await?;
    if !response.status().is_success() {
        return Err(std::io::Error::other(format!(
            "Request failed for {} with status {}",
            endpoint,
            response.status()
        ))
        .into());
    }
    const MAX_OPTIONS_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    let bytes = read_bounded_bytes(response, MAX_OPTIONS_RESPONSE_BYTES).await?;
    let val: serde_json::Value = serde_json::from_slice(&bytes)?;
    Ok(val)
}

pub fn enrich_override_settings_from_forge_options(
    payload: &mut ForgePayload,
    target_model: &str,
    opts: &serde_json::Value,
    source: Option<&GenerationParams>,
) {
    let is_forge_neo = opts.get("forge_preset").is_some()
        || opts.get("forge_additional_modules").is_some()
        || opts.as_object().is_some_and(|map| {
            map.keys()
                .any(|k| k.starts_with("forge_additional_modules_"))
        });

    if !is_forge_neo {
        return;
    }

    const FORGE_PRESETS: &[&str] = &[
        "zit", "krea", "qwen21", "qwen", "moss", "flux", "klein", "anima", "lumina", "wan",
        "ernie", "pid", "xl", "sd",
    ];

    let target_lower = target_model.to_ascii_lowercase();
    let target_clean = target_lower
        .trim_end_matches(".safetensors")
        .trim_end_matches(".gguf")
        .trim_end_matches(".ckpt")
        .trim();

    let mut matched_preset = None;

    // 1. Check if target_model matches any forge_checkpoint_{preset} configured in Forge
    for &preset in FORGE_PRESETS {
        let key = format!("forge_checkpoint_{}", preset);
        if let Some(cp_str) = opts.get(&key).and_then(|v| v.as_str()) {
            let cp_clean = cp_str
                .to_ascii_lowercase()
                .trim_end_matches(".safetensors")
                .trim_end_matches(".gguf")
                .trim_end_matches(".ckpt")
                .trim()
                .to_string();

            if !cp_clean.is_empty()
                && (target_clean == cp_clean
                    || target_clean.contains(&cp_clean)
                    || cp_clean.contains(target_clean))
            {
                matched_preset = Some(preset);
                break;
            }
        }
    }

    // 2. Fall back to model architecture classifier heuristics for Forge Neo presets
    if matched_preset.is_none() {
        if target_lower.contains("z_image")
            || target_lower.contains("z-image")
            || target_lower.contains("zimage")
        {
            matched_preset = Some("zit");
        } else if target_lower.contains("krea") {
            matched_preset = Some("krea");
        } else if target_lower.contains("qwen2.1")
            || target_lower.contains("qwen 2.1")
            || target_lower.contains("qwen21")
            || (target_lower.contains("qwen") && target_lower.contains("2512"))
        {
            matched_preset = Some("qwen21");
        } else if target_lower.contains("qwen") {
            matched_preset = Some("qwen");
        } else if target_lower.contains("moss") {
            matched_preset = Some("moss");
        } else if target_lower.contains("klein")
            || target_lower.contains("flux-2")
            || target_lower.contains("flux2")
        {
            matched_preset = Some("klein");
        } else if target_lower.contains("flux") {
            matched_preset = Some("flux");
        } else if target_lower.contains("anima") {
            matched_preset = Some("anima");
        } else if target_lower.contains("lumina") {
            matched_preset = Some("lumina");
        } else if target_lower.contains("wan") {
            matched_preset = Some("wan");
        } else if target_lower.contains("ernie") {
            matched_preset = Some("ernie");
        } else if target_lower.contains("pid") {
            matched_preset = Some("pid");
        } else if target_lower.contains("pony")
            || target_lower.contains("sdxl")
            || target_lower.contains("sd_xl")
        {
            matched_preset = Some("xl");
        } else if target_lower.contains("sd15")
            || target_lower.contains("v1-5")
            || target_lower.contains("sd1.5")
            || target_lower.contains("sd21")
            || target_lower.contains("v2-1")
            || target_lower.contains("sd2.1")
        {
            matched_preset = Some("sd");
        }
    }

    if let Some(preset) = matched_preset {
        let modules_key = format!("forge_additional_modules_{}", preset);
        let dtype_key = format!("forge_unet_storage_dtype_{}", preset);

        let mut overrides = match payload.override_settings.take() {
            Some(serde_json::Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        };

        // 3a. Restore modules from the image itself: Module 1, Module 2, ...
        // (case-insensitive; also inside extra_params). Each basename is matched to a
        // full path from forge_additional_modules_{preset} / forge_additional_modules
        // by file stem, case-insensitively. All must resolve or we fall back.
        let image_modules = collect_image_modules(source);
        let mut restored = false;
        if !image_modules.is_empty() && !has_usable_modules_value(&overrides) {
            let candidates = candidate_module_paths(opts, Some(&modules_key));
            let mut resolved: Vec<String> = Vec::with_capacity(image_modules.len());
            let mut all_ok = !candidates.is_empty();
            for wanted in &image_modules {
                match resolve_module_path(wanted, &candidates) {
                    Some(full) => resolved.push(full),
                    None => {
                        all_ok = false;
                        break;
                    }
                }
            }
            if all_ok && !resolved.is_empty() {
                overrides.insert(
                    "forge_additional_modules".to_string(),
                    serde_json::Value::Array(
                        resolved
                            .into_iter()
                            .map(serde_json::Value::String)
                            .collect(),
                    ),
                );
                restored = true;
            }
        }

        // 3b. Fallback: live options for this preset (string -> array), else generic key.
        if !restored && !has_usable_modules_value(&overrides) {
            let raw = opts
                .get(&modules_key)
                .or_else(|| opts.get("forge_additional_modules"))
                .cloned()
                .unwrap_or_else(|| json!([]));
            overrides.insert(
                "forge_additional_modules".to_string(),
                normalize_modules_value(&raw),
            );
        }

        if !overrides.contains_key("forge_unet_storage_dtype") {
            if let Some(dtype_str) = opts.get(&dtype_key).and_then(|v| v.as_str()) {
                if !is_omitted_dtype(dtype_str) {
                    overrides.insert(
                        "forge_unet_storage_dtype".to_string(),
                        serde_json::Value::String(dtype_str.to_string()),
                    );
                }
            }
        }

        // 3c. Carry image-recorded extras into override_settings without clobbering caller values.
        apply_source_extras_to_overrides(&mut overrides, source);

        payload.override_settings = Some(serde_json::Value::Object(overrides));
    }
}

fn is_omitted_dtype(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("none")
        || trimmed.eq_ignore_ascii_case("automatic")
}

fn is_nonempty_modules_value(value: Option<&serde_json::Value>) -> bool {
    match value {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str())
            .any(|s| !s.trim().is_empty()),
        Some(serde_json::Value::String(text)) => !text.trim().is_empty(),
        Some(_) => false,
        None => false,
    }
}

fn has_usable_modules_value(overrides: &serde_json::Map<String, serde_json::Value>) -> bool {
    is_nonempty_modules_value(overrides.get("forge_additional_modules"))
}

fn is_plausible_module_path(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 512 {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    // Live Neo joins full paths with spaces; a fragment like `C:\My` has no model
    // extension and must not be sent as a module entry.
    lower.ends_with(".safetensors")
        || lower.ends_with(".gguf")
        || lower.ends_with(".ckpt")
        || lower.ends_with(".pt")
}

fn normalize_modules_value(raw: &serde_json::Value) -> serde_json::Value {
    match raw {
        serde_json::Value::Array(items) => {
            let arr: Vec<serde_json::Value> = items
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty() && is_plausible_module_path(s))
                .map(|s| serde_json::Value::String(s.to_string()))
                .collect();
            serde_json::Value::Array(arr)
        }
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            if !trimmed.is_empty() && std::path::Path::new(trimmed).is_file() {
                return serde_json::Value::Array(vec![serde_json::Value::String(
                    trimmed.to_string(),
                )]);
            }
            let arr: Vec<serde_json::Value> = text
                .split_whitespace()
                .map(str::trim)
                .filter(|s| !s.is_empty() && is_plausible_module_path(s))
                .map(|s| serde_json::Value::String(s.to_string()))
                .collect();
            serde_json::Value::Array(arr)
        }
        _ => json!([]),
    }
}

fn candidate_module_paths(opts: &serde_json::Value, preset_key: Option<&str>) -> Vec<String> {
    let raw = preset_key
        .and_then(|k| opts.get(k))
        .or_else(|| opts.get("forge_additional_modules"));
    let Some(raw) = raw else {
        return Vec::new();
    };
    match normalize_modules_value(raw) {
        serde_json::Value::Array(items) => items
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn module_file_stem(value: &str) -> String {
    let trimmed = value.trim();
    let base = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    base.rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(base)
        .to_ascii_lowercase()
}

fn resolve_module_path(wanted: &str, candidates: &[String]) -> Option<String> {
    let wanted_stem = module_file_stem(wanted);
    let wanted_full = wanted.trim().to_ascii_lowercase();
    // Exact basename match wins (case-insensitive).
    for candidate in candidates {
        let cand_base = candidate
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(candidate)
            .to_ascii_lowercase();
        if cand_base == wanted_full {
            return Some(candidate.clone());
        }
    }
    // Stem-only fallback: a single stem hit resolves, but a tie (>1 candidate
    // sharing the stem, e.g. fp8 vs bf16 variants) fails closed so the caller
    // falls back to the normalized live-options list instead of a first-hit guess.
    let mut stem_hits: Vec<&String> = Vec::new();
    if !wanted_stem.is_empty() {
        for candidate in candidates {
            if module_file_stem(candidate) == wanted_stem {
                stem_hits.push(candidate);
            }
        }
    }
    if stem_hits.len() == 1 {
        return Some(stem_hits[0].clone());
    }
    None
}

fn collect_image_modules(source: Option<&GenerationParams>) -> Vec<String> {
    let Some(params) = source else {
        return Vec::new();
    };
    let mut indexed: Vec<(usize, String)> = Vec::new();
    let mut extra_lists: Vec<String> = Vec::new();
    for (key, value) in &params.extra_params {
        let lowered = key.trim().to_ascii_lowercase();
        if lowered == "forge additional modules" || lowered == "additional modules" {
            extra_lists.extend(split_extra_module_list(value));
            continue;
        }
        let Some(suffix) = lowered.strip_prefix("module") else {
            continue;
        };
        let num: usize = suffix
            .trim()
            .trim_start_matches(['_', '-', ' '])
            .parse()
            .unwrap_or(0);
        if num == 0 {
            continue;
        }
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        indexed.push((num, trimmed.to_string()));
    }
    indexed.sort_by_key(|(num, _)| *num);
    let mut out: Vec<String> = indexed.into_iter().map(|(_, v)| v).collect();
    out.extend(extra_lists);
    out
}

/// Splits a `forge additional modules` / `additional modules` extra value: a JSON
/// array of strings wins when present, otherwise a comma-separated list. Empty and
/// whitespace-only entries are dropped.
fn split_extra_module_list(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
        match parsed {
            serde_json::Value::Array(items) => {
                return items
                    .into_iter()
                    .filter_map(|v| v.as_str().map(str::trim).map(str::to_string))
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
            serde_json::Value::String(inner) => {
                return split_extra_module_list(&inner);
            }
            _ => {}
        }
    }
    trimmed
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn extra_lookup<'a>(
    extra: &'a std::collections::HashMap<String, String>,
    key: &str,
) -> Option<&'a str> {
    extra.get(key).map(String::as_str).or_else(|| {
        let lowered = key.to_ascii_lowercase();
        extra
            .iter()
            .find(|(k, _)| k.trim().to_ascii_lowercase() == lowered)
            .map(|(_, v)| v.as_str())
    })
}

fn apply_source_extras_to_overrides(
    overrides: &mut serde_json::Map<String, serde_json::Value>,
    source: Option<&GenerationParams>,
) {
    let Some(params) = source else {
        return;
    };
    let extra = &params.extra_params;

    if !overrides.contains_key("img2img_background_color") {
        if let Some(val) = extra_lookup(extra, "img2img_background_color") {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                overrides.insert(
                    "img2img_background_color".to_string(),
                    serde_json::Value::String(trimmed.to_string()),
                );
            }
        }
    }

    if !overrides.contains_key("CLIP_stop_at_last_layers") {
        let clip_raw = extra_lookup(extra, "CLIP_stop_at_last_layers")
            .or_else(|| extra_lookup(extra, "CLIP skip"))
            .or_else(|| extra_lookup(extra, "clip_skip"));
        if let Some(raw) = clip_raw {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                if let Ok(num) = trimmed.parse::<i64>() {
                    overrides.insert(
                        "CLIP_stop_at_last_layers".to_string(),
                        serde_json::Value::Number(num.into()),
                    );
                } else if let Ok(num) = trimmed.parse::<f64>() {
                    if let Some(n) = serde_json::Number::from_f64(num) {
                        overrides.insert(
                            "CLIP_stop_at_last_layers".to_string(),
                            serde_json::Value::Number(n),
                        );
                    }
                } else {
                    overrides.insert(
                        "CLIP_stop_at_last_layers".to_string(),
                        serde_json::Value::String(trimmed.to_string()),
                    );
                }
            }
        }
    }

    if !overrides.contains_key("forge_unet_storage_dtype") {
        let dtype_raw = extra_lookup(extra, "forge_unet_storage_dtype")
            .or_else(|| extra_lookup(extra, "unet_storage_dtype"))
            .or_else(|| extra_lookup(extra, "forge_unet_dtype"))
            .or_else(|| extra_lookup(extra, "unet_dtype"));
        if let Some(raw) = dtype_raw {
            if !is_omitted_dtype(raw) {
                overrides.insert(
                    "forge_unet_storage_dtype".to_string(),
                    serde_json::Value::String(raw.trim().to_string()),
                );
            }
        }
    }
}

pub async fn enrich_payload_for_forge_neo(
    payload: &mut ForgePayload,
    base_url: &str,
    api_key: Option<&str>,
) {
    enrich_payload_for_forge_neo_with_source(payload, base_url, api_key, None).await;
}

/// Same as [`enrich_payload_for_forge_neo`] but also restores `forge_additional_modules`
/// (plus background color / CLIP / dtype extras) from the image's own source params.
/// Callers that own the [`GenerationParams`] (e.g. [`forge_requeue_image`]) should prefer
/// this variant; callers with only a [`ForgePayload`] keep using the 3-arg version.
pub async fn enrich_payload_for_forge_neo_with_source(
    payload: &mut ForgePayload,
    base_url: &str,
    api_key: Option<&str>,
    source: Option<&GenerationParams>,
) {
    let target_model = payload
        .override_settings
        .as_ref()
        .and_then(|ov| ov.get("sd_model_checkpoint"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    let Some(target_model) = target_model else {
        return;
    };

    if payload
        .override_settings
        .as_ref()
        .and_then(|ov| ov.as_object())
        .is_some_and(has_usable_modules_value)
    {
        return;
    }

    if let Ok(opts) = get_forge_options(base_url, api_key).await {
        enrich_override_settings_from_forge_options(payload, &target_model, &opts, source);
    }
}

pub async fn upscale_image(
    payload: &ForgeUpscalePayload,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<ForgeUpscaleResult, Box<dyn Error + Send + Sync>> {
    let warning = match validate_base_url(base_url) {
        Ok(w) => w,
        Err(e) => {
            return Ok(ForgeUpscaleResult {
                ok: false,
                image: None,
                message: e,
            });
        }
    };
    if let Some(w) = warning {
        log::warn!("{}", w);
    }

    let client = build_client(api_key, SEND_TIMEOUT_SECONDS)?;
    let endpoint = build_sdapi_endpoint(base_url, "extra-single-image");

    let request_body = json!({
        "resize_mode": 0,
        "show_extras_results": true,
        "upscaling_resize": payload.upscaling_resize,
        "upscaler_1": payload.upscaler_1,
        "upscaler_2": payload.upscaler_2.as_deref().unwrap_or("None"),
        "extras_upscaler_2_visibility": payload.extras_upscaler_2_visibility.unwrap_or(0.0),
        "image": payload.image,
    });

    let response = match client.post(&endpoint).json(&request_body).send().await {
        Ok(res) => res,
        Err(error) => {
            return Ok(ForgeUpscaleResult {
                ok: false,
                image: None,
                message: format_send_transport_error(&endpoint, &error),
            });
        }
    };

    if !response.status().is_success() {
        let message = extract_error_message(response, &endpoint, false).await;
        return Ok(ForgeUpscaleResult {
            ok: false,
            image: None,
            message,
        });
    }

    const MAX_UPSCALE_RESPONSE_BYTES: usize = 256 * 1024 * 1024;
    let bytes = read_bounded_bytes(response, MAX_UPSCALE_RESPONSE_BYTES).await?;
    let body: ForgeExtraSingleImageResponse = serde_json::from_slice(&bytes)?;

    if let Some(img) = body.image {
        Ok(ForgeUpscaleResult {
            ok: true,
            image: Some(img),
            message: "Upscaling completed successfully".to_string(),
        })
    } else {
        Ok(ForgeUpscaleResult {
            ok: false,
            image: None,
            message: "Forge returned no image in response".to_string(),
        })
    }
}

pub struct ForgePayloadBuildInput<'a> {
    pub prompt: &'a str,
    pub negative_prompt: &'a str,
    pub steps: Option<&'a str>,
    pub sampler: Option<&'a str>,
    pub scheduler: Option<&'a str>,
    pub cfg_scale: Option<&'a str>,
    pub seed: Option<&'a str>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub model_name: Option<&'a str>,
    pub include_seed: bool,
    pub adetailer_face_enabled: bool,
    pub adetailer_face_model: Option<&'a str>,
    pub forge_additional_modules: Option<&'a [String]>,
}

/// Normalizes a scheduler label to the Forge API name: known labels map
/// case-insensitively (`Karras`->`karras`, `SGM Uniform`->`sgm_uniform`, ...);
/// anything else is trimmed, lowercased, and has whitespace runs folded to `_`.
pub fn normalize_scheduler(value: &str) -> String {
    let lowered = value.trim().to_ascii_lowercase();
    match lowered.as_str() {
        "karras" => "karras".to_string(),
        "exponential" => "exponential".to_string(),
        "sgm uniform" => "sgm_uniform".to_string(),
        "simple" => "simple".to_string(),
        "beta" => "beta".to_string(),
        "linear" => "linear".to_string(),
        "ddim uniform" => "ddim_uniform".to_string(),
        "normal" => "normal".to_string(),
        "uniform" => "uniform".to_string(),
        _ => lowered.split_whitespace().collect::<Vec<_>>().join("_"),
    }
}

/// Scheduler to send when re-generating a stored image: an explicit override wins, otherwise
/// the `Schedule type` recorded in the image's own metadata block (also mirrored on
/// `ImageRecord.schedule_type`). Labels are normalized via [`normalize_scheduler`];
/// without this the scheduler was silently dropped (upstream issue #15521, reproduced in-app).
pub fn resolve_scheduler(override_scheduler: Option<&str>, raw_metadata: &str) -> Option<String> {
    if let Some(explicit) = parse_optional_text(override_scheduler) {
        return Some(normalize_scheduler(&explicit));
    }
    crate::parser::parse_generation_metadata(raw_metadata)
        .schedule_type
        .and_then(|s| parse_optional_text(Some(&s)))
        .map(|s| normalize_scheduler(&s))
}

/// Per-field overrides applied on top of a stored image when re-generating it. `None` means
/// "use the stored value" (for the scheduler: the Schedule type in the stored metadata).
#[derive(Debug, Clone, Copy, Default)]
pub struct RecordOverrides<'a> {
    pub negative_prompt: Option<&'a str>,
    pub steps: Option<&'a str>,
    pub sampler: Option<&'a str>,
    pub scheduler: Option<&'a str>,
    pub cfg_scale: Option<&'a str>,
    pub seed: Option<&'a str>,
    pub model_name: Option<&'a str>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub forge_additional_modules: Option<&'a [String]>,
}

/// An override that is `None` or only whitespace counts as unset.
fn present(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// The one place that decides which value wins when re-generating a stored image
/// (override first, else the stored record, scheduler via [`resolve_scheduler`]).
/// `prompt` is passed in already resolved because callers may append LoRA tags to it.
pub fn build_payload_for_record(
    image: &crate::database::ImageRecord,
    prompt: &str,
    overrides: &RecordOverrides<'_>,
    include_seed: bool,
    adetailer_face_enabled: bool,
    adetailer_face_model: Option<&str>,
) -> ForgePayload {
    let scheduler = resolve_scheduler(overrides.scheduler, &image.raw_metadata);
    // A blank override means "not set", never "send nothing": a cleared Steps box must not
    // silently turn into Forge's default. (The negative prompt is the exception: blank there is
    // a legitimate "no negative prompt".)
    build_payload_from_image_record(ForgePayloadBuildInput {
        prompt,
        negative_prompt: overrides
            .negative_prompt
            .unwrap_or(image.negative_prompt.as_str()),
        steps: present(overrides.steps).or(image.steps.as_deref()),
        sampler: present(overrides.sampler).or(image.sampler.as_deref()),
        scheduler: scheduler.as_deref(),
        cfg_scale: present(overrides.cfg_scale).or(image.cfg_scale.as_deref()),
        seed: present(overrides.seed).or(image.seed.as_deref()),
        width: overrides.width.or(image.width),
        height: overrides.height.or(image.height),
        model_name: present(overrides.model_name).or(image.model_name.as_deref()),
        include_seed,
        adetailer_face_enabled,
        adetailer_face_model,
        forge_additional_modules: overrides.forge_additional_modules,
    })
}

pub fn build_payload_from_image_record(input: ForgePayloadBuildInput<'_>) -> ForgePayload {
    let ForgePayloadBuildInput {
        prompt,
        negative_prompt,
        steps,
        sampler,
        scheduler,
        cfg_scale,
        seed,
        width,
        height,
        model_name,
        include_seed,
        adetailer_face_enabled,
        adetailer_face_model,
        forge_additional_modules,
    } = input;
    let sampler_name = parse_optional_text(sampler);
    let scheduler = parse_optional_text(scheduler);
    let model_name = parse_optional_text(model_name);
    let override_settings = model_name.map(|name| {
        let mut obj = serde_json::Map::new();
        obj.insert("sd_model_checkpoint".to_string(), json!(name));
        if let Some(modules) = forge_additional_modules {
            if !modules.is_empty() {
                obj.insert("forge_additional_modules".to_string(), json!(modules));
            }
        }
        serde_json::Value::Object(obj)
    });
    let alwayson_scripts =
        build_adetailer_alwayson_scripts(adetailer_face_enabled, adetailer_face_model);

    ForgePayload {
        prompt: prompt.to_string(),
        negative_prompt: negative_prompt.to_string(),
        steps: parse_u32(steps),
        sampler_name: sampler_name.clone(),
        scheduler: scheduler.clone(),
        cfg_scale: parse_f32(cfg_scale),
        seed: if include_seed { parse_i64(seed) } else { None },
        width,
        height,
        override_settings,
        send_images: Some(true),
        // The app writes the returned images itself; don't also leave a copy in Forge's outputs folder.
        save_images: Some(false),
        alwayson_scripts,
        batch_size: Some(1),
        n_iter: Some(1),
    }
}

/// Strict mapping: GenerationParams -> Forge txt2img payload exactly.
/// Mirrors spec: prompt/negative/steps/sampler/scheduler/cfg/seed/width-height/model via override_settings.sd_model_checkpoint, LoRA via alwayson_scripts.
///
pub fn build_payload_from_generation_params(
    params: &GenerationParams,
    include_seed: bool,
    adetailer_face_enabled: bool,
    adetailer_face_model: Option<&str>,
) -> ForgePayload {
    let sampler_name = params.sampler.as_deref().and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });
    let scheduler = params.schedule_type.as_deref().and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(normalize_scheduler(t))
        }
    });
    let model_name = params.model_name.as_deref().and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });

    let override_settings = model_name
        .as_deref()
        .map(|name| json!({ "sd_model_checkpoint": name }));

    // LoRAs are applied by Forge from the `<lora:name:weight>` tags already in the prompt.
    // There is no "LoRA" always-on script: sending one gets HTTP 422 "Script 'LoRA' not found".
    let alwayson_scripts =
        build_adetailer_alwayson_scripts(adetailer_face_enabled, adetailer_face_model);

    ForgePayload {
        prompt: params.prompt.clone(),
        negative_prompt: params.negative_prompt.clone(),
        steps: params
            .steps
            .as_deref()
            .and_then(|v| v.trim().parse::<u32>().ok()),
        sampler_name,
        scheduler,
        cfg_scale: params
            .cfg_scale
            .as_deref()
            .and_then(|v| v.trim().parse::<f32>().ok()),
        seed: if include_seed {
            params
                .seed
                .as_deref()
                .and_then(|v| v.trim().parse::<i64>().ok())
        } else {
            None
        },
        width: params.width,
        height: params.height,
        override_settings,
        send_images: Some(true),
        // The app writes the returned images itself; don't also leave a copy in Forge's outputs folder.
        save_images: Some(false),
        alwayson_scripts,
        batch_size: Some(1),
        n_iter: Some(1),
    }
}

/// Builds a requeue payload with override_settings restricted to valid Forge options
/// (`sd_model_checkpoint` and `CLIP_stop_at_last_layers` when present).
/// Top-level generation parameters (seed, sampler_name, scheduler, cfg_scale, steps, width, height)
/// are set directly on the payload request fields rather than inside override_settings.
///
/// Note on reproduction:
/// Top-level parameters (prompt, negative prompt, steps, sampler, scheduler, cfg, seed, dimensions)
/// and model checkpoint + LoRA scripts are reproduced. Options not captured in metadata
/// or not exposed as top-level fields (such as VAE or custom script states) will use the
/// Forge instance's current defaults.
pub fn build_requeue_payload(params: &GenerationParams, include_seed: bool) -> ForgePayload {
    let mut payload = build_payload_from_generation_params(params, include_seed, false, None);

    let mut overrides = serde_json::Map::new();
    if let Some(model) = params.model_name.as_deref().and_then(|v| {
        let t = v.trim();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    }) {
        overrides.insert(
            "sd_model_checkpoint".to_string(),
            serde_json::Value::String(model.to_string()),
        );
    }

    if let Some(clip_skip_str) = extra_lookup(&params.extra_params, "CLIP_stop_at_last_layers")
        .or_else(|| extra_lookup(&params.extra_params, "CLIP skip"))
        .or_else(|| extra_lookup(&params.extra_params, "clip_skip"))
        .or_else(|| extra_lookup(&params.extra_params, "Clip skip"))
    {
        let trimmed = clip_skip_str.trim();
        if !trimmed.is_empty() {
            if let Ok(clip_skip) = trimmed.parse::<i64>() {
                overrides.insert(
                    "CLIP_stop_at_last_layers".to_string(),
                    serde_json::Value::Number(clip_skip.into()),
                );
            } else if let Ok(as_float) = trimmed.parse::<f64>() {
                if let Some(n) = serde_json::Number::from_f64(as_float) {
                    overrides.insert(
                        "CLIP_stop_at_last_layers".to_string(),
                        serde_json::Value::Number(n),
                    );
                }
            }
        }
    }

    if let Some(bg) = extra_lookup(&params.extra_params, "img2img_background_color") {
        let trimmed = bg.trim();
        if !trimmed.is_empty() {
            overrides.insert(
                "img2img_background_color".to_string(),
                serde_json::Value::String(trimmed.to_string()),
            );
        }
    }

    if let Some(dtype) = extra_lookup(&params.extra_params, "forge_unet_storage_dtype")
        .or_else(|| extra_lookup(&params.extra_params, "unet_storage_dtype"))
        .or_else(|| extra_lookup(&params.extra_params, "forge_unet_dtype"))
        .or_else(|| extra_lookup(&params.extra_params, "unet_dtype"))
    {
        if !is_omitted_dtype(dtype) {
            overrides.insert(
                "forge_unet_storage_dtype".to_string(),
                serde_json::Value::String(dtype.trim().to_string()),
            );
        }
    }

    if !overrides.is_empty() {
        payload.override_settings = Some(serde_json::Value::Object(overrides));
    }

    payload
}

/// Composite helper: test connection then queue image. Reports queue id via info field.
pub async fn forge_requeue_image(
    params: &GenerationParams,
    base_url: &str,
    api_key: Option<&str>,
    include_seed: bool,
) -> Result<ForgeSendResult, Box<dyn Error + Send + Sync>> {
    let status = test_connection(base_url, api_key).await?;
    if !status.ok {
        return Ok(ForgeSendResult {
            ok: false,
            images: Vec::new(),
            info: None,
            message: format!("Forge not reachable: {}", status.message),
        });
    }
    let mut payload = build_requeue_payload(params, include_seed);
    enrich_payload_for_forge_neo_with_source(&mut payload, base_url, api_key, Some(params)).await;
    let mut result = send_to_forge(&payload, base_url, api_key).await?;
    if result.ok {
        if let Some(info) = result.info.as_deref() {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(info) {
                if let Some(queue) = parsed.get("queue_id").or_else(|| parsed.get("id")) {
                    result.message = format!("Queued {} — {}", queue, result.message);
                } else if let Some(job) = parsed.get("job") {
                    result.message = format!("Queued job {} — {}", job, result.message);
                }
            }
        }
        if !result.message.contains("Queued") && !result.images.is_empty() {
            let fallback = format!("requeue-{}", chrono::Utc::now().timestamp_millis());
            result.message = format!("Queued {} — {}", fallback, result.message);
        }
    }
    Ok(result)
}

fn parse_u32(value: Option<&str>) -> Option<u32> {
    value.and_then(|v| v.trim().parse::<u32>().ok())
}

fn parse_f32(value: Option<&str>) -> Option<f32> {
    value.and_then(|v| v.trim().parse::<f32>().ok())
}

fn parse_i64(value: Option<&str>) -> Option<i64> {
    value.and_then(|v| v.trim().parse::<i64>().ok())
}

fn parse_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn build_adetailer_alwayson_scripts(
    adetailer_face_enabled: bool,
    adetailer_face_model: Option<&str>,
) -> Option<serde_json::Value> {
    if !adetailer_face_enabled {
        return None;
    }

    let model = parse_optional_text(adetailer_face_model)
        .unwrap_or_else(|| DEFAULT_ADETAILER_FACE_MODEL.to_string());

    Some(json!({
        "ADetailer": {
            "args": [
                true,
                false,
                {
                    "ad_model": model
                }
            ]
        }
    }))
}

fn collect_named_options(entries: &[serde_json::Value]) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut options = Vec::new();

    for entry in entries {
        let name = entry
            .get("name")
            .and_then(|value| value.as_str())
            .or_else(|| entry.get("label").and_then(|value| value.as_str()))
            .or_else(|| entry.get("title").and_then(|value| value.as_str()));

        let Some(name) = name else {
            continue;
        };
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            options.push(trimmed.to_string());
        }
    }

    options
}

async fn list_named_options(
    base_url: &str,
    api_key: Option<&str>,
    endpoint_name: &str,
) -> Result<Vec<String>, Box<dyn Error + Send + Sync>> {
    let client = build_client(api_key, TEST_TIMEOUT_SECONDS)?;
    let endpoint = build_sdapi_endpoint(base_url, endpoint_name);
    let response = client.get(&endpoint).send().await?;

    if !response.status().is_success() {
        return Err(std::io::Error::other(format!(
            "Request failed for {} with status {}",
            endpoint,
            response.status()
        ))
        .into());
    }

    const MAX_OPTION_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    let bytes = read_bounded_bytes(response, MAX_OPTION_RESPONSE_BYTES).await?;
    let raw: Vec<serde_json::Value> = serde_json::from_slice(&bytes)?;
    Ok(collect_named_options(&raw))
}

pub fn validate_base_url(base_url: &str) -> Result<Option<String>, String> {
    let parsed = reqwest::Url::parse(base_url).map_err(|e| format!("Invalid base_url: {}", e))?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "Invalid URL scheme '{}'. Must be http or https.",
            scheme
        ));
    }

    let host_str = parsed
        .host_str()
        .ok_or_else(|| "URL must have a host".to_string())?;

    if scheme == "http" {
        let clean_host = host_str.trim_start_matches('[').trim_end_matches(']');
        let is_loopback = clean_host.eq_ignore_ascii_case("localhost")
            || clean_host == "127.0.0.1"
            || clean_host == "::1"
            || clean_host.ends_with(".local");
        let is_private = if let Ok(ip) = clean_host.parse::<std::net::Ipv4Addr>() {
            let octets = ip.octets();
            octets[0] == 127
                || octets[0] == 10
                || (octets[0] == 172 && (16..=31).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 168)
        } else if let Ok(ip) = clean_host.parse::<std::net::Ipv6Addr>() {
            ip.is_loopback()
        } else {
            false
        };

        if !is_loopback && !is_private {
            return Ok(Some(format!(
                "Warning: Connecting to remote host '{}' over unencrypted HTTP. API key may be exposed in transit.",
                host_str
            )));
        }
    }

    Ok(None)
}

fn build_sdapi_endpoint(base_url: &str, endpoint: &str) -> String {
    let normalized = normalize_base_url(base_url);
    let path = endpoint.trim_start_matches('/');
    format!("{normalized}{SDAPI_PREFIX}/{path}")
}

fn normalize_base_url(base_url: &str) -> String {
    let mut normalized = base_url.trim().trim_end_matches('/').to_string();
    if normalized.is_empty() {
        return normalized;
    }

    loop {
        let stripped = if let Some(value) = normalized.strip_suffix("/docs") {
            Some(value)
        } else if let Some(value) = normalized.strip_suffix(SDAPI_PREFIX) {
            Some(value)
        } else {
            normalized.strip_suffix("/sdapi")
        };

        let Some(value) = stripped else {
            return normalized;
        };

        normalized = value.trim_end_matches('/').to_string();
        if normalized.is_empty() {
            return normalized;
        }
    }
}

fn format_send_transport_error(endpoint: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return format!(
            "Forge request timed out at {}. Model loading or generation exceeded {} seconds; reduce steps/resolution or try again after the model is warm.",
            endpoint, SEND_TIMEOUT_SECONDS
        );
    }

    if error.is_connect() {
        return format!(
            "Forge connection failed at {}. Verify Forge is still running and accepting API requests.",
            endpoint
        );
    }

    format!("Forge transport error at {}: {}", endpoint, error)
}

fn build_client(
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<reqwest::Client, Box<dyn Error + Send + Sync>> {
    let mut headers = HeaderMap::new();

    if let Some(key) = api_key {
        let token = key.trim();
        if !token.is_empty() {
            let value = HeaderValue::from_str(&format!("Bearer {}", token))?;
            headers.insert(AUTHORIZATION, value);
        }
    }

    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_seconds))
        .default_headers(headers)
        .build()?)
}

#[cfg(test)]
mod tests {
    use super::{
        build_payload_from_generation_params, build_requeue_payload, build_sdapi_endpoint,
        normalize_base_url, resolve_scheduler, validate_base_url,
    };
    use crate::parser::GenerationParams;
    use std::collections::HashMap;

    #[test]
    fn validate_base_url_checks_schemes_and_private_ips() {
        // Valid local HTTP
        assert_eq!(validate_base_url("http://localhost:7860"), Ok(None));
        assert_eq!(validate_base_url("http://127.0.0.1:7860"), Ok(None));
        assert_eq!(validate_base_url("http://[::1]:7860"), Ok(None));
        assert_eq!(validate_base_url("http://myhost.local:7860"), Ok(None));
        assert_eq!(validate_base_url("http://192.168.1.50:7860"), Ok(None));
        assert_eq!(validate_base_url("http://10.0.0.5:7860"), Ok(None));
        assert_eq!(validate_base_url("http://172.20.0.5:7860"), Ok(None));

        // Valid remote HTTPS
        assert_eq!(validate_base_url("https://remote.example.com"), Ok(None));

        // Remote HTTP warns about unencrypted connection
        let warn_res = validate_base_url("http://remote.example.com:7860");
        assert!(
            matches!(warn_res, Ok(Some(ref msg)) if msg.contains("Warning: Connecting to remote host"))
        );

        // Invalid scheme
        assert!(validate_base_url("ftp://localhost:7860").is_err());
        assert!(validate_base_url("ws://localhost:7860").is_err());

        // Malformed URL or missing host
        assert!(validate_base_url("not_a_url").is_err());
    }

    #[test]
    fn normalize_base_url_strips_sdapi_suffixes() {
        assert_eq!(
            normalize_base_url("http://127.0.0.1:7860/sdapi/v1"),
            "http://127.0.0.1:7860"
        );
        assert_eq!(
            normalize_base_url("http://127.0.0.1:7860/sdapi"),
            "http://127.0.0.1:7860"
        );
    }

    #[test]
    fn normalize_base_url_strips_docs_then_api() {
        assert_eq!(
            normalize_base_url("http://127.0.0.1:7860/sdapi/v1/docs/"),
            "http://127.0.0.1:7860"
        );
    }

    #[test]
    fn build_sdapi_endpoint_avoids_duplicate_prefix() {
        assert_eq!(
            build_sdapi_endpoint("http://127.0.0.1:7860", "txt2img"),
            "http://127.0.0.1:7860/sdapi/v1/txt2img"
        );
        assert_eq!(
            build_sdapi_endpoint("http://127.0.0.1:7860/sdapi/v1", "/txt2img"),
            "http://127.0.0.1:7860/sdapi/v1/txt2img"
        );
    }

    fn sample_params() -> GenerationParams {
        let mut extra = HashMap::new();
        extra.insert("Lora hashes".to_string(), "my_lora: abcd1234".to_string());
        GenerationParams {
            prompt: "a cat <lora:my_lora:0.8> masterpiece".to_string(),
            negative_prompt: "low quality".to_string(),
            steps: Some("28".to_string()),
            sampler: Some("Euler a".to_string()),
            schedule_type: Some("Karras".to_string()),
            cfg_scale: Some("7.5".to_string()),
            seed: Some("12345".to_string()),
            width: Some(1024),
            height: Some(768),
            model_hash: Some("abcd1234".to_string()),
            model_name: Some("pony_v6.safetensors".to_string()),
            generation_type: Some("txt2img".to_string()),
            extra_params: extra,
            text_chunks: HashMap::new(),
            raw_metadata: "raw".to_string(),
        }
    }

    #[test]
    fn generation_params_maps_to_txt2img_payload_exactly() {
        let params = sample_params();
        let payload = build_payload_from_generation_params(&params, true, false, None);
        assert_eq!(payload.prompt, params.prompt);
        assert_eq!(payload.negative_prompt, params.negative_prompt);
        assert_eq!(payload.steps, Some(28));
        assert_eq!(payload.sampler_name.as_deref(), Some("Euler a"));
        assert_eq!(payload.scheduler.as_deref(), Some("karras"));
        assert_eq!(payload.cfg_scale, Some(7.5));
        assert_eq!(payload.seed, Some(12345));
        assert_eq!(payload.width, Some(1024));
        assert_eq!(payload.height, Some(768));
        let overrides = payload
            .override_settings
            .expect("override_settings required");
        assert_eq!(
            overrides
                .get("sd_model_checkpoint")
                .and_then(|v| v.as_str()),
            Some("pony_v6.safetensors")
        );
        // LoRA is carried by the prompt tag; a "LoRA" always-on script makes Forge answer 422.
        assert!(
            payload.prompt.contains("<lora:my_lora"),
            "LoRA tag must stay in the prompt"
        );
        assert!(
            payload
                .alwayson_scripts
                .as_ref()
                .and_then(|a| a.get("LoRA"))
                .is_none(),
            "must not send a LoRA always-on script"
        );
    }

    #[test]
    fn requeue_payload_locks_override_settings_checkpoint_and_toplevel_fields() {
        let mut params = sample_params();
        params
            .extra_params
            .insert("Clip skip".to_string(), "2".to_string());
        let payload = build_requeue_payload(&params, true);
        let overrides = payload
            .override_settings
            .expect("requeue override_settings");
        assert_eq!(
            overrides
                .get("sd_model_checkpoint")
                .and_then(|v| v.as_str()),
            Some("pony_v6.safetensors"),
            "model locked via override_settings.sd_model_checkpoint"
        );
        assert_eq!(
            overrides
                .get("CLIP_stop_at_last_layers")
                .and_then(|v| v.as_i64()),
            Some(2),
            "clip skip locked via override_settings.CLIP_stop_at_last_layers"
        );
        // Non-option parameters must not be in override_settings
        assert!(overrides.get("sd_sampler").is_none());
        assert!(overrides.get("sampler_name").is_none());
        assert!(overrides.get("sd_scheduler").is_none());
        assert!(overrides.get("cfg_scale").is_none());
        assert!(overrides.get("seed").is_none());

        // Top-level payload fields must be set correctly
        assert_eq!(payload.sampler_name.as_deref(), Some("Euler a"));
        assert_eq!(payload.scheduler.as_deref(), Some("karras"));
        assert_eq!(payload.cfg_scale, Some(7.5));
        assert_eq!(payload.seed, Some(12345));

        assert!(
            payload
                .alwayson_scripts
                .as_ref()
                .and_then(|a| a.get("LoRA"))
                .is_none(),
            "must not send a LoRA always-on script"
        );
    }

    fn stored_image() -> crate::database::ImageRecord {
        crate::database::ImageRecord {
            id: 1,
            filepath: "/lib/a.png".into(),
            filename: "a.png".into(),
            directory: "/lib".into(),
            prompt: "a cat".into(),
            negative_prompt: "blurry".into(),
            steps: Some("20".into()),
            sampler: Some("Euler a".into()),
            cfg_scale: Some("7".into()),
            seed: Some("4294967299".into()),
            width: Some(512),
            height: Some(512),
            model_hash: None,
            model_name: Some("m.safetensors".into()),
            raw_metadata: "a cat
Steps: 20, Sampler: Euler a, Schedule type: Karras, CFG scale: 7, Seed: 4294967299"
                .into(),
            is_favorite: false,
            is_locked: false,
            schedule_type: Some("karras".into()),
            extra_params: None,
            text_chunks: None,
        }
    }

    #[test]
    fn blank_overrides_fall_back_to_the_stored_values() {
        let img = stored_image();
        let blank = crate::forge_api::RecordOverrides {
            steps: Some("  "),
            sampler: Some(""),
            cfg_scale: Some(" "),
            seed: Some(""),
            model_name: Some(""),
            ..Default::default()
        };
        let p = crate::forge_api::build_payload_for_record(
            &img,
            &img.prompt,
            &blank,
            true,
            false,
            None,
        );
        assert_eq!(
            p.steps,
            Some(20),
            "a cleared Steps box must not become Forge's default"
        );
        assert_eq!(p.sampler_name.as_deref(), Some("Euler a"));
        assert_eq!(p.cfg_scale, Some(7.0));
        assert_eq!(p.seed, Some(4294967299));
        assert_eq!(p.scheduler.as_deref(), Some("karras"));
    }

    #[test]
    fn real_overrides_still_win_and_a_blank_negative_prompt_is_respected() {
        let img = stored_image();
        let ov = crate::forge_api::RecordOverrides {
            steps: Some("30"),
            negative_prompt: Some(""),
            ..Default::default()
        };
        let p =
            crate::forge_api::build_payload_for_record(&img, &img.prompt, &ov, true, false, None);
        assert_eq!(p.steps, Some(30));
        assert_eq!(
            p.negative_prompt, "",
            "blank negative prompt is a legitimate choice"
        );
    }

    #[test]
    fn resolve_scheduler_prefers_override_then_stored_metadata() {
        let raw = "a cat
Negative prompt: x
Steps: 20, Sampler: Euler a, Schedule type: Karras, CFG scale: 7, Seed: 1, Size: 512x512";
        assert_eq!(
            resolve_scheduler(Some("exponential"), raw).as_deref(),
            Some("exponential")
        );
        assert_eq!(resolve_scheduler(None, raw).as_deref(), Some("karras"));
        assert_eq!(
            resolve_scheduler(Some("  "), raw).as_deref(),
            Some("karras")
        );
        assert_eq!(
            resolve_scheduler(
                None,
                "a cat
Steps: 20, Sampler: Euler"
            ),
            None
        );
    }

    #[test]
    fn normalize_scheduler_maps_known_labels_case_insensitively() {
        for (input, expected) in [
            ("Karras", "karras"),
            ("KARRAS", "karras"),
            ("Exponential", "exponential"),
            ("SGM Uniform", "sgm_uniform"),
            ("sgm uniform", "sgm_uniform"),
            ("Simple", "simple"),
            ("Beta", "beta"),
            ("Linear", "linear"),
            ("DDIM Uniform", "ddim_uniform"),
            ("Normal", "normal"),
            ("Uniform", "uniform"),
        ] {
            assert_eq!(super::normalize_scheduler(input), expected, "{input}");
        }
        assert_eq!(super::normalize_scheduler("  Karras  "), "karras");
        // Unknown labels fall back to trimmed lowercase with spaces folded to `_`.
        assert_eq!(super::normalize_scheduler("Foo Bar"), "foo_bar");
        assert_eq!(super::normalize_scheduler("  Exponential  "), "exponential");
    }

    #[test]
    fn payload_never_sends_lora_always_on_script_even_for_lora_prompts() {
        let mut params = sample_params();
        params.prompt = "a cat <lora:style_a:0.7> <lora:style_b:1.0>".to_string();
        for payload in [
            build_requeue_payload(&params, true),
            build_payload_from_generation_params(&params, true, false, None),
        ] {
            assert!(payload.prompt.contains("<lora:style_a:0.7>"));
            assert!(
                payload.alwayson_scripts.is_none(),
                "Forge answers 422 to a LoRA script"
            );
        }
    }

    #[test]
    fn requeue_payload_respects_include_seed_false() {
        let mut params = sample_params();
        params.seed = Some("999".to_string());
        let payload = build_requeue_payload(&params, false);
        assert_eq!(payload.seed, None);
    }

    #[test]
    fn mock_txt2img_generates_valid_payload() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::mpsc;
        use std::thread;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://{}", addr);
        let (tx, rx) = mpsc::channel::<String>();

        let handle = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let body_start = req.find("\r\n\r\n").map(|p| p + 4).unwrap_or(0);
                let body = if body_start < req.len() {
                    req[body_start..].to_string()
                } else {
                    String::new()
                };
                let _ = tx.send(body);
                let resp_body = r#"{"images":["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="],"info":"{\"queue_id\":\"mock-queue-123\"}"}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    resp_body.len(),
                    resp_body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        let params = sample_params();
        let payload = build_requeue_payload(&params, true);
        let serialized = serde_json::to_string(&payload).expect("serialize payload");
        assert!(
            serialized.contains("sd_model_checkpoint"),
            "payload has override_settings model"
        );
        assert!(
            serialized.contains("<lora:") && !serialized.contains("alwayson_scripts"),
            "LoRA travels as a prompt tag, not an always-on script"
        );

        let result = tauri::async_runtime::block_on(async {
            super::send_to_forge(&payload, &base_url, None).await
        });
        let body = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap_or_default();
        let _ = handle.join();

        assert!(
            body.contains("\"prompt\""),
            "mock received prompt in body: {}",
            body
        );
        assert!(
            body.contains("sd_model_checkpoint"),
            "mock received override_settings: {}",
            body
        );
        assert!(
            body.contains("<lora:") && !body.contains("alwayson_scripts"),
            "mock received LoRA as prompt tag only: {}",
            body
        );
        let res = result.expect("send_to_forge should succeed via mock");
        assert!(res.ok, "mock txt2img should be ok");
        assert_eq!(res.images.len(), 1);
        assert!(res.info.is_some());
    }

    #[test]
    fn mock_test_connection_via_samplers() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::thread;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://{}", addr);

        let handle = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let resp_body = r#"[{"name":"Euler a"},{"name":"DPM++ 2M"}]"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    resp_body.len(),
                    resp_body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        let status =
            tauri::async_runtime::block_on(async { super::test_connection(&base_url, None).await })
                .expect("test_connection should not error");
        let _ = handle.join();
        assert!(
            status.ok,
            "mock samplers should report ok: {}",
            status.message
        );
    }

    #[test]
    fn test_enrich_override_settings_for_forge_neo() {
        use serde_json::json;

        let forge_neo_opts = json!({
            "forge_preset": "krea",
            "forge_additional_modules": ["qwen_image_vae.safetensors", "qwen3vl_4b_fp8_scaled.safetensors"],
            "forge_checkpoint_zit": "z_image_de_turbo_v1_bf16.safetensors",
            "forge_additional_modules_zit": ["ae.safetensors", "Qwen3-4B-Q8_0.gguf"],
            "forge_unet_storage_dtype_zit": "Automatic (fp16 LoRA)",
            "forge_checkpoint_krea": "krea2_turbo_fp8_scaled.safetensors",
            "forge_additional_modules_krea": ["qwen_image_vae.safetensors", "Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors"],
            "forge_unet_storage_dtype_krea": "Automatic (fp16 LoRA)",
            "forge_additional_modules_xl": [],
            "forge_unet_storage_dtype_xl": "Automatic",
        });

        // 1. Target model is Z-Image Turbo -> should inject zit modules and dtype
        let mut payload_zit = super::ForgePayload {
            prompt: "cat".to_string(),
            negative_prompt: "".to_string(),
            steps: Some(20),
            sampler_name: None,
            scheduler: None,
            cfg_scale: None,
            seed: None,
            width: Some(512),
            height: Some(512),
            override_settings: Some(
                json!({ "sd_model_checkpoint": "z_image_turbo_bf16.safetensors" }),
            ),
            send_images: Some(true),
            save_images: Some(false),
            alwayson_scripts: None,
            batch_size: Some(1),
            n_iter: Some(1),
        };
        super::enrich_override_settings_from_forge_options(
            &mut payload_zit,
            "z_image_turbo_bf16.safetensors",
            &forge_neo_opts,
            None,
        );
        let ov_zit = payload_zit.override_settings.unwrap();
        assert_eq!(
            ov_zit.get("forge_additional_modules").unwrap(),
            &json!(["ae.safetensors", "Qwen3-4B-Q8_0.gguf"])
        );
        assert_eq!(
            ov_zit
                .get("forge_unet_storage_dtype")
                .unwrap()
                .as_str()
                .unwrap(),
            "Automatic (fp16 LoRA)"
        );

        // 2. Target model is Krea 2 -> should inject krea modules and dtype
        let mut payload_krea = super::ForgePayload {
            prompt: "cat".to_string(),
            negative_prompt: "".to_string(),
            steps: Some(20),
            sampler_name: None,
            scheduler: None,
            cfg_scale: None,
            seed: None,
            width: Some(512),
            height: Some(512),
            override_settings: Some(
                json!({ "sd_model_checkpoint": "krea2_turbo_fp8_scaled.safetensors" }),
            ),
            send_images: Some(true),
            save_images: Some(false),
            alwayson_scripts: None,
            batch_size: Some(1),
            n_iter: Some(1),
        };
        super::enrich_override_settings_from_forge_options(
            &mut payload_krea,
            "krea2_turbo_fp8_scaled.safetensors",
            &forge_neo_opts,
            None,
        );
        let ov_krea = payload_krea.override_settings.unwrap();
        assert_eq!(
            ov_krea.get("forge_additional_modules").unwrap(),
            &json!([
                "qwen_image_vae.safetensors",
                "Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors"
            ])
        );

        // 3. Target model is SDXL -> should inject empty list [] to unload extra modules
        let mut payload_xl = super::ForgePayload {
            prompt: "cat".to_string(),
            negative_prompt: "".to_string(),
            steps: Some(20),
            sampler_name: None,
            scheduler: None,
            cfg_scale: None,
            seed: None,
            width: Some(1024),
            height: Some(1024),
            override_settings: Some(json!({ "sd_model_checkpoint": "sd_xl_base_1.0.safetensors" })),
            send_images: Some(true),
            save_images: Some(false),
            alwayson_scripts: None,
            batch_size: Some(1),
            n_iter: Some(1),
        };
        super::enrich_override_settings_from_forge_options(
            &mut payload_xl,
            "sd_xl_base_1.0.safetensors",
            &forge_neo_opts,
            None,
        );
        let ov_xl = payload_xl.override_settings.unwrap();
        assert_eq!(ov_xl.get("forge_additional_modules").unwrap(), &json!([]));

        // 4. Standard options without Forge Neo keys -> leaves override_settings unchanged
        let standard_opts = json!({
            "sd_model_checkpoint": "v1-5-pruned.safetensors",
            "samples_save": true,
        });
        let mut payload_std = super::ForgePayload {
            prompt: "cat".to_string(),
            negative_prompt: "".to_string(),
            steps: Some(20),
            sampler_name: None,
            scheduler: None,
            cfg_scale: None,
            seed: None,
            width: Some(512),
            height: Some(512),
            override_settings: Some(json!({ "sd_model_checkpoint": "v1-5-pruned.safetensors" })),
            send_images: Some(true),
            save_images: Some(false),
            alwayson_scripts: None,
            batch_size: Some(1),
            n_iter: Some(1),
        };
        super::enrich_override_settings_from_forge_options(
            &mut payload_std,
            "v1-5-pruned.safetensors",
            &standard_opts,
            None,
        );
        let ov_std = payload_std.override_settings.unwrap();
        assert!(ov_std.get("forge_additional_modules").is_none());
    }

    fn live_shaped_opts() -> serde_json::Value {
        // Mirrors live Forge Neo 2.32 /sdapi/v1/options: forge_additional_modules is a
        // SPACE-SEPARATED STRING of full paths, with per-preset variants.
        serde_json::json!({
            "forge_preset": "krea",
            "forge_additional_modules": "/models/vae/krea2RealVae_v10.safetensors /models/llm/qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors",
            "forge_checkpoint_krea": "Krea2Turbo_W4A8.safetensors",
            "forge_additional_modules_krea": "/models/vae/krea2RealVae_v10.safetensors /models/llm/qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors",
            "forge_unet_storage_dtype_krea": "bf16",
            "forge_checkpoint_qwen21": "qwen2.1-7b.safetensors",
            "forge_additional_modules_qwen21": "/models/vae/qwen_vae.safetensors /models/llm/qwen21_text.safetensors",
            "forge_checkpoint_moss": "moss-image-v1.safetensors",
            "forge_additional_modules_moss": "/models/vae/moss_vae.safetensors",
            "forge_unet_storage_dtype_moss": "Automatic",
        })
    }

    fn payload_for(model: &str) -> super::ForgePayload {
        super::ForgePayload {
            prompt: "a".to_string(),
            negative_prompt: "".to_string(),
            steps: Some(1),
            sampler_name: Some("Euler".to_string()),
            scheduler: Some("karras".to_string()),
            cfg_scale: Some(1.0),
            seed: Some(3),
            width: Some(64),
            height: Some(64),
            override_settings: Some(serde_json::json!({ "sd_model_checkpoint": model })),
            send_images: Some(true),
            save_images: Some(false),
            alwayson_scripts: None,
            batch_size: Some(1),
            n_iter: Some(1),
        }
    }

    #[test]
    fn enrich_restores_modules_from_image_basenames_to_full_paths() {
        // Real txt2img infotext shape from live Forge Neo 2.32.
        let raw = "a\nSteps: 1, Sampler: Euler, Schedule type: Karras, CFG scale: 1.0, Seed: 3, Size: 64x64, Model: Krea2Turbo_W4A8, Model hash: 64aff423d3, Module 1: krea2RealVae_v10, Module 2: qwen3-vl-4b-heretic_fp8_e4m3fn, RNG: CPU, Version: neo-2.32";
        let params = crate::parser::parse_generation_metadata(raw);
        assert_eq!(
            params.extra_params.get("Module 1").map(String::as_str),
            Some("krea2RealVae_v10")
        );
        let mut payload = payload_for("Krea2Turbo_W4A8.safetensors");
        let opts = live_shaped_opts();
        super::enrich_override_settings_from_forge_options(
            &mut payload,
            "Krea2Turbo_W4A8.safetensors",
            &opts,
            Some(&params),
        );
        let ov = payload.override_settings.unwrap();
        assert_eq!(
            ov.get("forge_additional_modules").unwrap(),
            &serde_json::json!([
                "/models/vae/krea2RealVae_v10.safetensors",
                "/models/llm/qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors"
            ])
        );
    }

    #[test]
    fn enrich_unresolved_module_falls_back_to_live_options() {
        let mut extra = HashMap::new();
        extra.insert("Module 1".to_string(), "krea2RealVae_v10".to_string());
        extra.insert(
            "Module 2".to_string(),
            "totally_unknown_module_xyz".to_string(),
        );
        let params = GenerationParams {
            prompt: "a".to_string(),
            extra_params: extra,
            raw_metadata: "a".to_string(),
            ..Default::default()
        };
        let mut payload = payload_for("Krea2Turbo_W4A8.safetensors");
        let opts = live_shaped_opts();
        super::enrich_override_settings_from_forge_options(
            &mut payload,
            "Krea2Turbo_W4A8.safetensors",
            &opts,
            Some(&params),
        );
        let ov = payload.override_settings.unwrap();
        // Nothing invented: falls back to the normalized live-options array.
        assert_eq!(
            ov.get("forge_additional_modules").unwrap(),
            &serde_json::json!([
                "/models/vae/krea2RealVae_v10.safetensors",
                "/models/llm/qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors"
            ])
        );
    }

    #[test]
    fn enrich_qwen21_and_moss_classification() {
        let opts = live_shaped_opts();
        let mut payload_q = payload_for("qwen2.1-7b.safetensors");
        super::enrich_override_settings_from_forge_options(
            &mut payload_q,
            "qwen2.1-7b.safetensors",
            &opts,
            None,
        );
        let ov_q = payload_q.override_settings.unwrap();
        assert_eq!(
            ov_q.get("forge_additional_modules").unwrap(),
            &serde_json::json!([
                "/models/vae/qwen_vae.safetensors",
                "/models/llm/qwen21_text.safetensors"
            ]),
            "qwen 2.1 must map to the qwen21 preset"
        );

        // 2512 alias also maps to qwen21.
        let mut payload_2512 = payload_for("Qwen-Image-2512_fp8.safetensors");
        super::enrich_override_settings_from_forge_options(
            &mut payload_2512,
            "Qwen-Image-2512_fp8.safetensors",
            &opts,
            None,
        );
        let ov_2512 = payload_2512.override_settings.unwrap();
        assert_eq!(
            ov_2512.get("forge_additional_modules").unwrap(),
            &serde_json::json!([
                "/models/vae/qwen_vae.safetensors",
                "/models/llm/qwen21_text.safetensors"
            ]),
            "2512 must map to the qwen21 preset"
        );

        let mut payload_m = payload_for("moss-image-v1.safetensors");
        super::enrich_override_settings_from_forge_options(
            &mut payload_m,
            "moss-image-v1.safetensors",
            &opts,
            None,
        );
        let ov_m = payload_m.override_settings.unwrap();
        assert_eq!(
            ov_m.get("forge_additional_modules").unwrap(),
            &serde_json::json!(["/models/vae/moss_vae.safetensors"])
        );
        // Live dtype "Automatic" is omitted.
        assert!(
            ov_m.get("forge_unet_storage_dtype").is_none(),
            "Automatic dtype must be omitted"
        );
    }

    #[test]
    fn enrich_converts_string_modules_to_array_and_applies_extras() {
        let opts = serde_json::json!({
            "forge_preset": "krea",
            "forge_additional_modules_krea": "/a/vae.safetensors /b/llm.gguf",
            "forge_unet_storage_dtype_krea": "None",
        });
        let mut extra = HashMap::new();
        extra.insert(
            "img2img_background_color".to_string(),
            "(255,255,255)".to_string(),
        );
        extra.insert("CLIP skip".to_string(), "2.0".to_string());
        let params = GenerationParams {
            prompt: "a".to_string(),
            extra_params: extra,
            raw_metadata: "a".to_string(),
            ..Default::default()
        };
        let mut payload = payload_for("Krea2Turbo_W4A8.safetensors");
        super::enrich_override_settings_from_forge_options(
            &mut payload,
            "Krea2Turbo_W4A8.safetensors",
            &opts,
            Some(&params),
        );
        let ov = payload.override_settings.unwrap();
        assert_eq!(
            ov.get("forge_additional_modules").unwrap(),
            &serde_json::json!(["/a/vae.safetensors", "/b/llm.gguf"]),
            "string-valued modules must become an array"
        );
        assert_eq!(
            ov.get("img2img_background_color").and_then(|v| v.as_str()),
            Some("(255,255,255)")
        );
        assert!(
            ov.get("forge_unet_storage_dtype").is_none(),
            "None dtype must be omitted"
        );
        assert!(ov.get("CLIP_stop_at_last_layers").is_some());
    }

    #[test]
    fn enrich_preserves_caller_set_modules() {
        let opts = live_shaped_opts();
        let mut payload = payload_for("Krea2Turbo_W4A8.safetensors");
        payload.override_settings = Some(serde_json::json!({
            "sd_model_checkpoint": "Krea2Turbo_W4A8.safetensors",
            "forge_additional_modules": ["/custom/keep.safetensors"],
        }));
        let mut extra = HashMap::new();
        extra.insert("Module 1".to_string(), "krea2RealVae_v10".to_string());
        let params = GenerationParams {
            prompt: "a".to_string(),
            extra_params: extra,
            raw_metadata: "a".to_string(),
            ..Default::default()
        };
        super::enrich_override_settings_from_forge_options(
            &mut payload,
            "Krea2Turbo_W4A8.safetensors",
            &opts,
            Some(&params),
        );
        let ov = payload.override_settings.unwrap();
        assert_eq!(
            ov.get("forge_additional_modules").unwrap(),
            &serde_json::json!(["/custom/keep.safetensors"]),
            "caller-set modules must be preserved"
        );
    }

    #[test]
    fn from_image_record_restores_modules_when_live_options_point_elsewhere() {
        let record = crate::database::ImageRecord {
            id: 7,
            filepath: "/lib/a.png".into(),
            filename: "a.png".into(),
            directory: "/lib".into(),
            prompt: "a cat".into(),
            negative_prompt: "blurry".into(),
            steps: Some("20".into()),
            sampler: Some("Euler".into()),
            cfg_scale: Some("7".into()),
            seed: Some("3".into()),
            width: Some(64),
            height: Some(64),
            model_hash: None,
            model_name: Some("Krea2Turbo_W4A8.safetensors".into()),
            raw_metadata: "a\nSteps: 20, Sampler: Euler, CFG scale: 7, Seed: 3, Module 1: krea2RealVae_v10, Module 2: qwen3-vl-4b-heretic_fp8_e4m3fn".into(),
            is_favorite: false,
            is_locked: false,
            schedule_type: Some("karras".into()),
            extra_params: Some({
                let mut m = HashMap::new();
                m.insert("Module 1".to_string(), "krea2RealVae_v10".to_string());
                m.insert(
                    "Module 2".to_string(),
                    "qwen3-vl-4b-heretic_fp8_e4m3fn".to_string(),
                );
                m
            }),
            text_chunks: Some({
                let mut m = HashMap::new();
                m.insert("parameters".to_string(), "a\nSteps: 20".to_string());
                m
            }),
        };
        let params = GenerationParams::from_image_record(&record);
        assert_eq!(params.prompt, "a cat");
        assert_eq!(params.schedule_type.as_deref(), Some("karras"));
        assert_eq!(
            params.extra_params.get("Module 1").map(String::as_str),
            Some("krea2RealVae_v10")
        );
        assert_eq!(params.text_chunks.len(), 1);
        assert!(params.generation_type.is_some());
        let mut payload = payload_for("Krea2Turbo_W4A8.safetensors");
        let mut opts = live_shaped_opts();
        // Point the generic live key elsewhere; the preset key still holds the
        // image's real modules, so restore must win over the generic fallback.
        opts["forge_additional_modules"] =
            serde_json::json!("/other/unrelated_a.safetensors /other/unrelated_b.safetensors");
        super::enrich_override_settings_from_forge_options(
            &mut payload,
            "Krea2Turbo_W4A8.safetensors",
            &opts,
            Some(&params),
        );
        let ov = payload.override_settings.unwrap();
        assert_eq!(
            ov.get("forge_additional_modules").unwrap(),
            &serde_json::json!([
                "/models/vae/krea2RealVae_v10.safetensors",
                "/models/llm/qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors"
            ]),
            "image modules must win over live options pointing elsewhere"
        );
    }

    #[test]
    fn classifier_2512_without_qwen_anchor_does_not_map_to_qwen21() {
        let opts = live_shaped_opts();
        let mut payload = payload_for("run_2512_steps.safetensors");
        super::enrich_override_settings_from_forge_options(
            &mut payload,
            "run_2512_steps.safetensors",
            &opts,
            None,
        );
        let ov = payload.override_settings.unwrap();
        // run_2512_steps has no model anchor and no qwen context: must not
        // receive the qwen21 preset modules.
        let modules = ov
            .get("forge_additional_modules")
            .cloned()
            .unwrap_or_default();
        assert_ne!(
            modules,
            serde_json::json!([
                "/models/vae/qwen_vae.safetensors",
                "/models/llm/qwen21_text.safetensors"
            ]),
            "bare 2512 must not map to qwen21"
        );
    }

    #[test]
    fn stem_tie_fails_closed_to_live_fallback() {
        let opts = serde_json::json!({
            "forge_preset": "krea",
            "forge_checkpoint_krea": "Krea2Turbo.safetensors",
            "forge_additional_modules_krea": ["/a/foo_fp8.safetensors", "/b/foo_bf16.safetensors"],
        });
        let mut extra = HashMap::new();
        extra.insert("Module 1".to_string(), "foo".to_string());
        let params = GenerationParams {
            prompt: "a".to_string(),
            extra_params: extra,
            raw_metadata: "a".to_string(),
            ..Default::default()
        };
        let mut payload = payload_for("Krea2Turbo.safetensors");
        super::enrich_override_settings_from_forge_options(
            &mut payload,
            "Krea2Turbo.safetensors",
            &opts,
            Some(&params),
        );
        let ov = payload.override_settings.unwrap();
        // Two stem-only candidates tie: must fall back to normalized live list,
        // not a first-hit guess of one precision variant.
        assert_eq!(
            ov.get("forge_additional_modules").unwrap(),
            &serde_json::json!(["/a/foo_fp8.safetensors", "/b/foo_bf16.safetensors"])
        );
    }

    #[test]
    fn empty_caller_modules_are_treated_as_absent() {
        let opts = live_shaped_opts();
        // Empty caller array must not block image restore.
        let mut payload = payload_for("Krea2Turbo_W4A8.safetensors");
        payload.override_settings = Some(serde_json::json!({
            "sd_model_checkpoint": "Krea2Turbo_W4A8.safetensors",
            "forge_additional_modules": [],
        }));
        let mut extra = HashMap::new();
        extra.insert("Module 1".to_string(), "krea2RealVae_v10".to_string());
        extra.insert(
            "Module 2".to_string(),
            "qwen3-vl-4b-heretic_fp8_e4m3fn".to_string(),
        );
        let params = GenerationParams {
            prompt: "a".to_string(),
            extra_params: extra,
            raw_metadata: "a".to_string(),
            ..Default::default()
        };
        super::enrich_override_settings_from_forge_options(
            &mut payload,
            "Krea2Turbo_W4A8.safetensors",
            &opts,
            Some(&params),
        );
        let ov = payload.override_settings.unwrap();
        assert_eq!(
            ov.get("forge_additional_modules").unwrap(),
            &serde_json::json!([
                "/models/vae/krea2RealVae_v10.safetensors",
                "/models/llm/qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors"
            ]),
            "empty caller array must not suppress restore"
        );
        // Empty caller array with no source must fall back to live options.
        let mut payload2 = payload_for("Krea2Turbo_W4A8.safetensors");
        payload2.override_settings = Some(serde_json::json!({
            "sd_model_checkpoint": "Krea2Turbo_W4A8.safetensors",
            "forge_additional_modules": [],
        }));
        super::enrich_override_settings_from_forge_options(
            &mut payload2,
            "Krea2Turbo_W4A8.safetensors",
            &opts,
            None,
        );
        let ov2 = payload2.override_settings.unwrap();
        assert!(
            ov2.get("forge_additional_modules")
                .and_then(|v| v.as_array())
                .is_some_and(|a| !a.is_empty()),
            "empty caller array must fall back to live modules, got {:?}",
            ov2.get("forge_additional_modules")
        );
    }

    #[test]
    fn space_containing_live_path_is_not_split_into_bogus_entries() {
        let raw = serde_json::json!("C:\\My Models\\vae.safetensors");
        let normalized = super::normalize_modules_value(&raw);
        let arr = normalized.as_array().expect("array");
        assert!(
            !arr.iter().any(|v| v.as_str() == Some("C:\\My")),
            "space-joined split must not emit bogus fragment {:?}",
            arr
        );
        // Array input with empty/invalid entries is filtered too.
        let raw_arr = serde_json::json!(["", "   ", "/a/vae.safetensors", "not-a-module"]);
        let normalized_arr = super::normalize_modules_value(&raw_arr);
        assert_eq!(
            normalized_arr,
            serde_json::json!(["/a/vae.safetensors"]),
            "invalid/empty entries must be dropped"
        );
    }

    #[test]
    fn spaced_existing_file_path_is_preserved_whole() {
        let dir = std::env::temp_dir().join(format!(
            "forge spaced modules {} {}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create spaced temp dir");
        let file_path = dir.join("vae model.safetensors");
        std::fs::write(&file_path, b"stub").expect("write spaced temp file");
        let path_str = file_path.to_string_lossy().to_string();
        let normalized = super::normalize_modules_value(&serde_json::json!(path_str));
        assert_eq!(
            normalized,
            serde_json::json!([path_str]),
            "existing spaced path must be preserved whole"
        );
        let _ = std::fs::remove_file(&file_path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn collect_image_modules_accepts_forge_additional_modules_keys() {
        let mut extra = HashMap::new();
        extra.insert("Module 1".to_string(), "krea2RealVae_v10".to_string());
        extra.insert(
            "Forge additional modules".to_string(),
            "extra_a.safetensors, extra_b.safetensors".to_string(),
        );
        let params = GenerationParams {
            prompt: "a".to_string(),
            extra_params: extra,
            raw_metadata: "a".to_string(),
            ..Default::default()
        };
        let modules = super::collect_image_modules(Some(&params));
        assert!(modules.contains(&"krea2RealVae_v10".to_string()));
        assert!(modules.contains(&"extra_a.safetensors".to_string()));
        assert!(modules.contains(&"extra_b.safetensors".to_string()));

        let mut extra_json = HashMap::new();
        extra_json.insert(
            "additional modules".to_string(),
            r#"["j1.safetensors", "j2.safetensors"]"#.to_string(),
        );
        let params_json = GenerationParams {
            prompt: "a".to_string(),
            extra_params: extra_json,
            raw_metadata: "a".to_string(),
            ..Default::default()
        };
        let modules_json = super::collect_image_modules(Some(&params_json));
        assert_eq!(
            modules_json,
            vec!["j1.safetensors".to_string(), "j2.safetensors".to_string()]
        );
    }
}
