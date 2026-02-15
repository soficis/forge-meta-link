import {
    useState,
    useRef,
    useCallback,
    useEffect,
    useMemo,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GalleryImageRecord } from "../types/metadata";
import type { StorageProfile } from "../types/metadata";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getThumbnailPaths } from "../services/commands";
import {
    copyJpegImageToClipboard,
    copyCompressedImageForDiscord,
    formatBytes,
} from "../utils/imageClipboard";

interface GalleryProps {
    images: GalleryImageRecord[];
    onSelect: (image: GalleryImageRecord) => void;
    selectedId: number | null;
    selectedIds: Set<number>;
    onToggleSelected: (imageId: number) => void;
    onSelectAll: () => void;
    onClearSelection: () => void;
    onLoadMore: () => void;
    hasMore: boolean;
    isFetchingNextPage: boolean;
    columnCount: number;
    storageProfile: StorageProfile;
}

function profileThumbnailSettings(storageProfile: StorageProfile) {
    const cpu = navigator.hardwareConcurrency || 8;
    if (storageProfile === "hdd") {
        return {
            chunkSize: 16,
            prefetchRows: 6,
            cacheLimit: 10_000,
            concurrency: Math.max(2, Math.min(4, Math.ceil(cpu / 4))),
        };
    }
    return {
        chunkSize: 32,
        prefetchRows: 12,
        cacheLimit: 24_000,
        concurrency: Math.max(4, Math.min(16, Math.ceil(cpu * 0.75))),
    };
}

function upsertThumbnailCache(
    cache: Map<string, string>,
    filepath: string,
    thumbnailPath: string,
    cacheLimit: number
) {
    if (cache.has(filepath)) {
        cache.delete(filepath);
    }
    cache.set(filepath, thumbnailPath);

    while (cache.size > cacheLimit) {
        const oldest = cache.keys().next().value;
        if (!oldest) {
            break;
        }
        cache.delete(oldest);
    }
}

