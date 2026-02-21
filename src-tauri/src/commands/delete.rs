// ────────────────────────── Gallery management ──────────────────────────

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeleteMode {
    Permanent,
    Trash,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteImagesRequest {
    pub ids: Vec<i64>,
    pub mode: DeleteMode,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteImagesResult {
    pub requested: usize,
    pub removed_from_db: usize,
    pub deleted_ids: Vec<i64>,
    pub deleted_files: usize,
    pub missing_files: usize,
    pub failed_files: usize,
    pub deleted_sidecars: usize,
    pub deleted_thumbnails: usize,
    pub blocked_protected: usize,
    pub blocked_protected_ids: Vec<i64>,
    pub failed_paths: Vec<String>,
}

const KNOWN_SIDECAR_EXTENSIONS: [&str; 3] = ["yaml", "yml", "json"];

fn remove_known_sidecars(source_path: &Path) -> usize {
    let mut removed = 0usize;
    for ext in KNOWN_SIDECAR_EXTENSIONS {
        let sidecar_path = source_path.with_extension(ext);
        if !sidecar_path.exists() {
            continue;
        }
        match std::fs::remove_file(&sidecar_path) {
            Ok(_) => removed += 1,
            Err(error) => log::warn!(
                "Failed to delete sidecar {}: {}",
                sidecar_path.display(),
                error
            ),
        }
    }
    removed
}

fn remove_thumbnail_cache_file(
    source_path: &Path,
    cache_dir: &Path,
    thumbnail_index: &std::sync::Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
) -> usize {
    let thumbnail_path = image_processing::get_thumbnail_cache_path(source_path, cache_dir);
    let thumbnail_key = thumbnail_path.to_string_lossy().to_string();
    if let Ok(mut index) = thumbnail_index.write() {
        index.remove(&thumbnail_key);
    }

    if !thumbnail_path.exists() {
        return 0;
    }

    match std::fs::remove_file(&thumbnail_path) {
        Ok(_) => 1,
        Err(error) => {
            log::warn!(
                "Failed to delete cached thumbnail {}: {}",
                thumbnail_path.display(),
                error
            );
            0
        }
    }
}

fn delete_file_with_mode(path: &Path, mode: DeleteMode) -> Result<(), String> {
    match mode {
        DeleteMode::Permanent => std::fs::remove_file(path).map_err(|error| error.to_string()),
        DeleteMode::Trash => move_to_trash(path),
    }
}

#[cfg(target_os = "windows")]
fn move_to_trash(path: &Path) -> Result<(), String> {
    let escaped_path = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; \
         [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(\
         '{}',\
         [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,\
         [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
        escaped_path
    );

    let mut output_result: Option<std::process::Output> = None;
    for shell in ["powershell", "pwsh"] {
        match std::process::Command::new(shell)
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
        {
            Ok(output) => {
                output_result = Some(output);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to invoke {} recycle-bin delete: {}",
                    shell, error
                ));
            }
        }
    }

    let output = output_result.ok_or_else(|| {
        "Neither powershell nor pwsh was found for recycle-bin delete.".to_string()
    })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!(
            "PowerShell recycle-bin delete failed with status {}",
            output.status
        ))
    } else {
        Err(stderr)
    }
}

fn move_file_with_fallback(source: &Path, destination: &Path) -> Result<(), String> {
    let destination_parent = destination.parent().ok_or_else(|| {
        format!(
            "Destination path {} has no parent directory.",
            destination.display()
        )
    })?;
    std::fs::create_dir_all(destination_parent).map_err(|error| {
        format!(
            "Failed to create destination directory {}: {}",
            destination_parent.display(),
            error
        )
    })?;

    match std::fs::rename(source, destination) {
        Ok(_) => Ok(()),
        Err(rename_error) => {
            if !matches!(rename_error.raw_os_error(), Some(17) | Some(18)) {
                return Err(format!(
                    "Failed to move {} to {}: {}",
                    source.display(),
                    destination.display(),
                    rename_error
                ));
            }

            std::fs::copy(source, destination).map_err(|copy_error| {
                format!(
                    "Failed to copy {} to {} after cross-device move failure: {}",
                    source.display(),
                    destination.display(),
                    copy_error
                )
            })?;
            std::fs::remove_file(source).map_err(|remove_error| {
                format!(
                    "Failed to remove {} after copying to {}: {}",
                    source.display(),
                    destination.display(),
                    remove_error
                )
            })
        }
    }
}

fn move_known_sidecars(source_path: &Path, destination_path: &Path) {
    for ext in KNOWN_SIDECAR_EXTENSIONS {
        let sidecar_source = source_path.with_extension(ext);
        if !sidecar_source.exists() {
            continue;
        }
        let sidecar_destination = destination_path.with_extension(ext);
        if let Err(error) = move_file_with_fallback(&sidecar_source, &sidecar_destination) {
            log::warn!(
                "Failed to move sidecar {} to {}: {}",
                sidecar_source.display(),
                sidecar_destination.display(),
                error
            );
        }
    }
}

fn move_thumbnail_cache_file(
    source_path: &Path,
    destination_path: &Path,
    cache_dir: &Path,
    thumbnail_index: &std::sync::Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
) {
    let source_thumbnail_path = image_processing::get_thumbnail_cache_path(source_path, cache_dir);
    let source_thumbnail_key = source_thumbnail_path.to_string_lossy().to_string();

    if let Ok(mut index) = thumbnail_index.write() {
        index.remove(&source_thumbnail_key);
    }

    if !source_thumbnail_path.exists() {
        return;
    }

    let destination_thumbnail_path =
        image_processing::get_thumbnail_cache_path(destination_path, cache_dir);
    if let Err(error) = move_file_with_fallback(&source_thumbnail_path, &destination_thumbnail_path)
    {
        log::warn!(
            "Failed to move thumbnail cache {} to {}: {}",
            source_thumbnail_path.display(),
            destination_thumbnail_path.display(),
            error
        );
        return;
    }

    let destination_thumbnail_key = destination_thumbnail_path.to_string_lossy().to_string();
    if let Ok(mut index) = thumbnail_index.write() {
        index.insert(destination_thumbnail_key);
    }
}

fn resolve_move_destination_path(
    source_path: &Path,
    destination_directory: &Path,
    image_id: i64,
    state: &tauri::State<'_, AppState>,
) -> Result<PathBuf, String> {
    let original_filename = source_path.file_name().ok_or_else(|| {
        format!(
            "Failed to resolve destination for {} (missing filename).",
            source_path.display()
        )
    })?;
    let stem = source_path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string());
    let extension = source_path
        .extension()
        .map(|value| value.to_string_lossy().to_string());

    for suffix in 0..10_000usize {
        let filename = if suffix == 0 {
            original_filename.to_string_lossy().to_string()
        } else if let Some(ext) = &extension {
            format!("{}_{}.{}", stem, suffix, ext)
        } else {
            format!("{}_{}", stem, suffix)
        };

        let candidate = destination_directory.join(filename);
        if candidate == source_path {
            return Ok(candidate);
        }
        if candidate.exists() {
            continue;
        }

        let candidate_string = candidate.to_string_lossy().to_string();
        let existing_id = state
            .db
            .get_image_id_by_filepath(&candidate_string)
            .map_err(|error| format!("Failed to validate move destination path: {}", error))?;
        if let Some(existing_id) = existing_id {
            if existing_id != image_id {
                continue;
            }
        }

        return Ok(candidate);
    }

    Err(format!(
        "Failed to find a free destination filename in {} for {}.",
        destination_directory.display(),
        source_path.display()
    ))
}

