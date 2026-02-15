use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Structured representation of A1111/Forge generation parameters.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GenerationParams {
    pub prompt: String,
    pub negative_prompt: String,
    pub steps: Option<String>,
    pub sampler: Option<String>,
    pub schedule_type: Option<String>,
    pub cfg_scale: Option<String>,
    pub seed: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub model_hash: Option<String>,
    pub model_name: Option<String>,
    pub generation_type: Option<String>,
    /// All remaining key-value parameters not explicitly mapped
    pub extra_params: HashMap<String, String>,
    /// The raw, unparsed metadata string (as backup)
    pub raw_metadata: String,
}

/// Extracts normalized tags from the positive prompt.
///
/// Rules:
/// - comma-split prompt fragments
/// - LoRA tags: `<lora:name:weight>` -> `lora:name`
/// - Embedding tags: `embedding:name` -> `embedding:name`
pub fn extract_tags(prompt: &str) -> Vec<String> {
    let mut tags = HashSet::new();
    let comma_split = prompt.contains(',');

    if comma_split {
        for token in prompt.split(',') {
            if let Some(normalized) = normalize_prompt_token(token) {
                tags.insert(normalized);
            }
        }
    } else {
        extract_word_tags(prompt, &mut tags);
    }

    extract_lora_tags(prompt, &mut tags);
    extract_embedding_tags(prompt, &mut tags);

    let mut output: Vec<String> = tags.into_iter().collect();
    output.sort();
    output
}

fn extract_word_tags(prompt: &str, tags: &mut HashSet<String>) {
    const STOPWORDS: &[&str] = &[
        "the", "and", "for", "with", "from", "this", "that", "into", "onto", "your", "about",
        "then", "than", "have", "has", "had", "were", "was", "are", "you", "their", "there",
        "what", "when", "where", "while", "over", "under", "inside", "outside", "without",
        "within", "between", "through", "using", "make", "made", "just", "also", "very", "into",
    ];

    let mut added = 0usize;
    for word in prompt.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-') {
        if added >= 32 {
            break;
        }

        let lowered = word.trim().to_ascii_lowercase();
        if lowered.len() < 3 || lowered.len() > 48 {
            continue;
        }
        if STOPWORDS.contains(&lowered.as_str()) {
            continue;
        }
        if lowered.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }

        if tags.insert(lowered) {
            added += 1;
        }
    }
}

/// Key synonyms for normalization (Forge Neo, FLUX variants, etc.)
fn normalize_key(key: &str) -> &str {
    match key.trim().to_lowercase().as_str() {
        "guidance" | "distilled_cfg_scale" => "cfg_scale",
        "model" | "checkpoint" => "model",
        "schedule" => "schedule_type",
        _ => key.trim(),
    }
}

/// Parses generation metadata from both A1111/Forge-style text and JSON graph formats
/// (e.g. ComfyUI prompt metadata).
pub fn parse_generation_metadata(raw: &str) -> GenerationParams {
    let mut params = if let Some(params) = parse_json_metadata(raw) {
        params
    } else {
        parse_a1111_metadata(raw)
    };

    params.generation_type = Some(infer_generation_type(raw));
    params
}

pub fn infer_generation_type(raw_metadata: &str) -> String {
    let metadata = raw_metadata.to_ascii_lowercase();

    let is_grid = metadata.contains("script: x/y/z plot")
        || metadata.contains("script: xyz plot")
        || metadata.contains("x values:")
        || metadata.contains("y values:");
    if is_grid {
        return "grid".to_string();
    }

    let is_inpaint = metadata.contains("inpaint")
        || metadata.contains("mask blur")
        || metadata.contains("inpaint area")
        || metadata.contains("masked content")
        || metadata.contains("\"class_type\":\"inpaintmodelconditioning\"")
        || metadata.contains("\"class_type\":\"loadimagemask\"");
    if is_inpaint {
        return "inpaint".to_string();
    }

    let is_upscale = metadata.contains("upscaler")
        || metadata.contains("upscale by")
        || metadata.contains("postprocess upscaler")
        || metadata.contains("\"class_type\":\"imageupscalewithmodel\"");
    if is_upscale {
        return "upscale".to_string();
    }

    let has_img2img_markers = metadata.contains("img2img")
        || metadata.contains("denoising strength")
        || metadata.contains("init image")
        || metadata.contains("\"class_type\":\"loadimage\"");
    if has_img2img_markers {
        let has_hires_markers = metadata.contains("hires upscale")
            || metadata.contains("hires steps")
            || metadata.contains("hires upscaler")
            || metadata.contains("hires resize");
        if has_hires_markers
            && !metadata.contains("init image")
            && !metadata.contains("img2img")
            && !is_inpaint
        {
            return "txt2img".to_string();
        }
        return "img2img".to_string();
    }

    if metadata.trim().is_empty() {
        "unknown".to_string()
    } else {
        "txt2img".to_string()
    }
}

