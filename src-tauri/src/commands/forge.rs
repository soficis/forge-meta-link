// ────────────────────────── Forge API ──────────────────────────

#[tauri::command]
pub async fn forge_test_connection(
    base_url: String,
    api_key: Option<String>,
) -> Result<forge_api::ForgeStatus, String> {
    forge_api::test_connection(&base_url, api_key.as_deref())
        .await
        .map_err(|e| e.to_string())
}

const DEFAULT_FORGE_OUTPUT_DIR: &str = "forge-outputs";
const DEFAULT_ADETAILER_FACE_MODEL: &str = "face_yolov8n.pt";

#[derive(Debug, Clone, Serialize)]
pub struct ForgeOptionsResult {
    pub models: Vec<String>,
    pub loras: Vec<String>,
    pub samplers: Vec<String>,
    pub schedulers: Vec<String>,
    pub models_scan_dir: Option<String>,
    pub loras_scan_dir: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ForgePayloadOverridesInput {
    pub prompt: Option<String>,
    pub negative_prompt: Option<String>,
    pub steps: Option<String>,
    pub sampler_name: Option<String>,
    pub scheduler: Option<String>,
    pub cfg_scale: Option<String>,
    pub seed: Option<String>,
    pub width: Option<String>,
    pub height: Option<String>,
    pub model_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeSendOptionsRequest {
    pub base_url: String,
    pub api_key: Option<String>,
    pub output_dir: Option<String>,
    pub include_seed: Option<bool>,
    pub adetailer_face_enabled: Option<bool>,
    pub adetailer_face_model: Option<String>,
    pub lora_tokens: Option<Vec<String>>,
    pub lora_weight: Option<f32>,
    pub overrides: Option<ForgePayloadOverridesInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeSendToImageRequest {
    pub image_id: i64,
    pub options: ForgeSendOptionsRequest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeSendToImagesRequest {
    pub image_ids: Vec<i64>,
    pub options: ForgeSendOptionsRequest,
}

#[derive(Debug, Clone)]
struct NormalizedForgeSendOptions {
    base_url: String,
    api_key: Option<String>,
    output_dir: PathBuf,
    include_seed: bool,
    adetailer_face_enabled: bool,
    adetailer_face_model: String,
    lora_tokens: Option<Vec<String>>,
    lora_weight: f32,
    overrides: Option<ForgePayloadOverridesInput>,
}

struct ForgeSendContext<'a> {
    base_url: &'a str,
    api_key: Option<&'a str>,
    output_dir: &'a Path,
    include_seed: bool,
    adetailer_face_enabled: bool,
    adetailer_face_model: &'a str,
    lora_tokens: Option<&'a [String]>,
    lora_weight: f32,
    overrides: Option<&'a ForgePayloadOverridesInput>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForgeSendOutput {
    pub ok: bool,
    pub message: String,
    pub output_dir: String,
    pub generated_count: usize,
    pub saved_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForgeBatchItemOutput {
    pub image_id: i64,
    pub filename: String,
    pub ok: bool,
    pub message: String,
    pub generated_count: usize,
    pub saved_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForgeBatchSendOutput {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub output_dir: String,
    pub message: String,
    pub items: Vec<ForgeBatchItemOutput>,
}

fn default_forge_output_base_dir(cache_dir: &Path) -> PathBuf {
    cache_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn resolve_forge_output_dir(
    configured: Option<&str>,
    default_base_dir: &Path,
) -> Result<PathBuf, String> {
    let configured = configured.unwrap_or("").trim();
    let normalized_configured = configured
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_ascii_lowercase();
    let mut output_dir =
        if configured.is_empty() || normalized_configured == DEFAULT_FORGE_OUTPUT_DIR {
            default_base_dir.join(DEFAULT_FORGE_OUTPUT_DIR)
        } else {
            PathBuf::from(configured)
        };

    if output_dir.is_relative() {
        output_dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(output_dir);
    }

    std::fs::create_dir_all(&output_dir).map_err(|error| {
        format!(
            "Failed to create Forge output directory {}: {}",
            output_dir.display(),
            error
        )
    })?;

    Ok(output_dir)
}

fn resolve_forge_models_dir(configured: Option<&str>) -> Option<PathBuf> {
    let configured = configured.unwrap_or("").trim();
    if configured.is_empty() {
        return None;
    }

    let mut path = PathBuf::from(configured);

    if path.is_relative() {
        path = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path);
    }

    Some(path)
}

fn resolve_forge_loras_dir(configured: Option<&str>) -> Option<PathBuf> {
    resolve_forge_models_dir(configured)
}

fn normalize_forge_send_options(
    options: ForgeSendOptionsRequest,
    default_output_base: &Path,
) -> Result<NormalizedForgeSendOptions, String> {
    let include_seed = options.include_seed.unwrap_or(true);
    let adetailer_face_enabled = options.adetailer_face_enabled.unwrap_or(false);
    let adetailer_face_model = options
        .adetailer_face_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ADETAILER_FACE_MODEL)
        .to_string();
    let lora_weight = options.lora_weight.unwrap_or(1.0);
    if !lora_weight.is_finite() {
        return Err("Invalid LoRA weight value".to_string());
    }

    let output_dir = resolve_forge_output_dir(options.output_dir.as_deref(), default_output_base)?;

    Ok(NormalizedForgeSendOptions {
        base_url: options.base_url,
        api_key: options.api_key,
        output_dir,
        include_seed,
        adetailer_face_enabled,
        adetailer_face_model,
        lora_tokens: options.lora_tokens,
        lora_weight,
        overrides: options.overrides,
    })
}

fn scan_relevant_forge_models(
    models_dir: &Path,
    include_subfolders: bool,
) -> Result<Vec<String>, String> {
    if !models_dir.exists() {
        return Ok(Vec::new());
    }
    if !models_dir.is_dir() {
        return Err(format!(
            "Forge models path is not a directory: {}",
            models_dir.display()
        ));
    }

    let blocked_segments = [
        "lora",
        "loras",
        "lycoris",
        "embeddings",
        "vae",
        "controlnet",
        "hypernetwork",
        "hypernetworks",
        "upscaler",
        "upscalers",
        "esrgan",
        "codeformer",
        "gfpgan",
        "clip",
        "textualinversion",
    ];

    let mut models = std::collections::BTreeSet::new();
    let mut walker = WalkDir::new(models_dir);
    if !include_subfolders {
        walker = walker.max_depth(1);
    }

    for entry in walker
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if ext != "safetensors" && ext != "ckpt" && ext != "gguf" {
            continue;
        }

        let lowered = path.to_string_lossy().to_ascii_lowercase();
        if blocked_segments
            .iter()
            .any(|segment| lowered.contains(&format!("\\{}\\", segment)))
            || blocked_segments
                .iter()
                .any(|segment| lowered.contains(&format!("/{}/", segment)))
        {
            continue;
        }

        if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
            models.insert(name.to_string());
        }
    }

    Ok(models.into_iter().collect())
}

fn merge_unique_strings(primary: Vec<String>, secondary: Vec<String>) -> Vec<String> {
    let mut merged = Vec::with_capacity(primary.len() + secondary.len());
    let mut seen = std::collections::BTreeSet::new();

    for value in primary.into_iter().chain(secondary.into_iter()) {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            merged.push(trimmed.to_string());
        }
    }

    merged
}

fn strip_known_model_extension(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if lower.ends_with(".safetensors") {
        let truncate_len = value.len().saturating_sub(".safetensors".len());
        return value[..truncate_len].to_string();
    }
    if lower.ends_with(".ckpt") {
        let truncate_len = value.len().saturating_sub(".ckpt".len());
        return value[..truncate_len].to_string();
    }
    if lower.ends_with(".gguf") {
        let truncate_len = value.len().saturating_sub(".gguf".len());
        return value[..truncate_len].to_string();
    }
    value.to_string()
}

fn scan_relevant_forge_loras(
    loras_dir: &Path,
    include_subfolders: bool,
) -> Result<Vec<String>, String> {
    if !loras_dir.exists() {
        return Ok(Vec::new());
    }
    if !loras_dir.is_dir() {
        return Err(format!(
            "Forge LoRA path is not a directory: {}",
            loras_dir.display()
        ));
    }

    let mut loras = std::collections::BTreeSet::new();
    let mut walker = WalkDir::new(loras_dir);
    if !include_subfolders {
        walker = walker.max_depth(1);
    }

    for entry in walker
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if ext != "safetensors" && ext != "ckpt" {
            continue;
        }

        let relative = match path.strip_prefix(loras_dir) {
            Ok(value) => value,
            Err(_) => path,
        };
        let normalized_path = relative.to_string_lossy().replace('\\', "/");
        let without_extension = strip_known_model_extension(&normalized_path);
        let token = without_extension.trim().trim_start_matches("./").trim();
        if token.is_empty() {
            continue;
        }

        loras.insert(token.to_string());
    }

