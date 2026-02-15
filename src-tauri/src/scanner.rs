use byteorder::{BigEndian, ReadBytesExt};
use flate2::read::ZlibDecoder;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// PNG file signature (first 8 bytes of any valid PNG)
const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_READER_CAPACITY: usize = 128 * 1024;
const QUICK_HASH_SAMPLE_BYTES: usize = 64 * 1024;
const PRIMARY_METADATA_KEYS: &[&str] = &[
    "parameters",
    "Parameters",
    "prompt",
    "Prompt",
    "Description",
    "description",
    "Comment",
    "comment",
    "workflow",
    "Workflow",
    "invokeai_metadata",
    "invokeai_metadata_v2",
];

#[derive(Debug, Clone)]
pub struct ScannedFile {
    pub path: PathBuf,
    pub file_mtime: Option<i64>,
    pub file_size: Option<i64>,
}

/// Extracts all PNG text chunks as key/value pairs.
///
/// This is a zero-copy approach: we never decode pixel data (IDAT chunks).
/// We only read chunk headers and text metadata, keeping memory usage minimal.
pub fn extract_text_chunks(
    path: &Path,
) -> Result<HashMap<String, String>, Box<dyn std::error::Error>> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(PNG_READER_CAPACITY, file);
    let mut text_chunks = HashMap::new();

    // Verify PNG signature
    let mut sig = [0u8; 8];
    reader.read_exact(&mut sig)?;
    if sig != PNG_SIGNATURE {
        return Err(format!("Not a valid PNG file: {}", path.display()).into());
    }

    loop {
        // Read chunk length (4 bytes, big-endian)
        let length = match reader.read_u32::<BigEndian>() {
            Ok(len) => len,
            Err(_) => break, // EOF
        };

        // Read chunk type (4 bytes)
        let mut chunk_type = [0u8; 4];
        if reader.read_exact(&mut chunk_type).is_err() {
            break;
        }

        match &chunk_type {
            b"tEXt" | b"zTXt" | b"iTXt" => {
                let mut data = vec![0u8; length as usize];
                reader.read_exact(&mut data)?;
                reader.seek(SeekFrom::Current(4))?; // Skip CRC

                let maybe_pair = match &chunk_type {
                    b"tEXt" => parse_text_chunk_pair(&data),
                    b"zTXt" => parse_ztxt_chunk_pair(&data),
                    b"iTXt" => parse_itxt_chunk_pair(&data),
                    _ => None,
                };

                if let Some((key, value)) = maybe_pair {
                    text_chunks.insert(key, value);
                }
            }
            b"IEND" => {
                break; // End of PNG
            }
            _ => {
                // Skip chunk data + CRC (4 bytes)
                reader.seek(SeekFrom::Current(length as i64 + 4))?;
            }
        }
    }

    Ok(text_chunks)
}

/// Extracts the best available metadata payload from PNG text chunks.
pub fn extract_metadata(path: &Path) -> Result<Option<String>, Box<dyn std::error::Error>> {
    if !supports_png_metadata(path) {
        return Ok(None);
    }
    let chunks = extract_text_chunks(path)?;
    Ok(select_primary_metadata(&chunks))
}

fn supports_png_metadata(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("png"))
        .unwrap_or(false)
}

