use crate::StorageProfile;
use crate::image_decode;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Thumbnails are written as JPEG with tuned quality for compact cache size.
const THUMB_EXTENSION: &str = "jpg";
/// Legacy extension kept for compatibility with older cache entries.
const LEGACY_THUMB_EXTENSION: &str = "webp";
const THUMB_SIZE: u32 = 400;
const THUMB_FILTER: FilterType = FilterType::Lanczos3;
const THUMB_JPEG_QUALITY_DEFAULT: u8 = 85;
const HDD_FRIENDLY_IO_THREADS: usize = 4;
const SSD_FRIENDLY_IO_THREADS: usize = 12;

fn io_threads(profile: StorageProfile) -> usize {
    if let Ok(raw) = std::env::var("FORGE_IO_THREADS") {
        if let Ok(parsed) = raw.parse::<usize>() {
            return parsed.max(1).min(32);
        }
    }

    let cpu_count = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4);
    match profile {
        StorageProfile::Hdd => cpu_count.min(HDD_FRIENDLY_IO_THREADS).max(2),
        StorageProfile::Ssd => cpu_count.min(SSD_FRIENDLY_IO_THREADS).max(4),
    }
}

fn io_pool(profile: StorageProfile) -> &'static rayon::ThreadPool {
    static HDD_POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    static SSD_POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();

    let pool = match profile {
        StorageProfile::Hdd => &HDD_POOL,
        StorageProfile::Ssd => &SSD_POOL,
    };

    pool.get_or_init(move || {
        let threads = io_threads(profile);
        let profile_name = profile_label(profile);
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(move |idx| format!("thumb-io-{}-{}", profile_name, idx))
            .build()
            .expect("failed to create thumbnail IO threadpool")
    })
}

fn profile_label(profile: StorageProfile) -> &'static str {
    match profile {
        StorageProfile::Hdd => "hdd",
        StorageProfile::Ssd => "ssd",
    }
}

fn thumb_jpeg_quality() -> u8 {
    static QUALITY: OnceLock<u8> = OnceLock::new();
    *QUALITY.get_or_init(|| {
        std::env::var("FORGE_THUMB_JPEG_QUALITY")
            .ok()
            .and_then(|raw| raw.parse::<u8>().ok())
            .map(|quality| quality.clamp(40, 95))
            .unwrap_or(THUMB_JPEG_QUALITY_DEFAULT)
    })
}

pub fn prepare_cache_dir(cache_dir: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    std::fs::create_dir_all(cache_dir).map_err(|e| {
        format!(
            "Failed to create thumbnail cache dir {}: {}",
            cache_dir.display(),
            e
        )
        .into()
    })
}

/// Generates thumbnails for a batch of image paths using parallel processing.
///
/// - Uses Rayon's par_iter for work-stealing parallelism across CPU cores.
/// - Skips files that already have thumbnails in the cache.
/// - Each thumbnail is named by SHA256(original_path) to avoid filename collisions.
/// - Saves as JPEG for smaller, storage-efficient thumbnails.
pub fn generate_thumbnails(
    paths: &[PathBuf],
    cache_dir: &Path,
    profile: StorageProfile,
) -> Vec<(PathBuf, PathBuf)> {
    if let Err(e) = prepare_cache_dir(cache_dir) {
        log::error!("Failed to create thumbnail cache dir: {}", e);
        return Vec::new();
    }

    io_pool(profile).install(|| {
        paths
            .par_iter()
            .filter_map(|path| match generate_single_thumbnail(path, cache_dir) {
                Ok(thumb_path) => Some((path.clone(), thumb_path)),
                Err(e) => {
                    log::warn!("Thumbnail generation failed for {}: {}", path.display(), e);
                    None
                }
            })
            .collect()
    })
}

/// Generates a single thumbnail if it doesn't already exist.
///
/// Public so callers (e.g. `get_thumbnail_path`) can generate on-demand.
pub fn ensure_thumbnail(
    source: &Path,
    cache_dir: &Path,
    _profile: StorageProfile,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    generate_single_thumbnail(source, cache_dir)
}