#[cfg(not(target_os = "windows"))]
fn move_to_trash(path: &Path) -> Result<(), String> {
    let home = std::env::var("HOME")
        .map_err(|error| format!("Failed to resolve HOME for trash path: {}", error))?;
    #[cfg(target_os = "macos")]
    let trash_dir = PathBuf::from(home).join(".Trash");
    #[cfg(not(target_os = "macos"))]
    let trash_dir = PathBuf::from(home).join(".local/share/Trash/files");

    std::fs::create_dir_all(&trash_dir).map_err(|error| {
        format!(
            "Failed to create trash directory {}: {}",
            trash_dir.display(),
            error
        )
    })?;

    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Invalid file name for trash move: {}", path.display()))?;
    let mut target_path = trash_dir.join(file_name);
    if target_path.exists() {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let base_name = file_name.to_string_lossy();
        target_path = trash_dir.join(format!("{}_{}", millis, base_name));
    }

    match std::fs::rename(path, &target_path) {
        Ok(_) => Ok(()),
        Err(rename_error) => {
            const EXDEV: i32 = 18;
            if rename_error.raw_os_error() != Some(EXDEV) {
                return Err(format!(
                    "Failed to move {} to trash {}: {}",
                    path.display(),
                    target_path.display(),
                    rename_error
                ));
            }

            std::fs::copy(path, &target_path).map_err(|copy_error| {
                format!(
                    "Failed to copy {} to trash {} after cross-device move failure: {}",
                    path.display(),
                    target_path.display(),
                    copy_error
                )
            })?;
            std::fs::remove_file(path).map_err(|remove_error| {
                format!(
                    "Failed to remove {} after copying to trash {}: {}",
                    path.display(),
                    target_path.display(),
                    remove_error
                )
            })
        }
    }
}