fn parse_json_metadata(raw: &str) -> Option<GenerationParams> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let mut params = GenerationParams {
        raw_metadata: raw.to_string(),
        ..Default::default()
    };

    params.prompt = first_string_field(
        &value,
        &["prompt", "Prompt", "description", "Description", "caption"],
    )
    .unwrap_or_default();
    params.negative_prompt = first_string_field(
        &value,
        &[
            "negative_prompt",
            "negativePrompt",
            "negative",
            "uc",
            "Negative prompt",
        ],
    )
    .unwrap_or_default();
    params.steps = first_scalar_field(&value, &["steps", "num_inference_steps"]);
    params.sampler = first_scalar_field(&value, &["sampler", "sampler_name", "samplerName"]);
    params.schedule_type = first_scalar_field(&value, &["scheduler", "schedule_type", "schedule"]);
    params.cfg_scale = first_scalar_field(
        &value,
        &[
            "cfg",
            "cfg_scale",
            "guidance",
            "distilled_cfg_scale",
            "scale",
        ],
    );
    params.seed = first_scalar_field(&value, &["seed"]);
    params.model_name = first_scalar_field(
        &value,
        &[
            "model",
            "model_name",
            "checkpoint",
            "ckpt_name",
            "unet_name",
        ],
    );
    params.width = first_u32_field(&value, &["width", "w"]);
    params.height = first_u32_field(&value, &["height", "h"]);

    if looks_like_comfy_prompt_graph(&value) {
        merge_comfy_graph_params(&value, &mut params);
    }

    if params.prompt.trim().is_empty() {
        let mut prompts = Vec::new();
        collect_json_string_leaves(&value, &mut prompts);
        let reduced = prompts
            .into_iter()
            .filter(|text| is_likely_prompt_text(text))
            .take(6)
            .collect::<Vec<_>>();
        if !reduced.is_empty() {
            params.prompt = reduced.join(", ");
        }
    }

    let has_any_content = !params.prompt.is_empty()
        || !params.negative_prompt.is_empty()
        || params.steps.is_some()
        || params.sampler.is_some()
        || params.cfg_scale.is_some()
        || params.seed.is_some()
        || params.width.is_some()
        || params.height.is_some()
        || params.model_name.is_some();

    if has_any_content {
        Some(params)
    } else {
        None
    }
}

