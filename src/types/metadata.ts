/// TypeScript interfaces mirroring Rust backend types.

export interface GalleryImageRecord {
    id: number;
    filepath: string;
    filename: string;
    directory: string;
    seed: string | null;
    width: number | null;
    height: number | null;
    model_name: string | null;
    is_favorite: boolean;
    is_locked: boolean;
}

export interface ImageRecord extends GalleryImageRecord {
    prompt: string;
    negative_prompt: string;
    steps: string | null;
    sampler: string | null;
    cfg_scale: string | null;
    model_hash: string | null;
    raw_metadata: string;
    file_mtime: number | null;
}

export interface ScanResult {
    total_files: number;
    indexed: number;
    errors: number;
}

export interface TagCount {
    tag: string;
    count: number;
}

export interface ExportResult {
    exported_count: number;
    output_path: string;
}

export interface FileExportResult {
    exported_count: number;
    output_path: string;
    total_bytes: number;
}

export interface DeleteImagesResult {
    requested: number;
    removed_from_db: number;
    deleted_ids: number[];
    deleted_files: number;
    missing_files: number;
    failed_files: number;
    deleted_sidecars: number;
    deleted_thumbnails: number;
    blocked_protected: number;
    blocked_protected_ids: number[];
    failed_paths: string[];
}

export type DeleteMode = "trash" | "permanent";

export interface MovedImageRecord {
    id: number;
    filepath: string;
    filename: string;
    directory: string;
}

export interface MoveImagesResult {
    requested: number;
    moved_files: number;
    updated_in_db: number;
    moved_ids: number[];
    moved_items: MovedImageRecord[];
    skipped_missing: number;
    skipped_same_directory: number;
    failed: number;
    failed_paths: string[];
}

export type DeleteHistoryStatus = "pending" | "finalized" | "undone" | "failed";

export interface DeleteHistoryEntry {
    id: number;
    mode: DeleteMode;
    count: number;
    status: DeleteHistoryStatus;
    summary: string;
    createdAt: number;
    completedAt: number | null;
}

export type ImageExportFormat = "original" | "png" | "jpeg" | "webp" | "jxl";

export interface ThumbnailMapping {
    filepath: string;
    thumbnail_path: string;
}

export interface CursorPage<T = GalleryImageRecord> {
    items: T[];
    next_cursor: string | null;
}

export interface SidecarData {
    tags: string[];
    notes?: string | null;
    rating?: number | null;
}

export interface ForgePayload {
    prompt: string;
    negative_prompt: string;
    steps?: number;
    sampler_name?: string;
    cfg_scale?: number;
    seed?: number;
    width?: number;
    height?: number;
}

export interface ForgeStatus {
    ok: boolean;
    message: string;
}

export interface ForgeSendResult {
    ok: boolean;
    message: string;
    output_dir: string;
    generated_count: number;
    saved_paths: string[];
}

export interface ForgeBatchItemResult {
    image_id: number;
    filename: string;
    ok: boolean;
    message: string;
    generated_count: number;
    saved_paths: string[];
}

export interface ForgeBatchSendResult {
    total: number;
    succeeded: number;
    failed: number;
    output_dir: string;
    message: string;
    items: ForgeBatchItemResult[];
}

export interface ForgeOptionsResult {
    models: string[];
    loras: string[];
    samplers: string[];
    schedulers: string[];
    models_scan_dir: string | null;
    loras_scan_dir: string | null;
    warnings: string[];
}

export interface ForgePayloadOverrides {
    prompt: string;
    negative_prompt: string;
    steps: string;
    sampler_name: string;
    scheduler: string;
    cfg_scale: string;
    seed: string;
    width: string;
    height: string;
    model_name: string;
}

export interface ModelEntry {
    model_name: string;
    count: number;
}

export type GenerationType =
    | "txt2img"
    | "img2img"
    | "inpaint"
    | "grid"
    | "upscale"
    | "unknown";

export type SortOption =
    | "newest"
    | "oldest"
    | "name_asc"
    | "name_desc"
    | "model"
    | "generation_type";
export type StorageProfile = "hdd" | "ssd";
