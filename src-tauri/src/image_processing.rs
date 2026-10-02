use crate::image_decode;
use crate::StorageProfile;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const THUMB_EXTENSION: &str = "jpg";
const THUMB_SIZE_HDD: u32 = 480;
const THUMB_SIZE_SSD: u32 = 640;
const THUMB_FILTER: FilterType = FilterType::Lanczos3;
const THUMB_JPEG_QUALITY_HDD: u8 = 82;
const THUMB_JPEG_QUALITY_SSD: u8 = 90;
const THUMB_CACHE_VERSION: &str = "thumb-v2-hq";
const HDD_FRIENDLY_IO_THREADS: usize = 4;
const SSD_FRIENDLY_IO_THREADS: usize = 12;

fn io_threads(profile: StorageProfile) -> usize {
    if let Ok(raw) = std::env::var("FORGE_IO_THREADS") {
        if let Ok(parsed) = raw.parse::<usize>() {
            return parsed.clamp(1, 32);
        }
    }

    let cpu_count = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4);
    match profile {
        StorageProfile::Hdd => cpu_count.clamp(2, HDD_FRIENDLY_IO_THREADS),
        StorageProfile::Ssd => cpu_count.clamp(4, SSD_FRIENDLY_IO_THREADS),
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

fn thumb_size(profile: StorageProfile) -> u32 {
    match profile {
        StorageProfile::Hdd => THUMB_SIZE_HDD,
        StorageProfile::Ssd => THUMB_SIZE_SSD,
    }
}

fn thumb_jpeg_quality(profile: StorageProfile) -> u8 {
    if let Ok(raw) = std::env::var("FORGE_THUMB_JPEG_QUALITY") {
        if let Ok(parsed) = raw.parse::<u8>() {
            return parsed.clamp(40, 95);
        }
    }
    match profile {
        StorageProfile::Hdd => THUMB_JPEG_QUALITY_HDD,
        StorageProfile::Ssd => THUMB_JPEG_QUALITY_SSD,
    }
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

pub fn generate_thumbnails(
    paths: &[PathBuf],
    cache_dir: &Path,
    profile: StorageProfile,
) -> Vec<(PathBuf, PathBuf)> {
    generate_thumbnails_ext(paths, cache_dir, profile, false)
}

pub fn generate_thumbnails_ext(
    paths: &[PathBuf],
    cache_dir: &Path,
    profile: StorageProfile,
    force: bool,
) -> Vec<(PathBuf, PathBuf)> {
    if let Err(e) = prepare_cache_dir(cache_dir) {
        log::error!("Failed to create thumbnail cache dir: {}", e);
        return Vec::new();
    }

    io_pool(profile).install(|| {
        paths
            .par_iter()
            .filter_map(|path| {
                match generate_single_thumbnail_impl(path, cache_dir, profile, force) {
                    Ok(thumb_path) => Some((path.clone(), thumb_path)),
                    Err(e) => {
                        log::warn!("Thumbnail generation failed for {}: {}", path.display(), e);
                        None
                    }
                }
            })
            .collect()
    })
}

pub fn ensure_thumbnail(
    source: &Path,
    cache_dir: &Path,
    profile: StorageProfile,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    generate_single_thumbnail(source, cache_dir, profile)
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

                match generate_single_thumbnail(source, cache_dir, profile) {
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

fn generate_single_thumbnail_impl(
    source: &Path,
    cache_dir: &Path,
    profile: StorageProfile,
    force: bool,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    let thumb_name = hash_path(source);
    let thumb_path = cache_dir.join(format!("{}.{}", thumb_name, THUMB_EXTENSION));

    if !force && thumb_path.exists() {
        return Ok(thumb_path);
    }

    let img = image_decode::open_image(source)?;
    let size = thumb_size(profile);
    let thumbnail = img.resize(size, size, THUMB_FILTER);

    let tmp_path = cache_dir.join(format!("{}.{}.tmp", thumb_name, std::process::id()));
    encode_jpeg_thumbnail(&thumbnail, &tmp_path, profile)?;
    if let Err(e) = std::fs::rename(&tmp_path, &thumb_path) {
        if std::fs::copy(&tmp_path, &thumb_path).is_err() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e.into());
        }
        let _ = std::fs::remove_file(&tmp_path);
    }

    Ok(thumb_path)
}

fn generate_single_thumbnail(
    source: &Path,
    cache_dir: &Path,
    profile: StorageProfile,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    generate_single_thumbnail_impl(source, cache_dir, profile, false)
}

fn encode_jpeg_thumbnail(
    thumbnail: &image::DynamicImage,
    out_path: &Path,
    profile: StorageProfile,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let rgb = thumbnail.to_rgb8();
    let file = File::create(out_path)?;
    let writer = BufWriter::with_capacity(64 * 1024, file);
    let mut encoder = JpegEncoder::new_with_quality(writer, thumb_jpeg_quality(profile));
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
    hasher.update(THUMB_CACHE_VERSION.as_bytes());
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
pub fn get_thumbnail_path(source: &Path, cache_dir: &Path) -> PathBuf {
    get_thumbnail_cache_path(source, cache_dir)
}

/// Returns the canonical thumbnail cache path for a source image.
pub fn get_thumbnail_cache_path(source: &Path, cache_dir: &Path) -> PathBuf {
    let thumb_name = hash_path(source);
    cache_dir.join(format!("{}.{}", thumb_name, THUMB_EXTENSION))
}
