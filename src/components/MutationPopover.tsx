import { useState, useMemo, useCallback, useRef } from "react";
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
} from "../utils/mutations";
import { forgeSendToImage } from "../services/commands";
import type { GenerationParams } from "../utils/forgePayload";
import { Modal } from "./Modal";
import { BoltIcon, WarningIcon } from "./icons";
import "./MutationPopover.css";

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
    // Selection state
    const [selectedSeedSteps, setSelectedSeedSteps] = useState<number[]>([]);
    const [selectedCfgDeltas, setSelectedCfgDeltas] = useState<number[]>([]);
    const [selectedStepsDeltas, setSelectedStepsDeltas] = useState<number[]>([]);
    const [selectedSampler, setSelectedSampler] = useState<string>("");
    const [selectedScheduler, setSelectedScheduler] = useState<string>("");

    const [isSending, setIsSending] = useState(false);
    const [sendProgressIndex, setSendProgressIndex] = useState(0);
    const [showConfirm, setShowConfirm] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [statusMessage, setStatusMessage] = useState<string | null>(null);

    const stopRequested = useRef(false);
    const shouldCloseAfterStop = useRef(false);

    const isRandomSeed = useMemo(() => {
        const s = winnerDetails?.seed ?? winner.seed;
        return !s || s.trim() === "" || s.trim() === "-1";
    }, [winnerDetails, winner]);

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

    const combinations = useMemo(() => expandSweep(selection), [selection]);
    const rawCount = useMemo(() => calculateSweepSize(selection), [selection]);
    const sweepCount = combinations.length;
    const needsConfirm = isConfirmRequired(sweepCount);

    const baseParams = useMemo<GenerationParams>(() => {
        const isDetailsProvided = winnerDetails !== undefined;
        return {
            prompt: winnerDetails?.prompt ?? "",
            negative_prompt: winnerDetails?.negative_prompt ?? "",
            steps: isDetailsProvided ? (winnerDetails?.steps ?? null) : "20",
            sampler: isDetailsProvided ? (winnerDetails?.sampler ?? null) : null,
            schedule_type: null,
            cfg_scale: isDetailsProvided ? (winnerDetails?.cfg_scale ?? null) : "7.0",
            seed: winnerDetails?.seed ?? winner.seed ?? null,
            width: winnerDetails?.width ?? winner.width ?? null,
            height: winnerDetails?.height ?? winner.height ?? null,
            model_hash: winnerDetails?.model_hash ?? null,
            model_name: winnerDetails?.model_name ?? winner.model_name ?? null,
            generation_type: null,
            extra_params: {},
            raw_metadata: winnerDetails?.raw_metadata ?? "",
        };
    }, [winner, winnerDetails]);

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
        setIsSending(true);
        setErrorMessage(null);
        setStatusMessage(null);
        stopRequested.current = false;
        shouldCloseAfterStop.current = false;
        setSendProgressIndex(0);

        const results: ForgeSendResult[] = [];
        let isUserStop = false;

        try {
            for (let i = 0; i < combinations.length; i++) {
                if (stopRequested.current) {
                    isUserStop = true;
                    break;
                }

                const ops = combinations[i];
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
                results.push(res);
            }

            if (isUserStop || stopRequested.current) {
                const k = results.length;
                const msg = `Stopped after ${k} of ${combinations.length} (those ${k} are already in your library)`;
                setStatusMessage(msg);
                if (results.length > 0) {
                    onQueued?.(results);
                }
                if (shouldCloseAfterStop.current) {
                    onClose();
                }
            } else {
                onQueued?.(results);
                onClose();
            }
        } catch (err: unknown) {
            const reason = err instanceof Error ? err.message : String(err);
            const msg =
                results.length > 0
                    ? `Variant ${results.length + 1}/${combinations.length} failed after ${results.length} were sent (those are already in your library): ${reason}`
                    : reason;
            setErrorMessage(msg);
            onError?.(msg);
        } finally {
            setIsSending(false);
            setSendProgressIndex(0);
        }
    }, [combinations, baseParams, winner, baseUrl, apiKey, outputDir, includeSeed, onQueued, onError, onClose]);

    const handleSendClick = () => {
        if (sweepCount === 0) return;
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
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    handleClose();
                }
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
                        <h4 style={{ margin: 0 }}>Generate {sweepCount} variants?</h4>
                    </div>
                    <p className="mutation-confirm-desc">
                        You are about to queue {sweepCount} variants. Forge may take significant time to process all requests.
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
                            type="button"
                            className="sidebar-button primary"
                            onClick={() => void executeSweep()}
                            data-testid="sweep-confirm-proceed-btn"
                        >
                            Proceed with {sweepCount}
                        </button>
                    </div>
                </div>
            )}

            {/* Footer Actions */}
            <div className="mutation-footer">
                <div className="mutation-progress-wrap">
                    {isSending && (
                        <>
                            <progress
                                value={sendProgressIndex}
                                max={combinations.length}
                                aria-valuenow={sendProgressIndex}
                                aria-valuemax={combinations.length}
                                className="mutation-progress-bar"
                                data-testid="sweep-progress-bar"
                            />
                            <span>{`Generating variant ${sendProgressIndex}/${combinations.length}...`}</span>
                        </>
                    )}
                    {!isSending && statusMessage && (
                        <span data-testid="sweep-status-message">{statusMessage}</span>
                    )}
                </div>
                <div className="mutation-actions">
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
                        type="button"
                        onClick={handleSendClick}
                        disabled={sweepCount === 0 || isSending || previewError !== null}
                        className="sidebar-button primary"
                        data-testid="sweep-send-btn"
                        title={previewError ?? undefined}
                    >
                        {isSending ? "Sending..." : `Send Sweep (${sweepCount})`}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

export default MutationPopover;
