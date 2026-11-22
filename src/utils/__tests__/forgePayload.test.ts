import { describe, it, expect } from "vitest";
import { buildForgePayload, buildRequeuePayload, normalizeScheduler, type GenerationParams } from "../forgePayload";

const base: GenerationParams = {
    prompt: "p", negative_prompt: "", steps: "20", sampler: "Euler", schedule_type: "karras",
    cfg_scale: "7", seed: "12345", width: 512, height: 512, model_hash: null, model_name: null,
    generation_type: null, extra_params: {}, text_chunks: {}, raw_metadata: "",
};

describe("buildForgePayload seed handling", () => {
    it("keeps safe-integer seeds exactly", () => {
        expect(buildForgePayload(base).seed).toBe(12345);
    });
    it("never emits a precision-damaged seed above 2^53", () => {
        const p = buildForgePayload({ ...base, seed: "9007199254740999" });
        expect(p.seed).toBeUndefined();
    });
    it("forces batch_size 1", () => {
        expect(buildForgePayload(base).batch_size).toBe(1);
    });
    it("keeps LoRA tags in the prompt and never sends a LoRA always-on script (Forge answers 422)", () => {
        const params = { ...base, prompt: "a cat <lora:style_a:0.7>" };
        for (const payload of [buildForgePayload(params), buildRequeuePayload(params)]) {
            expect(payload.prompt).toContain("<lora:style_a:0.7>");
            expect(payload.alwayson_scripts).toBeUndefined();
        }
    });
    it("normalizes scheduler labels (Karras→karras)", () => {
        expect(normalizeScheduler("Karras")).toBe("karras");
        expect(normalizeScheduler("SGM Uniform")).toBe("sgm_uniform");
        expect(buildForgePayload({ ...base, schedule_type: "Karras" }).scheduler).toBe("karras");
        expect(buildRequeuePayload({ ...base, schedule_type: "Karras" }).scheduler).toBe("karras");
    });
});

describe("Forge override_settings parity with Rust build_requeue_payload", () => {
    const withExtras: GenerationParams = {
        ...base,
        model_name: "model.safetensors",
        extra_params: { "Clip skip": "2", "Other option": "keep-in-extra" },
    };
    const forbidden = ["sd_sampler", "sampler_name", "sd_scheduler", "cfg_scale", "seed"];

    const builders = [
        ["buildForgePayload", (p: GenerationParams, includeSeed: boolean) =>
            buildForgePayload(p, { includeSeed })],
        ["buildRequeuePayload", (p: GenerationParams, includeSeed: boolean) =>
            buildRequeuePayload(p, includeSeed)],
    ] as const;

    for (const [label, build] of builders) {
        it(`${label}: only checkpoint and numeric Clip skip go into override_settings`, () => {
            const payload = build(withExtras, true);
            expect(payload.override_settings).toEqual({
                sd_model_checkpoint: "model.safetensors",
                CLIP_stop_at_last_layers: 2,
            });
            for (const key of forbidden) {
                expect(payload.override_settings).not.toHaveProperty(key);
            }
            // Sampler/scheduler/cfg/seed remain top-level fields.
            expect(payload.sampler_name).toBe("Euler");
            expect(payload.scheduler).toBe("karras");
            expect(payload.cfg_scale).toBe(7);
            expect(payload.seed).toBe(12345);
        });

        it(`${label}: includeSeed only removes the top-level seed`, () => {
            const payload = build(withExtras, false);
            expect(payload.seed).toBeUndefined();
            expect(payload.override_settings).not.toHaveProperty("seed");
        });
    }

    it("accepts the lowercase clip_skip key and ignores a non-integer Clip skip", () => {
        expect(buildRequeuePayload({ ...base, extra_params: { clip_skip: "4" } }).override_settings)
            .toEqual({ CLIP_stop_at_last_layers: 4 });
        expect(buildRequeuePayload({ ...base, extra_params: { "Clip skip": "2.5" } }).override_settings)
            .toBeUndefined();
    });
});
