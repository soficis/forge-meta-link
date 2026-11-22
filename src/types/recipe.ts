import type { GenerationParams } from "../utils/forgePayload";

// Re-exported so the recipe DTO module is a single import site for both shapes.
export type { GenerationParams };

export const RECIPE_FORMAT_VERSION = 1;

/** One LoRA weight/timing pair. `tokens` keeps the verbatim source token string. */
export interface RecipeLora {
    name: string;
    tokens: string;
    weight: string | null;
    timing: string | null;
}

/**
 * Normalized, offline, lossless recipe. Every value is kept as it appeared in the
 * source metadata — no numeric coercion, no capitalization changes, no inferred
 * defaults. A missing value is `null` (or empty for string/array/object fields).
 */
export interface Recipe {
    format: "forgemetalink.recipe";
    version: 1;
    source?: {
        id?: number;
        filename?: string;
        filepath?: string;
        family?: string;
    };
    prompt: string;
    negative_prompt: string;
    seed: string | null;
    cfg_scale: string | null;
    steps: string | null;
    sampler: string | null;
    scheduler: string | null;
    width: number | null;
    height: number | null;
    model_name: string | null;
    model_hash: string | null;
    generation_type: string | null;
    loras: RecipeLora[];
    extra_params: Record<string, string>;
    /** Every PNG text chunk, verbatim; empty for older records that carried no chunks. */
    text_chunks: Record<string, string>;
    raw_metadata: string;
}
