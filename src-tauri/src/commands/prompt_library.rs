// ────────────────────────── Prompt library (N2) ──────────────────────────

const PROMPT_LIBRARY_FILE_VERSION: u32 = 1;
const PROMPT_LIBRARY_MAX_IMPORT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct PromptLibraryFile {
    version: u32,
    entries: Vec<crate::database::PromptEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptTagCount {
    pub tag: String,
    pub count: i64,
}

fn require_absolute_json(path: &str) -> Result<&Path, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("Path must be an absolute path".to_string());
    }
    let is_json = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("json"))
        .unwrap_or(false);
    if !is_json {
        return Err("Prompt library files must have a .json extension".to_string());
    }
    Ok(p)
}

#[tauri::command]
pub fn save_prompt(
    title: Option<String>,
    prompt: String,
    negative_prompt: Option<String>,
    tags: Option<String>,
    notes: Option<String>,
    source_image_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<crate::database::SavePromptResult, String> {
    state
        .db
        .save_prompt(
            title.as_deref(),
            &prompt,
            negative_prompt.as_deref().unwrap_or(""),
            tags.as_deref().unwrap_or(""),
            notes.as_deref().unwrap_or(""),
            source_image_id,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_prompts(
    query: Option<String>,
    tag: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    state: tauri::State<AppState>,
) -> Result<Vec<crate::database::PromptEntry>, String> {
    state
        .db
        .list_prompts(query.as_deref(), tag.as_deref(), limit.unwrap_or(100), offset.unwrap_or(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_prompt_tags(state: tauri::State<AppState>) -> Result<Vec<PromptTagCount>, String> {
    state
        .db
        .list_prompt_tags()
        .map(|rows| rows.into_iter().map(|(tag, count)| PromptTagCount { tag, count }).collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_prompt(
    id: i64,
    title: Option<String>,
    prompt: String,
    negative_prompt: Option<String>,
    tags: Option<String>,
    notes: Option<String>,
    state: tauri::State<AppState>,
) -> Result<crate::database::PromptEntry, String> {
    state
        .db
        .update_prompt(
            id,
            title.as_deref(),
            &prompt,
            negative_prompt.as_deref().unwrap_or(""),
            tags.as_deref().unwrap_or(""),
            notes.as_deref().unwrap_or(""),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_prompt(id: i64, state: tauri::State<AppState>) -> Result<bool, String> {
    state.db.delete_prompt(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn use_prompt(id: i64, state: tauri::State<AppState>) -> Result<(), String> {
    state.db.mark_prompt_used(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_prompt_library(
    output_path: String,
    state: tauri::State<AppState>,
) -> Result<usize, String> {
    let out = require_absolute_json(&output_path)?;
    let entries = state.db.export_prompts().map_err(|e| e.to_string())?;
    let count = entries.len();
    let body = serde_json::to_string_pretty(&PromptLibraryFile {
        version: PROMPT_LIBRARY_FILE_VERSION,
        entries,
    })
    .map_err(|e| e.to_string())?;
    // Write to a sibling temp file then rename so a failed export never leaves a partial file.
    let tmp = out.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("Failed to write export: {}", e))?;
    std::fs::rename(&tmp, out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to finalize export: {}", e)
    })?;
    Ok(count)
}

#[tauri::command]
pub fn import_prompt_library(
    input_path: String,
    state: tauri::State<AppState>,
) -> Result<crate::database::ImportPromptsResult, String> {
    let inp = require_absolute_json(&input_path)?;
    let size = std::fs::metadata(inp)
        .map_err(|e| format!("Cannot read file: {}", e))?
        .len();
    if size > PROMPT_LIBRARY_MAX_IMPORT_BYTES {
        return Err("Prompt library file is too large (limit 20 MB)".to_string());
    }
    let raw = std::fs::read_to_string(inp).map_err(|e| format!("Cannot read file: {}", e))?;
    let file: PromptLibraryFile =
        serde_json::from_str(&raw).map_err(|e| format!("Not a valid prompt library file: {}", e))?;
    if file.version != PROMPT_LIBRARY_FILE_VERSION {
        return Err(format!("Unsupported prompt library version {}", file.version));
    }
    state.db.import_prompts(&file.entries).map_err(|e| e.to_string())
}
