/** DTOs mirroring the Rust missing-asset detector (`commands/assets.rs`). */

export interface AssetStatus {
    name: string;
    found: boolean;
    path_hint: string | null;
    referencing_image_count: number;
}

export interface AssetReport {
    models: AssetStatus[];
    loras: AssetStatus[];
    total_referenced_models: number;
    total_referenced_loras: number;
}