/// Deletes image files from disk and removes corresponding DB rows.
///
/// Images that fail to delete on disk are left in the database.
#[tauri::command]
pub fn delete_images(
    request: DeleteImagesRequest,
    state: tauri::State<'_, AppState>,
) -> Result<DeleteImagesResult, String> {
    if request.ids.is_empty() {
        return Ok(DeleteImagesResult {
            requested: 0,
            removed_from_db: 0,
            deleted_ids: Vec::new(),
            deleted_files: 0,
            missing_files: 0,
            failed_files: 0,
            deleted_sidecars: 0,
            deleted_thumbnails: 0,
            blocked_protected: 0,
            blocked_protected_ids: Vec::new(),
            failed_paths: Vec::new(),
        });
    }

    let mut unique_ids = request.ids;
    unique_ids.sort_unstable();
    unique_ids.dedup();
    let requested = unique_ids.len();

    let records = state
        .db
        .get_images_by_ids(&unique_ids)
        .map_err(|error| format!("Failed to resolve images for deletion: {}", error))?;

    if records.is_empty() {
        return Ok(DeleteImagesResult {
            requested,
            removed_from_db: 0,
            deleted_ids: Vec::new(),
            deleted_files: 0,
            missing_files: 0,
            failed_files: 0,
            deleted_sidecars: 0,
            deleted_thumbnails: 0,
            blocked_protected: 0,
            blocked_protected_ids: Vec::new(),
            failed_paths: Vec::new(),
        });
    }

    let mut deleted_files = 0usize;
    let mut missing_files = 0usize;
    let mut failed_files = 0usize;
    let mut failed_paths = Vec::<String>::new();
    let mut deletable = Vec::<(i64, String)>::new();
    let mut blocked_protected_ids = Vec::<i64>::new();

    for record in &records {
        if record.is_locked || record.is_favorite {
            blocked_protected_ids.push(record.id);
            continue;
        }

        let source_path = PathBuf::from(&record.filepath);
        if source_path.exists() {
            match delete_file_with_mode(&source_path, request.mode) {
                Ok(_) => {
                    deleted_files += 1;
                    deletable.push((record.id, record.filepath.clone()));
                }
                Err(error) => {
                    failed_files += 1;
                    failed_paths.push(format!("{} ({})", record.filepath, error));
                }
            }
        } else {
            missing_files += 1;
            deletable.push((record.id, record.filepath.clone()));
        }
    }

    let mut deleted_sidecars = 0usize;
    let mut deleted_thumbnails = 0usize;
    let deleted_ids: Vec<i64> = deletable.iter().map(|(id, _)| *id).collect();

    for (_, filepath) in &deletable {
        let source_path = Path::new(filepath);
        deleted_sidecars += remove_known_sidecars(source_path);
        deleted_thumbnails +=
            remove_thumbnail_cache_file(source_path, &state.cache_dir, &state.thumbnail_index);
    }

    if let Ok(mut failed_thumbnail_sources) = state.failed_thumbnail_sources.write() {
        for (_, filepath) in &deletable {
            failed_thumbnail_sources.remove(filepath);
        }
    }

    let removed_from_db = state
        .db
        .delete_images_by_ids(&deleted_ids)
        .map_err(|error| format!("Failed to remove deleted images from database: {}", error))?;

    Ok(DeleteImagesResult {
        requested,
        removed_from_db,
        deleted_ids,
        deleted_files,
        missing_files,
        failed_files,
        deleted_sidecars,
        deleted_thumbnails,
        blocked_protected: blocked_protected_ids.len(),
        blocked_protected_ids,
        failed_paths,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveImagesRequest {
    pub ids: Vec<i64>,
    pub destination_directory: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MovedImageRecord {
    pub id: i64,
    pub filepath: String,
    pub filename: String,
    pub directory: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoveImagesResult {
    pub requested: usize,
    pub moved_files: usize,
    pub updated_in_db: usize,
    pub moved_ids: Vec<i64>,
    pub moved_items: Vec<MovedImageRecord>,
    pub skipped_missing: usize,
    pub skipped_same_directory: usize,
    pub failed: usize,
    pub failed_paths: Vec<String>,
}

#[tauri::command]
pub fn move_images_to_directory(
    request: MoveImagesRequest,
    state: tauri::State<'_, AppState>,
) -> Result<MoveImagesResult, String> {
    if request.ids.is_empty() {
        return Ok(MoveImagesResult {
            requested: 0,
            moved_files: 0,
            updated_in_db: 0,
            moved_ids: Vec::new(),
            moved_items: Vec::new(),
            skipped_missing: 0,
            skipped_same_directory: 0,
            failed: 0,
            failed_paths: Vec::new(),
        });
    }

    let destination_directory = PathBuf::from(request.destination_directory.trim());
    if request.destination_directory.trim().is_empty() {
        return Err("Destination directory is required.".to_string());
    }
    if !destination_directory.exists() {
        return Err(format!(
            "Destination directory does not exist: {}",
            destination_directory.display()
        ));
    }
    if !destination_directory.is_dir() {
        return Err(format!(
            "Destination path is not a directory: {}",
            destination_directory.display()
        ));
    }

    let mut unique_ids = request.ids;
    unique_ids.sort_unstable();
    unique_ids.dedup();
    let requested = unique_ids.len();

    let records = state
        .db
        .get_images_by_ids(&unique_ids)
        .map_err(|error| format!("Failed to resolve images for moving: {}", error))?;
    if records.is_empty() {
        return Ok(MoveImagesResult {
            requested,
            moved_files: 0,
            updated_in_db: 0,
            moved_ids: Vec::new(),
            moved_items: Vec::new(),
            skipped_missing: 0,
            skipped_same_directory: 0,
            failed: 0,
            failed_paths: Vec::new(),
        });
    }

    let mut moved_ids = Vec::<i64>::new();
    let mut moved_items = Vec::<MovedImageRecord>::new();
    let mut skipped_missing = 0usize;
    let mut skipped_same_directory = 0usize;
    let mut failed_paths = Vec::<String>::new();

    for record in records {
        let source_path = PathBuf::from(&record.filepath);
        if !source_path.exists() {
            skipped_missing += 1;
            continue;
        }

        let source_parent = source_path.parent().map(Path::to_path_buf);
        if source_parent.as_deref() == Some(destination_directory.as_path()) {
            skipped_same_directory += 1;
            continue;
        }

        let destination_path =
            resolve_move_destination_path(&source_path, &destination_directory, record.id, &state)?;
        if destination_path == source_path {
            skipped_same_directory += 1;
            continue;
        }

        if let Err(error) = move_file_with_fallback(&source_path, &destination_path) {
            failed_paths.push(format!("{} ({})", record.filepath, error));
            continue;
        }

        move_known_sidecars(&source_path, &destination_path);
        move_thumbnail_cache_file(
            &source_path,
            &destination_path,
            &state.cache_dir,
            &state.thumbnail_index,
        );

        let new_filepath = destination_path.to_string_lossy().to_string();
        let new_filename = destination_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| record.filename.clone());
        let new_directory = destination_path
            .parent()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(String::new);

        match state
            .db
            .update_image_location(record.id, &new_filepath, &new_filename, &new_directory)
        {
            Ok(true) => {
                moved_ids.push(record.id);
                moved_items.push(MovedImageRecord {
                    id: record.id,
                    filepath: new_filepath.clone(),
                    filename: new_filename,
                    directory: new_directory,
                });

                if let Ok(mut failed_thumbnail_sources) = state.failed_thumbnail_sources.write() {
                    if failed_thumbnail_sources.remove(&record.filepath) {
                        failed_thumbnail_sources.insert(new_filepath);
                    }
                }
            }
            Ok(false) => {
                failed_paths.push(format!(
                    "{} (database record missing during location update)",
                    record.filepath
                ));
                let _ = move_file_with_fallback(&destination_path, &source_path);
                move_known_sidecars(&destination_path, &source_path);
                move_thumbnail_cache_file(
                    &destination_path,
                    &source_path,
                    &state.cache_dir,
                    &state.thumbnail_index,
                );
            }
            Err(error) => {
                failed_paths.push(format!(
                    "{} (failed to update database location: {})",
                    record.filepath, error
                ));
                let _ = move_file_with_fallback(&destination_path, &source_path);
                move_known_sidecars(&destination_path, &source_path);
                move_thumbnail_cache_file(
                    &destination_path,
                    &source_path,
                    &state.cache_dir,
                    &state.thumbnail_index,
                );
            }
        }
    }

    let moved_files = moved_ids.len();
    Ok(MoveImagesResult {
        requested,
        moved_files,
        updated_in_db: moved_files,
        moved_ids,
        moved_items,
        skipped_missing,
        skipped_same_directory,
        failed: failed_paths.len(),
        failed_paths,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetImagesFavoriteRequest {
    pub ids: Vec<i64>,
    pub is_favorite: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetImagesLockedRequest {
    pub ids: Vec<i64>,
    pub is_locked: bool,
}

#[tauri::command]
pub fn set_images_favorite(
    request: SetImagesFavoriteRequest,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    if request.ids.is_empty() {
        return Ok(0);
    }
    let mut unique_ids = request.ids;
    unique_ids.sort_unstable();
    unique_ids.dedup();
    state
        .db
        .set_images_favorite(&unique_ids, request.is_favorite)
        .map_err(|error| format!("Failed to update selected favorites: {}", error))
}

#[tauri::command]
pub fn set_images_locked(
    request: SetImagesLockedRequest,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    if request.ids.is_empty() {
        return Ok(0);
    }
    let mut unique_ids = request.ids;
    unique_ids.sort_unstable();
    unique_ids.dedup();
    state
        .db
        .set_images_locked(&unique_ids, request.is_locked)
        .map_err(|error| format!("Failed to update selected lock state: {}", error))
}

#[tauri::command]
pub fn set_image_favorite(
    image_id: i64,
    is_favorite: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .db
        .set_image_favorite(image_id, is_favorite)
        .map_err(|error| format!("Failed to update favorite state: {}", error))
}

#[tauri::command]
pub fn set_image_locked(
    image_id: i64,
    is_locked: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .db
        .set_image_locked(image_id, is_locked)
        .map_err(|error| format!("Failed to update lock state: {}", error))
}
