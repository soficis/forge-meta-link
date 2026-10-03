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
                if (!params.seed || params.seed.trim() === "") {
                    throw new Error("Cannot apply a seed step: the source image has no seed recorded");
                }
                if (params.seed.trim() === "-1") {
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
                const raw = next.cfg_scale?.trim();
                const baseCfg = raw ? Number(raw) : NaN;
                if (!Number.isFinite(baseCfg)) {
                    throw new Error("Cannot apply a CFG delta: the source image has no CFG scale recorded");
                }
                const clamped = Math.max(1.0, Math.min(30.0, baseCfg + op.value));
                next.cfg_scale = Number(clamped.toFixed(2)).toString();
                break;
            }
            case "steps_delta": {
                const baseSteps = parseInt(next.steps?.trim() ?? "", 10);
                if (!Number.isFinite(baseSteps)) {
                    throw new Error("Cannot apply a steps delta: the source image has no step count recorded");
                }
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

/**
 * Only the fields a mutation actually changed. Sending just these as overrides lets the backend
 * take every other value (including the scheduler, which the UI record does not carry) from the
 * stored image, so nothing is guessed or defaulted on the client.
 */
export function changedOverrides(
    base: GenerationParams,
    mutated: GenerationParams
): Partial<Record<"steps" | "sampler_name" | "scheduler" | "cfg_scale" | "seed", string>> {
    const out: Partial<Record<"steps" | "sampler_name" | "scheduler" | "cfg_scale" | "seed", string>> = {};
    if (mutated.steps != null && mutated.steps !== base.steps) out.steps = mutated.steps;
    if (mutated.sampler != null && mutated.sampler !== base.sampler) out.sampler_name = mutated.sampler;
    if (mutated.schedule_type != null && mutated.schedule_type !== base.schedule_type) {
        out.scheduler = mutated.schedule_type;
    }
    if (mutated.cfg_scale != null && mutated.cfg_scale !== base.cfg_scale) out.cfg_scale = mutated.cfg_scale;
    if (mutated.seed != null && mutated.seed !== base.seed) out.seed = mutated.seed;
    return out;
}
