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
    pub db_error: Option<String>,
}

pub(crate) fn is_sidecar_source_failed(
    sidecar: &Path,
    failed_sources: &std::collections::HashSet<PathBuf>,
) -> bool {
    let sidecar_dir = match sidecar.parent() {
        Some(d) => d,
        None => return false,
    };
    let sidecar_stem = match sidecar.file_stem().and_then(|s| s.to_str()) {
        Some(s) => s,
        None => return false,
    };
    failed_sources.iter().any(|src| {
        let same_dir = src.parent() == Some(sidecar_dir);
        let same_stem = if cfg!(windows) {
            src.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase())
                == Some(sidecar_stem.to_lowercase())
        } else {
            src.file_stem().and_then(|s| s.to_str()) == Some(sidecar_stem)
        };
        same_dir && same_stem
    })
}

const KNOWN_SIDECAR_EXTENSIONS: [&str; 3] = ["yaml", "yml", "json"];

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
    db: &crate::database::Database,
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
        let existing_id = db
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

/// Deletes image files from disk and removes corresponding DB rows.
///
/// Images that fail to delete on disk are left in the database.
pub fn delete_images_sync(
    request: DeleteImagesRequest,
    db: &crate::database::Database,
    cache_dir: &Path,
    thumbnail_index: &std::sync::Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
    failed_thumbnail_sources: &std::sync::Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
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
            db_error: None,
        });
    }

    let mut unique_ids = request.ids;
    unique_ids.sort_unstable();
    unique_ids.dedup();
    let requested = unique_ids.len();

    let records = db
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
            db_error: None,
        });
    }

    let mut candidate_records = Vec::new();
    let mut blocked_protected_ids = Vec::new();

    for record in &records {
        if record.is_locked {
            blocked_protected_ids.push(record.id);
        } else {
            candidate_records.push(record);
        }
    }

    // Determine unshared stems: if no other indexed image in DB shares the stem, sidecars can be removed
    let mut batch_stem_counts = std::collections::HashMap::<(String, String), usize>::new();
    for record in &candidate_records {
        if let Some(stem) = Path::new(&record.filename)
            .file_stem()
            .and_then(|s| s.to_str())
        {
            let stem_key = if cfg!(windows) {
                stem.to_lowercase()
            } else {
                stem.to_string()
            };
            *batch_stem_counts
                .entry((record.directory.clone(), stem_key))
                .or_insert(0) += 1;
        }
    }

    let mut stem_is_unshared = std::collections::HashMap::<(String, String), bool>::new();
    for ((dir, stem_key), &batch_count) in &batch_stem_counts {
        let total_db_count = db.count_images_with_stem(dir, stem_key).unwrap_or(usize::MAX);
        stem_is_unshared.insert((dir.clone(), stem_key.clone()), total_db_count <= batch_count);
    }

    // Collect eligible sidecars for unshared stems
    let mut eligible_sidecars = std::collections::HashSet::<PathBuf>::new();
    for record in &candidate_records {
        if let Some(stem) = Path::new(&record.filename)
            .file_stem()
            .and_then(|s| s.to_str())
        {
            let stem_key = if cfg!(windows) {
                stem.to_lowercase()
            } else {
                stem.to_string()
            };
            if stem_is_unshared.get(&(record.directory.clone(), stem_key)) == Some(&true) {
                let source_path = Path::new(&record.filepath);
                for ext in KNOWN_SIDECAR_EXTENSIONS {
                    let sidecar_path = source_path.with_extension(ext);
                    if sidecar_path.is_file() {
                        eligible_sidecars.insert(sidecar_path);
                    }
                }
            }
        }
    }

    let mut deleted_files = 0usize;
    let mut missing_files = 0usize;
    let mut failed_files = 0usize;
    let mut deleted_sidecars = 0usize;
    let mut failed_paths = Vec::<String>::new();
    let mut failed_source_paths = std::collections::HashSet::<PathBuf>::new();
    let mut deletable = Vec::<(i64, String)>::new();

    if matches!(request.mode, DeleteMode::Trash) {
        let mut paths_to_trash = Vec::new();
        let mut existing_candidates = Vec::new();

        for record in candidate_records {
            let source_path = PathBuf::from(&record.filepath);
            if source_path.exists() {
                paths_to_trash.push(source_path);
                existing_candidates.push(record);
            } else {
                missing_files += 1;
                deletable.push((record.id, record.filepath.clone()));
            }
        }

        let mut all_paths_to_trash = paths_to_trash.clone();
        for sidecar in &eligible_sidecars {
            all_paths_to_trash.push(sidecar.clone());
        }

        if !all_paths_to_trash.is_empty() {
            match trash::delete_all(&all_paths_to_trash) {
                Ok(_) => {
                    deleted_files += existing_candidates.len();
                    deleted_sidecars += eligible_sidecars.len();
                    for record in existing_candidates {
                        deletable.push((record.id, record.filepath.clone()));
                    }
                }
                Err(_) => {
                    for record in existing_candidates {
                        let path = Path::new(&record.filepath);
                        if !path.exists() {
                            deleted_files += 1;
                            deletable.push((record.id, record.filepath.clone()));
                            continue;
                        }
                        match trash::delete(path) {
                            Ok(_) => {
                                deleted_files += 1;
                                deletable.push((record.id, record.filepath.clone()));
                            }
                            Err(error) => {
                                failed_files += 1;
                                failed_source_paths.insert(PathBuf::from(&record.filepath));
                                failed_paths.push(format!("{} ({})", record.filepath, error));
                            }
                        }
                    }

                    for sidecar in eligible_sidecars {
                        if !is_sidecar_source_failed(&sidecar, &failed_source_paths) {
                            match trash::delete(&sidecar) {
                                Ok(_) => deleted_sidecars += 1,
                                Err(error) => {
                                    log::warn!(
                                        "Failed to trash sidecar {}: {}",
                                        sidecar.display(),
                                        error
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    } else {
        for record in candidate_records {
            let source_path = PathBuf::from(&record.filepath);
            if source_path.exists() {
                match std::fs::remove_file(&source_path) {
                    Ok(_) => {
                        deleted_files += 1;
                        deletable.push((record.id, record.filepath.clone()));
                    }
                    Err(error) => {
                        failed_files += 1;
                        failed_source_paths.insert(source_path);
                        failed_paths.push(format!("{} ({})", record.filepath, error));
                    }
                }
            } else {
                missing_files += 1;
                deletable.push((record.id, record.filepath.clone()));
            }
        }

        for sidecar in eligible_sidecars {
            if !is_sidecar_source_failed(&sidecar, &failed_source_paths) {
                match std::fs::remove_file(&sidecar) {
                    Ok(_) => deleted_sidecars += 1,
                    Err(error) => {
                        log::warn!("Failed to delete sidecar {}: {}", sidecar.display(), error);
                    }
                }
            }
        }
    }

    let mut deleted_thumbnails = 0usize;
    let deleted_ids: Vec<i64> = deletable.iter().map(|(id, _)| *id).collect();

    for (_, filepath) in &deletable {
        let source_path = Path::new(filepath);
        deleted_thumbnails += remove_thumbnail_cache_file(source_path, cache_dir, thumbnail_index);
    }

    if let Ok(mut failed) = failed_thumbnail_sources.write() {
        for (_, filepath) in &deletable {
            failed.remove(filepath);
        }
    }

    let (removed_from_db, failed_paths, db_error) = match db.delete_images_by_ids(&deleted_ids) {
        Ok(count) => (count, failed_paths, None),
        Err(error) => {
            log::error!("Failed to remove deleted images from database: {}", error);
            let mut paths = failed_paths;
            let err_msg = format!("Database error removing rows: {}", error);
            paths.push(err_msg.clone());
            (0, paths, Some(err_msg))
        }
    };

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
        db_error,
    })
}

#[tauri::command]
pub async fn delete_images(
    request: DeleteImagesRequest,
    state: tauri::State<'_, AppState>,
) -> Result<DeleteImagesResult, String> {
    let db = state.db.clone();
    let cache_dir = state.cache_dir.clone();
    let thumbnail_index = state.thumbnail_index.clone();
    let failed_thumbnail_sources = state.failed_thumbnail_sources.clone();
    tauri::async_runtime::spawn_blocking(move || {
        delete_images_sync(
            request,
            &db,
            &cache_dir,
            &thumbnail_index,
            &failed_thumbnail_sources,
        )
    })
    .await
    .map_err(|e| e.to_string())?
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

pub fn move_images_to_directory_sync(
    request: MoveImagesRequest,
    destination_directory: &Path,
    db: &crate::database::Database,
    cache_dir: &Path,
    thumbnail_index: &std::sync::Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
    failed_thumbnail_sources: &std::sync::Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
) -> Result<MoveImagesResult, String> {
    let mut unique_ids = request.ids;
    unique_ids.sort_unstable();
    unique_ids.dedup();
    let requested = unique_ids.len();

    let records = db
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
        if source_parent.as_deref() == Some(destination_directory) {
            skipped_same_directory += 1;
            continue;
        }

        let destination_path =
            resolve_move_destination_path(&source_path, destination_directory, record.id, db)?;
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
            cache_dir,
            thumbnail_index,
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

        match db.update_image_location(
            record.id,
            &new_filepath,
            &new_filename,
            &new_directory,
        ) {
            Ok(true) => {
                moved_ids.push(record.id);
                moved_items.push(MovedImageRecord {
                    id: record.id,
                    filepath: new_filepath.clone(),
                    filename: new_filename,
                    directory: new_directory,
                });

                if let Ok(mut failed) = failed_thumbnail_sources.write() {
                    if failed.remove(&record.filepath) {
                        failed.insert(new_filepath);
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
                    cache_dir,
                    thumbnail_index,
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
                    cache_dir,
                    thumbnail_index,
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

#[tauri::command]
pub async fn move_images_to_directory(
    request: MoveImagesRequest,
    app: tauri::AppHandle,
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

    if let Err(error) = app
        .asset_protocol_scope()
        .allow_directory(&destination_directory, true)
    {
        log::warn!(
            "Failed to allow destination directory {} in asset protocol scope: {}",
            destination_directory.display(),
            error
        );
    }

    let db = state.db.clone();
    let cache_dir = state.cache_dir.clone();
    let thumbnail_index = state.thumbnail_index.clone();
    let failed_thumbnail_sources = state.failed_thumbnail_sources.clone();

    tauri::async_runtime::spawn_blocking(move || {
        move_images_to_directory_sync(
            request,
            &destination_directory,
            &db,
            &cache_dir,
            &thumbnail_index,
            &failed_thumbnail_sources,
        )
    })
    .await
    .map_err(|e| e.to_string())?
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

#[cfg(test)]
mod delete_tests {
    use super::*;

    fn move_to_trash(path: &Path) -> Result<(), String> {
        trash::delete(path)
            .map_err(|error| format!("Failed to move {} to trash: {}", path.display(), error))
    }

    fn delete_file_with_mode(path: &Path, mode: DeleteMode) -> Result<(), String> {
        match mode {
            DeleteMode::Permanent => std::fs::remove_file(path).map_err(|error| error.to_string()),
            DeleteMode::Trash => move_to_trash(path),
        }
    }

    fn insert_db_image(db: &crate::database::Database, path: &Path) -> i64 {
        let filename = path.file_name().unwrap().to_str().unwrap();
        let directory = path.parent().unwrap().to_str().unwrap();
        let filepath = path.to_str().unwrap();
        let conn = db.pool_get_for_test().unwrap();
        conn.execute(
            "INSERT INTO images(filepath, filename, directory, prompt, quick_hash, file_mtime)
             VALUES (?1, ?2, ?3, 'test prompt', NULL, 100)",
            rusqlite::params![filepath, filename, directory],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn test_trash_filename_with_unicode_quotes_and_semicolon() {
        let temp_dir = std::env::temp_dir().join(format!(
            "fml_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("test_’_calc;foo_’.png");
        std::fs::write(&file_path, b"test content").unwrap();
        assert!(file_path.exists());

        let result = delete_file_with_mode(&file_path, DeleteMode::Trash);
        assert!(result.is_ok(), "delete failed: {:?}", result.err());
        assert!(!file_path.exists(), "file should be deleted/trashed");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_permanent_delete_leaves_unrelated_and_shared_sidecars() {
        let temp_dir_path = std::env::temp_dir().join(format!(
            "fml_perm_delete_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir_path).unwrap();

        let a_png = temp_dir_path.join("a.png");
        let a_json = temp_dir_path.join("a.json");
        let b_png = temp_dir_path.join("b.png");
        let b_json = temp_dir_path.join("b.json");
        let c_png = temp_dir_path.join("c.png");
        let c_webp = temp_dir_path.join("c.webp");
        let c_json = temp_dir_path.join("c.json");

        std::fs::write(&a_png, b"png a").unwrap();
        std::fs::write(&a_json, b"json a").unwrap();
        std::fs::write(&b_png, b"png b").unwrap();
        std::fs::write(&b_json, b"json b").unwrap();
        std::fs::write(&c_png, b"png c").unwrap();
        std::fs::write(&c_webp, b"webp c").unwrap();
        std::fs::write(&c_json, b"json c").unwrap();

        let db_path = temp_dir_path.join("test.db");
        let db = crate::database::Database::new(&db_path, crate::StorageProfile::Hdd).unwrap();
        let cache_dir = temp_dir_path.join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let thumbnail_index =
            std::sync::Arc::new(std::sync::RwLock::new(std::collections::HashSet::new()));
        let failed_thumbnail_sources =
            std::sync::Arc::new(std::sync::RwLock::new(std::collections::HashSet::new()));

        let id_a = insert_db_image(&db, &a_png);
        let _id_b = insert_db_image(&db, &b_png);
        let id_c_png = insert_db_image(&db, &c_png);
        let id_c_webp = insert_db_image(&db, &c_webp);

        // 1. Delete a.png: unshared stem, so a.json is deleted; b.* and c.* untouched
        let res_a = delete_images_sync(
            DeleteImagesRequest {
                ids: vec![id_a],
                mode: DeleteMode::Permanent,
            },
            &db,
            &cache_dir,
            &thumbnail_index,
            &failed_thumbnail_sources,
        )
        .unwrap();

        assert_eq!(res_a.deleted_files, 1);
        assert_eq!(res_a.deleted_sidecars, 1);
        assert!(!a_png.exists());
        assert!(!a_json.exists());
        assert!(b_png.exists());
        assert!(b_json.exists());
        assert!(c_png.exists());
        assert!(c_webp.exists());
        assert!(c_json.exists());

        // 2. Delete c.png: stem 'c' is shared with c.webp in DB, so c.json MUST be left alone
        let res_c1 = delete_images_sync(
            DeleteImagesRequest {
                ids: vec![id_c_png],
                mode: DeleteMode::Permanent,
            },
            &db,
            &cache_dir,
            &thumbnail_index,
            &failed_thumbnail_sources,
        )
        .unwrap();

        assert_eq!(res_c1.deleted_files, 1);
        assert_eq!(res_c1.deleted_sidecars, 0);
        assert!(!c_png.exists());
        assert!(c_webp.exists());
        assert!(c_json.exists(), "shared stem sidecar must be preserved");

        // 3. Delete c.webp: now no other images with stem 'c' remain, so c.json is deleted
        let res_c2 = delete_images_sync(
            DeleteImagesRequest {
                ids: vec![id_c_webp],
                mode: DeleteMode::Permanent,
            },
            &db,
            &cache_dir,
            &thumbnail_index,
            &failed_thumbnail_sources,
        )
        .unwrap();

        assert_eq!(res_c2.deleted_files, 1);
        assert_eq!(res_c2.deleted_sidecars, 1);
        assert!(!c_webp.exists());
        assert!(
            !c_json.exists(),
            "sidecar removed once all stem images deleted"
        );

        // Cleanup
        let _ = std::fs::remove_dir_all(&temp_dir_path);
    }

    #[test]
    fn test_delete_images_db_error_does_not_fail_call() {
        let temp_dir_path = std::env::temp_dir().join(format!(
            "fml_db_err_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir_path).unwrap();

        let a_png = temp_dir_path.join("a.png");
        std::fs::write(&a_png, b"png a").unwrap();

        let db_path = temp_dir_path.join("test.db");
        let db = crate::database::Database::new(&db_path, crate::StorageProfile::Hdd).unwrap();
        let cache_dir = temp_dir_path.join("cache");
        let thumbnail_index =
            std::sync::Arc::new(std::sync::RwLock::new(std::collections::HashSet::new()));
        let failed_thumbnail_sources =
            std::sync::Arc::new(std::sync::RwLock::new(std::collections::HashSet::new()));

        let id_a = insert_db_image(&db, &a_png);

        // Add a BEFORE DELETE trigger on images that forces an abort during delete_images_by_ids
        {
            let conn = db.pool_get_for_test().unwrap();
            conn.execute_batch(
                "CREATE TRIGGER abort_delete BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT, 'forced test abort'); END;",
            )
            .unwrap();
        }

        let res = delete_images_sync(
            DeleteImagesRequest {
                ids: vec![id_a],
                mode: DeleteMode::Permanent,
            },
            &db,
            &cache_dir,
            &thumbnail_index,
            &failed_thumbnail_sources,
        );

        assert!(
            res.is_ok(),
            "delete_images_sync must return Ok even if DB delete fails"
        );
        let result = res.unwrap();
        assert_eq!(result.deleted_files, 1);
        assert_eq!(result.removed_from_db, 0);
        assert_eq!(result.deleted_ids, vec![id_a]);
        assert!(result.db_error.is_some());
        assert!(result.db_error.as_ref().unwrap().contains("forced test abort"));
        assert!(!a_png.exists());
        assert!(!result.failed_paths.is_empty());
        assert!(result.failed_paths[0].contains("forced test abort"));

        let _ = std::fs::remove_dir_all(&temp_dir_path);
    }

    #[test]
    fn test_is_sidecar_source_failed_helper() {
        let mut failed = std::collections::HashSet::new();
        failed.insert(PathBuf::from("/dir/photo.png"));

        assert!(is_sidecar_source_failed(Path::new("/dir/photo.json"), &failed));
        assert!(is_sidecar_source_failed(Path::new("/dir/photo.yaml"), &failed));
        assert!(!is_sidecar_source_failed(Path::new("/dir/other.json"), &failed));
        assert!(!is_sidecar_source_failed(Path::new("/other_dir/photo.json"), &failed));

        if cfg!(windows) {
            assert!(is_sidecar_source_failed(Path::new("/dir/PHOTO.json"), &failed));
        }
    }
}
