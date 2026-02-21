// ── Sidecar Commands ──────────────────────────────────────────────────

#[tauri::command]
pub fn get_sidecar_data(filepath: String) -> Option<sidecar::SidecarData> {
    let path = Path::new(&filepath);
    sidecar::read_sidecar(path)
}

#[tauri::command]
pub fn save_sidecar_tags(
    filepath: String,
    tags: Vec<String>,
    notes: Option<String>,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let file_path = PathBuf::from(&filepath);
    if !file_path.exists() {
        return Err(format!("File not found: {}", filepath));
    }

    // Preserve existing data (like ratings) if any
    let mut data = sidecar::read_sidecar(&file_path).unwrap_or_default();
    data.tags = tags.clone();
    data.notes = notes;

    sidecar::write_sidecar(&file_path, &data)?;

    if let Some(image_id) = state
        .db
        .get_image_id_by_filepath(&filepath)
        .map_err(|e| e.to_string())?
    {
        state
            .db
            .replace_image_tags(image_id, &data.tags)
            .map_err(|e| e.to_string())?;
    }

    Ok("Sidecar saved".to_string())
}
