pub mod database;
pub mod forge_api;
pub mod forge_keychain;
pub mod image_decode;
pub mod image_processing;
pub mod parser;
pub mod scanner;
pub mod sidecar;

mod commands;

use commands::{
    delete_images, delete_prompt, directory_exists, export_images, export_images_as_files,
    export_prompt_library, filter_images_cursor, forge_cancel_queue, forge_get_options,
    forge_get_upscalers, forge_requeue_image, forge_send_to_image, forge_send_to_images,
    forge_test_connection, forge_upscale_image, get_directories, get_display_image_path,
    get_duplicate_groups, get_file_mtimes, get_file_mtimes_for_query, get_forge_api_key,
    get_image_clipboard_payload, get_image_detail, get_image_tags, get_images_cursor,
    get_lineage_cursor, get_lineage_trace, get_models, get_seed_walk, get_sidecar_data,
    get_storage_profile, get_tag_provenance, get_thumbnail_path, get_thumbnail_paths, get_top_tags,
    get_total_count, import_prompt_library, infer_lineage, list_prompt_tags, list_prompts,
    list_tags, move_images_to_directory, open_file_location, precache_all_thumbnails, save_prompt,
    save_sidecar_tags, scan_directory, search_images_cursor, set_forge_api_key, set_image_favorite,
    set_image_locked, set_images_favorite, set_images_locked, set_lineage_override,
    set_storage_profile, update_prompt, use_prompt,
};
use database::Database;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};
use tauri::async_runtime::Mutex;
use tauri::{Emitter, Manager};

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
    pub scan_running: Arc<AtomicBool>,
    pub forge_cancel: Arc<AtomicBool>,
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
            let override_raw = std::env::var("FORGE_META_LINK_DATA_DIR").ok();
            if cfg!(debug_assertions) && override_raw.is_some() && data_dir_override(override_raw.clone()).is_none() {
                // The caller asked for isolation. Falling back to the real library would defeat it.
                return Err("FORGE_META_LINK_DATA_DIR is set but invalid (needs an absolute path); refusing to open the default data dir".into());
            }
            let app_data = match data_dir_override(override_raw) {
                Some(dir) => {
                    log::warn!("Using OVERRIDDEN app data dir (debug build): {}", dir.display());
                    dir
                }
                None => app
                    .path()
                    .app_data_dir()
                    .expect("Failed to get app data directory"),
            };
            std::fs::create_dir_all(&app_data).ok();
            log::info!("App data dir: {}", app_data.display());
            let storage_profile_path = app_data.join(STORAGE_PROFILE_FILE);
            let storage_profile_value = load_storage_profile(&storage_profile_path);
            let storage_profile = Arc::new(RwLock::new(storage_profile_value));
            let forge_api_key_path = app_data.join(FORGE_API_KEY_FILE);
            let initial_forge_api_key = match load_forge_api_key(&forge_api_key_path) {
                Ok(Some(k)) => k,
                Ok(None) => String::new(),
                Err(e) => {
                    log::warn!("Could not read Forge API key on startup: {}", e);
                    String::new()
                }
            };
            let forge_api_key = Arc::new(RwLock::new(initial_forge_api_key));

            let db_path = app_data.join("ForgeMetaLink.db");
            let cache_dir = app_data.join("thumbnails");
            std::fs::create_dir_all(&cache_dir).ok();
            let thumbnail_index = Arc::new(RwLock::new(build_thumbnail_index(&cache_dir)));
            let failed_thumbnail_sources = Arc::new(RwLock::new(HashSet::new()));
            let thumbnail_precache_running = Arc::new(AtomicBool::new(false));
            let forge_send_queue = Arc::new(Mutex::new(()));
            let scan_running = Arc::new(AtomicBool::new(false));
            let forge_cancel = Arc::new(AtomicBool::new(false));

            // R2D2 pool created here
            let db = Database::new(&db_path, storage_profile_value)
                .expect("Failed to initialize database");

            let db_backfill = db.clone();
            let app_handle_backfill = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                match db_backfill.run_lineage_migrations_if_needed() {
                    Ok(Some(edges)) => {
                        log::info!("Startup lineage migration completed: {} edges", edges);
                        let _ = app_handle_backfill
                            .emit("lineage-updated", serde_json::json!({ "edges": edges }));
                    }
                    Ok(None) => {
                        log::debug!("Startup lineage migration already applied");
                    }
                    Err(e) => {
                        log::warn!("Startup lineage migration failed: {}", e);
                    }
                }
            });

            if let Ok(dirs) = db.get_unique_directories() {
                for entry in dirs {
                    let dir = PathBuf::from(&entry.directory);
                    if dir.exists() {
                        let _ = app.asset_protocol_scope().allow_directory(&dir, true);
                    }
                }
            }
            let _ = app.asset_protocol_scope().allow_directory(&cache_dir, true);
            let display_cache_dir = app_data.join("display-cache");
            std::fs::create_dir_all(&display_cache_dir).ok();
            let _ = app.asset_protocol_scope().allow_directory(&display_cache_dir, true);
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
                scan_running,
                forge_cancel,
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
            get_duplicate_groups,
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
            forge_get_upscalers,
            forge_send_to_image,
            forge_send_to_images,
            forge_requeue_image,
            forge_upscale_image,
            forge_cancel_queue,
            get_forge_api_key,
            set_forge_api_key,
            get_sidecar_data,
            save_sidecar_tags,
            get_storage_profile,
            set_storage_profile,
            get_file_mtimes,
            get_file_mtimes_for_query,
            get_lineage_cursor,
            get_lineage_trace,
            get_seed_walk,
            get_tag_provenance,
            infer_lineage,
            set_lineage_override,
            save_prompt,
            list_prompts,
            list_prompt_tags,
            update_prompt,
            delete_prompt,
            use_prompt,
            export_prompt_library,
            import_prompt_library,
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

