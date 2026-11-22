import { describe, expect, it } from "vitest";
import {
    detectResolutionFamilyFromModelName,
    MODEL_FAMILIES,
    RESOLUTION_PRESETS,
    type ModelFamilyId,
} from "../modelFamilies";
import { CHECKPOINT_FAMILY_OPTIONS } from "../checkpointFamilies";

describe("modelFamilies detection & presets", () => {
    it("detects qwen2512 and Qwen-Image as qwen_image", () => {
        expect(detectResolutionFamilyFromModelName("qwen2512.safetensors")).toBe("qwen_image");
        expect(detectResolutionFamilyFromModelName("Qwen-Image-2512-bf16.safetensors")).toBe("qwen_image");
        expect(detectResolutionFamilyFromModelName("qwen2.5_12b_fp8")).toBe("qwen_image");
        expect(detectResolutionFamilyFromModelName("qwen_image")).toBe("qwen_image");
    });

    it("detects Qwen-Image-Edit / 2.1 Edit as qwen_image_edit before qwen_image", () => {
        expect(detectResolutionFamilyFromModelName("Qwen-Image-Edit-2509-bf16.safetensors")).toBe("qwen_image_edit");
        expect(detectResolutionFamilyFromModelName("Qwen-Image-2.1-Edit_fp8.safetensors")).toBe("qwen_image_edit");
        expect(detectResolutionFamilyFromModelName("qwen2.1_edit.safetensors")).toBe("qwen_image_edit");
        expect(detectResolutionFamilyFromModelName("qwen2.1.safetensors")).toBe("qwen_image_edit");
    });

    it("detects flux checkpoints as flux", () => {
        expect(detectResolutionFamilyFromModelName("flux1-dev.safetensors")).toBe("flux");
        expect(detectResolutionFamilyFromModelName("flux1-schnell.safetensors")).toBe("flux");
        expect(detectResolutionFamilyFromModelName("FLUX.1-Kontext")).toBe("flux");
    });

    it("detects Flux.2 Klein / Small-Decoder as flux2_klein before flux", () => {
        expect(detectResolutionFamilyFromModelName("flux2-klein-9b.safetensors")).toBe("flux2_klein");
        expect(detectResolutionFamilyFromModelName("Flux.2-Klein-4B_fp8.safetensors")).toBe("flux2_klein");
        expect(detectResolutionFamilyFromModelName("flux.2-small-decoder.safetensors")).toBe("flux2_klein");
    });

    it("detects krea2-turbo as krea2_turbo before turbo/zimage", () => {
        expect(detectResolutionFamilyFromModelName("krea2_turbo.safetensors")).toBe("krea2_turbo");
        expect(detectResolutionFamilyFromModelName("Krea 2 Turbo")).toBe("krea2_turbo");
        expect(detectResolutionFamilyFromModelName("krea-2-model")).toBe("krea2_turbo");
    });

    it("detects Krea Identity Edit as krea_identity_edit before krea2_turbo", () => {
        expect(detectResolutionFamilyFromModelName("krea2_identity_edit.safetensors")).toBe("krea_identity_edit");
        expect(detectResolutionFamilyFromModelName("Krea-2-Identity-v1.safetensors")).toBe("krea_identity_edit");
    });

    it("requires z-image or zimage for zimage_turbo and does not match bare turbo", () => {
        expect(detectResolutionFamilyFromModelName("z-image_turbo.safetensors")).toBe("zimage_turbo");
        expect(detectResolutionFamilyFromModelName("zimage.safetensors")).toBe("zimage_turbo");
        // Bare "turbo" must NOT match zimage_turbo
        expect(detectResolutionFamilyFromModelName("dreamshaper_turbo.safetensors")).toBe("unknown");
    });

    it("detects ponyxl vs sdxl", () => {
        expect(detectResolutionFamilyFromModelName("ponyDiffusionV6XL_v6.safetensors")).toBe("ponyxl");
        expect(detectResolutionFamilyFromModelName("sd_xl_base_1.0.safetensors")).toBe("sdxl");
    });

    it("detects sd15", () => {
        expect(detectResolutionFamilyFromModelName("v1-5-pruned-emaonly.safetensors")).toBe("sd15");
        expect(detectResolutionFamilyFromModelName("sd1.5.safetensors")).toBe("sd15");
    });

    it("detects the remaining Neo families by representative filename", () => {
        expect(detectResolutionFamilyFromModelName("anima_3.8B.safetensors")).toBe("anima");
        expect(detectResolutionFamilyFromModelName("Anima-Edit_fp8.safetensors")).toBe("anima");
        expect(detectResolutionFamilyFromModelName("anima_rgba.safetensors")).toBe("anima");
        expect(detectResolutionFamilyFromModelName("MOSS-Image-Edit.safetensors")).toBe("moss_image");
        expect(detectResolutionFamilyFromModelName("moss_image.safetensors")).toBe("moss_image");
        expect(detectResolutionFamilyFromModelName("Ernie-Image-v2.safetensors")).toBe("ernie_image");
        expect(detectResolutionFamilyFromModelName("pid1.5.safetensors")).toBe("pid");
        expect(detectResolutionFamilyFromModelName("PID_v15.safetensors")).toBe("pid");
        expect(detectResolutionFamilyFromModelName("mugen_v1.safetensors")).toBe("mugen");
        expect(detectResolutionFamilyFromModelName("chroma1-hd.safetensors")).toBe("chroma_hd");
        expect(detectResolutionFamilyFromModelName("Chroma1_HD_v1.safetensors")).toBe("chroma_hd");
        expect(detectResolutionFamilyFromModelName("chroma_v1.safetensors")).toBe("chroma");
    });

    it("guards alias boundaries (wan, sana, pid)", () => {
        // "swan" and "wang" must NOT match wan
        expect(detectResolutionFamilyFromModelName("swan_lake_v1.safetensors")).toBe("unknown");
        expect(detectResolutionFamilyFromModelName("wang_art.safetensors")).toBe("unknown");
        expect(detectResolutionFamilyFromModelName("wan2.1_t2v_14B.safetensors")).toBe("wan");
        expect(detectResolutionFamilyFromModelName("wan_video.safetensors")).toBe("wan");

        // "insane" must NOT match sana
        expect(detectResolutionFamilyFromModelName("insane_realism_v1.safetensors")).toBe("unknown");
        expect(detectResolutionFamilyFromModelName("sana_1600M_1024px.safetensors")).toBe("sana");
        expect(detectResolutionFamilyFromModelName("sana-v1.safetensors")).toBe("sana");

        // "pixel" / "rapid" must NOT match pid
        expect(detectResolutionFamilyFromModelName("pixel_art_v1.safetensors")).toBe("unknown");
        expect(detectResolutionFamilyFromModelName("rapid_model.safetensors")).toBe("unknown");
    });

    it("falls back to unknown rather than pony_sdxl for arbitrary unrecognized models", () => {
        expect(detectResolutionFamilyFromModelName("custom_model_v1.safetensors")).toBe("unknown");
        expect(detectResolutionFamilyFromModelName(null)).toBe("unknown");
        expect(detectResolutionFamilyFromModelName("")).toBe("unknown");
    });

    it("provides resolution presets for every family including sub-1MP and multi-scale", () => {
        expect(RESOLUTION_PRESETS.qwen_image.length).toBeGreaterThan(5);
        expect(RESOLUTION_PRESETS.qwen_image_edit.some((p) => p.width === "1024" && p.height === "1024")).toBe(true);
        expect(RESOLUTION_PRESETS.sd15.some((p) => p.width === "512" && p.height === "512")).toBe(true);
        expect(RESOLUTION_PRESETS.sana.some((p) => p.width === "2048" && p.height === "2048")).toBe(true);
        expect(RESOLUTION_PRESETS.sana.some((p) => p.width === "4096" && p.height === "4096")).toBe(true);
        expect(MODEL_FAMILIES.length).toBeGreaterThan(15);
        expect(MODEL_FAMILIES.some((f) => f.id === "qwen_image")).toBe(true);
    });

    it("keeps every ModelFamilyId in sync with the JSON registry", () => {
        const ids: ModelFamilyId[] = [
            "qwen_image_edit",
            "qwen_image",
            "flux2_klein",
            "flux",
            "krea_identity_edit",
            "krea2_turbo",
            "zimage_turbo",
            "anima",
            "moss_image",
            "ernie_image",
            "ponyxl",
            "sdxl",
            "sd15",
            "lumina",
            "pixart",
            "kolors",
            "auraflow",
            "hunyuan",
            "sana",
            "wan",
            "chroma_hd",
            "chroma",
            "vace",
            "pid",
            "mugen",
            "unknown",
        ];
        for (const id of ids) {
            expect(MODEL_FAMILIES.some((f) => f.id === id)).toBe(true);
            expect(RESOLUTION_PRESETS[id]).toBeDefined();
        }
        expect(MODEL_FAMILIES.every((f) => ids.includes(f.id as ModelFamilyId))).toBe(true);
    });

    it("removed SD2/SD3 families are absent from registry, presets and dropdown", () => {
        for (const id of ["sd3", "sd35", "sd21"]) {
            expect(MODEL_FAMILIES.some((f) => f.id === id)).toBe(false);
            expect(RESOLUTION_PRESETS[id]).toBeUndefined();
            expect(CHECKPOINT_FAMILY_OPTIONS.some((option) => option.value === id)).toBe(false);
        }
    });

    it("derives the checkpoint dropdown from the registry without unknown or vace", () => {
        expect(CHECKPOINT_FAMILY_OPTIONS.length).toBe(MODEL_FAMILIES.length - 2);
        expect(CHECKPOINT_FAMILY_OPTIONS.some((option) => option.value === "unknown")).toBe(false);
        expect(CHECKPOINT_FAMILY_OPTIONS.some((option) => option.value === "vace")).toBe(false);
        for (const option of CHECKPOINT_FAMILY_OPTIONS) {
            const family = MODEL_FAMILIES.find((f) => f.id === option.value);
            expect(family).toBeDefined();
            expect(option.label).toBe(family?.label);
        }
    });
});
