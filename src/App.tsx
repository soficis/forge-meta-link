import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Gallery } from "./components/Gallery";
import { PhotoViewer } from "./components/PhotoViewer";
import { SearchBar } from "./components/SearchBar";
import { Sidebar } from "./components/Sidebar";
import { ToastHost } from "./components/ToastHost";
import { useAppSettings } from "./hooks/useAppSettings";
import { useForgeSettings } from "./hooks/useForgeSettings";
import { useToast, type ShowToastOptions } from "./hooks/useToast";
import {
    useImages,
    useLoraTags,
    useModels,
    useScanDirectory,
    useScanProgress,
    useTopTags,
    useTotalCount,
} from "./hooks/useImages";
import {
    deleteImages,
    exportImages,
    exportImagesAsFiles,
    forgeSendToImages,
    forgeTestConnection,
    getStorageProfile,
    moveImagesToDirectory,
    onThumbnailCacheComplete,
    onThumbnailCacheProgress,
    precacheAllThumbnails,
    setImageFavorite,
    setImageLocked,
    setImagesFavorite,
    setImagesLocked,
    setStorageProfile,
} from "./services/commands";
import type {
    DeleteMode,
    DeleteHistoryEntry,
    GalleryImageRecord,
    ImageExportFormat,
    StorageProfile,
} from "./types/metadata";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: 1,
            refetchOnWindowFocus: false,
        },
    },
});

const DELETE_UNDO_WINDOW_MS = 6000;

function parseBooruTagFilter(input: string): {
    include: string[];
    exclude: string[];
} {
    const include: string[] = [];
    const exclude: string[] = [];
    const seenInclude = new Set<string>();
    const seenExclude = new Set<string>();

    const tokenRegex = /"([^"]+)"|(\S+)/g;
    let match: RegExpExecArray | null = tokenRegex.exec(input);
    while (match) {
        const raw = (match[1] ?? match[2] ?? "").trim().toLowerCase();
        if (raw) {
            if (raw.startsWith("-") && raw.length > 1) {
                const token = raw.slice(1).trim();
                if (token && !seenExclude.has(token)) {
                    seenExclude.add(token);
                    exclude.push(token);
                }
            } else {
                const token = raw.startsWith("+") ? raw.slice(1).trim() : raw;
                if (token && !seenInclude.has(token)) {
                    seenInclude.add(token);
                    include.push(token);
                }
            }
        }
        match = tokenRegex.exec(input);
    }

    return {
        include: include.filter((token) => !seenExclude.has(token)),
        exclude,
    };
}

const JPEG_EXTENSIONS = new Set(["jpg", "jpeg", "jpe"]);

function getRecordExtension(image: GalleryImageRecord): string {
    const source = image.filename || image.filepath || "";
    const filename = source.replace(/\\/g, "/").split("/").pop() ?? source;
    const dot = filename.lastIndexOf(".");
    if (dot <= 0 || dot === filename.length - 1) {
        return "";
    }
    return filename.slice(dot + 1).toLowerCase();
}

function isJpegRecord(image: GalleryImageRecord): boolean {
    return JPEG_EXTENSIONS.has(getRecordExtension(image));
}

function getViewerDedupKey(image: GalleryImageRecord): string {
    const source = image.filename || image.filepath || "";
    const filename = source.replace(/\\/g, "/").split("/").pop() ?? source;
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const directory = (image.directory || "").replace(/\\/g, "/").toLowerCase();
    return `${directory}|${stem.toLowerCase()}`;
}

function buildJpegPreferredViewerState(images: GalleryImageRecord[]): {
    viewerImages: GalleryImageRecord[];
    idToViewerIndex: Map<number, number>;
} {
    const viewerImages: GalleryImageRecord[] = [];
    const idToViewerIndex = new Map<number, number>();
    const keyToViewerIndex = new Map<string, number>();

    for (const image of images) {
        const key = getViewerDedupKey(image);
        const existingIndex = keyToViewerIndex.get(key);

        if (existingIndex == null) {
            const nextIndex = viewerImages.length;
            viewerImages.push(image);
            keyToViewerIndex.set(key, nextIndex);
            idToViewerIndex.set(image.id, nextIndex);
            continue;
        }

        const existing = viewerImages[existingIndex];
        const shouldReplace = isJpegRecord(image) && !isJpegRecord(existing);
        if (shouldReplace) {
            viewerImages[existingIndex] = image;
            idToViewerIndex.set(existing.id, existingIndex);
        }
        idToViewerIndex.set(image.id, existingIndex);
    }

    return {
        viewerImages,
        idToViewerIndex,
    };
}

interface PendingDeleteOperation {
    activityId: number;
    ids: number[];
    removedItems: Array<{ image: GalleryImageRecord; index: number }>;
    selectedBefore: number[];
    selectedImageIdBefore: number | null;
    mode: DeleteMode;
    timerId: number;
}

