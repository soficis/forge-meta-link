import { describe, expect, it } from "vitest";
import {
    detectResolutionFamilyFromModelName,
    MODEL_FAMILIES,
    RESOLUTION_PRESETS,
} from "../modelFamilies";

describe("modelFamilies detection & presets", () => {
    it("detects qwen2512 and Qwen-Image as qwen_image", () => {
        expect(detectResolutionFamilyFromModelName("qwen2512.safetensors")).toBe("qwen_image");
        expect(detectResolutionFamilyFromModelName("Qwen-Image-2512-bf16.safetensors")).toBe("qwen_image");
        expect(detectResolutionFamilyFromModelName("qwen2.5_12b_fp8")).toBe("qwen_image");
        expect(detectResolutionFamilyFromModelName("qwen_image")).toBe("qwen_image");
    });

    it("detects flux checkpoints as flux", () => {
        expect(detectResolutionFamilyFromModelName("flux1-dev.safetensors")).toBe("flux");
        expect(detectResolutionFamilyFromModelName("flux1-schnell.safetensors")).toBe("flux");
        expect(detectResolutionFamilyFromModelName("FLUX.1-Kontext")).toBe("flux");
    });

    it("detects krea2-turbo as krea2_turbo before turbo/zimage", () => {
        expect(detectResolutionFamilyFromModelName("krea2_turbo.safetensors")).toBe("krea2_turbo");
        expect(detectResolutionFamilyFromModelName("Krea 2 Turbo")).toBe("krea2_turbo");
        expect(detectResolutionFamilyFromModelName("krea-2-model")).toBe("krea2_turbo");
    });

    it("requires z-image or zimage for zimage_turbo and does not match bare turbo", () => {
        expect(detectResolutionFamilyFromModelName("z-image_turbo.safetensors")).toBe("zimage_turbo");
        expect(detectResolutionFamilyFromModelName("zimage.safetensors")).toBe("zimage_turbo");
        // Bare "turbo" must NOT match zimage_turbo
        expect(detectResolutionFamilyFromModelName("dreamshaper_turbo.safetensors")).toBe("unknown");
    });

    it("distinguishes sd35 from sd3", () => {
        expect(detectResolutionFamilyFromModelName("sd3.5_large.safetensors")).toBe("sd35");
        expect(detectResolutionFamilyFromModelName("sd35_medium.safetensors")).toBe("sd35");
        expect(detectResolutionFamilyFromModelName("sd3_medium.safetensors")).toBe("sd3");
    });

    it("detects ponyxl vs sdxl", () => {
        expect(detectResolutionFamilyFromModelName("ponyDiffusionV6XL_v6.safetensors")).toBe("ponyxl");
        expect(detectResolutionFamilyFromModelName("sd_xl_base_1.0.safetensors")).toBe("sdxl");
    });

    it("detects sd15 and sd21", () => {
        expect(detectResolutionFamilyFromModelName("v1-5-pruned-emaonly.safetensors")).toBe("sd15");
        expect(detectResolutionFamilyFromModelName("sd1.5.safetensors")).toBe("sd15");
        expect(detectResolutionFamilyFromModelName("v2-1_768-emapruned.safetensors")).toBe("sd21");
    });

    it("guards alias boundaries (wan, sana)", () => {
        // "swan" and "wang" must NOT match wan
        expect(detectResolutionFamilyFromModelName("swan_lake_v1.safetensors")).toBe("unknown");
        expect(detectResolutionFamilyFromModelName("wang_art.safetensors")).toBe("unknown");
        expect(detectResolutionFamilyFromModelName("wan2.1_t2v_14B.safetensors")).toBe("wan");
        expect(detectResolutionFamilyFromModelName("wan_video.safetensors")).toBe("wan");

        // "insane" must NOT match sana
        expect(detectResolutionFamilyFromModelName("insane_realism_v1.safetensors")).toBe("unknown");
        expect(detectResolutionFamilyFromModelName("sana_1600M_1024px.safetensors")).toBe("sana");
        expect(detectResolutionFamilyFromModelName("sana-v1.safetensors")).toBe("sana");
    });

    it("falls back to unknown rather than pony_sdxl for arbitrary unrecognized models", () => {
        expect(detectResolutionFamilyFromModelName("custom_model_v1.safetensors")).toBe("unknown");
        expect(detectResolutionFamilyFromModelName(null)).toBe("unknown");
        expect(detectResolutionFamilyFromModelName("")).toBe("unknown");
    });

    it("provides resolution presets for every family including sub-1MP and multi-scale", () => {
        expect(RESOLUTION_PRESETS.qwen_image.length).toBeGreaterThan(5);
        expect(RESOLUTION_PRESETS.sd15.some((p) => p.width === "512" && p.height === "512")).toBe(true);
        expect(RESOLUTION_PRESETS.sd21.some((p) => p.width === "768" && p.height === "768")).toBe(true);
        expect(RESOLUTION_PRESETS.sana.some((p) => p.width === "2048" && p.height === "2048")).toBe(true);
        expect(RESOLUTION_PRESETS.sana.some((p) => p.width === "4096" && p.height === "4096")).toBe(true);
        expect(MODEL_FAMILIES.length).toBeGreaterThan(15);
        expect(MODEL_FAMILIES.some((f) => f.id === "qwen_image")).toBe(true);
    });
});
