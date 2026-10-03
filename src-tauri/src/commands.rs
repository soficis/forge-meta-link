use crate::{
    database::{
        BulkRecord, BulkRecordWithLineage, CursorPage, DirectoryEntry, DuplicateGroup,
        ImageRecord, LineageEdgeRecord, ModelEntry, TagCount,
    },
    forge_api, image_decode, image_processing, parser, scanner, sidecar, AppState, ExportResult,
    ScanResult, StorageProfile,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
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

const BULK_CHUNK_SIZE: usize = 500;
/// File chunk size for metadata parsing to avoid building huge in-memory vectors.
const METADATA_PARSE_CHUNK_SIZE: usize = 2_048;

/// Size of each thumbnail generation chunk for scan-time immediate cache generation.
const THUMB_SCAN_CHUNK_HDD: usize = 64;
const THUMB_SCAN_CHUNK_SSD: usize = 192;
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
            return parsed.clamp(1, 32);
        }
    }

    let cpu_count = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4);
    let cpu_minus_one = cpu_count.saturating_sub(1).max(2);
    match profile {
        StorageProfile::Hdd => cpu_minus_one.clamp(2, HDD_FRIENDLY_SCAN_THREADS),
        StorageProfile::Ssd => cpu_minus_one.clamp(4, SSD_FRIENDLY_SCAN_THREADS),
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

fn scan_thumbnail_chunk_size(profile: StorageProfile) -> usize {
    match profile {
        StorageProfile::Hdd => THUMB_SCAN_CHUNK_HDD,
        StorageProfile::Ssd => THUMB_SCAN_CHUNK_SSD,
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

#[tauri::command]
pub fn get_forge_api_key(state: tauri::State<'_, AppState>) -> Result<String, String> {
    match crate::load_forge_api_key(&state.forge_api_key_path) {
        Ok(Some(key)) => {
            if let Ok(mut lock) = state.forge_api_key.write() {
                *lock = key.clone();
            }
            Ok(key)
        }
        Ok(None) => Ok(String::new()),
        Err(e) => {
            log::warn!("Failed to read Forge API key: {}", e);
            Err(format!("Could not read saved Forge API key: {}", e))
        }
    }
}

#[tauri::command]
pub fn set_forge_api_key(api_key: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    {
        let mut lock = state
            .forge_api_key
            .write()
            .map_err(|_| "Failed to update Forge API key".to_string())?;
        *lock = api_key.clone();
    }

    crate::persist_forge_api_key(&state.forge_api_key_path, &api_key)?;
    Ok(())
}

/// Returns true if filepath is either an indexed image in the DB,
/// or located under the thumbnail cache directory or the display cache directory.
pub fn is_allowed_path(filepath: &str, db: &crate::database::Database, cache_dir: &Path) -> bool {
    if db.is_indexed_path(filepath) {
        return true;
    }

    let path = Path::new(filepath);

    // Allow files directly inside or subdirectories of cache_dir (thumbnails)
    if let (Ok(canonical_path), Ok(canonical_cache)) =
        (path.canonicalize(), cache_dir.canonicalize())
    {
        if canonical_path.starts_with(&canonical_cache) {
            return true;
        }
    } else if path.starts_with(cache_dir) {
        return true;
    }

    // Allow files in display-cache
    let display_cache = cache_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("display-cache");
    if let (Ok(canonical_path), Ok(canonical_display)) =
        (path.canonicalize(), display_cache.canonicalize())
    {
        if canonical_path.starts_with(&canonical_display) {
            return true;
        }
    } else if path.starts_with(&display_cache) {
        return true;
    }

    false
}

include!("commands/scan.rs");

include!("commands/queries.rs");

include!("commands/thumbnails.rs");

include!("commands/shell.rs");

include!("commands/export.rs");

include!("commands/forge.rs");

include!("commands/sidecar.rs");

include!("commands/delete.rs");

include!("commands/timeline.rs");

include!("commands/lineage.rs");

include!("commands/prompt_library.rs");

#[cfg(test)]
mod path_validation_tests {
    use super::*;

    #[test]
    fn test_is_indexed_and_allowed_path() {
        let temp_dir = std::env::temp_dir().join(format!(
            "fml_path_val_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let db_path = temp_dir.join("test.db");
        let db = crate::database::Database::new(&db_path, crate::StorageProfile::Hdd).unwrap();
        let cache_dir = temp_dir.join("cache");
        let display_cache_dir = temp_dir.join("display-cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::create_dir_all(&display_cache_dir).unwrap();

        let indexed_file = temp_dir.join("indexed.png");
        std::fs::write(&indexed_file, b"data").unwrap();

        let conn = db.pool_get_for_test().unwrap();
        conn.execute(
            "INSERT INTO images(filepath, filename, directory, prompt, quick_hash, file_mtime)
             VALUES (?1, 'indexed.png', ?2, 'p', NULL, 100)",
            rusqlite::params![indexed_file.to_str().unwrap(), temp_dir.to_str().unwrap()],
        )
        .unwrap();

        // 1. is_indexed_path
        assert!(db.is_indexed_path(indexed_file.to_str().unwrap()));
        // Slash variation
        let alt_indexed = indexed_file.to_str().unwrap().replace('\\', "/");
        assert!(db.is_indexed_path(&alt_indexed));
        // Non-indexed path
        let unindexed_file = temp_dir.join("unindexed.png");
        assert!(!db.is_indexed_path(unindexed_file.to_str().unwrap()));
        assert!(!db.is_indexed_path("C:\\Windows\\System32\\calc.exe"));

        // 2. is_allowed_path
        // Indexed path is allowed
        assert!(is_allowed_path(
            indexed_file.to_str().unwrap(),
            &db,
            &cache_dir
        ));
        // Path in cache_dir (e.g. thumbnail) is allowed
        let thumb_file = cache_dir.join("thumb1.jpg");
        std::fs::write(&thumb_file, b"thumb").unwrap();
        assert!(is_allowed_path(
            thumb_file.to_str().unwrap(),
            &db,
            &cache_dir
        ));

        // Path in display-cache is allowed
        let display_file = display_cache_dir.join("proxy1.png");
        std::fs::write(&display_file, b"proxy").unwrap();
        assert!(is_allowed_path(
            display_file.to_str().unwrap(),
            &db,
            &cache_dir
        ));

        // Unindexed path outside cache is rejected
        assert!(!is_allowed_path(
            unindexed_file.to_str().unwrap(),
            &db,
            &cache_dir
        ));
        assert!(!is_allowed_path(
            "C:\\Windows\\System32\\calc.exe",
            &db,
            &cache_dir
        ));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