pub(crate) fn load_forge_api_key(path: &Path) -> Result<Option<String>, String> {
    forge_keychain::load_forge_api_key_with_migration(path)
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
    forge_keychain::persist_forge_api_key_secure(path, api_key)
}

/// Debug builds only: `FORGE_META_LINK_DATA_DIR` redirects the database, thumbnails and the
/// Forge outputs to another folder (and the keyring entry to a separate name) so the app can be
/// exercised without touching a real library. Webview storage (UI settings) is separate: also set
/// `WEBVIEW2_USER_DATA_FOLDER` on Windows, as `launch-isolated.ps1` does. Tauri finds the
/// default folder through a Windows API, so overriding `APPDATA` does NOT work. Release builds
/// ignore the variable, and a relative or empty value is rejected rather than guessed at.
fn data_dir_override(raw: Option<String>) -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let value = raw?;
    let path = PathBuf::from(value.trim());
    if value.trim().is_empty() || !path.is_absolute() {
        log::warn!("Ignoring FORGE_META_LINK_DATA_DIR: it must be a non-empty absolute path");
        return None;
    }
    Some(path)
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
    #[test]
    fn data_dir_override_accepts_only_absolute_paths() {
        let abs = std::env::temp_dir().join("fml_override_test");
        // Release builds ignore the variable entirely, so only debug builds honour it.
        let expected = if cfg!(debug_assertions) {
            Some(abs.clone())
        } else {
            None
        };
        assert_eq!(
            data_dir_override(Some(abs.to_string_lossy().to_string())),
            expected
        );
        assert_eq!(data_dir_override(None), None);
        assert_eq!(data_dir_override(Some(String::new())), None);
        assert_eq!(data_dir_override(Some("   ".to_string())), None);
        assert_eq!(data_dir_override(Some("relative/dir".to_string())), None);
    }

    use super::{data_dir_override, load_forge_api_key, persist_forge_api_key};
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_mutex() -> &'static Mutex<()> {
        static M: OnceLock<Mutex<()>> = OnceLock::new();
        M.get_or_init(|| Mutex::new(()))
    }

    fn temp_config_path() -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        let pid = std::process::id();
        std::env::temp_dir().join(format!(
            "forge_meta_link_forge_api_key_test_{}_{}.json",
            pid, timestamp
        ))
    }

    #[test]
    fn forge_api_key_round_trip_persists_and_loads() {
        let _guard = test_mutex().lock().unwrap();
        crate::forge_keychain::clear_mock();
        let path = temp_config_path();
        let key = "test-api-key-123";
        persist_forge_api_key(&path, key).expect("persist should succeed");
        let loaded = load_forge_api_key(&path).expect("load should succeed");
        assert_eq!(loaded, Some(key.to_string()));
        let _ = std::fs::remove_file(path);
        crate::forge_keychain::clear_mock();
    }

    #[test]
    fn forge_api_key_load_defaults_when_file_missing() {
        let _guard = test_mutex().lock().unwrap();
        crate::forge_keychain::clear_mock();
        let path = temp_config_path();
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
        let loaded = load_forge_api_key(&path).expect("load should succeed");
        assert_eq!(loaded, None);
        crate::forge_keychain::clear_mock();
    }

    #[test]
    fn forge_api_keychain_migrates_plaintext_and_deletes_file() {
        let _guard = test_mutex().lock().unwrap();
        crate::forge_keychain::clear_mock();
        let path = temp_config_path();
        let key = "migrate-secret-xyz";
        let payload = serde_json::json!({ "api_key": key }).to_string();
        std::fs::write(&path, payload).expect("write plaintext");
        assert!(path.exists());
        let loaded = load_forge_api_key(&path).expect("load should succeed");
        assert_eq!(
            loaded,
            Some(key.to_string()),
            "migrated key must be loadable from keychain mock"
        );
        assert!(
            !path.exists(),
            "plaintext file must be deleted after migration, still exists at {}",
            path.display()
        );
        let _ = std::fs::remove_file(&path);
        crate::forge_keychain::clear_mock();
    }

    #[test]
    fn forge_api_persist_writes_to_keychain_not_plaintext() {
        let _guard = test_mutex().lock().unwrap();
        crate::forge_keychain::clear_mock();
        let path = temp_config_path();
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
        let key = "keychain-only-456";
        persist_forge_api_key(&path, key).expect("persist should succeed");
        assert!(
            !path.exists(),
            "persist must not leave plaintext file when keychain available, found {}",
            path.display()
        );
        let loaded = load_forge_api_key(&path).expect("load should succeed");
        assert_eq!(loaded, Some(key.to_string()));
        let _ = std::fs::remove_file(&path);
        crate::forge_keychain::clear_mock();
    }

    #[test]
    fn forge_api_key_set_failure_preserves_plaintext_file() {
        let _guard = test_mutex().lock().unwrap();
        crate::forge_keychain::clear_mock();
        let path = temp_config_path();
        let key = "important-api-key";
        let payload = serde_json::json!({ "api_key": key }).to_string();
        std::fs::write(&path, payload).expect("write plaintext");

        // Simulate keyring_set failure
        crate::forge_keychain::set_mock_fail_set(true);

        let loaded = load_forge_api_key(&path).expect("should load from plaintext fallback");
        assert_eq!(loaded, Some(key.to_string()));
        assert!(
            path.exists(),
            "plaintext file must still exist after failed keyring_set"
        );

        let _ = std::fs::remove_file(&path);
        crate::forge_keychain::clear_mock();
    }

    #[test]
    fn forge_api_key_get_failure_reports_error_and_deletes_nothing() {
        let _guard = test_mutex().lock().unwrap();
        crate::forge_keychain::clear_mock();
        let path = temp_config_path();

        // Simulate keyring_get failure
        crate::forge_keychain::set_mock_fail_get(true);

        let result = load_forge_api_key(&path);
        assert!(
            result.is_err(),
            "load should report error on keyring failure"
        );
        assert!(
            !path.exists(),
            "no file should have been created or modified"
        );

        crate::forge_keychain::clear_mock();
    }
}
