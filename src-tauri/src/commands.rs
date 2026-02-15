use crate::{
    database::{BulkRecord, CursorPage, DirectoryEntry, ImageRecord, ModelEntry, TagCount},
    forge_api, image_decode, image_processing, parser, scanner, sidecar, AppState, ExportResult,
    ScanResult, StorageProfile,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use walkdir::WalkDir;

/// Mapping between a source filepath and its resolved thumbnail path.
#[derive(Debug, Clone, Serialize)]
pub struct ThumbnailMapping {
    pub filepath: String,
    pub thumbnail_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClipboardImagePayload {
    pub base64: String,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize)]
struct ExportImage {
    id: i64,
    filepath: String,
    filename: String,
    directory: String,
    prompt: String,
    negative_prompt: String,
    steps: Option<String>,
    sampler: Option<String>,
    cfg_scale: Option<String>,
    seed: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    model_hash: Option<String>,
    model_name: Option<String>,
    raw_metadata: String,
    tags: Vec<String>,
}

#[derive(Clone, Serialize)]
struct ScanProgress {
    current: usize,
    total: usize,
    stage: String, // "scanning", "indexing", "thumbnails"
    filename: Option<String>,
}

#[derive(Clone, Serialize)]
struct ThumbnailPrecacheProgress {
    current: usize,
    total: usize,
    generated: usize,
    skipped: usize,
    failed: usize,
    phase: String, // "preparing" | "generating"
}

#[derive(Clone, Serialize)]
struct ThumbnailPrecacheComplete {
    total: usize,
    generated: usize,
    skipped: usize,
    failed: usize,
}

#[derive(Clone)]
struct PendingFile {
    path: PathBuf,
    file_mtime: Option<i64>,
    file_size: Option<i64>,
}

/// Size of each bulk-upsert transaction chunk.
/// Larger = fewer disk syncs; 500 is a sweet-spot for SQLite WAL mode.
const BULK_CHUNK_SIZE: usize = 1_000;
/// File chunk size for metadata parsing to avoid building huge in-memory vectors.
const METADATA_PARSE_CHUNK_SIZE: usize = 2_048;

/// Size of each thumbnail generation chunk for progress reporting.
const THUMB_CHUNK_SIZE: usize = 128;
/// Number of thumbnails to pre-generate synchronously after indexing.
/// Remaining thumbnails warm in background so scan completion is much faster.
const THUMB_IMMEDIATE_BUDGET_HDD: usize = 2_000;
const THUMB_IMMEDIATE_BUDGET_SSD: usize = 8_000;
const THUMB_PRECACHE_CHUNK_HDD: usize = 192;
const THUMB_PRECACHE_CHUNK_SSD: usize = 640;
const HDD_FRIENDLY_SCAN_THREADS: usize = 4;
const SSD_FRIENDLY_SCAN_THREADS: usize = 12;

fn scan_threads(profile: StorageProfile) -> usize {
    if let Ok(raw) = std::env::var("FORGE_SCAN_THREADS") {
        if let Ok(parsed) = raw.parse::<usize>() {
            return parsed.max(1).min(32);
        }
    }

    let cpu_count = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4);
    match profile {
        StorageProfile::Hdd => cpu_count.min(HDD_FRIENDLY_SCAN_THREADS).max(2),
        StorageProfile::Ssd => cpu_count.min(SSD_FRIENDLY_SCAN_THREADS).max(4),
    }
}

fn scan_pool(profile: StorageProfile) -> &'static rayon::ThreadPool {
    static HDD_POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    static SSD_POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();

    let pool = match profile {
        StorageProfile::Hdd => &HDD_POOL,
        StorageProfile::Ssd => &SSD_POOL,
    };

    pool.get_or_init(move || {
        let threads = scan_threads(profile);
        let profile_name = profile_label(profile);
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(move |idx| format!("scan-io-{}-{}", profile_name, idx))
            .build()
            .expect("failed to create scan threadpool")
    })
}

