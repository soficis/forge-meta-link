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
    LineageCursor,
    LineageTrace,
    TagProvenance,
    PromptEntry,
    SavePromptResult,
    ImportPromptsResult,
    PromptTagCount,
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

export async function precacheAllThumbnails(force?: boolean): Promise<void> {
    return invoke<void>("precache_all_thumbnails", { force: Boolean(force) });
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

export async function onForgeImagesIngested(
    callback: (paths: string[]) => void
): Promise<UnlistenFn> {
    return listen<string[]>("forge-images-ingested", (event) => {
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

/** Per-send options that are not part of the recorded generation params. */
export interface ForgeSendExtras {
    /** Weight per LoRA token; a token with no entry uses the default loraWeight. */
    loraWeights?: Record<string, number> | null;
    /** Images generated per request (Forge n_iter). */
    batchCount?: number | null;
    /** Also let Forge keep its own copy in its outputs folder. */
    saveForgeCopy?: boolean;
    /** User confirmation to send API key over unencrypted remote HTTP. */
    confirmUnencrypted?: boolean | null;
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
    overrides: Partial<ForgePayloadOverrides> | null,
    mutationOps: unknown | null = null,
    extras: ForgeSendExtras = {}
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
                loraWeights: extras.loraWeights ?? null,
                batchCount: extras.batchCount ?? null,
                saveForgeCopy: extras.saveForgeCopy ?? false,
                overrides,
                mutationOps,
                confirmUnencrypted: extras.confirmUnencrypted ?? null,
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
    overrides: Partial<ForgePayloadOverrides> | null,
    mutationOps: unknown | null = null,
    extras: ForgeSendExtras = {}
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
                loraWeights: extras.loraWeights ?? null,
                batchCount: extras.batchCount ?? null,
                saveForgeCopy: extras.saveForgeCopy ?? false,
                overrides,
                mutationOps,
                confirmUnencrypted: extras.confirmUnencrypted ?? null,
            },
        },
    });
}

export async function forgeRequeueImage(
    imageId: number,
    baseUrl: string,
    apiKey: string | null,
    includeSeed = true,
    confirmUnencrypted: boolean | null = null
): Promise<ForgeSendResult> {
    return invoke<ForgeSendResult>("forge_requeue_image", {
        request: { imageId, baseUrl, apiKey, includeSeed, confirmUnencrypted },
    });
}

export interface ForgeUpscaleOptions {
    imageId: number;
    baseUrl: string;
    apiKey: string | null;
    upscaler: string;
    scale: number;
    outputDir?: string | null;
}

export interface ForgeUpscaleResult {
    ok: boolean;
    message: string;
    childId: number | null;
    savedPath: string | null;
    outputDir: string;
}

export async function forgeGetUpscalers(
    baseUrl: string,
    apiKey: string | null
): Promise<string[]> {
    return invoke<string[]>("forge_get_upscalers", { baseUrl, apiKey });
}

export async function forgeUpscaleImage(
    options: ForgeUpscaleOptions
): Promise<ForgeUpscaleResult> {
    return invoke<ForgeUpscaleResult>("forge_upscale_image", { request: options });
}

// ── Timeline (file_mtime histogram) ─────────────────────────────────────

export async function getFileMtimes(limit = 50000, offset = 0): Promise<number[]> {
    return invoke<number[]>("get_file_mtimes", { limit, offset });
}

export async function getFileMtimesForQuery(query: string, limit = 50000): Promise<number[]> {
    return invoke<number[]>("get_file_mtimes_for_query", { query, limit });
}

// ── Lineage (API-01) ─────────────────────────────────────────────────────

export async function getLineageCursor(filepath: string): Promise<LineageCursor> {
    return invoke<LineageCursor>("get_lineage_cursor", { filepath });
}

export async function getLineageTrace(imageId: number): Promise<LineageTrace> {
    return invoke<LineageTrace>("get_lineage_trace", { imageId });
}

export async function getSeedWalk(
    seed: string,
    promptLike: string | null,
    limit = 16
): Promise<GalleryImageRecord[]> {
    return invoke<GalleryImageRecord[]>("get_seed_walk", { seed, promptLike, limit });
}

export async function getTagProvenance(tag: string): Promise<TagProvenance> {
    return invoke<TagProvenance>("get_tag_provenance", { tag });
}

export interface DuplicateGroup {
    quick_hash: string;
    count: number;
    sample_filepaths: string[];
}

export async function getDuplicateGroups(
    limit?: number,
    offset?: number
): Promise<DuplicateGroup[]> {
    return invoke<DuplicateGroup[]>("get_duplicate_groups", { limit, offset });
}

export async function inferLineage(): Promise<number> {
    return invoke<number>("infer_lineage");
}

export async function setLineageOverride(
    childFilepath: string,
    parentFilepath: string,
    relation: string,
    confidence: number,
    action: string
): Promise<void> {
    return invoke<void>("set_lineage_override", {
        childFilepath,
        parentFilepath,
        relation,
        confidence,
        action,
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

// ── Prompt library (N2) ─────────────────────────────────────────────────

export interface SavePromptInput {
    title?: string;
    prompt: string;
    negativePrompt?: string;
    tags?: string;
    notes?: string;
    sourceImageId?: number;
}

export async function savePrompt(input: SavePromptInput): Promise<SavePromptResult> {
    return invoke<SavePromptResult>("save_prompt", {
        title: input.title ?? null,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt ?? null,
        tags: input.tags ?? null,
        notes: input.notes ?? null,
        sourceImageId: input.sourceImageId ?? null,
    });
}

export async function listPrompts(
    query?: string,
    tag?: string,
    limit = 200,
    offset = 0
): Promise<PromptEntry[]> {
    return invoke<PromptEntry[]>("list_prompts", {
        query: query?.trim() ? query : null,
        tag: tag ?? null,
        limit,
        offset,
    });
}

export async function listPromptTags(): Promise<PromptTagCount[]> {
    return invoke<PromptTagCount[]>("list_prompt_tags");
}

export async function updatePrompt(
    id: number,
    fields: Omit<SavePromptInput, "sourceImageId">
): Promise<PromptEntry> {
    return invoke<PromptEntry>("update_prompt", {
        id,
        title: fields.title ?? null,
        prompt: fields.prompt,
        negativePrompt: fields.negativePrompt ?? null,
        tags: fields.tags ?? null,
        notes: fields.notes ?? null,
    });
}

export async function deletePrompt(id: number): Promise<boolean> {
    return invoke<boolean>("delete_prompt", { id });
}

export async function markPromptUsed(id: number): Promise<void> {
    return invoke<void>("use_prompt", { id });
}

export async function exportPromptLibrary(outputPath: string): Promise<number> {
    return invoke<number>("export_prompt_library", { outputPath });
}

export async function importPromptLibrary(inputPath: string): Promise<ImportPromptsResult> {
    return invoke<ImportPromptsResult>("import_prompt_library", { inputPath });
}
