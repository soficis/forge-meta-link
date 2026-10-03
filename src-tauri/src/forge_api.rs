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

#[derive(Debug, Clone, Deserialize)]
struct ForgeTxt2ImgResponse {
    #[serde(default)]
    images: Vec<String>,
    info: Option<String>,
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
        let status = response.status();
        let message = if status == StatusCode::NOT_FOUND {
            format!(
                "Forge request failed with status {} at {}. Start Forge with --api and use a base URL like http://127.0.0.1:7860 (without /sdapi/v1).",
                status, endpoint
            )
        } else {
            format!(
                "Forge request failed with status {} at {}",
                status, endpoint
            )
        };

        return Ok(ForgeSendResult {
            ok: false,
            images: Vec::new(),
            info: None,
            message,
        });
    }

    let body: ForgeTxt2ImgResponse = response.json().await?;
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
}

/// Scheduler to send when re-generating a stored image: an explicit override wins, otherwise
/// the `Schedule type` recorded in the image's own metadata block. `ImageRecord` has no
/// scheduler column, so without this the scheduler was silently dropped (upstream issue #15521,
/// reproduced in-app).
pub fn resolve_scheduler(override_scheduler: Option<&str>, raw_metadata: &str) -> Option<String> {
    if let Some(explicit) = parse_optional_text(override_scheduler) {
        return Some(explicit);
    }
    crate::parser::parse_generation_metadata(raw_metadata)
        .schedule_type
        .and_then(|s| parse_optional_text(Some(&s)))
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
    } = input;
    let sampler_name = parse_optional_text(sampler);
    let scheduler = parse_optional_text(scheduler);
    let model_name = parse_optional_text(model_name);
    let override_settings = model_name.map(|name| json!({ "sd_model_checkpoint": name }));
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
        save_images: Some(true),
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
            Some(t.to_string())
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
        save_images: Some(true),
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

    if let Some(clip_skip_str) = params
        .extra_params
        .get("Clip skip")
        .or_else(|| params.extra_params.get("clip_skip"))
    {
        if let Ok(clip_skip) = clip_skip_str.trim().parse::<i64>() {
            overrides.insert(
                "CLIP_stop_at_last_layers".to_string(),
                serde_json::Value::Number(clip_skip.into()),
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
    let payload = build_requeue_payload(params, include_seed);
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

    let raw: Vec<serde_json::Value> = response.json().await?;
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
        assert_eq!(payload.scheduler.as_deref(), Some("Karras"));
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
                .map_or(true, |a| a.get("LoRA").is_none()),
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
        assert_eq!(payload.scheduler.as_deref(), Some("Karras"));
        assert_eq!(payload.cfg_scale, Some(7.5));
        assert_eq!(payload.seed, Some(12345));

        assert!(
            payload
                .alwayson_scripts
                .as_ref()
                .map_or(true, |a| a.get("LoRA").is_none()),
            "must not send a LoRA always-on script"
        );
    }

    #[test]
    fn resolve_scheduler_prefers_override_then_stored_metadata() {
        let raw = "a cat
Negative prompt: x
Steps: 20, Sampler: Euler a, Schedule type: Karras, CFG scale: 7, Seed: 1, Size: 512x512";
        assert_eq!(resolve_scheduler(Some("exponential"), raw).as_deref(), Some("exponential"));
        assert_eq!(resolve_scheduler(None, raw).as_deref(), Some("Karras"));
        assert_eq!(resolve_scheduler(Some("  "), raw).as_deref(), Some("Karras"));
        assert_eq!(resolve_scheduler(None, "a cat
Steps: 20, Sampler: Euler"), None);
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
            assert!(payload.alwayson_scripts.is_none(), "Forge answers 422 to a LoRA script");
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
}
