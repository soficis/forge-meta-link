import type { GalleryImageRecord, ImageRecord } from "../types/metadata";

// ── Keys that CompareLab cares about ────────────────────────────────
export type DeltaKey =
    | "seed"
    | "cfg"
    | "sampler"
    | "schedule"
    | "model"
    | "lora"
    | "resolution";

export const DELTA_KEYS: readonly DeltaKey[] = [
    "seed",
    "cfg",
    "sampler",
    "schedule",
    "model",
    "lora",
    "resolution",
] as const;

export const DELTA_LABELS: Record<DeltaKey, string> = {
    seed: "Seed",
    cfg: "CFG Scale",
    sampler: "Sampler",
    schedule: "Schedule",
    model: "Model",
    lora: "LoRA",
    resolution: "Width × Height",
};

// ── Extracted compare fields ──────────────────────────────────────
export interface CompareMetadata {
    seed: string | null;
    cfg_scale: string | null;
    sampler: string | null;
    schedule_type: string | null;
    model_name: string | null;
    model_hash: string | null;
    loras: string[];
    width: number | null;
    height: number | null;
    raw_metadata: string;
    prompt: string;
    // keep original id for reference
    id: number;
    filepath: string;
    filename: string;
}

// ── LoRA extraction ───────────────────────────────────────────────
const LORA_RE = /<lora:([^:>\s]+)\s*:[^>]*>/gi;

/**
 * Extract unique lower-cased LoRA names from raw metadata / prompt.
 * Mirrors Rust parser's `extract_lora_tags` logic but for display.
 */
export function extractLoras(text: string | null | undefined): string[] {
    if (!text) return [];
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    // Reset lastIndex in case of global reuse
    LORA_RE.lastIndex = 0;
    while ((m = LORA_RE.exec(text)) !== null) {
        const name = m[1]?.trim().toLowerCase();
        if (name) found.add(name);
    }
    return Array.from(found).sort((a, b) => a.localeCompare(b));
}

/**
 * Merge loras from prompt + raw_metadata + extra fallbacks.
 * De-duplicated, sorted.
 */
export function mergeLoras(...sources: Array<string | null | undefined>): string[] {
    const all = new Set<string>();
    for (const src of sources) {
        for (const l of extractLoras(src)) all.add(l);
    }
    return Array.from(all).sort((a, b) => a.localeCompare(b));
}

// ── Normalization helpers ─────────────────────────────────────────
function norm(v: string | null | undefined): string {
    const t = (v ?? "").trim();
    return t === "" ? "—" : t;
}

function normLora(loras: string[]): string {
    if (loras.length === 0) return "—";
    return loras.join(", ");
}

function normResolution(w: number | null, h: number | null): string {
    if (w == null || h == null) return "—";
    return `${w}×${h}`;
}

// ── Build CompareMetadata from records ────────────────────────────

/**
 * Build a CompareMetadata from GalleryImageRecord alone (partial) or
 * enriched ImageRecord. When both are provided, ImageRecord takes precedence
 * for detailed fields.
 */
export function toCompareMetadata(
    gallery: GalleryImageRecord,
    detail?: ImageRecord | null,
): CompareMetadata {
    // Detail wins for every field if available.
    // Gallery provides seed/width/height/model_name at minimum.
    const seed = detail?.seed ?? gallery.seed ?? null;
    const cfg = detail?.cfg_scale ?? null;
    const sampler = detail?.sampler ?? null;
    // schedule_type lives in ImageRecord via raw_metadata parsing? But ImageRecord
    // doesn't expose schedule_type directly. We parse from raw_metadata if needed.
    // For now, try to parse from raw or detail extra.
    const schedule = parseScheduleType(detail?.raw_metadata ?? gallery.filename) ?? null;

    const modelName = detail?.model_name ?? gallery.model_name ?? null;
    const modelHash = detail?.model_hash ?? null;
    const width = detail?.width ?? gallery.width ?? null;
    const height = detail?.height ?? gallery.height ?? null;
    const raw = detail?.raw_metadata ?? "";
    const prompt = detail?.prompt ?? "";

    // Loras extracted from prompt + raw
    const loras = mergeLoras(prompt, raw);

    return {
        seed: seed?.toString().trim() ? seed.toString().trim() : null,
        cfg_scale: cfg?.toString().trim() ? cfg.toString().trim() : null,
        sampler: sampler?.toString().trim() ? sampler.toString().trim() : null,
        schedule_type: schedule?.trim() ? schedule.trim() : null,
        model_name: modelName?.trim() ? modelName.trim() : null,
        model_hash: modelHash?.trim() ? modelHash.trim() : null,
        loras,
        width: width ?? null,
        height: height ?? null,
        raw_metadata: raw,
        prompt,
        id: gallery.id,
        filepath: gallery.filepath,
        filename: gallery.filename,
    };
}

