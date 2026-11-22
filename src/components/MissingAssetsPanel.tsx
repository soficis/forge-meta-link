import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { detectMissingAssets, forgeGetOptions } from "../services/commands";
import type { AssetReport, AssetStatus } from "../types/assets";
import { Modal } from "./Modal";

export interface MissingAssetsPanelProps {
    onClose: () => void;
    forgeBaseUrl: string;
    forgeApiKey?: string;
}

type LoadState =
    | { kind: "loading" }
    | { kind: "ready"; report: AssetReport }
    | { kind: "error"; message: string };

/** Friendly, single-line copy — never a bare `Error: ...` dump. */
function describeFailure(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const detail = raw.replace(/^Error:\s*/i, "").trim();
    return detail.length > 0
        ? `The asset check could not be completed (${detail}).`
        : "The asset check could not be completed. Please try again.";
}

function pathHint(asset: AssetStatus): string {
    return asset.path_hint && asset.path_hint.trim().length > 0
        ? asset.path_hint
        : "no path hint";
}

const PANEL_STYLE: CSSProperties = {
    width: "min(760px, 100%)",
    maxHeight: "min(82vh, 720px)",
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-highlight)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-lg)",
    outline: "none",
    overflow: "hidden",
};

const HEADER_STYLE: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "14px 20px",
    borderBottom: "1px solid var(--border)",
};

const HEADER_ROW_STYLE: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
};

const TITLE_STYLE: CSSProperties = {
    flex: 1,
    margin: 0,
    fontSize: "16px",
    fontWeight: 600,
    color: "var(--text-primary)",
};

const BODY_STYLE: CSSProperties = {
    padding: "14px 20px 20px",
    overflowY: "auto",
    minHeight: "120px",
};

const SUMMARY_STYLE: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: "18px",
    fontSize: "12px",
    color: "var(--text-secondary)",
};

const SECTION_STYLE: CSSProperties = { marginTop: "16px" };

const SECTION_TITLE_STYLE: CSSProperties = {
    margin: "0 0 8px",
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--text-primary)",
};

const TABLE_STYLE: CSSProperties = {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "12px",
};

const CELL_STYLE: CSSProperties = {
    padding: "7px 10px",
    borderBottom: "1px solid var(--border)",
    textAlign: "left",
    verticalAlign: "top",
    wordBreak: "break-word",
};

const HEAD_CELL_STYLE: CSSProperties = {
    ...CELL_STYLE,
    color: "var(--text-secondary)",
    fontWeight: 600,
    fontSize: "11px",
};

const MUTED_STYLE: CSSProperties = {
    margin: 0,
    fontSize: "12px",
    color: "var(--text-secondary)",
};

