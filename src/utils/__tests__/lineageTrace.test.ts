import { describe, it, expect } from "vitest";
import { formatOpsLabel, formatGhostRecipeText } from "../lineageTrace";
import type { LineageTraceNode } from "../../types/metadata";

describe("lineageTrace utils", () => {
    describe("formatOpsLabel", () => {
        it("returns null for empty or null ops_json", () => {
            expect(formatOpsLabel(null)).toBeNull();
            expect(formatOpsLabel("")).toBeNull();
            expect(formatOpsLabel("invalid json")).toBeNull();
        });

        it("formats seed_step, cfg_delta, steps_delta, and swaps", () => {
            const json = JSON.stringify({
                ops: [
                    { kind: "seed_step", value: 2 },
                    { kind: "cfg_delta", value: 1.0 },
                    { kind: "steps_delta", value: -5 },
                    { kind: "sampler_scheduler_swap", sampler: "DPM++ 2M", scheduler: "Karras" },
                ],
            });
            expect(formatOpsLabel(json)).toBe("seed+2, cfg+1, steps-5, DPM++ 2M, Karras");
        });

        it("includes variant_label when present and not unprocessed", () => {
            const json = JSON.stringify({
                ops: [{ kind: "seed_step", value: 1 }],
                variant_label: "adetailer",
            });
            expect(formatOpsLabel(json)).toBe("seed+1, adetailer");
        });
    });

    describe("formatGhostRecipeText", () => {
        it("formats text-only summary for culled ancestor", () => {
            const node: LineageTraceNode = {
                id: 10,
                filepath: "ghost://10",
                filename: "10.png",
                is_ghost: true,
                ghost_recipe: "{}",
                ops_json: null,
                source: "forge_requeue",
                parent_id: null,
                depth: 1,
                seed: "1234",
                cfg_scale: "7",
                steps: "20",
                sampler: "Euler a",
                scheduler: "Automatic",
                model_name: "v1-5-pruned.safetensors",
                prompt: null,
            };
            const text = formatGhostRecipeText(node);
            expect(text).toBe("culled ancestor · seed 1234 · cfg 7 · steps 20 · Euler a · v1-5-pruned");
        });
    });
});
