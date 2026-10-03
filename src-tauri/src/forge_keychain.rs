use std::path::Path;

const SERVICE: &str = "com.forgemetalink.app";
const ACCOUNT: &str = "forge-api-key";

/// Keyring service name. A debug run that redirects its data folder (`FORGE_META_LINK_DATA_DIR`)
/// also gets its own keyring entry, so an isolated test instance can never read or overwrite the
/// real Forge API key.
pub(crate) fn service_name(isolated: bool) -> String {
    if isolated {
        format!("{SERVICE}.isolated")
    } else {
        SERVICE.to_string()
    }
}

/// Debug builds only: a non-empty `FORGE_META_LINK_DATA_DIR` means an isolated run.
pub(crate) fn isolated_from_env(raw: Option<String>) -> bool {
    cfg!(debug_assertions) && raw.is_some_and(|v| !v.trim().is_empty())
}

#[cfg(test)]
thread_local! {
    /// Per-thread stand-in for the environment so tests can flip isolation without touching the
    /// process-wide environment (which other tests read concurrently).
    static TEST_DATA_DIR_ENV: std::cell::RefCell<Option<Option<String>>> =
        const { std::cell::RefCell::new(None) };
}

fn data_dir_env() -> Option<String> {
    #[cfg(test)]
    {
        if let Some(value) = TEST_DATA_DIR_ENV.with(|cell| cell.borrow().clone()) {
            return value;
        }
    }
    std::env::var("FORGE_META_LINK_DATA_DIR").ok()
}

/// The keyring service this process must use. Both the real keyring entry and the test mock
/// derive their key from this one function, so isolation cannot be wired in one and missed in
/// the other.
fn keyring_service() -> String {
    service_name(isolated_from_env(data_dir_env()))
}

#[cfg(not(test))]
fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(&keyring_service(), ACCOUNT)
        .map_err(|e| format!("keyring entry error: {}", e))
}

#[cfg(test)]
fn keyring_get() -> Result<Option<String>, String> {
    mock_store::get()
}

#[cfg(not(test))]
fn keyring_get() -> Result<Option<String>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
fn keyring_set(value: &str) -> Result<(), String> {
    mock_store::set(value)
}