export function Gallery({
    images,
    onSelect,
    selectedId,
    selectedIds,
    onToggleSelected,
    onSelectAll,
    onClearSelection,
    onLoadMore,
    hasMore,
    isFetchingNextPage,
    columnCount,
    storageProfile,
}: GalleryProps) {
    const parentRef = useRef<HTMLDivElement>(null);
    const thumbnailCacheRef = useRef<Map<string, string>>(new Map());
    const thumbnailInFlightRef = useRef<Set<string>>(new Set());
    const scrollRafRef = useRef<number | null>(null);
    const thumbFlushRafRef = useRef<number | null>(null);
    const contextToastTimeoutRef = useRef<number | null>(null);
    const [, setThumbnailVersion] = useState(0);
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        image: GalleryImageRecord;
    } | null>(null);
    const [contextToast, setContextToast] = useState<string | null>(null);
    const thumbnailSettings = useMemo(
        () => profileThumbnailSettings(storageProfile),
        [storageProfile]
    );

    const rowHeight = columnCount <= 3 ? 240 : columnCount <= 5 ? 190 : columnCount <= 8 ? 155 : 120;
    const rowCount = Math.ceil(images.length / columnCount);

    const virtualizer = useVirtualizer({
        count: rowCount + (hasMore ? 1 : 0),
        getScrollElement: () => parentRef.current,
        estimateSize: () => rowHeight,
        overscan: 5,
    });

    const virtualItems = virtualizer.getVirtualItems();

    const maybeLoadMore = useCallback(() => {
        const el = parentRef.current;
        if (!el || !hasMore || isFetchingNextPage) {
            return;
        }

        const { scrollTop, scrollHeight, clientHeight } = el;
        if (scrollHeight - scrollTop - clientHeight < 900) {
            onLoadMore();
        }
    }, [hasMore, isFetchingNextPage, onLoadMore]);

    const handleScroll = useCallback(() => {
        if (scrollRafRef.current != null) {
            return;
        }

        scrollRafRef.current = window.requestAnimationFrame(() => {
            scrollRafRef.current = null;
            maybeLoadMore();
        });
    }, [maybeLoadMore]);

    useEffect(() => {
        const el = parentRef.current;
        if (!el) {
            return;
        }

        el.addEventListener("scroll", handleScroll, { passive: true });
        return () => {
            el.removeEventListener("scroll", handleScroll);
            if (scrollRafRef.current != null) {
                window.cancelAnimationFrame(scrollRafRef.current);
                scrollRafRef.current = null;
            }
            if (thumbFlushRafRef.current != null) {
                window.cancelAnimationFrame(thumbFlushRafRef.current);
                thumbFlushRafRef.current = null;
            }
        };
    }, [handleScroll]);

    useEffect(() => {
        maybeLoadMore();
    }, [images.length, maybeLoadMore]);

    useEffect(() => {
        const handleKey = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "a") {
                event.preventDefault();
                onSelectAll();
                return;
            }

            if (event.key === "Escape" && selectedIds.size > 0) {
                event.preventDefault();
                onClearSelection();
            }
        };

        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [onSelectAll, onClearSelection, selectedIds.size]);

    useEffect(() => {
        return () => {
            if (contextToastTimeoutRef.current != null) {
                window.clearTimeout(contextToastTimeoutRef.current);
                contextToastTimeoutRef.current = null;
            }
        };
    }, []);

    const thumbnailTargets = useMemo(() => {
        if (images.length === 0 || rowCount === 0 || virtualItems.length === 0) {
            return [] as string[];
        }

        let minRow = rowCount;
        let maxRow = -1;

        for (const item of virtualItems) {
            if (item.index < rowCount) {
                minRow = Math.min(minRow, item.index);
                maxRow = Math.max(maxRow, item.index);
            }
        }

        if (maxRow < minRow) {
            return [] as string[];
        }

        const startRow = Math.max(0, minRow - thumbnailSettings.prefetchRows);
        const endRow = Math.min(rowCount - 1, maxRow + thumbnailSettings.prefetchRows);

        const filepaths: string[] = [];
        for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
            const start = rowIndex * columnCount;
            const end = Math.min(start + columnCount, images.length);
            for (let imageIndex = start; imageIndex < end; imageIndex += 1) {
                filepaths.push(images[imageIndex].filepath);
            }
        }

        return filepaths;
    }, [columnCount, images, rowCount, thumbnailSettings.prefetchRows, virtualItems]);

    useEffect(() => {
        let cancelled = false;

        const missing = thumbnailTargets.filter(
            (filepath) =>
                !thumbnailCacheRef.current.has(filepath) &&
                !thumbnailInFlightRef.current.has(filepath)
        );

        if (missing.length === 0) {
            return;
        }

        const chunks: string[][] = [];
        for (
            let index = 0;
            index < missing.length;
            index += thumbnailSettings.chunkSize
        ) {
            chunks.push(missing.slice(index, index + thumbnailSettings.chunkSize));
        }

        let chunkCursor = 0;
        const workerCount = Math.min(thumbnailSettings.concurrency, chunks.length);

        const resolveChunk = async () => {
            while (!cancelled) {
                const localIndex = chunkCursor;
                chunkCursor += 1;
                if (localIndex >= chunks.length) {
                    break;
                }

                const chunk = chunks[localIndex];
                for (const filepath of chunk) {
                    thumbnailInFlightRef.current.add(filepath);
                }

                try {
                    const mappings = await getThumbnailPaths(chunk);
                    if (cancelled) {
                        break;
                    }

                    let changed = false;
                    for (const { filepath, thumbnail_path } of mappings) {
                        if (thumbnail_path === filepath) {
                            continue;
                        }
                        const existing = thumbnailCacheRef.current.get(filepath);
                        if (existing !== thumbnail_path) {
                            upsertThumbnailCache(
                                thumbnailCacheRef.current,
                                filepath,
                                thumbnail_path,
                                thumbnailSettings.cacheLimit
                            );
                            changed = true;
                        }
                    }

                    if (changed) {
                        if (thumbFlushRafRef.current == null) {
                            thumbFlushRafRef.current = window.requestAnimationFrame(() => {
                                thumbFlushRafRef.current = null;
                                setThumbnailVersion((version) => version + 1);
                            });
                        }
                    }
                } catch (error) {
                    console.warn("Failed to batch-resolve thumbnail chunk:", error);
                } finally {
                    for (const filepath of chunk) {
                        thumbnailInFlightRef.current.delete(filepath);
                    }
                }
            }
        };

        const workers = Array.from({ length: workerCount }, () => resolveChunk());
        Promise.allSettled(workers).catch(() => {});

        return () => {
            cancelled = true;
        };
    }, [
        thumbnailSettings.cacheLimit,
        thumbnailSettings.chunkSize,
        thumbnailSettings.concurrency,
        thumbnailTargets,
    ]);

    const pushContextToast = useCallback((message: string) => {
        setContextToast(message);
        if (contextToastTimeoutRef.current != null) {
            window.clearTimeout(contextToastTimeoutRef.current);
        }
        contextToastTimeoutRef.current = window.setTimeout(() => {
            setContextToast(null);
            contextToastTimeoutRef.current = null;
        }, 2600);
    }, []);

    const openContextMenu = useCallback(
        (event: ReactMouseEvent<HTMLDivElement>, image: GalleryImageRecord) => {
            event.preventDefault();
            setContextMenu({
                x: event.clientX,
                y: event.clientY,
                image,
            });
        },
        []
    );

    const handleContextCopy = useCallback(async () => {
        if (!contextMenu) {
            return;
        }
        const target = contextMenu.image;
        setContextMenu(null);
        try {
            const result = await copyCompressedImageForDiscord(target.filepath);
            const mimeLabel = result.mime.replace("image/", "").toUpperCase();
            pushContextToast(
                `Copied ${mimeLabel} ${target.filename} (${result.width}x${result.height}, ${formatBytes(
                    result.bytes
                )})`
            );
        } catch (error) {
            pushContextToast(`Copy failed: ${String(error)}`);
        }
    }, [contextMenu, pushContextToast]);

    const handleContextCopyJpeg = useCallback(async () => {
        if (!contextMenu) {
            return;
        }
        const target = contextMenu.image;
        setContextMenu(null);
        try {
            const result = await copyJpegImageToClipboard(target.filepath);
            const mimeLabel = result.mime.replace("image/", "").toUpperCase();
            pushContextToast(
                `Copied ${mimeLabel} ${target.filename} (${result.width}x${result.height}, ${formatBytes(
                    result.bytes
                )})`
            );
        } catch (error) {
            pushContextToast(`JPEG copy failed: ${String(error)}`);
        }
    }, [contextMenu, pushContextToast]);

    useEffect(() => {
        if (!contextMenu) {
            return;
        }
        const closeMenu = () => setContextMenu(null);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                closeMenu();
            }
        };

        window.addEventListener("mousedown", closeMenu);
        window.addEventListener("scroll", closeMenu, true);
        window.addEventListener("resize", closeMenu);
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("mousedown", closeMenu);
            window.removeEventListener("scroll", closeMenu, true);
            window.removeEventListener("resize", closeMenu);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [contextMenu]);

    const contextMenuPosition = useMemo(() => {
        if (!contextMenu) {
            return null;
        }
        const menuWidth = 240;
        const menuHeight = 96;
        return {
            left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - menuWidth - 8)),
            top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - menuHeight - 8)),
        };
    }, [contextMenu]);

    if (images.length === 0 && !hasMore) {
        return (
            <div className="gallery-empty">
                <div className="gallery-empty-icon">
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        width="56"
                        height="56"
                    >
                        <path d="M3 7v10c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2h-6l-2-2H5c-1.1 0-2 .9-2 2z" />
                    </svg>
                </div>
                <h3>No images loaded</h3>
                <p>Select a folder to scan for AI-generated images</p>
            </div>
        );
    }

    return (
        <div ref={parentRef} className="gallery-container">
            <div
                style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                }}
            >
                {virtualItems.map((virtualRow) => {
                    const isLoaderRow = virtualRow.index >= rowCount;
                    const start = virtualRow.index * columnCount;
                    const end = Math.min(start + columnCount, images.length);

                    return (
                        <div
                            key={virtualRow.key}
                            className="gallery-row"
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                height: `${virtualRow.size}px`,
                                transform: `translateY(${virtualRow.start}px)`,
                                gridTemplateColumns: `repeat(${columnCount}, 1fr)`,
                            }}
                        >
                            {isLoaderRow ? (
                                <div
                                    style={{
                                        width: "100%",
                                        height: "100%",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        color: "var(--text-secondary)",
                                        gridColumn: "1 / -1",
                                    }}
                                >
                                    {isFetchingNextPage ? (
                                        <span className="spinner" />
                                    ) : (
                                        "Scroll for more"
                                    )}
                                </div>
                            ) : (
                                images.slice(start, end).map((image) => {
                                    const thumbnailPath =
                                        thumbnailCacheRef.current.get(image.filepath) ?? null;

                                    return (
                                        <GalleryItem
                                            key={image.id}
                                            image={image}
                                            thumbnailPath={thumbnailPath}
                                            isChecked={selectedIds.has(image.id)}
                                            onToggleChecked={() =>
                                                onToggleSelected(image.id)
                                            }
                                            isSelected={image.id === selectedId}
                                            onClick={() => onSelect(image)}
                                            onContextMenu={(event) =>
                                                openContextMenu(event, image)
                                            }
                                        />
                                    );
                                })
                            )}
                        </div>
                    );
                })}
            </div>
            {contextMenu && contextMenuPosition && (
                <div
                    className="image-context-menu"
                    style={{
                        left: contextMenuPosition.left,
                        top: contextMenuPosition.top,
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    <button
                        type="button"
                        className="image-context-menu-item"
                        onClick={handleContextCopy}
                    >
                        Compress + Copy for Discord
                    </button>
                    <button
                        type="button"
                        className="image-context-menu-item"
                        onClick={handleContextCopyJpeg}
                    >
                        Copy JPEG to Clipboard
                    </button>
                </div>
            )}
            {contextToast && <div className="image-context-toast">{contextToast}</div>}
        </div>
    );
}

