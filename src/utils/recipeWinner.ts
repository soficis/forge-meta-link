import type { GalleryImageRecord, ImageRecord } from "../types/metadata";
import type { Recipe } from "../types/recipe";
import type { GenerationParams } from "./forgePayload";
import { buildRecipe, decodeRecipe, decodeRecipeBundle } from "./recipeClipboard";

const POPULATED_STRING_FIELDS = [
    "prompt",
    "negative_prompt",
    "seed",
    "cfg_scale",
    "steps",
    "sampler",
    "scheduler",
    "model_name",
    "model_hash",
    "generation_type",
    "raw_metadata",
] as const;

const SOURCE_FIELDS = ["id", "filename", "filepath", "family"] as const;

/** Count populated fields, mirroring the rows diffRecipes reports (format + version included). */
export function countRecipeFields(recipe: Recipe): number {
    let count = 2; // format + version
    for (const field of POPULATED_STRING_FIELDS) {
        const value = recipe[field];
        if (value !== null && value !== "") count += 1;
    }
    if (recipe.width !== null) count += 1;
    if (recipe.height !== null) count += 1;
    count += recipe.loras.length;
    count += Object.keys(recipe.extra_params).length;
    count += Object.keys(recipe.text_chunks ?? {}).length;
    if (recipe.source) {
        for (const field of SOURCE_FIELDS) {
            const value = recipe.source[field];
            if (value !== undefined && value !== null) count += 1;
        }
    }
    return count;
}

/** The backend record carries generation_type; the legacy TS interface omits it. */
type WinnerDetail = ImageRecord & { generation_type?: string | null };

/**
 * Build GenerationParams strictly from observed values. Schedule type, generation type and extra
 * params are copied from the resolved detail when present; absent fields stay null/empty —
 * nothing is inferred.
 */
export function winnerToGenerationParams(
    winner: GalleryImageRecord,
    winnerDetails?: ImageRecord | null,
): GenerationParams {
    const detail = (winnerDetails as WinnerDetail | null | undefined) ?? null;
    return {
        prompt: detail?.prompt ?? "",
        negative_prompt: detail?.negative_prompt ?? "",
        steps: detail?.steps ?? null,
        sampler: detail?.sampler ?? null,
        schedule_type: detail?.schedule_type ?? null,
        cfg_scale: detail?.cfg_scale ?? null,
        seed: detail?.seed ?? winner.seed ?? null,
        width: detail?.width ?? winner.width ?? null,
        height: detail?.height ?? winner.height ?? null,
        model_hash: detail?.model_hash ?? null,
        model_name: detail?.model_name ?? winner.model_name ?? null,
        generation_type: detail?.generation_type ?? null,
        extra_params: detail?.extra_params ?? {},
        text_chunks: detail?.text_chunks ?? {},
        raw_metadata: detail?.raw_metadata ?? "",
    };
}

/** Recipe for the selected winner, using the resolved detail and the matching compare pin. */
export function buildWinnerRecipe(
    winner: GalleryImageRecord,
    winnerDetails: ImageRecord | null | undefined,
    pins: GalleryImageRecord[] = [],
): Recipe {
    const pin = pins.find((candidate) => candidate.id === winner.id) ?? winner;
    return buildRecipe(winnerToGenerationParams(pin, winnerDetails), {
        id: pin.id,
        filename: pin.filename,
        filepath: pin.filepath,
    });
}

/** Accept the bundle we copy as well as a single recipe pasted from elsewhere. */
export function readPastedRecipe(text: string): Recipe {
    try {
        const recipes = decodeRecipeBundle(text);
        if (recipes.length > 0) return recipes[0];
    } catch {
        // Fall through to single-recipe decoding.
    }
    return decodeRecipe(text);
}
