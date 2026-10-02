import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { StorageProfile } from "../types/metadata";
import {
    getDuplicateGroups,
    inferLineage,
    openFileLocation,
    type DuplicateGroup,
    type ThumbnailCacheComplete,
    type ThumbnailCacheProgress,
} from "../services/commands";
import { getForgeUrlError } from "../utils/forgeUrl";
import type { ShowToastOptions } from "../hooks/useToast";

export type SettingsSectionId = "library" | "safety" | "forge";

interface SettingsDialogProps {
    initialSection?: SettingsSectionId;
    onClose: () => void;
    onShowToast?: (message: string, options?: ShowToastOptions) => void;
    storageProfile: StorageProfile;
    onStorageProfileChange: (profile: StorageProfile) => void;
    onPrecacheAllThumbnails: (force?: boolean) => void;
    isPrecachingThumbnails: boolean;
    isScanning: boolean;
    thumbnailCacheProgress: ThumbnailCacheProgress | null;
    thumbnailCacheResult: ThumbnailCacheComplete | null;
    autoLockFavorites: boolean;
    onAutoLockFavoritesChange: (value: boolean) => void;
    forgeBaseUrl: string;
    onForgeBaseUrlChange: (value: string) => void;
    forgeApiKey: string;
    onForgeApiKeyChange: (value: string) => void;
    forgeApiKeyError?: string | null;
    isForgeApiKeyLoaded?: boolean;
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
    isTestingForge: boolean;
}

const SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
    { id: "library", label: "Library" },
    { id: "safety", label: "Deletion safety" },
    { id: "forge", label: "Forge connection" },
];

const CACHE_PHASE_LABELS: Record<string, string> = {
    preparing: "Preparing",
    generating: "Generating thumbnails",
};

