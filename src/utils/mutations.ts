import type { GenerationParams } from "./forgePayload";

export type MutationOp =
    | { kind: "seed_step"; value: number }
    | { kind: "cfg_delta"; value: number }
    | { kind: "steps_delta"; value: number }
    | { kind: "sampler_scheduler_swap"; sampler?: string; scheduler?: string };

export interface SweepSelection {
    seedSteps?: number[];
    cfgDeltas?: number[];
    stepsDeltas?: number[];
    swaps?: Array<{ sampler?: string; scheduler?: string }>;
}

export const SWEEP_HARD_CAP = 16;
export const SWEEP_CONFIRM_THRESHOLD = 8;

export const ACCEPTED_SCHEDULERS = [
    "automatic",
    "karras",
    "exponential",
    "polyexponential",
    "normal",
    "simple",
    "uniform",
    "sgm_uniform",
    "linear_quadratic",
    "kl_optimal",
    "ddim",
    "align_your_steps",
    "beta",
    "turbo",
    "flow_match",
    "flux2",
] as const;

export const REJECTED_SCHEDULERS = ["bong_tangent"] as const;

export const COMMON_SAMPLERS = [
    "Euler a",
    "Euler",
    "DPM++ 2M",
    "DPM++ SDE",
    "DPM++ 2M SDE",
    "DPM++ 3M SDE",
    "DPM++ 2s a RF",
    "LCM",
    "Heun",
    "Restart",
] as const;

export function applyOps(
    params: GenerationParams,
    ops: MutationOp[]
): GenerationParams {
    const next: GenerationParams = {
        ...params,
        extra_params: { ...(params.extra_params ?? {}) },
    };

    for (const op of ops) {
        switch (op.kind) {
            case "seed_step": {
                if (!params.seed || params.seed.trim() === "" || params.seed.trim() === "-1") {
                    throw new Error("Cannot apply seed step to random seed (-1)");
                }
                const trimmed = params.seed.trim();
                let seedBigInt: bigint;
                try {
                    seedBigInt = BigInt(trimmed);
                } catch {
                    throw new Error(`Invalid numeric seed: "${params.seed}"`);
                }
                if (seedBigInt === -1n) {
                    throw new Error("Cannot apply seed step to random seed (-1)");
                }
                const stepped = seedBigInt + BigInt(op.value);
                if (stepped > 9223372036854775807n) {
                    throw new Error("Seed step overflows the 64-bit seed range");
                }
                next.seed = stepped.toString();
                break;
            }
            case "cfg_delta": {
                const current = Number(next.cfg_scale?.trim() ?? "7.0");
                const baseCfg = Number.isFinite(current) ? current : 7.0;
                const clamped = Math.max(1.0, Math.min(30.0, baseCfg + op.value));
                next.cfg_scale = Number(clamped.toFixed(2)).toString();
                break;
            }
            case "steps_delta": {
                const current = parseInt(next.steps?.trim() ?? "20", 10);
                const baseSteps = Number.isFinite(current) ? current : 20;
                const clamped = Math.max(1, Math.min(150, baseSteps + op.value));
                next.steps = clamped.toString();
                break;
            }
            case "sampler_scheduler_swap": {
                if (op.scheduler !== undefined) {
                    const schedNorm = op.scheduler.trim().toLowerCase();
                    if ((REJECTED_SCHEDULERS as readonly string[]).includes(schedNorm)) {
                        throw new Error(`Unsupported scheduler: ${op.scheduler}`);
                    }
                    next.schedule_type = op.scheduler;
                }
                if (op.sampler !== undefined) {
                    next.sampler = op.sampler;
                }
                break;
            }
        }
    }

    return next;
}

export function calculateSweepSize(selection: SweepSelection): number {
    const dims: number[] = [];
    if (selection.seedSteps && selection.seedSteps.length > 0) {
        dims.push(selection.seedSteps.length);
    }
    if (selection.cfgDeltas && selection.cfgDeltas.length > 0) {
        dims.push(selection.cfgDeltas.length);
    }
    if (selection.stepsDeltas && selection.stepsDeltas.length > 0) {
        dims.push(selection.stepsDeltas.length);
    }
    if (selection.swaps && selection.swaps.length > 0) {
        dims.push(selection.swaps.length);
    }

    if (dims.length === 0) return 0;
    return dims.reduce((acc, len) => acc * len, 1);
}

export function isConfirmRequired(count: number): boolean {
    return count > SWEEP_CONFIRM_THRESHOLD;
}

export function expandSweep(selection: SweepSelection): MutationOp[][] {
    const dimensions: MutationOp[][] = [];

    if (selection.seedSteps && selection.seedSteps.length > 0) {
        dimensions.push(
            selection.seedSteps.map((v) => ({ kind: "seed_step", value: v }))
        );
    }
    if (selection.cfgDeltas && selection.cfgDeltas.length > 0) {
        dimensions.push(
            selection.cfgDeltas.map((v) => ({ kind: "cfg_delta", value: v }))
        );
    }
    if (selection.stepsDeltas && selection.stepsDeltas.length > 0) {
        dimensions.push(
            selection.stepsDeltas.map((v) => ({ kind: "steps_delta", value: v }))
        );
    }
    if (selection.swaps && selection.swaps.length > 0) {
        dimensions.push(
            selection.swaps.map((s) => ({
                kind: "sampler_scheduler_swap",
                sampler: s.sampler,
                scheduler: s.scheduler,
            }))
        );
    }

    if (dimensions.length === 0) {
        return [];
    }

    let combinations: MutationOp[][] = [[]];
    for (const dim of dimensions) {
        const nextCombinations: MutationOp[][] = [];
        for (const existing of combinations) {
            for (const op of dim) {
                nextCombinations.push([...existing, op]);
            }
        }
        combinations = nextCombinations;
    }

    if (combinations.length > SWEEP_HARD_CAP) {
        return combinations.slice(0, SWEEP_HARD_CAP);
    }

    return combinations;
}
