//! Sidecar file support — read/write per-image YAML/JSON tag files.
//!
//! Sidecar files sit next to the image on disk (e.g. `image.yaml`) and carry
//! portable metadata that travels with the file when copied or shared.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Portable metadata stored in a sidecar file next to each image.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SidecarData {
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<u8>,
}

/// Reads a sidecar file for the given image path.
///
/// Search order: `.yaml` → `.yml` → `.json`.
/// Returns `None` silently if no sidecar exists.
pub fn read_sidecar(image_path: &Path) -> Option<SidecarData> {
    for ext in &["yaml", "yml", "json"] {
        let sidecar_path = image_path.with_extension(ext);
        if sidecar_path.exists() {
            return read_sidecar_file(&sidecar_path);
        }
    }
    None
}

/// Writes sidecar data as a YAML file next to the image.
///
/// Creates `<image_stem>.yaml` in the same directory as the image.
pub fn write_sidecar(image_path: &Path, data: &SidecarData) -> Result<PathBuf, String> {
    let sidecar_path = image_path.with_extension("yaml");
    let yaml =
        serde_yaml::to_string(data).map_err(|e| format!("YAML serialization error: {}", e))?;
    std::fs::write(&sidecar_path, yaml).map_err(|e| format!("Failed to write sidecar: {}", e))?;
    Ok(sidecar_path)
}

fn read_sidecar_file(path: &Path) -> Option<SidecarData> {
    let content = std::fs::read_to_string(path).ok()?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    match ext {
        "json" => serde_json::from_str(&content).ok(),
        _ => serde_yaml::from_str(&content).ok(), // yaml/yml
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_write_and_read_sidecar_yaml() {
        let dir = std::env::temp_dir().join("forge_sidecar_test");
        fs::create_dir_all(&dir).unwrap();
        let image_path = dir.join("test_image.png");
        fs::write(&image_path, b"fake png").unwrap();

        let data = SidecarData {
            tags: vec!["landscape".into(), "cat".into()],
            notes: Some("A nice image".into()),
            rating: Some(5),
        };

        let sidecar_path = write_sidecar(&image_path, &data).unwrap();
        assert!(sidecar_path.exists());
        assert_eq!(sidecar_path.extension().unwrap(), "yaml");

        let read_back = read_sidecar(&image_path).expect("should read sidecar");
        assert_eq!(read_back.tags, vec!["landscape", "cat"]);
        assert_eq!(read_back.notes.as_deref(), Some("A nice image"));
        assert_eq!(read_back.rating, Some(5));

        // Cleanup
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_read_sidecar_json_fallback() {
        let dir = std::env::temp_dir().join("forge_sidecar_json_test");
        fs::create_dir_all(&dir).unwrap();
        let image_path = dir.join("test_image.png");
        fs::write(&image_path, b"fake png").unwrap();

        let json_path = image_path.with_extension("json");
        fs::write(
            &json_path,
            r#"{"tags":["hello","world"],"notes":"test note"}"#,
        )
        .unwrap();

        let read_back = read_sidecar(&image_path).expect("should read JSON sidecar");
        assert_eq!(read_back.tags, vec!["hello", "world"]);
        assert_eq!(read_back.notes.as_deref(), Some("test note"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_read_sidecar_returns_none_when_missing() {
        let dir = std::env::temp_dir().join("forge_sidecar_none_test");
        fs::create_dir_all(&dir).unwrap();
        let image_path = dir.join("no_sidecar.png");
        fs::write(&image_path, b"fake png").unwrap();

        assert!(read_sidecar(&image_path).is_none());

        fs::remove_dir_all(&dir).ok();
    }
}
