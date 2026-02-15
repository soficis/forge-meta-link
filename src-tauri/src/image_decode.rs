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

pub fn open_image(path: &Path) -> Result<DynamicImage, image::ImageError> {
    ensure_jxl_decoder_registered();
    image::open(path)
}
