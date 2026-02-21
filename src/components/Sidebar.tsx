import { type ReactNode, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type {
    DeleteHistoryEntry,
    ImageExportFormat,
    StorageProfile,
    TagCount,
} from "../types/metadata";
import { directoryExists } from "../services/commands";
import type {
    ScanProgress,
    ScanComplete,
    ThumbnailCacheComplete,
    ThumbnailCacheProgress,
} from "../services/commands";
import { usePersistedState } from "../hooks/usePersistedState";

interface SidebarProps {
    isCollapsed: boolean;
    onToggleCollapsed: () => void;
    onScan: (directory: string) => void;
    isScanning: boolean;
    scanProgress: ScanProgress | null;
    scanResult: ScanComplete | null;
    includeTags: string[];
    excludeTags: string[];
    topTags: TagCount[];
    onAddIncludeTag: (tag: string) => void;
    booruTagFilterInput: string;
    onBooruTagFilterInputChange: (value: string) => void;
    onApplyBooruTagFilter: (value: string) => void;
    onClearTagFilters: () => void;
    checkpointFamilyFilters: string[];
    onToggleCheckpointFamilyFilter: (family: string) => void;
    onClearCheckpointFamilyFilters: () => void;
    selectedCount: number;
    onExportSelected: (format: "json" | "csv") => void;
    onExportAsFiles: (format: ImageExportFormat, quality: number) => void;
    onMoveSelectedToFolder: () => void;
    isMovingSelected: boolean;
    onBulkFavoriteSelected: () => void;
    onBulkUnfavoriteSelected: () => void;
    onBulkLockSelected: () => void;
    onBulkUnlockSelected: () => void;
    isApplyingSelectionActions: boolean;
    autoLockFavorites: boolean;
    onAutoLockFavoritesChange: (value: boolean) => void;
    recentDeleteHistory: DeleteHistoryEntry[];
    onClearDeleteHistory: () => void;
    forgeBaseUrl: string;
    forgeApiKey: string;
    onForgeBaseUrlChange: (value: string) => void;
    onForgeApiKeyChange: (value: string) => void;
    forgeOutputDir: string;
    onForgeOutputDirChange: (value: string) => void;
    forgeModelsPath: string;
    onForgeModelsPathChange: (value: string) => void;
    forgeModelsScanSubfolders: boolean;
    onForgeModelsScanSubfoldersChange: (value: boolean) => void;
    forgeLoraPath: string;
    onForgeLoraPathChange: (value: string) => void;
    forgeLoraScanSubfolders: boolean;
    onForgeLoraScanSubfoldersChange: (value: boolean) => void;
    forgeIncludeSeed: boolean;
    onForgeIncludeSeedChange: (value: boolean) => void;
    forgeAdetailerFaceEnabled: boolean;
    onForgeAdetailerFaceEnabledChange: (value: boolean) => void;
    forgeAdetailerFaceModel: string;
    onForgeAdetailerFaceModelChange: (value: string) => void;
    onForgeTestConnection: () => void;
    onForgeSendSelected: () => void;
    isTestingForge: boolean;
    isSendingForgeBatch: boolean;
    columnCount: number;
    onColumnCountChange: (count: number) => void;
    storageProfile: StorageProfile;
    onStorageProfileChange: (profile: StorageProfile) => void;
    onPrecacheAllThumbnails: () => void;
    isPrecachingThumbnails: boolean;
    thumbnailCacheProgress: ThumbnailCacheProgress | null;
    thumbnailCacheResult: ThumbnailCacheComplete | null;
}

const EXPORT_FORMAT_OPTIONS: { value: ImageExportFormat; label: string }[] = [
    { value: "original", label: "Original (ZIP)" },
    { value: "png", label: "PNG" },
    { value: "jpeg", label: "JPEG" },
    { value: "webp", label: "WebP" },
    { value: "jxl", label: "JPEG XL" },
];

const CHECKPOINT_FAMILY_OPTIONS: Array<{ value: string; label: string }> = [
    { value: "ponyxl", label: "PonyXL" },
    { value: "sdxl", label: "SDXL" },
    { value: "flux", label: "Flux" },
    { value: "zimage_turbo", label: "Z-Image Turbo" },
    { value: "sd15", label: "SD 1.5" },
    { value: "sd21", label: "SD 2.1" },
    { value: "chroma", label: "Chroma" },
    { value: "vace", label: "VACE" },
];

type SidebarSectionId =
    | "gridSize"
    | "storageProfile"
    | "thumbnailCache"
    | "tagFilters"
    | "checkpointFamilies"
    | "topTags"
    | "exportMetadata"
    | "exportImages"
    | "gallerySafety"
    | "forgeApiSettings";

const SIDEBAR_SECTION_STORAGE_KEY = "sidebarSectionExpanded:v2";

const DEFAULT_SECTION_EXPANDED: Record<SidebarSectionId, boolean> = {
    gridSize: true,
    storageProfile: false,
    thumbnailCache: false,
    tagFilters: true,
    checkpointFamilies: true,
    topTags: true,
    exportMetadata: false,
    exportImages: false,
    gallerySafety: true,
    forgeApiSettings: false,
};

const sidebarSectionExpandedStorage = {
    serialize: (value: Record<SidebarSectionId, boolean>) =>
        JSON.stringify(value),
    deserialize: (
        raw: string
    ): Record<SidebarSectionId, boolean> | undefined => {
        try {
            const parsed = JSON.parse(raw) as Partial<
                Record<SidebarSectionId, boolean>
            >;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                return undefined;
            }
            const next = { ...DEFAULT_SECTION_EXPANDED };
            for (const sectionId of Object.keys(
                DEFAULT_SECTION_EXPANDED
            ) as SidebarSectionId[]) {
                const value = parsed[sectionId];
                if (typeof value === "boolean") {
                    next[sectionId] = value;
                }
            }
            return next;
        } catch {
            return undefined;
        }
    },
};