function GalleryItem({
    image,
    thumbnailPath,
    isChecked,
    onToggleChecked,
    isSelected,
    onClick,
    onContextMenu,
}: {
    image: GalleryImageRecord;
    thumbnailPath: string | null;
    isChecked: boolean;
    onToggleChecked: () => void;
    isSelected: boolean;
    onClick: () => void;
    onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
    const [loaded, setLoaded] = useState(false);
    const imgSrc = thumbnailPath ? convertFileSrc(thumbnailPath) : null;

    return (
        <div
            className={`gallery-item ${isSelected ? "selected" : ""} ${
                isChecked ? "checked" : ""
            }`}
            onClick={onClick}
            onContextMenu={onContextMenu}
        >
            <label
                className="gallery-item-checkbox"
                onClick={(event) => event.stopPropagation()}
            >
                <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={onToggleChecked}
                    aria-label={`Select ${image.filename}`}
                />
            </label>
            <div className="gallery-item-image-wrapper">
                {!loaded && imgSrc && <div className="gallery-item-skeleton" />}
                {!imgSrc && (
                    <div
                        style={{
                            position: "absolute",
                            inset: 0,
                            background: "var(--bg-tertiary)",
                        }}
                    />
                )}
                {imgSrc && (
                    <img
                        src={imgSrc}
                        alt={image.filename}
                        loading="lazy"
                        decoding="async"
                        onLoad={() => setLoaded(true)}
                        onError={() => setLoaded(true)}
                        style={{ opacity: loaded ? 1 : 0 }}
                    />
                )}
            </div>
            <div className="gallery-item-info">
                <span className="gallery-item-filename" title={image.filename}>
                    {image.filename}
                </span>
                {image.model_name && (
                    <span className="gallery-item-model" title={image.model_name}>
                        {image.model_name}
                    </span>
                )}
                {image.seed && (
                    <span className="gallery-item-seed">Seed: {image.seed}</span>
                )}
            </div>
        </div>
    );
}
