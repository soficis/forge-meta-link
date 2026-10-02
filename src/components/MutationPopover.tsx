import { useState, useMemo, useCallback } from "react";
import type { GalleryImageRecord, ImageRecord, ForgeSendResult } from "../types/metadata";
import {
    applyOps,
    expandSweep,
    calculateSweepSize,
    isConfirmRequired,
    SWEEP_HARD_CAP,
    SWEEP_CONFIRM_THRESHOLD,
    COMMON_SAMPLERS,
    ACCEPTED_SCHEDULERS,
    type SweepSelection,
} from "../utils/mutations";
import { forgeSendToImage } from "../services/commands";
import type { GenerationParams } from "../utils/forgePayload";

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
    const [sendProgress, setSendProgress] = useState<string | null>(null);
    const [showConfirm, setShowConfirm] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

    const handleSendClick = () => {
        if (sweepCount === 0) return;
        if (needsConfirm) {
            setShowConfirm(true);
        } else {
            executeSweep();
        }
    };

    const executeSweep = useCallback(async () => {
        setShowConfirm(false);
        setIsSending(true);
        setErrorMessage(null);

        // Build base generation params from winner
        const baseParams: GenerationParams = {
            prompt: winnerDetails?.prompt ?? "",
            negative_prompt: winnerDetails?.negative_prompt ?? "",
            steps: winnerDetails?.steps ?? "20",
            sampler: winnerDetails?.sampler ?? winner.model_name ?? "Euler a",
            schedule_type: winnerDetails?.schedule_type ?? "karras",
            cfg_scale: winnerDetails?.cfg_scale ?? "7.0",
            seed: winnerDetails?.seed ?? winner.seed ?? "12345",
            width: winnerDetails?.width ?? winner.width ?? 512,
            height: winnerDetails?.height ?? winner.height ?? 512,
            model_hash: winnerDetails?.model_hash ?? null,
            model_name: winnerDetails?.model_name ?? winner.model_name ?? null,
            generation_type: winnerDetails?.generation_type ?? "txt2img",
            extra_params: {},
            raw_metadata: winnerDetails?.raw_metadata ?? "",
        };

        const results: ForgeSendResult[] = [];
        try {
            for (let i = 0; i < combinations.length; i++) {
                const ops = combinations[i];
                setSendProgress(`Generating variant ${i + 1}/${combinations.length}...`);
                const mutated = applyOps(baseParams, ops);

                const overrides = {
                    prompt: mutated.prompt,
                    negative_prompt: mutated.negative_prompt,
                    steps: mutated.steps ?? undefined,
                    sampler_name: mutated.sampler ?? undefined,
                    scheduler: mutated.schedule_type ?? undefined,
                    cfg_scale: mutated.cfg_scale ?? undefined,
                    seed: mutated.seed ?? undefined,
                };

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
            onQueued?.(results);
            onClose();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMessage(msg);
            onError?.(msg);
        } finally {
            setIsSending(false);
            setSendProgress(null);
        }
    }, [combinations, winner, winnerDetails, baseUrl, apiKey, outputDir, includeSeed, onQueued, onError, onClose]);

    return (
        <div className="settings-backdrop" data-testid="mutation-popover-backdrop">
            <div
                className="confirm-dialog-content mutation-popover-modal"
                data-testid="mutation-popover"
                role="dialog"
                aria-modal="true"
                aria-label="Mutation Sweep"
                style={{ maxWidth: "540px", width: "95%" }}
            >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                    <h3 style={{ margin: 0, fontSize: "16px", color: "var(--color-text-main, #e0e0e0)" }}>
                        👑 Mutate Winner: <span style={{ color: "var(--color-accent, #6366f1)" }}>{winner.filename}</span>
                    </h3>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={isSending}
                        style={{ background: "none", border: "none", color: "var(--color-text-muted, #888)", cursor: "pointer", fontSize: "18px" }}
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                {errorMessage && (
                    <div style={{ padding: "8px 12px", background: "rgba(239, 68, 68, 0.15)", border: "1px solid #ef4444", borderRadius: "4px", color: "#fca5a5", fontSize: "12px", marginBottom: "12px" }}>
                        {errorMessage}
                    </div>
                )}

                {/* Operator 1: Seed Step */}
                <div style={{ marginBottom: "14px", padding: "10px", background: "rgba(255, 255, 255, 0.03)", borderRadius: "6px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                        <span style={{ fontSize: "13px", fontWeight: 600 }}>Seed Step (+1..+4)</span>
                        {isRandomSeed && (
                            <span style={{ fontSize: "11px", color: "#f59e0b" }}>Random seed (-1) — disabled</span>
                        )}
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                        {[1, 2, 3, 4].map((step) => (
                            <label
                                key={`seed-${step}`}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "4px",
                                    fontSize: "12px",
                                    cursor: isRandomSeed ? "not-allowed" : "pointer",
                                    opacity: isRandomSeed ? 0.4 : 1,
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={selectedSeedSteps.includes(step)}
                                    onChange={() => toggleSeedStep(step)}
                                    disabled={isRandomSeed || isSending}
                                    data-testid={`checkbox-seed-${step}`}
                                />
                                +{step}
                            </label>
                        ))}
                    </div>
                </div>

                {/* Operator 2: CFG Delta */}
                <div style={{ marginBottom: "14px", padding: "10px", background: "rgba(255, 255, 255, 0.03)", borderRadius: "6px" }}>
                    <span style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>
                        CFG Delta
                    </span>
                    <div style={{ display: "flex", gap: "8px" }}>
                        {[-1.0, 1.0].map((delta) => (
                            <label
                                key={`cfg-${delta}`}
                                style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", cursor: "pointer" }}
                            >
                                <input
                                    type="checkbox"
                                    checked={selectedCfgDeltas.includes(delta)}
                                    onChange={() => toggleCfgDelta(delta)}
                                    disabled={isSending}
                                    data-testid={`checkbox-cfg-${delta > 0 ? "plus" : "minus"}-${Math.abs(delta)}`}
                                />
                                {delta > 0 ? `+${delta}` : delta}
                            </label>
                        ))}
                    </div>
                </div>

                {/* Operator 3: Steps Delta */}
                <div style={{ marginBottom: "14px", padding: "10px", background: "rgba(255, 255, 255, 0.03)", borderRadius: "6px" }}>
                    <span style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>
                        Steps Delta
                    </span>
                    <div style={{ display: "flex", gap: "8px" }}>
                        {[-5, 5].map((delta) => (
                            <label
                                key={`steps-${delta}`}
                                style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", cursor: "pointer" }}
                            >
                                <input
                                    type="checkbox"
                                    checked={selectedStepsDeltas.includes(delta)}
                                    onChange={() => toggleStepsDelta(delta)}
                                    disabled={isSending}
                                    data-testid={`checkbox-steps-${delta > 0 ? "plus" : "minus"}-${Math.abs(delta)}`}
                                />
                                {delta > 0 ? `+${delta}` : delta}
                            </label>
                        ))}
                    </div>
                </div>

                {/* Operator 4: Sampler / Scheduler Swap */}
                <div style={{ marginBottom: "14px", padding: "10px", background: "rgba(255, 255, 255, 0.03)", borderRadius: "6px" }}>
                    <span style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>
                        Sampler / Scheduler Swap
                    </span>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                        <div>
                            <label style={{ fontSize: "11px", color: "var(--color-text-muted, #aaa)", display: "block", marginBottom: "2px" }}>
                                Sampler
                            </label>
                            <select
                                value={selectedSampler}
                                onChange={(e) => setSelectedSampler(e.target.value)}
                                disabled={isSending}
                                style={{ width: "100%", padding: "4px 8px", background: "var(--color-bg-secondary, #222)", color: "#fff", border: "1px solid #444", borderRadius: "4px", fontSize: "12px" }}
                                data-testid="select-sampler-swap"
                            >
                                <option value="">(No swap)</option>
                                {COMMON_SAMPLERS.map((s) => (
                                    <option key={s} value={s}>
                                        {s}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label style={{ fontSize: "11px", color: "var(--color-text-muted, #aaa)", display: "block", marginBottom: "2px" }}>
                                Scheduler
                            </label>
                            <select
                                value={selectedScheduler}
                                onChange={(e) => setSelectedScheduler(e.target.value)}
                                disabled={isSending}
                                style={{ width: "100%", padding: "4px 8px", background: "var(--color-bg-secondary, #222)", color: "#fff", border: "1px solid #444", borderRadius: "4px", fontSize: "12px" }}
                                data-testid="select-scheduler-swap"
                            >
                                <option value="">(No swap)</option>
                                {ACCEPTED_SCHEDULERS.map((s) => (
                                    <option key={s} value={s}>
                                        {s}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>

                {/* Preview count & Combinatorics info */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "rgba(99, 102, 241, 0.08)", border: "1px solid rgba(99, 102, 241, 0.2)", borderRadius: "6px", marginBottom: "16px" }}>
                    <div>
                        <span style={{ fontSize: "12px", fontWeight: 600 }}>Sweep Combinations: </span>
                        <span style={{ fontSize: "13px", fontWeight: "bold", color: "var(--color-accent, #6366f1)" }} data-testid="sweep-count-badge">
                            {sweepCount} variant{sweepCount === 1 ? "" : "s"}
                        </span>
                        {rawCount > SWEEP_HARD_CAP && (
                            <span style={{ fontSize: "11px", color: "#f59e0b", marginLeft: "6px" }}>
                                (capped at {SWEEP_HARD_CAP})
                            </span>
                        )}
                    </div>
                    {needsConfirm && (
                        <span style={{ fontSize: "11px", color: "#f59e0b" }}>⚠️ Confirmation required (&gt;8)</span>
                    )}
                </div>

                {/* Confirm Dialog Overlay if size > 8 */}
                {showConfirm && (
                    <div
                        style={{ padding: "12px", background: "rgba(245, 158, 11, 0.1)", border: "1px solid #f59e0b", borderRadius: "6px", marginBottom: "16px" }}
                        data-testid="sweep-confirm-dialog"
                    >
                        <h4 style={{ margin: "0 0 6px 0", fontSize: "13px", color: "#fbbf24" }}>
                            Confirm Mutation Sweep
                        </h4>
                        <p style={{ margin: "0 0 10px 0", fontSize: "12px" }}>
                            Generate {sweepCount} variants? This will send {sweepCount} requests to Forge Neo in sequence.
                        </p>
                        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                            <button
                                type="button"
                                onClick={() => setShowConfirm(false)}
                                style={{ padding: "4px 10px", fontSize: "12px", background: "#333", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}
                                data-testid="sweep-confirm-cancel-btn"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={executeSweep}
                                style={{ padding: "4px 10px", fontSize: "12px", background: "#f59e0b", color: "#000", fontWeight: 600, border: "none", borderRadius: "4px", cursor: "pointer" }}
                                data-testid="sweep-confirm-proceed-btn"
                            >
                                Confirm &amp; Send
                            </button>
                        </div>
                    </div>
                )}

                {/* Footer Actions */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "12px", color: "var(--color-text-muted, #888)" }}>
                        {sendProgress ?? ""}
                    </span>
                    <div style={{ display: "flex", gap: "8px" }}>
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={isSending}
                            style={{ padding: "6px 14px", background: "transparent", color: "var(--color-text-main, #e0e0e0)", border: "1px solid #444", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={handleSendClick}
                            disabled={sweepCount === 0 || isSending}
                            style={{
                                padding: "6px 16px",
                                background: sweepCount === 0 || isSending ? "#444" : "var(--color-accent, #6366f1)",
                                color: "#fff",
                                fontWeight: 600,
                                border: "none",
                                borderRadius: "4px",
                                cursor: sweepCount === 0 || isSending ? "not-allowed" : "pointer",
                                fontSize: "12px",
                            }}
                            data-testid="sweep-send-btn"
                        >
                            {isSending ? "Sending..." : `Send Sweep (${sweepCount})`}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default MutationPopover;
