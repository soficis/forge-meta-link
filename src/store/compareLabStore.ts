import { create } from "zustand";
import type { GalleryImageRecord } from "../types/metadata";

export const COMPARE_MIN_PINS = 2;
export const COMPARE_MAX_PINS = 4;

interface CompareLabState {
    pins: GalleryImageRecord[];
    winnerId: number | null;
    pin: (image: GalleryImageRecord) => boolean;
    pinToSlot: (image: GalleryImageRecord, slotIndex: number) => boolean;
    unpin: (id: number) => void;
    togglePin: (image: GalleryImageRecord) => boolean;
    reorder: (fromIndex: number, toIndex: number) => void;
    setPins: (pins: GalleryImageRecord[]) => void;
    setWinner: (id: number | null) => void;
    clear: () => void;
    isPinned: (id: number) => boolean;
}

function dedupeAndClamp(pins: GalleryImageRecord[]): GalleryImageRecord[] {
    const seen = new Set<number>();
    const out: GalleryImageRecord[] = [];
    for (const p of pins) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        out.push(p);
        if (out.length >= COMPARE_MAX_PINS) break;
    }
    return out;
}

export const useCompareLabStore = create<CompareLabState>((set, get) => ({
    pins: [],
    winnerId: null,
    setWinner: (id) => set({ winnerId: id }),

    pin: (image) => {
        const { pins } = get();
        if (pins.some((p) => p.id === image.id)) return true;
        if (pins.length >= COMPARE_MAX_PINS) return false;
        set({ pins: [...pins, image] });
        return true;
    },

    pinToSlot: (image, slotIndex) => {
        if (slotIndex < 0 || slotIndex >= COMPARE_MAX_PINS) return false;
        const pins = [...get().pins];
        const existingIdx = pins.findIndex((p) => p.id === image.id);
        if (existingIdx !== -1) pins.splice(existingIdx, 1);
        if (slotIndex < pins.length) {
            pins[slotIndex] = image;
        } else if (slotIndex === pins.length) {
            pins.push(image);
        } else {
            pins.push(image);
        }
        const deduped = dedupeAndClamp(pins);
        set({ pins: deduped });
        return true;
    },

    unpin: (id) => {
        const { pins, winnerId } = get();
        set({
            pins: pins.filter((p) => p.id !== id),
            winnerId: winnerId === id ? null : winnerId,
        });
    },

    togglePin: (image) => {
        const { pins, winnerId } = get();
        if (pins.some((p) => p.id === image.id)) {
            set({
                pins: pins.filter((p) => p.id !== image.id),
                winnerId: winnerId === image.id ? null : winnerId,
            });
            return false;
        }
        if (pins.length >= COMPARE_MAX_PINS) return false;
        set({ pins: [...pins, image] });
        return true;
    },

    reorder: (fromIndex, toIndex) => {
        const { pins } = get();
        if (
            fromIndex < 0 ||
            fromIndex >= pins.length ||
            toIndex < 0 ||
            toIndex >= pins.length ||
            fromIndex === toIndex
        )
            return;
        const next = [...pins];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        set({ pins: next });
    },

    setPins: (pins) => {
        const next = dedupeAndClamp(pins);
        const { winnerId } = get();
        set({
            pins: next,
            winnerId: winnerId !== null && next.some((p) => p.id === winnerId) ? winnerId : null,
        });
    },

    clear: () => set({ pins: [], winnerId: null }),

    isPinned: (id) => get().pins.some((p) => p.id === id),
}));

// ── Selector helpers (avoid subscribing to whole store) ─────────────

export function useComparePinsArray(): GalleryImageRecord[] {
    return useCompareLabStore((s) => s.pins);
}

export function useComparePinActions() {
    const pin = useCompareLabStore((s) => s.pin);
    const unpin = useCompareLabStore((s) => s.unpin);
    const togglePin = useCompareLabStore((s) => s.togglePin);
    const reorder = useCompareLabStore((s) => s.reorder);
    const clear = useCompareLabStore((s) => s.clear);
    const setPins = useCompareLabStore((s) => s.setPins);
    return { pin, unpin, togglePin, reorder, clear, setPins };
}

export function useIsPinned(id: number): boolean {
    return useCompareLabStore((s) => s.pins.some((p) => p.id === id));
}

// ── Derived helpers ─────────────────────────────────────────────────

export function canAddMorePins(pins: GalleryImageRecord[]): boolean {
    return pins.length < COMPARE_MAX_PINS;
}

export function isCompareReady(pins: GalleryImageRecord[]): boolean {
    return pins.length >= COMPARE_MIN_PINS && pins.length <= COMPARE_MAX_PINS;
}
