import { describe, it, expect } from "vitest";
import { buildForgePayload, type GenerationParams } from "../forgePayload";

const base: GenerationParams = {
    prompt: "p", negative_prompt: "", steps: "20", sampler: "Euler", schedule_type: "karras",
    cfg_scale: "7", seed: "12345", width: 512, height: 512, model_hash: null, model_name: null,
    generation_type: null, extra_params: {}, raw_metadata: "",
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
});
