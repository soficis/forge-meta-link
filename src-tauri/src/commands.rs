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
    match profile {
        StorageProfile::Hdd => cpu_count.clamp(2, HDD_FRIENDLY_SCAN_THREADS),
        StorageProfile::Ssd => cpu_count.clamp(4, SSD_FRIENDLY_SCAN_THREADS),
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
    state
        .forge_api_key
        .read()
        .map(|api_key| api_key.clone())
        .map_err(|_| "Failed to read Forge API key".to_string())
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

include!("commands/scan.rs");

include!("commands/queries.rs");

include!("commands/thumbnails.rs");

include!("commands/shell.rs");

include!("commands/export.rs");

include!("commands/forge.rs");

include!("commands/sidecar.rs");

include!("commands/delete.rs");
