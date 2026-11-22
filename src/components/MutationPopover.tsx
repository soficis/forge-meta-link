import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { GalleryImageRecord, ImageRecord, ForgeSendResult } from "../types/metadata";
import {
    applyOps,
    expandSweep,
    calculateSweepSize,
    changedOverrides,
    isConfirmRequired,
    SWEEP_HARD_CAP,
    COMMON_SAMPLERS,
    ACCEPTED_SCHEDULERS,
    type SweepSelection,
    type MutationOp,
} from "../utils/mutations";
import { forgeSendToImage } from "../services/commands";
import type { GenerationParams } from "../utils/forgePayload";
import { Modal } from "./Modal";
import { BoltIcon, WarningIcon } from "./icons";
import "./MutationPopover.css";

const SELECTION_STORAGE_KEY = "fml.mutationSweep.selection";

/** The backend record carries generation_type; the legacy TS interface omits it. */
type WinnerDetail = ImageRecord & { generation_type?: string | null };

interface PersistedSelection {
    seedSteps: number[];
    cfgDeltas: number[];
    stepsDeltas: number[];
    sampler: string;
    scheduler: string;
}

function asNumberArray(value: unknown): number[] {
    return Array.isArray(value)
        ? value.filter((n: unknown): n is number => typeof n === "number" && Number.isFinite(n))
        : [];
}

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/**
 * Restore a persisted <select> value only if it can actually render as an option. An empty value
 * means "keep current"; an option list that is empty imposes no vocabulary. Anything else that is
 * not in the list came from a hand-edited payload and would render with no matching option, so it
 * is ignored rather than silently emitted as an off-vocabulary sampler/scheduler.
 */
function asValidOption(value: unknown, options: readonly string[]): string {
    const text = asString(value);
    if (text === "") return "";
    if (options.length === 0) return text;
    return options.includes(text) ? text : "";
}

