// ────────────────────────── Export ──────────────────────────

#[tauri::command]
pub fn export_images(
    ids: Vec<i64>,
    format: String,
    output_path: String,
    state: tauri::State<AppState>,
) -> Result<ExportResult, String> {
    let records = state
        .db
        .get_images_by_ids(&ids)
        .map_err(|e| e.to_string())?;
    if records.is_empty() {
        return Err("No images found for the requested ids".to_string());
    }

    let mut export_records = Vec::new();
    for record in &records {
        let tags = state
            .db
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

    let content = match format.trim().to_ascii_lowercase().as_str() {
        "json" => serde_json::to_string_pretty(&export_records).map_err(|e| e.to_string())?,
        "csv" => build_csv_export(&export_records).map_err(|e| e.to_string())?,
        _ => return Err("Unsupported export format. Use 'json' or 'csv'.".to_string()),
    };

    std::fs::write(&output_path, content).map_err(|e| e.to_string())?;

    Ok(ExportResult {
        exported_count: export_records.len(),
        output_path,
    })
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
            &record.id.to_string(),
            &record.filepath,
            &record.filename,
            &record.directory,
            &record.prompt,
            &record.negative_prompt,
            record.steps.as_deref().unwrap_or(""),
            record.sampler.as_deref().unwrap_or(""),
            record.cfg_scale.as_deref().unwrap_or(""),
            record.seed.as_deref().unwrap_or(""),
            &record.width.map(|v| v.to_string()).unwrap_or_default(),
            &record.height.map(|v| v.to_string()).unwrap_or_default(),
            record.model_hash.as_deref().unwrap_or(""),
            record.model_name.as_deref().unwrap_or(""),
            &record.raw_metadata,
            &record.tags.join("|"),
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
#[tauri::command]
pub fn export_images_as_files(
    ids: Vec<i64>,
    format: String,
    quality: Option<u8>,
    output_path: String,
    state: tauri::State<AppState>,
) -> Result<FileExportResult, String> {
    use std::io::{BufWriter, Write};

    let records = state
        .db
        .get_images_by_ids(&ids)
        .map_err(|e| e.to_string())?;
    if records.is_empty() {
        return Err("No images found for the requested ids".to_string());
    }

    let fmt = format.trim().to_ascii_lowercase();
    let quality = quality.unwrap_or(85).clamp(1, 100);

    let file = std::fs::File::create(&output_path)
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

    let total_bytes = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(FileExportResult {
        exported_count: exported,
        output_path,
        total_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