function basename(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

async function pickFolder(title: string): Promise<string | null> {
    const selected = await open({ directory: true, multiple: false, title });
    return typeof selected === "string" ? selected : null;
}

interface FieldProps {
    label: string;
    hint?: string;
    error?: string | null;
    children: (id: string, describedBy: string | undefined) => ReactNode;
}

function Field({ label, hint, error, children }: FieldProps) {
    const id = useId();
    const hintId = `${id}-hint`;
    const describedBy = error || hint ? hintId : undefined;
    return (
        <div className="settings-field">
            <label className="settings-label" htmlFor={id}>
                {label}
            </label>
            {children(id, describedBy)}
            {error ? (
                <p id={hintId} className="input-error" role="alert">
                    {error}
                </p>
            ) : hint ? (
                <p id={hintId} className="settings-hint">
                    {hint}
                </p>
            ) : null}
        </div>
    );
}

interface FolderFieldProps {
    label: string;
    hint: string;
    value: string;
    placeholder: string;
    pickerTitle: string;
    onChange: (value: string) => void;
}

function FolderField({ label, hint, value, placeholder, pickerTitle, onChange }: FolderFieldProps) {
    return (
        <Field label={label} hint={hint}>
            {(id, describedBy) => (
                <div className="settings-inline">
                    <input
                        id={id}
                        className="sidebar-input"
                        value={value}
                        placeholder={placeholder}
                        aria-describedby={describedBy}
                        onChange={(event) => onChange(event.target.value)}
                    />
                    <button
                        type="button"
                        className="sidebar-button"
                        onClick={async () => {
                            const folder = await pickFolder(pickerTitle);
                            if (folder) onChange(folder);
                        }}
                    >
                        Browse…
                    </button>
                </div>
            )}
        </Field>
    );
}

export function SettingsDialog(props: SettingsDialogProps) {
    const { initialSection = "library", onClose } = props;
    const [section, setSection] = useState<SettingsSectionId>(initialSection);
    const dialogRef = useRef<HTMLDivElement>(null);
    const titleId = useId();

    const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[] | null>(null);
    const [duplicatesLoading, setDuplicatesLoading] = useState(false);
    const [duplicatesError, setDuplicatesError] = useState<string | null>(null);

    useEffect(() => {
        const previouslyFocused = document.activeElement as HTMLElement | null;
        dialogRef.current?.focus();
        return () => previouslyFocused?.focus?.();
    }, []);

    const [isRebuildingLineage, setIsRebuildingLineage] = useState(false);

    const handleRebuildLineage = useCallback(async () => {
        setIsRebuildingLineage(true);
        try {
            const count = await inferLineage();
            props.onShowToast?.(`Lineage rebuild complete: ${count} edges in library.`, {
                tone: "success",
            });
        } catch (error) {
            props.onShowToast?.(`Failed to rebuild lineage: ${String(error)}`, {
                tone: "error",
            });
        } finally {
            setIsRebuildingLineage(false);
        }
    }, [props]);

    const handleScanDuplicates = useCallback(async () => {
        setDuplicatesLoading(true);
        setDuplicatesError(null);
        try {
            setDuplicateGroups(await getDuplicateGroups());
        } catch (error) {
            setDuplicatesError(String(error));
        } finally {
            setDuplicatesLoading(false);
        }
    }, []);

    const forgeUrlError = getForgeUrlError(props.forgeBaseUrl);
    const cacheProgress = props.thumbnailCacheProgress;

    return (
        <div
            className="settings-backdrop"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={dialogRef}
                className="settings-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                onKeyDown={(event) => {
                    // Keep gallery/viewer shortcuts (f, 1-4, Delete…) from firing behind the dialog.
                    event.stopPropagation();
                    if (event.key === "Escape") {
                        event.preventDefault();
                        onClose();
                    }
                }}
            >
                <header className="settings-header">
                    <h2 id={titleId}>Settings</h2>
                    <button
                        type="button"
                        className="viewer-control-button"
                        onClick={onClose}
                        aria-label="Close settings"
                    >
                        ✕
                    </button>
                </header>

                <div className="settings-body">
                    <nav className="settings-nav" aria-label="Settings sections">
                        {SECTIONS.map((entry) => (
                            <button
                                key={entry.id}
                                type="button"
                                className={`settings-nav-item ${section === entry.id ? "active" : ""}`}
                                aria-current={section === entry.id ? "page" : undefined}
                                onClick={() => setSection(entry.id)}
                            >
                                {entry.label}
                            </button>
                        ))}
                    </nav>

                    <div className="settings-content">
                        {section === "library" && (
                            <>
                                <section className="settings-group">
                                    <h3>Storage type</h3>
                                    <div className="profile-toggle-row" role="radiogroup" aria-label="Storage type">
                                        {(["ssd", "hdd"] as const).map((profile) => (
                                            <button
                                                key={profile}
                                                type="button"
                                                role="radio"
                                                aria-checked={props.storageProfile === profile}
                                                className={`profile-toggle-button ${props.storageProfile === profile ? "active" : ""}`}
                                                onClick={() => props.onStorageProfileChange(profile)}
                                            >
                                                {profile.toUpperCase()}
                                            </button>
                                        ))}
                                    </div>
                                    <p className="settings-hint">
                                        Match the drive your images live on. Tunes indexing, thumbnail
                                        generation and caching for that kind of drive.
                                    </p>
                                </section>

                                <section className="settings-group">
                                    <h3>Thumbnail cache</h3>
                                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                        <button
                                            type="button"
                                            className="sidebar-button"
                                            onClick={() => props.onPrecacheAllThumbnails(false)}
                                            disabled={props.isPrecachingThumbnails || props.isScanning}
                                        >
                                            {props.isPrecachingThumbnails
                                                ? "Building thumbnails…"
                                                : "Build missing thumbnails"}
                                        </button>
                                        <button
                                            type="button"
                                            className="sidebar-button"
                                            onClick={() => props.onPrecacheAllThumbnails(true)}
                                            disabled={props.isPrecachingThumbnails || props.isScanning}
                                            title="Forces re-generation and overwrites any existing cached thumbnails"
                                        >
                                            Force Rebuild All
                                        </button>
                                    </div>
                                    <p className="settings-hint">
                                        Generates high-quality thumbnails for the whole library so
                                        scrolling never waits. Can take a while on large libraries.
                                    </p>
                                    {cacheProgress && (
                                        <div className="scan-progress-container" aria-live="polite">
                                            <div className="scan-progress-labels">
                                                <span className="scan-stage">
                                                    {CACHE_PHASE_LABELS[cacheProgress.phase] ?? cacheProgress.phase}
                                                </span>
                                                <span className="scan-count">
                                                    {cacheProgress.current} / {cacheProgress.total || "?"}
                                                </span>
                                            </div>
                                            <div className="scan-progress-bar-bg">
                                                <div
                                                    className="scan-progress-bar-fill"
                                                    style={{
                                                        width: `${cacheProgress.total ? (cacheProgress.current / cacheProgress.total) * 100 : 0}%`,
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    )}
                                    {!props.isPrecachingThumbnails && props.thumbnailCacheResult && (
                                        <p className="settings-hint">
                                            Done: {props.thumbnailCacheResult.generated} created,{" "}
                                            {props.thumbnailCacheResult.skipped} already cached
                                            {props.thumbnailCacheResult.failed > 0 &&
                                                `, ${props.thumbnailCacheResult.failed} could not be read`}
                                            .
                                        </p>
                                    )}
                                </section>

                                <section className="settings-group">
                                    <h3>Lineage</h3>
                                    <button
                                        type="button"
                                        className="sidebar-button"
                                        onClick={handleRebuildLineage}
                                        disabled={isRebuildingLineage || props.isScanning}
                                    >
                                        {isRebuildingLineage ? "Rebuilding lineage…" : "Rebuild lineage"}
                                    </button>
                                    <p className="settings-hint">
                                        Recalculates automatic links across all images in the library while preserving manual links and unlinks.
                                    </p>
                                </section>

                                <section className="settings-group">
                                    <h3>Duplicate files</h3>
                                    <button
                                        type="button"
                                        className="sidebar-button"
                                        onClick={handleScanDuplicates}
                                        disabled={duplicatesLoading}
                                    >
                                        {duplicatesLoading ? "Looking for duplicates…" : "Find duplicate files"}
                                    </button>
                                    <p className="settings-hint">
                                        Finds files that are very likely copies (same size, matching
                                        content samples). Check them before deleting. Shows up to 100
                                        groups; click a file to show it in its folder.
                                    </p>
                                    {duplicatesError != null && (
                                        <p className="input-error" role="alert">
                                            Could not check for duplicates: {duplicatesError}
                                        </p>
                                    )}
                                    {duplicateGroups != null && !duplicatesLoading && duplicatesError == null && (
                                        duplicateGroups.length === 0 ? (
                                            <p className="settings-hint">No duplicates found.</p>
                                        ) : (
                                            <ul className="settings-duplicate-list" data-testid="duplicate-groups">
                                                {duplicateGroups.map((group) => (
                                                    <li key={group.quick_hash}>
                                                        <span className="settings-duplicate-count">
                                                            {group.count} likely copies
                                                        </span>
                                                        <ul>
                                                            {group.sample_filepaths.map((path) => (
                                                                <li key={path}>
                                                                    <button
                                                                        type="button"
                                                                        className="settings-link-button"
                                                                        title={`Show ${path} in folder`}
                                                                        onClick={() => void openFileLocation(path)}
                                                                    >
                                                                        {basename(path)}
                                                                    </button>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    </li>
                                                ))}
                                            </ul>
                                        )
                                    )}
                                </section>
                            </>
                        )}

                        {section === "safety" && (
                            <section className="settings-group">
                                <h3>Locking</h3>
                                <label className="sidebar-checkbox-row">
                                    <input
                                        type="checkbox"
                                        checked={props.autoLockFavorites}
                                        onChange={(event) =>
                                            props.onAutoLockFavoritesChange(event.target.checked)
                                        }
                                    />
                                    Lock images when I favorite them
                                </label>
                                <p className="settings-hint">
                                    Only locked images are protected from deletion. Favorites are
                                    just a marker unless this is on.
                                </p>
                            </section>
                        )}

                        {section === "forge" && (
                            <section className="settings-group">
                                <h3>Forge connection</h3>
                                <Field
                                    label="Forge URL"
                                    hint="Root address only (no /sdapi/v1). Start Forge with --api."
                                    error={forgeUrlError}
                                >
                                    {(id, describedBy) => (
                                        <input
                                            id={id}
                                            className={`sidebar-input ${forgeUrlError ? "input-invalid" : ""}`}
                                            value={props.forgeBaseUrl}
                                            placeholder="http://127.0.0.1:7860"
                                            aria-invalid={forgeUrlError != null}
                                            aria-describedby={describedBy}
                                            onChange={(event) => props.onForgeBaseUrlChange(event.target.value)}
                                        />
                                    )}
                                </Field>
                                <Field
                                    label="API key"
                                    hint={props.forgeApiKeyError ? props.forgeApiKeyError : "Optional. Stored in your system keychain."}
                                    error={props.forgeApiKeyError ?? undefined}
                                >
                                    {(id, describedBy) => (
                                        <input
                                            id={id}
                                            className="sidebar-input"
                                            type="password"
                                            value={props.forgeApiKey}
                                            disabled={props.isForgeApiKeyLoaded === false && !!props.forgeApiKeyError}
                                            placeholder={props.forgeApiKeyError ? "Could not read saved key" : ""}
                                            aria-describedby={describedBy}
                                            onChange={(event) => props.onForgeApiKeyChange(event.target.value)}
                                        />
                                    )}
                                </Field>
                                <button
                                    type="button"
                                    className="sidebar-button"
                                    onClick={props.onForgeTestConnection}
                                    disabled={props.isTestingForge || forgeUrlError != null}
                                >
                                    {props.isTestingForge ? "Testing…" : "Test connection"}
                                </button>

                                <h3>Folders</h3>
                                <FolderField
                                    label="Output folder"
                                    hint="Where images generated through Forge are saved. Leave blank to use forge-outputs in the app data folder."
                                    value={props.forgeOutputDir}
                                    placeholder="forge-outputs"
                                    pickerTitle="Select Forge output folder"
                                    onChange={props.onForgeOutputDirChange}
                                />
                                <FolderField
                                    label="Models folder"
                                    hint="Checkpoints found here fill the model list in the viewer's Forge tab."
                                    value={props.forgeModelsPath}
                                    placeholder="Not set"
                                    pickerTitle="Select Forge models folder"
                                    onChange={props.onForgeModelsPathChange}
                                />
                                <label className="sidebar-checkbox-row">
                                    <input
                                        type="checkbox"
                                        checked={props.forgeModelsScanSubfolders}
                                        onChange={(event) =>
                                            props.onForgeModelsScanSubfoldersChange(event.target.checked)
                                        }
                                    />
                                    Include model subfolders
                                </label>
                                <FolderField
                                    label="LoRA folder"
                                    hint="LoRAs found here can be added to prompts in the viewer's Forge tab."
                                    value={props.forgeLoraPath}
                                    placeholder="Not set"
                                    pickerTitle="Select Forge LoRA folder"
                                    onChange={props.onForgeLoraPathChange}
                                />
                                <label className="sidebar-checkbox-row">
                                    <input
                                        type="checkbox"
                                        checked={props.forgeLoraScanSubfolders}
                                        onChange={(event) =>
                                            props.onForgeLoraScanSubfoldersChange(event.target.checked)
                                        }
                                    />
                                    Include LoRA subfolders
                                </label>

                                <h3>Generation defaults</h3>
                                <label className="sidebar-checkbox-row">
                                    <input
                                        type="checkbox"
                                        checked={props.forgeIncludeSeed}
                                        onChange={(event) => props.onForgeIncludeSeedChange(event.target.checked)}
                                    />
                                    Reuse the original seed
                                </label>
                                <label className="sidebar-checkbox-row">
                                    <input
                                        type="checkbox"
                                        checked={props.forgeAdetailerFaceEnabled}
                                        onChange={(event) =>
                                            props.onForgeAdetailerFaceEnabledChange(event.target.checked)
                                        }
                                    />
                                    Fix faces with ADetailer
                                </label>
                                <Field label="ADetailer face model">
                                    {(id) => (
                                        <select
                                            id={id}
                                            className="sidebar-input"
                                            value={props.forgeAdetailerFaceModel}
                                            disabled={!props.forgeAdetailerFaceEnabled}
                                            onChange={(event) =>
                                                props.onForgeAdetailerFaceModelChange(event.target.value)
                                            }
                                        >
                                            <option value="face_yolov8n.pt">face_yolov8n.pt (faster)</option>
                                            <option value="face_yolov8s.pt">face_yolov8s.pt (more accurate)</option>
                                        </select>
                                    )}
                                </Field>
                            </section>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
