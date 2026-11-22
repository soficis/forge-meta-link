import { describe, it, expect } from "vitest";
import {
    buildRecipe,
    extractRecipeLoras,
    encodeRecipe,
    decodeRecipe,
    validateRecipe,
    diffRecipes,
    encodeRecipeBundle,
    decodeRecipeBundle,
} from "../recipeClipboard";
import type { Recipe } from "../../types/recipe";
import type { GenerationParams } from "../../utils/forgePayload";

function makeParams(): GenerationParams {
    return {
        prompt: "cat, masterpiece, <lora:DetailTuner:[0.8@t1, 0.6@t2]>",
        negative_prompt: "blurry, jpeg artifacts",
        steps: "20",
        sampler: "e_uler",
        schedule_type: "Karras",
        cfg_scale: "7.0",
        // Beyond Number.MAX_SAFE_INTEGER on purpose: a numeric coercion would corrupt it.
        seed: "18446744073709551615",
        width: 1024,
        height: 768,
        model_hash: "a1b2c3d4",
        model_name: "Flux.2 [dev]",
        generation_type: "txt2img",
        extra_params: {
            "Refiner CFG": "1.25",
            img2img_background_color: "#ffffff",
            dtype: "bf16",
        },
        text_chunks: {
            parameters: "Steps: 20, Sampler: e_uler, Schedule type: Karras, CFG scale: 7.0",
            workflow:
                '{\n  "nodes": [\n    { "id": 1, "type": "KSampler" },\n    { "id": 2, "type": "VAEDecode" }\n  ],\n  "links": []\n}',
            invokeai_metadata: "Généré par InvokeAI — café ☕",
        },
        raw_metadata:
            "Steps: 20, Sampler: e_uler, Schedule type: Karras, CFG scale: 7.0, <lora:DetailTuner:[0.8@t1, 0.6@t2]>",
    };
}

function mismatches(a: Recipe, b: Recipe): string[] {
    return diffRecipes(a, b)
        .filter((row) => !row.match)
        .map((row) => row.field);
}

describe("buildRecipe / LoRA extraction", () => {
    it("keeps both weight/timing pairs verbatim and de-duplicates repeated tags", () => {
        const loras = extractRecipeLoras(makeParams().prompt, makeParams().raw_metadata);
        expect(loras).toHaveLength(2);
        expect(loras[0]).toEqual({
            name: "DetailTuner",
            tokens: "[0.8@t1, 0.6@t2]",
            weight: "0.8",
            timing: "t1",
        });
        expect(loras[1]).toEqual({
            name: "DetailTuner",
            tokens: "[0.8@t1, 0.6@t2]",
            weight: "0.6",
            timing: "t2",
        });
    });

    it("handles plain weights and bracket timing without altering case", () => {
        const loras = extractRecipeLoras(
            "x <lora:MixedLoRA:0.7> <lora:Second:[0.5@tA]> <lora:mixedlora:0.7>",
        );
        expect(loras).toEqual([
            { name: "MixedLoRA", tokens: "0.7", weight: "0.7", timing: null },
            { name: "Second", tokens: "[0.5@tA]", weight: "0.5", timing: "tA" },
            { name: "mixedlora", tokens: "0.7", weight: "0.7", timing: null },
        ]);
    });

    it("copies unknown scalar params into extra_params", () => {
        const params = makeParams() as GenerationParams & { novelNeoField: string };
        params.novelNeoField = "keep-me";
        const recipe = buildRecipe(params);
        expect(recipe.extra_params.novelNeoField).toBe("keep-me");
        expect(recipe.extra_params).not.toHaveProperty("seed");
    });
});

describe("full lossless round-trip", () => {
    it("diffRecipes reports zero mismatches for a fully populated recipe", () => {
        const recipe = buildRecipe(makeParams(), {
            id: 42,
            filename: "cat.png",
            filepath: "/tmp/cat.png",
            family: "flux2",
        });
        const decoded = decodeRecipe(encodeRecipe(recipe));

        expect(mismatches(recipe, decoded)).toEqual([]);
        expect(decoded.seed).toBe("18446744073709551615");
        expect(decoded.cfg_scale).toBe("7.0");
        expect(decoded.steps).toBe("20");
        expect(decoded.sampler).toBe("e_uler");
        expect(decoded.scheduler).toBe("Karras");
        expect(decoded.width).toBe(1024);
        expect(decoded.height).toBe(768);
        expect(decoded.model_name).toBe("Flux.2 [dev]");
        expect(decoded.model_hash).toBe("a1b2c3d4");
        expect(decoded.generation_type).toBe("txt2img");
        expect(decoded.source).toEqual({
            id: 42,
            filename: "cat.png",
            filepath: "/tmp/cat.png",
            family: "flux2",
        });
        expect(decoded.extra_params).toEqual({
            "Refiner CFG": "1.25",
            dtype: "bf16",
            img2img_background_color: "#ffffff",
        });
        expect(decoded.text_chunks).toEqual(recipe.text_chunks);
        expect(encodeRecipe(decoded)).toBe(encodeRecipe(recipe));
        expect(decoded.loras.map((lora) => [lora.weight, lora.timing])).toEqual([
            ["0.8", "t1"],
            ["0.6", "t2"],
        ]);
    });
});

