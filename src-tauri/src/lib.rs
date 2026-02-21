pub mod database;
pub mod forge_api;
pub mod image_decode;
pub mod image_processing;
pub mod parser;
pub mod scanner;
pub mod sidecar;

mod commands;

use commands::{
    delete_images, directory_exists, export_images, export_images_as_files, filter_images_cursor,
    forge_get_options, forge_send_to_image, forge_send_to_images, forge_test_connection,
    get_directories, get_display_image_path, get_forge_api_key, get_image_clipboard_payload,
    get_image_detail, get_image_tags, get_images_cursor, get_models, get_sidecar_data,
    get_storage_profile, get_thumbnail_path, get_thumbnail_paths, get_top_tags, get_total_count,
    list_tags, move_images_to_directory, open_file_location, precache_all_thumbnails,
    save_sidecar_tags, scan_directory, search_images_cursor, set_forge_api_key, set_image_favorite,
    set_image_locked, set_images_favorite, set_images_locked, set_storage_profile,
};
use database::Database;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};
use tauri::async_runtime::Mutex;
use tauri::Manager;

const STORAGE_PROFILE_FILE: &str = "storage_profile.json";
const FORGE_API_KEY_FILE: &str = "forge_api_key.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StorageProfile {
    #[default]
    Hdd,
    Ssd,
}

