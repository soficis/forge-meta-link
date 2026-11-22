import type { GenerationParams } from "../utils/forgePayload";
import { RECIPE_FORMAT_VERSION } from "../types/recipe";
import type { Recipe, RecipeLora } from "../types/recipe";

const RECIPE_FORMAT = "forgemetalink.recipe";
export const RECIPE_BUNDLE_FORMAT = "forgemetalink.recipe-bundle";

const GENERATION_PARAM_KEYS: ReadonlySet<string> = new Set([
    "prompt",
    "negative_prompt",
    "steps",
    "sampler",
    "schedule_type",
    "cfg_scale",
    "seed",
    "width",
    "height",
    "model_hash",
    "model_name",
    "generation_type",
    "extra_params",
    "text_chunks",
    "raw_metadata",
]);

const RECIPE_KEYS: ReadonlySet<string> = new Set([
    "format",
    "version",
    "source",
    "prompt",
    "negative_prompt",
    "seed",
    "cfg_scale",
    "steps",
    "sampler",
    "scheduler",
    "width",
    "height",
    "model_name",
    "model_hash",
    "generation_type",
    "loras",
    "extra_params",
    "text_chunks",
    "raw_metadata",
]);

// Unlike utils/metadata.ts:53-69 this captures the whole `<lora:name:body>` so
// `[0.8@t1, 0.6@t2]` timing is retained instead of being thrown away.
const LORA_RE = /<lora:([^:>\s]+)\s*:\s*([^>]*)>/gi;

const DIFF_SCALAR_FIELDS = [
    "format",
    "version",
    "prompt",
    "negative_prompt",
    "seed",
    "cfg_scale",
    "steps",
    "sampler",
    "scheduler",
    "width",
    "height",
    "model_name",
    "model_hash",
    "generation_type",
    "raw_metadata",
] as const;

const SOURCE_FIELDS = ["id", "filename", "filepath", "family"] as const;
const LORA_FIELDS = ["name", "tokens", "weight", "timing"] as const;
const NULLABLE_STRING_FIELDS = [
    "seed",
    "cfg_scale",
    "steps",
    "sampler",
    "scheduler",
    "model_name",
    "model_hash",
    "generation_type",
] as const;

// ── small helpers ──────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function describeValue(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

function invalid(field: string, expected: string, value: unknown): Error {
    return new Error(
        `recipe: invalid field "${field}" — expected ${expected}, got ${describeValue(value)}`,
    );
}

/** Unknown scalar keys are preserved as strings so no field is dropped silently. */
function foldUnknown(
    source: Record<string, unknown>,
    known: ReadonlySet<string>,
    extra: Record<string, string>,
): Record<string, string> {
    const folded = { ...extra };
    for (const key of Object.keys(source)) {
        if (known.has(key) || Object.prototype.hasOwnProperty.call(folded, key)) continue;
        const value = source[key];
        if (typeof value === "string") folded[key] = value;
        else if (typeof value === "number" || typeof value === "boolean") folded[key] = String(value);
        else if (value !== null && typeof value === "object") {
            const serialized = JSON.stringify(sortJson(value));
            if (serialized !== undefined) folded[key] = serialized;
        }
    }
    return folded;
}

/** Copy unknown top-level keys into `extra_params` before serialization. */
function withFoldedUnknowns(recipe: Recipe): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(recipe as unknown as Record<string, unknown>) };
    out.extra_params = foldUnknown(
        recipe as unknown as Record<string, unknown>,
        RECIPE_KEYS,
        recipe.extra_params,
    );
    for (const key of Object.keys(out)) {
        if (!RECIPE_KEYS.has(key)) delete out[key];
    }
    return out;
}

/** Deterministic JSON value: object keys sorted at every level, arrays kept in order. */
function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJson);
    if (isPlainObject(value)) {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key]);
        return sorted;
    }
    return value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((value, i) => valuesEqual(value, right[i]));
    }
    if (isPlainObject(left) && isPlainObject(right)) {
        const leftKeys = Object.keys(left).sort();
        const rightKeys = Object.keys(right).sort();
        if (leftKeys.length !== rightKeys.length) return false;
        return leftKeys.every(
            (key, i) => key === rightKeys[i] && valuesEqual(left[key], right[key]),
        );
    }
    return false;
}

/**
 * Compact marker for a chunk in a diff row. Chunk bodies can be whole JSON documents, so the
 * diff reports presence and a short digest instead of dumping the value.
 */
function chunkSummary(value: string | undefined): string {
    if (value === undefined) return "absent";
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    const digest = (hash >>> 0).toString(16).padStart(8, "0");
    return `present (${value.length} chars, ${digest})`;
}