/// Resolves thumbnail mappings for a batch of source filepaths.
/// Existing cache hits are returned immediately; missing entries are generated in parallel.
pub fn resolve_thumbnail_paths(
    filepaths: &[String],
    cache_dir: &Path,
    profile: StorageProfile,
) -> Vec<(String, String)> {
    if let Err(e) = prepare_cache_dir(cache_dir) {
        log::error!("Thumbnail cache dir unavailable: {}", e);
        return filepaths
            .iter()
            .map(|filepath| (filepath.clone(), filepath.clone()))
            .collect();
    }

    io_pool(profile).install(|| {
        filepaths
            .par_iter()
            .map(|filepath| {
                let source = Path::new(filepath);
                let thumb = get_thumbnail_path(source, cache_dir);

                if thumb.exists() {
                    return (filepath.clone(), thumb.to_string_lossy().to_string());
                }

                match generate_single_thumbnail(source, cache_dir) {
                    Ok(generated) => (filepath.clone(), generated.to_string_lossy().to_string()),
                    Err(e) => {
                        log::warn!("On-demand thumbnail failed for {}: {}", filepath, e);
                        (filepath.clone(), filepath.clone())
                    }
                }
            })
            .collect()
    })
}

/// Generates a single thumbnail, returning the thumbnail path.
fn generate_single_thumbnail(
    source: &Path,
    cache_dir: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    let thumb_name = hash_path(source);
    let thumb_path = cache_dir.join(format!("{}.{}", thumb_name, THUMB_EXTENSION));

    // Skip if already cached
    if thumb_path.exists() {
        return Ok(thumb_path);
    }

    let legacy_path = cache_dir.join(format!("{}.{}", thumb_name, LEGACY_THUMB_EXTENSION));
    let has_legacy = legacy_path.exists();
    if !source.exists() && has_legacy {
        // Source disappeared but old cache exists; use what we have.
        return Ok(legacy_path);
    }

    // Open and resize using CatmullRom — visually identical to Lanczos3 at 300px
    // but significantly faster for large batch operations.
    let img = image_decode::open_image(source)?;
    let thumbnail = img.resize(THUMB_SIZE, THUMB_SIZE, THUMB_FILTER);

    if let Err(error) = encode_jpeg_thumbnail(&thumbnail, &thumb_path) {
        // Fall back to legacy cache if migration failed and old thumbnail exists.
        if has_legacy {
            log::warn!(
                "Failed to convert legacy thumbnail for {}: {}",
                source.display(),
                error
            );
            return Ok(legacy_path);
        }
        return Err(error);
    }

    // JPEG is now the canonical thumbnail format. Remove old WebP entries.
    if has_legacy {
        if let Err(error) = std::fs::remove_file(&legacy_path) {
            log::debug!(
                "Failed to remove legacy thumbnail {}: {}",
                legacy_path.display(),
                error
            );
        }
    }

    Ok(thumb_path)
}

fn encode_jpeg_thumbnail(
    thumbnail: &image::DynamicImage,
    out_path: &Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let rgb = thumbnail.to_rgb8();
    let file = File::create(out_path)?;
    let writer = BufWriter::with_capacity(64 * 1024, file);
    let mut encoder = JpegEncoder::new_with_quality(writer, thumb_jpeg_quality());
    encoder.encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(())
}

/// Creates a SHA256 hash of the file path for use as a cache filename.
fn hash_path(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    let result = hasher.finalize();
    hex_encode(&result[..16])
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

/// Returns the expected thumbnail path for a given source image.
///
/// Checks for current JPEG cache, otherwise returns the expected JPEG output path.
pub fn get_thumbnail_path(source: &Path, cache_dir: &Path) -> PathBuf {
    let (jpg_path, _webp_path) = get_thumbnail_candidate_paths(source, cache_dir);
    if jpg_path.exists() {
        return jpg_path;
    }

    // Return the expected JPEG path (caller should generate if needed)
    jpg_path
}

/// Returns both candidate thumbnail cache paths for a source image.
pub fn get_thumbnail_candidate_paths(source: &Path, cache_dir: &Path) -> (PathBuf, PathBuf) {
    let thumb_name = hash_path(source);
    let jpg_path = cache_dir.join(format!("{}.{}", thumb_name, THUMB_EXTENSION));
    let webp_path = cache_dir.join(format!("{}.{}", thumb_name, LEGACY_THUMB_EXTENSION));
    (jpg_path, webp_path)
}
