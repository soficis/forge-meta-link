import { useState, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
    exportImages,
    forgeSendToImage,
    getSidecarData,
    getThumbnailPath,
    saveSidecarTags,
} from "../services/commands";
import type { ImageRecord } from "../types/metadata";

interface DetailPanelProps {
    image: ImageRecord | null;
    onClose: () => void;
    forgeBaseUrl: string;
    forgeApiKey: string;
}

export function DetailPanel({
    image,
    onClose,
    forgeBaseUrl,
    forgeApiKey,
}: DetailPanelProps) {
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const [isSendingToForge, setIsSendingToForge] = useState(false);

    const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null);
    const [fullResLoaded, setFullResLoaded] = useState(false);

    // Sidecar state
    const [sidecarNotes, setSidecarNotes] = useState("");
    const [sidecarTags, setSidecarTags] = useState<string[]>([]);
    const [isSavingSidecar, setIsSavingSidecar] = useState(false);

    useEffect(() => {
        if (!image) return;
        setFullResLoaded(false);
        setThumbnailSrc(null);
        getThumbnailPath(image.filepath)
            .then((thumbPath) => setThumbnailSrc(convertFileSrc(thumbPath)))
            .catch(() => { });

        // Load sidecar data
        setSidecarNotes("");
        setSidecarTags([]);
        getSidecarData(image.filepath).then((data) => {
            if (data) {
                setSidecarTags(data.tags);
                if (data.notes) setSidecarNotes(data.notes);
            }
        });
    }, [image]);

    if (!image) return null;

    const imgSrc = convertFileSrc(image.filepath);

    const paramEntries: [string, string][] = [];
    if (image.steps) paramEntries.push(["Steps", image.steps]);
    if (image.sampler) paramEntries.push(["Sampler", image.sampler]);
    if (image.cfg_scale) paramEntries.push(["CFG Scale", image.cfg_scale]);
    if (image.seed) paramEntries.push(["Seed", image.seed]);
    if (image.width && image.height) {
        paramEntries.push(["Size", `${image.width}x${image.height}`]);
    }
    if (image.model_name) paramEntries.push(["Model", image.model_name]);
    if (image.model_hash) paramEntries.push(["Model Hash", image.model_hash]);

    const copyText = async (value: string, successMessage: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setStatusMessage(successMessage);
            setTimeout(() => setStatusMessage(null), 3000);
        } catch {
            setStatusMessage("Clipboard write failed");
        }
    };

    const handleExport = async (format: "json" | "csv") => {
        const outputPath = await save({
            title: `Export ${format.toUpperCase()}`,
            defaultPath: `${image.filename}.${format}`,
        });

        if (!outputPath || typeof outputPath !== "string") {
            return;
        }

        try {
            const result = await exportImages([image.id], format, outputPath);
            setStatusMessage(
                `Exported to ${result.output_path}`
            );
            setTimeout(() => setStatusMessage(null), 3000);
        } catch (error) {
            setStatusMessage(`Export failed: ${String(error)}`);
        }
    };

    const handleSendToForge = async () => {
        setIsSendingToForge(true);
        setStatusMessage(null);

        try {
            const result = await forgeSendToImage(
                image.id,
                forgeBaseUrl,
                forgeApiKey || null,
                null,
                true,
                false,
                null,
                null,
                null,
                null
            );
            setStatusMessage(result.message);
        } catch (error) {
            setStatusMessage(`Forge send failed: ${String(error)}`);
        } finally {
            setIsSendingToForge(false);
        }
    };

    const handleSaveSidecar = async () => {
        setIsSavingSidecar(true);
        try {
            await saveSidecarTags(image.filepath, sidecarTags, sidecarNotes || null);
            setStatusMessage("Sidecar saved!");
            setTimeout(() => setStatusMessage(null), 3000);
        } catch (error) {
            setStatusMessage(`Save failed: ${String(error)}`);
        } finally {
            setIsSavingSidecar(false);
        }
    };

    return (
        <div className="detail-panel">
            <div className="detail-header">
                <h3 className="detail-title" title={image.filename}>
                    {image.filename}
                </h3>
                <button className="detail-close" onClick={onClose}>
                    ✕
                </button>
            </div>

            <div className="detail-preview">
                {thumbnailSrc && !fullResLoaded && (
                    <img
                        src={thumbnailSrc}
                        alt={image.filename}
                        className="detail-preview-thumb"
                    />
                )}
                <img
                    src={imgSrc}
                    alt={image.filename}
                    loading="eager"
                    onLoad={() => setFullResLoaded(true)}
                    style={{ opacity: fullResLoaded ? 1 : 0 }}
                />
            </div>

            <div className="detail-content-scroll">
                <div className="detail-sections">
                    <div className="detail-section detail-actions">
                        <button
                            className="detail-action-button"
                            onClick={() => copyText(image.raw_metadata, "Raw metadata copied")}
                        >
                            Copy Metadata
                        </button>
                        <button
                            className="detail-action-button"
                            onClick={() => handleExport("json")}
                        >
                            Export JSON
                        </button>
                        <button
                            className="detail-action-button"
                            onClick={handleSendToForge}
                            disabled={isSendingToForge || !forgeBaseUrl.trim()}
                        >
                            {isSendingToForge ? "Sending..." : "Send to Forge"}
                        </button>
                    </div>

                    {statusMessage && (
                        <div className="detail-section">
                            <p className="detail-section-content status-message">{statusMessage}</p>
                        </div>
                    )}

                    <div className="detail-section">
                        <h4 className="detail-section-title">Sidecar Data</h4>
                        <div className="sidecar-form">
                            <label className="sidecar-label">Notes</label>
                            <textarea
                                className="sidecar-textarea"
                                value={sidecarNotes}
                                onChange={(e) => setSidecarNotes(e.target.value)}
                                placeholder="Add notes..."
                                rows={3}
                            />
                            <div className="sidecar-actions">
                                <button
                                    className="detail-action-button primary"
                                    onClick={handleSaveSidecar}
                                    disabled={isSavingSidecar}
                                >
                                    {isSavingSidecar ? "Saving..." : "Save to Sidecar"}
                                </button>
                            </div>
                        </div>
                    </div>

                    {image.prompt && (
                        <div className="detail-section">
                            <div className="section-header-row">
                                <h4 className="detail-section-title">Prompt</h4>
                                <button
                                    className="copy-icon-btn"
                                    onClick={() => copyText(image.prompt, "Prompt copied")}
                                    title="Copy prompt"
                                >
                                    📋
                                </button>
                            </div>
                            <p className="detail-section-content prompt-text">{image.prompt}</p>
                        </div>
                    )}

                    {image.negative_prompt && (
                        <div className="detail-section">
                            <div className="section-header-row">
                                <h4 className="detail-section-title negative">Negative Prompt</h4>
                                <button
                                    className="copy-icon-btn"
                                    onClick={() => copyText(image.negative_prompt, "Negative prompt copied")}
                                    title="Copy negative prompt"
                                >
                                    📋
                                </button>
                            </div>
                            <p className="detail-section-content prompt-text">
                                {image.negative_prompt}
                            </p>
                        </div>
                    )}

                    {paramEntries.length > 0 && (
                        <div className="detail-section">
                            <h4 className="detail-section-title">Parameters</h4>
                            <div className="params-grid">
                                {paramEntries.map(([key, value]) => (
                                    <div key={key} className="param-item">
                                        <span className="param-key">{key}</span>
                                        <span className="param-value">{value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="detail-section">
                        <h4 className="detail-section-title">File Info</h4>
                        <div className="params-grid">
                            <div className="param-item">
                                <span className="param-key">Path</span>
                                <span className="param-value filepath">{image.filepath}</span>
                            </div>
                            <div className="param-item">
                                <span className="param-key">Directory</span>
                                <span className="param-value">{image.directory}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