// ── LoRA extraction ───────────────────────────────────────────────────

function splitWeightTokens(body: string): Array<{ weight: string | null; timing: string | null }> {
    let inner = body.trim();
    if (inner.startsWith("[") && inner.endsWith("]")) inner = inner.slice(1, -1);
    const parts = inner
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    if (parts.length === 0) return [{ weight: null, timing: null }];
    return parts.map((token) => {
        const at = token.indexOf("@");
        if (at < 0) return { weight: token, timing: null };
        const weight = token.slice(0, at).trim();
        const timing = token.slice(at + 1).trim();
        return { weight: weight || null, timing: timing || null };
    });
}

/**
 * Extract LoRAs from prompt + raw_metadata. `tokens` is the verbatim weight body;
 * commas produce one weight/timing pair per entry. Duplicate name+tokens pairs
 * (the same tag repeated in prompt and raw metadata) are collapsed.
 */
export function extractRecipeLoras(...texts: Array<string | null | undefined>): RecipeLora[] {
    const loras: RecipeLora[] = [];
    const seen = new Set<string>();
    for (const text of texts) {
        if (!text) continue;
        LORA_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = LORA_RE.exec(text)) !== null) {
            const name = match[1] ?? "";
            const tokens = match[2] ?? "";
            for (const pair of splitWeightTokens(tokens)) {
                const lora: RecipeLora = {
                    name,
                    tokens,
                    weight: pair.weight,
                    timing: pair.timing,
                };
                const key = JSON.stringify([lora.name, lora.tokens, lora.weight, lora.timing]);
                if (seen.has(key)) continue;
                seen.add(key);
                loras.push(lora);
            }
        }
    }
    return loras;
}

// ── build / encode / decode ───────────────────────────────────────────

/** Build a normalized recipe without coercing or re-capitalizing any source value. */
export function buildRecipe(params: GenerationParams, source?: Recipe["source"]): Recipe {
    const recipe: Recipe = {
        format: RECIPE_FORMAT,
        version: RECIPE_FORMAT_VERSION,
        prompt: params.prompt,
        negative_prompt: params.negative_prompt,
        seed: params.seed,
        cfg_scale: params.cfg_scale,
        steps: params.steps,
        sampler: params.sampler,
        scheduler: params.schedule_type,
        width: params.width,
        height: params.height,
        model_name: params.model_name,
        model_hash: params.model_hash,
        generation_type: params.generation_type,
        loras: extractRecipeLoras(params.prompt, params.raw_metadata),
        extra_params: foldUnknown(
            params as unknown as Record<string, unknown>,
            GENERATION_PARAM_KEYS,
            params.extra_params,
        ),
        // A shallow copy keeps the canonical sorted-key serializer free to reorder without
        // mutating the caller's params; every key/value survives verbatim.
        text_chunks: { ...(params.text_chunks ?? {}) },
        raw_metadata: params.raw_metadata,
    };
    if (source !== undefined) recipe.source = source;
    return recipe;
}

/** Pretty-printed, byte-stable JSON; unknown top-level keys go into `extra_params`. */
export function encodeRecipe(recipe: Recipe): string {
    return JSON.stringify(sortJson(withFoldedUnknowns(recipe)), null, 2);
}

