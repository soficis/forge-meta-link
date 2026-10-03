import { useState } from "react";
import type { DeleteMode, ImageExportFormat } from "../types/metadata";
import type { ShowToastOptions } from "../hooks/useToast";
import type { ForgeSettings } from "../hooks/useForgeSettings";
import { getForgeUrlError } from "../utils/forgeUrl";
import { buildLoraWeightMap } from "../utils/forgeSendOptions";
import { ForgeRequeueButton } from "./ForgeRequeueButton";

interface SelectionActionBarProps {
    selectedCount: number;
    loadedCount: number;
    selectedImageIds: number[];
    onSelectAll: () => void;
    onClearSelection: () => void;
    isBusy: boolean;
    isMovingSelected: boolean;
    onFavorite: () => void;
    onUnfavorite: () => void;
    onLock: () => void;
    onUnlock: () => void;
    onMoveToFolder: () => void;
    onExportMetadata: (format: "json" | "csv") => void;
    onExportImages: (format: ImageExportFormat, quality: number) => void;
    onDeleteSelected: (mode: DeleteMode) => void;
    forge: ForgeSettings;
    onShowToast: (message: string, options?: ShowToastOptions) => void;
}

const EXPORT_FORMAT_OPTIONS: { value: ImageExportFormat; label: string }[] = [
    { value: "original", label: "Original files" },
    { value: "png", label: "PNG" },
    { value: "jpeg", label: "JPEG" },
    { value: "webp", label: "WebP" },
    { value: "jxl", label: "JPEG XL" },
];

/**
 * Every action that applies to the current multi-selection lives here, next to
 * the gallery, and only appears while something is selected.
 */
