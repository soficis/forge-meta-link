/**
 * Re-export hook surface for CompareLab pin store.
 * Satisfies SCOPE requirement: src/hooks/ or store for pins.
 */
export {
    useCompareLabStore,
    useComparePinsArray,
    useComparePinActions,
    useIsPinned,
    canAddMorePins,
    isCompareReady,
    COMPARE_MIN_PINS,
    COMPARE_MAX_PINS,
} from "../store/compareLabStore";

import { useMemo } from "react";
import { useCompareLabStore } from "../store/compareLabStore";
import { toCompareMetadata, computeDelta } from "../utils/metadata";
import type { GalleryImageRecord, ImageRecord } from "../types/metadata";

/**
 * Convenience hook to compute delta from current pins + optional details map.
 * Integrate with API-01 lineage types later if needed.
 */
export function useCompareDelta(detailsMap?: Map<number, ImageRecord>) {
    const pins = useCompareLabStore((s) => s.pins);
    const metas = useMemo(() => {
        return pins.map((p: GalleryImageRecord) => toCompareMetadata(p, detailsMap?.get(p.id) ?? null));
    }, [pins, detailsMap]);

    const delta = useMemo(() => computeDelta(metas), [metas]);

    return { pins, metas, delta };
}
