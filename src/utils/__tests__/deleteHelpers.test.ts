import { describe, it, expect } from "vitest";
import {
    BULK_TRASH_CONFIRM_THRESHOLD,
    needsBulkTrashConfirm,
    getDeleteResultToast,
} from "../deleteHelpers";
import type { DeleteImagesResult } from "../../types/metadata";

describe("deleteHelpers", () => {
    it("returns false for counts below threshold", () => {
        expect(needsBulkTrashConfirm(0)).toBe(false);
        expect(needsBulkTrashConfirm(1)).toBe(false);
        expect(needsBulkTrashConfirm(24)).toBe(false);
    });

    it("returns true for counts at or above threshold", () => {
        expect(needsBulkTrashConfirm(BULK_TRASH_CONFIRM_THRESHOLD)).toBe(true);
        expect(needsBulkTrashConfirm(25)).toBe(true);
        expect(needsBulkTrashConfirm(200)).toBe(true);
    });

    describe("getDeleteResultToast", () => {
        const baseResult: DeleteImagesResult = {
            requested: 1,
            removed_from_db: 0,
            deleted_ids: [1],
            deleted_files: 1,
            missing_files: 0,
            failed_files: 0,
            deleted_sidecars: 0,
            deleted_thumbnails: 0,
            blocked_protected: 0,
            blocked_protected_ids: [],
            failed_paths: [],
        };

        it("returns specific warning toast when db_error is set", () => {
            const resultWithDbError: DeleteImagesResult = {
                ...baseResult,
                removed_from_db: 0,
                db_error: "Database error removing rows: sqlite locked",
            };
            const toast = getDeleteResultToast(resultWithDbError, "trash");
            expect(toast.message).toBe(
                "Files were moved but the library could not be updated. Rescan to refresh."
            );
            expect(toast.tone).toBe("warning");
        });

        it("returns generic no images deleted warning when removed_from_db is 0 and no db_error", () => {
            const toast = getDeleteResultToast(baseResult, "trash");
            expect(toast.message).toBe("No images were deleted.");
            expect(toast.tone).toBe("warning");
        });

        it("returns success toast when images were removed from DB", () => {
            const successResult: DeleteImagesResult = {
                ...baseResult,
                removed_from_db: 3,
            };
            const toastTrash = getDeleteResultToast(successResult, "trash");
            expect(toastTrash.message).toBe("Moved to Trash 3 images.");
            expect(toastTrash.tone).toBe("success");

            const toastPermanent = getDeleteResultToast(successResult, "permanent");
            expect(toastPermanent.message).toBe("Deleted 3 images.");
            expect(toastPermanent.tone).toBe("success");
        });
    });
});
