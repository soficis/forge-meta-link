import {
    memo,
    useState,
    useRef,
    useCallback,
    useEffect,
    useMemo,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GalleryImageRecord } from "../types/metadata";
import type { StorageProfile, LineageCursor } from "../types/metadata";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getThumbnailPaths, getLineageCursor } from "../services/commands";
import { GalleryLineageHover } from "./GalleryLineageHover";
import {
    copyJpegImageToClipboard,
    copyCompressedImageForDiscord,
    formatBytes,
} from "../utils/imageClipboard";
import type { ShowToastOptions } from "../hooks/useToast";

interface GalleryProps {
    images: GalleryImageRecord[];
    onSelect: (image: GalleryImageRecord) => void;
    selectedId: number | null;
    selectedIds: Set<number>;
    onToggleSelected: (imageId: number) => void;
    /** Adds every id to the multi-selection (Shift-click / Shift+arrow ranges). */
    onAddToSelection: (imageIds: number[]) => void;
    onSelectAll: () => void;
    onClearSelection: () => void;
    onDeleteSelected: () => void;
    isDeletingSelected: boolean;
    onLoadMore: () => void;
    hasMore: boolean;
    isFetchingNextPage: boolean;
    columnCount: number;
    storageProfile: StorageProfile;
    onShowToast: (message: string, options?: ShowToastOptions) => void;
    emptyState: {
        title: string;
        message: string;
        action?: { label: string; onClick: () => void };
    };
}

const LINEAGE_LRU_LIMIT = 180;
const LINEAGE_DEBOUNCE_MS = 80;

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

function upsertLRU<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
    if (cache.has(key)) {
        cache.delete(key);
    }
    cache.set(key, value);
    while (cache.size > limit) {
        const oldest = cache.keys().next().value as K | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    const tagName = target.tagName.toLowerCase();
    return (
        tagName === "input" ||
        tagName === "textarea" ||
        target.isContentEditable
    );
}

function toAssetSrc(filepath: string, version?: number): string {
    const src = convertFileSrc(filepath.replace(/\\/g, "/"));
    return version ? `${src}?v=${version}` : src;
}