/** Deterministic JSON for identities: object keys sorted at every level, arrays keep their order. */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(",")}}`;
}

/**
 * Identity of a queued variant: the winner plus the recipe the ops resolve to. Two different op
 * shapes that produce the same overrides are the same variant; changing the selection so a stored
 * recipe reappears must not queue it again.
 */
function variantKey(winnerId: number, baseParams: GenerationParams, ops: MutationOp[]): string {
    try {
        const mutated = applyOps(baseParams, ops);
        const overrides = changedOverrides(baseParams, mutated);
        return `${winnerId}:${stableStringify(overrides)}`;
    } catch {
        // An unresolvable variant can never be sent (Send is blocked by previewError). Keep a
        // deterministic fallback so the pending filter never throws during render.
        return `${winnerId}:ops:${stableStringify(ops)}`;
    }
}

/** Best-effort read of the last selection. Bad storage or bad JSON just means "start empty". */
function loadPersistedSelection(): PersistedSelection | null {
    try {
        const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PersistedSelection> | null;
        if (!parsed || typeof parsed !== "object") return null;
        return {
            seedSteps: asNumberArray(parsed.seedSteps),
            cfgDeltas: asNumberArray(parsed.cfgDeltas),
            stepsDeltas: asNumberArray(parsed.stepsDeltas),
            sampler: asValidOption(parsed.sampler, COMMON_SAMPLERS),
            scheduler: asValidOption(parsed.scheduler, ACCEPTED_SCHEDULERS),
        };
    } catch {
        return null;
    }
}

export interface MutationPopoverProps {
    winner: GalleryImageRecord;
    winnerDetails?: ImageRecord | null;
    baseUrl: string;
    apiKey: string | null;
    outputDir?: string | null;
    includeSeed?: boolean;
    onClose: () => void;
    onQueued?: (results: ForgeSendResult[]) => void;
    onError?: (message: string) => void;
}

export function MutationPopover({
    winner,
    winnerDetails,
    baseUrl,
    apiKey,
    outputDir = null,
    includeSeed = true,
    onClose,
    onQueued,
    onError,
}: MutationPopoverProps) {
    // Selection state — seeded from the last-used selection so Send is usable on open.
    const [persisted] = useState(loadPersistedSelection);
    const [selectedSeedSteps, setSelectedSeedSteps] = useState<number[]>(persisted?.seedSteps ?? []);
    const [selectedCfgDeltas, setSelectedCfgDeltas] = useState<number[]>(persisted?.cfgDeltas ?? []);
    const [selectedStepsDeltas, setSelectedStepsDeltas] = useState<number[]>(persisted?.stepsDeltas ?? []);
    const [selectedSampler, setSelectedSampler] = useState<string>(persisted?.sampler ?? "");
    const [selectedScheduler, setSelectedScheduler] = useState<string>(persisted?.scheduler ?? "");

    const [isSending, setIsSending] = useState(false);
    const [sendProgressIndex, setSendProgressIndex] = useState(0);
    const [sendTotal, setSendTotal] = useState(0);
    const [showConfirm, setShowConfirm] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    // Recipes that have actually been handed to Forge. Keyed by the resolved overrides (prefixed
    // with the winner id), so a later change to the selection cannot re-queue the same variant.
    const [sentKeys, setSentKeys] = useState<Set<string>>(() => new Set());

    const stopRequested = useRef(false);
    const shouldCloseAfterStop = useRef(false);
    const proceedButtonRef = useRef<HTMLButtonElement>(null);
    const sendButtonRef = useRef<HTMLButtonElement>(null);
    const wasConfirmOpen = useRef(false);

    const isRandomSeed = useMemo(() => {
        const s = winnerDetails?.seed ?? winner.seed;
        return !s || s.trim() === "" || s.trim() === "-1";
    }, [winnerDetails, winner]);

    // The winner's full record is fetched asynchronously by the parent. Until it arrives there is
    // no trustworthy CFG/steps to mutate, so nothing may be sent and no default may be invented.
    const detailsUnavailable = useMemo(
        () => winnerDetails == null || (winnerDetails.steps == null && winnerDetails.cfg_scale == null),
        [winnerDetails]
    );

    const selection = useMemo<SweepSelection>(() => {
        const sel: SweepSelection = {};
        if (!isRandomSeed && selectedSeedSteps.length > 0) {
            sel.seedSteps = selectedSeedSteps;
        }
        if (selectedCfgDeltas.length > 0) {
            sel.cfgDeltas = selectedCfgDeltas;
        }
        if (selectedStepsDeltas.length > 0) {
            sel.stepsDeltas = selectedStepsDeltas;
        }
        if (selectedSampler || selectedScheduler) {
            sel.swaps = [
                {
                    sampler: selectedSampler ? selectedSampler : undefined,
                    scheduler: selectedScheduler ? selectedScheduler : undefined,
                },
            ];
        }
        return sel;
    }, [isRandomSeed, selectedSeedSteps, selectedCfgDeltas, selectedStepsDeltas, selectedSampler, selectedScheduler]);

    const baseParams = useMemo<GenerationParams>(() => {
        const detail = winnerDetails as WinnerDetail | null | undefined;
        return {
            prompt: detail?.prompt ?? "",
            negative_prompt: detail?.negative_prompt ?? "",
            steps: detail?.steps ?? null,
            sampler: detail?.sampler ?? null,
            schedule_type: detail?.schedule_type ?? null,
            cfg_scale: detail?.cfg_scale ?? null,
            seed: detail?.seed ?? winner.seed ?? null,
            width: detail?.width ?? winner.width ?? null,
            height: detail?.height ?? winner.height ?? null,
            model_hash: detail?.model_hash ?? null,
            model_name: detail?.model_name ?? winner.model_name ?? null,
            generation_type: detail?.generation_type ?? null,
            extra_params: detail?.extra_params ?? {},
            text_chunks: detail?.text_chunks ?? {},
            raw_metadata: detail?.raw_metadata ?? "",
        };
    }, [winner, winnerDetails]);

    const combinations = useMemo(() => expandSweep(selection), [selection]);
    const rawCount = useMemo(() => calculateSweepSize(selection), [selection]);
    const sweepCount = combinations.length;
    // What is left to queue. After a Stop (or a partial failure) the already-sent recipes stay
    // recorded here, so a selection change cannot resurrect a variant that was already queued.
    const pendingCombos = useMemo(
        () => combinations.filter((ops) => !sentKeys.has(variantKey(winner.id, baseParams, ops))),
        [combinations, sentKeys, winner.id, baseParams]
    );
    const pendingCount = pendingCombos.length;
    const needsConfirm = isConfirmRequired(pendingCount);

    const previewRows = useMemo(() => {
        return combinations.map((ops, idx) => {
            try {
                const mutated = applyOps(baseParams, ops);
                const overrides = changedOverrides(baseParams, mutated);
                return {
                    index: idx + 1,
                    seed: overrides.seed ?? "—",
                    cfg: overrides.cfg_scale ?? "—",
                    steps: overrides.steps ?? "—",
                    sampler: overrides.sampler_name ?? "—",
                    scheduler: overrides.scheduler ?? "—",
                    error: null,
                };
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    index: idx + 1,
                    seed: "—",
                    cfg: "—",
                    steps: "—",
                    sampler: "—",
                    scheduler: "—",
                    error: msg,
                };
            }
        });
    }, [combinations, baseParams]);

    const previewError = useMemo(() => {
        return previewRows.find((r) => r.error !== null)?.error ?? null;
    }, [previewRows]);

    useEffect(() => {
        try {
            const payload: PersistedSelection = {
                seedSteps: selectedSeedSteps,
                cfgDeltas: selectedCfgDeltas,
                stepsDeltas: selectedStepsDeltas,
                sampler: selectedSampler,
                scheduler: selectedScheduler,
            };
            localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(payload));
        } catch {
            // Ignore write failures (quota exceeded / storage disabled).
        }
    }, [selectedSeedSteps, selectedCfgDeltas, selectedStepsDeltas, selectedSampler, selectedScheduler]);

    // The confirm overlay owns focus while open; returning focus to Send makes keyboard use
    // continuous after Escape / Cancel instead of dropping the user back at the modal edge.
    useEffect(() => {
        if (showConfirm) {
            wasConfirmOpen.current = true;
            proceedButtonRef.current?.focus();
        } else if (wasConfirmOpen.current) {
            wasConfirmOpen.current = false;
            sendButtonRef.current?.focus();
        }
    }, [showConfirm]);

    const toggleSeedStep = (step: number) => {
        setSelectedSeedSteps((prev) =>
            prev.includes(step) ? prev.filter((s) => s !== step) : [...prev, step].sort((a, b) => a - b)
        );
    };

    const toggleCfgDelta = (delta: number) => {
        setSelectedCfgDeltas((prev) =>
            prev.includes(delta) ? prev.filter((d) => d !== delta) : [...prev, delta].sort((a, b) => a - b)
        );
    };

    const toggleStepsDelta = (delta: number) => {
        setSelectedStepsDeltas((prev) =>
            prev.includes(delta) ? prev.filter((d) => d !== delta) : [...prev, delta].sort((a, b) => a - b)
        );
    };

    const executeSweep = useCallback(async () => {
        setShowConfirm(false);
        // Only the variants that have not already been queued. This is what makes a second Send
        // after a Stop top up the sweep instead of duplicating the variants already in the library.
        const pending = pendingCombos;
        if (pending.length === 0) {
            setStatusMessage("All selected variants have already been queued. Change the selection to queue more.");
            return;
        }

        setIsSending(true);
        setErrorMessage(null);
        setStatusMessage(null);
        stopRequested.current = false;
        shouldCloseAfterStop.current = false;
        setSendProgressIndex(0);
        setSendTotal(pending.length);

        // Only variants that actually saved images are queued/deduped. A failed send stays
        // retryable, so its variant key is never recorded in sentKeys.
        const succeeded: ForgeSendResult[] = [];
        let failedCount = 0;
        let isUserStop = false;

        try {
            for (let i = 0; i < pending.length; i++) {
                if (stopRequested.current) {
                    isUserStop = true;
                    break;
                }

                const ops = pending[i];
                setSendProgressIndex(i + 1);

                const mutated = applyOps(baseParams, ops);
                const overrides = changedOverrides(baseParams, mutated);

                const res = await forgeSendToImage(
                    winner.id,
                    baseUrl,
                    apiKey,
                    outputDir,
                    includeSeed,
                    false,
                    null,
                    null,
                    null,
                    overrides,
                    ops
                );
                // ForgeSendResult (Rust ForgeSendOutput) reports generated_count and saved_paths.
                const savedImages =
                    res.ok === true &&
                    (res.generated_count > 0 || res.saved_paths.length > 0);
                if (savedImages) {
                    succeeded.push(res);
                    const key = variantKey(winner.id, baseParams, ops);
                    setSentKeys((prev) => {
                        const next = new Set(prev);
                        next.add(key);
                        return next;
                    });
                } else {
                    failedCount += 1;
                }
            }

            const failureNote =
                failedCount > 0
                    ? ` ${failedCount} variant${failedCount === 1 ? "" : "s"} failed to save images and were not queued (still retryable).`
                    : "";

            if (isUserStop || stopRequested.current) {
                const k = succeeded.length;
                const msg = `Stopped after ${k} of ${pending.length} (those ${k} are already in your library)${failureNote}`;
                setStatusMessage(msg);
                if (succeeded.length > 0) {
                    onQueued?.(succeeded);
                }
                if (shouldCloseAfterStop.current) {
                    onClose();
                }
            } else {
                if (succeeded.length > 0) {
                    onQueued?.(succeeded);
                }
                if (failedCount > 0) {
                    // Keep the popover open so the failures are visible and stay retryable.
                    setStatusMessage(
                        `Queued ${succeeded.length} of ${pending.length} variants.${failureNote}`,
                    );
                } else {
                    onClose();
                }
            }
        } catch (err: unknown) {
            const reason = err instanceof Error ? err.message : String(err);
            const msg =
                succeeded.length > 0
                    ? `Variant ${succeeded.length + 1}/${pending.length} failed after ${succeeded.length} were sent (those are already in your library): ${reason}`
                    : reason;
            setErrorMessage(msg);
            onError?.(msg);
            // Variants that completed before the failure still reached the library — the parent
            // must refresh/record them even though this sweep did not finish. Only successes count.
            if (succeeded.length > 0) {
                onQueued?.(succeeded);
            }
        } finally {
            setIsSending(false);
            setSendProgressIndex(0);
        }
    }, [pendingCombos, baseParams, winner, baseUrl, apiKey, outputDir, includeSeed, onQueued, onError, onClose]);

    const handleSendClick = () => {
        if (detailsUnavailable || sweepCount === 0 || pendingCount === 0) return;
        if (previewError) {
            return;
        }
        if (needsConfirm) {
            setShowConfirm(true);
        } else {
            void executeSweep();
        }
    };

    const handleStop = () => {
        stopRequested.current = true;
    };

    const handleClose = () => {
        if (isSending) {
            stopRequested.current = true;
            shouldCloseAfterStop.current = true;
        } else {
            onClose();
        }
    };

    return (
        <Modal
            label="Mutation Sweep"
            className="confirm-dialog-content mutation-popover-modal"
            backdropTestId="mutation-popover-backdrop"
            panelTestId="mutation-popover"
            onClose={handleClose}
            closeOnEscape={false}
            closeOnBackdrop={!isSending}
            onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                // Modal calls this before its own Escape handling. While the >8 confirm is open,
                // Escape must dismiss only that overlay — never the whole popover/selection.
                if (showConfirm) {
                    event.preventDefault();
                    event.stopPropagation();
                    setShowConfirm(false);
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                handleClose();
            }}
        >
            <div className="mutation-header">
                <h3 className="mutation-title">
                    <BoltIcon /> Mutate Winner: <span className="mutation-title-winner">{winner.filename}</span>
                </h3>
                <button
                    type="button"
                    onClick={handleClose}
                    className="mutation-close-btn"
                    aria-label="Close"
                >
                    ✕
                </button>
            </div>

            {errorMessage && (
                <div className="mutation-error-banner" data-testid="sweep-error-message">
                    {errorMessage}
                </div>
            )}

            {/* Operator 1: Seed Step */}
            <div className="mutation-section">
                <div className="mutation-section-header">
                    <span className="mutation-section-title">Seed Step (+1..+4)</span>
                    {isRandomSeed && (
                        <span className="mutation-section-warning">Random seed (-1) — disabled</span>
                    )}
                </div>
                <div className="mutation-options-row">
                    {[1, 2, 3, 4].map((step) => (
                        <label
                            key={`seed-${step}`}
                            className={`mutation-option-label ${isRandomSeed ? "disabled" : ""}`}
                        >
                            <input
                                type="checkbox"
                                checked={selectedSeedSteps.includes(step)}
                                onChange={() => toggleSeedStep(step)}
                                disabled={isRandomSeed || isSending}
                                data-testid={`checkbox-seed-${step}`}
                            />
                            <span>+{step}</span>
                        </label>
                    ))}
                </div>
            </div>

            {/* Operator 2: CFG Delta */}
            <div className="mutation-section">
                <div className="mutation-section-header">
                    <span className="mutation-section-title">CFG Delta (±0.5, ±1.0)</span>
                </div>
                <div className="mutation-options-row">
                    {[
                        { label: "-1.0", value: -1.0, id: "minus-1" },
                        { label: "-0.5", value: -0.5, id: "minus-0-5" },
                        { label: "+0.5", value: 0.5, id: "plus-0-5" },
                        { label: "+1.0", value: 1.0, id: "plus-1" },
                    ].map(({ label, value, id }) => (
                        <label key={`cfg-${id}`} className="mutation-option-label">
                            <input
                                type="checkbox"
                                checked={selectedCfgDeltas.includes(value)}
                                onChange={() => toggleCfgDelta(value)}
                                disabled={isSending}
                                data-testid={`checkbox-cfg-${id}`}
                            />
                            <span>{label}</span>
                        </label>
                    ))}
                </div>
            </div>

            {/* Operator 3: Steps Delta */}
            <div className="mutation-section">
                <div className="mutation-section-header">
                    <span className="mutation-section-title">Steps Delta (±5, ±10)</span>
                </div>
                <div className="mutation-options-row">
                    {[
                        { label: "-10", value: -10, id: "minus-10" },
                        { label: "-5", value: -5, id: "minus-5" },
                        { label: "+5", value: 5, id: "plus-5" },
                        { label: "+10", value: 10, id: "plus-10" },
                    ].map(({ label, value, id }) => (
                        <label key={`steps-${id}`} className="mutation-option-label">
                            <input
                                type="checkbox"
                                checked={selectedStepsDeltas.includes(value)}
                                onChange={() => toggleStepsDelta(value)}
                                disabled={isSending}
                                data-testid={`checkbox-steps-${id}`}
                            />
                            <span>{label}</span>
                        </label>
                    ))}
                </div>
            </div>

            {/* Operator 4: Sampler / Scheduler Swap */}
            <div className="mutation-section">
                <div className="mutation-section-header">
                    <span className="mutation-section-title">Sampler &amp; Scheduler Swap (1-pair)</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                    <div>
                        <select
                            value={selectedSampler}
                            onChange={(e) => setSelectedSampler(e.target.value)}
                            disabled={isSending}
                            className="mutation-select"
                            data-testid="select-sampler-swap"
                        >
                            <option value="">Keep current sampler</option>
                            {COMMON_SAMPLERS.map((s) => (
                                <option key={s} value={s}>
                                    {s}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <select
                            value={selectedScheduler}
                            onChange={(e) => setSelectedScheduler(e.target.value)}
                            disabled={isSending}
                            className="mutation-select"
                            data-testid="select-scheduler-swap"
                        >
                            <option value="">Keep current scheduler</option>
                            {ACCEPTED_SCHEDULERS.map((sched) => (
                                <option key={sched} value={sched}>
                                    {sched}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>

            {/* Sweep Summary */}
            <div className="mutation-summary-row">
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span
                        className="settings-badge"
                        style={{
                            backgroundColor: sweepCount > 0 ? "var(--bg-selected)" : "var(--bg-tertiary)",
                            color: sweepCount > 0 ? "var(--text-accent)" : "var(--text-secondary)",
                            padding: "3px 8px",
                            borderRadius: "var(--radius-sm)",
                            fontSize: "12px",
                            fontWeight: 600,
                        }}
                        data-testid="sweep-count-badge"
                    >
                        {sweepCount} variant{sweepCount === 1 ? "" : "s"}
                    </span>
                    {rawCount > SWEEP_HARD_CAP && (
                        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                            (capped at {SWEEP_HARD_CAP})
                        </span>
                    )}
                </div>
                {needsConfirm && (
                    <span className="mutation-section-warning" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                        <WarningIcon /> Confirmation required (&gt;8)
                    </span>
                )}
            </div>

            {/* Preview Table */}
            {combinations.length > 0 && (
                <div className="mutation-preview-table-container">
                    <table className="mutation-preview-table" data-testid="sweep-preview-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Seed</th>
                                <th>CFG</th>
                                <th>Steps</th>
                                <th>Sampler</th>
                                <th>Scheduler</th>
                            </tr>
                        </thead>
                        <tbody>
                            {previewRows.map((row) => (
                                <tr key={row.index} data-testid={`sweep-preview-row-${row.index}`}>
                                    <td>{row.index}</td>
                                    {row.error ? (
                                        <td colSpan={5} className="mutation-preview-error">
                                            {row.error}
                                        </td>
                                    ) : (
                                        <>
                                            <td>{row.seed}</td>
                                            <td>{row.cfg}</td>
                                            <td>{row.steps}</td>
                                            <td>{row.sampler}</td>
                                            <td>{row.scheduler}</td>
                                        </>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Confirm Dialog Overlay if size > 8 */}
            {showConfirm && (
                <div className="mutation-confirm-box" data-testid="sweep-confirm-dialog">
                    <div className="mutation-confirm-header">
                        <WarningIcon />
                        <h4 style={{ margin: 0 }}>Generate {pendingCount} variants?</h4>
                    </div>
                    <p className="mutation-confirm-desc">
                        You are about to queue {pendingCount} variants. Forge may take significant time to process all requests.
                    </p>
                    <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                        <button
                            type="button"
                            className="sidebar-button"
                            onClick={() => setShowConfirm(false)}
                            data-testid="sweep-confirm-cancel-btn"
                        >
                            Cancel
                        </button>
                        <button
                            ref={proceedButtonRef}
                            type="button"
                            className="sidebar-button primary"
                            onClick={() => void executeSweep()}
                            data-testid="sweep-confirm-proceed-btn"
                        >
                            Proceed with {pendingCount}
                        </button>
                    </div>
                </div>
            )}

            {/* Footer Actions */}
            <div className="mutation-footer">
                {detailsUnavailable && (
                    <div className="mutation-error-banner" data-testid="sweep-details-unavailable">
                        Winner details are still loading. Send is disabled until they arrive.
                    </div>
                )}
                <div className="mutation-progress-wrap">
                    {isSending && (
                        <>
                            <progress
                                value={sendProgressIndex}
                                max={sendTotal}
                                aria-valuenow={sendProgressIndex}
                                aria-valuemax={sendTotal}
                                className="mutation-progress-bar"
                                data-testid="sweep-progress-bar"
                            />
                            <span>{`Generating variant ${sendProgressIndex}/${sendTotal}...`}</span>
                        </>
                    )}
                    {!isSending && statusMessage && (
                        <span data-testid="sweep-status-message">{statusMessage}</span>
                    )}
                    {!isSending && sweepCount > pendingCount && pendingCount > 0 && (
                        <span className="mutation-section-warning" data-testid="sweep-overlap-hint">
                            {sweepCount - pendingCount} of these were already queued — Send will queue the remaining {pendingCount}.
                        </span>
                    )}
                    {!isSending && sweepCount > 0 && pendingCount === 0 && (
                        <span className="mutation-section-warning" data-testid="sweep-all-queued-hint">
                            All {sweepCount} selected variants were already queued. Change the selection to queue more.
                        </span>
                    )}
                </div>
                <div className="mutation-actions">
                    {sweepCount === 0 && !isSending && (
                        <span className="mutation-section-warning" data-testid="sweep-empty-hint">
                            Select at least one operator
                        </span>
                    )}
                    {isSending ? (
                        <button
                            type="button"
                            onClick={handleStop}
                            className="sidebar-button danger"
                            data-testid="sweep-stop-btn"
                        >
                            Stop
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={onClose}
                            className="sidebar-button"
                            data-testid="sweep-cancel-btn"
                        >
                            Cancel
                        </button>
                    )}
                    <button
                        ref={sendButtonRef}
                        type="button"
                        onClick={handleSendClick}
                        disabled={detailsUnavailable || sweepCount === 0 || pendingCount === 0 || isSending || previewError !== null}
                        className="sidebar-button primary"
                        data-testid="sweep-send-btn"
                        title={previewError ?? (detailsUnavailable ? "Winner details are still loading" : undefined)}
                    >
                        {isSending ? "Sending..." : `Send Sweep (${sweepCount})`}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

export default MutationPopover;