#[cfg(not(test))]
fn keyring_set(value: &str) -> Result<(), String> {
    let entry = keyring_entry()?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

#[cfg(test)]
fn keyring_delete() -> Result<(), String> {
    mock_store::delete()
}

#[cfg(not(test))]
fn keyring_delete() -> Result<(), String> {
    let entry = keyring_entry()?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn read_plaintext_file(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    #[derive(serde::Deserialize)]
    struct ForgeApiKeyConfig {
        api_key: String,
    }
    let parsed: Result<ForgeApiKeyConfig, _> = serde_json::from_str(&content);
    match parsed {
        Ok(cfg) => {
            let trimmed = cfg.api_key.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
        Err(_) => {
            let trimmed = content.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
    }
}

fn write_plaintext_fallback(path: &Path, api_key: &str) -> Result<(), String> {
    #[derive(serde::Serialize)]
    struct ForgeApiKeyConfig<'a> {
        api_key: &'a str,
    }
    let payload = serde_json::to_string_pretty(&ForgeApiKeyConfig { api_key })
        .map_err(|e| format!("Failed to serialize Forge API key: {}", e))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create Forge API key directory {}: {}",
                parent.display(),
                e
            )
        })?;
    }
    std::fs::write(path, payload)
        .map_err(|e| format!("Failed to save Forge API key to {}: {}", path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn load_forge_api_key_with_migration(path: &Path) -> Result<Option<String>, String> {
    match keyring_get() {
        Ok(Some(value)) => {
            let trimmed = value.trim().to_string();
            if !trimmed.is_empty() {
                if path.exists() {
                    let _ = std::fs::remove_file(path);
                }
                return Ok(Some(trimmed));
            }
            Ok(None)
        }
        Ok(None) => {
            if let Some(plaintext) = read_plaintext_file(path) {
                match keyring_set(&plaintext) {
                    Ok(_) => {
                        let _ = std::fs::remove_file(path);
                        Ok(Some(plaintext))
                    }
                    Err(e) => {
                        log::warn!(
                            "Failed to migrate plaintext Forge API key to keyring: {}. Keeping file.",
                            e
                        );
                        Ok(Some(plaintext))
                    }
                }
            } else {
                Ok(None)
            }
        }
        Err(e) => {
            log::warn!("Failed to read Forge API key from keyring: {}", e);
            if path.exists() {
                if let Some(plaintext) = read_plaintext_file(path) {
                    log::warn!(
                        "Falling back to plaintext Forge API key file after keyring read error."
                    );
                    return Ok(Some(plaintext));
                }
            }
            Err(e)
        }
    }
}

#[cfg(test)]
pub fn clear_mock() {
    mock_store::clear();
}

#[cfg(test)]
pub fn set_mock_fail_get(fail: bool) {
    mock_store::set_fail_get(fail);
}

#[cfg(test)]
pub fn set_mock_fail_set(fail: bool) {
    mock_store::set_fail_set(fail);
}

pub fn persist_forge_api_key_secure(path: &Path, api_key: &str) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        let _ = keyring_delete();
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    match keyring_set(trimmed) {
        Ok(_) => {
            let _ = std::fs::remove_file(path);
            Ok(())
        }
        Err(e) => {
            log::warn!(
                "keychain persist failed ({}), falling back to file with 600",
                e
            );
            write_plaintext_fallback(path, trimmed)
        }
    }
}

#[cfg(test)]
mod mock_store {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};

    static FAIL_GET: AtomicBool = AtomicBool::new(false);
    static FAIL_SET: AtomicBool = AtomicBool::new(false);

    fn store() -> &'static Mutex<HashMap<String, String>> {
        static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn key() -> String {
        format!("{}:{}", super::keyring_service(), super::ACCOUNT)
    }

    pub fn set_fail_get(fail: bool) {
        FAIL_GET.store(fail, Ordering::SeqCst);
    }

    pub fn set_fail_set(fail: bool) {
        FAIL_SET.store(fail, Ordering::SeqCst);
    }

    pub fn get() -> Result<Option<String>, String> {
        if FAIL_GET.load(Ordering::SeqCst) {
            return Err("mock keyring get failure".to_string());
        }
        let map = store()
            .lock()
            .map_err(|_| "mock lock poisoned".to_string())?;
        Ok(map.get(&key()).cloned())
    }

    pub fn set(value: &str) -> Result<(), String> {
        if FAIL_SET.load(Ordering::SeqCst) {
            return Err("mock keyring set failure".to_string());
        }
        let mut map = store()
            .lock()
            .map_err(|_| "mock lock poisoned".to_string())?;
        if value.is_empty() {
            map.remove(&key());
        } else {
            map.insert(key(), value.to_string());
        }
        Ok(())
    }

    pub fn delete() -> Result<(), String> {
        let mut map = store()
            .lock()
            .map_err(|_| "mock lock poisoned".to_string())?;
        map.remove(&key());
        Ok(())
    }

    pub fn clear() {
        FAIL_GET.store(false, Ordering::SeqCst);
        FAIL_SET.store(false, Ordering::SeqCst);
        if let Ok(mut map) = store().lock() {
            map.clear();
        }
    }
}

#[cfg(test)]
mod service_name_tests {
    use super::{isolated_from_env, keyring_service, mock_store, service_name, TEST_DATA_DIR_ENV};

    fn with_env<R>(value: Option<&str>, f: impl FnOnce() -> R) -> R {
        TEST_DATA_DIR_ENV.with(|c| *c.borrow_mut() = Some(value.map(String::from)));
        let result = f();
        TEST_DATA_DIR_ENV.with(|c| *c.borrow_mut() = None);
        result
    }

    #[test]
    fn isolated_runs_never_share_the_real_keyring_entry() {
        assert_eq!(service_name(false), "com.forgemetalink.app");
        assert_ne!(service_name(true), service_name(false));
        assert!(service_name(true).starts_with("com.forgemetalink.app"));
    }

    #[test]
    fn only_a_non_empty_data_dir_override_counts_as_isolated() {
        if !cfg!(debug_assertions) {
            assert!(!isolated_from_env(Some("C:/x".into())), "release builds ignore the override");
            return;
        }
        assert!(isolated_from_env(Some("C:/x".into())));
        assert!(!isolated_from_env(None));
        assert!(!isolated_from_env(Some(String::new())));
        assert!(!isolated_from_env(Some("   ".into())));
    }

    #[test]
    fn the_service_and_the_mock_store_key_both_follow_the_environment() {
        if !cfg!(debug_assertions) {
            return;
        }
        let real_service = with_env(None, keyring_service);
        let iso_service = with_env(Some("C:/isolated"), keyring_service);
        assert_eq!(real_service, "com.forgemetalink.app");
        assert_ne!(real_service, iso_service);

        // the mock (and therefore every load/persist path under test) keys off the same service
        let real_key = with_env(None, mock_store::key);
        let iso_key = with_env(Some("C:/isolated"), mock_store::key);
        assert_ne!(real_key, iso_key, "an isolated run must not read or write the real key");
        assert!(iso_key.starts_with(&iso_service));
    }
}
