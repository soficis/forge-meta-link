import { useMemo } from "react";
import type { GalleryImageRecord, ImageRecord } from "../types/metadata";
import {
    toCompareMetadata,
    computeDelta,
    type CompareMetadata,
} from "../utils/metadata";
import { CrownIcon } from "./icons";

export interface MetadataDeltaTableProps {
    pins: GalleryImageRecord[];
    detailsMap?: Map<number, ImageRecord>;
    /** Optional pre-built metas (bypasses toCompareMetadata). */
    metas?: CompareMetadata[];
    className?: string;
    /** When true, compact variant for narrow hero. */
    compact?: boolean;
    winnerId?: number | null;
    onPickWinner?: (id: number) => void;
    onMutateWinner?: (id: number) => void;
}

/**
 * Delta table highlights changed keys (seed, cfg, sampler, schedule,
 * model, LoRA, width/height) across 2-4 pinned images.
 *
 * - Changed rows get `delta-changed` class + aria indicator.
 * - Uses <table> semantics for a11y.
 * - No background-image; values rendered as text.
 */
export function MetadataDeltaTable({
    pins,
    detailsMap,
    metas: metasProp,
    className,
    compact = false,
    winnerId = null,
    onPickWinner,
    onMutateWinner,
}: MetadataDeltaTableProps) {
    const metas = useMemo<CompareMetadata[]>(() => {
        if (metasProp) return metasProp;
        return pins.map((p) => toCompareMetadata(p, detailsMap?.get(p.id) ?? null));
    }, [pins, detailsMap, metasProp]);

    const delta = useMemo(() => computeDelta(metas), [metas]);

    if (metas.length < 2) {
        return (
            <div className={`metadata-delta-empty ${className ?? ""}`.trim()} aria-live="polite">
                <p className="metadata-delta-hint">
                    Pin at least 2 images to compare metadata.
                </p>
            </div>
        );
    }

    return (
        <div
            className={`metadata-delta-table-wrapper ${compact ? "compact" : ""} ${className ?? ""}`.trim()}
            data-testid="metadata-delta-table"
        >
            <table className="metadata-delta-table" role="table" aria-label="Metadata delta comparison">
                <thead>
                    <tr>
                        <th scope="col" className="metadata-delta-key-col">
                            Parameter
                        </th>
                        {metas.map((m) => (
                            <th
                                key={m.id}
                                scope="col"
                                className="metadata-delta-pin-col"
                                title={m.filename}
                            >
                                <div style={{ display: "flex", flexDirection: "column", gap: "2px", alignItems: "center" }}>
                                    <span className="metadata-delta-pin-label">{m.filename}</span>
                                    {m.id === winnerId ? (
                                        <div style={{ display: "flex", gap: "4px", alignItems: "center", marginTop: "2px" }}>
                                            <span className="metadata-delta-winner-badge"><CrownIcon size={12} /> Winner</span>
                                            {onMutateWinner && (
                                                <button
                                                    type="button"
                                                    className="compare-lab-btn mutate-btn metadata-delta-action-btn"
                                                    data-testid={`mutate-col-${m.id}`}
                                                    onClick={() => onMutateWinner(m.id)}
                                                >
                                                    Mutate
                                                </button>
                                            )}
                                        </div>
                                    ) : (
                                        onPickWinner && (
                                            <button
                                                type="button"
                                                className="compare-lab-btn pick-winner-btn metadata-delta-action-btn"
                                                data-testid={`pick-winner-col-${m.id}`}
                                                onClick={() => onPickWinner(m.id)}
                                            >
                                                Pick Winner
                                            </button>
                                        )
                                    )}
                                </div>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {delta.rows.map((row) => (
                        <tr
                            key={row.key}
                            className={row.isChanged ? "delta-changed" : "delta-unchanged"}
                            data-delta-key={row.key}
                            data-changed={row.isChanged ? "true" : "false"}
                            aria-label={`${row.label} ${row.isChanged ? "changed" : "unchanged"}`}
                        >
                            <th
                                scope="row"
                                className="metadata-delta-row-label"
                                data-testid={`delta-label-${row.key}`}
                            >
                                <span className="delta-label-text">{row.label}</span>
                                {row.isChanged && (
                                    <span
                                        className="delta-changed-badge"
                                        aria-label="changed"
                                        data-testid={`delta-badge-${row.key}`}
                                    >
                                        •
                                    </span>
                                )}
                            </th>
                            {row.values.map((val, idx) => (
                                <td
                                    key={`${row.key}-${metas[idx].id}`}
                                    className={`metadata-delta-cell ${row.isChanged ? "delta-cell-changed" : ""}`.trim()}
                                    data-testid={`delta-cell-${row.key}-${idx}`}
                                    title={val}
                                >
                                    <span className="delta-cell-value">{val}</span>
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>

            {delta.hasAnyChange ? (
                <p className="metadata-delta-footnote">Highlighted rows differ across pins.</p>
            ) : (
                <p className="metadata-delta-footnote muted">All parameters identical across pins.</p>
            )}
        </div>
    );
}

export default MetadataDeltaTable;
