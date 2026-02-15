import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { save } from "@tauri-apps/plugin-dialog";
import { Gallery } from "./components/Gallery";
import { PhotoViewer } from "./components/PhotoViewer";
import { SearchBar } from "./components/SearchBar";
import { Sidebar } from "./components/Sidebar";
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
    exportImages,
    exportImagesAsFiles,
    forgeSendToImages,
    forgeTestConnection,
    getStorageProfile,
    onThumbnailCacheComplete,
    onThumbnailCacheProgress,
    precacheAllThumbnails,
    setStorageProfile,
} from "./services/commands";
import type {
    GenerationType,
    GalleryImageRecord,
    ImageExportFormat,
    SortOption,
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

function AppContent() {
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedImageId, setSelectedImageId] = useState<number | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [scanResult, setScanResult] = useState<{
        total_files: number;
        indexed: number;
        errors: number;
    } | null>(null);
    const [includeTags, setIncludeTags] = useState<string[]>([]);
    const [excludeTags, setExcludeTags] = useState<string[]>([]);
    const [booruTagFilterInput, setBooruTagFilterInput] = useState("");
    const [exportMessage, setExportMessage] = useState<string | null>(null);
    const [forgeStatusMessage, setForgeStatusMessage] = useState<string | null>(null);
    const [isTestingForge, setIsTestingForge] = useState(false);
    const [sortBy, setSortBy] = useState<SortOption>("newest");
    const [generationTypeFilter, setGenerationTypeFilter] = useState<
        GenerationType | "all"
    >("all");
    const [columnCount, setColumnCount] = useState(
        () => Number(localStorage.getItem("columnCount")) || 6
    );
    const [forgeBaseUrl, setForgeBaseUrl] = useState(
        () => localStorage.getItem("forgeBaseUrl") ?? "http://127.0.0.1:7860"
    );
    const [forgeApiKey, setForgeApiKey] = useState(
        () => localStorage.getItem("forgeApiKey") ?? ""
    );
    const [forgeOutputDir, setForgeOutputDir] = useState(
        () => {
            const saved = localStorage.getItem("forgeOutputDir");
            if (!saved) {
                return "";
            }
            const normalized = saved.trim().toLowerCase().replace(/\\/g, "/");
            if (normalized === "upscaled" || normalized === "./upscaled") {
                return "";
            }
            return saved;
        }
    );
    const [forgeModelsPath, setForgeModelsPath] = useState(
        () => localStorage.getItem("forgeModelsPath") ?? ""
    );
    const [forgeModelsScanSubfolders, setForgeModelsScanSubfolders] = useState(
        () => {
            const raw = localStorage.getItem("forgeModelsScanSubfolders");
            return raw == null ? true : raw === "true";
        }
    );
    const [forgeLoraPath, setForgeLoraPath] = useState(
        () => localStorage.getItem("forgeLoraPath") ?? ""
    );
    const [forgeLoraScanSubfolders, setForgeLoraScanSubfolders] = useState(() => {
        const raw = localStorage.getItem("forgeLoraScanSubfolders");
        return raw == null ? true : raw === "true";
    });
    const [forgeSelectedLoras, setForgeSelectedLoras] = useState<string[]>(() => {
        const raw = localStorage.getItem("forgeSelectedLoras");
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed)
                ? parsed.filter((value): value is string => typeof value === "string")
                : [];
        } catch {
            return [];
        }
    });
    const [forgeLoraWeight, setForgeLoraWeight] = useState(
        () => localStorage.getItem("forgeLoraWeight") ?? "1.0"
    );
    const [forgeIncludeSeed, setForgeIncludeSeed] = useState(() => {
        const raw = localStorage.getItem("forgeIncludeSeed");
        return raw == null ? true : raw === "true";
    });
    const [forgeAdetailerFaceEnabled, setForgeAdetailerFaceEnabled] = useState(() => {
        const raw = localStorage.getItem("forgeAdetailerFaceEnabled");
        return raw == null ? false : raw === "true";
    });
    const [forgeAdetailerFaceModel, setForgeAdetailerFaceModel] = useState(
        () => localStorage.getItem("forgeAdetailerFaceModel") ?? "face_yolov8n.pt"
    );
    const [isSendingForgeBatch, setIsSendingForgeBatch] = useState(false);
    const [selectedModelFilter, setSelectedModelFilter] = useState("");
    const [selectedLoraFilter, setSelectedLoraFilter] = useState("");
    const [selectedCheckpointFamilies, setSelectedCheckpointFamilies] = useState<string[]>(
        () => {
            const raw = localStorage.getItem("selectedCheckpointFamilies");
            if (!raw) {
                return [];
            }
            try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed)
                    ? parsed.filter(
                          (value): value is string =>
                              typeof value === "string" && value.trim().length > 0
                      )
                    : [];
            } catch {
                return [];
            }
        }
    );
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
        const raw = localStorage.getItem("isSidebarCollapsed");
        return raw == null ? false : raw === "true";
    });
    const [storageProfile, setStorageProfileState] =
        useState<StorageProfile>("hdd");
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
    const [thumbnailCacheMessage, setThumbnailCacheMessage] = useState<string | null>(
        null
    );

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
    const { progress: scanProgress, isScanning } = useScanProgress();

    useEffect(() => {
        localStorage.setItem("forgeBaseUrl", forgeBaseUrl);
    }, [forgeBaseUrl]);

    useEffect(() => {
        localStorage.setItem("forgeApiKey", forgeApiKey);
    }, [forgeApiKey]);

    useEffect(() => {
        localStorage.setItem("forgeOutputDir", forgeOutputDir);
    }, [forgeOutputDir]);

    useEffect(() => {
        localStorage.setItem("forgeModelsPath", forgeModelsPath);
    }, [forgeModelsPath]);

    useEffect(() => {
        localStorage.setItem(
            "forgeModelsScanSubfolders",
            String(forgeModelsScanSubfolders)
        );
    }, [forgeModelsScanSubfolders]);

    useEffect(() => {
        localStorage.setItem("forgeLoraPath", forgeLoraPath);
    }, [forgeLoraPath]);

    useEffect(() => {
        localStorage.setItem(
            "forgeLoraScanSubfolders",
            String(forgeLoraScanSubfolders)
        );
    }, [forgeLoraScanSubfolders]);

    useEffect(() => {
        localStorage.setItem("forgeSelectedLoras", JSON.stringify(forgeSelectedLoras));
    }, [forgeSelectedLoras]);

    useEffect(() => {
        localStorage.setItem("forgeLoraWeight", forgeLoraWeight);
    }, [forgeLoraWeight]);

    useEffect(() => {
        localStorage.setItem("forgeIncludeSeed", String(forgeIncludeSeed));
    }, [forgeIncludeSeed]);

    useEffect(() => {
        localStorage.setItem(
            "forgeAdetailerFaceEnabled",
            String(forgeAdetailerFaceEnabled)
        );
    }, [forgeAdetailerFaceEnabled]);

    useEffect(() => {
        localStorage.setItem("forgeAdetailerFaceModel", forgeAdetailerFaceModel);
    }, [forgeAdetailerFaceModel]);

    useEffect(() => {
        localStorage.setItem("columnCount", String(columnCount));
    }, [columnCount]);

    useEffect(() => {
        localStorage.setItem("isSidebarCollapsed", String(isSidebarCollapsed));
    }, [isSidebarCollapsed]);

    useEffect(() => {
        localStorage.setItem(
            "selectedCheckpointFamilies",
            JSON.stringify(selectedCheckpointFamilies)
        );
    }, [selectedCheckpointFamilies]);

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
                setThumbnailCacheMessage(null);
            });

            unlistenComplete = await onThumbnailCacheComplete((result) => {
                if (!active) return;
                setIsPrecachingThumbnails(false);
                setThumbnailCacheProgress(null);
                setThumbnailCacheResult(result);
                setThumbnailCacheMessage(
                    result.failed > 0
                        ? `Cache finished with ${result.failed} failures`
                        : "Thumbnail cache completed"
                );
            });
        };

        setupListeners();
        return () => {
            active = false;
            if (unlistenProgress) unlistenProgress();
            if (unlistenComplete) unlistenComplete();
        };
    }, []);

    const handleSearch = useCallback((query: string) => {
        setSearchQuery(query);
    }, []);

    const handleScan = useCallback(
        (directory: string) => {
            scanMutation.mutate(directory, {
                onSuccess: () => {
                    setScanResult(null);
                },
            });
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
        setThumbnailCacheMessage(null);
        setThumbnailCacheResult(null);
        try {
            await precacheAllThumbnails();
            setIsPrecachingThumbnails(true);
        } catch (error) {
            setIsPrecachingThumbnails(false);
            setThumbnailCacheMessage(`Failed to start cache: ${String(error)}`);
        }
    }, []);

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
    }, []);

    const clearCheckpointFamilyFilters = useCallback(() => {
        setSelectedCheckpointFamilies([]);
    }, []);

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
                setExportMessage(
                    `Exported ${result.exported_count} images to ${result.output_path}`
                );
            } catch (error) {
                setExportMessage(`Export failed: ${String(error)}`);
            }
        },
        [selectedIds]
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
                setExportMessage("Exporting...");
                const result = await exportImagesAsFiles(
                    Array.from(selectedIds),
                    format,
                    format === "original" ? null : quality,
                    outputPath
                );
                const sizeMB = (result.total_bytes / (1024 * 1024)).toFixed(1);
                setExportMessage(
                    `Exported ${result.exported_count} images (${sizeMB} MB)`
                );
            } catch (error) {
                setExportMessage(`Export failed: ${String(error)}`);
            }
        },
        [selectedIds]
    );

    const handleForgeTestConnection = useCallback(async () => {
        setIsTestingForge(true);
        try {
            const status = await forgeTestConnection(
                forgeBaseUrl,
                forgeApiKey.trim() ? forgeApiKey : null
            );
            setForgeStatusMessage(status.message);
        } catch (error) {
            setForgeStatusMessage(`Connection failed: ${String(error)}`);
        } finally {
            setIsTestingForge(false);
        }
    }, [forgeApiKey, forgeBaseUrl]);

    const handleForgeSendSelected = useCallback(async () => {
        if (selectedIds.size === 0) {
            setForgeStatusMessage("No images selected for Forge queue");
            return;
        }

        setIsSendingForgeBatch(true);
        setForgeStatusMessage(
            `Queueing ${selectedIds.size} image${selectedIds.size === 1 ? "" : "s"}...`
        );
        try {
            const result = await forgeSendToImages(
                Array.from(selectedIds),
                forgeBaseUrl,
                forgeApiKey.trim() ? forgeApiKey : null,
                forgeOutputDir.trim() ? forgeOutputDir : null,
                forgeIncludeSeed,
                forgeAdetailerFaceEnabled,
                forgeAdetailerFaceModel.trim() ? forgeAdetailerFaceModel : null,
                forgeSelectedLoras.length > 0 ? forgeSelectedLoras : null,
                forgeLoraWeight.trim() ? Number(forgeLoraWeight) : null,
                null
            );
            setForgeStatusMessage(result.message);
        } catch (error) {
            setForgeStatusMessage(`Forge queue failed: ${String(error)}`);
        } finally {
            setIsSendingForgeBatch(false);
        }
    }, [
        forgeApiKey,
        forgeAdetailerFaceEnabled,
        forgeAdetailerFaceModel,
        forgeBaseUrl,
        forgeIncludeSeed,
        forgeLoraWeight,
        forgeSelectedLoras,
        forgeOutputDir,
        selectedIds,
    ]);

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
                forgeBaseUrl={forgeBaseUrl}
                forgeApiKey={forgeApiKey}
                onForgeBaseUrlChange={setForgeBaseUrl}
                onForgeApiKeyChange={setForgeApiKey}
                forgeOutputDir={forgeOutputDir}
                onForgeOutputDirChange={setForgeOutputDir}
                forgeModelsPath={forgeModelsPath}
                onForgeModelsPathChange={setForgeModelsPath}
                forgeModelsScanSubfolders={forgeModelsScanSubfolders}
                onForgeModelsScanSubfoldersChange={setForgeModelsScanSubfolders}
                forgeLoraPath={forgeLoraPath}
                onForgeLoraPathChange={setForgeLoraPath}
                forgeLoraScanSubfolders={forgeLoraScanSubfolders}
                onForgeLoraScanSubfoldersChange={setForgeLoraScanSubfolders}
                forgeIncludeSeed={forgeIncludeSeed}
                onForgeIncludeSeedChange={setForgeIncludeSeed}
                forgeAdetailerFaceEnabled={forgeAdetailerFaceEnabled}
                onForgeAdetailerFaceEnabledChange={setForgeAdetailerFaceEnabled}
                forgeAdetailerFaceModel={forgeAdetailerFaceModel}
                onForgeAdetailerFaceModelChange={setForgeAdetailerFaceModel}
                onForgeTestConnection={handleForgeTestConnection}
                onForgeSendSelected={handleForgeSendSelected}
                forgeStatusMessage={forgeStatusMessage}
                isTestingForge={isTestingForge}
                isSendingForgeBatch={isSendingForgeBatch}
                operationMessage={exportMessage}
                columnCount={columnCount}
                onColumnCountChange={setColumnCount}
                storageProfile={storageProfile}
                onStorageProfileChange={handleStorageProfileChange}
                onPrecacheAllThumbnails={handlePrecacheAllThumbnails}
                isPrecachingThumbnails={isPrecachingThumbnails}
                thumbnailCacheProgress={thumbnailCacheProgress}
                thumbnailCacheResult={thumbnailCacheResult}
                thumbnailCacheMessage={thumbnailCacheMessage}
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
                        onLoadMore={handleLoadMore}
                        hasMore={hasNextPage ?? false}
                        isFetchingNextPage={isFetchingNextPage}
                        columnCount={columnCount}
                        storageProfile={storageProfile}
                    />
                )}
            </main>

            {selectedImageIndex >= 0 && (
                <PhotoViewer
                    images={viewerImageState.viewerImages}
                    currentIndex={selectedImageIndex}
                    onNavigate={handleNavigateViewer}
                    onClose={() => setSelectedImageId(null)}
                    forgeBaseUrl={forgeBaseUrl}
                    forgeApiKey={forgeApiKey}
                    forgeOutputDir={forgeOutputDir}
                    forgeModelsPath={forgeModelsPath}
                    forgeModelsScanSubfolders={forgeModelsScanSubfolders}
                    onForgeModelsPathChange={setForgeModelsPath}
                    onForgeModelsScanSubfoldersChange={
                        setForgeModelsScanSubfolders
                    }
                    forgeLoraPath={forgeLoraPath}
                    forgeLoraScanSubfolders={forgeLoraScanSubfolders}
                    onForgeLoraPathChange={setForgeLoraPath}
                    onForgeLoraScanSubfoldersChange={setForgeLoraScanSubfolders}
                    forgeSelectedLoras={forgeSelectedLoras}
                    onForgeSelectedLorasChange={setForgeSelectedLoras}
                    forgeLoraWeight={forgeLoraWeight}
                    onForgeLoraWeightChange={setForgeLoraWeight}
                    forgeIncludeSeed={forgeIncludeSeed}
                    forgeAdetailerFaceEnabled={forgeAdetailerFaceEnabled}
                    forgeAdetailerFaceModel={forgeAdetailerFaceModel}
                    onSearchBySeed={handleSearchBySeed}
                />
            )}
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
