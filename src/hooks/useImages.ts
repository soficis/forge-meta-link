import {
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
    filterImagesCursor,
    getDirectories,
    getImageTags,
    getModels,
    getTopTags,
    getTotalCount,
    getImagesCursor,
    listTags,
    scanDirectory,
    searchImagesCursor,
    onScanProgress,
    onScanComplete,
} from "../services/commands";
import type { ScanProgress } from "../services/commands";
import type { GenerationType, SortOption, StorageProfile } from "../types/metadata";

function pageSizeForProfile(profile: StorageProfile): number {
    const cpu = navigator.hardwareConcurrency || 8;
    if (profile === "hdd") {
        return Math.max(40, Math.min(100, cpu * 6));
    }
    return Math.max(80, Math.min(220, cpu * 12));
}

/**
 * Hook for fetching paginated images using cursor-based infinite scroll.
 * Automatically switches between get/search/filter modes based on arguments.
 */
export function useImages(
    query: string,
    includeTags: string[],
    excludeTags: string[],
    generationTypeFilter: GenerationType | "all",
    sortBy: SortOption = "newest",
    storageProfile: StorageProfile = "hdd",
    modelFilter: string = "",
    loraFilter: string = "",
    modelFamilyFilters: string[] = []
) {
    const normalizedLoraFilter = loraFilter
        .trim()
        .toLowerCase()
        .replace(/^lora:/, "");
    const resolvedLoraTag = normalizedLoraFilter
        ? `lora:${normalizedLoraFilter}`
        : "";
    const effectiveIncludeTags = resolvedLoraTag
        ? Array.from(new Set([...includeTags, resolvedLoraTag]))
        : includeTags;
    const hasTagFilters = effectiveIncludeTags.length > 0 || excludeTags.length > 0;
    const hasQuery = query.trim().length > 0;
    const pageSize = pageSizeForProfile(storageProfile);
    const generationTypes =
        generationTypeFilter === "all" ? null : [generationTypeFilter];
    const normalizedModelFamilyFilters = Array.from(
        new Set(
            modelFamilyFilters
                .map((value) => value.trim().toLowerCase())
                .filter((value) => value.length > 0)
        )
    ).sort((left, right) => left.localeCompare(right));

    return useInfiniteQuery({
        queryKey: [
            "images",
            query,
            effectiveIncludeTags,
            excludeTags,
            generationTypeFilter,
            sortBy,
            storageProfile,
            modelFilter,
            resolvedLoraTag,
            normalizedModelFamilyFilters,
        ],
        queryFn: async ({ pageParam }: { pageParam: string | null }) => {
            if (hasTagFilters) {
                return filterImagesCursor(
                    effectiveIncludeTags,
                    excludeTags,
                    hasQuery ? query : null,
                    pageParam,
                    pageSize,
                    generationTypes,
                    sortBy,
                    modelFilter.trim() ? modelFilter : null,
                    normalizedModelFamilyFilters.length > 0
                        ? normalizedModelFamilyFilters
                        : null
                );
            } else if (hasQuery) {
                return searchImagesCursor(
                    query,
                    pageParam,
                    pageSize,
                    generationTypes,
                    sortBy,
                    modelFilter.trim() ? modelFilter : null,
                    normalizedModelFamilyFilters.length > 0
                        ? normalizedModelFamilyFilters
                        : null
                );
            } else {
                return getImagesCursor(
                    pageParam,
                    pageSize,
                    sortBy,
                    generationTypes,
                    modelFilter.trim() ? modelFilter : null,
                    normalizedModelFamilyFilters.length > 0
                        ? normalizedModelFamilyFilters
                        : null
                );
            }
        },
        initialPageParam: null as string | null,
        getNextPageParam: (lastPage) => lastPage.next_cursor,
        staleTime: 30_000,
    });
}

/** Hook for the total image count. */
export function useTotalCount() {
    return useQuery({
        queryKey: ["totalCount"],
        queryFn: getTotalCount,
        staleTime: 60_000,
    });
}

/** Hook for triggering a directory scan. */
export function useScanDirectory() {
    return useMutation({
        mutationFn: (directory: string) => scanDirectory(directory),
    });
}

/**
 * Hook to listen for scan progress events.
 * Returns current progress state and whether a scan is active.
 */
export function useScanProgress() {
    const queryClient = useQueryClient();
    const [progress, setProgress] = useState<ScanProgress | null>(null);
    const [isScanning, setIsScanning] = useState(false);

    useEffect(() => {
        let unlistenProgress: (() => void) | undefined;
        let unlistenComplete: (() => void) | undefined;

        const setupListeners = async () => {
            unlistenProgress = await onScanProgress((payload) => {
                setIsScanning(true);
                setProgress(payload);
            });

            unlistenComplete = await onScanComplete(() => {
                setIsScanning(false);
                setProgress(null);

                // Refresh all data when scan completes
                queryClient.invalidateQueries({ queryKey: ["images"] });
                queryClient.invalidateQueries({ queryKey: ["totalCount"] });
                queryClient.invalidateQueries({ queryKey: ["topTags"] });
                queryClient.invalidateQueries({ queryKey: ["tagSuggestions"] });
                queryClient.invalidateQueries({ queryKey: ["directories"] });
                queryClient.invalidateQueries({ queryKey: ["models"] });
            });
        };

        setupListeners();

        return () => {
            if (unlistenProgress) unlistenProgress();
            if (unlistenComplete) unlistenComplete();
        };
    }, [queryClient]);

    return { progress, isScanning };
}

/** Hook for tag autocomplete suggestions. */
export function useTagSuggestions(prefix: string) {
    return useQuery({
        queryKey: ["tagSuggestions", prefix],
        queryFn: () => listTags(prefix.trim() ? prefix : null, 20),
        staleTime: 30_000,
    });
}

/** Hook for LoRA tag options used by search/filter UI. */
export function useLoraTags(limit: number = 500) {
    return useQuery({
        queryKey: ["loraTags", limit],
        queryFn: () => listTags("lora:", limit),
        staleTime: 30_000,
    });
}

/** Hook for top tags list. */
export function useTopTags(limit: number = 20) {
    return useQuery({
        queryKey: ["topTags", limit],
        queryFn: () => getTopTags(limit),
        staleTime: 30_000,
    });
}

/** Hook for fetching tags for a specific image. */
export function useImageTags(id: number) {
    return useQuery({
        queryKey: ["imageTags", id],
        queryFn: () => getImageTags(id),
        enabled: id > 0,
    });
}

/** Hook for directory grouping. */
export function useDirectories() {
    return useQuery({
        queryKey: ["directories"],
        queryFn: getDirectories,
        staleTime: 60_000,
    });
}

/** Hook for model grouping. */
export function useModels() {
    return useQuery({
        queryKey: ["models"],
        queryFn: getModels,
        staleTime: 60_000,
    });
}
