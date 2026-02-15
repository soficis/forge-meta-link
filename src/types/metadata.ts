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

export interface DirectoryEntry {
    directory: string;
    count: number;
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