function AssetSection({
    title,
    assets,
    testId,
}: {
    title: string;
    assets: AssetStatus[];
    testId: string;
}) {
    return (
        <section data-testid={testId} style={SECTION_STYLE}>
            <h3 style={SECTION_TITLE_STYLE}>{title}</h3>
            {assets.length === 0 ? (
                <p style={MUTED_STYLE}>None missing.</p>
            ) : (
                <table style={TABLE_STYLE}>
                    <thead>
                        <tr>
                            <th scope="col" style={HEAD_CELL_STYLE}>Name</th>
                            <th scope="col" style={HEAD_CELL_STYLE}>Path hint</th>
                            <th scope="col" style={HEAD_CELL_STYLE}>Referencing images</th>
                        </tr>
                    </thead>
                    <tbody>
                        {assets.map((asset, index) => (
                            <tr key={`${asset.name}-${index}`}>
                                <td style={CELL_STYLE}>{asset.name}</td>
                                <td style={CELL_STYLE}>{pathHint(asset)}</td>
                                <td style={CELL_STYLE}>{asset.referencing_image_count}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}

/**
 * Read-only report of referenced models/LoRAs the backend could not find.
 * Detection starts when the panel is opened (i.e. on the toolbar button click):
 * it first asks Forge for its scan directories, then runs the detector.
 */
export function MissingAssetsPanel({
    onClose,
    forgeBaseUrl,
    forgeApiKey,
}: MissingAssetsPanelProps) {
    const [state, setState] = useState<LoadState>({ kind: "loading" });
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const requestSeq = useRef(0);

    const load = useCallback(async () => {
        const seq = ++requestSeq.current;
        setState({ kind: "loading" });
        try {
            const apiKey = forgeApiKey?.trim() ? forgeApiKey : null;
            const options = await forgeGetOptions(
                forgeBaseUrl,
                apiKey,
                null,
                true,
                null,
                true
            );
            const modelsDir = options.models_scan_dir;
            const lorasDir = options.loras_scan_dir;
            if (!modelsDir || !lorasDir) {
                if (seq === requestSeq.current) {
                    setState({
                        kind: "error",
                        message: "Forge did not report a models/LoRA scan directory",
                    });
                }
                return;
            }
            // Empty `dirs` covers every indexed image directory; the Forge scan dirs
            // are what let the backend resolve each referenced asset on disk.
            const report = await detectMissingAssets([], modelsDir, lorasDir);
            if (seq === requestSeq.current) {
                setState({ kind: "ready", report });
            }
        } catch (error) {
            if (seq === requestSeq.current) {
                setState({ kind: "error", message: describeFailure(error) });
            }
        }
    }, [forgeApiKey, forgeBaseUrl]);

    useEffect(() => {
        // Initial load is asynchronous IPC: state is only set from the async callbacks in
        // `load`, never synchronously in this effect body. This is external-system sync,
        // not render-derived state.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
    }, [load]);

    const missingModels =
        state.kind === "ready" ? state.report.models.filter((asset) => !asset.found) : [];
    const missingLoras =
        state.kind === "ready" ? state.report.loras.filter((asset) => !asset.found) : [];
    const allFound = missingModels.length === 0 && missingLoras.length === 0;

    return (
        <Modal
            labelledBy="missing-assets-title"
            label="Missing assets"
            className="missing-assets-panel"
            style={PANEL_STYLE}
            onClose={onClose}
            initialFocusRef={closeButtonRef}
            data-testid="missing-assets-dialog"
        >
            <header style={HEADER_STYLE}>
                <div style={HEADER_ROW_STYLE}>
                    <h2 id="missing-assets-title" style={TITLE_STYLE}>Missing assets</h2>
                    <button
                        ref={closeButtonRef}
                        type="button"
                        className="sidebar-button"
                        aria-label="Close missing assets"
                        onClick={onClose}
                    >
                        Close
                    </button>
                </div>
                {state.kind === "ready" && (
                    <div style={SUMMARY_STYLE}>
                        <span data-testid="missing-assets-model-count">
                            missing {missingModels.length} of {state.report.total_referenced_models} models
                        </span>
                        <span data-testid="missing-assets-lora-count">
                            missing {missingLoras.length} of {state.report.total_referenced_loras} loras
                        </span>
                    </div>
                )}
            </header>

            <div style={BODY_STYLE}>
                {state.kind === "loading" ? (
                    <div role="status" aria-live="polite" data-testid="missing-assets-loading">
                        <div className="spinner" />
                        <p style={MUTED_STYLE}>Checking referenced models and LoRAs…</p>
                    </div>
                ) : state.kind === "error" ? (
                    <div role="alert" aria-live="assertive" data-testid="missing-assets-error">
                        <p style={MUTED_STYLE}>{state.message}</p>
                        <button
                            type="button"
                            className="detail-action-button"
                            style={{ marginTop: "12px" }}
                            onClick={() => void load()}
                        >
                            Retry
                        </button>
                    </div>
                ) : allFound ? (
                    <p role="status" data-testid="missing-assets-all-found" style={MUTED_STYLE}>
                        Every referenced model and LoRA was found.
                    </p>
                ) : (
                    <>
                        <AssetSection
                            title="Missing models"
                            assets={missingModels}
                            testId="missing-assets-models"
                        />
                        <AssetSection
                            title="Missing LoRAs"
                            assets={missingLoras}
                            testId="missing-assets-loras"
                        />
                    </>
                )}
            </div>
        </Modal>
    );
}
