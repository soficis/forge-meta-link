// ────────────────────────── Thumbnails ──────────────────────────

/// Starts a full-library thumbnail pre-cache pass in the background.
///
/// Emits:
/// - `thumbnail-cache-progress`
/// - `thumbnail-cache-complete`
#[tauri::command]
pub fn precache_all_thumbnails(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if state
        .thumbnail_precache_running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("Thumbnail cache warmup is already running".to_string());
    }

    let db = state.db.clone();
    let cache_dir = state.cache_dir.clone();
    let thumbnail_index = state.thumbnail_index.clone();
    let failed_thumbnail_sources = state.failed_thumbnail_sources.clone();
    let storage_profile = state
        .storage_profile
        .read()
        .map(|profile| *profile)
        .unwrap_or(StorageProfile::Hdd);
    let app_handle = app.clone();
    let running_flag = state.thumbnail_precache_running.clone();
    let running_flag_for_worker = running_flag.clone();

    std::thread::Builder::new()
        .name("thumbnail-precache".into())
        .spawn(move || {
            let precache_timer = std::time::Instant::now();
            struct RunningGuard {
                flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
            }

            impl Drop for RunningGuard {
                fn drop(&mut self) {
                    self.flag.store(false, Ordering::Release);
                }
            }

            let _running_guard = RunningGuard {
                flag: running_flag_for_worker,
            };

            if let Err(error) = image_processing::prepare_cache_dir(&cache_dir) {
                log::error!("Thumbnail pre-cache failed to prepare cache dir: {}", error);
                let _ = app_handle.emit(
                    "thumbnail-cache-complete",
                    ThumbnailPrecacheComplete {
                        total: 0,
                        generated: 0,
                        skipped: 0,
                        failed: 0,
                    },
                );
                return;
            }

            let all_filepaths = match db.get_all_image_filepaths_desc() {
                Ok(filepaths) => filepaths,
                Err(error) => {
                    log::error!("Thumbnail pre-cache failed to read filepaths: {}", error);
                    let _ = app_handle.emit(
                        "thumbnail-cache-complete",
                        ThumbnailPrecacheComplete {
                            total: 0,
                            generated: 0,
                            skipped: 0,
                            failed: 0,
                        },
                    );
                    return;
                }
            };

            let total = all_filepaths.len();
            let mut generated = 0usize;
            let mut skipped = 0usize;
            let mut failed = 0usize;
            let mut pending_paths = Vec::<PathBuf>::new();
            let mut discovered_thumb_paths = Vec::<String>::new();

            let _ = app_handle.emit(
                "thumbnail-cache-progress",
                ThumbnailPrecacheProgress {
                    current: 0,
                    total,
                    generated,
                    skipped,
                    failed,
                    phase: "preparing".into(),
                },
            );

            if total == 0 {
                let _ = app_handle.emit(
                    "thumbnail-cache-complete",
                    ThumbnailPrecacheComplete {
                        total,
                        generated,
                        skipped,
                        failed,
                    },
                );
                return;
            }

            let index_snapshot = thumbnail_index
                .read()
                .map(|index| index.clone())
                .unwrap_or_default();
            for (idx, filepath) in all_filepaths.into_iter().enumerate() {
                let source = Path::new(&filepath);
                let primary_path = image_processing::get_thumbnail_cache_path(source, &cache_dir);
                let primary_key = primary_path.to_string_lossy().to_string();

                // Skip if current-format thumbnail exists.
                if index_snapshot.contains(&primary_key) {
                    skipped += 1;
                } else if primary_path.exists() {
                    skipped += 1;
                    discovered_thumb_paths.push(primary_key);
                } else {
                    pending_paths.push(PathBuf::from(filepath));
                }

                let current = idx + 1;
                if current % 1_024 == 0 || current == total {
                    let _ = app_handle.emit(
                        "thumbnail-cache-progress",
                        ThumbnailPrecacheProgress {
                            current,
                            total,
                            generated,
                            skipped,
                            failed,
                            phase: "preparing".into(),
                        },
                    );
                }
            }

            if !discovered_thumb_paths.is_empty() {
                if let Ok(mut index) = thumbnail_index.write() {
                    for thumb_path in discovered_thumb_paths {
                        index.insert(thumb_path);
                    }
                }
            }

            let chunk_size = precache_chunk_size(storage_profile).max(1);
            let mut processed = skipped;

            for chunk in pending_paths.chunks(chunk_size) {
                let generated_chunk =
                    image_processing::generate_thumbnails(chunk, &cache_dir, storage_profile);
                generated += generated_chunk.len();
                processed += chunk.len();

                let failed_in_chunk = chunk.len().saturating_sub(generated_chunk.len());
                failed += failed_in_chunk;

                if !generated_chunk.is_empty() {
                    if let Ok(mut index) = thumbnail_index.write() {
                        for (_, thumb_path) in &generated_chunk {
                            index.insert(thumb_path.to_string_lossy().to_string());
                        }
                    }
                }

                if let Ok(mut failed_set) = failed_thumbnail_sources.write() {
                    let generated_sources: std::collections::HashSet<String> = generated_chunk
                        .iter()
                        .map(|(source_path, _)| source_path.to_string_lossy().to_string())
                        .collect();

                    for source_path in chunk {
                        let source_key = source_path.to_string_lossy().to_string();
                        if generated_sources.contains(&source_key) {
                            failed_set.remove(&source_key);
                        } else {
                            failed_set.insert(source_key);
                        }
                    }
                }

                let _ = app_handle.emit(
                    "thumbnail-cache-progress",
                    ThumbnailPrecacheProgress {
                        current: processed,
                        total,
                        generated,
                        skipped,
                        failed,
                        phase: "generating".into(),
                    },
                );
            }

            let _ = app_handle.emit(
                "thumbnail-cache-complete",
                ThumbnailPrecacheComplete {
                    total,
                    generated,
                    skipped,
                    failed,
                },
            );

            let elapsed_seconds = precache_timer.elapsed().as_secs_f64();
            let throughput = if elapsed_seconds > 0.0 {
                generated as f64 / elapsed_seconds
            } else {
                generated as f64
            };
            log::info!(
                "Thumbnail pre-cache complete: total={}, generated={}, skipped={}, failed={}, profile={}, throughput={:.1} images/s",
                total,
                generated,
                skipped,
                failed,
                profile_label(storage_profile),
                throughput
            );
        })
        .map_err(|error| {
            running_flag.store(false, Ordering::Release);
            format!("Failed to spawn thumbnail pre-cache worker: {}", error)
        })?;

    Ok(())
}