    Ok(loras.into_iter().collect())
}

#[tauri::command]
pub async fn forge_get_options(
    base_url: String,
    api_key: Option<String>,
    models_dir: Option<String>,
    scan_subfolders: Option<bool>,
    loras_dir: Option<String>,
    loras_scan_subfolders: Option<bool>,
) -> Result<ForgeOptionsResult, String> {
    let include_subfolders = scan_subfolders.unwrap_or(true);
    let models_path = resolve_forge_models_dir(models_dir.as_deref());
    let include_lora_subfolders = loras_scan_subfolders.unwrap_or(true);
    let loras_path = resolve_forge_loras_dir(loras_dir.as_deref());
    let scanned_models = if let Some(models_path) = models_path.clone() {
        tauri::async_runtime::spawn_blocking(move || {
            scan_relevant_forge_models(&models_path, include_subfolders)
        })
        .await
        .map_err(|error| error.to_string())??
    } else {
        Vec::new()
    };
    let scanned_loras = if let Some(loras_path) = loras_path.clone() {
        tauri::async_runtime::spawn_blocking(move || {
            scan_relevant_forge_loras(&loras_path, include_lora_subfolders)
        })
        .await
        .map_err(|error| error.to_string())??
    } else {
        Vec::new()
    };

    let mut warnings = Vec::new();

    let api_models = match forge_api::list_models(&base_url, api_key.as_deref()).await {
        Ok(values) => values,
        Err(error) => {
            warnings.push(format!("Model list unavailable from Forge API: {}", error));
            Vec::new()
        }
    };

    let samplers = match forge_api::list_samplers(&base_url, api_key.as_deref()).await {
        Ok(values) => values,
        Err(error) => {
            warnings.push(format!("Sampler list unavailable: {}", error));
            Vec::new()
        }
    };

    let schedulers = match forge_api::list_schedulers(&base_url, api_key.as_deref()).await {
        Ok(values) => values,
        Err(error) => {
            warnings.push(format!("Scheduler list unavailable: {}", error));
            Vec::new()
        }
    };

    if let Some(models_path) = models_path.as_ref() {
        if !models_path.exists() {
            warnings.push(format!(
                "Models directory not found: {}",
                models_path.display()
            ));
        }
    } else if api_models.is_empty() {
        warnings.push("Models directory not configured. Select one in the sidebar.".to_string());
    }

    if let Some(loras_path) = loras_path.as_ref() {
        if !loras_path.exists() {
            warnings.push(format!(
                "LoRA directory not found: {}",
                loras_path.display()
            ));
        }
    } else {
        warnings.push("LoRA directory not configured. Select one in the sidebar.".to_string());
    }

    let merged_models = merge_unique_strings(api_models, scanned_models);
    if merged_models.is_empty() {
        warnings.push(
            "No models detected. Configure model folder scan and verify Forge model loading."
                .to_string(),
        );
    }

    Ok(ForgeOptionsResult {
        models: merged_models,
        loras: scanned_loras,
        samplers,
        schedulers,
        models_scan_dir: models_path.map(|path| path.to_string_lossy().to_string()),
        loras_scan_dir: loras_path.map(|path| path.to_string_lossy().to_string()),
        warnings,
    })
}