fn first_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    for key in keys {
        if let Some(raw) = object.get(*key).and_then(Value::as_str) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn first_scalar_field(value: &Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    for key in keys {
        if let Some(raw) = object.get(*key) {
            match raw {
                Value::String(text) => {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
                Value::Number(number) => return Some(number.to_string()),
                Value::Bool(boolean) => return Some(boolean.to_string()),
                _ => {}
            }
        }
    }
    None
}

fn first_u32_field(value: &Value, keys: &[&str]) -> Option<u32> {
    let object = value.as_object()?;
    for key in keys {
        if let Some(raw) = object.get(*key) {
            if let Some(parsed) = raw.as_u64().and_then(|num| u32::try_from(num).ok()) {
                return Some(parsed);
            }
            if let Some(parsed) = raw
                .as_str()
                .and_then(|text| text.trim().parse::<u32>().ok())
            {
                return Some(parsed);
            }
        }
    }
    None
}

fn looks_like_comfy_prompt_graph(value: &Value) -> bool {
    value
        .as_object()
        .map(|nodes| {
            nodes.values().any(|node| {
                node.get("class_type").and_then(Value::as_str).is_some()
                    && node.get("inputs").and_then(Value::as_object).is_some()
            })
        })
        .unwrap_or(false)
}

fn merge_comfy_graph_params(value: &Value, params: &mut GenerationParams) {
    let Some(nodes) = value.as_object() else {
        return;
    };

    let mut positive_refs = Vec::new();
    let mut negative_refs = Vec::new();
    let mut fallback_positive = Vec::new();
    let mut fallback_negative = Vec::new();

    for node in nodes.values() {
        let Some(class_type) = node.get("class_type").and_then(Value::as_str) else {
            continue;
        };
        let class_lower = class_type.to_ascii_lowercase();
        let Some(inputs) = node.get("inputs").and_then(Value::as_object) else {
            continue;
        };

        if class_lower.contains("ksampler")
            || (class_lower.contains("sampler") && class_lower.contains("advanced"))
        {
            if params.steps.is_none() {
                params.steps = read_scalar_from_inputs(inputs, &["steps"]);
            }
            if params.sampler.is_none() {
                params.sampler = read_scalar_from_inputs(inputs, &["sampler_name", "sampler"]);
            }
            if params.schedule_type.is_none() {
                params.schedule_type =
                    read_scalar_from_inputs(inputs, &["scheduler", "schedule_type"]);
            }
            if params.cfg_scale.is_none() {
                params.cfg_scale =
                    read_scalar_from_inputs(inputs, &["cfg", "guidance", "distilled_cfg_scale"]);
            }
            if params.seed.is_none() {
                params.seed = read_scalar_from_inputs(inputs, &["seed", "noise_seed"]);
            }
            if let Some(positive_ref) = inputs.get("positive").and_then(extract_node_reference) {
                positive_refs.push(positive_ref);
            }
            if let Some(negative_ref) = inputs.get("negative").and_then(extract_node_reference) {
                negative_refs.push(negative_ref);
            }
        }

        if params.width.is_none() {
            params.width = read_u32_from_inputs(inputs, &["width"]);
        }
        if params.height.is_none() {
            params.height = read_u32_from_inputs(inputs, &["height"]);
        }
        if params.model_name.is_none() {
            params.model_name =
                read_scalar_from_inputs(inputs, &["ckpt_name", "model_name", "unet_name"]);
        }

        if let Some(text_value) = inputs
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            let is_negative = node
                .get("_meta")
                .and_then(|meta| meta.get("title"))
                .and_then(Value::as_str)
                .map(|title| title.to_ascii_lowercase().contains("negative"))
                .unwrap_or(false);

            if is_negative {
                fallback_negative.push(text_value.to_string());
            } else {
                fallback_positive.push(text_value.to_string());
            }
        }
    }

    let positive_texts = resolve_referenced_texts(nodes, &positive_refs);
    let negative_texts = resolve_referenced_texts(nodes, &negative_refs);

    if params.prompt.trim().is_empty() {
        params.prompt = if !positive_texts.is_empty() {
            join_unique_texts(&positive_texts)
        } else {
            join_unique_texts(&fallback_positive)
        };
    }

    if params.negative_prompt.trim().is_empty() {
        params.negative_prompt = if !negative_texts.is_empty() {
            join_unique_texts(&negative_texts)
        } else {
            join_unique_texts(&fallback_negative)
        };
    }
}

fn read_scalar_from_inputs(
    inputs: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
        if let Some(raw) = inputs.get(*key) {
            match raw {
                Value::String(text) => {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
                Value::Number(number) => return Some(number.to_string()),
                Value::Bool(boolean) => return Some(boolean.to_string()),
                _ => {}
            }
        }
    }
    None
}

fn read_u32_from_inputs(inputs: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u32> {
    for key in keys {
        if let Some(raw) = inputs.get(*key) {
            if let Some(value) = raw.as_u64().and_then(|num| u32::try_from(num).ok()) {
                return Some(value);
            }
            if let Some(value) = raw
                .as_str()
                .and_then(|text| text.trim().parse::<u32>().ok())
            {
                return Some(value);
            }
        }
    }
    None
}

fn extract_node_reference(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let array = value.as_array()?;
    let first = array.first()?;
    if let Some(text) = first.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    } else if let Some(number) = first.as_i64() {
        return Some(number.to_string());
    }
    None
}

fn resolve_referenced_texts(
    nodes: &serde_json::Map<String, Value>,
    refs: &[String],
) -> Vec<String> {
    refs.iter()
        .filter_map(|node_id| nodes.get(node_id))
        .filter_map(|node| node.get("inputs").and_then(Value::as_object))
        .filter_map(|inputs| inputs.get("text"))
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .collect()
}

fn join_unique_texts(texts: &[String]) -> String {
    let mut seen = HashSet::new();
    let mut ordered = Vec::new();
    for text in texts {
        let normalized = text.trim();
        if normalized.is_empty() {
            continue;
        }
        if seen.insert(normalized.to_ascii_lowercase()) {
            ordered.push(normalized.to_string());
        }
    }
    ordered.join(", ")
}

fn collect_json_string_leaves(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                output.push(trimmed.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_json_string_leaves(item, output);
            }
        }
        Value::Object(map) => {
            for nested in map.values() {
                collect_json_string_leaves(nested, output);
            }
        }
        _ => {}
    }
}

