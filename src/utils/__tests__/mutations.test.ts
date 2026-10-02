import { describe, it, expect } from "vitest";
import {
    applyOps,
    expandSweep,
    calculateSweepSize,
    isConfirmRequired,
    SWEEP_HARD_CAP,
    SWEEP_CONFIRM_THRESHOLD,
    type MutationOp,
    type SweepSelection,
} from "../mutations";
import type { GenerationParams } from "../forgePayload";

const baseParams: GenerationParams = {
    prompt: "masterpiece, 1girl, forest",
    negative_prompt: "blurry, low quality",
    steps: "20",
    sampler: "Euler a",
    schedule_type: "karras",
    cfg_scale: "7.0",
    seed: "12345",
    width: 512,
    height: 512,
    model_hash: "abc123",
    model_name: "v1-5-pruned",
    generation_type: "txt2img",
    extra_params: {},
    raw_metadata: "",
};

describe("mutations pure module", () => {
    describe("applyOps", () => {
        it("applies seed_step with standard seed", () => {
            const res = applyOps(baseParams, [{ kind: "seed_step", value: 3 }]);
            expect(res.seed).toBe("12348");
            expect(res.prompt).toBe(baseParams.prompt);
        });

        it("applies seed_step with 64-bit seed without precision loss", () => {
            const bigSeed = "9007199254740995"; // > Number.MAX_SAFE_INTEGER
            const params = { ...baseParams, seed: bigSeed };
            const res = applyOps(params, [{ kind: "seed_step", value: 4 }]);
            expect(res.seed).toBe("9007199254740999");
        });

        it("disallows seed_step on random seed (-1)", () => {
            const params = { ...baseParams, seed: "-1" };
            expect(() => applyOps(params, [{ kind: "seed_step", value: 1 }])).toThrow(
                /random seed/i
            );
        });

        it("disallows seed_step on non-numeric seed", () => {
            const params = { ...baseParams, seed: "invalid_seed" };
            expect(() => applyOps(params, [{ kind: "seed_step", value: 1 }])).toThrow(
                /invalid numeric seed/i
            );
        });

        it("applies cfg_delta and clamps to [1.0, 30.0]", () => {
            const res = applyOps(baseParams, [{ kind: "cfg_delta", value: 1.5 }]);
            expect(res.cfg_scale).toBe("8.5");

            const clampedLow = applyOps(baseParams, [{ kind: "cfg_delta", value: -10.0 }]);
            expect(clampedLow.cfg_scale).toBe("1");

            const clampedHigh = applyOps(baseParams, [{ kind: "cfg_delta", value: 30.0 }]);
            expect(clampedHigh.cfg_scale).toBe("30");
        });

        it("applies steps_delta and clamps to [1, 150]", () => {
            const res = applyOps(baseParams, [{ kind: "steps_delta", value: 5 }]);
            expect(res.steps).toBe("25");

            const clampedLow = applyOps(baseParams, [{ kind: "steps_delta", value: -50 }]);
            expect(clampedLow.steps).toBe("1");

            const clampedHigh = applyOps(baseParams, [{ kind: "steps_delta", value: 200 }]);
            expect(clampedHigh.steps).toBe("150");
        });

        it("applies sampler and scheduler swaps for verified names", () => {
            const res = applyOps(baseParams, [
                {
                    kind: "sampler_scheduler_swap",
                    sampler: "DPM++ 2M",
                    scheduler: "exponential",
                },
            ]);
            expect(res.sampler).toBe("DPM++ 2M");
            expect(res.schedule_type).toBe("exponential");
        });

        it("rejects rejected schedulers (e.g. bong_tangent)", () => {
            expect(() =>
                applyOps(baseParams, [
                    {
                        kind: "sampler_scheduler_swap",
                        scheduler: "bong_tangent",
                    },
                ])
            ).toThrow(/unsupported scheduler/i);
        });
    });

    describe("expandSweep combinatorics", () => {
        it("returns empty when no operators selected", () => {
            expect(expandSweep({})).toEqual([]);
        });

        it("evaluates Cartesian cross product for active dimensions", () => {
            const selection: SweepSelection = {
                seedSteps: [1, 2],
                cfgDeltas: [-0.5, 0.5],
            };
            const sweep = expandSweep(selection);
            expect(sweep.length).toBe(4);
            expect(sweep[0]).toEqual([
                { kind: "seed_step", value: 1 },
                { kind: "cfg_delta", value: -0.5 },
            ]);
            expect(sweep[3]).toEqual([
                { kind: "seed_step", value: 2 },
                { kind: "cfg_delta", value: 0.5 },
            ]);
        });

        it("enforces hard cap of 16 children", () => {
            const selection: SweepSelection = {
                seedSteps: [1, 2, 3, 4], // 4
                cfgDeltas: [-1, 0, 1], // 3
                stepsDeltas: [-5, 5], // 2 -> 4 * 3 * 2 = 24
            };
            const count = calculateSweepSize(selection);
            expect(count).toBe(24);

            const sweep = expandSweep(selection);
            expect(sweep.length).toBe(SWEEP_HARD_CAP);
            expect(sweep.length).toBe(16);
        });

        it("flags confirmation when size > 8", () => {
            expect(isConfirmRequired(8)).toBe(false);
            expect(isConfirmRequired(9)).toBe(true);
            expect(isConfirmRequired(16)).toBe(true);
            expect(SWEEP_CONFIRM_THRESHOLD).toBe(8);
        });
    });
});