fn sanitize_stem(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            sanitized.push(ch);
        } else if ch.is_whitespace() || ch == '.' {
            sanitized.push('_');
        }
    }
    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "image".to_string()
    } else {
        trimmed.to_string()
    }
}

fn extension_from_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/avif" => Some("avif"),
        "image/jxl" | "image/jpegxl" => Some("jxl"),
        _ => None,
    }
}

fn is_jpegxl_bytes(bytes: &[u8]) -> bool {
    // JXL codestream magic: 0xFF 0x0A
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0x0A {
        return true;
    }

    // JXL container signature:
    // 00 00 00 0C 4A 58 4C 20 0D 0A 87 0A
    const JXL_CONTAINER_SIGNATURE: [u8; 12] = [
        0x00, 0x00, 0x00, 0x0C, 0x4A, 0x58, 0x4C, 0x20, 0x0D, 0x0A, 0x87, 0x0A,
    ];
    bytes.starts_with(&JXL_CONTAINER_SIGNATURE)
}

fn mime_from_image_bytes(bytes: &[u8]) -> &'static str {
    if is_jpegxl_bytes(bytes) {
        return "image/jxl";
    }
    match image::guess_format(bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::WebP) => "image/webp",
        Ok(image::ImageFormat::Gif) => "image/gif",
        Ok(image::ImageFormat::Avif) => "image/avif",
        _ => "application/octet-stream",
    }
}