describe("encodeRecipe determinism", () => {
    it("is byte-stable across encodes and key insertion order", () => {
        const recipe = buildRecipe(makeParams());
        const first = encodeRecipe(recipe);
        const second = encodeRecipe(decodeRecipe(first));
        const shuffled = Object.fromEntries(Object.entries(recipe).reverse()) as unknown as Recipe;

        expect(second).toBe(first);
        expect(encodeRecipe(shuffled)).toBe(first);
        const shuffledChunks = Object.fromEntries(Object.entries(recipe.text_chunks).reverse());
        expect(encodeRecipe({ ...recipe, text_chunks: shuffledChunks })).toBe(first);
        expect(first).toContain("\n  "); // pretty-printed
    });
});

describe("decodeRecipe validation", () => {
    it("throws field-specific errors for bad JSON, format, version and types", () => {
        const valid = buildRecipe(makeParams());
        expect(() => decodeRecipe("{not json")).toThrow(/invalid JSON/);
        expect(() => decodeRecipe(JSON.stringify({ ...valid, format: "other" }))).toThrow(
            /"format"/,
        );
        expect(() => decodeRecipe(JSON.stringify({ ...valid, version: 2 }))).toThrow(/"version"/);
        expect(() => decodeRecipe(JSON.stringify({ ...valid, seed: 123 }))).toThrow(/"seed"/);
        expect(() => decodeRecipe(JSON.stringify({ ...valid, width: "1024" }))).toThrow(
            /"width"/,
        );
        expect(() =>
            decodeRecipe(JSON.stringify({ ...valid, extra_params: { Refiner: 2 } })),
        ).toThrow(/extra_params\.Refiner/);
        expect(() =>
            decodeRecipe(JSON.stringify({ ...valid, text_chunks: { workflow: 2 } })),
        ).toThrow(/text_chunks\.workflow/);
    });

    it("never fabricates defaults for absent fields and validates them as warnings", () => {
        const decoded = decodeRecipe(
            JSON.stringify({
                format: "forgemetalink.recipe",
                version: 1,
                prompt: "only a prompt",
            }),
        );
        expect(decoded.steps).toBeNull();
        expect(decoded.cfg_scale).toBeNull();
        expect(decoded.seed).toBeNull();
        expect(decoded.negative_prompt).toBe("");
        expect(decoded.loras).toEqual([]);
        expect(decoded.extra_params).toEqual({});
        expect(decoded.text_chunks).toEqual({});
        const warnings = validateRecipe(decoded);
        expect(warnings.some((warning) => warning.includes("steps"))).toBe(true);
        expect(warnings.some((warning) => warning.includes("cfg_scale"))).toBe(true);
        expect(warnings.some((warning) => warning.includes("source"))).toBe(true);
        expect(warnings.some((warning) => warning.includes("text_chunks"))).toBe(false);
    });
});

describe("bundle queue file", () => {
    it("round-trips every recipe in order with all fields intact", () => {
        const first = buildRecipe(makeParams(), { id: 1, family: "flux2" });
        const second = buildRecipe(
            {
                ...makeParams(),
                seed: "999",
                prompt: "dog",
                raw_metadata: "Steps: 12, Schedule type: Normal",
                schedule_type: "Normal",
                extra_params: { "Refiner CFG": "2.0" },
            },
            { id: 2, filename: "dog.png", filepath: "/tmp/dog.png" },
        );
        const text = encodeRecipeBundle([first, second]);
        const decoded = decodeRecipeBundle(text);

        expect(decoded).toHaveLength(2);
        expect(decoded.map((recipe) => recipe.seed)).toEqual(["18446744073709551615", "999"]);
        expect(decoded.map((recipe) => recipe.source?.id)).toEqual([1, 2]);
        expect(decoded[0].source?.family).toBe("flux2");
        expect(decoded[1].source?.filepath).toBe("/tmp/dog.png");
        expect(decoded[1].extra_params).toEqual({ "Refiner CFG": "2.0" });
        expect(mismatches(first, decoded[0])).toEqual([]);
        expect(mismatches(second, decoded[1])).toEqual([]);
        expect(decodeRecipeBundle(encodeRecipeBundle([second, first])).map((r) => r.seed)).toEqual([
            "999",
            "18446744073709551615",
        ]);
    });

    it("validates bundle envelope fields", () => {
        expect(() => decodeRecipeBundle("nope")).toThrow(/invalid JSON/);
        expect(() =>
            decodeRecipeBundle(JSON.stringify({ format: "wrong", version: 1, recipes: [] })),
        ).toThrow(/"format"/);
        expect(() =>
            decodeRecipeBundle(
                JSON.stringify({ format: "forgemetalink.recipe-bundle", version: 9, recipes: [] }),
            ),
        ).toThrow(/"version"/);
    });
});