fn is_likely_prompt_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.len() < 3 || trimmed.len() > 280 {
        return false;
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return false;
    }
    if trimmed.contains(".ckpt") || trimmed.contains(".safetensors") {
        return false;
    }
    trimmed.chars().any(|ch| ch.is_alphabetic())
}

/// Parses a raw A1111/Forge metadata string into structured GenerationParams.
///
/// Format: `{prompt}\nNegative prompt: {neg}\nSteps: N, Sampler: X, ...`
///
/// Handles edge cases:
/// - Colons in prompt weights like `(masterpiece:1.2)`
/// - Commas within prompt text
/// - Missing negative prompt section
/// - Metadata with only parameter block (no prompt text)
pub fn parse_a1111_metadata(raw: &str) -> GenerationParams {
    let mut params = GenerationParams {
        raw_metadata: raw.to_string(),
        ..Default::default()
    };

    let raw = raw.trim();
    if raw.is_empty() {
        return params;
    }

    // Phase 1: Split into sections using specific delimiters
    // Look for "Negative prompt:" and "Steps:" as section boundaries
    let (prompt_section, neg_and_rest) = if let Some(neg_idx) = raw.find("Negative prompt:") {
        let prompt = raw[..neg_idx].trim().to_string();
        let rest = raw[neg_idx + "Negative prompt:".len()..].trim();
        (prompt, Some(rest.to_string()))
    } else {
        (raw.to_string(), None)
    };

    // Phase 2: Extract negative prompt and parameter block
    let (negative_prompt, param_block) = if let Some(ref neg_rest) = neg_and_rest {
        if let Some(steps_idx) = neg_rest.find("\nSteps:") {
            let neg = neg_rest[..steps_idx].trim().to_string();
            let params_str = neg_rest[steps_idx + 1..].trim().to_string();
            (neg, Some(params_str))
        } else if let Some(steps_idx) = neg_rest.find("Steps:") {
            // Sometimes on same line
            let neg = neg_rest[..steps_idx].trim().to_string();
            let params_str = neg_rest[steps_idx..].trim().to_string();
            (neg, Some(params_str))
        } else {
            (neg_rest.to_string(), None)
        }
    } else {
        // No negative prompt; check if Steps: appears in prompt section
        if let Some(steps_idx) = prompt_section.find("\nSteps:") {
            let prompt = prompt_section[..steps_idx].trim().to_string();
            let params_str = prompt_section[steps_idx + 1..].trim().to_string();
            params.prompt = prompt;
            (String::new(), Some(params_str))
        } else if prompt_section.starts_with("Steps:") {
            // Entire text is a parameter block
            (String::new(), Some(prompt_section.clone()))
        } else {
            params.prompt = prompt_section;
            return params;
        }
    };

    if params.prompt.is_empty() && !prompt_section.is_empty() && neg_and_rest.is_some() {
        params.prompt = prompt_section;
    }
    params.negative_prompt = negative_prompt;

    // Phase 3: Parse comma-separated key-value pairs from parameter block
    if let Some(ref param_block) = param_block {
        parse_parameter_block(param_block, &mut params);
    }

    params
}

