import { describe, expect, it } from "vitest";
import { resolveGalleryKeyTarget } from "../galleryKeyTarget";

describe("resolveGalleryKeyTarget", () => {
    it("returns none when nothing is focused and nothing is selected", () => {
        expect(resolveGalleryKeyTarget({ focusedId: null, selectedIds: [], key: "f" })).toEqual({
            kind: "none",
        });
        expect(resolveGalleryKeyTarget({ focusedId: undefined, selectedIds: new Set(), key: "1" })).toEqual({
            kind: "none",
        });
        expect(resolveGalleryKeyTarget({ focusedId: null, selectedIds: [], key: "delete" })).toEqual({
            kind: "none",
        });
        expect(resolveGalleryKeyTarget({ focusedId: Number.NaN, selectedIds: [], key: "f" })).toEqual({
            kind: "none",
        });
    });

    it("ensures a focused cell beats the selection", () => {
        const resultF = resolveGalleryKeyTarget({
            focusedId: 42,
            selectedIds: [1, 2, 3],
            key: "f",
        });
        expect(resultF).toEqual({ kind: "focused", id: 42 });

        const resultSet = resolveGalleryKeyTarget({
            focusedId: 42,
            selectedIds: new Set([10, 20]),
            key: "1",
        });
        expect(resultSet).toEqual({ kind: "focused", id: 42 });

        const resultDel = resolveGalleryKeyTarget({
            focusedId: 99,
            selectedIds: [5, 6],
            key: "delete",
        });
        expect(resultDel).toEqual({ kind: "focused", id: 99 });
    });

    it("uses selection only for f and returns none for other keys when nothing is focused", () => {
        const resultF = resolveGalleryKeyTarget({
            focusedId: null,
            selectedIds: [101, 102],
            key: "f",
        });
        expect(resultF).toEqual({ kind: "selection", ids: [101, 102] });

        const resultFSet = resolveGalleryKeyTarget({
            focusedId: null,
            selectedIds: new Set([201, 202]),
            key: "F",
        });
        expect(resultFSet).toEqual({ kind: "selection", ids: [201, 202] });

        // Compare Lab slot pinning (1-4) should never pin a multi-selection
        expect(resolveGalleryKeyTarget({ focusedId: null, selectedIds: [101, 102], key: "1" })).toEqual({
            kind: "none",
        });
        expect(resolveGalleryKeyTarget({ focusedId: null, selectedIds: [101, 102], key: "4" })).toEqual({
            kind: "none",
        });

        // Delete with no focused cell returns none for selection
        expect(resolveGalleryKeyTarget({ focusedId: null, selectedIds: [101, 102], key: "delete" })).toEqual({
            kind: "none",
        });
    });
});
