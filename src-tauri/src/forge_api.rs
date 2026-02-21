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
    let client = build_client(api_key, TEST_TIMEOUT_SECONDS)?;
    let endpoint = build_sdapi_endpoint(base_url, "samplers");

    let response = client.get(&endpoint).send().await?;
    if response.status().is_success() {
        return Ok(ForgeStatus {
            ok: true,
            message: "Connected to Forge/A1111 API".to_string(),
        });
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
        sampler_name,
        scheduler,
        cfg_scale: parse_f32(cfg_scale),
        seed: if include_seed { parse_i64(seed) } else { None },
        width,
        height,
        override_settings,
        send_images: Some(true),
        save_images: Some(true),
        alwayson_scripts,
    }
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
    use super::{build_sdapi_endpoint, normalize_base_url};

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
}
