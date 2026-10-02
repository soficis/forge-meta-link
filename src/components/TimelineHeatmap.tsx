import { useEffect, useMemo, useState, useCallback } from "react";
import { useFileMtimes } from "../hooks/useFileMtimes";
import { bucketMtimes, formatBucketLabel, DAY_SEC } from "../utils/timelineBuckets";
import type { Bucket } from "../utils/timelineBuckets";
import "./TimelineHeatmap.css";

export interface TimelineRange {
    start: number;
    end: number;
}

interface Props {
    clusterQuery?: string | null;
    onClusterQueryChange?: (q: string) => void;
    onBucketSelect?: (range: TimelineRange | null, bucket: Bucket | null) => void;
    selectedRange?: TimelineRange | null;
}

function heatColor(intensity: number): string {
    const clamped = Math.max(0, Math.min(1, intensity));
    const h = 258;
    const s = 70 + clamped * 20;
    const l = 28 + clamped * 32;
    const a = 0.55 + clamped * 0.45;
    return `hsla(${h}, ${s}%, ${l}%, ${a})`;
}

export function TimelineHeatmap({ clusterQuery, onClusterQueryChange, onBucketSelect, selectedRange }: Props) {
    const [draft, setDraft] = useState(clusterQuery ?? "");
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDraft(clusterQuery ?? "");
    }, [clusterQuery]);
    const { data: mtimes, isLoading } = useFileMtimes(clusterQuery ?? null);

    const buckets = useMemo(() => bucketMtimes(mtimes ?? []), [mtimes]);
    const bucketSec = useMemo(() => {
        if (buckets.length < 2) return DAY_SEC;
        return buckets[0].end - buckets[0].start;
    }, [buckets]);

    const maxCount = useMemo(() => {
        let m = 0;
        for (const b of buckets) if (b.count > m) m = b.count;
        return m || 1;
    }, [buckets]);

    const handleBarClick = useCallback((bucket: Bucket) => {
        if (!onBucketSelect) return;
        const isSame = selectedRange && selectedRange.start === bucket.start && selectedRange.end === bucket.end;
        if (isSame) onBucketSelect(null, null);
        else onBucketSelect({ start: bucket.start, end: bucket.end }, bucket);
    }, [onBucketSelect, selectedRange]);

    const handleClusterSubmit = useCallback(() => {
        onClusterQueryChange?.(draft.trim());
    }, [draft, onClusterQueryChange]);

    const handleClear = useCallback(() => {
        setDraft("");
        onClusterQueryChange?.("");
        onBucketSelect?.(null, null);
    }, [onClusterQueryChange, onBucketSelect]);

    if (isLoading) {
        return <div className="timeline-heatmap"><div className="timeline-heatmap-empty">Loading timeline…</div></div>;
    }

    if (!mtimes || mtimes.length === 0) {
        return <div className="timeline-heatmap"><div className="timeline-heatmap-empty">No dated images yet — scan a folder to see the timeline.</div></div>;
    }

    return (
        <div className="timeline-heatmap" role="region" aria-label="Timeline heatmap">
            <div className="timeline-heatmap-header">
                <span className="timeline-heatmap-title">Timeline · {buckets.length} buckets · {mtimes.length.toLocaleString()} dated</span>
                <div className="timeline-heatmap-controls">
                    <input
                        className="timeline-heatmap-cluster-input"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleClusterSubmit(); }}
                        placeholder="Cluster filter (FTS)… e.g. cat portrait"
                        aria-label="Prompt cluster filter"
                    />
                    <button type="button" className="timeline-heatmap-clear" onClick={handleClusterSubmit}>Filter</button>
                    <button type="button" className="timeline-heatmap-clear" onClick={handleClear}>Clear</button>
                </div>
            </div>

            <div className="timeline-heatmap-bars" role="list" aria-label="file_mtime histogram">
                {buckets.map((b) => {
                    const selected = selectedRange?.start === b.start && selectedRange?.end === b.end;
                    const heightPct = maxCount === 0 ? 4 : Math.max(4, (b.count / maxCount) * 100);
                    return (
                        <div
                            key={b.start}
                            className={`timeline-heatmap-bar-wrap ${selected ? "selected" : ""}`}
                            role="listitem"
                            tabIndex={0}
                            aria-label={`${formatBucketLabel(b.start, bucketSec)} count ${b.count}`}
                            onClick={() => handleBarClick(b)}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleBarClick(b); } }}
                            title={`${formatBucketLabel(b.start, bucketSec)} — ${b.count} images`}
                        >
                            <div
                                className="timeline-heatmap-bar"
                                style={{ height: `${heightPct}%`, background: heatColor(b.intensity) }}
                            />
                            <span className="timeline-heatmap-bar-count">{b.count > 0 ? b.count : ""}</span>
                        </div>
                    );
                })}
            </div>

            <div className="timeline-heatmap-meta">
                <span>Bucket {bucketSec === DAY_SEC ? "day" : "week"} · heat by count</span>
                {selectedRange && <span>Selected {formatBucketLabel(selectedRange.start, bucketSec)} · click again to clear</span>}
                {clusterQuery?.trim() && <span>Cluster “{clusterQuery.trim()}” via FTS5</span>}
            </div>
        </div>
    );
}
