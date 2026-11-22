import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { deleteImages, getThumbnailPaths } from "../services/commands";
import type { DeleteImagesResult } from "../types/metadata";
import "./RapidCullBoard.css";

interface RapidCullImage {
    id: number;
    filepath: string;
    filename: string;
    /** Already-resolved asset URL, when the caller has one. */
    thumbnailUrl?: string | null;
    width: number | null;
    height: number | null;
    model_name: string | null;
    seed: string | null;
    is_locked?: boolean;
}

interface RapidCullBoardProps {
    images: RapidCullImage[];
    onClose: () => void;
    /** Lets the host drop the culled row from its own gallery state. */
    onCulled?: (id: number) => void;
}

const CONFIRM_WINDOW_MS = 3000;
const COLUMN_COUNT = 5;
const UNDO_UNAVAILABLE = "Undo unavailable in this session; use Recently Deleted";

function toImageSrc(value: string): string {
    if (/^(asset|http|https|data|blob):/i.test(value)) {
        return value;
    }
    try {
        return convertFileSrc(value.replace(/\\/g, "/"));
    } catch {
        return value;
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Only an explicit backend result that reports a removal counts as success.
 * A missing payload fails closed so a cull is never treated as done blindly.
 */
function cullSucceeded(result: DeleteImagesResult | null | undefined, id: number): boolean {
    if (result == null) {
        return false;
    }
    if (result.db_error) {
        return false;
    }
    if (result.failed_files > 0 || result.blocked_protected > 0) {
        return false;
    }
    if (Array.isArray(result.deleted_ids) && result.deleted_ids.includes(id)) {
        return true;
    }
    return result.removed_from_db > 0;
}

export function RapidCullBoard({ images, onClose, onCulled }: RapidCullBoardProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const requestedThumbnailsRef = useRef<Set<string>>(new Set<string>());
    const [culledIds, setCulledIds] = useState<Set<number>>(() => new Set<number>());
    const [culledHistory, setCulledHistory] = useState<Array<{ id: number; filename: string }>>(
        []
    );
    const [keptIds, setKeptIds] = useState<Set<number>>(() => new Set<number>());
    const [currentIndex, setCurrentIndex] = useState(0);
    const [notice, setNotice] = useState("");
    const [cellErrors, setCellErrors] = useState<Map<number, string>>(
        () => new Map<number, string>()
    );
    const [busyIds, setBusyIds] = useState<Set<number>>(() => new Set<number>());
    const [thumbnailPaths, setThumbnailPaths] = useState<Map<string, string>>(
        () => new Map<string, string>()
    );
    const [confirmPending, setConfirmPending] = useState(false);
    const [firstConfirmAt, setFirstConfirmAt] = useState<number | null>(null);
    const [sessionConfirmed, setSessionConfirmed] = useState(false);

    const activeImages = useMemo(
        () => images.filter((image) => !culledIds.has(image.id)),
        [images, culledIds]
    );
    const safeIndex =
        activeImages.length === 0 ? 0 : Math.min(currentIndex, activeImages.length - 1);
    const currentImage = activeImages[safeIndex] ?? null;

    const indexById = useMemo(() => {
        const map = new Map<number, number>();
        activeImages.forEach((image, index) => map.set(image.id, index));
        return map;
    }, [activeImages]);

    const rows = useMemo(() => {
        const grouped: RapidCullImage[][] = [];
        for (let offset = 0; offset < activeImages.length; offset += COLUMN_COUNT) {
            grouped.push(activeImages.slice(offset, offset + COLUMN_COUNT));
        }
        return grouped;
    }, [activeImages]);

    useEffect(() => {
        dialogRef.current?.focus();
    }, []);

    // Thumbnails are resolved lazily from the shared cache command; failure is
    // non-fatal because the original filepath is a usable fallback source.
    useEffect(() => {
        const missing = Array.from(
            new Set(
                images
                    .filter(
                        (image) =>
                            !image.thumbnailUrl && !requestedThumbnailsRef.current.has(image.filepath)
                    )
                    .map((image) => image.filepath)
            )
        );
        if (missing.length === 0) {
            return;
        }
        for (const filepath of missing) {
            requestedThumbnailsRef.current.add(filepath);
        }
        let active = true;
        void getThumbnailPaths(missing)
            .then((mappings) => {
                if (!active) {
                    return;
                }
                setThumbnailPaths((previous) => {
                    const next = new Map(previous);
                    let changed = false;
                    for (const mapping of mappings) {
                        if (mapping.thumbnail_path && next.get(mapping.filepath) !== mapping.thumbnail_path) {
                            next.set(mapping.filepath, mapping.thumbnail_path);
                            changed = true;
                        }
                    }
                    return changed ? next : previous;
                });
            })
            .catch(() => {
                // Keep the filepath fallback; triage must not depend on thumbnails.
            });
        return () => {
            active = false;
        };
    }, [images]);

    const move = useCallback(
        (delta: number) => {
            if (activeImages.length === 0) {
                return;
            }
            const next = Math.max(0, Math.min(safeIndex + delta, activeImages.length - 1));
            if (next === safeIndex) {
                return;
            }
            if (delta > 0) {
                const leaving = activeImages[safeIndex];
                if (leaving) {
                    setKeptIds((previous) => new Set(previous).add(leaving.id));
                }
            }
            setNotice("");
            setCurrentIndex(next);
        },
        [activeImages, safeIndex]
    );

    const cullImage = useCallback(
        async (image: RapidCullImage) => {
            if (image.is_locked) {
                setNotice(
                    `Skipped "${image.filename}": locked images cannot be culled. Unlock it first.`
                );
                return;
            }
            if (busyIds.has(image.id)) {
                return;
            }
            setBusyIds((previous) => new Set(previous).add(image.id));
            setCellErrors((previous) => {
                if (!previous.has(image.id)) {
                    return previous;
                }
                const next = new Map(previous);
                next.delete(image.id);
                return next;
            });
            try {
                const result = await deleteImages([image.id], "trash");
                if (!cullSucceeded(result, image.id)) {
                    let reason = "no images were removed";
                    if (result?.db_error) {
                        reason = result.db_error;
                    } else if (result && result.failed_files > 0) {
                        reason = `${result.failed_files} file(s) failed`;
                    } else if (result && result.blocked_protected > 0) {
                        reason = "image is protected";
                    }
                    throw new Error(reason);
                }
                setCulledIds((previous) => new Set(previous).add(image.id));
                setCulledHistory((previous) => [
                    { id: image.id, filename: image.filename },
                    ...previous,
                ]);
                setNotice(`Moved "${image.filename}" to Trash.`);
                onCulled?.(image.id);
            } catch (error) {
                setCellErrors(
                    (previous) => new Map(previous).set(image.id, `Cull failed: ${errorText(error)}`)
                );
                setNotice(`Cull failed for "${image.filename}". It stays in the board.`);
            } finally {
                setBusyIds((previous) => {
                    const next = new Set(previous);
                    next.delete(image.id);
                    return next;
                });
            }
        },
        [busyIds, onCulled]
    );

    const requestCull = useCallback(() => {
        const image = activeImages[safeIndex];
        if (!image) {
            return;
        }
        if (image.is_locked || sessionConfirmed) {
            void cullImage(image);
            return;
        }
        setConfirmPending(true);
        setFirstConfirmAt(null);
        setNotice(
            `First cull needs confirmation: press Y twice within ${
                CONFIRM_WINDOW_MS / 1000
            }s to move "${image.filename}" to Trash.`
        );
    }, [activeImages, safeIndex, cullImage, sessionConfirmed]);

    const handleConfirmKey = useCallback(() => {
        if (!confirmPending) {
            return;
        }
        const now = Date.now();
        if (firstConfirmAt == null || now - firstConfirmAt > CONFIRM_WINDOW_MS) {
            setFirstConfirmAt(now);
            setNotice("Press Y again within 3 seconds to confirm the first cull.");
            return;
        }
        setSessionConfirmed(true);
        setConfirmPending(false);
        setFirstConfirmAt(null);
        const image = activeImages[safeIndex];
        if (image) {
            void cullImage(image);
        }
    }, [confirmPending, firstConfirmAt, activeImages, safeIndex, cullImage]);

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        // The board owns the keyboard while open: never let App's gallery
        // shortcuts (Delete, j/k, Escape) act on the images behind it.
        event.stopPropagation();
        const key = event.key;
        const lower = key.toLowerCase();

        if (key === "Tab") {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
        }
        if (key === "Escape" || key === "Enter") {
            event.preventDefault();
            onClose();
            return;
        }
        if (key === "ArrowLeft" || lower === "a") {
            event.preventDefault();
            move(-1);
            return;
        }
        if (key === "ArrowRight" || lower === "d") {
            event.preventDefault();
            move(1);
            return;
        }
        if (key === " " || key === "Spacebar" || lower === "x") {
            event.preventDefault();
            requestCull();
            return;
        }
        if (lower === "z") {
            event.preventDefault();
            setNotice(UNDO_UNAVAILABLE);
            return;
        }
        if (lower === "y") {
            event.preventDefault();
            handleConfirmKey();
        }
    };

    const keptCount = keptIds.size;
    const culledCount = culledIds.size;
    const remainingCount = Math.max(0, activeImages.length - keptCount);
    const progressText = `kept ${keptCount} / culled ${culledCount} / remaining ${remainingCount}`;
    const size = currentImage
        ? `${currentImage.width ?? "?"}×${currentImage.height ?? "?"}`
        : "—";
    const currentDetails = currentImage
        ? `${currentImage.filename} · ${currentImage.model_name ?? "unknown model"} · seed ${
              currentImage.seed ?? "—"
          } · ${size}`
        : "No images remaining";

    return (
        <div className="rapid-cull-overlay" data-testid="rapid-cull-overlay">
            <div
                ref={dialogRef}
                className="rapid-cull-board"
                role="dialog"
                aria-modal="true"
                aria-labelledby="rapid-cull-title"
                aria-describedby="rapid-cull-help"
                tabIndex={-1}
                data-testid="rapid-cull-board"
                onKeyDown={handleKeyDown}
            >
                <header className="rapid-cull-header">
                    <div>
                        <h2 id="rapid-cull-title">Rapid cull board</h2>
                        <p id="rapid-cull-help" className="rapid-cull-help">
                            ←/A and →/D move · Space/X cull to Trash · Z undo · Y twice confirms
                            your first cull · Enter/Esc close
                        </p>
                    </div>
                    <button
                        type="button"
                        className="rapid-cull-close"
                        aria-label="Close rapid cull board"
                        onClick={onClose}
                    >
                        Close
                    </button>
                </header>

                <div
                    className="rapid-cull-status"
                    aria-live="polite"
                    data-testid="rapid-cull-status"
                >
                    <span data-testid="rapid-cull-progress">{progressText}</span>
                    <span data-testid="rapid-cull-current">{currentDetails}</span>
                </div>
                {notice && (
                    <p className="rapid-cull-notice" role="status" data-testid="rapid-cull-notice">
                        {notice}
                    </p>
                )}

                <div className="rapid-cull-grid-wrap">
                    {activeImages.length === 0 ? (
                        <p className="rapid-cull-empty">All images in this view have been culled.</p>
                    ) : (
                        <div
                            className="rapid-cull-grid"
                            role="grid"
                            aria-label="Images to triage"
                            aria-rowcount={rows.length}
                            data-testid="rapid-cull-grid"
                        >
                            {rows.map((row, rowIndex) => (
                                <div className="rapid-cull-row" role="row" key={`row-${rowIndex}`}>
                                    {row.map((image) => {
                                        const position = indexById.get(image.id) ?? 0;
                                        const isCurrent = position === safeIndex;
                                        const cellError = cellErrors.get(image.id);
                                        const isBusy = busyIds.has(image.id);
                                        const source =
                                            thumbnailPaths.get(image.filepath) ??
                                            image.thumbnailUrl ??
                                            image.filepath;
                                        return (
                                            <div
                                                key={image.id}
                                                role="gridcell"
                                                aria-selected={isCurrent}
                                                aria-label={`${position + 1}: ${image.filename}`}
                                                className={`rapid-cull-cell${
                                                    isCurrent ? " is-current" : ""
                                                }${image.is_locked ? " is-locked" : ""}`}
                                                data-testid={`rapid-cull-cell-${image.id}`}
                                                data-image-id={image.id}
                                                onClick={() => setCurrentIndex(position)}
                                            >
                                                <span className="rapid-cull-cell-index">
                                                    #{position + 1}
                                                </span>
                                                <img
                                                    className="rapid-cull-thumb"
                                                    src={toImageSrc(source)}
                                                    alt={image.filename}
                                                    loading="lazy"
                                                    draggable={false}
                                                />
                                                <span
                                                    className="rapid-cull-cell-name"
                                                    title={image.filename}
                                                >
                                                    {image.filename}
                                                </span>
                                                <span className="rapid-cull-cell-meta">
                                                    {image.width ?? "?"}×{image.height ?? "?"}
                                                </span>
                                                {image.is_locked && (
                                                    <span className="rapid-cull-lock-badge">
                                                        Locked — cannot cull
                                                    </span>
                                                )}
                                                {isBusy && (
                                                    <span className="rapid-cull-cell-busy">
                                                        Culling…
                                                    </span>
                                                )}
                                                {cellError && (
                                                    <span
                                                        className="rapid-cull-cell-error"
                                                        role="alert"
                                                    >
                                                        {cellError}
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {culledHistory.length > 0 && (
                    <section className="rapid-cull-history" aria-label="Culled this session">
                        <h3>Culled this session</h3>
                        <ul>
                            {culledHistory.map((entry) => (
                                <li key={entry.id}>
                                    <span className="rapid-cull-culled-badge">Culled</span>{" "}
                                    {entry.filename}
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
            </div>
        </div>
    );
}
