export type GalleryKey = "f" | "delete" | "1" | "2" | "3" | "4" | (string & {});

export interface ResolveGalleryKeyTargetParams {
    focusedId?: number | null;
    selectedIds?: Set<number> | number[];
    key: GalleryKey;
}

export type GalleryKeyTargetResult =
    | { kind: "focused"; id: number }
    | { kind: "selection"; ids: number[] }
    | { kind: "none" };

/**
 * Resolves the target image(s) for a keyboard shortcut pressed in the gallery.
 *
 * Rules:
 * 1. If a gallery cell has focus, that cell's image ID is always used (beats selection).
 * 2. If nothing is focused, selection applies ONLY to 'f' (for toggling favorite).
 * 3. Otherwise (e.g. keys 1-4, delete, or empty selection), returns 'none'.
 */
export function resolveGalleryKeyTarget({
    focusedId,
    selectedIds,
    key,
}: ResolveGalleryKeyTargetParams): GalleryKeyTargetResult {
    if (focusedId != null && !Number.isNaN(focusedId)) {
        return { kind: "focused", id: focusedId };
    }

    const selection = Array.isArray(selectedIds)
        ? selectedIds
        : selectedIds
          ? Array.from(selectedIds)
          : [];

    if (key.toLowerCase() === "f" && selection.length > 0) {
        return { kind: "selection", ids: selection };
    }

    return { kind: "none" };
}
