// ────────────────────────── Scan ──────────────────────────

/// High-performance directory scanner.
///
/// Pipeline:
///   1. Walk filesystem (walkdir)
///   2. Bulk-fetch existing mtimes in ONE query
///   3. Filter to changed/new files only
///   4. Parallel metadata extraction (Rayon par_iter)
///   5. Chunked bulk-upsert with tags (single transaction per chunk)
///   6. Chunked thumbnail generation with progress events
#[tauri::command]
pub async fn scan_directory(
    directory: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let dir_path = PathBuf::from(&directory);
    if !dir_path.exists() || !dir_path.is_dir() {
        return Err(format!("Invalid directory: {}", directory));
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

    tauri::async_runtime::spawn_blocking(move || {
        let total_timer = std::time::Instant::now();

        // ── Stage 1: Walk filesystem ─────────────────────────────────
        let discovery_timer = std::time::Instant::now();
        let _ = app_handle.emit(
            "scan-progress",
            ScanProgress {
                current: 0,
                total: 0,
                stage: "scanning".into(),
                filename: None,
            },
        );

        let image_files = scanner::scan_directory(&dir_path);
        let total_files = image_files.len();
        let discovery_elapsed = discovery_timer.elapsed();

        if total_files == 0 {
            log::info!(
                "Scan complete: no files discovered in {} (discovery took {:.1} ms)",
                dir_path.display(),
                discovery_elapsed.as_secs_f64() * 1000.0
            );
            let _ = app_handle.emit(
                "scan-complete",
                ScanResult {
                    total_files: 0,
                    indexed: 0,
                    errors: 0,
                },
            );
            return;
        }

        // ── Stage 2: Bulk mtime lookup (one query for all files) ─────
        let filter_timer = std::time::Instant::now();
        let existing_mtimes = db.get_all_file_mtimes().unwrap_or_default();

        // Filter to only changed or new files (and capture mtimes once).
        let mut files_to_process: Vec<PendingFile> = image_files
            .into_iter()
            .filter_map(|scanned| {
                let filepath_str = scanned.path.to_string_lossy();
                let is_unchanged = matches!(
                    (scanned.file_mtime, existing_mtimes.get(filepath_str.as_ref())),
                    (Some(cur), Some(existing)) if cur == *existing
                );
                if is_unchanged {
                    None
                } else {
                    Some(PendingFile {
                        path: scanned.path,
                        file_mtime: scanned.file_mtime,
                        file_size: scanned.file_size,
                    })
                }
            })
            .collect();
        files_to_process.sort_unstable_by(|a, b| a.path.cmp(&b.path));

        let files_to_process_count = files_to_process.len();
        let skipped = total_files - files_to_process_count;
        let filter_elapsed = filter_timer.elapsed();

        log::info!(
            "Scan: {} total files, {} unchanged (skipped), {} to process",
            total_files,
            skipped,
            files_to_process_count
        );

        let _ = app_handle.emit(
            "scan-progress",
            ScanProgress {
                current: 0,
                total: files_to_process_count,
                stage: "indexing".into(),
                filename: None,
            },
        );

        // ── Stage 3/4: Chunked parallel metadata extraction + bulk upsert ──────
        let metadata_timer = std::time::Instant::now();
        let progress_counter = AtomicUsize::new(0);
        let error_counter = AtomicUsize::new(0);
        let mut indexed = 0usize;
        let mut db_errors = 0usize;
        let mut write_batch_idx = 0usize;

        for file_chunk in files_to_process.chunks(METADATA_PARSE_CHUNK_SIZE) {
            let records: Vec<BulkRecord> = scan_pool(storage_profile).install(|| {
                file_chunk
                    .par_iter()
                    .filter_map(|pending| {
                        let done = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
                        if done.is_multiple_of(64) || done == files_to_process_count {
                            let _ = app_handle.emit(
                                "scan-progress",
                                ScanProgress {
                                    current: done,
                                    total: files_to_process_count,
                                    stage: "indexing".into(),
                                    filename: Some(
                                        pending
                                            .path
                                            .file_name()
                                            .unwrap_or_default()
                                            .to_string_lossy()
                                            .to_string(),
                                    ),
                                },
                            );
                        }

                        let raw_metadata = extract_parameters_metadata(&pending.path);
                        let params = if raw_metadata.trim().is_empty() {
                            parser::GenerationParams {
                                raw_metadata: String::new(),
                                ..Default::default()
                            }
                        } else {
                            parser::parse_generation_metadata(&raw_metadata)
                        };
                        let mut tags = parser::extract_tags(&params.prompt);

                        if let Some(sidecar_data) = sidecar::read_sidecar(&pending.path) {
                            tags.extend(sidecar_data.tags);
                        }

                        let filepath = pending.path.to_string_lossy().to_string();
                        let quick_hash =
                            scanner::compute_quick_hash(&pending.path, pending.file_size);
                        let filename = pending
                            .path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        let directory = pending
                            .path
                            .parent()
                            .unwrap_or(&dir_path)
                            .to_string_lossy()
                            .to_string();

                        Some(BulkRecord {
                            filepath,
                            filename,
                            directory,
                            params,
                            file_mtime: pending.file_mtime,
                            file_size: pending.file_size,
                            quick_hash,
                            tags,
                        })
                    })
                    .collect()
            });

            for chunk in records.chunks(BULK_CHUNK_SIZE) {
                match db.bulk_upsert_with_tags(chunk) {
                    Ok(count) => {
                        indexed += count;
                        write_batch_idx += 1;
                        let _ = app_handle.emit(
                            "scan-progress",
                            ScanProgress {
                                current: progress_counter
                                    .load(Ordering::Relaxed)
                                    .min(files_to_process_count),
                                total: files_to_process_count,
                                stage: "indexing".into(),
                                filename: Some(format!("Writing batch {}...", write_batch_idx)),
                            },
                        );
                    }
                    Err(err) => {
                        log::error!("Bulk upsert chunk {} failed: {}", write_batch_idx, err);
                        db_errors += chunk.len();
                    }
                }
            }
        }
        let metadata_elapsed = metadata_timer.elapsed();
        let errors = error_counter.load(Ordering::Relaxed);

        // ── Stage 5: Chunked thumbnail generation with progress ──────
        let thumbnail_timer = std::time::Instant::now();
        let immediate_thumb_count =
            files_to_process_count.min(immediate_thumb_budget(storage_profile));
        let immediate_thumb_chunk_size = scan_thumbnail_chunk_size(storage_profile).max(1);
        let split_at = files_to_process_count.saturating_sub(immediate_thumb_count);
        let (remaining_pending, immediate_pending) = files_to_process.split_at(split_at);
        let immediate_thumb_paths: Vec<PathBuf> = immediate_pending
            .iter()
            .rev()
            .map(|pending| pending.path.clone())
            .collect();

        if immediate_thumb_count > 0 {
            let _ = app_handle.emit(
                "scan-progress",
                ScanProgress {
                    current: 0,
                    total: immediate_thumb_count,
                    stage: "thumbnails".into(),
                    filename: None,
                },
            );

            for (chunk_idx, chunk) in immediate_thumb_paths
                .chunks(immediate_thumb_chunk_size)
                .enumerate()
            {
                let generated =
                    image_processing::generate_thumbnails(chunk, &cache_dir, storage_profile);
                if !generated.is_empty() {
                    if let Ok(mut index) = thumbnail_index.write() {
                        for (_, thumb_path) in &generated {
                            index.insert(thumb_path.to_string_lossy().to_string());
                        }
                    }
                    if let Ok(mut failed) = failed_thumbnail_sources.write() {
                        for (source_path, _) in &generated {
                            failed.remove(&source_path.to_string_lossy().to_string());
                        }
                    }
                }

                let done =
                    ((chunk_idx + 1) * immediate_thumb_chunk_size).min(immediate_thumb_count);
                let _ = app_handle.emit(
                    "scan-progress",
                    ScanProgress {
                        current: done,
                        total: immediate_thumb_count,
                        stage: "thumbnails".into(),
                        filename: None,
                    },
                );
            }
        }
        let thumbnail_elapsed = thumbnail_timer.elapsed();

        let metadata_throughput = if metadata_elapsed.as_secs_f64() > 0.0 {
            files_to_process_count as f64 / metadata_elapsed.as_secs_f64()
        } else {
            files_to_process_count as f64
        };
        let thumbnail_throughput = if thumbnail_elapsed.as_secs_f64() > 0.0 {
            immediate_thumb_count as f64 / thumbnail_elapsed.as_secs_f64()
        } else {
            immediate_thumb_count as f64
        };

        let _ = app_handle.emit(
            "scan-complete",
            ScanResult {
                total_files,
                indexed,
                errors: errors + db_errors,
            },
        );

        log::info!(
            "Scan complete: {} total, {} indexed, {} errors, {} skipped (unchanged)",
            total_files,
            indexed,
            errors + db_errors,
            skipped,
        );
        log::info!(
            "Scan timings ({}): discovery={:.1}ms, filter={:.1}ms, metadata={:.1}ms ({:.1} files/s), thumbs={:.1}ms ({:.1} images/s, chunk={}), total={:.1}ms",
            profile_label(storage_profile),
            discovery_elapsed.as_secs_f64() * 1000.0,
            filter_elapsed.as_secs_f64() * 1000.0,
            metadata_elapsed.as_secs_f64() * 1000.0,
            metadata_throughput,
            thumbnail_elapsed.as_secs_f64() * 1000.0,
            thumbnail_throughput,
            immediate_thumb_chunk_size,
            total_timer.elapsed().as_secs_f64() * 1000.0
        );

        let remaining_thumb_paths: Vec<PathBuf> = remaining_pending
            .iter()
            .rev()
            .map(|pending| pending.path.clone())
            .collect();
        if !remaining_thumb_paths.is_empty() {
            let cache_dir_bg = cache_dir.clone();
            let thumbnail_index_bg = thumbnail_index.clone();
            let failed_thumbnail_sources_bg = failed_thumbnail_sources.clone();
            let remaining = remaining_thumb_paths.len();
            let _ = std::thread::Builder::new()
                .name("thumbnail-warmup".into())
                .spawn(move || {
                    let warmup_timer = std::time::Instant::now();
                    let warmup_chunk_size = precache_chunk_size(storage_profile).max(1);
                    let mut generated_total = 0usize;
                    for chunk in remaining_thumb_paths.chunks(warmup_chunk_size) {
                        let generated = image_processing::generate_thumbnails(
                            chunk,
                            &cache_dir_bg,
                            storage_profile,
                        );
                        generated_total += generated.len();
                        if !generated.is_empty() {
                            if let Ok(mut index) = thumbnail_index_bg.write() {
                                for (_, thumb_path) in &generated {
                                    index.insert(thumb_path.to_string_lossy().to_string());
                                }
                            }
                            if let Ok(mut failed) = failed_thumbnail_sources_bg.write() {
                                for (source_path, _) in &generated {
                                    failed.remove(&source_path.to_string_lossy().to_string());
                                }
                            }
                        }
                    }
                    let elapsed_seconds = warmup_timer.elapsed().as_secs_f64();
                    let throughput = if elapsed_seconds > 0.0 {
                        generated_total as f64 / elapsed_seconds
                    } else {
                        generated_total as f64
                    };
                    log::info!(
                        "Background thumbnail warmup complete ({} files, {} generated, {:.1} images/s, chunk={})",
                        remaining,
                        generated_total,
                        throughput,
                        warmup_chunk_size
                    );
                });
        }
    });

    Ok(())
}

fn extract_parameters_metadata(path: &Path) -> String {
    match scanner::extract_metadata(path) {
        Ok(Some(parameters)) => parameters,
        Ok(None) => read_sidecar_txt(path),
        Err(err) => {
            log::warn!("PNG metadata read failed for {}: {}", path.display(), err);
            read_sidecar_txt(path)
        }
    }
}

fn read_sidecar_txt(path: &Path) -> String {
    let txt_path = path.with_extension("txt");
    if txt_path.exists() {
        return std::fs::read_to_string(&txt_path).unwrap_or_default();
    }
    String::new()
}