/**
 * Attempt to parse schedule type from raw_metadata parameter block.
 * Handles `Schedule type: ...` or `Schedule: ...`.
 */
export function parseScheduleType(raw: string | null | undefined): string | null {
    if (!raw) return null;
    // Look for Schedule type: <value> or Schedule: <value> up to next comma or newline
    const re = /Schedule(?:\s+type)?:\s*([^,\n]+)/i;
    const m = re.exec(raw);
    if (!m) return null;
    const v = m[1]?.trim();
    return v && v.length > 0 ? v : null;
}

// ── Delta computation ─────────────────────────────────────────────

export interface DeltaRow {
    key: DeltaKey;
    label: string;
    values: string[];
    isChanged: boolean;
    // raw values for custom rendering (e.g., LoRA list)
    rawValues: Array<string | string[]>;
}

export interface DeltaResult {
    rows: DeltaRow[];
    changedKeys: Set<DeltaKey>;
    hasAnyChange: boolean;
}

/**
 * Given 2-4 CompareMetadata items, compute which keys differ.
 * Null/empty normalized to "—" for display but treated as distinct value
 * for diffing (so missing vs present counts as changed).
 *
 * For `lora`, compare sorted joined string; for `resolution`, compare "WxH".
 */
export function computeDelta(metas: CompareMetadata[]): DeltaResult {
    if (metas.length === 0) {
        return { rows: [], changedKeys: new Set(), hasAnyChange: false };
    }

    const getters: Record<DeltaKey, (m: CompareMetadata) => string> = {
        seed: (m) => norm(m.seed),
        cfg: (m) => norm(m.cfg_scale),
        sampler: (m) => norm(m.sampler),
        schedule: (m) => norm(m.schedule_type),
        model: (m) => {
            // Prefer model_name, fallback to hash prefix
            if (m.model_name?.trim()) return m.model_name.trim();
            if (m.model_hash?.trim()) return `hash:${m.model_hash.trim()}`;
            return "—";
        },
        lora: (m) => normLora(m.loras),
        resolution: (m) => normResolution(m.width, m.height),
    };

    const rows: DeltaRow[] = [];
    const changedKeys = new Set<DeltaKey>();

    for (const key of DELTA_KEYS) {
        const values = metas.map((m) => getters[key](m));
        const uniq = new Set(values);
        const isChanged = uniq.size > 1;
        if (isChanged) changedKeys.add(key);

        // preserve raw for LoRA custom highlight
        const raw: Array<string | string[]> =
            key === "lora"
                ? metas.map((m) => m.loras)
                : values;

        rows.push({
            key,
            label: DELTA_LABELS[key],
            values,
            isChanged,
            rawValues: raw,
        });
    }

    return {
        rows,
        changedKeys,
        hasAnyChange: changedKeys.size > 0,
    };
}

/**
 * Shorthand: return only changed keys as array.
 */
export function getChangedKeys(metas: CompareMetadata[]): DeltaKey[] {
    return Array.from(computeDelta(metas).changedKeys);
}

/**
 * Build table-friendly matrix: rows × columns with highlight flag per cell.
 * The `isChanged` on row-level means all cells in row get highlighted; alternatively
 * you can use per-cell diff against first column.
 */
export function buildDeltaMatrix(metas: CompareMetadata[]): {
    rows: DeltaRow[];
    columns: CompareMetadata[];
} {
    const { rows } = computeDelta(metas);
    return { rows, columns: metas };
}

// ── Display helpers ───────────────────────────────────────────────

/**
 * Human-friendly value for a key, used in card badges.
 */
export function displayValueForKey(meta: CompareMetadata, key: DeltaKey): string {
    switch (key) {
        case "seed":
            return norm(meta.seed);
        case "cfg":
            return norm(meta.cfg_scale);
        case "sampler":
            return norm(meta.sampler);
        case "schedule":
            return norm(meta.schedule_type);
        case "model":
            return meta.model_name?.trim() || (meta.model_hash ? `hash:${meta.model_hash.slice(0, 8)}` : "—");
        case "lora":
            return normLora(meta.loras);
        case "resolution":
            return normResolution(meta.width, meta.height);
        default:
            return "—";
    }
}

/**
 * Used by MetadataDeltaTable tests: whether a given key should be highlighted
 * for the provided metas.
 */
export function isKeyChanged(metas: CompareMetadata[], key: DeltaKey): boolean {
    return computeDelta(metas).changedKeys.has(key);
}