export function Gallery({
    images,
    onSelect,
    selectedId,
    selectedIds,
    onToggleSelected,
    onAddToSelection,
    onSelectAll,
    onClearSelection,
    onDeleteSelected,
    isDeletingSelected,
    onLoadMore,
    hasMore,
    isFetchingNextPage,
    columnCount,
    storageProfile,
    onShowToast,
    emptyState,
}: GalleryProps) {
    const parentRef = useRef<HTMLDivElement>(null);
    const thumbnailCacheRef = useRef<Map<string, string>>(new Map());
    const thumbnailInFlightRef = useRef<Set<string>>(new Set());
    const scrollRafRef = useRef<number | null>(null);
    const thumbFlushRafRef = useRef<number | null>(null);
    const [thumbnailVersion, setThumbnailVersion] = useState(0);
    // FV-02: virtualized scroll thumbnail cache hit/miss instrumentation
    const thumbnailStatsRef = useRef({ hits: 0, misses: 0, total: 0, batches: 0 });
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        image: GalleryImageRecord;
    } | null>(null);
    const thumbnailSettings = useMemo(
        () => profileThumbnailSettings(storageProfile),
        [storageProfile]
    );

    const lineageCacheRef = useRef<Map<string, LineageCursor>>(new Map());
    const [lineageVersion, setLineageVersion] = useState(0);
    const lineageDebounceRef = useRef<number | null>(null);
    const lineageSeqRef = useRef(0);
    const lineagePendingRef = useRef<string | null>(null);
    const hoverStayRef = useRef(false);
    const hoverLeaveTimerRef = useRef<number | null>(null);
    const [hoverTarget, setHoverTarget] = useState<{
        image: GalleryImageRecord;
        anchor: { left: number; top: number; width: number; height: number };
    } | null>(null);

    const filepathToImage = useMemo(() => {
        const m = new Map<string, GalleryImageRecord>();
        for (const img of images) m.set(img.filepath, img);
        return m;
    }, [images]);

    const hoverLineage = useMemo(() => {
        if (!hoverTarget) return null;
        void lineageVersion;
        return lineageCacheRef.current.get(hoverTarget.image.filepath) ?? null;
    }, [hoverTarget, lineageVersion]);

    const activeHoverCursor = hoverLineage;

    const scheduleLineageFetch = useCallback(
        (filepath: string) => {
            if (lineageCacheRef.current.has(filepath)) {
                return;
            }
            if (lineageDebounceRef.current != null) {
                window.clearTimeout(lineageDebounceRef.current);
                lineageDebounceRef.current = null;
            }
            lineagePendingRef.current = filepath;
            const seq = ++lineageSeqRef.current;
            lineageDebounceRef.current = window.setTimeout(async () => {
                lineageDebounceRef.current = null;
                const pending = lineagePendingRef.current;
                if (!pending || pending !== filepath) return;
                const t0 = performance.now();
                try {
                    const cursor = await getLineageCursor(pending);
                    if (seq !== lineageSeqRef.current) return;
                    if (lineagePendingRef.current !== pending) return;
                    upsertLRU(lineageCacheRef.current, pending, cursor, LINEAGE_LRU_LIMIT);
                    setLineageVersion((v) => v + 1);
                    const elapsed = performance.now() - t0;
                    if (elapsed > 150) {
                        console.warn(`[perf] lineage hover >150ms: ${elapsed.toFixed(1)}ms for ${pending}`);
                    }
                    const related = [
                        ...cursor.ancestors.map((e) => e.parent_filepath),
                        ...cursor.children.map((e) => e.child_filepath),
                    ];
                    const missing = related.filter(
                        (fp) => !thumbnailCacheRef.current.has(fp) && !thumbnailInFlightRef.current.has(fp)
                    );
                    if (missing.length > 0) {
                        const toFetch = missing.slice(0, 5);
                        for (const fp of toFetch) thumbnailInFlightRef.current.add(fp);
                        getThumbnailPaths(toFetch)
                            .then((mappings) => {
                                let changed = false;
                                for (const { filepath: fp, thumbnail_path } of mappings) {
                                    if (thumbnail_path !== fp) {
                                        const existing = thumbnailCacheRef.current.get(fp);
                                        if (existing !== thumbnail_path) {
                                            upsertThumbnailCache(
                                                thumbnailCacheRef.current,
                                                fp,
                                                thumbnail_path,
                                                thumbnailSettings.cacheLimit
                                            );
                                            changed = true;
                                        }
                                    }
                                    thumbnailInFlightRef.current.delete(fp);
                                }
                                if (changed) setThumbnailVersion((v) => v + 1);
                            })
                            .catch(() => {
                                for (const fp of toFetch) thumbnailInFlightRef.current.delete(fp);
                            });
                    }
                } catch (error) {
                    console.warn("getLineageCursor failed:", error);
                }
            }, LINEAGE_DEBOUNCE_MS);
        },
        [thumbnailSettings.cacheLimit]
    );

    const hoverTargetRef = useRef(hoverTarget);
    hoverTargetRef.current = hoverTarget;

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let mounted = true;

        listen("lineage-updated", () => {
            lineageCacheRef.current.clear();
            setLineageVersion((v) => v + 1);
            if (hoverTargetRef.current) {
                scheduleLineageFetch(hoverTargetRef.current.image.filepath);
            }
        })
            .then((fn) => {
                if (mounted) {
                    unlisten = fn;
                } else {
                    fn();
                }
            })
            .catch(() => {
                // ignore in non-tauri or test environments
            });

        return () => {
            mounted = false;
            if (unlisten) {
                unlisten();
            }
        };
    }, [scheduleLineageFetch]);

    const handleItemHoverEnter = useCallback(
        (image: GalleryImageRecord, anchorEl: HTMLElement) => {
            if (hoverLeaveTimerRef.current != null) {
                window.clearTimeout(hoverLeaveTimerRef.current);
                hoverLeaveTimerRef.current = null;
            }
            const rect = anchorEl.getBoundingClientRect();
            setHoverTarget({
                image,
                anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            });
            scheduleLineageFetch(image.filepath);
        },
        [scheduleLineageFetch]
    );

    const handleItemHoverLeave = useCallback(() => {
        if (hoverLeaveTimerRef.current != null) {
            window.clearTimeout(hoverLeaveTimerRef.current);
        }
        hoverLeaveTimerRef.current = window.setTimeout(() => {
            hoverLeaveTimerRef.current = null;
            if (!hoverStayRef.current) {
                setHoverTarget(null);
            }
        }, 60);
    }, []);

    const handleHoverCardEnter = useCallback(() => {
        hoverStayRef.current = true;
    }, []);
    const handleHoverCardLeave = useCallback(() => {
        hoverStayRef.current = false;
        setHoverTarget(null);
    }, []);

    const handleNavigateLineage = useCallback(
        (target: GalleryImageRecord) => {
            onSelect(target);
            setHoverTarget(null);
            hoverStayRef.current = false;
        },
        [onSelect]
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
    const virtualRangeKey = useMemo(
        () => virtualItems.map((v) => `${v.index}:${v.key}`).join(","),
        [virtualItems]
    );

    const prevVirtualRangeKeyRef = useRef(virtualRangeKey);
    useEffect(() => {
        if (prevVirtualRangeKeyRef.current !== virtualRangeKey) {
            prevVirtualRangeKeyRef.current = virtualRangeKey;
            lineageSeqRef.current += 1;
            if (lineageDebounceRef.current != null) {
                window.clearTimeout(lineageDebounceRef.current);
                lineageDebounceRef.current = null;
            }
            lineagePendingRef.current = null;
            if (hoverTarget) {
                const hoveredIdx = Math.floor(
                    images.findIndex((img) => img.id === hoverTarget.image.id) /
                        Math.max(1, columnCount)
                );
                const visible = virtualItems.some((v) => v.index === hoveredIdx);
                if (!visible) {
                    setHoverTarget(null);
                    hoverStayRef.current = false;
                }
            }
        }
    }, [virtualRangeKey, hoverTarget, images, columnCount, virtualItems]);

    useEffect(() => {
        virtualizer.measure();
    }, [columnCount, images.length, rowHeight, virtualizer]);

    // Keyboard cursor, separate from the image open in the viewer. Roving
    // tabindex: only the focused cell is tabbable, arrow keys move it.
    const [focusedIndex, setFocusedIndex] = useState(0);
    const selectionAnchorRef = useRef<number | null>(null);
    const pendingFocusRef = useRef<{ index: number; requestedAt: number } | null>(null);
    const clampedFocusedIndex = Math.min(focusedIndex, Math.max(0, images.length - 1));

    const focusCell = useCallback(
        (index: number) => {
            if (images.length === 0) return;
            const next = Math.max(0, Math.min(index, images.length - 1));
            setFocusedIndex(next);
            pendingFocusRef.current = { index: next, requestedAt: performance.now() };
            virtualizer.scrollToIndex(Math.floor(next / columnCount), { align: "auto" });
        },
        [columnCount, images.length, virtualizer]
    );

    // The target cell may not be rendered until the virtualizer scrolls to it.
    useEffect(() => {
        const pending = pendingFocusRef.current;
        if (pending == null) return;
        // Never yank focus long after the keypress (e.g. if the user scrolled away).
        if (performance.now() - pending.requestedAt > 1500) {
            pendingFocusRef.current = null;
            return;
        }
        const cell = parentRef.current?.querySelector<HTMLElement>(
            `[data-image-index="${pending.index}"]`
        );
        if (cell) {
            pendingFocusRef.current = null;
            cell.focus({ preventScroll: true });
        }
    });

    const rangeIds = useCallback(
        (from: number, to: number) => {
            const [start, end] = from <= to ? [from, to] : [to, from];
            return images.slice(start, end + 1).map((image) => image.id);
        },
        [images]
    );

    const handleItemClick = useCallback(
        (event: ReactMouseEvent<HTMLDivElement>, index: number, image: GalleryImageRecord) => {
            setFocusedIndex(index);
            if (event.shiftKey) {
                event.preventDefault();
                const anchor = selectionAnchorRef.current ?? index;
                onAddToSelection(rangeIds(anchor, index));
                return;
            }
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                selectionAnchorRef.current = index;
                onToggleSelected(image.id);
                return;
            }
            selectionAnchorRef.current = index;
            onSelect(image);
        },
        [onAddToSelection, onSelect, onToggleSelected, rangeIds]
    );

    const handleGridKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isTypingTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey) {
                return;
            }
            const visibleRows = Math.max(1, Math.floor((parentRef.current?.clientHeight ?? rowHeight) / rowHeight));
            const deltas: Record<string, number> = {
                ArrowRight: 1,
                ArrowLeft: -1,
                ArrowDown: columnCount,
                ArrowUp: -columnCount,
                PageDown: columnCount * visibleRows,
                PageUp: -columnCount * visibleRows,
            };
            let target: number | null = null;
            if (event.key in deltas) {
                target = clampedFocusedIndex + deltas[event.key];
            } else if (event.key === "Home") {
                target = 0;
            } else if (event.key === "End") {
                target = images.length - 1;
            }
            if (target == null) return;
            event.preventDefault();
            const next = Math.max(0, Math.min(target, images.length - 1));
            if (event.shiftKey) {
                const anchor = selectionAnchorRef.current ?? clampedFocusedIndex;
                selectionAnchorRef.current = anchor;
                onAddToSelection(rangeIds(anchor, next));
            } else {
                selectionAnchorRef.current = next;
            }
            focusCell(next);
        },
        [clampedFocusedIndex, columnCount, focusCell, images.length, onAddToSelection, rangeIds, rowHeight]
    );

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
            if (isTypingTarget(event.target)) {
                return;
            }

            if (hoverTarget && event.key === "Escape") {
                event.preventDefault();
                setHoverTarget(null);
                hoverStayRef.current = false;
                return;
            }

            if (event.key === "Escape" && selectedIds.size > 0) {
                event.preventDefault();
                onClearSelection();
                return;
            }
        };

        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [
        onClearSelection,
        onDeleteSelected,
        onSelectAll,
        isDeletingSelected,
        selectedIds,
        hoverTarget,
    ]);

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

        const cacheHits = thumbnailTargets.filter((fp) =>
            thumbnailCacheRef.current.has(fp)
        ).length;
        const cacheMisses = thumbnailTargets.length - cacheHits;
        thumbnailStatsRef.current.hits += cacheHits;
        thumbnailStatsRef.current.misses += cacheMisses;
        thumbnailStatsRef.current.total += thumbnailTargets.length;
        thumbnailStatsRef.current.batches += 1;
        if (thumbnailTargets.length > 0) {
            const windowMiss = thumbnailTargets.length
                ? (cacheMisses / thumbnailTargets.length) * 100
                : 0;
            const cumMiss =
                thumbnailStatsRef.current.total > 0
                    ? (thumbnailStatsRef.current.misses /
                          thumbnailStatsRef.current.total) *
                      100
                    : 0;
            const cumHit = 100 - cumMiss;
            console.log(
                `[thumb-cache] window hits=${cacheHits} misses=${cacheMisses} miss=${windowMiss.toFixed(1)}% cum hits=${thumbnailStatsRef.current.hits} misses=${thumbnailStatsRef.current.misses} hit=${cumHit.toFixed(1)}% miss=${cumMiss.toFixed(1)}% batches=${thumbnailStatsRef.current.batches}`
            );
            if (typeof window !== "undefined") {
                (window as unknown as Record<string, unknown>).__thumbCacheStats =
                    { ...thumbnailStatsRef.current, hitRate: cumHit, missRate: cumMiss };
            }
        }

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
        void Promise.allSettled(workers).then((results) => {
            if (cancelled) {
                return;
            }
            const rejected = results.filter((result) => result.status === "rejected");
            if (rejected.length > 0) {
                console.warn(
                    `Thumbnail batch workers reported ${rejected.length} rejection(s).`
                );
            }
        });

        return () => {
            cancelled = true;
        };
    }, [
        thumbnailSettings.cacheLimit,
        thumbnailSettings.chunkSize,
        thumbnailSettings.concurrency,
        thumbnailTargets,
    ]);

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
            onShowToast(
                `Copied ${mimeLabel} ${target.filename} (${result.width}x${result.height}, ${formatBytes(
                    result.bytes
                )})`,
                { tone: "success" }
            );
        } catch (error) {
            onShowToast(`Copy failed: ${String(error)}`, { tone: "error" });
        }
    }, [contextMenu, onShowToast]);

    const handleContextCopyJpeg = useCallback(async () => {
        if (!contextMenu) {
            return;
        }
        const target = contextMenu.image;
        setContextMenu(null);
        try {
            const result = await copyJpegImageToClipboard(target.filepath);
            const mimeLabel = result.mime.replace("image/", "").toUpperCase();
            onShowToast(
                `Copied ${mimeLabel} ${target.filename} (${result.width}x${result.height}, ${formatBytes(
                    result.bytes
                )})`,
                { tone: "success" }
            );
        } catch (error) {
            onShowToast(`JPEG copy failed: ${String(error)}`, { tone: "error" });
        }
    }, [contextMenu, onShowToast]);

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
                <h3>{emptyState.title}</h3>
                <p>{emptyState.message}</p>
                {emptyState.action && (
                    <button
                        type="button"
                        className="scan-button gallery-empty-action"
                        onClick={emptyState.action.onClick}
                    >
                        {emptyState.action.label}
                    </button>
                )}
            </div>
        );
    }

    return (
        <div
            ref={parentRef}
            className="gallery-container"
            role="grid"
            aria-label="Image gallery"
            aria-rowcount={rowCount}
            aria-colcount={columnCount}
            aria-multiselectable="true"
            onKeyDown={handleGridKeyDown}
            style={{ containerType: "inline-size", containerName: "gallery" } as React.CSSProperties}
        >
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
                            data-index={virtualRow.index}
                            ref={virtualizer.measureElement}
                            className="gallery-row"
                            role="row"
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${virtualRow.start}px)`,
                                gridTemplateColumns: `repeat(${columnCount}, 1fr)`,
                            }}
                        >
                            {isLoaderRow ? (
                                <div
                                    style={{
                                        width: "100%",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        color: "var(--text-secondary)",
                                        gridColumn: "1 / -1",
                                        minHeight: `${rowHeight}px`,
                                    }}
                                >
                                    {isFetchingNextPage ? (
                                        <span className="spinner" />
                                    ) : (
                                        "Scroll for more"
                                    )}
                                </div>
                            ) : (
                                images.slice(start, end).map((image, offset) => {
                                    const thumbnailPath =
                                        thumbnailCacheRef.current.get(image.filepath) ?? null;
                                    const index = start + offset;

                                    return (
                                        <GalleryItem
                                            key={image.id}
                                            image={image}
                                            index={index}
                                            isFocused={index === clampedFocusedIndex}
                                            thumbnailPath={thumbnailPath}
                                            thumbnailVersion={thumbnailVersion}
                                            isChecked={selectedIds.has(image.id)}
                                            onToggleChecked={() => {
                                                selectionAnchorRef.current = index;
                                                onToggleSelected(image.id);
                                            }}
                                            isSelected={image.id === selectedId}
                                            onOpen={() => onSelect(image)}
                                            onItemClick={(event) =>
                                                handleItemClick(event, index, image)
                                            }
                                            onItemFocus={() => setFocusedIndex(index)}
                                            onContextMenu={(event) =>
                                                openContextMenu(event, image)
                                            }
                                            onHoverEnter={handleItemHoverEnter}
                                            onHoverLeave={handleItemHoverLeave}
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
            {hoverTarget && (
                <GalleryLineageHover
                    image={hoverTarget.image}
                    cursor={activeHoverCursor}
                    anchor={hoverTarget.anchor}
                    filepathToImage={filepathToImage}
                    thumbnailCache={thumbnailCacheRef.current}
                    onNavigate={handleNavigateLineage}
                    onHoverEnter={handleHoverCardEnter}
                    onHoverLeave={handleHoverCardLeave}
                />
            )}
        </div>
    );
}

interface GalleryItemProps {
    image: GalleryImageRecord;
    index: number;
    isFocused: boolean;
    thumbnailPath: string | null;
    thumbnailVersion: number;
    isChecked: boolean;
    onToggleChecked: () => void;
    isSelected: boolean;
    onOpen: () => void;
    onItemClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
    onItemFocus: () => void;
    onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
    onHoverEnter: (image: GalleryImageRecord, anchorEl: HTMLElement) => void;
    onHoverLeave: () => void;
}

const GalleryItem = memo(function GalleryItem({
    image,
    index,
    isFocused,
    thumbnailPath,
    thumbnailVersion,
    isChecked,
    onToggleChecked,
    isSelected,
    onOpen,
    onItemClick,
    onItemFocus,
    onContextMenu,
    onHoverEnter,
    onHoverLeave,
}: GalleryItemProps) {
    const [thumbLoaded, setThumbLoaded] = useState(false);
    const [fullLoaded, setFullLoaded] = useState(false);
    const [thumbError, setThumbError] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const thumbSrc = thumbnailPath ? toAssetSrc(thumbnailPath, thumbnailVersion) : null;
    const fullSrc = toAssetSrc(image.filepath);
    const aspect = image.width && image.height ? `${image.width} / ${image.height}` : undefined;

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setFullLoaded(false);
        setThumbLoaded(false);
        setThumbError(false);
    }, [image.filepath, thumbnailPath, thumbnailVersion]);

    const handleEnter = useCallback(
        (_e: ReactMouseEvent<HTMLDivElement>) => {
            if (rootRef.current) onHoverEnter(image, rootRef.current);
        },
        [image, onHoverEnter]
    );

    return (
        <div
            ref={rootRef}
            className={`gallery-item ${isSelected ? "selected" : ""} ${
                isChecked ? "checked" : ""
            }`}
            onClick={onItemClick}
            onContextMenu={onContextMenu}
            onMouseEnter={handleEnter}
            onMouseLeave={onHoverLeave}
            onFocus={(e) => {
                onItemFocus();
                if (rootRef.current) onHoverEnter(image, rootRef.current);
                void e;
            }}
            onBlur={onHoverLeave}
            role="gridcell"
            aria-selected={isChecked}
            aria-current={isSelected ? "true" : undefined}
            aria-label={image.filename}
            data-image-id={image.id}
            data-image-index={index}
            tabIndex={isFocused ? 0 : -1}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    onOpen();
                    return;
                }
                if (event.key === " ") {
                    event.preventDefault();
                    onToggleChecked();
                }
            }}
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
            {(image.is_favorite || image.is_locked) && (
                <div className="gallery-item-badges" aria-hidden="true">
                    {image.is_favorite && (
                        <span className="gallery-item-badge favorite" title="Favorite">
                            ★
                        </span>
                    )}
                    {image.is_locked && (
                        <span className="gallery-item-badge locked" title="Locked">
                            🔒
                        </span>
                    )}
                </div>
            )}
            <div
                className="gallery-item-image-wrapper"
                style={aspect ? ({ aspectRatio: aspect } as React.CSSProperties) : undefined}
            >
                {!thumbLoaded && !fullLoaded && <div className="gallery-item-skeleton" />}
                {thumbSrc && !thumbError ? (
                    <img
                        src={thumbSrc}
                        alt={image.filename}
                        loading="eager"
                        decoding="async"
                        onLoad={() => setThumbLoaded(true)}
                        onError={() => {
                            setThumbError(true);
                            setThumbLoaded(false);
                        }}
                        className="gallery-thumb-img"
                        style={{ opacity: thumbLoaded ? 1 : 0 }}
                    />
                ) : (
                    <img
                        src={fullSrc}
                        alt={image.filename}
                        loading="eager"
                        decoding="async"
                        onLoad={() => setFullLoaded(true)}
                        onError={() => setFullLoaded(true)}
                        className="gallery-full-img"
                        style={{ opacity: fullLoaded ? 1 : 0 }}
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
});
