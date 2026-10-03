import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
    DndContext,
    closestCenter,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from "@dnd-kit/core";
import {
    SortableContext,
    useSortable,
    horizontalListSortingStrategy,
    arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCompareLabStore, isCompareReady } from "../store/compareLabStore";
import { MetadataDeltaTable } from "./MetadataDeltaTable";
import { MutationPopover } from "./MutationPopover";
import { useForgeSettings } from "../hooks/useForgeSettings";
import type { GalleryImageRecord, ImageRecord } from "../types/metadata";
import { getImageDetail, getLineageCursor, getSeedWalk } from "../services/commands";
import type { LineageCursor } from "../types/metadata";
import { BoltIcon, CrownIcon, TrophyIcon } from "./icons";
import "./CompareLab.css";

function toAssetSrc(filepath: string): string {
    return convertFileSrc(filepath.replace(/\\/g, "/"));
}

type SwipeMode = "thumb" | "full";

interface SortablePinProps {
    image: GalleryImageRecord;
    isWinner: boolean;
    onPickWinner: (id: number) => void;
    onRemove: (id: number) => void;
}

function SortablePinCard({ image, isWinner, onPickWinner, onRemove }: SortablePinProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: String(image.id),
    });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`compare-lab-pin-card ${isDragging ? "dragging" : ""} ${isWinner ? "is-winner" : ""}`.trim()}
            data-testid={`compare-pin-${image.id}`}
        >
            <div className="compare-lab-pin-thumb">
                <img
                    src={toAssetSrc(image.filepath)}
                    alt={image.filename}
                    loading="lazy"
                    decoding="async"
                />
            </div>
            <div className="compare-lab-pin-info">
                <span className="compare-lab-pin-filename" title={image.filename}>
                    {image.filename}
                </span>
                <span className="compare-lab-pin-meta">
                    {image.model_name ?? "Unknown model"} {image.seed ? `• Seed ${image.seed}` : ""}
                </span>
            </div>
            <div className="compare-lab-pin-actions">
                <button
                    type="button"
                    className={`compare-lab-pin-winner-btn ${isWinner ? "active" : ""}`}
                    aria-label={`Set ${image.filename} as winner`}
                    title={isWinner ? "Active winner for mutations" : "Pick winner"}
                    onClick={() => onPickWinner(image.id)}
                    data-testid={`pin-winner-${image.id}`}
                >
                    {isWinner ? <><TrophyIcon /> Winner</> : <><CrownIcon /> Win</>}
                </button>
                <button
                    type="button"
                    className="compare-lab-pin-handle"
                    aria-label={`Drag ${image.filename}`}
                    {...attributes}
                    {...listeners}
                >
                    ⋮⋮
                </button>
                <button
                    type="button"
                    className="compare-lab-pin-remove"
                    aria-label={`Remove ${image.filename}`}
                    onClick={() => onRemove(image.id)}
                >
                    ✕
                </button>
            </div>
        </div>
    );
}

function SkeletonCard({ index }: { index: number }) {
    return (
        <div className="compare-lab-skeleton-card" data-testid={`compare-skeleton-${index}`} aria-hidden="true">
            <div className="compare-lab-skeleton-thumb" />
            <div className="compare-lab-skeleton-text" />
        </div>
    );
}

/* ── SwipeSlider (60fps, RAF, pointer) ────────────────────────────── */

interface SwipeSliderProps {
    left: GalleryImageRecord;
    right: GalleryImageRecord;
    mode: SwipeMode;
}

