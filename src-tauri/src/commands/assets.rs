// ────────────────────────── Missing asset detector (Phase 3) ──────────────────────────
use std::collections::{BTreeMap, HashSet};

/// Status of one referenced model or LoRA.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssetStatus {
    pub name: String,
    pub found: bool,
    pub path_hint: Option<String>,
    pub referencing_image_count: u32,
}

/// Report of all referenced models/LoRAs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssetReport {
    pub models: Vec<AssetStatus>,
    pub loras: Vec<AssetStatus>,
    pub total_referenced_models: usize,
    pub total_referenced_loras: usize,
}

/// Extracts LoRA names from free text using the same conventions as `parser.rs`:
/// `<lora:name:weight>` and `<lora:name:[w@t, ...]>`. Matching is case-insensitive
/// on the `<lora:` prefix; the returned name preserves the original casing.
pub fn extract_lora_names(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    if text.is_empty() {
        return out;
    }
    let lower = text.to_ascii_lowercase();
    let mut cursor = 0usize;
    while cursor < text.len() {
        let Some(found) = lower[cursor..].find("<lora:") else {
            break;
        };
        let start = cursor + found + "<lora:".len();
        if start >= text.len() {
            break;
        }
        let rest_lower = &lower[start..];
        let end_rel = rest_lower
            .find([':', '>'])
            .unwrap_or(rest_lower.len());
        let name = text[start..start + end_rel].trim();
        if !name.is_empty() && name.len() <= 96 {
            out.push(name.to_string());
        }
        cursor = start.saturating_add(end_rel).saturating_add(1);
    }
    out
}

/// Collects every candidate file under `dir` recursively (no pixel loading).
/// Each entry is `(file_stem, basename_lower, full_path)`.
fn index_asset_dir(dir: &str) -> Vec<(String, String, String)> {
    let root = Path::new(dir);
    if !root.exists() || !root.is_dir() {
        return Vec::new();
    }
    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let basename = match path.file_name().and_then(|v| v.to_str()) {
            Some(v) => v.to_string(),
            None => continue,
        };
        let stem = path
            .file_stem()
            .and_then(|v| v.to_str())
            .unwrap_or(&basename)
            .to_string();
        files.push((
            stem,
            basename.to_ascii_lowercase(),
            path.to_string_lossy().to_string(),
        ));
    }
    files.sort_by(|a, b| a.2.cmp(&b.2));
    files
}

fn strip_known_extension(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    for ext in [".safetensors", ".ckpt", ".gguf", ".pt"] {
        if lower.ends_with(ext) && name.len() > ext.len() {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    name.to_string()
}

/// Finds `name` in an indexed asset dir by exact filename stem OR
/// case-insensitive basename/stem match. Returns the first sorted hit.
fn find_asset_path(name: &str, files: &[(String, String, String)]) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let name_lower = name.to_ascii_lowercase();
    let name_stem_lower = strip_known_extension(name).to_ascii_lowercase();
    // 1. exact filename stem (case-insensitive)
    for (stem, _, full) in files {
        if stem.to_ascii_lowercase() == name_lower
            || stem.to_ascii_lowercase() == name_stem_lower
        {
            return Some(full.clone());
        }
    }
    // 2. case-insensitive basename, stem, or extension-stripped stem
    for (stem, basename_lower, full) in files {
        if *basename_lower == name_lower
            || stem.to_ascii_lowercase() == name_lower
            || stem.to_ascii_lowercase() == name_stem_lower
        {
            return Some(full.clone());
        }
    }
    None
}

/// Core report builder, kept free of Tauri state so integration tests can call it directly.
pub fn build_asset_report(
    db: &crate::database::Database,
    dirs: &[String],
    models_dir: Option<&str>,
    loras_dir: Option<&str>,
) -> Result<AssetReport, String> {
    let cleaned: Vec<String> = dirs
        .iter()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .collect();

    let effective: Vec<String> = if cleaned.is_empty() {
        db.get_unique_directories()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|e| e.directory)
            .collect()
    } else {
        cleaned
    };

    let rows = db
        .get_asset_reference_rows(&effective)
        .map_err(|e| e.to_string())?;

    let mut model_counts: BTreeMap<String, u32> = BTreeMap::new();
    let mut lora_counts: BTreeMap<String, u32> = BTreeMap::new();

    for row in rows {
        if let Some(model) = row.0 {
            let name = model.trim().to_string();
            if !name.is_empty() && !name.eq_ignore_ascii_case("unknown") {
                *model_counts.entry(name).or_insert(0) += 1;
            }
        }
        let mut seen_in_image: HashSet<String> = HashSet::new();
        for name in extract_lora_names(&row.1) {
            seen_in_image.insert(name);
        }
        if let Some(extra) = row.2 {
            if !extra.trim().is_empty() {
                match serde_json::from_str::<HashMap<String, String>>(&extra) {
                    Ok(map) => {
                        for value in map.values() {
                            for name in extract_lora_names(value) {
                                seen_in_image.insert(name);
                            }
                        }
                    }
                    Err(_) => {
                        for name in extract_lora_names(&extra) {
                            seen_in_image.insert(name);
                        }
                    }
                }
            }
        }
        for name in seen_in_image {
            *lora_counts.entry(name).or_insert(0) += 1;
        }
    }

    let model_files = models_dir.map(index_asset_dir).unwrap_or_default();
    let lora_files = loras_dir.map(index_asset_dir).unwrap_or_default();

    let mut models: Vec<AssetStatus> = Vec::with_capacity(model_counts.len());
    for (name, count) in &model_counts {
        let path_hint = find_asset_path(name, &model_files);
        models.push(AssetStatus {
            name: name.clone(),
            found: path_hint.is_some(),
            path_hint,
            referencing_image_count: *count,
        });
    }
    models.sort_by(|a, b| a.name.cmp(&b.name));

    let mut loras: Vec<AssetStatus> = Vec::with_capacity(lora_counts.len());
    for (name, count) in &lora_counts {
        let path_hint = find_asset_path(name, &lora_files);
        loras.push(AssetStatus {
            name: name.clone(),
            found: path_hint.is_some(),
            path_hint,
            referencing_image_count: *count,
        });
    }
    loras.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(AssetReport {
        total_referenced_models: models.len(),
        total_referenced_loras: loras.len(),
        models,
        loras,
    })
}

/// Tauri command: reports referenced models/LoRAs missing from the given folders.
/// `dirs` empty means every indexed image directory. Never loads image pixels.
#[tauri::command]
pub fn detect_missing_assets(
    dirs: Vec<String>,
    models_dir: Option<String>,
    loras_dir: Option<String>,
    state: tauri::State<AppState>,
) -> Result<AssetReport, String> {
    build_asset_report(
        &state.db,
        &dirs,
        models_dir.as_deref(),
        loras_dir.as_deref(),
    )
}