function AppContent() {
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedImageId, setSelectedImageId] = useState<number | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [includeTags, setIncludeTags] = useState<string[]>([]);
    const [excludeTags, setExcludeTags] = useState<string[]>([]);
    const [booruTagFilterInput, setBooruTagFilterInput] = useState("");
    const [isTestingForge, setIsTestingForge] = useState(false);
    const [isSendingForgeBatch, setIsSendingForgeBatch] = useState(false);
    const [isDeletingImages, setIsDeletingImages] = useState(false);
    const [isMovingImages, setIsMovingImages] = useState(false);
    const [isUpdatingSelectionMarks, setIsUpdatingSelectionMarks] = useState(false);
    const [storageProfile, setStorageProfileState] =
        useState<StorageProfile>("hdd");
    const { toast, showToast, clearToast } = useToast();

    const forge = useForgeSettings();
    const {
        columnCount,
        setColumnCount,
        isSidebarCollapsed,
        setIsSidebarCollapsed,
        sortBy,
        setSortBy,
        generationTypeFilter,
        setGenerationTypeFilter,
        selectedModelFilter,
        setSelectedModelFilter,
        selectedLoraFilter,
        setSelectedLoraFilter,
        selectedCheckpointFamilies,
        setSelectedCheckpointFamilies,
        deleteMode,
        setDeleteMode,
        autoLockFavorites,
        setAutoLockFavorites,
    } = useAppSettings();
    const [isPrecachingThumbnails, setIsPrecachingThumbnails] = useState(false);
    const [thumbnailCacheProgress, setThumbnailCacheProgress] = useState<{
        current: number;
        total: number;
        generated: number;
        skipped: number;
        failed: number;
        phase: "preparing" | "generating";
    } | null>(null);
    const [thumbnailCacheResult, setThumbnailCacheResult] = useState<{
        total: number;
        generated: number;
        skipped: number;
        failed: number;
    } | null>(null);
    const pendingDeleteRef = useRef<PendingDeleteOperation | null>(null);
    const [deleteHistory, setDeleteHistory] = useState<DeleteHistoryEntry[]>([]);
    const deleteHistoryIdRef = useRef(0);

    const pushToast = useCallback(
        (message: string, options?: ShowToastOptions) => {
            showToast(message, options);
        },
        [showToast]
    );

    const appendDeleteHistory = useCallback(
        (mode: DeleteMode, count: number, summary: string): number => {
            deleteHistoryIdRef.current += 1;
            const id = deleteHistoryIdRef.current;
            setDeleteHistory((previous) =>
                [
                    {
                        id,
                        mode,
                        count,
                        status: "pending" as const,
                        summary,
                        createdAt: Date.now(),
                        completedAt: null,
                    },
                    ...previous,
                ].slice(0, 40)
            );
            return id;
        },
        []
    );

    const updateDeleteHistory = useCallback(
        (
            id: number,
            status: DeleteHistoryEntry["status"],
            summary: string
        ) => {
            setDeleteHistory((previous) =>
                previous.map((entry) =>
                    entry.id === id
                        ? {
                              ...entry,
                              status,
                              summary,
                              completedAt:
                                  status === "pending" ? entry.completedAt : Date.now(),
                          }
                        : entry
                )
            );
        },
        []
    );

    const clearDeleteHistory = useCallback(() => {
        setDeleteHistory([]);
    }, []);

    const {
        data,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        isLoading,
    } = useImages(
        searchQuery,
        includeTags,
        excludeTags,
        generationTypeFilter,
        sortBy,
        storageProfile,
        selectedModelFilter,
        selectedLoraFilter,
        selectedCheckpointFamilies
    );

    const querySignature = useMemo(
        () =>
            [
                searchQuery.trim(),
                selectedModelFilter,
                selectedLoraFilter,
                selectedCheckpointFamilies
                    .slice()
                    .sort((left, right) => left.localeCompare(right))
                    .join("\u0001"),
                includeTags.join("\u0001"),
                excludeTags.join("\u0001"),
                generationTypeFilter,
                sortBy,
            ].join("\u0002"),
        [
            excludeTags,
            generationTypeFilter,
            includeTags,
            selectedCheckpointFamilies,
            selectedLoraFilter,
            searchQuery,
            selectedModelFilter,
            sortBy,
        ]
    );
    const [images, setImages] = useState<GalleryImageRecord[]>([]);
    const pageAccumulatorRef = useRef<{
        signature: string;
        pageCount: number;
    }>({
        signature: querySignature,
        pageCount: 0,
    });

    useEffect(() => {
        setImages([]);
        pageAccumulatorRef.current = { signature: querySignature, pageCount: 0 };
    }, [querySignature]);

    const dedupeImages = useCallback((records: GalleryImageRecord[]) => {
        const seen = new Set<number>();
        const deduped: GalleryImageRecord[] = [];
        for (const record of records) {
            if (seen.has(record.id)) {
                continue;
            }
            seen.add(record.id);
            deduped.push(record);
        }
        return deduped;
    }, []);

    useEffect(() => {
        if (!data?.pages) {
            setImages([]);
            pageAccumulatorRef.current = { signature: querySignature, pageCount: 0 };
            return;
        }

        const tracker = pageAccumulatorRef.current;
        const pageCount = data.pages.length;
        const isQueryChanged = tracker.signature !== querySignature;
        const hasPageReset = pageCount < tracker.pageCount;

        if (isQueryChanged || hasPageReset) {
            setImages(dedupeImages(data.pages.flatMap((page) => page.items)));
            pageAccumulatorRef.current = {
                signature: querySignature,
                pageCount,
            };
            return;
        }

        if (pageCount === tracker.pageCount) {
            return;
        }

        const appended = data.pages
            .slice(tracker.pageCount)
            .flatMap((page) => page.items);

        setImages((prev) =>
            appended.length > 0 ? dedupeImages(prev.concat(appended)) : prev
        );
        pageAccumulatorRef.current = {
            signature: querySignature,
            pageCount,
        };
    }, [data, dedupeImages, querySignature]);

    const viewerImageState = useMemo(
        () => buildJpegPreferredViewerState(images),
        [images]
    );

    const selectedImageIndex = useMemo(() => {
        if (selectedImageId == null) {
            return -1;
        }
        return viewerImageState.idToViewerIndex.get(selectedImageId) ?? -1;
    }, [selectedImageId, viewerImageState]);

    const { data: totalCount = 0 } = useTotalCount();
    const { data: topTags = [] } = useTopTags(200);
    const { data: models = [] } = useModels();
    const { data: loraTags = [] } = useLoraTags(1000);

    const scanMutation = useScanDirectory();
    const { progress: scanProgress, scanResult, isScanning } = useScanProgress();


    useEffect(() => {
        let cancelled = false;

        const loadStorageProfile = async () => {
            try {
                const profile = await getStorageProfile();
                if (!cancelled) {
                    setStorageProfileState(profile);
                }
            } catch (error) {
                console.warn("Failed to load storage profile:", error);
            }
        };

        loadStorageProfile();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let active = true;
        let unlistenProgress: (() => void) | undefined;
        let unlistenComplete: (() => void) | undefined;

        const setupListeners = async () => {
            unlistenProgress = await onThumbnailCacheProgress((progress) => {
                if (!active) return;
                setIsPrecachingThumbnails(true);
                setThumbnailCacheProgress(progress);
                setThumbnailCacheResult(null);
            });

            unlistenComplete = await onThumbnailCacheComplete((result) => {
                if (!active) return;
                setIsPrecachingThumbnails(false);
                setThumbnailCacheProgress(null);
                setThumbnailCacheResult(result);
                pushToast(
                    result.failed > 0
                        ? `Thumbnail cache finished with ${result.failed} failed file${result.failed === 1 ? "" : "s"}.`
                        : "Thumbnail cache completed.",
                    { tone: result.failed > 0 ? "warning" : "success" }
                );
            });
        };

        setupListeners();
        return () => {
            active = false;
            if (unlistenProgress) unlistenProgress();
            if (unlistenComplete) unlistenComplete();
        };
    }, [pushToast]);

    const handleSearch = useCallback((query: string) => {
        setSearchQuery(query);
    }, []);

    const handleScan = useCallback(
        (directory: string) => {
            scanMutation.mutate(directory);
        },
        [scanMutation]
    );

    const handleStorageProfileChange = useCallback(
        async (profile: StorageProfile) => {
            try {
                await setStorageProfile(profile);
                setStorageProfileState(profile);
            } catch (error) {
                console.warn("Failed to update storage profile:", error);
            }
        },
        []
    );

    const handlePrecacheAllThumbnails = useCallback(async () => {
        setThumbnailCacheResult(null);
        try {
            await precacheAllThumbnails();
            setIsPrecachingThumbnails(true);
        } catch (error) {
            setIsPrecachingThumbnails(false);
            pushToast(`Failed to start thumbnail cache: ${String(error)}`, {
                tone: "error",
            });
        }
    }, [pushToast]);

    const handleLoadMore = useCallback(() => {
        if (hasNextPage && !isFetchingNextPage) {
            fetchNextPage();
        }
    }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

    // O(1) Set-based selection toggle
    const toggleSelected = useCallback((imageId: number) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(imageId)) {
                next.delete(imageId);
            } else {
                next.add(imageId);
            }
            return next;
        });
    }, []);

    const selectAll = useCallback(() => {
        setSelectedIds(new Set(images.map((image) => image.id)));
    }, [images]);

    const clearSelection = useCallback(() => {
        setSelectedIds(new Set());
    }, []);

    const invalidateImageQueries = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ["images"] });
        queryClient.invalidateQueries({ queryKey: ["totalCount"] });
        queryClient.invalidateQueries({ queryKey: ["topTags"] });
        queryClient.invalidateQueries({ queryKey: ["models"] });
    }, []);

    const finalizeDeleteOperation = useCallback(
        async (operation: PendingDeleteOperation) => {
            setIsDeletingImages(true);
            try {
                const result = await deleteImages(operation.ids, operation.mode);
                invalidateImageQueries();

                const deletedLabel =
                    operation.mode === "trash" ? "Moved to Trash" : "Deleted";
                if (result.removed_from_db > 0) {
                    pushToast(
                        `${deletedLabel} ${result.removed_from_db} image${
                            result.removed_from_db === 1 ? "" : "s"
                        }.`,
                        {
                            tone:
                                result.failed_files > 0 || result.blocked_protected > 0
                                    ? "warning"
                                    : "success",
                        }
                    );
                    updateDeleteHistory(
                        operation.activityId,
                        "finalized",
                        `${deletedLabel} ${result.removed_from_db} image${
                            result.removed_from_db === 1 ? "" : "s"
                        }${result.failed_files > 0 ? ` (${result.failed_files} failed)` : ""}.`
                    );
                } else {
                    pushToast("No images were deleted.", { tone: "warning" });
                    updateDeleteHistory(
                        operation.activityId,
                        "finalized",
                        "No images were deleted."
                    );
                }

                if (result.blocked_protected > 0) {
                    pushToast(
                        `Skipped ${result.blocked_protected} protected image${
                            result.blocked_protected === 1 ? "" : "s"
                        }. Unlock or unfavorite them first.`,
                        { tone: "warning", durationMs: 4200 }
                    );
                }

                if (result.failed_files > 0) {
                    const firstFailure = result.failed_paths[0] ?? "unknown path";
                    pushToast(
                        `Failed to delete ${result.failed_files} file${
                            result.failed_files === 1 ? "" : "s"
                        } (e.g. ${firstFailure}).`,
                        { tone: "error", durationMs: 5200 }
                    );
                }
            } catch (error) {
                pushToast(`Delete failed: ${String(error)}`, { tone: "error" });
                updateDeleteHistory(
                    operation.activityId,
                    "failed",
                    `Delete failed: ${String(error)}`
                );
                setImages((previous) => {
                    const existing = new Set(previous.map((image) => image.id));
                    const next = [...previous];
                    const ordered = operation.removedItems
                        .slice()
                        .sort((left, right) => left.index - right.index);
                    for (const { image, index } of ordered) {
                        if (existing.has(image.id)) {
                            continue;
                        }
                        next.splice(Math.min(index, next.length), 0, image);
                        existing.add(image.id);
                    }
                    return next;
                });
                setSelectedIds((previous) => {
                    const next = new Set(previous);
                    for (const id of operation.selectedBefore) {
                        next.add(id);
                    }
                    return next;
                });
                if (operation.selectedImageIdBefore != null) {
                    setSelectedImageId(operation.selectedImageIdBefore);
                }
            } finally {
                setIsDeletingImages(false);
            }
        },
        [invalidateImageQueries, pushToast, updateDeleteHistory]
    );

    const undoPendingDelete = useCallback(() => {
        const pending = pendingDeleteRef.current;
        if (!pending) {
            return;
        }
        window.clearTimeout(pending.timerId);
        pendingDeleteRef.current = null;

        setImages((previous) => {
            const existing = new Set(previous.map((image) => image.id));
            const next = [...previous];
            const ordered = pending.removedItems
                .slice()
                .sort((left, right) => left.index - right.index);
            for (const { image, index } of ordered) {
                if (existing.has(image.id)) {
                    continue;
                }
                next.splice(Math.min(index, next.length), 0, image);
                existing.add(image.id);
            }
            return next;
        });
        setSelectedIds((previous) => {
            const next = new Set(previous);
            for (const id of pending.selectedBefore) {
                next.add(id);
            }
            return next;
        });
        if (pending.selectedImageIdBefore != null) {
            setSelectedImageId(pending.selectedImageIdBefore);
        }

        updateDeleteHistory(pending.activityId, "undone", "Deletion undone.");
        pushToast("Deletion undone.", { tone: "success", durationMs: 2200 });
    }, [pushToast, updateDeleteHistory]);

    const flushPendingDelete = useCallback(async () => {
        const pending = pendingDeleteRef.current;
        if (!pending) {
            return;
        }
        window.clearTimeout(pending.timerId);
        pendingDeleteRef.current = null;
        await finalizeDeleteOperation(pending);
    }, [finalizeDeleteOperation]);

    const scheduleDelete = useCallback(
        async (
            ids: number[],
            confirmMessage: string,
            fallbackViewerImageId: number | null = null
        ) => {
            const requestedIds = Array.from(new Set(ids));
            if (requestedIds.length === 0 || isDeletingImages || isMovingImages) {
                return;
            }
            await flushPendingDelete();
            if (!window.confirm(confirmMessage)) {
                return;
            }

            const requestedSet = new Set(requestedIds);
            const protectedRecords = images.filter(
                (image) =>
                    requestedSet.has(image.id) &&
                    (image.is_locked || image.is_favorite)
            );
            const protectedIds = protectedRecords
                .map((image) => image.id);
            const protectedSet = new Set(protectedIds);
            const deletableIds = requestedIds.filter((id) => !protectedSet.has(id));

            if (protectedRecords.length > 0) {
                const lockedOnly = protectedRecords.filter(
                    (image) => image.is_locked && !image.is_favorite
                ).length;
                const favoriteOnly = protectedRecords.filter(
                    (image) => image.is_favorite && !image.is_locked
                ).length;
                const lockedAndFavorite = protectedRecords.filter(
                    (image) => image.is_locked && image.is_favorite
                ).length;
                const reasons: string[] = [];
                if (lockedOnly > 0) {
                    reasons.push(`${lockedOnly} locked`);
                }
                if (favoriteOnly > 0) {
                    reasons.push(`${favoriteOnly} favorited`);
                }
                if (lockedAndFavorite > 0) {
                    reasons.push(`${lockedAndFavorite} locked+favorited`);
                }
                pushToast(
                    `Skipped ${protectedRecords.length} protected image${
                        protectedRecords.length === 1 ? "" : "s"
                    } (${reasons.join(", ")}).`,
                    { tone: "warning", durationMs: 4200 }
                );
            }
            if (deletableIds.length === 0) {
                return;
            }

            const deletedSet = new Set(deletableIds);
            const removedItems = images
                .map((image, index) => ({ image, index }))
                .filter(({ image }) => deletedSet.has(image.id));
            if (removedItems.length === 0) {
                return;
            }

            const selectedBefore = deletableIds.filter((id) => selectedIds.has(id));
            const selectedImageIdBefore = selectedImageId;

            setImages((previous) =>
                previous.filter((image) => !deletedSet.has(image.id))
            );
            setSelectedIds((previous) => {
                const next = new Set(previous);
                for (const id of deletableIds) {
                    next.delete(id);
                }
                return next;
            });
            setSelectedImageId((previous) => {
                if (previous == null || !deletedSet.has(previous)) {
                    return previous;
                }
                return fallbackViewerImageId;
            });

            const timerId = window.setTimeout(() => {
                const pending = pendingDeleteRef.current;
                if (!pending || pending.timerId !== timerId) {
                    return;
                }
                pendingDeleteRef.current = null;
                void finalizeDeleteOperation(pending);
            }, DELETE_UNDO_WINDOW_MS);

            const actionPrefix = deleteMode === "trash" ? "Move to Trash" : "Delete";
            const activityId = appendDeleteHistory(
                deleteMode,
                deletableIds.length,
                `${actionPrefix} ${deletableIds.length} image${
                    deletableIds.length === 1 ? "" : "s"
                } (pending undo)`
            );

            pendingDeleteRef.current = {
                activityId,
                ids: deletableIds,
                removedItems,
                selectedBefore,
                selectedImageIdBefore,
                mode: deleteMode,
                timerId,
            };

            pushToast(
                `${
                    deleteMode === "trash"
                        ? `Queued ${deletableIds.length} image${
                              deletableIds.length === 1 ? "" : "s"
                          } for Trash.`
                        : `Queued ${deletableIds.length} image${
                              deletableIds.length === 1 ? "" : "s"
                          } for permanent deletion.`
                }`,
                {
                    tone: "warning",
                    durationMs: DELETE_UNDO_WINDOW_MS,
                    actionLabel: "Undo",
                    onAction: undoPendingDelete,
                }
            );
        },
        [
            deleteMode,
            finalizeDeleteOperation,
            flushPendingDelete,
            isDeletingImages,
            isMovingImages,
            images,
            appendDeleteHistory,
            pushToast,
            selectedIds,
            selectedImageId,
            undoPendingDelete,
        ]
    );

    useEffect(() => {
        return () => {
            const pending = pendingDeleteRef.current;
            if (!pending) {
                return;
            }
            window.clearTimeout(pending.timerId);
        };
    }, []);

    const handleDeleteSelected = useCallback(async () => {
        if (selectedIds.size === 0) {
            pushToast("Select images to delete first.", { tone: "warning" });
            return;
        }
        const ids = Array.from(selectedIds);
        const actionLabel =
            deleteMode === "trash" ? "move to Trash" : "permanently delete";
        await scheduleDelete(
            ids,
            `${
                deleteMode === "trash" ? "Move" : "Delete"
            } ${ids.length} selected image${
                ids.length === 1 ? "" : "s"
            } from disk (${actionLabel})?`,
        );
    }, [deleteMode, pushToast, scheduleDelete, selectedIds]);

    const handleDeleteImageFromViewer = useCallback(
        async (image: GalleryImageRecord) => {
            const viewerImages = viewerImageState.viewerImages;
            const index = viewerImages.findIndex((entry) => entry.id === image.id);
            let fallbackViewerImageId: number | null = null;
            if (index >= 0 && viewerImages.length > 1) {
                const fallbackIndex =
                    index < viewerImages.length - 1 ? index + 1 : index - 1;
                fallbackViewerImageId = viewerImages[fallbackIndex]?.id ?? null;
            }

            const actionLabel =
                deleteMode === "trash" ? "move to Trash" : "permanently delete";
            await scheduleDelete(
                [image.id],
                `${
                    deleteMode === "trash" ? "Move" : "Delete"
                } ${image.filename} from disk (${actionLabel})?`,
                fallbackViewerImageId
            );
        },
        [deleteMode, scheduleDelete, viewerImageState]
    );

    const handleMoveSelectedToFolder = useCallback(async () => {
        if (selectedIds.size === 0) {
            pushToast("Select images to move first.", { tone: "warning" });
            return;
        }
        if (isDeletingImages || isMovingImages || isUpdatingSelectionMarks) {
            return;
        }

        const selected = await open({
            directory: true,
            multiple: false,
            title: "Move selected images to folder",
        });
        if (!selected || typeof selected !== "string") {
            return;
        }
        await flushPendingDelete();

        const ids = Array.from(selectedIds);
        setIsMovingImages(true);
        try {
            const result = await moveImagesToDirectory(ids, selected);
            const movedById = new Map(
                result.moved_items.map((item) => [item.id, item] as const)
            );
            if (movedById.size > 0) {
                setImages((previous) =>
                    previous.map((entry) => {
                        const moved = movedById.get(entry.id);
                        if (!moved) {
                            return entry;
                        }
                        return {
                            ...entry,
                            filepath: moved.filepath,
                            filename: moved.filename,
                            directory: moved.directory,
                        };
                    })
                );
                invalidateImageQueries();
            }

            if (result.moved_files > 0) {
                pushToast(
                    `Moved ${result.moved_files} image${
                        result.moved_files === 1 ? "" : "s"
                    } to ${selected}.`,
                    { tone: result.failed > 0 ? "warning" : "success" }
                );
            } else if (result.skipped_same_directory > 0) {
                pushToast(
                    "Selected images are already in that folder.",
                    { tone: "warning" }
                );
            } else {
                pushToast("No images were moved.", { tone: "warning" });
            }

            if (result.failed > 0) {
                const firstFailure = result.failed_paths[0] ?? "unknown file";
                pushToast(
                    `Failed to move ${result.failed} image${
                        result.failed === 1 ? "" : "s"
                    } (e.g. ${firstFailure}).`,
                    { tone: "error", durationMs: 5200 }
                );
            }
        } catch (error) {
            pushToast(`Move failed: ${String(error)}`, { tone: "error" });
        } finally {
            setIsMovingImages(false);
        }
    }, [
        flushPendingDelete,
        invalidateImageQueries,
        isDeletingImages,
        isMovingImages,
        isUpdatingSelectionMarks,
        pushToast,
        selectedIds,
    ]);

    const handleBulkFavoriteSelected = useCallback(
        async (isFavorite: boolean) => {
            if (selectedIds.size === 0) {
                pushToast("Select images first.", { tone: "warning" });
                return;
            }
            if (isDeletingImages || isMovingImages || isUpdatingSelectionMarks) {
                return;
            }

            const selectedSet = new Set(selectedIds);
            const selectedRecords = images.filter((image) => selectedSet.has(image.id));
            const previousById = new Map(
                selectedRecords.map((image) => [
                    image.id,
                    {
                        is_favorite: image.is_favorite,
                        is_locked: image.is_locked,
                    },
                ])
            );

            const favoriteTargetIds = selectedRecords
                .filter((image) => image.is_favorite !== isFavorite)
                .map((image) => image.id);
            const lockTargetIds =
                isFavorite && autoLockFavorites
                    ? selectedRecords
                          .filter((image) => !image.is_locked)
                          .map((image) => image.id)
                    : [];

            if (favoriteTargetIds.length === 0 && lockTargetIds.length === 0) {
                pushToast(
                    isFavorite
                        ? "Selected images are already favorited."
                        : "Selected images are already not favorited.",
                    { tone: "warning" }
                );
                return;
            }

            setIsUpdatingSelectionMarks(true);
            setImages((previous) =>
                previous.map((entry) => {
                    if (!selectedSet.has(entry.id)) {
                        return entry;
                    }
                    return {
                        ...entry,
                        is_favorite: isFavorite,
                        is_locked:
                            isFavorite && autoLockFavorites
                                ? true
                                : entry.is_locked,
                    };
                })
            );

            try {
                if (favoriteTargetIds.length > 0) {
                    await setImagesFavorite(favoriteTargetIds, isFavorite);
                }

                if (lockTargetIds.length > 0) {
                    try {
                        await setImagesLocked(lockTargetIds, true);
                    } catch (error) {
                        setImages((previous) =>
                            previous.map((entry) => {
                                const prior = previousById.get(entry.id);
                                if (!prior) {
                                    return entry;
                                }
                                return {
                                    ...entry,
                                    is_locked: prior.is_locked,
                                };
                            })
                        );
                        pushToast(
                            `Favorites updated, but auto-lock failed: ${String(error)}`,
                            { tone: "warning" }
                        );
                        return;
                    }
                }

                const affectedCount = new Set([
                    ...favoriteTargetIds,
                    ...lockTargetIds,
                ]).size;
                const message = isFavorite
                    ? `Favorited ${affectedCount} selected image${
                          affectedCount === 1 ? "" : "s"
                      }.`
                    : `Unfavorited ${affectedCount} selected image${
                          affectedCount === 1 ? "" : "s"
                      }.`;
                pushToast(message, { tone: "success", durationMs: 2400 });
            } catch (error) {
                setImages((previous) =>
                    previous.map((entry) => {
                        const prior = previousById.get(entry.id);
                        if (!prior) {
                            return entry;
                        }
                        return {
                            ...entry,
                            is_favorite: prior.is_favorite,
                            is_locked: prior.is_locked,
                        };
                    })
                );
                pushToast(`Bulk favorite update failed: ${String(error)}`, {
                    tone: "error",
                });
            } finally {
                setIsUpdatingSelectionMarks(false);
            }
        },
        [
            autoLockFavorites,
            images,
            isDeletingImages,
            isMovingImages,
            isUpdatingSelectionMarks,
            pushToast,
            selectedIds,
        ]
    );

    const handleBulkLockSelected = useCallback(
        async (isLocked: boolean) => {
            if (selectedIds.size === 0) {
                pushToast("Select images first.", { tone: "warning" });
                return;
            }
            if (isDeletingImages || isMovingImages || isUpdatingSelectionMarks) {
                return;
            }

            const selectedSet = new Set(selectedIds);
            const selectedRecords = images.filter((image) => selectedSet.has(image.id));
            const previousById = new Map(
                selectedRecords.map((image) => [image.id, image.is_locked])
            );
            const lockTargetIds = selectedRecords
                .filter((image) => image.is_locked !== isLocked)
                .map((image) => image.id);

            if (lockTargetIds.length === 0) {
                pushToast(
                    isLocked
                        ? "Selected images are already locked."
                        : "Selected images are already unlocked.",
                    { tone: "warning" }
                );
                return;
            }

            setIsUpdatingSelectionMarks(true);
            setImages((previous) =>
                previous.map((entry) =>
                    selectedSet.has(entry.id) ? { ...entry, is_locked: isLocked } : entry
                )
            );

            try {
                await setImagesLocked(lockTargetIds, isLocked);
                const message = isLocked
                    ? `Locked ${lockTargetIds.length} selected image${
                          lockTargetIds.length === 1 ? "" : "s"
                      }.`
                    : `Unlocked ${lockTargetIds.length} selected image${
                          lockTargetIds.length === 1 ? "" : "s"
                      }.`;
                pushToast(message, { tone: "success", durationMs: 2400 });
            } catch (error) {
                setImages((previous) =>
                    previous.map((entry) => {
                        const prior = previousById.get(entry.id);
                        if (prior == null) {
                            return entry;
                        }
                        return {
                            ...entry,
                            is_locked: prior,
                        };
                    })
                );
                pushToast(`Bulk lock update failed: ${String(error)}`, {
                    tone: "error",
                });
            } finally {
                setIsUpdatingSelectionMarks(false);
            }
        },
        [
            images,
            isDeletingImages,
            isMovingImages,
            isUpdatingSelectionMarks,
            pushToast,
            selectedIds,
        ]
    );

    const handleToggleFavorite = useCallback(
        async (image: GalleryImageRecord) => {
            const nextValue = !image.is_favorite;
            const shouldAutoLock =
                nextValue && autoLockFavorites && !image.is_locked;
            setImages((previous) =>
                previous.map((entry) =>
                    entry.id === image.id
                        ? {
                              ...entry,
                              is_favorite: nextValue,
                              is_locked:
                                  shouldAutoLock ? true : entry.is_locked,
                          }
                        : entry
                )
            );
            let favoriteSaved = false;
            try {
                await setImageFavorite(image.id, nextValue);
                favoriteSaved = true;
                if (shouldAutoLock) {
                    await setImageLocked(image.id, true);
                }
                pushToast(
                    nextValue
                        ? shouldAutoLock
                            ? "Added to favorites and auto-locked."
                            : "Added to favorites."
                        : "Removed from favorites.",
                    { tone: "success", durationMs: 2000 }
                );
            } catch (error) {
                if (favoriteSaved) {
                    setImages((previous) =>
                        previous.map((entry) =>
                            entry.id === image.id
                                ? {
                                      ...entry,
                                      is_favorite: nextValue,
                                      is_locked: image.is_locked,
                                  }
                                : entry
                        )
                    );
                    pushToast(
                        `Favorite saved, but auto-lock failed: ${String(error)}`,
                        { tone: "warning" }
                    );
                    return;
                }

                setImages((previous) =>
                    previous.map((entry) =>
                        entry.id === image.id
                            ? {
                                  ...entry,
                                  is_favorite: image.is_favorite,
                                  is_locked: image.is_locked,
                              }
                            : entry
                    )
                );
                pushToast(`Favorite update failed: ${String(error)}`, { tone: "error" });
            }
        },
        [autoLockFavorites, pushToast]
    );

    const handleToggleLocked = useCallback(
        async (image: GalleryImageRecord) => {
            const nextValue = !image.is_locked;
            setImages((previous) =>
                previous.map((entry) =>
                    entry.id === image.id ? { ...entry, is_locked: nextValue } : entry
                )
            );
            try {
                await setImageLocked(image.id, nextValue);
                pushToast(
                    nextValue
                        ? "Image locked from deletion."
                        : "Image unlocked.",
                    { tone: "success", durationMs: 2200 }
                );
            } catch (error) {
                setImages((previous) =>
                    previous.map((entry) =>
                        entry.id === image.id ? { ...entry, is_locked: image.is_locked } : entry
                    )
                );
                pushToast(`Lock update failed: ${String(error)}`, { tone: "error" });
            }
        },
        [pushToast]
    );

    const toggleCheckpointFamilyFilter = useCallback((family: string) => {
        const normalized = family.trim().toLowerCase();
        if (!normalized) {
            return;
        }
        setSelectedCheckpointFamilies((previous) => {
            if (previous.includes(normalized)) {
                return previous.filter((entry) => entry !== normalized);
            }
            return [...previous, normalized];
        });
    }, [setSelectedCheckpointFamilies]);

    const clearCheckpointFamilyFilters = useCallback(() => {
        setSelectedCheckpointFamilies([]);
    }, [setSelectedCheckpointFamilies]);

    const addTag = useCallback(
        (kind: "include" | "exclude", tag: string) => {
            const normalized = tag.trim().toLowerCase();
            if (!normalized) return;

            if (kind === "include") {
                setIncludeTags((prev) =>
                    prev.includes(normalized) ? prev : [...prev, normalized]
                );
                setExcludeTags((prev) => prev.filter((value) => value !== normalized));
            } else {
                setExcludeTags((prev) =>
                    prev.includes(normalized) ? prev : [...prev, normalized]
                );
                setIncludeTags((prev) => prev.filter((value) => value !== normalized));
            }
        },
        []
    );

    const handleApplyBooruTagFilter = useCallback((rawFilter: string) => {
        const parsed = parseBooruTagFilter(rawFilter);
        setIncludeTags(parsed.include);
        setExcludeTags(parsed.exclude);
        setBooruTagFilterInput(rawFilter);
    }, []);

    const handleClearTagFilters = useCallback(() => {
        setIncludeTags([]);
        setExcludeTags([]);
        setBooruTagFilterInput("");
    }, []);

    const handleExportSelected = useCallback(
        async (format: "json" | "csv") => {
            if (selectedIds.size === 0) {
                return;
            }

            const outputPath = await save({
                title: `Export ${format.toUpperCase()}`,
                defaultPath: `ForgeMetaLink-export.${format}`,
            });
            if (!outputPath || typeof outputPath !== "string") {
                return;
            }

            try {
                const result = await exportImages(
                    Array.from(selectedIds),
                    format,
                    outputPath
                );
                pushToast(
                    `Exported ${result.exported_count} image${result.exported_count === 1 ? "" : "s"} to ${result.output_path}`,
                    { tone: "success" }
                );
            } catch (error) {
                pushToast(`Export failed: ${String(error)}`, { tone: "error" });
            }
        },
        [pushToast, selectedIds]
    );

    const handleExportAsFiles = useCallback(
        async (format: ImageExportFormat, quality: number) => {
            if (selectedIds.size === 0) {
                return;
            }

            const ext = format === "original" ? "zip" : `${format}.zip`;
            const outputPath = await save({
                title: `Export Images as ${format === "original" ? "ZIP" : format.toUpperCase()}`,
                defaultPath: `ForgeMetaLink-images.${ext}`,
                filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
            });
            if (!outputPath || typeof outputPath !== "string") {
                return;
            }

            try {
                pushToast("Export started…", { tone: "info", durationMs: 1800 });
                const result = await exportImagesAsFiles(
                    Array.from(selectedIds),
                    format,
                    format === "original" ? null : quality,
                    outputPath
                );
                const sizeMB = (result.total_bytes / (1024 * 1024)).toFixed(1);
                pushToast(
                    `Exported ${result.exported_count} image${result.exported_count === 1 ? "" : "s"} (${sizeMB} MB).`,
                    { tone: "success" }
                );
            } catch (error) {
                pushToast(`Export failed: ${String(error)}`, { tone: "error" });
            }
        },
        [pushToast, selectedIds]
    );

    const handleForgeTestConnection = useCallback(async () => {
        setIsTestingForge(true);
        try {
            const status = await forgeTestConnection(
                forge.forgeBaseUrl,
                forge.forgeApiKey.trim() ? forge.forgeApiKey : null
            );
            pushToast(status.message, { tone: status.ok ? "success" : "warning" });
        } catch (error) {
            pushToast(`Connection failed: ${String(error)}`, { tone: "error" });
        } finally {
            setIsTestingForge(false);
        }
    }, [forge.forgeApiKey, forge.forgeBaseUrl, pushToast]);

    const handleForgeSendSelected = useCallback(async () => {
        if (selectedIds.size === 0) {
            pushToast("No images selected for Forge queue.", { tone: "warning" });
            return;
        }

        const parsedLoraWeight = forge.forgeLoraWeight.trim()
            ? Number(forge.forgeLoraWeight)
            : null;
        if (
            parsedLoraWeight != null &&
            (!Number.isFinite(parsedLoraWeight) ||
                parsedLoraWeight < 0 ||
                parsedLoraWeight > 2)
        ) {
            pushToast("LoRA weight must be between 0 and 2 before queueing.", {
                tone: "error",
            });
            return;
        }

        setIsSendingForgeBatch(true);
        pushToast(
            `Queueing ${selectedIds.size} image${selectedIds.size === 1 ? "" : "s"}...`,
            { tone: "info", durationMs: 1800 }
        );
        try {
            const result = await forgeSendToImages(
                Array.from(selectedIds),
                forge.forgeBaseUrl,
                forge.forgeApiKey.trim() ? forge.forgeApiKey : null,
                forge.forgeOutputDir.trim() ? forge.forgeOutputDir : null,
                forge.forgeIncludeSeed,
                forge.forgeAdetailerFaceEnabled,
                forge.forgeAdetailerFaceModel.trim() ? forge.forgeAdetailerFaceModel : null,
                forge.forgeSelectedLoras.length > 0 ? forge.forgeSelectedLoras : null,
                parsedLoraWeight,
                null
            );
            pushToast(result.message, { tone: result.failed > 0 ? "warning" : "success" });
        } catch (error) {
            pushToast(`Forge queue failed: ${String(error)}`, { tone: "error" });
        } finally {
            setIsSendingForgeBatch(false);
        }
    }, [forge, pushToast, selectedIds]);

    const handleNavigateViewer = useCallback(
        (index: number) => {
            const nextImage = viewerImageState.viewerImages[index];
            if (nextImage) {
                setSelectedImageId(nextImage.id);
            }
        },
        [viewerImageState]
    );

    const handleSearchBySeed = useCallback((seed: string) => {
        const normalized = seed.trim();
        if (!normalized) {
            return;
        }
        setSearchQuery(normalized);
        setSelectedImageId(null);
    }, []);

    const modelFilterOptions = useMemo(
        () =>
            models
                .map((entry) => entry.model_name)
                .filter((value): value is string => typeof value === "string" && value.length > 0)
                .sort((left, right) => left.localeCompare(right)),
        [models]
    );

    const loraFilterOptions = useMemo(
        () =>
            loraTags
                .filter(
                    (value): value is string =>
                        typeof value === "string" && value.startsWith("lora:")
                )
                .sort((left, right) => left.localeCompare(right)),
        [loraTags]
    );

    const hasSearchQuery = searchQuery.trim().length > 0;
    const hasSidebarTagFilters = includeTags.length > 0 || excludeTags.length > 0;
    const hasFilterControls =
        generationTypeFilter !== "all" ||
        selectedModelFilter.trim().length > 0 ||
        selectedLoraFilter.trim().length > 0 ||
        selectedCheckpointFamilies.length > 0;
    const hasAnyFilters = hasSearchQuery || hasSidebarTagFilters || hasFilterControls;

    const galleryEmptyState = useMemo(() => {
        if (totalCount === 0) {
            return {
                title: "No images loaded",
                message: "Select a folder to scan for AI-generated images.",
            };
        }

        if (hasSearchQuery) {
            return {
                title: "No images match your search",
                message: "Try broader keywords or clear search terms.",
            };
        }

        if (hasAnyFilters) {
            return {
                title: "No images match current filters",
                message: "Clear tags or model filters to widen results.",
            };
        }

        return {
            title: "No images available",
            message: "Rescan your folder if images should appear here.",
        };
    }, [hasAnyFilters, hasSearchQuery, totalCount]);

    const isGalleryMutationInFlight =
        isDeletingImages || isMovingImages || isUpdatingSelectionMarks;

    return (
        <div className="app-layout">
            <Sidebar
                isCollapsed={isSidebarCollapsed}
                onToggleCollapsed={() =>
                    setIsSidebarCollapsed((previous) => !previous)
                }
                onScan={handleScan}
                isScanning={isScanning}
                scanProgress={scanProgress}
                scanResult={scanResult}
                includeTags={includeTags}
                excludeTags={excludeTags}
                topTags={topTags}
                onAddIncludeTag={(tag) => addTag("include", tag)}
                booruTagFilterInput={booruTagFilterInput}
                onBooruTagFilterInputChange={setBooruTagFilterInput}
                onApplyBooruTagFilter={handleApplyBooruTagFilter}
                onClearTagFilters={handleClearTagFilters}
                checkpointFamilyFilters={selectedCheckpointFamilies}
                onToggleCheckpointFamilyFilter={toggleCheckpointFamilyFilter}
                onClearCheckpointFamilyFilters={clearCheckpointFamilyFilters}
                selectedCount={selectedIds.size}
                onExportSelected={handleExportSelected}
                onExportAsFiles={handleExportAsFiles}
                onMoveSelectedToFolder={handleMoveSelectedToFolder}
                isMovingSelected={isMovingImages}
                onBulkFavoriteSelected={() => handleBulkFavoriteSelected(true)}
                onBulkUnfavoriteSelected={() => handleBulkFavoriteSelected(false)}
                onBulkLockSelected={() => handleBulkLockSelected(true)}
                onBulkUnlockSelected={() => handleBulkLockSelected(false)}
                isApplyingSelectionActions={isGalleryMutationInFlight}
                autoLockFavorites={autoLockFavorites}
                onAutoLockFavoritesChange={setAutoLockFavorites}
                recentDeleteHistory={deleteHistory}
                onClearDeleteHistory={clearDeleteHistory}
                forgeBaseUrl={forge.forgeBaseUrl}
                forgeApiKey={forge.forgeApiKey}
                onForgeBaseUrlChange={forge.setForgeBaseUrl}
                onForgeApiKeyChange={forge.setForgeApiKey}
                forgeOutputDir={forge.forgeOutputDir}
                onForgeOutputDirChange={forge.setForgeOutputDir}
                forgeModelsPath={forge.forgeModelsPath}
                onForgeModelsPathChange={forge.setForgeModelsPath}
                forgeModelsScanSubfolders={forge.forgeModelsScanSubfolders}
                onForgeModelsScanSubfoldersChange={forge.setForgeModelsScanSubfolders}
                forgeLoraPath={forge.forgeLoraPath}
                onForgeLoraPathChange={forge.setForgeLoraPath}
                forgeLoraScanSubfolders={forge.forgeLoraScanSubfolders}
                onForgeLoraScanSubfoldersChange={forge.setForgeLoraScanSubfolders}
                forgeIncludeSeed={forge.forgeIncludeSeed}
                onForgeIncludeSeedChange={forge.setForgeIncludeSeed}
                forgeAdetailerFaceEnabled={forge.forgeAdetailerFaceEnabled}
                onForgeAdetailerFaceEnabledChange={forge.setForgeAdetailerFaceEnabled}
                forgeAdetailerFaceModel={forge.forgeAdetailerFaceModel}
                onForgeAdetailerFaceModelChange={forge.setForgeAdetailerFaceModel}
                onForgeTestConnection={handleForgeTestConnection}
                onForgeSendSelected={handleForgeSendSelected}
                isTestingForge={isTestingForge}
                isSendingForgeBatch={isSendingForgeBatch}
                columnCount={columnCount}
                onColumnCountChange={setColumnCount}
                storageProfile={storageProfile}
                onStorageProfileChange={handleStorageProfileChange}
                onPrecacheAllThumbnails={handlePrecacheAllThumbnails}
                isPrecachingThumbnails={isPrecachingThumbnails}
                thumbnailCacheProgress={thumbnailCacheProgress}
                thumbnailCacheResult={thumbnailCacheResult}
            />

            <main className="main-content">
                <SearchBar
                    searchValue={searchQuery}
                    onSearch={handleSearch}
                    totalCount={totalCount}
                    resultCount={images.length}
                    sortBy={sortBy}
                    onSortChange={setSortBy}
                    generationTypeFilter={generationTypeFilter}
                    onGenerationTypeChange={setGenerationTypeFilter}
                    selectedCount={selectedIds.size}
                    onSelectAll={selectAll}
                    onDeselectAll={clearSelection}
                    onDeleteSelected={handleDeleteSelected}
                    isDeletingSelected={isGalleryMutationInFlight}
                    deleteMode={deleteMode}
                    onDeleteModeChange={setDeleteMode}
                    modelFilter={selectedModelFilter}
                    modelOptions={modelFilterOptions}
                    onModelFilterChange={setSelectedModelFilter}
                    loraFilter={selectedLoraFilter}
                    loraOptions={loraFilterOptions}
                    onLoraFilterChange={setSelectedLoraFilter}
                />

                {isLoading && images.length === 0 ? (
                    <div className="loading-state">
                        <div className="spinner large" />
                        <p>Loading images...</p>
                    </div>
                ) : (
                    <Gallery
                        images={images}
                        onSelect={(image) => setSelectedImageId(image.id)}
                        selectedId={selectedImageId}
                        selectedIds={selectedIds}
                        onToggleSelected={toggleSelected}
                        onSelectAll={selectAll}
                        onClearSelection={clearSelection}
                        onDeleteSelected={handleDeleteSelected}
                        isDeletingSelected={isGalleryMutationInFlight}
                        onLoadMore={handleLoadMore}
                        hasMore={hasNextPage ?? false}
                        isFetchingNextPage={isFetchingNextPage}
                        columnCount={columnCount}
                        storageProfile={storageProfile}
                        onShowToast={pushToast}
                        emptyState={galleryEmptyState}
                    />
                )}
            </main>

            {selectedImageIndex >= 0 && (
                <PhotoViewer
                    images={viewerImageState.viewerImages}
                    currentIndex={selectedImageIndex}
                    onNavigate={handleNavigateViewer}
                    onClose={() => setSelectedImageId(null)}
                    forgeBaseUrl={forge.forgeBaseUrl}
                    forgeApiKey={forge.forgeApiKey}
                    forgeOutputDir={forge.forgeOutputDir}
                    forgeModelsPath={forge.forgeModelsPath}
                    forgeModelsScanSubfolders={forge.forgeModelsScanSubfolders}
                    onForgeModelsPathChange={forge.setForgeModelsPath}
                    onForgeModelsScanSubfoldersChange={
                        forge.setForgeModelsScanSubfolders
                    }
                    forgeLoraPath={forge.forgeLoraPath}
                    forgeLoraScanSubfolders={forge.forgeLoraScanSubfolders}
                    onForgeLoraPathChange={forge.setForgeLoraPath}
                    onForgeLoraScanSubfoldersChange={forge.setForgeLoraScanSubfolders}
                    forgeSelectedLoras={forge.forgeSelectedLoras}
                    onForgeSelectedLorasChange={forge.setForgeSelectedLoras}
                    forgeLoraWeight={forge.forgeLoraWeight}
                    onForgeLoraWeightChange={forge.setForgeLoraWeight}
                    forgeIncludeSeed={forge.forgeIncludeSeed}
                    forgeAdetailerFaceEnabled={forge.forgeAdetailerFaceEnabled}
                    forgeAdetailerFaceModel={forge.forgeAdetailerFaceModel}
                    onSearchBySeed={handleSearchBySeed}
                    onDeleteCurrentImage={handleDeleteImageFromViewer}
                    isDeletingCurrentImage={isGalleryMutationInFlight}
                    deleteMode={deleteMode}
                    onToggleFavorite={handleToggleFavorite}
                    onToggleLocked={handleToggleLocked}
                    onShowToast={pushToast}
                />
            )}

            <ToastHost toast={toast} onDismiss={clearToast} />
        </div>
    );
}

function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <AppContent />
        </QueryClientProvider>
    );
}

export default App;
