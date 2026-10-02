import type { DeleteImagesResult, DeleteMode } from "../types/metadata";

export const BULK_TRASH_CONFIRM_THRESHOLD = 25;

export function needsBulkTrashConfirm(count: number): boolean {
    return count >= BULK_TRASH_CONFIRM_THRESHOLD;
}

export function getDeleteResultToast(
    result: DeleteImagesResult,
    mode: DeleteMode
): { message: string; tone: "success" | "warning" } {
    const deletedLabel = mode === "trash" ? "Moved to Trash" : "Deleted";
    if (result.removed_from_db > 0) {
        return {
            message: `${deletedLabel} ${result.removed_from_db} image${
                result.removed_from_db === 1 ? "" : "s"
            }.`,
            tone:
                result.failed_files > 0 || result.blocked_protected > 0
                    ? "warning"
                    : "success",
        };
    }
    if (result.db_error) {
        return {
            message:
                "Files were moved but the library could not be updated. Rescan to refresh.",
            tone: "warning",
        };
    }
    return {
        message: "No images were deleted.",
        tone: "warning",
    };
}