fn extension_from_image_bytes(bytes: &[u8]) -> &'static str {
    if is_jpegxl_bytes(bytes) {
        return "jxl";
    }
    match image::guess_format(bytes) {
        Ok(image::ImageFormat::Png) => "png",
        Ok(image::ImageFormat::Jpeg) => "jpg",
        Ok(image::ImageFormat::WebP) => "webp",
        Ok(image::ImageFormat::Gif) => "gif",
        Ok(image::ImageFormat::Avif) => "avif",
        _ => "png",
    }
}

fn decode_forge_image_payload(payload: &str) -> Result<(Vec<u8>, &'static str), String> {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        return Err("empty image payload".to_string());
    }

    let (mime, b64_data) = if let Some(rest) = trimmed.strip_prefix("data:") {
        let (mime, b64) = rest
            .split_once(";base64,")
            .ok_or_else(|| "malformed data URI payload".to_string())?;
        (Some(mime), b64)
    } else {
        (None, trimmed)
    };

    let normalized_b64: String = b64_data.chars().filter(|ch| !ch.is_whitespace()).collect();
    let decoded = BASE64_STANDARD
        .decode(normalized_b64.as_bytes())
        .map_err(|error| format!("base64 decode failed: {}", error))?;
    if decoded.is_empty() {
        return Err("decoded payload is empty".to_string());
    }

    let ext = mime
        .and_then(extension_from_mime)
        .unwrap_or_else(|| extension_from_image_bytes(&decoded));

    Ok((decoded, ext))
}