describe("diffRecipes", () => {
    it("detects exactly one changed field including case changes", () => {
        const a = buildRecipe(makeParams());
        const b: Recipe = { ...a, scheduler: "karras" };
        expect(diffRecipes(a, b).filter((row) => !row.match)).toEqual([
            { field: "scheduler", left: "Karras", right: "karras", match: false },
        ]);
    });

    it("reports every extra_params key and full LoRA token string", () => {
        const a = buildRecipe(makeParams());
        const changedExtra: Recipe = {
            ...a,
            extra_params: { ...a.extra_params, dtype: "fp16" },
        };
        expect(mismatches(a, changedExtra)).toEqual(["extra_params.dtype"]);

        const changedTokens: Recipe = {
            ...a,
            loras: a.loras.map((lora, i) =>
                i === 0 ? { ...lora, tokens: "[0.9@t1, 0.6@t2]" } : lora,
            ),
        };
        expect(mismatches(a, changedTokens)).toEqual(["loras[0].tokens"]);
    });

    it("reports one row per changed, added or removed text chunk without dumping values", () => {
        const a = buildRecipe(makeParams());
        const changed: Recipe = {
            ...a,
            text_chunks: { ...a.text_chunks, workflow: '{\n  "changed": true\n}' },
        };
        expect(diffRecipes(a, changed).filter((row) => !row.match)).toEqual([
            expect.objectContaining({ field: "text_chunks.workflow", match: false }),
        ]);
        const row = diffRecipes(a, changed).find((r) => r.field === "text_chunks.workflow")!;
        expect(JSON.stringify(row)).not.toContain("changed");
        expect(String(row.left).length).toBeLessThan(80);
        expect(String(row.right).length).toBeLessThan(80);

        const added: Recipe = {
            ...a,
            text_chunks: { ...a.text_chunks, extra_chunk: "brand new chunk" },
        };
        expect(mismatches(a, added)).toEqual(["text_chunks.extra_chunk"]);

        const removed: Recipe = {
            ...a,
            text_chunks: { parameters: a.text_chunks.parameters },
        };
        expect(mismatches(a, removed)).toEqual([
            "text_chunks.invokeai_metadata",
            "text_chunks.workflow",
        ]);
    });

    it("compares every declared field with stable ordering", () => {
        const a = buildRecipe(makeParams(), { id: 7 });
        expect(mismatches(a, a)).toEqual([]);
        const fields = diffRecipes(a, a).map((row) => row.field);
        expect(fields.length).toBeGreaterThan(20);
        expect(fields.slice(0, 5)).toEqual([
            "format",
            "version",
            "prompt",
            "negative_prompt",
            "seed",
        ]);
        expect(fields).toContain("source.id");
        expect(fields).toContain("loras[0].tokens");
        expect(fields).toContain("extra_params.dtype");
        expect(fields).toContain("text_chunks.workflow");
        expect(diffRecipes(a, a).map((row) => row.field)).toEqual(fields);
    });
});

describe("PNG text chunks", () => {
    it("round-trips every chunk verbatim with deterministic key order", () => {
        const params = makeParams();
        const recipe = buildRecipe(params);
        const encoded = encodeRecipe(recipe);
        const decoded = decodeRecipe(encoded);

        expect(decoded.text_chunks).toEqual(params.text_chunks);
        expect(decoded.text_chunks.workflow).toContain("\n");
        expect(decoded.text_chunks.invokeai_metadata).toBe("Généré par InvokeAI — café ☕");
        expect(encodeRecipe(decoded)).toBe(encoded);

        const raw = JSON.parse(encoded) as { text_chunks: Record<string, string> };
        expect(Object.keys(raw.text_chunks)).toEqual([
            "invokeai_metadata",
            "parameters",
            "workflow",
        ]);
        // Chunks are their own field, never folded into extra_params.
        expect(decoded.extra_params).not.toHaveProperty("text_chunks");
        expect(decoded.extra_params).not.toHaveProperty("workflow");
    });

    it("accepts an empty chunk map for older records without reporting an error", () => {
        const recipe = buildRecipe({ ...makeParams(), text_chunks: {} });
        const decoded = decodeRecipe(encodeRecipe(recipe));

        expect(decoded.text_chunks).toEqual({});
        expect(validateRecipe(decoded).some((warning) => warning.includes("text_chunks"))).toBe(
            false,
        );
    });
});