fn select_primary_metadata(chunks: &HashMap<String, String>) -> Option<String> {
    if let Some(novelai) = build_novelai_metadata(chunks) {
        return Some(novelai);
    }

    for key in PRIMARY_METADATA_KEYS {
        if let Some(value) = chunks.get(*key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    // Deterministic fallback: pick the largest non-empty text payload.
    chunks
        .values()
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .max_by_key(|value| value.len())
        .map(str::to_string)
}

fn build_novelai_metadata(chunks: &HashMap<String, String>) -> Option<String> {
    let software = chunks
        .get("Software")
        .map(String::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if software != "novelai" {
        return None;
    }

    let description = chunks
        .get("Description")
        .or_else(|| chunks.get("description"))
        .map(String::as_str)
        .unwrap_or_default()
        .trim();
    let comment = chunks
        .get("Comment")
        .or_else(|| chunks.get("comment"))
        .map(String::as_str)
        .unwrap_or_default()
        .trim();

    if description.is_empty() && comment.is_empty() {
        return None;
    }

    let mut lines = Vec::new();
    if !description.is_empty() {
        lines.push(description.to_string());
    }

    if let Ok(comment_json) = serde_json::from_str::<Value>(comment) {
        if let Some(negative) = comment_json
            .get("uc")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("Negative prompt: {}", negative));
        }

        let mut params = Vec::new();
        append_comment_param(&mut params, "Steps", comment_json.get("steps"));
        append_comment_param(&mut params, "Sampler", comment_json.get("sampler"));
        append_comment_param(&mut params, "CFG scale", comment_json.get("scale"));
        append_comment_param(&mut params, "Seed", comment_json.get("seed"));

        let width = comment_json.get("width").and_then(Value::as_u64);
        let height = comment_json.get("height").and_then(Value::as_u64);
        if let (Some(width), Some(height)) = (width, height) {
            params.push(format!("Size: {}x{}", width, height));
        }

        if !params.is_empty() {
            lines.push(params.join(", "));
        }
    }

    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

fn append_comment_param(params: &mut Vec<String>, key: &str, value: Option<&Value>) {
    let Some(value) = value else {
        return;
    };

    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                params.push(format!("{}: {}", key, trimmed));
            }
        }
        Value::Number(number) => params.push(format!("{}: {}", key, number)),
        Value::Bool(boolean) => params.push(format!("{}: {}", key, boolean)),
        _ => {}
    }
}

fn parse_text_chunk_pair(data: &[u8]) -> Option<(String, String)> {
    let null_pos = data.iter().position(|&b| b == 0)?;
    let keyword = String::from_utf8(data[..null_pos].to_vec()).ok()?;
    let value = String::from_utf8(data[null_pos + 1..].to_vec()).ok()?;
    Some((keyword, value))
}

fn parse_ztxt_chunk_pair(data: &[u8]) -> Option<(String, String)> {
    let null_pos = data.iter().position(|&b| b == 0)?;
    let keyword = String::from_utf8(data[..null_pos].to_vec()).ok()?;

    let mut cursor = null_pos + 1;
    if cursor >= data.len() {
        return None;
    }

    let compression_method = data[cursor];
    cursor += 1;
    if compression_method != 0 {
        return None;
    }

    // Some tools include an extra separator byte before payload; tolerate it.
    if cursor < data.len() && data[cursor] == 0 {
        cursor += 1;
    }

    let value = decompress_zlib_to_string(&data[cursor..])?;
    Some((keyword, value))
}

fn parse_itxt_chunk_pair(data: &[u8]) -> Option<(String, String)> {
    let null_pos = data.iter().position(|&b| b == 0)?;
    let keyword = String::from_utf8(data[..null_pos].to_vec()).ok()?;

    let rest = &data[null_pos + 1..];
    if rest.len() < 2 {
        return None;
    }

    let compression_flag = rest[0];
    let compression_method = rest[1];
    if compression_flag != 0 && compression_flag != 1 {
        return None;
    }

    let after_compression = &rest[2..];
    let lang_end = after_compression.iter().position(|&b| b == 0)?;
    let after_lang = &after_compression[lang_end + 1..];
    let translated_end = after_lang.iter().position(|&b| b == 0)?;
    let text = &after_lang[translated_end + 1..];

    if compression_flag == 1 {
        if compression_method != 0 {
            return None;
        }
        let value = decompress_zlib_to_string(text)?;
        return Some((keyword, value));
    }

    let value = String::from_utf8(text.to_vec()).ok()?;
    Some((keyword, value))
}

fn decompress_zlib_to_string(data: &[u8]) -> Option<String> {
    let mut decoder = ZlibDecoder::new(data);
    let mut output = String::new();
    decoder.read_to_string(&mut output).ok()?;
    Some(output)
}

/// Supported image extensions for scanning.
const SUPPORTED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "avif", "gif", "jxl"];

/// Recursively scans a directory for supported image files and returns their paths.
pub fn scan_directory(dir: &Path) -> Vec<ScannedFile> {
    let mut paths = Vec::new();
    for entry in walkdir::WalkDir::new(dir)
        .follow_links(false)
        .max_open(32)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        if let Some(ext) = path.extension() {
            let ext_lower = ext.to_string_lossy().to_ascii_lowercase();
            if SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str()) {
                let metadata = entry.metadata().ok();
                let file_mtime = metadata
                    .as_ref()
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs() as i64);
                let file_size = metadata.as_ref().map(|metadata| metadata.len() as i64);
                paths.push(ScannedFile {
                    path: path.to_path_buf(),
                    file_mtime,
                    file_size,
                });
            }
        }
    }
    paths
}

