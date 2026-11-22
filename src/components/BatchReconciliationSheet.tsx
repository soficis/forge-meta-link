import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { forgeSendToImage, getImageDetail } from "../services/commands";
import { Modal } from "./Modal";
import { FORGE_BATCH_COUNT_MAX } from "../utils/forgeSendOptions";
import { getForgeUrlError } from "../utils/forgeUrl";
import type {
    ForgePayloadOverrides,
    ForgeSendResult,
    ImageRecord,
} from "../types/metadata";

export interface BatchReconciliationSheetProps {
    imageIds: number[];
    baseUrl: string;
    apiKey: string;
    outputDir: string | null;
    /** Random-seed request from the toolbar: when true, the seed sent to Forge is "-1". */
    includeSeed: boolean;
    /** The one global override set the toolbar would otherwise apply to every image. */
    overrides?: Partial<ForgePayloadOverrides> | null;
    adetailerEnabled: boolean;
    adetailerModel: string | null;
    /** Shared LoRA tokens from the toolbar. Win over an image's own LoRAs when provided. */
    loraTokens?: string[] | null;
    loraWeight: number | null;
    loraWeights?: Record<string, number> | null;
    batchCount?: number | null;
    saveForgeCopy: boolean;
    confirmUnencrypted?: boolean | null;
    onQueued: (queueId: string, result: ForgeSendResult) => void;
    onError: (message: string) => void;
    onClose: () => void;
}

type SendMode = "stored" | "shared";

interface ReconciliationRow {
    id: number;
    record: ImageRecord | null;
    loading: boolean;
    error: string | null;
    includeSeed: boolean;
    includeLoras: boolean;
}

const NOT_RECORDED = "not recorded";
const LORA_TAG_RE = /<lora:[^>]*>/gi;
/** Fooocus/Forge-style weighted LoRA shorthand, e.g. `[0.7@detail_tweaker]`. */
const BRACKET_LORA_RE = /\[[^\]\n]*@[^\]\n]*\]/g;

function display(value: string | number | null | undefined): string {
    if (value == null) return NOT_RECORDED;
    const text = String(value).trim();
    return text || NOT_RECORDED;
}

/** Keeps LoRA tokens verbatim, including `[w@t]` shorthand, instead of normalizing them away. */
function extractLoraTokens(record: ImageRecord): string[] {
    const sources: string[] = [record.prompt, record.raw_metadata];
    for (const map of [record.extra_params, record.text_chunks]) {
        if (!map) continue;
        for (const value of Object.values(map)) sources.push(value);
    }
    const found: string[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
        if (!source) continue;
        const tokens = [
            ...(source.match(LORA_TAG_RE) ?? []),
            ...(source.match(BRACKET_LORA_RE) ?? []),
        ];
        for (const token of tokens) {
            const key = token.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            found.push(token);
        }
    }
    return found;
}

