import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
    GalleryImageRecord,
    ImageRecord,
    TagCount,
    ExportResult,
    FileExportResult,
    DeleteImagesResult,
    DeleteMode,
    MoveImagesResult,
    ImageExportFormat,
    ThumbnailMapping,
    ForgeStatus,
    ForgeSendResult,
    ForgeBatchSendResult,
    ForgeOptionsResult,
    ForgePayloadOverrides,
    CursorPage,
    SidecarData,
    GenerationType,
    ModelEntry,
    SortOption,
    StorageProfile,
} from "../types/metadata";

// ── Directory Scanning ──────────────────────────────────────────────────

export interface ScanProgress {
    current: number;
    total: number;
    stage: "scanning" | "indexing" | "thumbnails";
    filename: string | null;
}

export interface ScanComplete {
    total_files: number;
    indexed: number;
    errors: number;
}

export interface ThumbnailCacheProgress {
    current: number;
    total: number;
    generated: number;
    skipped: number;
    failed: number;
    phase: "preparing" | "generating";
}

export interface ThumbnailCacheComplete {
    total: number;
    generated: number;
    skipped: number;
    failed: number;
}

export async function scanDirectory(directory: string): Promise<void> {
    return invoke<void>("scan_directory", { directory });
}

export async function getStorageProfile(): Promise<StorageProfile> {
    return invoke<StorageProfile>("get_storage_profile");
}

export async function setStorageProfile(profile: StorageProfile): Promise<void> {
    return invoke<void>("set_storage_profile", { profile });
}

export async function getForgeApiKey(): Promise<string> {
    return invoke<string>("get_forge_api_key");
}

export async function setForgeApiKey(apiKey: string): Promise<void> {
    return invoke<void>("set_forge_api_key", { apiKey });
}

export async function precacheAllThumbnails(): Promise<void> {
    return invoke<void>("precache_all_thumbnails");
}

export async function onScanProgress(
    callback: (progress: ScanProgress) => void
): Promise<UnlistenFn> {
    return listen<ScanProgress>("scan-progress", (event) => {
        callback(event.payload);
    });
}

export async function onScanComplete(
    callback: (result: ScanComplete) => void
): Promise<UnlistenFn> {
    return listen<ScanComplete>("scan-complete", (event) => {
        callback(event.payload);
    });
}

export async function onThumbnailCacheProgress(
    callback: (progress: ThumbnailCacheProgress) => void
): Promise<UnlistenFn> {
    return listen<ThumbnailCacheProgress>("thumbnail-cache-progress", (event) => {
        callback(event.payload);
    });
}

export async function onThumbnailCacheComplete(
    callback: (result: ThumbnailCacheComplete) => void
): Promise<UnlistenFn> {
    return listen<ThumbnailCacheComplete>("thumbnail-cache-complete", (event) => {
        callback(event.payload);
    });
}

// ── Image Queries ───────────────────────────────────────────────────────

export async function getImagesCursor(
    cursor: string | null,
    limit: number,
    sortBy?: SortOption | null,
    generationTypes?: GenerationType[] | null,
    modelFilter?: string | null,
    modelFamilyFilters?: string[] | null
): Promise<CursorPage<GalleryImageRecord>> {
    return invoke<CursorPage<GalleryImageRecord>>("get_images_cursor", {
        cursor,
        limit,
        sortBy: sortBy ?? null,
        generationTypes: generationTypes ?? null,
        modelFilter: modelFilter ?? null,
        modelFamilyFilters: modelFamilyFilters ?? null,
    });
}

export async function searchImagesCursor(
    query: string,
    cursor: string | null,
    limit: number,
    generationTypes?: GenerationType[] | null,
    sortBy?: SortOption | null,
    modelFilter?: string | null,
    modelFamilyFilters?: string[] | null
): Promise<CursorPage<GalleryImageRecord>> {
    return invoke<CursorPage<GalleryImageRecord>>("search_images_cursor", {
        request: {
            query,
            cursor,
            limit,
            generationTypes: generationTypes ?? null,
            sortBy: sortBy ?? null,
            modelFilter: modelFilter ?? null,
            modelFamilyFilters: modelFamilyFilters ?? null,
        },
    });
}

export async function filterImagesCursor(
    tagsInclude: string[],
    tagsExclude: string[],
    query: string | null,
    cursor: string | null,
    limit: number,
    generationTypes?: GenerationType[] | null,
    sortBy?: SortOption | null,
    modelFilter?: string | null,
    modelFamilyFilters?: string[] | null
): Promise<CursorPage<GalleryImageRecord>> {
    return invoke<CursorPage<GalleryImageRecord>>("filter_images_cursor", {
        request: {
            tagsInclude,
            tagsExclude,
            query,
            cursor,
            limit,
            generationTypes: generationTypes ?? null,
            sortBy: sortBy ?? null,
            modelFilter: modelFilter ?? null,
            modelFamilyFilters: modelFamilyFilters ?? null,
        },
    });
}

// ── Tags ────────────────────────────────────────────────────────────────

export async function listTags(
    prefix: string | null,
    limit: number
): Promise<string[]> {
    return invoke<string[]>("list_tags", { prefix, limit });
}

export async function getTopTags(limit: number): Promise<TagCount[]> {
    return invoke<TagCount[]>("get_top_tags", { limit });
}

// ── Image Detail ────────────────────────────────────────────────────────

export async function getImageDetail(
    id: number
): Promise<ImageRecord | null> {
    return invoke<ImageRecord | null>("get_image_detail", { id });
}

export async function getTotalCount(): Promise<number> {
    return invoke<number>("get_total_count");
}

export async function getDisplayImagePath(filepath: string): Promise<string> {
    return invoke<string>("get_display_image_path", { filepath });
}