/// Parses the `Steps: 20, Sampler: Euler a, ...` parameter block.
///
/// Uses a smart split strategy: we split on `, ` followed by a known key pattern
/// (capitalized word + colon) to avoid breaking on commas inside values like
/// `Lora hashes: "name: hash, name2: hash2"`.
fn parse_parameter_block(block: &str, params: &mut GenerationParams) {
    let pairs = split_parameter_pairs(block);

    for pair in pairs {
        // Split on first colon only
        if let Some(colon_pos) = pair.find(':') {
            let key = pair[..colon_pos].trim();
            let value = pair[colon_pos + 1..].trim();
            let normalized = normalize_key(key);

            match normalized.to_lowercase().as_str() {
                "steps" => params.steps = Some(value.to_string()),
                "sampler" => params.sampler = Some(value.to_string()),
                "schedule type" => params.schedule_type = Some(value.to_string()),
                "cfg scale" | "cfg_scale" => params.cfg_scale = Some(value.to_string()),
                "seed" => params.seed = Some(value.to_string()),
                "model hash" => params.model_hash = Some(value.to_string()),
                "model" => params.model_name = Some(value.to_string()),
                "size" => {
                    // Format: "WxH"
                    if let Some((w, h)) = value.split_once('x') {
                        params.width = w.trim().parse().ok();
                        params.height = h.trim().parse().ok();
                    }
                }
                _ => {
                    params
                        .extra_params
                        .insert(key.to_string(), value.to_string());
                }
            }
        }
    }
}

/// Splits parameter pairs on commas that look like true `Key: Value` boundaries.
///
/// We only split when `,` is followed by a key that:
/// - starts with an uppercase ASCII letter
/// - has a valid key body
/// - contains a trailing `:`
///
/// This avoids breaking values such as:
/// - `Lora hashes: "a:111, b:222"`
/// - `ADetailer prompt: foo, bar, baz`
fn split_parameter_pairs(block: &str) -> Vec<String> {
    let mut pairs = Vec::new();
    let mut start = 0usize;
    let mut in_quotes = false;

    for (idx, ch) in block.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes && is_key_boundary_after_comma(block, idx + 1) => {
                let segment = block[start..idx].trim();
                if !segment.is_empty() {
                    pairs.push(segment.to_string());
                }
                start = idx + 1;
            }
            _ => {}
        }
    }

    let tail = block[start..].trim();
    if !tail.is_empty() {
        pairs.push(tail.to_string());
    }

    pairs
}

fn is_key_boundary_after_comma(block: &str, from_idx: usize) -> bool {
    let bytes = block.as_bytes();
    let mut idx = from_idx;

    while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
        idx += 1;
    }
    if idx >= bytes.len() || !bytes[idx].is_ascii_uppercase() {
        return false;
    }

    let key_start = idx;
    while idx < bytes.len() {
        let b = bytes[idx];
        if b == b':' {
            return idx > key_start;
        }
        if b == b',' || b == b'\n' || b == b'\r' {
            return false;
        }

        let is_valid_key_char = b.is_ascii_alphanumeric()
            || matches!(b, b' ' | b'_' | b'-' | b'/' | b'.' | b'(' | b')');
        if !is_valid_key_char {
            return false;
        }
        idx += 1;
    }

    false
}

fn normalize_prompt_token(token: &str) -> Option<String> {
    let trimmed = token.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }

    // Ignore raw LoRA tokens in the generic token pass.
    if trimmed.to_ascii_lowercase().starts_with("<lora:") {
        return None;
    }

    let unwrapped = trimmed
        .strip_prefix('(')
        .and_then(|v| v.strip_suffix(')'))
        .unwrap_or(trimmed);

    // Convert weighted prompt `(foo:1.2)` to `foo`.
    let canonical = if let Some((name, maybe_weight)) = unwrapped.rsplit_once(':') {
        if maybe_weight.trim().parse::<f32>().is_ok() {
            name.trim()
        } else {
            unwrapped
        }
    } else {
        unwrapped
    };

    if canonical.len() < 2 || canonical.len() > 96 {
        return None;
    }

    Some(canonical.to_ascii_lowercase())
}

