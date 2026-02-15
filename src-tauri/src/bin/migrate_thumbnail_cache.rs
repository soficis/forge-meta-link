use image::codecs::jpeg::JpegEncoder;
use std::env;
use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

const JPEG_QUALITY: u8 = 85;

#[derive(Default)]
struct MigrationSummary {
    scanned_webp: usize,
    migrated_to_jpg: usize,
    removed_webp: usize,
    kept_existing_jpg: usize,
    skipped_non_file: usize,
    failed_convert: usize,
    failed_remove: usize,
}

fn usage() {
    println!("One-time migration for legacy WebP thumbnail cache entries.");
    println!();
    println!("Usage:");
    println!("  cargo run --manifest-path src-tauri/Cargo.toml --bin migrate_thumbnail_cache");
    println!(
        "  cargo run --manifest-path src-tauri/Cargo.toml --bin migrate_thumbnail_cache -- --cache-dir /path/to/thumbnails"
    );
}

fn parse_cache_dir() -> Result<Option<PathBuf>, String> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                usage();
                std::process::exit(0);
            }
            "--cache-dir" => {
                let Some(path) = args.next() else {
                    return Err("Missing path after --cache-dir".to_string());
                };
                return Ok(Some(PathBuf::from(path)));
            }
            unknown => {
                return Err(format!("Unknown argument: {}", unknown));
            }
        }
    }
    Ok(None)
}

fn candidate_cache_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(xdg_data_home) = env::var_os("XDG_DATA_HOME") {
        dirs.push(
            PathBuf::from(xdg_data_home)
                .join("com.forgemetalink.app")
                .join("thumbnails"),
        );
    }
    if let Some(home) = env::var_os("HOME") {
        dirs.push(
            PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("com.forgemetalink.app")
                .join("thumbnails"),
        );
    }
    if let Some(app_data) = env::var_os("APPDATA") {
        dirs.push(
            PathBuf::from(app_data)
                .join("com.forgemetalink.app")
                .join("thumbnails"),
        );
    }
    dirs
}

fn resolve_cache_dir(flag_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(path) = flag_dir {
        return Ok(path);
    }
    if let Some(path) = env::var_os("FORGE_THUMB_CACHE_DIR") {
        return Ok(PathBuf::from(path));
    }

    let candidates = candidate_cache_dirs();
    for path in &candidates {
        if path.exists() {
            return Ok(path.clone());
        }
    }

    Err(format!(
        "Could not locate thumbnail cache directory. Checked: {}",
        candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn encode_jpeg(input_path: &Path, output_path: &Path) -> Result<(), String> {
    let img = image::open(input_path)
        .map_err(|error| format!("decode failed for {}: {}", input_path.display(), error))?;
    let rgb = img.to_rgb8();
    let file = fs::File::create(output_path)
        .map_err(|error| format!("create failed for {}: {}", output_path.display(), error))?;
    let writer = BufWriter::with_capacity(64 * 1024, file);
    let mut encoder = JpegEncoder::new_with_quality(writer, JPEG_QUALITY);
    encoder
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|error| format!("encode failed for {}: {}", output_path.display(), error))
}

fn migrate_cache(cache_dir: &Path) -> Result<MigrationSummary, String> {
    if !cache_dir.exists() {
        return Err(format!(
            "Cache directory does not exist: {}",
            cache_dir.display()
        ));
    }
    if !cache_dir.is_dir() {
        return Err(format!(
            "Cache path is not a directory: {}",
            cache_dir.display()
        ));
    }

    let mut summary = MigrationSummary::default();
    let entries = fs::read_dir(cache_dir)
        .map_err(|error| format!("Failed to read {}: {}", cache_dir.display(), error))?;

    for entry in entries {
        let Ok(entry) = entry else {
            summary.skipped_non_file += 1;
            continue;
        };
        let path = entry.path();
        if !path.is_file() {
            summary.skipped_non_file += 1;
            continue;
        }
        let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if !ext.eq_ignore_ascii_case("webp") {
            continue;
        }

        summary.scanned_webp += 1;
        let jpg_path = path.with_extension("jpg");
        if jpg_path.exists() {
            summary.kept_existing_jpg += 1;
        } else {
            match encode_jpeg(&path, &jpg_path) {
                Ok(()) => summary.migrated_to_jpg += 1,
                Err(error) => {
                    summary.failed_convert += 1;
                    eprintln!("{}", error);
                }
            }
        }

        match fs::remove_file(&path) {
            Ok(()) => summary.removed_webp += 1,
            Err(error) => {
                summary.failed_remove += 1;
                eprintln!("remove failed for {}: {}", path.display(), error);
            }
        }
    }

    Ok(summary)
}

fn main() {
    let cache_dir = match parse_cache_dir().and_then(resolve_cache_dir) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{}", error);
            usage();
            std::process::exit(1);
        }
    };

    println!("Using cache directory: {}", cache_dir.display());
    match migrate_cache(&cache_dir) {
        Ok(summary) => {
            println!("Legacy WebP thumbnail migration complete.");
            println!("  scanned_webp: {}", summary.scanned_webp);
            println!("  migrated_to_jpg: {}", summary.migrated_to_jpg);
            println!("  kept_existing_jpg: {}", summary.kept_existing_jpg);
            println!("  removed_webp: {}", summary.removed_webp);
            println!("  skipped_non_file: {}", summary.skipped_non_file);
            println!("  failed_convert: {}", summary.failed_convert);
            println!("  failed_remove: {}", summary.failed_remove);
        }
        Err(error) => {
            eprintln!("{}", error);
            std::process::exit(1);
        }
    }
}