function SwipeSlider({ left, right, mode }: SwipeSliderProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState(50);
    const rafRef = useRef<number | null>(null);
    const pendingPosRef = useRef<number>(50);
    const rectRef = useRef<DOMRect | null>(null);
    const draggingRef = useRef(false);

    const flush = useCallback(() => {
        rafRef.current = null;
        setPos(pendingPosRef.current);
    }, []);

    const schedule = useCallback(
        (next: number) => {
            const clamped = Math.max(2, Math.min(98, next));
            pendingPosRef.current = clamped;
            if (rafRef.current == null) {
                rafRef.current = window.requestAnimationFrame(flush);
            }
        },
        [flush],
    );

    const updateFromClientX = useCallback(
        (clientX: number) => {
            const rect = rectRef.current;
            if (!rect) return;
            const rel = ((clientX - rect.left) / rect.width) * 100;
            schedule(rel);
        },
        [schedule],
    );

    const handlePointerDown = useCallback(
        (e: React.PointerEvent) => {
            const el = containerRef.current;
            if (!el) return;
            draggingRef.current = true;
            rectRef.current = el.getBoundingClientRect();
            (e.target as Element).setPointerCapture?.(e.pointerId);
            updateFromClientX(e.clientX);
        },
        [updateFromClientX],
    );

    const handlePointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (!draggingRef.current) return;
            updateFromClientX(e.clientX);
        },
        [updateFromClientX],
    );

    const handlePointerUp = useCallback(
        (e: React.PointerEvent) => {
            draggingRef.current = false;
            (e.target as Element).releasePointerCapture?.(e.pointerId);
        },
        [],
    );

    const handleRange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            schedule(Number(e.target.value));
        },
        [schedule],
    );

    useEffect(() => {
        return () => {
            if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
        };
    }, []);

    // 480 vs 640 container sizing handled via parent class; images use same src but intent is
    // thumb vs full resolution distinction (480 thumb, 640 full). Both use <img loading="lazy">.
    const labelLeft = `${left.filename.slice(0, 18)}`;
    const labelRight = `${right.filename.slice(0, 18)}`;

    return (
        <div
            ref={containerRef}
            className="swipe-slider"
            data-testid="swipe-slider"
            data-mode={mode}
            style={{ ["--swipe-pos" as string]: `${pos}%` }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
        >
            {/* Back image */}
            <img
                src={toAssetSrc(right.filepath)}
                alt={right.filename}
                className="swipe-slider-img back"
                loading="lazy"
                decoding="async"
                draggable={false}
            />
            {/* Front clipped */}
            <img
                src={toAssetSrc(left.filepath)}
                alt={left.filename}
                className="swipe-slider-img front"
                loading="lazy"
                decoding="async"
                draggable={false}
            />
            <div className="swipe-divider" aria-hidden="true" />
            <div className="swipe-thumb" aria-hidden="true">
                ↔
            </div>
            <div className="swipe-labels">
                <span className="swipe-label">{labelLeft}</span>
                <span className="swipe-label">{labelRight}</span>
            </div>
            <input
                type="range"
                min={0}
                max={100}
                value={pos}
                onChange={handleRange}
                className="swipe-range"
                aria-label="Swipe comparison slider"
                data-testid="swipe-range"
            />
        </div>
    );
}

/* ── CompareLab main ─────────────────────────────────────────────── */

export interface CompareLabProps {
    /** Optional: render in hero slot (default true). When false, renders inline. */
    hero?: boolean;
    /** Optional details map for richer delta (seed/cfg/etc). If not provided, component fetches on demand. */
    detailsMap?: Map<number, ImageRecord>;
}