interface CollapsibleSidebarSectionProps {
    id: SidebarSectionId;
    title: string;
    isExpanded: boolean;
    onToggle: (id: SidebarSectionId) => void;
    children: ReactNode;
}

function CollapsibleSidebarSection({
    id,
    title,
    isExpanded,
    onToggle,
    children,
}: CollapsibleSidebarSectionProps) {
    return (
        <section className={`sidebar-section ${isExpanded ? "expanded" : "minimized"}`}>
            <button
                type="button"
                className="sidebar-section-toggle"
                onClick={() => onToggle(id)}
                aria-expanded={isExpanded}
                aria-controls={`sidebar-section-${id}`}
            >
                <h4 className="sidebar-section-title">{title}</h4>
                <span className="sidebar-section-chevron">{isExpanded ? "▾" : "▸"}</span>
            </button>
            <div id={`sidebar-section-${id}`} className="sidebar-section-body">
                {children}
            </div>
        </section>
    );
}

export function Sidebar({
    isCollapsed,
    onToggleCollapsed,
    onScan,
    isScanning,
    scanProgress,
    scanResult,
    includeTags,
    excludeTags,
    topTags,
    onAddIncludeTag,
    booruTagFilterInput,
    onBooruTagFilterInputChange,
    onApplyBooruTagFilter,
    onClearTagFilters,
    checkpointFamilyFilters,
    onToggleCheckpointFamilyFilter,
    onClearCheckpointFamilyFilters,
    selectedCount,
    onExportSelected,
    onExportAsFiles,
    onMoveSelectedToFolder,
    isMovingSelected,
    onBulkFavoriteSelected,
    onBulkUnfavoriteSelected,
    onBulkLockSelected,
    onBulkUnlockSelected,
    isApplyingSelectionActions,
    autoLockFavorites,
    onAutoLockFavoritesChange,
    recentDeleteHistory,
    onClearDeleteHistory,
    forgeBaseUrl,
    forgeApiKey,
    onForgeBaseUrlChange,
    onForgeApiKeyChange,
    forgeOutputDir,
    onForgeOutputDirChange,
    forgeModelsPath,
    onForgeModelsPathChange,
    forgeModelsScanSubfolders,
    onForgeModelsScanSubfoldersChange,
    forgeLoraPath,
    onForgeLoraPathChange,
    forgeLoraScanSubfolders,
    onForgeLoraScanSubfoldersChange,
    forgeIncludeSeed,
    onForgeIncludeSeedChange,
    forgeAdetailerFaceEnabled,
    onForgeAdetailerFaceEnabledChange,
    forgeAdetailerFaceModel,
    onForgeAdetailerFaceModelChange,
    onForgeTestConnection,
    onForgeSendSelected,
    isTestingForge,
    isSendingForgeBatch,
    columnCount,
    onColumnCountChange,
    storageProfile,
    onStorageProfileChange,
    onPrecacheAllThumbnails,
    isPrecachingThumbnails,
    thumbnailCacheProgress,
    thumbnailCacheResult,
}: SidebarProps) {
    const [topTagsExpanded, setTopTagsExpanded] = useState(false);
    const [exportFormat, setExportFormat] = useState<ImageExportFormat>("original");
    const [exportQuality, setExportQuality] = useState(85);
    const [scanValidationError, setScanValidationError] = useState<string | null>(null);
    const [sectionExpanded, setSectionExpanded] = usePersistedState<
        Record<SidebarSectionId, boolean>
    >(
        SIDEBAR_SECTION_STORAGE_KEY,
        DEFAULT_SECTION_EXPANDED,
        sidebarSectionExpandedStorage
    );

    const trimmedForgeBaseUrl = forgeBaseUrl.trim();
    let forgeUrlError: string | null = null;
    if (trimmedForgeBaseUrl.length === 0) {
        forgeUrlError = "Forge URL is required (for example http://127.0.0.1:7860).";
    } else {
        try {
            const parsed = new URL(trimmedForgeBaseUrl);
            if (!["http:", "https:"].includes(parsed.protocol)) {
                forgeUrlError = "Forge URL must start with http:// or https://.";
            }
        } catch {
            forgeUrlError = "Enter a valid Forge URL (for example http://127.0.0.1:7860).";
        }
    }
    const hasValidForgeUrl = forgeUrlError == null;

    const handleSelectFolder = async () => {
        const selected = await open({
            directory: true,
            multiple: false,
            title: "Select image folder to scan",
        });
        if (selected && typeof selected === "string") {
            try {
                const exists = await directoryExists(selected);
                if (!exists) {
                    setScanValidationError(
                        "Selected directory no longer exists. Please choose another folder."
                    );
                    return;
                }
                setScanValidationError(null);
                onScan(selected);
            } catch {
                setScanValidationError(
                    "Unable to validate selected directory. Please try again."
                );
            }
        }
    };

    const handleSelectForgeOutputFolder = async () => {
        const selected = await open({
            directory: true,
            multiple: false,
            title: "Select Forge output folder",
        });
        if (selected && typeof selected === "string") {
            onForgeOutputDirChange(selected);
        }
    };

    const handleSelectForgeModelsFolder = async () => {
        const selected = await open({
            directory: true,
            multiple: false,
            title: "Select Forge models directory",
        });
        if (selected && typeof selected === "string") {
            onForgeModelsPathChange(selected);
        }
    };

    const handleSelectForgeLoraFolder = async () => {
        const selected = await open({
            directory: true,
            multiple: false,
            title: "Select Forge LoRA directory",
        });
        if (selected && typeof selected === "string") {
            onForgeLoraPathChange(selected);
        }
    };

    const applyIncludeTag = (rawTag: string) => {
        const tag = rawTag.trim().toLowerCase();
        if (!tag) return;
        onAddIncludeTag(tag);
    };

    const showQualitySlider = exportFormat === "jpeg" || exportFormat === "webp";
    const displayedTopTags = topTagsExpanded ? topTags : topTags.slice(0, 10);
    const pendingDeletes = recentDeleteHistory.filter(
        (entry) => entry.status === "pending"
    );
    const finalizedDeletes = recentDeleteHistory.filter(
        (entry) => entry.status !== "pending"
    );
    const toggleSection = (sectionId: SidebarSectionId) => {
        setSectionExpanded((previous) => ({
            ...previous,
            [sectionId]: !previous[sectionId],
        }));
    };

    const formatDeleteTimestamp = (timestamp: number | null): string => {
        if (timestamp == null) {
            return "";
        }
        return new Date(timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    };

    return (
        <div className={`sidebar ${isCollapsed ? "collapsed" : ""}`}>
            <div className="sidebar-header">
                <div className="sidebar-logo">
                    <img
                        src="/forgemetalink-icon.svg"
                        alt="ForgeMetaLink icon"
                        className="logo-icon"
                        width={20}
                        height={20}
                    />
                    {!isCollapsed && <span className="logo-text">ForgeMetaLink</span>}
                </div>
                <button
                    type="button"
                    className="sidebar-collapse-button"
                    onClick={onToggleCollapsed}
                    title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                >
                    {isCollapsed ? ">" : "<"}
                </button>
            </div>

            {!isCollapsed && <div className="sidebar-content">
                <button
                    className="scan-button"
                    onClick={handleSelectFolder}
                    disabled={isScanning}
                >
                    {isScanning ? (
                        <>
                            <span className="spinner" />
                            Scanning...
                        </>
                    ) : (
                        <>
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className="btn-icon"
                            >
                                <path d="M3 7v10c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2h-6l-2-2H5c-1.1 0-2 .9-2 2z" />
                            </svg>
                            Scan Folder
                        </>
                    )}
                </button>
                {scanValidationError && (
                    <p className="input-error" role="alert">
                        {scanValidationError}
                    </p>
                )}

                {isScanning && scanProgress && (
                    <div className="scan-progress-container">
                        <div className="scan-progress-labels">
                            <span className="scan-stage">{scanProgress.stage}</span>
                            <span className="scan-count">
                                {scanProgress.current} / {scanProgress.total || "?"}
                            </span>
                        </div>
                        <div className="scan-progress-bar-bg">
                            <div
                                className="scan-progress-bar-fill"
                                style={{
                                    width: `${scanProgress.total ? (scanProgress.current / scanProgress.total) * 100 : 0}%`,
                                }}
                            />
                        </div>
                        {scanProgress.filename && (
                            <div className="scan-filename" title={scanProgress.filename}>
                                {scanProgress.filename}
                            </div>
                        )}
                    </div>
                )}

                {!isScanning && scanResult && (
                    <div className="scan-result">
                        <div className="scan-stat">
                            <span className="scan-stat-number">{scanResult.total_files}</span>
                            <span className="scan-stat-label">Total Files</span>
                        </div>
                        <div className="scan-stat">
                            <span className="scan-stat-number success">
                                {scanResult.indexed}
                            </span>
                            <span className="scan-stat-label">Indexed</span>
                        </div>
                        {scanResult.errors > 0 && (
                            <div className="scan-stat">
                                <span className="scan-stat-number error">
                                    {scanResult.errors}
                                </span>
                                <span className="scan-stat-label">Errors</span>
                            </div>
                        )}
                    </div>
                )}

                <CollapsibleSidebarSection
                    id="gridSize"
                    title="Grid Size"
                    isExpanded={sectionExpanded.gridSize}
                    onToggle={toggleSection}
                >
                    <div className="grid-slider-row">
                        <input
                            type="range"
                            className="grid-slider"
                            min={3}
                            max={14}
                            value={columnCount}
                            onChange={(e) => onColumnCountChange(Number(e.target.value))}
                        />
                        <span className="grid-slider-label">{columnCount} cols</span>
                    </div>
                </CollapsibleSidebarSection>

                <CollapsibleSidebarSection
                    id="storageProfile"
                    title="Storage Profile"
                    isExpanded={sectionExpanded.storageProfile}
                    onToggle={toggleSection}
                >
                    <div className="profile-toggle-row">
                        <button
                            className={`profile-toggle-button ${
                                storageProfile === "hdd" ? "active" : ""
                            }`}
                            onClick={() => onStorageProfileChange("hdd")}
                            type="button"
                        >
                            HDD
                        </button>
                        <button
                            className={`profile-toggle-button ${
                                storageProfile === "ssd" ? "active" : ""
                            }`}
                            onClick={() => onStorageProfileChange("ssd")}
                            type="button"
                        >
                            SSD
                        </button>
                    </div>
                    <p className="sidebar-help">
                        Tunes indexing, thumbnail generation, and caching defaults
                        for your storage type.
                    </p>
                </CollapsibleSidebarSection>

                <CollapsibleSidebarSection
                    id="thumbnailCache"
                    title="Thumbnail Cache"
                    isExpanded={sectionExpanded.thumbnailCache}
                    onToggle={toggleSection}
                >
                    <button
                        className="sidebar-button"
                        onClick={onPrecacheAllThumbnails}
                        disabled={isPrecachingThumbnails || isScanning}
                        type="button"
                    >
                        {isPrecachingThumbnails
                            ? "Caching all thumbnails..."
                            : "Cache All Thumbnails"}
                    </button>
                    <p className="sidebar-help">
                        Prebuilds HQ cache entries for the full indexed library.
                    </p>

                    {thumbnailCacheProgress && (
                        <div className="scan-progress-container thumbnail-cache-progress">
                            <div className="scan-progress-labels">
                                <span className="scan-stage">
                                    {thumbnailCacheProgress.phase}
                                </span>
                                <span className="scan-count">
                                    {thumbnailCacheProgress.current} /{" "}
                                    {thumbnailCacheProgress.total || "?"}
                                </span>
                            </div>
                            <div className="scan-progress-bar-bg">
                                <div
                                    className="scan-progress-bar-fill"
                                    style={{
                                        width: `${thumbnailCacheProgress.total ? (thumbnailCacheProgress.current / thumbnailCacheProgress.total) * 100 : 0}%`,
                                    }}
                                />
                            </div>
                            <div className="thumbnail-cache-stats">
                                +{thumbnailCacheProgress.generated} generated,{" "}
                                {thumbnailCacheProgress.skipped} skipped,{" "}
                                {thumbnailCacheProgress.failed} failed
                            </div>
                        </div>
                    )}

                    {!isPrecachingThumbnails && thumbnailCacheResult && (
                        <p className="sidebar-help">
                            Finished {thumbnailCacheResult.total} files: +
                            {thumbnailCacheResult.generated} generated,{" "}
                            {thumbnailCacheResult.skipped} skipped,{" "}
                            {thumbnailCacheResult.failed} failed.
                        </p>
                    )}
                </CollapsibleSidebarSection>

                <CollapsibleSidebarSection
                    id="tagFilters"
                    title="Tag Filters"
                    isExpanded={sectionExpanded.tagFilters}
                    onToggle={toggleSection}
                >
                    <div className="tag-input-group">
                        <input
                            className="sidebar-input"
                            value={booruTagFilterInput}
                            placeholder='Booru style: "1girl" -nsfw'
                            onChange={(event) =>
                                onBooruTagFilterInputChange(event.target.value)
                            }
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    onApplyBooruTagFilter(booruTagFilterInput);
                                }
                            }}
                        />
                        <button
                            className="sidebar-button"
                            onClick={() => onApplyBooruTagFilter(booruTagFilterInput)}
                            type="button"
                        >
                            Apply
                        </button>
                    </div>
                    <div className="sidebar-actions">
                        <button
                            className="sidebar-button"
                            onClick={() => onClearTagFilters()}
                            type="button"
                        >
                            Clear Filters
                        </button>
                    </div>
                    <p className="sidebar-help">
                        Include: {includeTags.length > 0 ? includeTags.join(", ") : "none"}
                    </p>
                    <p className="sidebar-help">
                        Exclude: {excludeTags.length > 0 ? excludeTags.join(", ") : "none"}
                    </p>
                </CollapsibleSidebarSection>

                <CollapsibleSidebarSection
                    id="checkpointFamilies"
                    title="Checkpoint Families"
                    isExpanded={sectionExpanded.checkpointFamilies}
                    onToggle={toggleSection}
                >
                    <div className="checkpoint-family-toggle-grid">
                        {CHECKPOINT_FAMILY_OPTIONS.map((option) => {
                            const active = checkpointFamilyFilters.includes(
                                option.value
                            );
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    className={`checkpoint-family-toggle ${
                                        active ? "active" : ""
                                    }`}
                                    onClick={() =>
                                        onToggleCheckpointFamilyFilter(option.value)
                                    }
                                >
                                    {option.label}
                                </button>
                            );
                        })}
                    </div>
                    <button
                        className="sidebar-button"
                        type="button"
                        onClick={onClearCheckpointFamilyFilters}
                        disabled={checkpointFamilyFilters.length === 0}
                    >
                        Clear Family Filters
                    </button>
                    <p className="sidebar-help">
                        Quick toggles for model family filtering (for example PonyXL).
                    </p>
                </CollapsibleSidebarSection>

                <CollapsibleSidebarSection
                    id="topTags"
                    title="Top Tags"
                    isExpanded={sectionExpanded.topTags}
                    onToggle={toggleSection}
                >
                    <div className="tag-suggestions">
                        {displayedTopTags.map((entry, index) => (
                            <button
                                key={`top-${entry.tag}`}
                                className="tag-suggestion"
                                onClick={() => applyIncludeTag(entry.tag)}
                            >
                                #{index + 1} {entry.tag} ({entry.count})
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        className="sidebar-button"
                        onClick={() => setTopTagsExpanded((prev) => !prev)}
                    >
                        {topTagsExpanded ? "Show Top 10" : "Show More"}
                    </button>
                </CollapsibleSidebarSection>

                <CollapsibleSidebarSection
                    id="exportMetadata"
                    title="Export Metadata"
                    isExpanded={sectionExpanded.exportMetadata}
                    onToggle={toggleSection}
                >
                    <p className="sidebar-help">Selected: {selectedCount}</p>
                    <div className="sidebar-actions">
                        <button
                            className="sidebar-button"
                            disabled={selectedCount === 0}
                            onClick={() => onExportSelected("json")}
                        >
                            Export JSON
                        </button>
                        <button
                            className="sidebar-button"
                            disabled={selectedCount === 0}
                            onClick={() => onExportSelected("csv")}
                        >
                            Export CSV
                        </button>
                    </div>
                </CollapsibleSidebarSection>

                <CollapsibleSidebarSection
                    id="exportImages"
                    title="Export Images"
                    isExpanded={sectionExpanded.exportImages}
                    onToggle={toggleSection}
                >
                    <p className="sidebar-help">Selected: {selectedCount}</p>
                    <div className="export-format-row">
                        <select
                            className="export-format-select"
                            value={exportFormat}
                            onChange={(e) =>
                                setExportFormat(e.target.value as ImageExportFormat)
                            }
                        >
                            {EXPORT_FORMAT_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                </option>
                            ))}
                        </select>
                    </div>
                    {showQualitySlider && (
                        <div className="export-quality-row">
                            <span className="export-quality-label">Quality</span>
                            <input
                                type="range"
                                className="export-quality-slider"
                                min={10}
                                max={100}
                                step={5}
                                value={exportQuality}
                                onChange={(e) => setExportQuality(Number(e.target.value))}
                            />
                            <span className="export-quality-value">{exportQuality}</span>
                        </div>
                    )}
                    <button
                        className="sidebar-button"
                        disabled={selectedCount === 0}
                        onClick={() => onExportAsFiles(exportFormat, exportQuality)}
                    >
                        Export as ZIP
                    </button>
                </CollapsibleSidebarSection>

                <CollapsibleSidebarSection
                    id="gallerySafety"
                    title="Gallery Safety"
                    isExpanded={sectionExpanded.gallerySafety}
                    onToggle={toggleSection}
                >
                    <label className="sidebar-checkbox-row">
                        <input
                            type="checkbox"
                            checked={autoLockFavorites}
                            onChange={(event) =>
                                onAutoLockFavoritesChange(event.target.checked)
                            }
                        />
                        Auto-lock favorites
                    </label>
                    <p className="sidebar-help">
                        When enabled, marking an image as favorite also locks it.
                    </p>

                    <div className="bulk-mark-actions">
                        <button
                            className="sidebar-button"
                            type="button"
                            onClick={onBulkFavoriteSelected}
                            disabled={selectedCount === 0 || isApplyingSelectionActions}
                        >
                            Favorite Selected
                        </button>
                        <button
                            className="sidebar-button"
                            type="button"
                            onClick={onBulkUnfavoriteSelected}
                            disabled={selectedCount === 0 || isApplyingSelectionActions}
                        >
                            Unfavorite Selected
                        </button>
                        <button
                            className="sidebar-button"
                            type="button"
                            onClick={onBulkLockSelected}
                            disabled={selectedCount === 0 || isApplyingSelectionActions}
                        >
                            Lock Selected
                        </button>
                        <button
                            className="sidebar-button"
                            type="button"
                            onClick={onBulkUnlockSelected}
                            disabled={selectedCount === 0 || isApplyingSelectionActions}
                        >
                            Unlock Selected
                        </button>
                    </div>
                    <p className="sidebar-help">
                        Apply favorite/lock state to all currently selected images.
                    </p>

                    <button
                        className="sidebar-button"
                        type="button"
                        onClick={onMoveSelectedToFolder}
                        disabled={selectedCount === 0 || isApplyingSelectionActions}
                    >
                        {isMovingSelected
                            ? "Moving selected..."
                            : `Move Selected (${selectedCount})`}
                    </button>
                    <p className="sidebar-help">
                        Move selected images to another folder without deleting.
                    </p>

                    <div className="recent-delete-panel">
                        <div className="recent-delete-header">
                            <h5>Recently deleted</h5>
                            <button
                                className="sidebar-button"
                                type="button"
                                onClick={onClearDeleteHistory}
                                disabled={recentDeleteHistory.length === 0}
                            >
                                Clear
                            </button>
                        </div>

                        <div className="recent-delete-group">
                            <span className="recent-delete-group-title">Pending</span>
                            {pendingDeletes.length === 0 ? (
                                <p className="sidebar-help">No pending deletes.</p>
                            ) : (
                                <ul className="recent-delete-list">
                                    {pendingDeletes.map((entry) => (
                                        <li key={entry.id} className="recent-delete-item pending">
                                            <span className="recent-delete-summary">
                                                {entry.summary}
                                            </span>
                                            <span className="recent-delete-meta">
                                                {formatDeleteTimestamp(entry.createdAt)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        <div className="recent-delete-group">
                            <span className="recent-delete-group-title">Finalized</span>
                            {finalizedDeletes.length === 0 ? (
                                <p className="sidebar-help">No finalized deletes yet.</p>
                            ) : (
                                <ul className="recent-delete-list">
                                    {finalizedDeletes.slice(0, 12).map((entry) => (
                                        <li
                                            key={entry.id}
                                            className={`recent-delete-item ${entry.status}`}
                                        >
                                            <span className="recent-delete-summary">
                                                {entry.summary}
                                            </span>
                                            <span className="recent-delete-meta">
                                                {formatDeleteTimestamp(
                                                    entry.completedAt ?? entry.createdAt
                                                )}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>
                </CollapsibleSidebarSection>

                <CollapsibleSidebarSection
                    id="forgeApiSettings"
                    title="Forge API Settings"
                    isExpanded={sectionExpanded.forgeApiSettings}
                    onToggle={toggleSection}
                >
                    <input
                        className={`sidebar-input ${hasValidForgeUrl ? "" : "input-invalid"}`}
                        value={forgeBaseUrl}
                        onChange={(event) => onForgeBaseUrlChange(event.target.value)}
                        placeholder="http://127.0.0.1:7860"
                        aria-invalid={!hasValidForgeUrl}
                    />
                    {!hasValidForgeUrl && (
                        <p className="input-error" role="alert">
                            {forgeUrlError}
                        </p>
                    )}
                    <p className="sidebar-help">
                        Use host root URL (no /sdapi/v1). Forge must be started with --api.
                    </p>
                    <input
                        className="sidebar-input"
                        value={forgeApiKey}
                        onChange={(event) => onForgeApiKeyChange(event.target.value)}
                        placeholder="API key (optional)"
                        type="password"
                    />
                    <input
                        className="sidebar-input"
                        value={forgeOutputDir}
                        onChange={(event) => onForgeOutputDirChange(event.target.value)}
                        placeholder="forge-outputs"
                    />
                    <input
                        className="sidebar-input"
                        value={forgeModelsPath}
                        onChange={(event) => onForgeModelsPathChange(event.target.value)}
                        placeholder="Select Forge models folder"
                    />
                    <input
                        className="sidebar-input"
                        value={forgeLoraPath}
                        onChange={(event) => onForgeLoraPathChange(event.target.value)}
                        placeholder="Select Forge LoRA folder"
                    />
                    <p className="sidebar-help">
                        Leave blank for default `forge-outputs` in app data.
                    </p>
                    <p className="sidebar-help">
                        Models folder is scanned for checkpoint dropdown options in viewer.
                    </p>
                    <p className="sidebar-help">
                        LoRA folder is scanned for multi-select LoRA prompt tokens in viewer.
                    </p>
                    <label className="sidebar-help">
                        <input
                            type="checkbox"
                            checked={forgeModelsScanSubfolders}
                            onChange={(event) =>
                                onForgeModelsScanSubfoldersChange(event.target.checked)
                            }
                        />{" "}
                        Scan model subfolders
                    </label>
                    <label className="sidebar-help">
                        <input
                            type="checkbox"
                            checked={forgeLoraScanSubfolders}
                            onChange={(event) =>
                                onForgeLoraScanSubfoldersChange(event.target.checked)
                            }
                        />{" "}
                        Scan LoRA subfolders
                    </label>
                    <div className="sidebar-actions">
                        <button
                            className="sidebar-button"
                            onClick={handleSelectForgeOutputFolder}
                            type="button"
                        >
                            Browse Output Folder
                        </button>
                        <button
                            className="sidebar-button"
                            onClick={handleSelectForgeModelsFolder}
                            type="button"
                        >
                            Browse Models Folder
                        </button>
                        <button
                            className="sidebar-button"
                            onClick={handleSelectForgeLoraFolder}
                            type="button"
                        >
                            Browse LoRA Folder
                        </button>
                    </div>
                    <label className="sidebar-help">
                        <input
                            type="checkbox"
                            checked={forgeIncludeSeed}
                            onChange={(event) =>
                                onForgeIncludeSeedChange(event.target.checked)
                            }
                        />{" "}
                        Send original seed
                    </label>
                    <label className="sidebar-help">
                        <input
                            type="checkbox"
                            checked={forgeAdetailerFaceEnabled}
                            onChange={(event) =>
                                onForgeAdetailerFaceEnabledChange(event.target.checked)
                            }
                        />{" "}
                        Enable ADetailer face fix
                    </label>
                    <select
                        className="sidebar-input"
                        value={forgeAdetailerFaceModel}
                        onChange={(event) =>
                            onForgeAdetailerFaceModelChange(event.target.value)
                        }
                        disabled={!forgeAdetailerFaceEnabled}
                    >
                        <option value="face_yolov8n.pt">face_yolov8n.pt</option>
                        <option value="face_yolov8s.pt">face_yolov8s.pt</option>
                    </select>
                    <button
                        className="sidebar-button"
                        onClick={onForgeTestConnection}
                        disabled={isTestingForge || !hasValidForgeUrl}
                    >
                        {isTestingForge ? "Testing..." : "Test Connection"}
                    </button>
                    <button
                        className="sidebar-button"
                        onClick={onForgeSendSelected}
                        disabled={selectedCount === 0 || isSendingForgeBatch || !hasValidForgeUrl}
                    >
                        {isSendingForgeBatch
                            ? "Queueing..."
                            : `Send Selected to Forge (${selectedCount})`}
                    </button>
                </CollapsibleSidebarSection>
            </div>}
        </div>
    );
}
