import { useEffect, useId, useRef } from "react";

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
    const dialogRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Initial focus must be on the Cancel button
        cancelButtonRef.current?.focus();
    }, []);

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
        : "They will not go to the Recycle Bin.";

    return (
        <div
            className="settings-backdrop"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onCancel();
                }
            }}
        >
            <div
                ref={dialogRef}
                className="confirm-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                tabIndex={-1}
                onKeyDown={(event) => {
                    // Prevent background shortcuts (f, 1-4, Delete, etc.) from firing behind modal
                    event.stopPropagation();
                    if (event.key === "Escape") {
                        event.preventDefault();
                        onCancel();
                    }
                }}
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
            </div>
        </div>
    );
}