fn is_jxl_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("jxl"))
        .unwrap_or(false)
}

fn display_cache_directory(cache_dir: &Path) -> PathBuf {
    cache_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("display-cache")
}

/// Returns a viewer-displayable path for a source image.
///
/// For JPEG XL files, this generates a cached PNG proxy so the frontend can render
/// consistently even when platform WebView codec support is unavailable.
#[tauri::command]
pub async fn get_display_image_path(
    filepath: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let cache_dir = state.cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&filepath);
        if !source.exists() {
            return Err(format!("File not found: {}", filepath));
        }
        if !is_jxl_path(&source) {
            return Ok(filepath);
        }

        let display_cache_dir = display_cache_directory(&cache_dir);
        std::fs::create_dir_all(&display_cache_dir).map_err(|error| {
            format!(
                "Failed to create display cache directory {}: {}",
                display_cache_dir.display(),
                error
            )
        })?;

        let metadata = std::fs::metadata(&source).map_err(|error| {
            format!(
                "Failed to read source metadata for {}: {}",
                source.display(),
                error
            )
        })?;

        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let mut hasher = Sha256::new();
        hasher.update(source.to_string_lossy().as_bytes());
        hasher.update(metadata.len().to_le_bytes());
        hasher.update(modified_ns.to_le_bytes());
        let hash = format!("{:x}", hasher.finalize());
        let cache_path = display_cache_dir.join(format!("{}.png", hash));

        if cache_path.exists() {
            return Ok(cache_path.to_string_lossy().to_string());
        }

        let image = image_decode::open_image(&source).map_err(|error| {
            format!(
                "Failed to decode JPEG XL image {}: {}",
                source.display(),
                error
            )
        })?;

        let mut encoded = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut encoded),
                image::ImageFormat::Png,
            )
            .map_err(|error| {
                format!(
                    "Failed to encode display proxy for {}: {}",
                    source.display(),
                    error
                )
            })?;

        std::fs::write(&cache_path, encoded).map_err(|error| {
            format!(
                "Failed to write display proxy {}: {}",
                cache_path.display(),
                error
            )
        })?;

        Ok(cache_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Returns base64-encoded bytes + detected mime for clipboard-safe image loading.
#[tauri::command]
pub async fn get_image_clipboard_payload(
    filepath: String,
) -> Result<ClipboardImagePayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&filepath);
        if !path.exists() || !path.is_file() {
            return Err(format!("File not found: {}", filepath));
        }

        let bytes = std::fs::read(&path)
            .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
        if bytes.is_empty() {
            return Err(format!("File is empty: {}", path.display()));
        }

        Ok(ClipboardImagePayload {
            base64: BASE64_STANDARD.encode(&bytes),
            mime: mime_from_image_bytes(&bytes).to_string(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Returns thumbnail path for a single image, generating on-demand if missing.
#[tauri::command]
pub async fn get_thumbnail_path(
    filepath: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let cache_dir = state.cache_dir.clone();
    let thumbnail_index = state.thumbnail_index.clone();
    let failed_thumbnail_sources = state.failed_thumbnail_sources.clone();
    let storage_profile = state
        .storage_profile
        .read()
        .map(|profile| *profile)
        .unwrap_or(StorageProfile::Hdd);
    tauri::async_runtime::spawn_blocking(move || {
        let source = Path::new(&filepath);
        if let Err(e) = image_processing::prepare_cache_dir(&cache_dir) {
            log::warn!("Thumbnail cache unavailable for {}: {}", filepath, e);
            return Ok(filepath);
        }

        let primary_path = image_processing::get_thumbnail_cache_path(source, &cache_dir);
        let primary_key = primary_path.to_string_lossy().to_string();

        if let Ok(index) = thumbnail_index.read() {
            if index.contains(&primary_key) {
                return Ok(primary_key);
            }
        }

        if primary_path.exists() {
            if let Ok(mut index) = thumbnail_index.write() {
                index.insert(primary_key.clone());
            }
            if let Ok(mut failed) = failed_thumbnail_sources.write() {
                failed.remove(&filepath);
            }
            return Ok(primary_key);
        }

        if let Ok(failed) = failed_thumbnail_sources.read() {
            if failed.contains(&filepath) {
                return Ok(filepath);
            }
        }

        match image_processing::ensure_thumbnail(source, &cache_dir, storage_profile) {
            Ok(generated) => {
                let generated_key = generated.to_string_lossy().to_string();
                if let Ok(mut index) = thumbnail_index.write() {
                    index.insert(generated_key.clone());
                }
                if let Ok(mut failed) = failed_thumbnail_sources.write() {
                    failed.remove(&filepath);
                }
                Ok(generated_key)
            }
            Err(e) => {
                log::warn!("On-demand thumbnail failed for {}: {}", filepath, e);
                if let Ok(mut failed) = failed_thumbnail_sources.write() {
                    failed.insert(filepath.clone());
                }
                Ok(filepath)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Batch-resolves thumbnail paths for multiple images in a single IPC call.
#[tauri::command]
pub async fn get_thumbnail_paths(
    filepaths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ThumbnailMapping>, String> {
    if filepaths.is_empty() {
        return Ok(Vec::new());
    }

    let cache_dir = state.cache_dir.clone();
    let thumbnail_index = state.thumbnail_index.clone();
    let failed_thumbnail_sources = state.failed_thumbnail_sources.clone();
    let storage_profile = state
        .storage_profile
        .read()
        .map(|profile| *profile)
        .unwrap_or(StorageProfile::Hdd);
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let mut resolved =
            std::collections::HashMap::<String, String>::with_capacity(filepaths.len());
        let mut missing: Vec<String> = Vec::new();
        let mut discovered_on_disk: Vec<String> = Vec::new();
        let mut generated_or_cached_from_missing = 0usize;
        let failed_guard = failed_thumbnail_sources.read().ok();

        if let Ok(index) = thumbnail_index.read() {
            for filepath in &filepaths {
                let source = Path::new(filepath);
                let primary_path = image_processing::get_thumbnail_cache_path(source, &cache_dir);
                let primary_key = primary_path.to_string_lossy().to_string();

                if index.contains(&primary_key) {
                    resolved.insert(filepath.clone(), primary_key);
                } else if primary_path.exists() {
                    discovered_on_disk.push(primary_key.clone());
                    resolved.insert(filepath.clone(), primary_key);
                } else if failed_guard
                    .as_ref()
                    .is_some_and(|failed| failed.contains(filepath))
                {
                    resolved.insert(filepath.clone(), filepath.clone());
                } else {
                    missing.push(filepath.clone());
                }
            }
        } else {
            missing.extend(filepaths.iter().cloned());
        }

        if !discovered_on_disk.is_empty() {
            if let Ok(mut index) = thumbnail_index.write() {
                for thumb_path in discovered_on_disk {
                    index.insert(thumb_path);
                }
            }
        }

        drop(failed_guard);

        if !missing.is_empty() {
            // HDD-friendly ordering: keep filesystem-near paths together for fewer seeks.
            missing.sort_unstable();
            missing.dedup();
            let mappings =
                image_processing::resolve_thumbnail_paths(&missing, &cache_dir, storage_profile);
            if let Ok(mut index) = thumbnail_index.write() {
                for (source_path, thumbnail_path) in &mappings {
                    if thumbnail_path != source_path {
                        index.insert(thumbnail_path.clone());
                    }
                }
            }
            if let Ok(mut failed) = failed_thumbnail_sources.write() {
                for (filepath, thumbnail_path) in &mappings {
                    if thumbnail_path == filepath {
                        failed.insert(filepath.clone());
                    } else {
                        failed.remove(filepath);
                    }
                }
            }
            for (filepath, thumbnail_path) in mappings {
                if thumbnail_path != filepath {
                    generated_or_cached_from_missing += 1;
                }
                resolved.insert(filepath, thumbnail_path);
            }
        }
        let mappings = filepaths
            .into_iter()
            .map(|filepath| ThumbnailMapping {
                thumbnail_path: resolved
                    .get(&filepath)
                    .cloned()
                    .unwrap_or_else(|| filepath.clone()),
                filepath,
            })
            .collect::<Vec<ThumbnailMapping>>();

        let elapsed_seconds = started.elapsed().as_secs_f64();
        let throughput = if elapsed_seconds > 0.0 {
            mappings.len() as f64 / elapsed_seconds
        } else {
            mappings.len() as f64
        };
        log::info!(
            "Thumbnail batch resolved {} items (missing={}, generated_or_cached={}, profile={}) in {:.1} ms ({:.1} items/s)",
            mappings.len(),
            missing.len(),
            generated_or_cached_from_missing,
            profile_label(storage_profile),
            elapsed_seconds * 1000.0,
            throughput
        );

        Ok(mappings)
    })
    .await
    .map_err(|e| e.to_string())?
}