/** Parse and type-check a recipe. Missing values stay null/empty — never inferred. */
export function decodeRecipe(text: string): Recipe {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`recipe: invalid JSON — ${errorMessage(err)}`);
    }
    if (!isPlainObject(parsed)) throw invalid("recipe", "a JSON object", parsed);
    const obj = parsed;

    if (obj.format !== RECIPE_FORMAT) throw invalid("format", `"${RECIPE_FORMAT}"`, obj.format);
    if (obj.version !== RECIPE_FORMAT_VERSION) throw invalid("version", "1", obj.version);

    const requiredString = (field: string): string => {
        const value = obj[field];
        if (value === undefined) return "";
        if (typeof value !== "string") throw invalid(field, "string", value);
        return value;
    };
    const nullableString = (field: string): string | null => {
        const value = obj[field];
        if (value === undefined || value === null) return null;
        if (typeof value !== "string") throw invalid(field, "string or null", value);
        return value;
    };
    const nullableNumber = (field: string): number | null => {
        const value = obj[field];
        if (value === undefined || value === null) return null;
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw invalid(field, "number or null", value);
        }
        return value;
    };

    const rawLoras = obj.loras === undefined ? [] : obj.loras;
    if (!Array.isArray(rawLoras)) throw invalid("loras", "array", rawLoras);
    const loras: RecipeLora[] = rawLoras.map((entry: unknown, i: number) => {
        if (!isPlainObject(entry)) throw invalid(`loras[${i}]`, "object", entry);
        const read = (field: (typeof LORA_FIELDS)[number], expected: string): string | null => {
            const value = entry[field];
            if (value === undefined || value === null) {
                return field === "name" || field === "tokens" ? "" : null;
            }
            if (typeof value !== "string") throw invalid(`loras[${i}].${field}`, expected, value);
            return value;
        };
        return {
            name: read("name", "string") ?? "",
            tokens: read("tokens", "string") ?? "",
            weight: read("weight", "string or null"),
            timing: read("timing", "string or null"),
        };
    });

    const rawExtra = obj.extra_params === undefined ? {} : obj.extra_params;
    if (!isPlainObject(rawExtra)) throw invalid("extra_params", "object", rawExtra);
    const extra_params: Record<string, string> = {};
    for (const key of Object.keys(rawExtra).sort()) {
        const value = rawExtra[key];
        if (typeof value !== "string") throw invalid(`extra_params.${key}`, "string", value);
        extra_params[key] = value;
    }
    // Every chunk is preserved verbatim, including unknown keys. Older records have no
    // `text_chunks` field at all, which decodes to an empty map (valid, never an error).
    const rawChunks = obj.text_chunks === undefined || obj.text_chunks === null ? {} : obj.text_chunks;
    if (!isPlainObject(rawChunks)) throw invalid("text_chunks", "object", rawChunks);
    const text_chunks: Record<string, string> = {};
    for (const key of Object.keys(rawChunks).sort()) {
        const value = rawChunks[key];
        if (typeof value !== "string") throw invalid(`text_chunks.${key}`, "string", value);
        text_chunks[key] = value;
    }
    // Unknown top-level keys are kept too, so a direct decode is lossless as well.
    const foldedExtra = foldUnknown(obj, RECIPE_KEYS, extra_params);

    let source: Recipe["source"];
    const rawSource = obj.source;
    if (rawSource === undefined || rawSource === null) {
        source = undefined;
    } else {
        if (!isPlainObject(rawSource)) throw invalid("source", "object", rawSource);
        const parsedSource: NonNullable<Recipe["source"]> = {};
        if (rawSource.id !== undefined) {
            if (typeof rawSource.id !== "number" || !Number.isInteger(rawSource.id)) {
                throw invalid("source.id", "number", rawSource.id);
            }
            parsedSource.id = rawSource.id;
        }
        for (const key of ["filename", "filepath", "family"] as const) {
            const value = rawSource[key];
            if (value === undefined) continue;
            if (typeof value !== "string") throw invalid(`source.${key}`, "string", value);
            parsedSource[key] = value;
        }
        source = parsedSource;
    }

    const recipe: Recipe = {
        format: RECIPE_FORMAT,
        version: RECIPE_FORMAT_VERSION,
        prompt: requiredString("prompt"),
        negative_prompt: requiredString("negative_prompt"),
        seed: nullableString("seed"),
        cfg_scale: nullableString("cfg_scale"),
        steps: nullableString("steps"),
        sampler: nullableString("sampler"),
        scheduler: nullableString("scheduler"),
        width: nullableNumber("width"),
        height: nullableNumber("height"),
        model_name: nullableString("model_name"),
        model_hash: nullableString("model_hash"),
        generation_type: nullableString("generation_type"),
        loras,
        extra_params: foldedExtra,
        text_chunks,
        raw_metadata: requiredString("raw_metadata"),
    };
    if (source !== undefined) recipe.source = source;
    return recipe;
}

/**
 * Report absent/empty values without inventing any. This is the explicit guard
 * against the `MutationPopover.tsx` P1 that fabricated `steps: "20"` / `cfg: "7.0"`.
 */
export function validateRecipe(recipe: Recipe): string[] {
    const warnings: string[] = [];
    for (const field of NULLABLE_STRING_FIELDS) {
        if (recipe[field] === null) warnings.push(`${field}: absent (null) — no default was inferred`);
    }
    for (const field of ["width", "height"] as const) {
        if (recipe[field] === null) warnings.push(`${field}: absent (null) — no default was inferred`);
    }
    for (const field of ["prompt", "negative_prompt", "raw_metadata"] as const) {
        if (recipe[field] === "") warnings.push(`${field}: absent (empty) — no default was inferred`);
    }
    if (recipe.source === undefined) warnings.push("source: absent — no source was inferred");
    if (recipe.loras.length === 0) warnings.push("loras: empty — no LoRA tags were inferred");
    if (Object.keys(recipe.extra_params).length === 0) {
        warnings.push("extra_params: empty — no extra params were inferred");
    }
    // `text_chunks` is intentionally absent from this list: an empty map is the honest
    // representation of an older record with no PNG text chunks, not a missing value.
    return warnings;
}

