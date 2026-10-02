// ────────────────────────── Export ──────────────────────────

pub fn export_images_sync(
    ids: Vec<i64>,
    format: String,
    output_path: String,
    db: &crate::database::Database,
) -> Result<ExportResult, String> {
    let out = Path::new(&output_path);
    if !out.is_absolute() {
        return Err("Output path must be an absolute path".to_string());
    }

    let fmt_clean = format.trim().to_ascii_lowercase();
    match fmt_clean.as_str() {
        "json" => {
            if !output_path.to_ascii_lowercase().ends_with(".json") {
                return Err("Output path must end with .json for JSON export".to_string());
            }
        }
        "csv" => {
            if !output_path.to_ascii_lowercase().ends_with(".csv") {
                return Err("Output path must end with .csv for CSV export".to_string());
            }
        }
        _ => return Err("Unsupported export format. Use 'json' or 'csv'.".to_string()),
    }

    if let Ok(meta) = std::fs::symlink_metadata(out) {
        if !meta.is_file() {
            return Err("Output path exists and is not a regular file".to_string());
        }
    }

    let records = db
        .get_images_by_ids(&ids)
        .map_err(|e| e.to_string())?;
    if records.is_empty() {
        return Err("No images found for the requested ids".to_string());
    }

    let mut export_records = Vec::new();
    for record in &records {
        let tags = db
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

    let content = match fmt_clean.as_str() {
        "json" => serde_json::to_string_pretty(&export_records).map_err(|e| e.to_string())?,
        "csv" => build_csv_export(&export_records).map_err(|e| e.to_string())?,
        _ => unreachable!(),
    };

    std::fs::write(&output_path, content).map_err(|e| e.to_string())?;

    Ok(ExportResult {
        exported_count: export_records.len(),
        output_path,
    })
}

#[tauri::command]
pub async fn export_images(
    ids: Vec<i64>,
    format: String,
    output_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<ExportResult, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        export_images_sync(ids, format, output_path, &db)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sanitize_csv_field(field: &str) -> String {
    let trimmed = field.trim_start_matches(' ');
    if trimmed.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{}", field)
    } else {
        field.to_string()
    }
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
            sanitize_csv_field(&record.id.to_string()),
            sanitize_csv_field(&record.filepath),
            sanitize_csv_field(&record.filename),
            sanitize_csv_field(&record.directory),
            sanitize_csv_field(&record.prompt),
            sanitize_csv_field(&record.negative_prompt),
            sanitize_csv_field(record.steps.as_deref().unwrap_or("")),
            sanitize_csv_field(record.sampler.as_deref().unwrap_or("")),
            sanitize_csv_field(record.cfg_scale.as_deref().unwrap_or("")),
            sanitize_csv_field(record.seed.as_deref().unwrap_or("")),
            sanitize_csv_field(&record.width.map(|v| v.to_string()).unwrap_or_default()),
            sanitize_csv_field(&record.height.map(|v| v.to_string()).unwrap_or_default()),
            sanitize_csv_field(record.model_hash.as_deref().unwrap_or("")),
            sanitize_csv_field(record.model_name.as_deref().unwrap_or("")),
            sanitize_csv_field(&record.raw_metadata),
            sanitize_csv_field(&record.tags.join("|")),
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

fn encode_dynamic_image_as_webp(image: &image::DynamicImage, quality: u8) -> Vec<u8> {
    if image.color().has_alpha() {
        let rgba = image.to_rgba8();
        return webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height())
            .encode(quality as f32)
            .to_vec();
    }

    let rgb = image.to_rgb8();
    webp::Encoder::from_rgb(rgb.as_raw(), rgb.width(), rgb.height())
        .encode(quality as f32)
        .to_vec()
}

fn encode_image_as_webp(source: &Path, quality: u8) -> Result<Vec<u8>, String> {
    let image = image_decode::open_image(source)
        .map_err(|error| format!("Failed to open {}: {}", source.display(), error))?;
    Ok(encode_dynamic_image_as_webp(&image, quality))
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
/// - `"webp"` -- converts each image to lossy WebP at the given `quality` (1-100)
/// - `"jxl"` -- converts each image to JPEG XL (lossless)
pub fn export_images_as_files_sync(
    ids: Vec<i64>,
    format: String,
    quality: Option<u8>,
    output_path: String,
    db: &crate::database::Database,
) -> Result<FileExportResult, String> {
    use std::io::{BufWriter, Write};

    let out = Path::new(&output_path);
    if !out.is_absolute() {
        return Err("Output path must be an absolute path".to_string());
    }
    if !output_path.to_ascii_lowercase().ends_with(".zip") {
        return Err("Output path must end with .zip for ZIP export".to_string());
    }
    if let Ok(meta) = std::fs::symlink_metadata(out) {
        if !meta.is_file() {
            return Err("Output path exists and is not a regular file".to_string());
        }
    }

    let records = db
        .get_images_by_ids(&ids)
        .map_err(|e| e.to_string())?;
    if records.is_empty() {
        return Err("No images found for the requested ids".to_string());
    }

    let fmt = format.trim().to_ascii_lowercase();
    match fmt.as_str() {
        "original" | "png" | "jpeg" | "jpg" | "webp" | "jxl" => {}
        _ => {
            return Err(format!(
                "Unsupported format '{}'. Use 'original', 'png', 'jpeg', 'webp', or 'jxl'.",
                fmt
            ));
        }
    }
    let quality = quality.unwrap_or(85).clamp(1, 100);

    let partial_path = format!("{}.partial", output_path);
    let export_process = || -> Result<usize, String> {
        let file = std::fs::File::create(&partial_path)
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
                    let buf = encode_image_as_webp(source, quality)?;
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
        drop(inner);
        Ok(exported)
    };

    let exported = match export_process() {
        Ok(count) => count,
        Err(err) => {
            let _ = std::fs::remove_file(&partial_path);
            return Err(err);
        }
    };

    if let Err(err) = std::fs::rename(&partial_path, &output_path) {
        let _ = std::fs::remove_file(&partial_path);
        return Err(format!("Failed to finalize export file: {}", err));
    }

    let total_bytes = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(FileExportResult {
        exported_count: exported,
        output_path,
        total_bytes,
    })
}

#[tauri::command]
pub async fn export_images_as_files(
    ids: Vec<i64>,
    format: String,
    quality: Option<u8>,
    output_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<FileExportResult, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        export_images_as_files_sync(ids, format, quality, output_path, &db)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn csv_injection_leading_formula_cells_are_escaped_with_single_quote() {
        let records = vec![ExportImage {
            id: 1,
            filepath: "C:/images/test.png".to_string(),
            filename: "test.png".to_string(),
            directory: "C:/images".to_string(),
            prompt: "=2+2; cmd|' /C calc'!A0".to_string(),
            negative_prompt: "@malicious".to_string(),
            steps: Some("+20".to_string()),
            sampler: Some("-Euler".to_string()),
            cfg_scale: None,
            seed: None,
            width: Some(1024),
            height: Some(1024),
            model_hash: None,
            model_name: Some("=HYPERLINK(\"http://evil\",\"click\")".to_string()),
            raw_metadata: "=cmd".to_string(),
            tags: vec!["=injection".to_string()],
        }];
        let csv = build_csv_export(&records).expect("csv build failed");
        assert!(
            csv.contains("'=2+2"),
            "CSV prompt not escaped, got: {}",
            csv
        );
        assert!(
            csv.contains("'@malicious"),
            "CSV negative_prompt not escaped, got: {}",
            csv
        );
        assert!(
            csv.contains("'+20"),
            "CSV steps not escaped, got: {}",
            csv
        );
        assert!(
            csv.contains("'-Euler"),
            "CSV sampler not escaped, got: {}",
            csv
        );
        assert!(
            csv.contains("'=HYPERLINK"),
            "CSV model_name not escaped, got: {}",
            csv
        );
        assert!(
            csv.contains("'=cmd"),
            "CSV raw_metadata not escaped, got: {}",
            csv
        );
        assert!(
            csv.contains("'=injection") || csv.contains("'=injection"),
            "CSV tags not escaped, got: {}",
            csv
        );
    }

    #[test]
    fn lossy_webp_quality_produces_smaller_output_than_lossless() {
        let width = 320u32;
        let height = 240u32;
        let mut rgb = image::RgbImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let mut hash =
                    ((x as u64) << 32) ^ (y as u64) ^ ((x as u64).wrapping_mul(y as u64));
                hash ^= hash >> 33;
                hash = hash.wrapping_mul(0xff51afd7ed558ccd);
                hash ^= hash >> 33;
                hash = hash.wrapping_mul(0xc4ceb9fe1a85ec53);
                hash ^= hash >> 33;

                let red = (hash & 0xFF) as u8;
                let green = ((hash >> 8) & 0xFF) as u8;
                let blue = ((hash >> 16) & 0xFF) as u8;
                rgb.put_pixel(x, y, image::Rgb([red, green, blue]));
            }
        }

        let image = image::DynamicImage::ImageRgb8(rgb.clone());
        let lossy = encode_dynamic_image_as_webp(&image, 80);
        let lossless = webp::Encoder::from_rgb(rgb.as_raw(), width, height)
            .encode_lossless()
            .to_vec();

        assert!(
            lossy.len() < lossless.len(),
            "Expected lossy WebP ({}) to be smaller than lossless ({})",
            lossy.len(),
            lossless.len()
        );
    }

    #[test]
    fn test_failed_export_leaves_no_file_at_target_path() {
        let temp_dir = std::env::temp_dir().join(format!(
            "fml_export_fail_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let db_path = temp_dir.join("test.db");
        let db = crate::database::Database::new(&db_path, crate::StorageProfile::Hdd).unwrap();

        let img_file = temp_dir.join("corrupt.png");
        std::fs::write(&img_file, b"not a real image payload").unwrap();

        let conn = db.pool_get_for_test().unwrap();
        conn.execute(
            "INSERT INTO images(filepath, filename, directory, prompt, quick_hash, file_mtime)
             VALUES (?1, 'corrupt.png', ?2, 'p', NULL, 100)",
            rusqlite::params![img_file.to_str().unwrap(), temp_dir.to_str().unwrap()],
        )
        .unwrap();
        let id = conn.last_insert_rowid();

        let output_zip = temp_dir.join("output.zip");
        let partial_zip = temp_dir.join("output.zip.partial");

        // 1. Invalid format upfront
        let res_invalid = export_images_as_files_sync(
            vec![id],
            "invalid_format_xyz".to_string(),
            None,
            output_zip.to_str().unwrap().to_string(),
            &db,
        );
        assert!(res_invalid.is_err(), "export with invalid format should fail");
        assert!(!output_zip.exists(), "target output zip must not exist after error");
        assert!(!partial_zip.exists(), "partial zip must not exist after error");

        // 2. Failure during processing (corrupted image) cleans up partial zip
        let res_corrupt = export_images_as_files_sync(
            vec![id],
            "png".to_string(),
            None,
            output_zip.to_str().unwrap().to_string(),
            &db,
        );
        assert!(res_corrupt.is_err(), "export with corrupt image should fail");
        assert!(!output_zip.exists(), "target output zip must not exist after error");
        assert!(!partial_zip.exists(), "partial zip must be cleaned up on error");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_export_output_path_validation() {
        let temp_dir = std::env::temp_dir().join(format!(
            "fml_export_val_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let db_path = temp_dir.join("test.db");
        let db = crate::database::Database::new(&db_path, crate::StorageProfile::Hdd).unwrap();

        let conn = db.pool_get_for_test().unwrap();
        conn.execute(
            "INSERT INTO images(filepath, filename, directory, prompt, quick_hash, file_mtime)
             VALUES ('/a.png', 'a.png', '/', 'p', NULL, 100)",
            rusqlite::params![],
        )
        .unwrap();
        let id = conn.last_insert_rowid();

        // 1. Relative path rejected
        let res_rel = export_images_sync(vec![id], "json".to_string(), "relative.json".to_string(), &db);
        assert!(res_rel.is_err());
        assert!(res_rel.unwrap_err().contains("absolute path"));

        let res_rel_zip = export_images_as_files_sync(vec![id], "original".to_string(), None, "relative.zip".to_string(), &db);
        assert!(res_rel_zip.is_err());
        assert!(res_rel_zip.unwrap_err().contains("absolute path"));

        // 2. Extension mismatch rejected
        let bad_ext_json = temp_dir.join("export.txt");
        let res_ext = export_images_sync(vec![id], "json".to_string(), bad_ext_json.to_str().unwrap().to_string(), &db);
        assert!(res_ext.is_err());
        assert!(res_ext.unwrap_err().contains(".json"));

        let bad_ext_zip = temp_dir.join("export.tar");
        let res_zip_ext = export_images_as_files_sync(vec![id], "original".to_string(), None, bad_ext_zip.to_str().unwrap().to_string(), &db);
        assert!(res_zip_ext.is_err());
        assert!(res_zip_ext.unwrap_err().contains(".zip"));

        // 3. Existing directory target rejected
        let dir_target = temp_dir.join("target_dir.json");
        std::fs::create_dir_all(&dir_target).unwrap();
        let res_dir_target = export_images_sync(vec![id], "json".to_string(), dir_target.to_str().unwrap().to_string(), &db);
        assert!(res_dir_target.is_err());
        assert!(res_dir_target.unwrap_err().contains("not a regular file"));

        let dir_zip_target = temp_dir.join("target_dir.zip");
        std::fs::create_dir_all(&dir_zip_target).unwrap();
        let res_zip_dir = export_images_as_files_sync(vec![id], "original".to_string(), None, dir_zip_target.to_str().unwrap().to_string(), &db);
        assert!(res_zip_dir.is_err());
        assert!(res_zip_dir.unwrap_err().contains("not a regular file"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_sanitize_csv_field_formula_and_control_chars() {
        assert_eq!(sanitize_csv_field("=cmd"), "'=cmd");
        assert_eq!(sanitize_csv_field("+cmd"), "'+cmd");
        assert_eq!(sanitize_csv_field("-cmd"), "'-cmd");
        assert_eq!(sanitize_csv_field("@cmd"), "'@cmd");
        assert_eq!(sanitize_csv_field("\tcmd"), "'\tcmd");
        assert_eq!(sanitize_csv_field("\rcmd"), "'\rcmd");
        assert_eq!(sanitize_csv_field("   \tcmd"), "'   \tcmd");
        assert_eq!(sanitize_csv_field("   \rcmd"), "'   \rcmd");
        assert_eq!(sanitize_csv_field("normal text"), "normal text");
        assert_eq!(sanitize_csv_field("123"), "123");
        assert_eq!(sanitize_csv_field(""), "");
    }
}
