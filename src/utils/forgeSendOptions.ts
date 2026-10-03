/** Mirrors MAX_FORGE_BATCH_COUNT in src-tauri/src/commands/forge.rs. */
export const FORGE_BATCH_COUNT_MIN = 1;
export const FORGE_BATCH_COUNT_MAX = 64;

/**
 * Per-LoRA weights to send, keyed by token. Only LoRAs that are currently selected and have a
 * valid typed weight are included, so a stale entry for a removed LoRA never leaks into a request
 * and an empty field falls back to the default weight. Returns null when nothing is overridden.
 */
export function buildLoraWeightMap(
    selected: readonly string[],
    typed: Readonly<Record<string, string>>
): Record<string, number> | null {
    const out: Record<string, number> = {};
    for (const token of selected) {
        const raw = typed[token]?.trim();
        if (!raw) continue;
        const value = Number(raw);
        if (Number.isFinite(value)) {
            out[token] = value;
        }
    }
    return Object.keys(out).length > 0 ? out : null;
}

export interface BatchCountParse {
    /** The count to send, or null when the field is empty (meaning "just one"). */
    value: number | null;
    error: string | null;
}

export function parseBatchCount(text: string): BatchCountParse {
    const normalized = text.trim();
    if (!normalized) {
        return { value: null, error: null };
    }
    const parsed = Number(normalized);
    if (
        !Number.isInteger(parsed) ||
        parsed < FORGE_BATCH_COUNT_MIN ||
        parsed > FORGE_BATCH_COUNT_MAX
    ) {
        return {
            value: null,
            error: `Images per send must be a whole number from ${FORGE_BATCH_COUNT_MIN} to ${FORGE_BATCH_COUNT_MAX}.`,
        };
    }
    return { value: parsed, error: null };
}
