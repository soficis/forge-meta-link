// ────────────────────────── Shell / OS ──────────────────────────

#[tauri::command]
pub fn directory_exists(path: String) -> bool {
    let normalized = path.trim();
    if normalized.is_empty() {
        return false;
    }
    let directory = Path::new(normalized);
    directory.exists() && directory.is_dir()
}

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