export function CompareLab({ hero = true, detailsMap: detailsMapProp }: CompareLabProps) {
    const pins = useCompareLabStore((s) => s.pins);
    const reorder = useCompareLabStore((s) => s.reorder);
    const clear = useCompareLabStore((s) => s.clear);
    const unpin = useCompareLabStore((s) => s.unpin);
    const winnerId = useCompareLabStore((s) => s.winnerId);
    const setWinner = useCompareLabStore((s) => s.setWinner);

    const forge = useForgeSettings();
    const [isMutateOpen, setIsMutateOpen] = useState(false);

    const winner = useMemo(() => {
        if (winnerId === null) return null;
        return pins.find((p) => p.id === winnerId) ?? null;
    }, [pins, winnerId]);

    const [mode, setMode] = useState<SwipeMode>("full");
    const [detailsMap, setDetailsMap] = useState<Map<number, ImageRecord>>(
        () => detailsMapProp ?? new Map(),
    );
    const [lineage, setLineage] = useState<Map<number, LineageCursor>>(new Map());
    const [seedWalk, setSeedWalk] = useState<Map<number, GalleryImageRecord[]>>(new Map());
    const [lineageVersion, setLineageVersion] = useState(0);

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let mounted = true;

        listen("lineage-updated", () => {
            setLineageVersion((v) => v + 1);
        })
            .then((fn) => {
                if (mounted) {
                    unlisten = fn;
                } else {
                    fn();
                }
            })
            .catch(() => {
                // ignore in non-tauri or test environments
            });

        return () => {
            mounted = false;
            if (unlisten) {
                unlisten();
            }
        };
    }, []);

    useEffect(() => {
        if (detailsMapProp) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setDetailsMap(detailsMapProp);
        }
    }, [detailsMapProp]);

    // Fetch ImageRecord details for pins lacking them (for delta table richness)
    useEffect(() => {
        let cancelled = false;
        const missing = pins.filter((p) => !detailsMap.has(p.id));
        if (missing.length === 0) return;
        void Promise.all(
            missing.map(async (p) => {
                try {
                    const detail = await getImageDetail(p.id);
                    if (detail && !cancelled) {
                        setDetailsMap((prev) => {
                            const next = new Map(prev);
                            next.set(p.id, detail);
                            return next;
                        });
                    }
                } catch {
                    // ignore
                }
            }),
        );
        return () => {
            cancelled = true;
        };
    }, [pins, detailsMap]);

    useEffect(() => {
        let cancelled = false;
        if (pins.length === 0) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setLineage(new Map());
            setSeedWalk(new Map());
            return;
        }
        void Promise.all(
            pins.map(async (p) => {
                try {
                    const cursor = await getLineageCursor(p.filepath);
                    if (!cancelled) {
                        setLineage((prev) => {
                            const next = new Map(prev);
                            next.set(p.id, cursor);
                            return next;
                        });
                    }
                } catch {
                    // ignore - lineage not available for all images
                }
                const seed = detailsMap.get(p.id)?.seed ?? p.seed;
                if (seed?.trim()) {
                    try {
                        const walk = await getSeedWalk(seed.trim(), null, 8);
                        if (!cancelled) {
                            setSeedWalk((prev) => {
                                const next = new Map(prev);
                                next.set(p.id, walk);
                                return next;
                            });
                        }
                    } catch {
                        // ignore
                    }
                }
            }),
        );
        return () => {
            cancelled = true;
        };
    }, [pins, detailsMap, lineageVersion]);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    );

    const handleDragEnd = useCallback(
        (event: DragEndEvent) => {
            const { active, over } = event;
            if (!over || active.id === over.id) return;
            const oldIndex = pins.findIndex((p) => String(p.id) === String(active.id));
            const newIndex = pins.findIndex((p) => String(p.id) === String(over.id));
            if (oldIndex === -1 || newIndex === -1) return;
            // Use local reorder via arrayMove for correctness, sync to store
            const reordered = arrayMove(pins, oldIndex, newIndex);
            // Apply via store reorder OR setPins
            // Prefer direct set for moved array
            useCompareLabStore.setState({ pins: reordered });
            // Also call reorder for consistency (no-op if already moved)
            void reorder;
        },
        [pins, reorder],
    );

    const handleRemove = useCallback(
        (id: number) => {
            unpin(id);
        },
        [unpin],
    );

    const ready = isCompareReady(pins);
    const hasPins = pins.length > 0;
    const emptyCount = Math.max(0, 4 - pins.length);
    const ids = useMemo(() => pins.map((p) => String(p.id)), [pins]);

    // Swipe pair: for 2 pins use them; for 3-4 allow selecting pair via first two
    const swipePair = useMemo(() => {
        if (pins.length === 2) return [pins[0], pins[1]] as const;
        if (pins.length > 2) return [pins[0], pins[1]] as const;
        return null;
    }, [pins]);

    const gridColsClass = useMemo(() => {
        if (pins.length <= 2) return "cols-2";
        if (pins.length === 3) return "cols-3";
        return "cols-4";
    }, [pins.length]);

    if (!hasPins) {
        return null;
    }

    return (
        <section
            className={hero ? "compare-lab compare-lab--hero" : "compare-lab"}
            aria-label="Compare Lab"
            data-testid="compare-lab"
            data-hero={hero ? "true" : "false"}
        >
            <div className="compare-lab-header">
                <h2 className="compare-lab-title">
                    <span className="compare-lab-title-dot" aria-hidden="true" />
                    Compare Lab
                    <span className="compare-lab-count" data-testid="compare-count">
                        {pins.length}/4 {ready ? "• ready" : pins.length < 2 ? "• pin 2–4" : ""}
                    </span>
                </h2>
                <div className="compare-lab-header-actions">
                    <div className="compare-lab-mode-row" role="group" aria-label="View mode">
                        <button
                            type="button"
                            className={`compare-lab-mode-btn ${mode === "thumb" ? "active" : ""}`.trim()}
                            aria-pressed={mode === "thumb"}
                            onClick={() => setMode("thumb")}
                            data-testid="mode-thumb"
                        >
                            Thumb 480
                        </button>
                        <button
                            type="button"
                            className={`compare-lab-mode-btn ${mode === "full" ? "active" : ""}`.trim()}
                            aria-pressed={mode === "full"}
                            onClick={() => setMode("full")}
                            data-testid="mode-full"
                        >
                            Full 640
                        </button>
                    </div>
                    {winner && (
                        <button
                            type="button"
                            className="compare-lab-btn compare-lab-mutate-btn"
                            onClick={() => setIsMutateOpen(true)}
                            data-testid="mutate-winner-btn"
                            title={`Mutate winner: ${winner.filename}`}
                        >
                            <BoltIcon /> Mutate Winner
                        </button>
                    )}
                    <button
                        type="button"
                        className="compare-lab-btn"
                        onClick={clear}
                        disabled={!hasPins}
                        data-testid="compare-clear"
                    >
                        Clear
                    </button>
                </div>
            </div>

            {/* Pin strip with drag reorder */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
                    <div className="compare-lab-pin-strip" data-testid="pin-strip">
                        {pins.map((p) => (
                            <SortablePinCard
                                key={p.id}
                                image={p}
                                isWinner={p.id === winnerId}
                                onPickWinner={setWinner}
                                onRemove={handleRemove}
                            />
                        ))}
                        {/* Skeletons for empty slots */}
                        {Array.from({ length: emptyCount }).map((_, i) => (
                            <SkeletonCard key={`sk-${i}`} index={i} />
                        ))}
                    </div>
                </SortableContext>
            </DndContext>

            {!ready && (
                <div className="compare-lab-empty" data-testid="compare-empty">
                    <p className="metadata-delta-hint">
                        {pins.length === 0
                            ? "No pins yet — select 2–4 images from the gallery to compare."
                            : pins.length === 1
                              ? "Pin one more image to start comparing."
                              : ""}
                    </p>
                </div>
            )}

            {/* Canvas */}
            {ready && (
                <div
                    className={`compare-lab-canvas ${mode}`.trim()}
                    data-testid="compare-canvas"
                    data-mode={mode}
                >
                    {swipePair && pins.length === 2 ? (
                        <SwipeSlider left={swipePair[0]} right={swipePair[1]} mode={mode} />
                    ) : (
                        <div className={`compare-lab-grid ${gridColsClass}`.trim()} data-testid="compare-grid">
                            {pins.map((p) => (
                                <div key={p.id} className="compare-lab-grid-cell" data-testid={`grid-cell-${p.id}`}>
                                    <img
                                        src={toAssetSrc(p.filepath)}
                                        alt={p.filename}
                                        loading="lazy"
                                        decoding="async"
                                    />
                                    <span className="compare-lab-grid-label">{p.filename}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Optional secondary swipe for 3-4 pins: also show swipe of first two */}
                    {pins.length > 2 && swipePair && (
                        <div style={{ marginTop: "10px" }}>
                            <p className="metadata-delta-footnote">Swipe: first two pins</p>
                            <SwipeSlider left={swipePair[0]} right={swipePair[1]} mode={mode} />
                        </div>
                    )}
                </div>
            )}

            {/* Lineage / SeedWalk badges (API-01 integration) */}
            {ready && (
                <div className="compare-lab-lineage" data-testid="compare-lineage">
                    {pins.map((p) => {
                        const cur = lineage.get(p.id);
                        const walk = seedWalk.get(p.id);
                        if (!cur && !walk) return null;
                        return (
                            <span
                                key={`lin-${p.id}`}
                                className="tag-chip include compare-lineage-badge"
                                title={`${p.filename} lineage`}
                                data-testid={`lineage-badge-${p.id}`}
                            >
                                {cur ? `${cur.ancestors.length}↑ ${cur.children.length}↓` : "—"} {walk ? `• seed ${walk.length}` : ""}
                            </span>
                        );
                    })}
                </div>
            )}

            {/* Delta table */}
            <div className="compare-lab-delta" data-testid="compare-delta">
                <MetadataDeltaTable
                    pins={pins}
                    detailsMap={detailsMap}
                    winnerId={winnerId}
                    onPickWinner={setWinner}
                    onMutateWinner={() => setIsMutateOpen(true)}
                />
            </div>

            {/* Mutation Popover */}
            {isMutateOpen && winner && (
                <MutationPopover
                    winner={winner}
                    winnerDetails={detailsMap.get(winner.id)}
                    baseUrl={forge.forgeBaseUrl}
                    apiKey={forge.forgeApiKey || null}
                    outputDir={forge.forgeOutputDir || null}
                    includeSeed={forge.forgeIncludeSeed}
                    onClose={() => setIsMutateOpen(false)}
                />
            )}
        </section>
    );
}

export default CompareLab;