fn validate_optional_u32(field: &str, value: Option<&str>) -> Result<(), String> {
    let Some(raw) = value else {
        return Ok(());
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    trimmed
        .parse::<u32>()
        .map(|_| ())
        .map_err(|_| format!("Invalid {} value: {}", field, raw))
}

fn validate_optional_i64(field: &str, value: Option<&str>) -> Result<(), String> {
    let Some(raw) = value else {
        return Ok(());
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    trimmed
        .parse::<i64>()
        .map(|_| ())
        .map_err(|_| format!("Invalid {} value: {}", field, raw))
}

fn validate_optional_f32(field: &str, value: Option<&str>) -> Result<(), String> {
    let Some(raw) = value else {
        return Ok(());
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    trimmed
        .parse::<f32>()
        .map(|_| ())
        .map_err(|_| format!("Invalid {} value: {}", field, raw))
}

fn parse_optional_u32_override(field: &str, raw: &str) -> Result<Option<u32>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    trimmed
        .parse::<u32>()
        .map(Some)
        .map_err(|_| format!("Invalid {} value: {}", field, raw))
}

fn normalize_lora_token_for_prompt(value: &str) -> Option<String> {
    let mut token = value.trim().replace('\\', "/");
    if token.is_empty() {
        return None;
    }

    if token.to_ascii_lowercase().starts_with("<lora:") && token.ends_with('>') {
        token = token
            .trim_start_matches('<')
            .trim_end_matches('>')
            .to_string();
        if token.to_ascii_lowercase().starts_with("lora:") {
            token = token[5..].to_string();
        }
        if let Some((name, _weight)) = token.split_once(':') {
            token = name.to_string();
        }
    }

    let token = strip_known_model_extension(token.trim());
    let token = token.trim().trim_start_matches("./").trim_matches('/');
    if token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

fn strip_existing_lora_tags(prompt: &str) -> String {
    let mut output = String::with_capacity(prompt.len());
    let mut rest = prompt;

    loop {
        let lowered = rest.to_ascii_lowercase();
        let Some(start) = lowered.find("<lora:") else {
            output.push_str(rest);
            break;
        };

        output.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(end) = tail.find('>') else {
            // Keep malformed trailing chunk untouched.
            output.push_str(tail);
            break;
        };
        rest = &tail[end + 1..];
    }

    output
}

fn normalize_prompt_after_lora_strip(prompt: &str) -> String {
    prompt
        .split(',')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

fn format_lora_weight(weight: f32) -> String {
    let mut value = format!("{weight:.3}");
    while value.contains('.') && value.ends_with('0') {
        value.pop();
    }
    if value.ends_with('.') {
        value.pop();
    }
    if value.is_empty() {
        "1".to_string()
    } else {
        value
    }
}

fn apply_custom_loras_to_prompt(
    prompt: &str,
    lora_tokens: Option<&[String]>,
    lora_weight: f32,
) -> String {
    let Some(tokens) = lora_tokens else {
        return prompt.to_string();
    };

    let mut normalized_tokens = Vec::new();
    for value in tokens {
        let Some(token) = normalize_lora_token_for_prompt(value) else {
            continue;
        };
        if !normalized_tokens.contains(&token) {
            normalized_tokens.push(token);
        }
    }

    if normalized_tokens.is_empty() {
        return prompt.to_string();
    }

    let sanitized_base = normalize_prompt_after_lora_strip(&strip_existing_lora_tags(prompt));
    let weight_text = format_lora_weight(lora_weight);
    let lora_suffix = normalized_tokens
        .into_iter()
        .map(|token| format!("<lora:{}:{}>", token, weight_text))
        .collect::<Vec<_>>()
        .join(", ");

    if sanitized_base.is_empty() {
        lora_suffix
    } else {
        format!("{sanitized_base}, {lora_suffix}")
    }
}

fn build_payload_for_image(
    image: &ImageRecord,
    include_seed: bool,
    adetailer_face_enabled: bool,
    adetailer_face_model: Option<&str>,
    lora_tokens: Option<&[String]>,
    lora_weight: f32,
    overrides: Option<&ForgePayloadOverridesInput>,
) -> Result<forge_api::ForgePayload, String> {
    let override_prompt = overrides.and_then(|o| o.prompt.as_deref());
    let override_negative_prompt = overrides.and_then(|o| o.negative_prompt.as_deref());
    let override_steps = overrides.and_then(|o| o.steps.as_deref());
    let override_sampler = overrides.and_then(|o| o.sampler_name.as_deref());
    let override_scheduler = overrides.and_then(|o| o.scheduler.as_deref());
    let override_cfg_scale = overrides.and_then(|o| o.cfg_scale.as_deref());
    let override_seed = overrides.and_then(|o| o.seed.as_deref());
    let override_model = overrides.and_then(|o| o.model_name.as_deref());
    let override_width = overrides.and_then(|o| o.width.as_deref());
    let override_height = overrides.and_then(|o| o.height.as_deref());

    validate_optional_u32("steps", override_steps)?;
    validate_optional_f32("cfg scale", override_cfg_scale)?;
    validate_optional_i64("seed", override_seed)?;

    let width = match override_width {
        Some(raw) => parse_optional_u32_override("width", raw)?,
        None => image.width,
    };
    let height = match override_height {
        Some(raw) => parse_optional_u32_override("height", raw)?,
        None => image.height,
    };

    let base_prompt = override_prompt.unwrap_or(image.prompt.as_str());
    let prompt = apply_custom_loras_to_prompt(base_prompt, lora_tokens, lora_weight);
    let negative_prompt = override_negative_prompt.unwrap_or(image.negative_prompt.as_str());
    let steps = override_steps.or(image.steps.as_deref());
    let sampler = override_sampler.or(image.sampler.as_deref());
    let scheduler = override_scheduler;
    let cfg_scale = override_cfg_scale.or(image.cfg_scale.as_deref());
    let seed = override_seed.or(image.seed.as_deref());
    let model_name = override_model.or(image.model_name.as_deref());

    Ok(forge_api::build_payload_from_image_record(
        forge_api::ForgePayloadBuildInput {
            prompt: &prompt,
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
        },
    ))
}

fn save_generated_images(
    payloads: &[String],
    output_dir: &Path,
    source_filename: &str,
    variant_label: Option<&str>,
) -> Result<Vec<String>, String> {
    let stem = Path::new(source_filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_stem)
        .unwrap_or_else(|| "image".to_string());
    let variant = variant_label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(sanitize_stem);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    let mut saved_paths = Vec::with_capacity(payloads.len());
    let mut decode_failures = 0usize;

    for (index, payload) in payloads.iter().enumerate() {
        let decoded = decode_forge_image_payload(payload);
        let (bytes, ext) = match decoded {
            Ok(value) => value,
            Err(error) => {
                decode_failures += 1;
                log::warn!(
                    "Forge output decode failed for {} image {}: {}",
                    source_filename,
                    index + 1,
                    error
                );
                continue;
            }
        };

        let sequence = index + 1;
        let mut counter = 0usize;
        let output_path = loop {
            let suffix = if counter == 0 {
                String::new()
            } else {
                format!("_{}", counter)
            };
            let candidate_name = match variant.as_ref() {
                Some(variant) => format!(
                    "{}_forge_{}_{}_{}{}.{}",
                    stem, variant, stamp, sequence, suffix, ext
                ),
                None => format!("{}_forge_{}_{}{}.{}", stem, stamp, sequence, suffix, ext),
            };
            let candidate = output_dir.join(candidate_name);
            if !candidate.exists() {
                break candidate;
            }
            counter += 1;
        };

        std::fs::write(&output_path, &bytes).map_err(|error| {
            format!(
                "Failed saving generated image to {}: {}",
                output_path.display(),
                error
            )
        })?;
        saved_paths.push(output_path.to_string_lossy().to_string());
    }

    if saved_paths.is_empty() {
        if decode_failures > 0 {
            return Err("Forge returned image payloads, but none could be decoded".to_string());
        }
        return Err("Forge returned no images in response payload".to_string());
    }

    Ok(saved_paths)
}

async fn send_payload_and_save(
    payload: &forge_api::ForgePayload,
    base_url: &str,
    api_key: Option<&str>,
    output_dir: &Path,
    source_filename: &str,
    variant_label: Option<&str>,
) -> Result<Vec<String>, String> {
    let api_result = forge_api::send_to_forge(payload, base_url, api_key)
        .await
        .map_err(|e| e.to_string())?;

    if !api_result.ok {
        return Err(api_result.message);
    }

    save_generated_images(
        &api_result.images,
        output_dir,
        source_filename,
        variant_label,
    )
}

async fn send_image_record_to_forge(
    image: &ImageRecord,
    context: &ForgeSendContext<'_>,
) -> Result<ForgeSendOutput, String> {
    let mut saved_paths = Vec::new();
    let mut failures = Vec::new();
    let mut unprocessed_count = 0usize;
    let mut processed_count = 0usize;

    if context.adetailer_face_enabled {
        let unprocessed_payload = build_payload_for_image(
            image,
            context.include_seed,
            false,
            Some(context.adetailer_face_model),
            context.lora_tokens,
            context.lora_weight,
            context.overrides,
        )?;
        match send_payload_and_save(
            &unprocessed_payload,
            context.base_url,
            context.api_key,
            context.output_dir,
            &image.filename,
            Some("unprocessed"),
        )
        .await
        {
            Ok(paths) => {
                unprocessed_count = paths.len();
                saved_paths.extend(paths);
            }
            Err(error) => failures.push(format!("Unprocessed request failed: {}", error)),
        }
    }

    let processed_payload = build_payload_for_image(
        image,
        context.include_seed,
        context.adetailer_face_enabled,
        Some(context.adetailer_face_model),
        context.lora_tokens,
        context.lora_weight,
        context.overrides,
    )?;
    let processed_variant = if context.adetailer_face_enabled {
        Some("adetailer")
    } else {
        None
    };
    match send_payload_and_save(
        &processed_payload,
        context.base_url,
        context.api_key,
        context.output_dir,
        &image.filename,
        processed_variant,
    )
    .await
    {
        Ok(paths) => {
            processed_count = paths.len();
            saved_paths.extend(paths);
        }
        Err(error) => {
            if context.adetailer_face_enabled {
                failures.push(format!("ADetailer request failed: {}", error));
            } else {
                failures.push(error);
            }
        }
    }

    let generated_count = saved_paths.len();
    let output_dir_display = context.output_dir.to_string_lossy().to_string();
    if !failures.is_empty() {
        let summary = if context.adetailer_face_enabled {
            format!(
                "Saved {} unprocessed and {} ADetailer image{}",
                unprocessed_count,
                processed_count,
                if generated_count == 1 { "" } else { "s" }
            )
        } else {
            format!(
                "Saved {} generated image{}",
                processed_count,
                if processed_count == 1 { "" } else { "s" }
            )
        };
        return Ok(ForgeSendOutput {
            ok: false,
            message: format!(
                "{} to {}, but some requests failed: {}",
                summary,
                context.output_dir.display(),
                failures.join(" | ")
            ),
            output_dir: output_dir_display,
            generated_count,
            saved_paths,
        });
    }

    let message = if context.adetailer_face_enabled {
        format!(
            "Saved {} unprocessed and {} ADetailer image{} to {}",
            unprocessed_count,
            processed_count,
            if generated_count == 1 { "" } else { "s" },
            context.output_dir.display()
        )
    } else {
        format!(
            "Saved {} generated image{} to {}",
            processed_count,
            if processed_count == 1 { "" } else { "s" },
            context.output_dir.display()
        )
    };

    Ok(ForgeSendOutput {
        ok: true,
        message,
        output_dir: output_dir_display,
        generated_count,
        saved_paths,
    })
}

#[tauri::command]
pub async fn forge_send_to_image(
    request: ForgeSendToImageRequest,
    state: tauri::State<'_, AppState>,
) -> Result<ForgeSendOutput, String> {
    let ForgeSendToImageRequest { image_id, options } = request;
    let _queue_guard = state.forge_send_queue.lock().await;
    let default_output_base = default_forge_output_base_dir(&state.cache_dir);
    let normalized = normalize_forge_send_options(options, &default_output_base)?;
    let image = state
        .db
        .get_image_by_id(image_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {}", image_id))?;

    let context = ForgeSendContext {
        base_url: &normalized.base_url,
        api_key: normalized.api_key.as_deref(),
        output_dir: &normalized.output_dir,
        include_seed: normalized.include_seed,
        adetailer_face_enabled: normalized.adetailer_face_enabled,
        adetailer_face_model: &normalized.adetailer_face_model,
        lora_tokens: normalized.lora_tokens.as_deref(),
        lora_weight: normalized.lora_weight,
        overrides: normalized.overrides.as_ref(),
    };

    send_image_record_to_forge(&image, &context).await
}

#[tauri::command]
pub async fn forge_send_to_images(
    request: ForgeSendToImagesRequest,
    state: tauri::State<'_, AppState>,
) -> Result<ForgeBatchSendOutput, String> {
    let ForgeSendToImagesRequest { image_ids, options } = request;
    if image_ids.is_empty() {
        return Err("No selected images for Forge queue".to_string());
    }

    let _queue_guard = state.forge_send_queue.lock().await;
    let default_output_base = default_forge_output_base_dir(&state.cache_dir);
    let normalized = normalize_forge_send_options(options, &default_output_base)?;
    let output_dir_display = normalized.output_dir.to_string_lossy().to_string();

    let mut items = Vec::with_capacity(image_ids.len());
    let mut succeeded = 0usize;

    let context = ForgeSendContext {
        base_url: &normalized.base_url,
        api_key: normalized.api_key.as_deref(),
        output_dir: &normalized.output_dir,
        include_seed: normalized.include_seed,
        adetailer_face_enabled: normalized.adetailer_face_enabled,
        adetailer_face_model: &normalized.adetailer_face_model,
        lora_tokens: normalized.lora_tokens.as_deref(),
        lora_weight: normalized.lora_weight,
        overrides: normalized.overrides.as_ref(),
    };

    for image_id in image_ids {
        let image = match state
            .db
            .get_image_by_id(image_id)
            .map_err(|e| e.to_string())?
        {
            Some(image) => image,
            None => {
                items.push(ForgeBatchItemOutput {
                    image_id,
                    filename: "<missing>".to_string(),
                    ok: false,
                    message: format!("Image not found: {}", image_id),
                    generated_count: 0,
                    saved_paths: Vec::new(),
                });
                continue;
            }
        };

        match send_image_record_to_forge(&image, &context).await {
            Ok(result) => {
                if result.ok {
                    succeeded += 1;
                }
                items.push(ForgeBatchItemOutput {
                    image_id: image.id,
                    filename: image.filename.clone(),
                    ok: result.ok,
                    message: result.message,
                    generated_count: result.generated_count,
                    saved_paths: result.saved_paths,
                });
            }
            Err(error) => {
                items.push(ForgeBatchItemOutput {
                    image_id: image.id,
                    filename: image.filename.clone(),
                    ok: false,
                    message: error,
                    generated_count: 0,
                    saved_paths: Vec::new(),
                });
            }
        }
    }

    let total = items.len();
    let failed = total.saturating_sub(succeeded);
    let message = format!(
        "Forge queue completed: {}/{} succeeded ({} failed). Output: {}",
        succeeded, total, failed, output_dir_display
    );

    Ok(ForgeBatchSendOutput {
        total,
        succeeded,
        failed,
        output_dir: output_dir_display,
        message,
        items,
    })
}