function stripLoraTags(prompt: string): string {
    return prompt
        .replace(LORA_TAG_RE, " ")
        .replace(BRACKET_LORA_RE, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractModulePaths(record: ImageRecord): string[] {
    const found: string[] = [];
    const seen = new Set<string>();
    for (const map of [record.extra_params, record.text_chunks]) {
        if (!map) continue;
        for (const [key, raw] of Object.entries(map)) {
            if (!/module/i.test(key)) continue;
            const value = raw.trim();
            if (!value) continue;
            let parts: string[] = [];
            if (value.startsWith("[")) {
                try {
                    const parsed: unknown = JSON.parse(value);
                    if (Array.isArray(parsed)) {
                        parts = parsed.filter((item): item is string => typeof item === "string");
                    }
                } catch {
                    // Fall through to the comma-separated reading below.
                }
            }
            if (parts.length === 0) {
                parts = value.split(/[,\n]+/).map((part) => part.trim()).filter(Boolean);
            }
            for (const part of parts) {
                if (seen.has(part)) continue;
                seen.add(part);
                found.push(part);
            }
        }
    }
    return found;
}

/** Values come from this row's own record only — nothing is invented when a field is missing. */
function buildStoredOverrides(
    record: ImageRecord,
    includeLoras: boolean
): Partial<ForgePayloadOverrides> {
    const overrides: Partial<ForgePayloadOverrides> = {};
    const assign = (
        key: keyof ForgePayloadOverrides,
        value: string | number | null | undefined
    ) => {
        if (value == null) return;
        const text = String(value).trim();
        if (text) overrides[key] = text;
    };
    assign("seed", record.seed);
    assign("steps", record.steps);
    assign("sampler_name", record.sampler);
    assign("scheduler", record.schedule_type);
    assign("cfg_scale", record.cfg_scale);
    assign("model_name", record.model_name);
    assign("width", record.width);
    assign("height", record.height);
    if (!includeLoras) overrides.prompt = stripLoraTags(record.prompt);
    return overrides;
}

export function BatchReconciliationSheet({
    imageIds,
    baseUrl,
    apiKey,
    outputDir,
    includeSeed,
    overrides,
    adetailerEnabled,
    adetailerModel,
    loraTokens,
    loraWeight,
    loraWeights,
    batchCount,
    saveForgeCopy,
    confirmUnencrypted,
    onQueued,
    onError,
    onClose,
}: BatchReconciliationSheetProps) {
    const [mode, setMode] = useState<SendMode>("stored");
    const [rows, setRows] = useState<ReconciliationRow[]>(() =>
        imageIds.map((id) => ({
            id,
            record: null,
            loading: true,
            error: null,
            includeSeed: true,
            includeLoras: true,
        }))
    );
    const [sending, setSending] = useState(false);
    const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
    const [summary, setSummary] = useState<string | null>(null);

    const storedModeRef = useRef<HTMLInputElement>(null);
    const abortRef = useRef(false);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            abortRef.current = true;
        };
    }, []);

    /* eslint-disable react-hooks/set-state-in-effect -- reset staged rows when the selection prop changes */
    useEffect(() => {
        let cancelled = false;
        setRows(
            imageIds.map((id) => ({
                id,
                record: null,
                loading: true,
                error: null,
                includeSeed: true,
                includeLoras: true,
            }))
        );
        setSummary(null);

        void Promise.all(
            imageIds.map(async (id) => {
                try {
                    const record = await getImageDetail(id);
                    return {
                        id,
                        record,
                        error: record ? null : `Image #${id} was not found in the library.`,
                    };
                } catch (error) {
                    return {
                        id,
                        record: null,
                        error: `Could not load image #${id}: ${String(error)}`,
                    };
                }
            })
        ).then((results) => {
            if (cancelled) return;
            setRows(
                results.map((result) => ({
                    id: result.id,
                    record: result.record,
                    loading: false,
                    error: result.error,
                    includeSeed: true,
                    includeLoras: true,
                }))
            );
        });

        return () => {
            cancelled = true;
        };
    }, [imageIds]);
    /* eslint-enable react-hooks/set-state-in-effect */

    const urlError = getForgeUrlError(baseUrl);
    const weightError = useMemo(() => {
        if (loraWeight == null) return null;
        if (!Number.isFinite(loraWeight) || loraWeight < 0 || loraWeight > 2) {
            return "LoRA weight must be between 0 and 2 before sending to Forge.";
        }
        return null;
    }, [loraWeight]);
    const tooMany = imageIds.length > FORGE_BATCH_COUNT_MAX;
    const loadedRows = rows.filter((row) => row.record != null);
    const canSend =
        !sending &&
        !tooMany &&
        !urlError &&
        !weightError &&
        loadedRows.length > 0;

    /** Shared overrides (including a toolbar seed such as "-1") are applied as-is. */
    const sharedOverrides = useMemo(
        () => (overrides ? { ...overrides } : {}),
        [overrides]
    );

    const updateRow = useCallback((id: number, patch: Partial<ReconciliationRow>) => {
        setRows((previous) =>
            previous.map((row) => (row.id === id ? { ...row, ...patch } : row))
        );
    }, []);

    const handleClose = useCallback(() => {
        abortRef.current = true;
        onClose();
    }, [onClose]);

    const handleSend = useCallback(async () => {
        if (!canSend) return;
        setSending(true);
        setSummary(null);
        abortRef.current = false;
        const targets = rows.filter(
            (row): row is ReconciliationRow & { record: ImageRecord } => row.record != null
        );
        setProgress({ current: 0, total: targets.length });
        const failures = rows
            .filter((row) => row.error != null)
            .map((row) => `Image #${row.id}: ${row.error}`);
        const successes: ForgeSendResult[] = [];

        for (let index = 0; index < targets.length; index += 1) {
            if (abortRef.current) {
                failures.push("Sending was cancelled.");
                break;
            }
            const row = targets[index];
            const record = row.record;
            const stored = buildStoredOverrides(record, row.includeLoras);
            let rowOverrides: Partial<ForgePayloadOverrides>;
            if (mode === "shared") {
                // Keep the toolbar's seed override (e.g. "-1") so each image gets a fresh seed.
                rowOverrides = { ...stored, ...sharedOverrides };
            } else {
                rowOverrides = { ...stored };
                if (includeSeed === true) {
                    rowOverrides.seed = "-1";
                } else if (!row.includeSeed) {
                    delete rowOverrides.seed;
                }
            }

            try {
                // Toolbar LoRA tokens win over tokens stored on the image when provided.
                const result = await forgeSendToImage(
                    row.id,
                    baseUrl,
                    apiKey.trim() ? apiKey : null,
                    outputDir,
                    row.includeSeed,
                    adetailerEnabled,
                    adetailerModel,
                    loraTokens ?? null,
                    loraWeight,
                    Object.keys(rowOverrides).length > 0 ? rowOverrides : null,
                    null,
                    { loraWeights, batchCount, saveForgeCopy, confirmUnencrypted }
                );
                if (result.ok) {
                    successes.push(result);
                } else {
                    failures.push(`${record.filename}: ${result.message}`);
                }
            } catch (error) {
                failures.push(`${record.filename}: ${String(error)}`);
            }
            if (mountedRef.current) {
                setProgress({ current: index + 1, total: targets.length });
            }
        }

        if (!mountedRef.current) return;
        setSending(false);
        setProgress(null);

        const noun = successes.length === 1 ? "image" : "images";
        let message = `Queued ${successes.length} ${noun} to Forge.`;
        if (failures.length > 0) message += ` Not sent: ${failures.join(" | ")}`;
        setSummary(message);

        if (successes.length > 0) {
            const aggregate: ForgeSendResult = {
                ok: failures.length === 0,
                message,
                output_dir: successes[successes.length - 1].output_dir,
                generated_count: successes.reduce((sum, item) => sum + item.generated_count, 0),
                saved_paths: successes.flatMap((item) => item.saved_paths),
                children: successes.flatMap((item) => item.children),
            };
            onQueued(`batch-reconcile-${Date.now()}`, aggregate);
        }
        if (failures.length > 0) onError(message);
    }, [
        canSend,
        rows,
        mode,
        includeSeed,
        sharedOverrides,
        loraTokens,
        baseUrl,
        apiKey,
        outputDir,
        adetailerEnabled,
        adetailerModel,
        loraWeight,
        loraWeights,
        batchCount,
        saveForgeCopy,
        confirmUnencrypted,
        onQueued,
        onError,
    ]);

    const renderRow = (row: ReconciliationRow) => {
        if (row.loading) {
            return (
                <div
                    key={row.id}
                    className="batch-reconciliation-skeleton"
                    data-testid={`batch-row-skeleton-${row.id}`}
                    aria-hidden="true"
                >
                    Loading image #{row.id}…
                </div>
            );
        }
        if (!row.record) {
            return (
                <section
                    key={row.id}
                    className="batch-reconciliation-row"
                    data-testid={`batch-reconciliation-row-${row.id}`}
                >
                    <strong>Image #{row.id}</strong>
                    <p role="alert" data-testid={`row-error-${row.id}`}>
                        {row.error ?? "Could not load details."}
                    </p>
                </section>
            );
        }

        const record = row.record;
        const loras = extractLoraTokens(record);
        const modules = extractModulePaths(record);
        return (
            <section
                key={row.id}
                className="batch-reconciliation-row"
                data-testid={`batch-reconciliation-row-${row.id}`}
                aria-label={`Image ${row.id}: ${record.filename}`}
            >
                <strong data-testid={`row-filename-${row.id}`}>
                    {record.filename} (#{row.id})
                </strong>
                <dl className="batch-reconciliation-fields">
                    <div>
                        <dt>Model</dt>
                        <dd data-testid={`row-model-${row.id}`}>{display(record.model_name)}</dd>
                    </div>
                    <div>
                        <dt>Seed</dt>
                        <dd data-testid={`row-seed-${row.id}`}>{display(record.seed)}</dd>
                    </div>
                    <div>
                        <dt>Steps</dt>
                        <dd data-testid={`row-steps-${row.id}`}>{display(record.steps)}</dd>
                    </div>
                    <div>
                        <dt>CFG</dt>
                        <dd data-testid={`row-cfg-${row.id}`}>{display(record.cfg_scale)}</dd>
                    </div>
                    <div>
                        <dt>Sampler</dt>
                        <dd data-testid={`row-sampler-${row.id}`}>{display(record.sampler)}</dd>
                    </div>
                    <div>
                        <dt>Scheduler</dt>
                        <dd data-testid={`row-scheduler-${row.id}`}>{display(record.schedule_type)}</dd>
                    </div>
                    <div>
                        <dt>Size</dt>
                        <dd data-testid={`row-size-${row.id}`}>
                            {record.width != null && record.height != null
                                ? `${record.width}×${record.height}`
                                : NOT_RECORDED}
                        </dd>
                    </div>
                    <div>
                        <dt>LoRA tokens</dt>
                        <dd data-testid={`row-loras-${row.id}`}>
                            {loras.length > 0 ? loras.join(" ") : NOT_RECORDED}
                        </dd>
                    </div>
                    <div>
                        <dt>Module paths</dt>
                        <dd data-testid={`row-modules-${row.id}`}>
                            {modules.length > 0 ? modules.join(", ") : NOT_RECORDED}
                        </dd>
                    </div>
                </dl>
                {mode === "stored" ? (
                    <div className="batch-reconciliation-toggles">
                        <label>
                            <input
                                type="checkbox"
                                checked={row.includeSeed}
                                aria-label={`Include stored seed for image ${row.id}`}
                                onChange={(event) =>
                                    updateRow(row.id, { includeSeed: event.target.checked })
                                }
                            />
                            Include stored seed
                        </label>
                        <label>
                            <input
                                type="checkbox"
                                checked={row.includeLoras}
                                aria-label={`Include stored LoRAs for image ${row.id}`}
                                onChange={(event) =>
                                    updateRow(row.id, { includeLoras: event.target.checked })
                                }
                            />
                            Include stored LoRAs
                        </label>
                    </div>
                ) : null}
            </section>
        );
    };

    return (
        <Modal
            label="Review Forge batch send"
            onClose={handleClose}
            initialFocusRef={storedModeRef}
            className="settings-dialog batch-reconciliation-sheet"
            style={{ maxWidth: 960, maxHeight: "85vh", overflow: "auto" }}
            panelTestId="batch-reconciliation-sheet"
        >
            <header className="settings-header">
                <h2>Review Forge batch send</h2>
                <button
                    type="button"
                    className="viewer-control-button"
                    onClick={handleClose}
                    aria-label="Close review"
                >
                    ✕
                </button>
            </header>
            <div
                className="settings-body"
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
                <p>
                    Each image is sent with its own stored parameters. Review them before queuing;
                    nothing is sent until you choose Send.
                </p>
                {tooMany ? (
                    <p role="alert" className="input-error">
                        Only {FORGE_BATCH_COUNT_MAX} images can be sent at once. Narrow the selection.
                    </p>
                ) : null}
                {urlError ? (
                    <p role="alert" className="input-error">
                        {urlError}
                    </p>
                ) : null}
                {weightError ? (
                    <p role="alert" className="input-error">
                        {weightError}
                    </p>
                ) : null}
                <fieldset style={{ border: "1px solid var(--border, #444)", borderRadius: 6 }}>
                    <legend>Parameter mode</legend>
                    <label style={{ display: "block" }}>
                        <input
                            ref={storedModeRef}
                            type="radio"
                            name="batch-reconciliation-mode"
                            checked={mode === "stored"}
                            onChange={() => setMode("stored")}
                        />
                        Use each image's stored params
                    </label>
                    <label style={{ display: "block" }}>
                        <input
                            type="radio"
                            name="batch-reconciliation-mode"
                            checked={mode === "shared"}
                            onChange={() => setMode("shared")}
                        />
                        Apply shared overrides
                    </label>
                </fieldset>
                {mode === "shared" ? (
                    <p className="settings-hint">
                        Shared overrides are applied to every image. A random-seed request sends
                        "-1", and toolbar LoRA tokens replace the image's own when selected.
                    </p>
                ) : null}
                {rows.some((row) => row.loading) ? (
                    <p role="status" data-testid="batch-loading" aria-live="polite">
                        Loading image details…
                    </p>
                ) : null}
                <div className="batch-reconciliation-rows" style={{ display: "grid", gap: 8 }}>
                    {rows.map(renderRow)}
                </div>
                {progress ? (
                    <p role="status" data-testid="batch-progress" aria-live="polite">
                        Sending {progress.current}/{progress.total}
                    </p>
                ) : null}
                {summary ? (
                    <p role="status" data-testid="batch-summary">
                        {summary}
                    </p>
                ) : null}
                <footer
                    style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}
                >
                    {sending ? (
                        <button
                            type="button"
                            className="sidebar-button"
                            onClick={() => {
                                abortRef.current = true;
                            }}
                        >
                            Cancel send
                        </button>
                    ) : null}
                    <button type="button" className="sidebar-button" onClick={handleClose}>
                        Close
                    </button>
                    <button
                        type="button"
                        className="sidebar-button"
                        data-testid="batch-send"
                        disabled={!canSend}
                        onClick={() => void handleSend()}
                    >
                        {`Send ${imageIds.length} image${imageIds.length === 1 ? "" : "s"}`}
                    </button>
                </footer>
            </div>
        </Modal>
    );
}

export default BatchReconciliationSheet;
