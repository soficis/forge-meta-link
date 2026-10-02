// ────────────────────────── Shell / OS ──────────────────────────

#[tauri::command]
pub fn directory_exists(path: String) -> bool {
    let normalized = path.trim();
    if normalized.is_empty() {
        return false;
    }
    let directory = Path::new(normalized);
    if !directory.exists() {
        return false;
    }
    let canonical = match directory.canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };
    canonical.is_dir()
}

#[cfg(test)]
mod shell_tests {
    use super::directory_exists;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn walkdir_jail_directory_exists_rejects_broken_symlink() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let pid = std::process::id();
        let root = std::env::temp_dir().join(format!("fml_dir_exists_{}_{}", pid, nanos));
        let _ = fs::create_dir_all(&root);
        let missing_target = root.join("nonexistent_target_dir");
        let link_path = root.join("broken_link");
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let _ = symlink(&missing_target, &link_path);
        }
        #[cfg(windows)]
        {
            let _ = std::os::windows::fs::symlink_dir(&missing_target, &link_path);
        }
        let result = directory_exists(link_path.to_string_lossy().to_string());
        let _ = fs::remove_dir_all(&root);
        assert!(!result, "broken symlink must not be considered existing directory");
    }
}

/// Opens the native file explorer with the given file selected.
#[tauri::command]
pub async fn open_file_location(
    filepath: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if !is_allowed_path(&filepath, &state.db, &state.cache_dir) {
        return Err(format!("Access denied: path is not indexed or in cache: {}", filepath));
    }

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
