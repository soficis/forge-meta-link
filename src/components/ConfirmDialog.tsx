import { useId, useRef } from "react";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
    count: number;
    filenames?: string[];
    mode?: "permanent" | "trash";
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmDialog({
    count,
    filenames = [],
    mode = "permanent",
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    const titleId = useId();
    const descriptionId = useId();
    const cancelButtonRef = useRef<HTMLButtonElement>(null);

    const isSingle = count === 1;
    const isTrash = mode === "trash";
    const title = isTrash
        ? isSingle
            ? "Move 1 image to Trash?"
            : `Move ${count} images to Trash?`
        : isSingle
        ? "Delete 1 image permanently?"
        : `Delete ${count} images permanently?`;

    // Construct body: the first 3 filenames + "and N more"
    let filesSummary = "";
    if (filenames.length > 0) {
        const firstThree = filenames.slice(0, 3);
        const remainingCount = Math.max(0, count - 3);
        if (remainingCount > 0) {
            filesSummary = `${firstThree.join(", ")}, and ${remainingCount} more.`;
        } else {
            filesSummary = `${firstThree.join(", ")}.`;
        }
    }

    const destructiveLabel = isTrash
        ? isSingle
            ? "Move 1 to Trash"
            : `Move ${count} to Trash`
        : isSingle
        ? "Delete 1 permanently"
        : `Delete ${count} permanently`;

    const description = isTrash
        ? "They will be moved to the Recycle Bin."
        : "Prompt text is removed; seed, CFG, steps, sampler, scheduler and model are kept so lineage can still be traced.";

    return (
        <Modal
            role="alertdialog"
            labelledBy={titleId}
            aria-describedby={descriptionId}
            className="confirm-dialog"
            onClose={onCancel}
            initialFocusRef={cancelButtonRef}
        >
            <header className="confirm-dialog-header">
                <h2 id={titleId}>{title}</h2>
            </header>

            <div className="confirm-dialog-body" id={descriptionId}>
                {filesSummary ? (
                    <p className="confirm-dialog-files">{filesSummary}</p>
                ) : null}
                <p>{description}</p>
            </div>

            <footer className="confirm-dialog-actions">
                <button
                    ref={cancelButtonRef}
                    type="button"
                    className="sidebar-button"
                    onClick={onCancel}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    className="sidebar-button danger"
                    onClick={onConfirm}
                >
                    {destructiveLabel}
                </button>
            </footer>
        </Modal>
    );
}