fn profile_label(profile: StorageProfile) -> &'static str {
    match profile {
        StorageProfile::Hdd => "hdd",
        StorageProfile::Ssd => "ssd",
    }
}

fn immediate_thumb_budget(profile: StorageProfile) -> usize {
    match profile {
        StorageProfile::Hdd => THUMB_IMMEDIATE_BUDGET_HDD,
        StorageProfile::Ssd => THUMB_IMMEDIATE_BUDGET_SSD,
    }
}

fn precache_chunk_size(profile: StorageProfile) -> usize {
    match profile {
        StorageProfile::Hdd => THUMB_PRECACHE_CHUNK_HDD,
        StorageProfile::Ssd => THUMB_PRECACHE_CHUNK_SSD,
    }
}

#[tauri::command]
pub fn get_storage_profile(state: tauri::State<'_, AppState>) -> Result<StorageProfile, String> {
    state
        .storage_profile
        .read()
        .map(|profile| *profile)
        .map_err(|_| "Failed to read storage profile".to_string())
}

#[tauri::command]
pub fn set_storage_profile(
    profile: StorageProfile,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut lock = state
            .storage_profile
            .write()
            .map_err(|_| "Failed to update storage profile".to_string())?;
        *lock = profile;
    }

    crate::persist_storage_profile(&state.storage_profile_path, profile)?;
    log::info!("Storage profile set to {}", profile_label(profile));
    Ok(())
}

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
        // ── Stage 1: Walk filesystem ─────────────────────────────────
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

        if total_files == 0 {
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
                        if done % 64 == 0 || done == files_to_process_count {
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
                        if raw_metadata.trim().is_empty() {
                            error_counter.fetch_add(1, Ordering::Relaxed);
                            return None;
                        }

                        let params = parser::parse_generation_metadata(&raw_metadata);
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
        let errors = error_counter.load(Ordering::Relaxed);

        // ── Stage 5: Chunked thumbnail generation with progress ──────
        let immediate_thumb_count =
            files_to_process_count.min(immediate_thumb_budget(storage_profile));
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

            for (chunk_idx, chunk) in immediate_thumb_paths.chunks(THUMB_CHUNK_SIZE).enumerate() {
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

                let done = ((chunk_idx + 1) * THUMB_CHUNK_SIZE).min(immediate_thumb_count);
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
                    for chunk in remaining_thumb_paths.chunks(THUMB_CHUNK_SIZE * 4) {
                        let generated = image_processing::generate_thumbnails(
                            chunk,
                            &cache_dir_bg,
                            storage_profile,
                        );
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
                    log::info!("Background thumbnail warmup complete ({} files)", remaining);
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

// ────────────────────────── Image queries ──────────────────────────

#[tauri::command]
pub fn get_images(
    limit: u32,
    offset: u32,
    state: tauri::State<AppState>,
) -> Result<Vec<ImageRecord>, String> {
    state
        .db
        .get_all_images(limit, offset)
        .map_err(|e| e.to_string())
}

/// Cursor-based pagination for infinite scroll with optional sorting.
#[tauri::command]
pub fn get_images_cursor(
    cursor: Option<String>,
    limit: u32,
    sort_by: Option<String>,
    generation_types: Option<Vec<String>>,
    model_filter: Option<String>,
    model_family_filters: Option<Vec<String>>,
    state: tauri::State<AppState>,
) -> Result<CursorPage, String> {
    state
        .db
        .get_images_cursor(
            cursor.as_deref(),
            limit,
            sort_by.as_deref(),
            generation_types.as_deref(),
            model_filter.as_deref(),
            model_family_filters.as_deref(),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_images(
    query: String,
    limit: u32,
    offset: u32,
    state: tauri::State<AppState>,
) -> Result<Vec<ImageRecord>, String> {
    if query.trim().is_empty() {
        return state
            .db
            .get_all_images(limit, offset)
            .map_err(|e| e.to_string());
    }

    state
        .db
        .search(&query, limit, offset)
        .map_err(|e| e.to_string())
}

/// Cursor-based search.
#[tauri::command]
pub fn search_images_cursor(
    query: String,
    cursor: Option<String>,
    limit: u32,
    generation_types: Option<Vec<String>>,
    sort_by: Option<String>,
    model_filter: Option<String>,
    model_family_filters: Option<Vec<String>>,
    state: tauri::State<AppState>,
) -> Result<CursorPage, String> {
    if query.trim().is_empty() {
        return state
            .db
            .get_images_cursor(
                cursor.as_deref(),
                limit,
                sort_by.as_deref(),
                generation_types.as_deref(),
                model_filter.as_deref(),
                model_family_filters.as_deref(),
            )
            .map_err(|e| e.to_string());
    }

    state
        .db
        .search_cursor(
            &query,
            cursor.as_deref(),
            limit,
            generation_types.as_deref(),
            sort_by.as_deref(),
            model_filter.as_deref(),
            model_family_filters.as_deref(),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn filter_images(
    tags_include: Vec<String>,
    tags_exclude: Vec<String>,
    query: Option<String>,
    limit: u32,
    offset: u32,
    state: tauri::State<AppState>,
) -> Result<Vec<ImageRecord>, String> {
    state
        .db
        .filter_images(
            query.as_deref(),
            &tags_include,
            &tags_exclude,
            limit,
            offset,
        )
        .map_err(|e| e.to_string())
}

/// Cursor-based filtering.
#[tauri::command]
pub fn filter_images_cursor(
    tags_include: Vec<String>,
    tags_exclude: Vec<String>,
    query: Option<String>,
    cursor: Option<String>,
    limit: u32,
    generation_types: Option<Vec<String>>,
    sort_by: Option<String>,
    model_filter: Option<String>,
    model_family_filters: Option<Vec<String>>,
    state: tauri::State<AppState>,
) -> Result<CursorPage, String> {
    state
        .db
        .filter_images_cursor(
            query.as_deref(),
            &tags_include,
            &tags_exclude,
            cursor.as_deref(),
            limit,
            generation_types.as_deref(),
            sort_by.as_deref(),
            model_filter.as_deref(),
            model_family_filters.as_deref(),
        )
        .map_err(|e| e.to_string())
}

// ────────────────────────── Tag queries ──────────────────────────

#[tauri::command]
pub fn list_tags(
    prefix: Option<String>,
    limit: u32,
    state: tauri::State<AppState>,
) -> Result<Vec<String>, String> {
    state
        .db
        .list_tags(prefix.as_deref(), limit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_top_tags(limit: u32, state: tauri::State<AppState>) -> Result<Vec<TagCount>, String> {
    state.db.get_top_tags(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_image_tags(id: i64, state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    state.db.get_tags_for_image(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_image_detail(
    id: i64,
    state: tauri::State<AppState>,
) -> Result<Option<ImageRecord>, String> {
    state.db.get_image_by_id(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_total_count(state: tauri::State<AppState>) -> Result<u32, String> {
    state.db.get_total_count().map_err(|e| e.to_string())
}

// ────────────────────────── Group-by queries ──────────────────────────

/// Returns unique directories with image counts for group-by view.
#[tauri::command]
pub fn get_directories(state: tauri::State<AppState>) -> Result<Vec<DirectoryEntry>, String> {
    state.db.get_unique_directories().map_err(|e| e.to_string())
}

/// Returns unique model names with image counts for group-by view.
#[tauri::command]
pub fn get_models(state: tauri::State<AppState>) -> Result<Vec<ModelEntry>, String> {
    state.db.get_unique_models().map_err(|e| e.to_string())
}

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
                let (primary_path, _) =
                    image_processing::get_thumbnail_candidate_paths(source, &cache_dir);
                let primary_key = primary_path.to_string_lossy().to_string();

                // Skip only if current-format thumbnail exists. Legacy-only entries
                // should be regenerated to compact storage.
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

            log::info!(
                "Thumbnail pre-cache complete: total={}, generated={}, skipped={}, failed={}, profile={}",
                total,
                generated,
                skipped,
                failed,
                profile_label(storage_profile)
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
            .write_to(&mut std::io::Cursor::new(&mut encoded), image::ImageFormat::Png)
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
pub async fn get_image_clipboard_payload(filepath: String) -> Result<ClipboardImagePayload, String> {
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

        let (primary_path, legacy_path) =
            image_processing::get_thumbnail_candidate_paths(source, &cache_dir);
        let primary_key = primary_path.to_string_lossy().to_string();
        let legacy_key = legacy_path.to_string_lossy().to_string();

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

        // Legacy thumbnail exists: attempt migration to compact current format.
        let has_legacy = legacy_path.exists()
            || thumbnail_index
                .read()
                .map(|index| index.contains(&legacy_key))
                .unwrap_or(false);
        if has_legacy {
            match image_processing::ensure_thumbnail(source, &cache_dir, storage_profile) {
                Ok(generated) => {
                    let generated_key = generated.to_string_lossy().to_string();
                    if let Ok(mut index) = thumbnail_index.write() {
                        index.insert(generated_key.clone());
                        if generated_key != legacy_key {
                            index.remove(&legacy_key);
                        }
                    }
                    if let Ok(mut failed) = failed_thumbnail_sources.write() {
                        failed.remove(&filepath);
                    }
                    return Ok(generated_key);
                }
                Err(error) => {
                    log::warn!(
                        "Legacy thumbnail migration failed for {}: {}",
                        filepath,
                        error
                    );
                    if legacy_path.exists() {
                        if let Ok(mut index) = thumbnail_index.write() {
                            index.insert(legacy_key.clone());
                        }
                        if let Ok(mut failed) = failed_thumbnail_sources.write() {
                            failed.remove(&filepath);
                        }
                        return Ok(legacy_key);
                    }
                }
            }
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
                    if generated_key != legacy_key {
                        index.remove(&legacy_key);
                    }
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
        let mut resolved =
            std::collections::HashMap::<String, String>::with_capacity(filepaths.len());
        let mut missing: Vec<String> = Vec::new();
        let mut discovered_on_disk: Vec<String> = Vec::new();
        let failed_guard = failed_thumbnail_sources.read().ok();

        if let Ok(index) = thumbnail_index.read() {
            for filepath in &filepaths {
                let source = Path::new(filepath);
                let (primary_path, legacy_path) =
                    image_processing::get_thumbnail_candidate_paths(source, &cache_dir);
                let primary_key = primary_path.to_string_lossy().to_string();
                let legacy_key = legacy_path.to_string_lossy().to_string();

                if index.contains(&primary_key) {
                    resolved.insert(filepath.clone(), primary_key);
                } else if primary_path.exists() {
                    discovered_on_disk.push(primary_key.clone());
                    resolved.insert(filepath.clone(), primary_key);
                } else if index.contains(&legacy_key) || legacy_path.exists() {
                    // Force regeneration to current compact format when possible.
                    missing.push(filepath.clone());
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
                for (filepath, thumbnail_path) in &mappings {
                    if thumbnail_path != filepath {
                        index.insert(thumbnail_path.clone());
                        let source = Path::new(filepath);
                        let (_, legacy_path) =
                            image_processing::get_thumbnail_candidate_paths(source, &cache_dir);
                        let legacy_key = legacy_path.to_string_lossy().to_string();
                        if thumbnail_path != &legacy_key {
                            index.remove(&legacy_key);
                        }
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
                resolved.insert(filepath, thumbnail_path);
            }
        }

        Ok(filepaths
            .into_iter()
            .map(|filepath| ThumbnailMapping {
                thumbnail_path: resolved
                    .get(&filepath)
                    .cloned()
                    .unwrap_or_else(|| filepath.clone()),
                filepath,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ────────────────────────── Shell / OS ──────────────────────────

/// Opens the native file explorer with the given file selected.
#[tauri::command]
pub async fn open_file_location(filepath: String) -> Result<(), String> {
    let path = PathBuf::from(&filepath);
    if !path.exists() {
        return Err(format!("File not found: {}", filepath));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg("/select,")
            .arg(&filepath)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&filepath)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try xdg-open on the parent directory
        if let Some(parent) = path.parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("Failed to open file manager: {}", e))?;
        }
    }

    Ok(())
}

// ────────────────────────── Export ──────────────────────────

#[tauri::command]
pub fn export_images(
    ids: Vec<i64>,
    format: String,
    output_path: String,
    state: tauri::State<AppState>,
) -> Result<ExportResult, String> {
    let records = state
        .db
        .get_images_by_ids(&ids)
        .map_err(|e| e.to_string())?;
    if records.is_empty() {
        return Err("No images found for the requested ids".to_string());
    }

    let mut export_records = Vec::new();
    for record in &records {
        let tags = state
            .db
            .get_tags_for_image(record.id)
            .map_err(|e| e.to_string())?;
        export_records.push(ExportImage {
            id: record.id,
            filepath: record.filepath.clone(),
            filename: record.filename.clone(),
            directory: record.directory.clone(),
            prompt: record.prompt.clone(),
            negative_prompt: record.negative_prompt.clone(),
            steps: record.steps.clone(),
            sampler: record.sampler.clone(),
            cfg_scale: record.cfg_scale.clone(),
            seed: record.seed.clone(),
            width: record.width,
            height: record.height,
            model_hash: record.model_hash.clone(),
            model_name: record.model_name.clone(),
            raw_metadata: record.raw_metadata.clone(),
            tags,
        });
    }

    let content = match format.trim().to_ascii_lowercase().as_str() {
        "json" => serde_json::to_string_pretty(&export_records).map_err(|e| e.to_string())?,
        "csv" => build_csv_export(&export_records).map_err(|e| e.to_string())?,
        _ => return Err("Unsupported export format. Use 'json' or 'csv'.".to_string()),
    };

    std::fs::write(&output_path, content).map_err(|e| e.to_string())?;

    Ok(ExportResult {
        exported_count: export_records.len(),
        output_path,
    })
}

fn build_csv_export(records: &[ExportImage]) -> Result<String, csv::Error> {
    let mut wtr = csv::Writer::from_writer(Vec::new());

    wtr.write_record([
        "id",
        "filepath",
        "filename",
        "directory",
        "prompt",
        "negative_prompt",
        "steps",
        "sampler",
        "cfg_scale",
        "seed",
        "width",
        "height",
        "model_hash",
        "model_name",
        "raw_metadata",
        "tags",
    ])?;

    for record in records {
        wtr.write_record([
            &record.id.to_string(),
            &record.filepath,
            &record.filename,
            &record.directory,
            &record.prompt,
            &record.negative_prompt,
            record.steps.as_deref().unwrap_or(""),
            record.sampler.as_deref().unwrap_or(""),
            record.cfg_scale.as_deref().unwrap_or(""),
            record.seed.as_deref().unwrap_or(""),
            &record.width.map(|v| v.to_string()).unwrap_or_default(),
            &record.height.map(|v| v.to_string()).unwrap_or_default(),
            record.model_hash.as_deref().unwrap_or(""),
            record.model_name.as_deref().unwrap_or(""),
            &record.raw_metadata,
            &record.tags.join("|"),
        ])?;
    }

    let bytes = wtr.into_inner().map_err(|e| e.into_error())?;
    Ok(String::from_utf8(bytes).unwrap_or_default())
}

// ────────────────────────── Export as Files (ZIP) ──────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct FileExportResult {
    pub exported_count: usize,
    pub output_path: String,
    pub total_bytes: u64,
}

fn encode_image_as_jxl(source: &Path) -> Result<Vec<u8>, String> {
    use zune_core::bit_depth::BitDepth;
    use zune_core::colorspace::ColorSpace;
    use zune_core::options::EncoderOptions;
    use zune_jpegxl::JxlSimpleEncoder;

    let image = image_decode::open_image(source)
        .map_err(|error| format!("Failed to open {}: {}", source.display(), error))?;
    let rgba = image.to_rgba8();
    let options = EncoderOptions::new(
        rgba.width() as usize,
        rgba.height() as usize,
        ColorSpace::RGBA,
        BitDepth::Eight,
    );
    let encoder = JxlSimpleEncoder::new(rgba.as_raw(), options);
    let mut encoded = Vec::new();
    encoder
        .encode(&mut encoded)
        .map_err(|error| format!("JPEG XL encode error: {}", error))?;
    Ok(encoded)
}

/// Exports selected images as a ZIP file.
///
/// Supported `format` values:
/// - `"original"` -- copies the source files as-is into the ZIP
/// - `"png"` -- converts each image to PNG
/// - `"jpeg"` -- converts each image to JPEG at the given `quality` (1-100)
/// - `"webp"` -- converts each image to WebP at the given `quality` (1-100)
/// - `"jxl"` -- converts each image to JPEG XL (lossless)
#[tauri::command]
pub fn export_images_as_files(
    ids: Vec<i64>,
    format: String,
    quality: Option<u8>,
    output_path: String,
    state: tauri::State<AppState>,
) -> Result<FileExportResult, String> {
    use std::io::{BufWriter, Write};

    let records = state
        .db
        .get_images_by_ids(&ids)
        .map_err(|e| e.to_string())?;
    if records.is_empty() {
        return Err("No images found for the requested ids".to_string());
    }

    let fmt = format.trim().to_ascii_lowercase();
    let quality = quality.unwrap_or(85).clamp(1, 100);

    let file = std::fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;
    let writer = BufWriter::with_capacity(256 * 1024, file);
    let mut zip = zip::ZipWriter::new(writer);
    let zip_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(6));

    let mut exported = 0usize;
    let mut seen_names = std::collections::HashSet::<String>::new();

    for record in &records {
        let source = Path::new(&record.filepath);
        if !source.exists() {
            log::warn!("Export: source file missing, skipping: {}", record.filepath);
            continue;
        }

        let base_name = record.filename.clone();
        let stem = match base_name.rsplit_once('.') {
            Some((s, _)) => s.to_string(),
            None => base_name.clone(),
        };

        let target_ext = match fmt.as_str() {
            "png" => "png",
            "jpeg" | "jpg" => "jpg",
            "webp" => "webp",
            "jxl" => "jxl",
            _ => source.extension().and_then(|e| e.to_str()).unwrap_or("png"),
        };

        let mut zip_name = format!("{}.{}", stem, target_ext);
        let mut counter = 1u32;
        while seen_names.contains(&zip_name) {
            zip_name = format!("{}_{}.{}", stem, counter, target_ext);
            counter += 1;
        }
        seen_names.insert(zip_name.clone());

        match fmt.as_str() {
            "original" => {
                let raw = std::fs::read(source)
                    .map_err(|e| format!("Failed to read {}: {}", record.filepath, e))?;
                zip.start_file(&zip_name, zip_options)
                    .map_err(|e| format!("ZIP write error: {}", e))?;
                zip.write_all(&raw)
                    .map_err(|e| format!("ZIP write error: {}", e))?;
            }
            "png" => {
                let img = image_decode::open_image(source)
                    .map_err(|e| format!("Failed to open {}: {}", record.filepath, e))?;
                let mut buf = Vec::new();
                img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
                    .map_err(|e| format!("PNG encode error: {}", e))?;
                zip.start_file(&zip_name, zip_options)
                    .map_err(|e| format!("ZIP write error: {}", e))?;
                zip.write_all(&buf)
                    .map_err(|e| format!("ZIP write error: {}", e))?;
            }
            "jpeg" | "jpg" => {
                let img = image_decode::open_image(source)
                    .map_err(|e| format!("Failed to open {}: {}", record.filepath, e))?;
                let rgb = img.to_rgb8();
                let mut buf = Vec::new();
                let mut encoder =
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
                encoder
                    .encode(
                        rgb.as_raw(),
                        rgb.width(),
                        rgb.height(),
                        image::ExtendedColorType::Rgb8,
                    )
                    .map_err(|e| format!("JPEG encode error: {}", e))?;
                zip.start_file(&zip_name, zip_options)
                    .map_err(|e| format!("ZIP write error: {}", e))?;
                zip.write_all(&buf)
                    .map_err(|e| format!("ZIP write error: {}", e))?;
            }
            "webp" => {
                let img = image_decode::open_image(source)
                    .map_err(|e| format!("Failed to open {}: {}", record.filepath, e))?;
                let mut buf = Vec::new();
                img.write_to(
                    &mut std::io::Cursor::new(&mut buf),
                    image::ImageFormat::WebP,
                )
                .map_err(|e| format!("WebP encode error: {}", e))?;
                zip.start_file(&zip_name, zip_options)
                    .map_err(|e| format!("ZIP write error: {}", e))?;
                zip.write_all(&buf)
                    .map_err(|e| format!("ZIP write error: {}", e))?;
            }
            "jxl" => {
                let buf = encode_image_as_jxl(source)?;
                zip.start_file(&zip_name, zip_options)
                    .map_err(|e| format!("ZIP write error: {}", e))?;
                zip.write_all(&buf)
                    .map_err(|e| format!("ZIP write error: {}", e))?;
            }
            _ => {
                return Err(format!(
                    "Unsupported format '{}'. Use 'original', 'png', 'jpeg', 'webp', or 'jxl'.",
                    fmt
                ));
            }
        }

        exported += 1;
    }

    let mut inner = zip
        .finish()
        .map_err(|e| format!("Failed to finalize ZIP: {}", e))?;
    inner
        .flush()
        .map_err(|e| format!("Failed to flush ZIP: {}", e))?;

    let total_bytes = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(FileExportResult {
        exported_count: exported,
        output_path,
        total_bytes,
    })
}

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
        &prompt,
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
    base_url: &str,
    api_key: Option<&str>,
    output_dir: &Path,
    include_seed: bool,
    adetailer_face_enabled: bool,
    adetailer_face_model: Option<&str>,
    lora_tokens: Option<&[String]>,
    lora_weight: f32,
    overrides: Option<&ForgePayloadOverridesInput>,
) -> Result<ForgeSendOutput, String> {
    let mut saved_paths = Vec::new();
    let mut failures = Vec::new();
    let mut unprocessed_count = 0usize;
    let mut processed_count = 0usize;

    if adetailer_face_enabled {
        let unprocessed_payload = build_payload_for_image(
            image,
            include_seed,
            false,
            adetailer_face_model,
            lora_tokens,
            lora_weight,
            overrides,
        )?;
        match send_payload_and_save(
            &unprocessed_payload,
            base_url,
            api_key,
            output_dir,
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
        include_seed,
        adetailer_face_enabled,
        adetailer_face_model,
        lora_tokens,
        lora_weight,
        overrides,
    )?;
    let processed_variant = if adetailer_face_enabled {
        Some("adetailer")
    } else {
        None
    };
    match send_payload_and_save(
        &processed_payload,
        base_url,
        api_key,
        output_dir,
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
            if adetailer_face_enabled {
                failures.push(format!("ADetailer request failed: {}", error));
            } else {
                failures.push(error);
            }
        }
    }

    let generated_count = saved_paths.len();
    let output_dir_display = output_dir.to_string_lossy().to_string();
    if !failures.is_empty() {
        let summary = if adetailer_face_enabled {
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
                output_dir.display(),
                failures.join(" | ")
            ),
            output_dir: output_dir_display,
            generated_count,
            saved_paths,
        });
    }

    let message = if adetailer_face_enabled {
        format!(
            "Saved {} unprocessed and {} ADetailer image{} to {}",
            unprocessed_count,
            processed_count,
            if generated_count == 1 { "" } else { "s" },
            output_dir.display()
        )
    } else {
        format!(
            "Saved {} generated image{} to {}",
            processed_count,
            if processed_count == 1 { "" } else { "s" },
            output_dir.display()
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
    image_id: i64,
    base_url: String,
    api_key: Option<String>,
    output_dir: Option<String>,
    include_seed: Option<bool>,
    adetailer_face_enabled: Option<bool>,
    adetailer_face_model: Option<String>,
    lora_tokens: Option<Vec<String>>,
    lora_weight: Option<f32>,
    overrides: Option<ForgePayloadOverridesInput>,
    state: tauri::State<'_, AppState>,
) -> Result<ForgeSendOutput, String> {
    let include_seed = include_seed.unwrap_or(true);
    let adetailer_face_enabled = adetailer_face_enabled.unwrap_or(false);
    let adetailer_face_model = adetailer_face_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ADETAILER_FACE_MODEL);
    let lora_weight = lora_weight.unwrap_or(1.0);
    if !lora_weight.is_finite() {
        return Err("Invalid LoRA weight value".to_string());
    }
    let _queue_guard = state.forge_send_queue.lock().await;
    let default_output_base = default_forge_output_base_dir(&state.cache_dir);
    let output_dir = resolve_forge_output_dir(output_dir.as_deref(), &default_output_base)?;
    let image = state
        .db
        .get_image_by_id(image_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {}", image_id))?;

    send_image_record_to_forge(
        &image,
        &base_url,
        api_key.as_deref(),
        &output_dir,
        include_seed,
        adetailer_face_enabled,
        Some(adetailer_face_model),
        lora_tokens.as_deref(),
        lora_weight,
        overrides.as_ref(),
    )
    .await
}

#[tauri::command]
pub async fn forge_send_to_images(
    image_ids: Vec<i64>,
    base_url: String,
    api_key: Option<String>,
    output_dir: Option<String>,
    include_seed: Option<bool>,
    adetailer_face_enabled: Option<bool>,
    adetailer_face_model: Option<String>,
    lora_tokens: Option<Vec<String>>,
    lora_weight: Option<f32>,
    overrides: Option<ForgePayloadOverridesInput>,
    state: tauri::State<'_, AppState>,
) -> Result<ForgeBatchSendOutput, String> {
    if image_ids.is_empty() {
        return Err("No selected images for Forge queue".to_string());
    }

    let include_seed = include_seed.unwrap_or(true);
    let adetailer_face_enabled = adetailer_face_enabled.unwrap_or(false);
    let adetailer_face_model = adetailer_face_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ADETAILER_FACE_MODEL);
    let lora_weight = lora_weight.unwrap_or(1.0);
    if !lora_weight.is_finite() {
        return Err("Invalid LoRA weight value".to_string());
    }
    let _queue_guard = state.forge_send_queue.lock().await;
    let default_output_base = default_forge_output_base_dir(&state.cache_dir);
    let output_dir = resolve_forge_output_dir(output_dir.as_deref(), &default_output_base)?;
    let output_dir_display = output_dir.to_string_lossy().to_string();

    let mut items = Vec::with_capacity(image_ids.len());
    let mut succeeded = 0usize;

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

        match send_image_record_to_forge(
            &image,
            &base_url,
            api_key.as_deref(),
            &output_dir,
            include_seed,
            adetailer_face_enabled,
            Some(adetailer_face_model),
            lora_tokens.as_deref(),
            lora_weight,
            overrides.as_ref(),
        )
        .await
        {
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