/// Shared application state for Tauri commands.
pub struct AppState {
    pub db: Database,
    pub cache_dir: PathBuf,
    pub thumbnail_index: Arc<RwLock<HashSet<String>>>,
    pub failed_thumbnail_sources: Arc<RwLock<HashSet<String>>>,
    pub thumbnail_precache_running: Arc<AtomicBool>,
    pub storage_profile: Arc<RwLock<StorageProfile>>,
    pub storage_profile_path: PathBuf,
    pub forge_api_key: Arc<RwLock<String>>,
    pub forge_api_key_path: PathBuf,
    pub forge_send_queue: Arc<Mutex<()>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub total_files: usize,
    pub indexed: usize,
    pub errors: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResult {
    pub exported_count: usize,
    pub output_path: String,
}

/// Entry point: sets up the Tauri application with managed state.
pub fn run() {
    env_logger::init();
    image_decode::ensure_jxl_decoder_registered();

    let cpu_count = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(8);
    let rayon_threads = cpu_count.saturating_sub(1).max(2);
    if rayon::ThreadPoolBuilder::new()
        .num_threads(rayon_threads)
        .build_global()
        .is_ok()
    {
        log::info!(
            "Configured rayon global thread pool with {} workers ({} CPUs detected)",
            rayon_threads,
            cpu_count
        );
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");
            std::fs::create_dir_all(&app_data).ok();
            let storage_profile_path = app_data.join(STORAGE_PROFILE_FILE);
            let storage_profile_value = load_storage_profile(&storage_profile_path);
            let storage_profile = Arc::new(RwLock::new(storage_profile_value));
            let forge_api_key_path = app_data.join(FORGE_API_KEY_FILE);
            let forge_api_key = Arc::new(RwLock::new(load_forge_api_key(&forge_api_key_path)));

            let db_path = app_data.join("ForgeMetaLink.db");
            let cache_dir = app_data.join("thumbnails");
            std::fs::create_dir_all(&cache_dir).ok();
            let thumbnail_index = Arc::new(RwLock::new(build_thumbnail_index(&cache_dir)));
            let failed_thumbnail_sources = Arc::new(RwLock::new(HashSet::new()));
            let thumbnail_precache_running = Arc::new(AtomicBool::new(false));
            let forge_send_queue = Arc::new(Mutex::new(()));

            // R2D2 pool created here
            let db = Database::new(&db_path, storage_profile_value)
                .expect("Failed to initialize database");
            app.manage(AppState {
                db,
                cache_dir,
                thumbnail_index,
                failed_thumbnail_sources,
                thumbnail_precache_running,
                storage_profile,
                storage_profile_path,
                forge_api_key,
                forge_api_key_path,
                forge_send_queue,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            get_images_cursor,
            search_images_cursor,
            filter_images_cursor,
            list_tags,
            get_top_tags,
            get_image_tags,
            get_image_detail,
            get_total_count,
            get_display_image_path,
            get_image_clipboard_payload,
            get_thumbnail_path,
            get_thumbnail_paths,
            precache_all_thumbnails,
            get_directories,
            get_models,
            directory_exists,
            open_file_location,
            delete_images,
            move_images_to_directory,
            set_image_favorite,
            set_image_locked,
            set_images_favorite,
            set_images_locked,
            export_images,
            export_images_as_files,
            forge_test_connection,
            forge_get_options,
            forge_send_to_image,
            forge_send_to_images,
            get_forge_api_key,
            set_forge_api_key,
            get_sidecar_data,
            save_sidecar_tags,
            get_storage_profile,
            set_storage_profile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn load_storage_profile(path: &Path) -> StorageProfile {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return StorageProfile::default(),
    };

    #[derive(Deserialize)]
    struct StorageProfileConfig {
        profile: StorageProfile,
    }

    serde_json::from_str::<StorageProfileConfig>(&content)
        .map(|config| config.profile)
        .unwrap_or_default()
}

fn load_forge_api_key(path: &Path) -> String {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return String::new(),
    };

    #[derive(Deserialize)]
    struct ForgeApiKeyConfig {
        api_key: String,
    }

    serde_json::from_str::<ForgeApiKeyConfig>(&content)
        .map(|config| config.api_key)
        .unwrap_or_default()
}

pub(crate) fn persist_storage_profile(path: &Path, profile: StorageProfile) -> Result<(), String> {
    #[derive(Serialize)]
    struct StorageProfileConfig {
        profile: StorageProfile,
    }

    let payload = serde_json::to_string_pretty(&StorageProfileConfig { profile })
        .map_err(|error| format!("Failed to serialize storage profile: {}", error))?;

    std::fs::write(path, payload).map_err(|error| {
        format!(
            "Failed to save storage profile to {}: {}",
            path.display(),
            error
        )
    })
}

pub(crate) fn persist_forge_api_key(path: &Path, api_key: &str) -> Result<(), String> {
    #[derive(Serialize)]
    struct ForgeApiKeyConfig<'a> {
        api_key: &'a str,
    }

    let payload = serde_json::to_string_pretty(&ForgeApiKeyConfig { api_key })
        .map_err(|error| format!("Failed to serialize Forge API key: {}", error))?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create Forge API key directory {}: {}",
                parent.display(),
                error
            )
        })?;
    }

    std::fs::write(path, payload).map_err(|error| {
        format!(
            "Failed to save Forge API key to {}: {}",
            path.display(),
            error
        )
    })
}

fn build_thumbnail_index(cache_dir: &std::path::Path) -> HashSet<String> {
    let mut index = HashSet::new();

    let entries = match std::fs::read_dir(cache_dir) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!(
                "Failed to read thumbnail cache dir {}: {}",
                cache_dir.display(),
                error
            );
            return index;
        }
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        let ext = ext.to_ascii_lowercase();
        if ext == "jpg" {
            index.insert(path.to_string_lossy().to_string());
        }
    }

    log::info!(
        "Indexed {} thumbnail cache entries from {}",
        index.len(),
        cache_dir.display()
    );

    index
}

#[cfg(test)]
mod tests {
    use super::{load_forge_api_key, persist_forge_api_key};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_config_path() -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "forge_meta_link_forge_api_key_test_{}.json",
            timestamp
        ))
    }

    #[test]
    fn forge_api_key_round_trip_persists_and_loads() {
        let path = temp_config_path();
        let key = "test-api-key-123";
        persist_forge_api_key(&path, key).expect("persist should succeed");
        let loaded = load_forge_api_key(&path);
        assert_eq!(loaded, key);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn forge_api_key_load_defaults_when_file_missing() {
        let path = temp_config_path();
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
        let loaded = load_forge_api_key(&path);
        assert_eq!(loaded, "");
    }
}