fn extract_lora_tags(prompt: &str, tags: &mut HashSet<String>) {
    let lower = prompt.to_ascii_lowercase();
    let mut cursor = 0usize;

    while let Some(found) = lower[cursor..].find("<lora:") {
        let start = cursor + found + "<lora:".len();
        let rest = &prompt[start..];
        let end = rest.find([':', '>']).unwrap_or(rest.len());
        let name = rest[..end].trim();

        if !name.is_empty() && name.len() <= 96 {
            tags.insert(format!("lora:{}", name.to_ascii_lowercase()));
        }

        cursor = start.saturating_add(end).saturating_add(1);
        if cursor >= prompt.len() {
            break;
        }
    }
}

fn extract_embedding_tags(prompt: &str, tags: &mut HashSet<String>) {
    for word in prompt.split(|c: char| c.is_whitespace() || c == ',') {
        let lowered = word.to_ascii_lowercase();
        if let Some(name) = lowered.strip_prefix("embedding:") {
            let cleaned = name
                .trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
                .trim();
            if !cleaned.is_empty() && cleaned.len() <= 96 {
                tags.insert(format!("embedding:{}", cleaned));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_METADATA: &str = r#"<lora:norman_rockwell_style_pony_v6-000040:0.6> <lora:Higashiyama_Shou_PonyXL_Style:0.7>  zPDXL3 zPDXLxxx,brown_eyes brown_hair,flat_chest highres,medium_hair,petite,wispy_bangs,hair_over_one_eye,<lora:Age Slider V2_alpha1.0_rank4_noxattn_last:-3.6> <lora:BetterFaces:0.7>,open_jacket,anime_coloring
Steps: 30, Sampler: Euler a, Schedule type: Karras, CFG scale: 5, Seed: 87358210, Size: 896x1152, Model hash: 747bbe7d2d, Model: SuzannesSnowRainFissionTernaryponyRealism, ADetailer model: face_yolov8n.pt, ADetailer confidence: 0.8, Version: f2.0.1v1.10.1-previous-659-gc055f2d4"#;

    const SAMPLE_WITH_NEGATIVE: &str = r#"masterpiece, best quality, 1girl, solo
Negative prompt: worst quality, low quality, normal quality
Steps: 20, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, Size: 512x768, Model hash: abc123, Model: anything-v5"#;

    #[test]
    fn test_parse_valid_metadata() {
        let params = parse_a1111_metadata(SAMPLE_METADATA);
        assert!(params.prompt.contains("norman_rockwell_style_pony"));
        assert!(params.prompt.contains("anime_coloring"));
        assert_eq!(params.steps.as_deref(), Some("30"));
        assert_eq!(params.sampler.as_deref(), Some("Euler a"));
        assert_eq!(params.cfg_scale.as_deref(), Some("5"));
        assert_eq!(params.seed.as_deref(), Some("87358210"));
        assert_eq!(params.width, Some(896));
        assert_eq!(params.height, Some(1152));
        assert_eq!(params.model_hash.as_deref(), Some("747bbe7d2d"));
        assert_eq!(
            params.model_name.as_deref(),
            Some("SuzannesSnowRainFissionTernaryponyRealism")
        );
    }

    #[test]
    fn test_parse_with_negative_prompt() {
        let params = parse_a1111_metadata(SAMPLE_WITH_NEGATIVE);
        assert_eq!(params.prompt, "masterpiece, best quality, 1girl, solo");
        assert_eq!(
            params.negative_prompt,
            "worst quality, low quality, normal quality"
        );
        assert_eq!(params.steps.as_deref(), Some("20"));
        assert_eq!(params.sampler.as_deref(), Some("DPM++ 2M Karras"));
        assert_eq!(params.seed.as_deref(), Some("12345"));
        assert_eq!(params.width, Some(512));
        assert_eq!(params.height, Some(768));
    }

    #[test]
    fn test_parse_weighted_prompts() {
        let raw = "(masterpiece:1.2), (best quality:1.4), 1girl\nSteps: 15, Sampler: Euler, CFG scale: 7.5, Seed: 999, Size: 512x512";
        let params = parse_a1111_metadata(raw);
        assert!(params.prompt.contains("(masterpiece:1.2)"));
        assert!(params.prompt.contains("(best quality:1.4)"));
        assert_eq!(params.steps.as_deref(), Some("15"));
        assert_eq!(params.cfg_scale.as_deref(), Some("7.5"));
    }

    #[test]
    fn test_parse_parameter_values_with_commas() {
        let raw = r#"portrait of a cat
Steps: 20, Sampler: Euler a, Lora hashes: "foo:111, bar:222", ADetailer prompt: face, eyes, smile, CFG scale: 7, Seed: 42"#;

        let params = parse_a1111_metadata(raw);

        assert_eq!(params.steps.as_deref(), Some("20"));
        assert_eq!(params.sampler.as_deref(), Some("Euler a"));
        assert_eq!(params.cfg_scale.as_deref(), Some("7"));
        assert_eq!(params.seed.as_deref(), Some("42"));
        assert_eq!(
            params.extra_params.get("Lora hashes").map(String::as_str),
            Some(r#""foo:111, bar:222""#)
        );
        assert_eq!(
            params
                .extra_params
                .get("ADetailer prompt")
                .map(String::as_str),
            Some("face, eyes, smile")
        );
    }

    #[test]
    fn test_parse_empty() {
        let params = parse_a1111_metadata("");
        assert!(params.prompt.is_empty());
        assert!(params.steps.is_none());
    }

    #[test]
    fn test_extract_tags_from_prompt_and_lora_embedding() {
        let prompt = "(masterpiece:1.2), 1girl, cinematic lighting, <lora:MyStyle:0.7>, embedding:EasyNegative";
        let tags = extract_tags(prompt);

        assert!(tags.contains(&"masterpiece".to_string()));
        assert!(tags.contains(&"1girl".to_string()));
        assert!(tags.contains(&"cinematic lighting".to_string()));
        assert!(tags.contains(&"lora:mystyle".to_string()));
        assert!(tags.contains(&"embedding:easynegative".to_string()));
    }

    #[test]
    fn test_extract_tags_from_natural_language_prompt() {
        let prompt = "Portrait of Donald Trump standing in Times Square with dramatic lighting";
        let tags = extract_tags(prompt);

        assert!(tags.contains(&"trump".to_string()));
        assert!(tags.contains(&"portrait".to_string()));
        assert!(tags.contains(&"times".to_string()));
    }

    #[test]
    fn test_parse_generation_metadata_from_comfy_prompt_graph() {
        let raw = r#"{
            "3": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 987654,
                    "steps": 30,
                    "cfg": 4.5,
                    "sampler_name": "euler",
                    "scheduler": "karras",
                    "positive": ["6", 0],
                    "negative": ["7", 0]
                }
            },
            "4": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {
                    "ckpt_name": "flux1-dev.safetensors"
                }
            },
            "6": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "Donald Trump giving a speech in New York"
                }
            },
            "7": {
                "class_type": "CLIPTextEncode",
                "_meta": {
                    "title": "CLIP Text Encode (Negative Prompt)"
                },
                "inputs": {
                    "text": "low quality, blurry"
                }
            }
        }"#;

        let params = parse_generation_metadata(raw);
        assert!(params.prompt.contains("Donald Trump"));
        assert_eq!(params.negative_prompt, "low quality, blurry");
        assert_eq!(params.steps.as_deref(), Some("30"));
        assert_eq!(params.cfg_scale.as_deref(), Some("4.5"));
        assert_eq!(params.sampler.as_deref(), Some("euler"));
        assert_eq!(params.schedule_type.as_deref(), Some("karras"));
        assert_eq!(params.seed.as_deref(), Some("987654"));
        assert_eq!(params.model_name.as_deref(), Some("flux1-dev.safetensors"));
    }
}