// ── diff ───────────────────────────────────────────────────────────────

export interface RecipeDiffRow {
    field: string;
    left: unknown;
    right: unknown;
    match: boolean;
}

/**
 * Field-by-field diff in stable order: declared scalars, source subfields, every
 * LoRA subfield (including the full token string), every `extra_params` key, then
 * every `text_chunks` key (as a compact marker, never the full chunk body).
 */
export function diffRecipes(a: Recipe, b: Recipe): RecipeDiffRow[] {
    const rows: RecipeDiffRow[] = [];
    const add = (field: string, left: unknown, right: unknown): void => {
        rows.push({ field, left, right, match: valuesEqual(left, right) });
    };

    for (const field of DIFF_SCALAR_FIELDS) add(field, a[field], b[field]);
    for (const field of SOURCE_FIELDS) {
        add(`source.${field}`, a.source?.[field] ?? null, b.source?.[field] ?? null);
    }
    const loraCount = Math.max(a.loras.length, b.loras.length);
    for (let i = 0; i < loraCount; i += 1) {
        for (const field of LORA_FIELDS) {
            add(`loras[${i}].${field}`, a.loras[i]?.[field] ?? null, b.loras[i]?.[field] ?? null);
        }
    }
    const extraKeys = Array.from(
        new Set([...Object.keys(a.extra_params), ...Object.keys(b.extra_params)]),
    ).sort();
    for (const key of extraKeys) {
        add(`extra_params.${key}`, a.extra_params[key] ?? null, b.extra_params[key] ?? null);
    }
    // One row per chunk key so added/removed/changed chunks are visible without copying their
    // (potentially very large) values into the diff. `match` uses the real values.
    const leftChunks = a.text_chunks ?? {};
    const rightChunks = b.text_chunks ?? {};
    const chunkKeys = Array.from(
        new Set([...Object.keys(leftChunks), ...Object.keys(rightChunks)]),
    ).sort();
    for (const key of chunkKeys) {
        const left = leftChunks[key];
        const right = rightChunks[key];
        rows.push({
            field: `text_chunks.${key}`,
            left: chunkSummary(left),
            right: chunkSummary(right),
            match: left === right,
        });
    }
    return rows;
}

// ── bundle queue file ──────────────────────────────────────────────────

export function encodeRecipeBundle(recipes: Recipe[]): string {
    return JSON.stringify(
        sortJson({
            format: RECIPE_BUNDLE_FORMAT,
            version: RECIPE_FORMAT_VERSION,
            recipes: recipes.map(withFoldedUnknowns),
        }),
        null,
        2,
    );
}

export function decodeRecipeBundle(text: string): Recipe[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`recipe bundle: invalid JSON — ${errorMessage(err)}`);
    }
    if (!isPlainObject(parsed)) throw invalid("bundle", "a JSON object", parsed);
    const obj = parsed;
    if (obj.format !== RECIPE_BUNDLE_FORMAT) {
        throw invalid("format", `"${RECIPE_BUNDLE_FORMAT}"`, obj.format);
    }
    if (obj.version !== RECIPE_FORMAT_VERSION) throw invalid("version", "1", obj.version);
    if (!Array.isArray(obj.recipes)) throw invalid("recipes", "array", obj.recipes);

    return obj.recipes.map((entry: unknown, i: number): Recipe => {
        try {
            return decodeRecipe(JSON.stringify(entry));
        } catch (err) {
            throw new Error(`recipe bundle: invalid field "recipes[${i}]" — ${errorMessage(err)}`);
        }
    });
}

// ── clipboard wrappers ─────────────────────────────────────────────────

export async function copyRecipeText(text: string): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard write is unavailable (navigator.clipboard.writeText).");
    }
    try {
        await navigator.clipboard.writeText(text);
    } catch (err) {
        throw new Error(`Failed to copy recipe to clipboard: ${errorMessage(err)}`);
    }
}

export async function readRecipeText(): Promise<string> {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        throw new Error("Clipboard read is unavailable (navigator.clipboard.readText).");
    }
    try {
        return await navigator.clipboard.readText();
    } catch (err) {
        throw new Error(`Failed to read recipe from clipboard: ${errorMessage(err)}`);
    }
}
