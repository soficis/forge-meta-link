use image::DynamicImage;
use std::path::Path;
use std::sync::Once;

static JXL_DECODER_HOOK: Once = Once::new();

pub fn ensure_jxl_decoder_registered() {
    JXL_DECODER_HOOK.call_once(|| {
        let registered = jxl_oxide::integration::register_image_decoding_hook();
        if registered {
            log::info!("Registered JPEG XL decoder hook");
        }
    });
}

pub const MAX_IMAGE_WIDTH: u32 = 16384;
pub const MAX_IMAGE_HEIGHT: u32 = 16384;
pub const MAX_IMAGE_ALLOC: u64 = 256 * 1024 * 1024;

pub fn open_image(path: &Path) -> Result<DynamicImage, image::ImageError> {
    ensure_jxl_decoder_registered();
    let mut reader = image::ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_WIDTH);
    limits.max_image_height = Some(MAX_IMAGE_HEIGHT);
    limits.max_alloc = Some(MAX_IMAGE_ALLOC);
    reader.limits(limits);
    reader.decode()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn crc32(data: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &b in data {
            crc ^= b as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    fn make_png_chunk(ctype: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len() + 12);
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(ctype);
        out.extend_from_slice(data);
        let mut crc_input = Vec::with_capacity(data.len() + 4);
        crc_input.extend_from_slice(ctype);
        crc_input.extend_from_slice(data);
        out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
        out
    }

    #[test]
    fn test_open_image_rejects_oversized_dimensions() {
        let dir = std::env::temp_dir().join(format!("fml_test_limits_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file_path = dir.join("oversized.png");

        // Construct PNG with width 16385 (> MAX_IMAGE_WIDTH 16384)
        let mut ihdr_data = Vec::new();
        ihdr_data.extend_from_slice(&16385u32.to_be_bytes());
        ihdr_data.extend_from_slice(&1u32.to_be_bytes());
        ihdr_data.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit RGB

        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&make_png_chunk(b"IHDR", &ihdr_data));
        png.extend_from_slice(&make_png_chunk(b"IEND", &[]));

        let mut file = std::fs::File::create(&file_path).unwrap();
        file.write_all(&png).unwrap();
        drop(file);

        let res = open_image(&file_path);
        let _ = std::fs::remove_file(&file_path);
        let _ = std::fs::remove_dir(&dir);

        assert!(
            res.is_err(),
            "Image decoding should fail for dimensions exceeding limit"
        );
        let err_str = res.unwrap_err().to_string();
        assert!(
            err_str.to_lowercase().contains("limit")
                || err_str.to_lowercase().contains("dimension"),
            "Error message should mention limits/dimensions, got: {err_str}"
        );
    }
}