export interface ClipboardImagePayload {
    base64: string;
    mime: string;
}

export async function getImageClipboardPayload(
    filepath: string
): Promise<ClipboardImagePayload> {
    return invoke<ClipboardImagePayload>("get_image_clipboard_payload", { filepath });
}

// ── Thumbnails ──────────────────────────────────────────────────────────

export async function getThumbnailPath(filepath: string): Promise<string> {
    return invoke<string>("get_thumbnail_path", { filepath });
}

/**
 * Batch-resolves thumbnail paths for multiple images in a single IPC call.
 * Generates thumbnails on-demand if missing.
 */
export async function getThumbnailPaths(
    filepaths: string[]
): Promise<ThumbnailMapping[]> {
    return invoke<ThumbnailMapping[]>("get_thumbnail_paths", { filepaths });
}

// ── Group-by Queries ────────────────────────────────────────────────────

export async function getModels(): Promise<ModelEntry[]> {
    return invoke<ModelEntry[]>("get_models");
}

// ── Shell / OS ──────────────────────────────────────────────────────────

export async function openFileLocation(filepath: string): Promise<void> {
    return invoke<void>("open_file_location", { filepath });
}

export async function directoryExists(path: string): Promise<boolean> {
    return invoke<boolean>("directory_exists", { path });
}

export async function deleteImages(
    ids: number[],
    mode: DeleteMode
): Promise<DeleteImagesResult> {
    return invoke<DeleteImagesResult>("delete_images", {
        request: {
            ids,
            mode,
        },
    });
}

export async function setImageFavorite(
    imageId: number,
    isFavorite: boolean
): Promise<void> {
    return invoke<void>("set_image_favorite", { imageId, isFavorite });
}

export async function setImagesFavorite(
    ids: number[],
    isFavorite: boolean
): Promise<number> {
    return invoke<number>("set_images_favorite", {
        request: {
            ids,
            isFavorite,
        },
    });
}

export async function setImageLocked(
    imageId: number,
    isLocked: boolean
): Promise<void> {
    return invoke<void>("set_image_locked", { imageId, isLocked });
}

export async function setImagesLocked(
    ids: number[],
    isLocked: boolean
): Promise<number> {
    return invoke<number>("set_images_locked", {
        request: {
            ids,
            isLocked,
        },
    });
}

export async function moveImagesToDirectory(
    ids: number[],
    destinationDirectory: string
): Promise<MoveImagesResult> {
    return invoke<MoveImagesResult>("move_images_to_directory", {
        request: {
            ids,
            destinationDirectory,
        },
    });
}

// ── Export ───────────────────────────────────────────────────────────────

export async function exportImages(
    ids: number[],
    format: string,
    outputPath: string
): Promise<ExportResult> {
    return invoke<ExportResult>("export_images", {
        ids,
        format,
        outputPath,
    });
}

export async function exportImagesAsFiles(
    ids: number[],
    format: ImageExportFormat,
    quality: number | null,
    outputPath: string
): Promise<FileExportResult> {
    return invoke<FileExportResult>("export_images_as_files", {
        ids,
        format,
        quality,
        outputPath,
    });
}

// ── Forge API Integration ───────────────────────────────────────────────

export async function forgeTestConnection(
    baseUrl: string,
    apiKey: string | null
): Promise<ForgeStatus> {
    return invoke<ForgeStatus>("forge_test_connection", { baseUrl, apiKey });
}

export async function forgeGetOptions(
    baseUrl: string,
    apiKey: string | null,
    modelsDir: string | null,
    scanSubfolders: boolean,
    lorasDir: string | null,
    lorasScanSubfolders: boolean
): Promise<ForgeOptionsResult> {
    return invoke<ForgeOptionsResult>("forge_get_options", {
        baseUrl,
        apiKey,
        modelsDir,
        scanSubfolders,
        lorasDir,
        lorasScanSubfolders,
    });
}

export async function forgeSendToImage(
    imageId: number,
    baseUrl: string,
    apiKey: string | null,
    outputDir: string | null,
    includeSeed: boolean,
    adetailerFaceEnabled: boolean,
    adetailerFaceModel: string | null,
    loraTokens: string[] | null,
    loraWeight: number | null,
    overrides: ForgePayloadOverrides | null
): Promise<ForgeSendResult> {
    return invoke<ForgeSendResult>("forge_send_to_image", {
        request: {
            imageId,
            options: {
                baseUrl,
                apiKey,
                outputDir,
                includeSeed,
                adetailerFaceEnabled,
                adetailerFaceModel,
                loraTokens,
                loraWeight,
                overrides,
            },
        },
    });
}

export async function forgeSendToImages(
    imageIds: number[],
    baseUrl: string,
    apiKey: string | null,
    outputDir: string | null,
    includeSeed: boolean,
    adetailerFaceEnabled: boolean,
    adetailerFaceModel: string | null,
    loraTokens: string[] | null,
    loraWeight: number | null,
    overrides: ForgePayloadOverrides | null
): Promise<ForgeBatchSendResult> {
    return invoke<ForgeBatchSendResult>("forge_send_to_images", {
        request: {
            imageIds,
            options: {
                baseUrl,
                apiKey,
                outputDir,
                includeSeed,
                adetailerFaceEnabled,
                adetailerFaceModel,
                loraTokens,
                loraWeight,
                overrides,
            },
        },
    });
}

// ── Sidecar Metadata ────────────────────────────────────────────────────

export async function getSidecarData(
    filepath: string
): Promise<SidecarData | null> {
    return invoke<SidecarData | null>("get_sidecar_data", { filepath });
}

export async function saveSidecarTags(
    filepath: string,
    tags: string[],
    notes: string | null
): Promise<void> {
    return invoke<void>("save_sidecar_tags", { filepath, tags, notes });
}
