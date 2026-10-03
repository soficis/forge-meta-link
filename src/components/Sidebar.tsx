import { type ReactNode, useCallback, useState } from "react";
import type { DeleteHistoryEntry, TagCount, TagProvenance } from "../types/metadata";
import { getTagProvenance } from "../services/commands";
import type { ScanProgress, ScanComplete } from "../services/commands";
import { usePersistedState } from "../hooks/usePersistedState";
import { BookmarkIcon, GearIcon } from "./icons";

interface SidebarProps {
    isCollapsed: boolean;
    onToggleCollapsed: () => void;
    onPickFolderToScan: () => void;
    isScanning: boolean;
    scanProgress: ScanProgress | null;
    scanResult: ScanComplete | null;
    topTags: TagCount[];
    onAddIncludeTag: (tag: string) => void;
    recentDeleteHistory: DeleteHistoryEntry[];
    onClearDeleteHistory: () => void;
    columnCount: number;
    onColumnCountChange: (count: number) => void;
    onOpenSettings: () => void;
    onOpenPromptLibrary: () => void;
}

const SCAN_STAGE_LABELS: Record<ScanProgress["stage"], string> = {
    scanning: "Finding images",
    indexing: "Reading metadata",
    thumbnails: "Creating thumbnails",
};

function formatMtime(value: number): string {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

type SidebarSectionId = "gridSize" | "topTags" | "recentDeletes";

const SIDEBAR_SECTION_STORAGE_KEY = "sidebarSectionExpanded:v3";

const DEFAULT_SECTION_EXPANDED: Record<SidebarSectionId, boolean> = {
    gridSize: true,
    topTags: true,
    recentDeletes: false,
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
    onPickFolderToScan,
    isScanning,
    scanProgress,
    scanResult,
    topTags,
    onAddIncludeTag,
    recentDeleteHistory,
    onClearDeleteHistory,
    columnCount,
    onColumnCountChange,
    onOpenSettings,
    onOpenPromptLibrary,
}: SidebarProps) {
    const [topTagsExpanded, setTopTagsExpanded] = useState(false);
    const [sectionExpanded, setSectionExpanded] = usePersistedState<
        Record<SidebarSectionId, boolean>
    >(
        SIDEBAR_SECTION_STORAGE_KEY,
        DEFAULT_SECTION_EXPANDED,
        sidebarSectionExpandedStorage
    );
    const [provenanceTag, setProvenanceTag] = useState<string | null>(null);
    const [provenanceData, setProvenanceData] = useState<TagProvenance | null>(null);
    const [provenanceLoading, setProvenanceLoading] = useState(false);
    const [provenanceError, setProvenanceError] = useState<string | null>(null);

    const handleToggleProvenance = useCallback(
        async (tag: string) => {
            if (provenanceTag === tag) {
                setProvenanceTag(null);
                setProvenanceData(null);
                setProvenanceError(null);
                return;
            }
            setProvenanceTag(tag);
            setProvenanceData(null);
            setProvenanceError(null);
            setProvenanceLoading(true);
            try {
                const info = await getTagProvenance(tag);
                setProvenanceData(info);
            } catch (error) {
                setProvenanceError(String(error));
            } finally {
                setProvenanceLoading(false);
            }
        },
        [provenanceTag]
    );

    const applyIncludeTag = (rawTag: string) => {
        const tag = rawTag.trim().toLowerCase();
        if (!tag) return;
        onAddIncludeTag(tag);
    };

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
                    aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                    aria-expanded={!isCollapsed}
                >
                    {isCollapsed ? "»" : "«"}
                </button>
            </div>

            {!isCollapsed && <div className="sidebar-content">
                <button
                    type="button"
                    className="scan-button"
                    onClick={onPickFolderToScan}
                    disabled={isScanning}
                >
                    {isScanning ? (
                        <>
                            <span className="spinner" />
                            Scanning…
                        </>
                    ) : (
                        <>
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className="btn-icon"
                                aria-hidden="true"
                            >
                                <path d="M3 7v10c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2h-6l-2-2H5c-1.1 0-2 .9-2 2z" />
                            </svg>
                            Scan Folder
                        </>
                    )}
                </button>

                {isScanning && scanProgress && (
                    <div className="scan-progress-container" aria-live="polite">
                        <div className="scan-progress-labels">
                            <span className="scan-stage">
                                {SCAN_STAGE_LABELS[scanProgress.stage] ?? scanProgress.stage}
                            </span>
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
                            <span className="scan-stat-label">Files found</span>
                        </div>
                        <div className="scan-stat">
                            <span className="scan-stat-number success">
                                {scanResult.indexed}
                            </span>
                            <span className="scan-stat-label">Added</span>
                        </div>
                        {scanResult.errors > 0 && (
                            <div className="scan-stat">
                                <span className="scan-stat-number error">
                                    {scanResult.errors}
                                </span>
                                <span className="scan-stat-label">Unreadable</span>
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
                            aria-label="Columns"
                            onChange={(e) => onColumnCountChange(Number(e.target.value))}
                        />
                        <span className="grid-slider-label">{columnCount} cols</span>
                    </div>
                </CollapsibleSidebarSection>

                <CollapsibleSidebarSection
                    id="topTags"
                    title="Top Tags"
                    isExpanded={sectionExpanded.topTags}
                    onToggle={toggleSection}
                >
                    <p className="sidebar-help">Click a tag to filter by it.</p>
                    <div className="tag-suggestions">
                        {displayedTopTags.map((entry, index) => (
                            <span key={`top-${entry.tag}`} className="tag-suggestion-pair">
                                <button
                                    type="button"
                                    className="tag-suggestion"
                                    onClick={() => applyIncludeTag(entry.tag)}
                                    title={`Show only images tagged ${entry.tag}`}
                                >
                                    #{index + 1} {entry.tag} ({entry.count})
                                </button>
                                <button
                                    type="button"
                                    className="tag-suggestion"
                                    aria-label={`Tag history for ${entry.tag}`}
                                    aria-pressed={provenanceTag === entry.tag}
                                    title="When was this tag first and last used?"
                                    onClick={() => handleToggleProvenance(entry.tag)}
                                >
                                    i
                                </button>
                            </span>
                        ))}
                    </div>
                    {provenanceTag != null && (
                        <div className="sidebar-help" data-testid="tag-provenance" aria-live="polite">
                            <strong>{provenanceTag}</strong>
                            {provenanceLoading && <span> — loading…</span>}
                            {!provenanceLoading && provenanceError != null && (
                                <span> — could not load: {provenanceError}</span>
                            )}
                            {!provenanceLoading &&
                                provenanceError == null &&
                                provenanceData != null && (
                                    <span>
                                        {" "}
                                        — {provenanceData.count} images, first used{" "}
                                        {provenanceData.first_seen != null
                                            ? formatMtime(provenanceData.first_seen)
                                            : "?"}
                                        , last used{" "}
                                        {provenanceData.last_seen != null
                                            ? formatMtime(provenanceData.last_seen)
                                            : "?"}
                                        {provenanceData.sample_filepaths.length > 0 &&
                                            `; e.g. ${provenanceData.sample_filepaths
                                                .map((path) => path.split(/[\\/]/).pop() ?? path)
                                                .join(", ")}`}
                                    </span>
                                )}
                        </div>
                    )}
                    {topTags.length > 10 && (
                        <button
                            type="button"
                            className="sidebar-button"
                            onClick={() => setTopTagsExpanded((prev) => !prev)}
                        >
                            {topTagsExpanded ? "Show top 10" : "Show more"}
                        </button>
                    )}
                </CollapsibleSidebarSection>

                <CollapsibleSidebarSection
                    id="recentDeletes"
                    title="Recently Deleted"
                    isExpanded={sectionExpanded.recentDeletes}
                    onToggle={toggleSection}
                >
                    <div className="recent-delete-panel">
                        <div className="recent-delete-group">
                            <span className="recent-delete-group-title">Waiting (can undo)</span>
                            {pendingDeletes.length === 0 ? (
                                <p className="sidebar-help">Nothing waiting.</p>
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
                            <span className="recent-delete-group-title">Done</span>
                            {finalizedDeletes.length === 0 ? (
                                <p className="sidebar-help">No deletions yet.</p>
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

                        <button
                            className="sidebar-button"
                            type="button"
                            onClick={onClearDeleteHistory}
                            disabled={recentDeleteHistory.length === 0}
                        >
                            Clear history
                        </button>
                    </div>
                </CollapsibleSidebarSection>
            </div>}

            <div className="sidebar-footer">
                <button
                    type="button"
                    className="sidebar-button"
                    onClick={onOpenPromptLibrary}
                    title="Prompt library"
                    aria-label="Prompt library"
                >
                    <BookmarkIcon />
                    {!isCollapsed && <span>Prompt library</span>}
                </button>
                <button
                    type="button"
                    className="sidebar-button sidebar-settings-button"
                    onClick={onOpenSettings}
                    title="Settings"
                    aria-label="Settings"
                >
                    <GearIcon />
                    {!isCollapsed && <span>Settings</span>}
                </button>
            </div>
        </div>
    );
}
