use std::path::Path;

const SERVICE: &str = "com.forgemetalink.app";
const ACCOUNT: &str = "forge-api-key";

#[cfg(not(test))]
fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keyring entry error: {}", e))
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

    fn key() -> String {
        format!("{}:{}", super::SERVICE, super::ACCOUNT)
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