export function SelectionActionBar({
    selectedCount,
    loadedCount,
    selectedImageIds,
    onSelectAll,
    onClearSelection,
    isBusy,
    isMovingSelected,
    onFavorite,
    onUnfavorite,
    onLock,
    onUnlock,
    onMoveToFolder,
    onExportMetadata,
    onExportImages,
    onDeleteSelected,
    forge,
    onShowToast,
}: SelectionActionBarProps) {
    const [exportFormat, setExportFormat] = useState<ImageExportFormat>("original");
    const [exportQuality, setExportQuality] = useState(85);
    const [randomSeedBatch, setRandomSeedBatch] = useState(false);
    const showQualitySlider = exportFormat === "jpeg" || exportFormat === "webp";
    const forgeUrlError = getForgeUrlError(forge.forgeBaseUrl);
    const parsedLoraWeight = forge.forgeLoraWeight.trim() ? Number(forge.forgeLoraWeight) : null;
    const selectedLoraWeights = buildLoraWeightMap(forge.forgeSelectedLoras, forge.forgeLoraWeights);

    if (selectedCount === 0) {
        return null;
    }

    return (
        <div className="selection-bar" role="toolbar" aria-label={`Actions for ${selectedCount} selected images`}>
            <span className="selection-bar-count" aria-live="polite">
                {selectedCount.toLocaleString()} selected
            </span>
            {selectedCount < loadedCount && (
                <button type="button" className="selection-bar-link" onClick={onSelectAll}>
                    Select all {loadedCount.toLocaleString()} loaded
                </button>
            )}
            <button type="button" className="selection-bar-link" onClick={onClearSelection} disabled={isBusy}>
                Clear
            </button>

            <span className="selection-bar-divider" aria-hidden="true" />

            <div className="selection-bar-group" role="group" aria-label="Mark">
                <button type="button" className="selection-bar-button" onClick={onFavorite} disabled={isBusy}>
                    ☆ Favorite
                </button>
                <button type="button" className="selection-bar-button" onClick={onUnfavorite} disabled={isBusy}>
                    Unfavorite
                </button>
                <button type="button" className="selection-bar-button" onClick={onLock} disabled={isBusy}>
                    🔒 Lock
                </button>
                <button type="button" className="selection-bar-button" onClick={onUnlock} disabled={isBusy}>
                    Unlock
                </button>
            </div>

            <div className="selection-bar-group" role="group" aria-label="Files">
                <button type="button" className="selection-bar-button" onClick={onMoveToFolder} disabled={isBusy}>
                    {isMovingSelected ? "Moving…" : "Move to folder…"}
                </button>

                <details className="selection-bar-menu">
                    <summary className="selection-bar-button">Export ▾</summary>
                    <div className="selection-bar-menu-panel">
                        <span className="selection-bar-menu-heading">Metadata</span>
                        <div className="selection-bar-menu-row">
                            <button type="button" className="sidebar-button" onClick={() => onExportMetadata("json")}>
                                JSON
                            </button>
                            <button type="button" className="sidebar-button" onClick={() => onExportMetadata("csv")}>
                                CSV
                            </button>
                        </div>
                        <span className="selection-bar-menu-heading">Images as ZIP</span>
                        <label className="selection-bar-menu-field">
                            Format
                            <select
                                className="export-format-select"
                                value={exportFormat}
                                onChange={(event) => setExportFormat(event.target.value as ImageExportFormat)}
                            >
                                {EXPORT_FORMAT_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                        {showQualitySlider && (
                            <label className="selection-bar-menu-field">
                                Quality {exportQuality}
                                <input
                                    type="range"
                                    min={10}
                                    max={100}
                                    step={5}
                                    value={exportQuality}
                                    onChange={(event) => setExportQuality(Number(event.target.value))}
                                />
                            </label>
                        )}
                        <button
                            type="button"
                            className="sidebar-button"
                            onClick={() => onExportImages(exportFormat, exportQuality)}
                        >
                            Export {selectedCount} image{selectedCount === 1 ? "" : "s"}
                        </button>
                    </div>
                </details>

                <button
                    type="button"
                    className={`selection-bar-button ${randomSeedBatch ? "active" : ""}`}
                    onClick={() => setRandomSeedBatch((prev) => !prev)}
                    title={
                        randomSeedBatch
                            ? "Random seed (-1) active for batch Forge requests"
                            : "Click to generate batch with random seed (-1)"
                    }
                    style={{
                        background: randomSeedBatch ? "var(--accent)" : undefined,
                        color: randomSeedBatch ? "#fff" : undefined,
                    }}
                >
                    🎲 Random Seed
                </button>

                <ForgeRequeueButton
                    imageIds={selectedImageIds}
                    baseUrl={forge.forgeBaseUrl}
                    apiKey={forge.forgeApiKey}
                    outputDir={forge.forgeOutputDir.trim() ? forge.forgeOutputDir : null}
                    includeSeed={randomSeedBatch ? true : forge.forgeIncludeSeed}
                    overrides={randomSeedBatch ? { seed: "-1" } : undefined}
                    adetailerEnabled={forge.forgeAdetailerFaceEnabled}
                    adetailerModel={forge.forgeAdetailerFaceModel.trim() ? forge.forgeAdetailerFaceModel : null}
                    loraTokens={forge.forgeSelectedLoras.length > 0 ? forge.forgeSelectedLoras : null}
                    loraWeight={parsedLoraWeight}
                    loraWeights={selectedLoraWeights}
                    saveForgeCopy={forge.forgeSaveCopy}
                    disabled={isBusy || forgeUrlError != null}
                    validate={() => {
                        if (
                            parsedLoraWeight != null &&
                            (!Number.isFinite(parsedLoraWeight) || parsedLoraWeight < 0 || parsedLoraWeight > 2)
                        ) {
                            return "LoRA weight must be between 0 and 2 before sending to Forge.";
                        }
                        return null;
                    }}
                    onQueued={(_queueId, result) => onShowToast(result.message, { tone: "success" })}
                    onError={(message) => onShowToast(message, { tone: "error" })}
                    label="Send to Forge"
                    className="selection-bar-button"
                />
            </div>

            <div className="selection-bar-group selection-bar-danger-zone" role="group" aria-label="Delete">
                <button
                    type="button"
                    className="selection-bar-button danger"
                    onClick={() => onDeleteSelected("trash")}
                    disabled={isBusy}
                    title="Move selected images to Trash"
                >
                    Trash
                </button>
                <details className="selection-bar-menu">
                    <summary className="selection-bar-button" title="More deletion options" aria-label="More deletion options">
                        ▾
                    </summary>
                    <div className="selection-bar-menu-panel">
                        <button
                            type="button"
                            className="sidebar-button danger"
                            onClick={(event) => {
                                event.currentTarget.closest("details")?.removeAttribute("open");
                                onDeleteSelected("permanent");
                            }}
                            disabled={isBusy}
                        >
                            Delete permanently…
                        </button>
                    </div>
                </details>
            </div>
        </div>
    );
}