/// Computes a fast, HDD-friendly content fingerprint from sampled bytes.
///
/// Uses sampled SHA-256 over:
/// - file size
/// - first 64 KiB
/// - last 64 KiB
///
/// This is significantly cheaper than hashing the entire file and is good enough
/// for duplicate-candidate grouping and organization heuristics.
pub fn compute_quick_hash(path: &Path, file_size_hint: Option<i64>) -> Option<String> {
    let file = File::open(path).ok()?;
    let file_size = file_size_hint
        .filter(|value| *value > 0)
        .or_else(|| file.metadata().ok().map(|meta| meta.len() as i64))?;
    if file_size <= 0 {
        return None;
    }

    let size_u64 = file_size as u64;
    let sample_len = usize::try_from(size_u64.min(QUICK_HASH_SAMPLE_BYTES as u64)).ok()?;
    if sample_len == 0 {
        return None;
    }

    let mut reader = BufReader::with_capacity(PNG_READER_CAPACITY, file);
    let mut hasher = Sha256::new();
    hasher.update(&size_u64.to_le_bytes());

    let mut head = vec![0u8; sample_len];
    reader.read_exact(&mut head).ok()?;
    hasher.update(&head);

    if size_u64 > QUICK_HASH_SAMPLE_BYTES as u64 {
        let tail_start = size_u64.saturating_sub(sample_len as u64);
        reader.seek(SeekFrom::Start(tail_start)).ok()?;
        let mut tail = vec![0u8; sample_len];
        reader.read_exact(&mut tail).ok()?;
        hasher.update(&tail);
    }

    let mut hex = hex_encode(&hasher.finalize()[..]);
    hex.truncate(24);
    Some(hex)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn build_chunk(chunk_type: [u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(&chunk_type);
        out.extend_from_slice(data);
        out.extend_from_slice(&0u32.to_be_bytes()); // CRC ignored by parser
        out
    }

    fn build_test_png(text_chunks: Vec<([u8; 4], Vec<u8>)>) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();

        // Minimal IHDR for 1x1 RGB image
        let ihdr_data = [
            0, 0, 0, 1, // width
            0, 0, 0, 1, // height
            8, // bit depth
            2, // color type (RGB)
            0, // compression method
            0, // filter method
            0, // interlace method
        ];
        bytes.extend_from_slice(&build_chunk(*b"IHDR", &ihdr_data));

        for (chunk_type, chunk_data) in text_chunks {
            bytes.extend_from_slice(&build_chunk(chunk_type, &chunk_data));
        }

        bytes.extend_from_slice(&build_chunk(*b"IEND", &[]));
        bytes
    }

    fn write_temp_png(bytes: &[u8]) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "forge_meta_link_scanner_test_{}_{}.png",
            std::process::id(),
            timestamp
        ));
        fs::write(&path, bytes).expect("failed to write temp png");
        path
    }

    #[test]
    fn test_extract_metadata_returns_none_for_non_png() {
        let path = Path::new("Cargo.toml");
        let result = extract_metadata(path).expect("metadata extraction failed");
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_text_chunks_returns_all_supported_chunk_types() {
        let mut text_data = b"parameters\0".to_vec();
        text_data.extend_from_slice(b"from text");

        let mut ztxt_data = b"comment\0".to_vec();
        ztxt_data.push(0);
        let mut z_encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        z_encoder
            .write_all(b"from ztxt")
            .expect("failed to write ztxt payload");
        ztxt_data.extend_from_slice(&z_encoder.finish().expect("failed to finish ztxt payload"));

        let mut itxt_data = b"description\0".to_vec();
        itxt_data.push(1);
        itxt_data.push(0);
        itxt_data.push(0);
        itxt_data.push(0);
        let mut i_encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        i_encoder
            .write_all(b"from itxt")
            .expect("failed to write itxt payload");
        itxt_data.extend_from_slice(&i_encoder.finish().expect("failed to finish itxt payload"));

        let png_bytes = build_test_png(vec![
            (*b"tEXt", text_data),
            (*b"zTXt", ztxt_data),
            (*b"iTXt", itxt_data),
        ]);
        let path = write_temp_png(&png_bytes);

        let result = extract_text_chunks(&path).expect("chunk extraction failed");
        assert_eq!(
            result.get("parameters").map(String::as_str),
            Some("from text")
        );
        assert_eq!(result.get("comment").map(String::as_str), Some("from ztxt"));
        assert_eq!(
            result.get("description").map(String::as_str),
            Some("from itxt")
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_extracts_parameters_from_text_chunk() {
        let metadata = "Steps: 20, Sampler: Euler";
        let mut text_data = b"parameters\0".to_vec();
        text_data.extend_from_slice(metadata.as_bytes());

        let png_bytes = build_test_png(vec![(*b"tEXt", text_data)]);
        let path = write_temp_png(&png_bytes);

        let result = extract_metadata(&path).expect("metadata extraction failed");
        assert_eq!(result.as_deref(), Some(metadata));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_extracts_parameters_from_ztxt_chunk() {
        let metadata = "Steps: 30, Sampler: DPM++ 2M Karras";
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(metadata.as_bytes())
            .expect("failed to write zlib payload");
        let compressed = encoder.finish().expect("failed to finish zlib payload");

        let mut ztxt_data = b"parameters\0".to_vec();
        ztxt_data.push(0); // zlib compression method
        ztxt_data.extend_from_slice(&compressed);

        let png_bytes = build_test_png(vec![(*b"zTXt", ztxt_data)]);
        let path = write_temp_png(&png_bytes);

        let result = extract_metadata(&path).expect("metadata extraction failed");
        assert_eq!(result.as_deref(), Some(metadata));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_extracts_parameters_from_compressed_itxt_chunk() {
        let metadata = "Steps: 25, Sampler: Euler a, CFG scale: 6.5";
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(metadata.as_bytes())
            .expect("failed to write zlib payload");
        let compressed = encoder.finish().expect("failed to finish zlib payload");

        let mut itxt_data = b"parameters\0".to_vec();
        itxt_data.push(1); // compression flag
        itxt_data.push(0); // zlib compression method
        itxt_data.push(0); // empty language tag terminator
        itxt_data.push(0); // empty translated keyword terminator
        itxt_data.extend_from_slice(&compressed);

        let png_bytes = build_test_png(vec![(*b"iTXt", itxt_data)]);
        let path = write_temp_png(&png_bytes);

        let result = extract_metadata(&path).expect("metadata extraction failed");
        assert_eq!(result.as_deref(), Some(metadata));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_extracts_prompt_metadata_when_parameters_is_missing() {
        let prompt_graph =
            r#"{"3":{"class_type":"CLIPTextEncode","inputs":{"text":"trump at a rally"}}}"#;
        let mut text_data = b"prompt\0".to_vec();
        text_data.extend_from_slice(prompt_graph.as_bytes());

        let png_bytes = build_test_png(vec![(*b"tEXt", text_data)]);
        let path = write_temp_png(&png_bytes);

        let result = extract_metadata(&path).expect("metadata extraction failed");
        assert_eq!(result.as_deref(), Some(prompt_graph));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_extracts_novelai_compatible_metadata_summary() {
        let mut software = b"Software\0".to_vec();
        software.extend_from_slice(b"NovelAI");

        let mut description = b"Description\0".to_vec();
        description.extend_from_slice(b"cinematic portrait of a hero");

        let mut comment = b"Comment\0".to_vec();
        comment.extend_from_slice(
            br#"{"uc":"low quality, blurry","steps":28,"sampler":"k_euler","scale":6.5,"seed":1234,"width":1024,"height":1024}"#,
        );

        let png_bytes = build_test_png(vec![
            (*b"tEXt", software),
            (*b"tEXt", description),
            (*b"tEXt", comment),
        ]);
        let path = write_temp_png(&png_bytes);

        let result = extract_metadata(&path).expect("metadata extraction failed");
        let extracted = result.expect("expected metadata");
        assert!(extracted.contains("cinematic portrait of a hero"));
        assert!(extracted.contains("Negative prompt: low quality, blurry"));
        assert!(extracted.contains("Steps: 28"));
        assert!(extracted.contains("Sampler: k_euler"));
        assert!(extracted.contains("Size: 1024x1024"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_quick_hash_is_stable_for_same_file() {
        let bytes = build_test_png(vec![]);
        let path = write_temp_png(&bytes);

        let hash_a = compute_quick_hash(&path, None).expect("expected quick hash");
        let hash_b = compute_quick_hash(&path, None).expect("expected quick hash");
        assert_eq!(hash_a, hash_b);

        let _ = fs::remove_file(path);
    }
}
