import { useCallback, useMemo, useState } from "react";
import { forgeSendToImage, forgeSendToImages, forgeTestConnection } from "../services/commands";
import type { ForgeSendResult, ForgeBatchSendResult, ForgePayloadOverrides } from "../types/metadata";

type QueueState = "idle" | "testing" | "queuing" | "done" | "error";

interface ForgeRequeueButtonProps {
    imageId?: number;
    imageIds?: number[];
    baseUrl: string;
    apiKey: string;
    outputDir?: string | null;
    includeSeed?: boolean;
    adetailerEnabled?: boolean;
    adetailerModel?: string | null;
    loraTokens?: string[] | null;
    loraWeight?: number | null;
    overrides?: Partial<ForgePayloadOverrides> | null;
    mutationOps?: unknown | null;
    onQueued?: (queueId: string, result: ForgeSendResult | ForgeBatchSendResult) => void;
    onError?: (message: string) => void;
    /** Site-specific pre-send validation (payload ranges, selection state). Return an error message to abort, null to proceed. */
    validate?: () => string | null;
    className?: string;
    disabled?: boolean;
    label?: string;
}

function extractQueueId(message: string, fallback: string): string {
    const queued = message.match(/Queued\s+([^\s—]+)/i);
    if (queued?.[1]) return queued[1].replace(/[,;]+$/, "");
    const idMatch = message.match(/(requeue-[0-9]+)/i);
    if (idMatch?.[1]) return idMatch[1];
    return fallback;
}

export function ForgeRequeueButton({
    imageId,
    imageIds,
    baseUrl,
    apiKey,
    outputDir = null,
    includeSeed = true,
    adetailerEnabled = false,
    adetailerModel = null,
    loraTokens = null,
    loraWeight = null,
    overrides = null,
    mutationOps = null,
    onQueued,
    onError,
    validate,
    className,
    disabled,
    label,
}: ForgeRequeueButtonProps) {
    const [state, setState] = useState<QueueState>("idle");
    const [queueId, setQueueId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const isBatch = Array.isArray(imageIds) && imageIds.length > 0;
    const effectiveIds = useMemo(
        () => (isBatch ? (imageIds as number[]) : imageId != null ? [imageId] : []),
        [isBatch, imageIds, imageId],
    );

    const handleRequeue = useCallback(async () => {
        if (effectiveIds.length === 0) {
            const msg = "No image selected for requeue.";
            setError(msg);
            setState("error");
            onError?.(msg);
            return;
        }
        if (!baseUrl.trim()) {
            const msg = "Forge URL is required.";
            setError(msg);
            setState("error");
            onError?.(msg);
            return;
        }

        const validationMsg = validate?.();
        if (validationMsg) {
            setError(validationMsg);
            setState("error");
            onError?.(validationMsg);
            return;
        }

        setError(null);
        setQueueId(null);
        setState("testing");

        try {
            const conn = await forgeTestConnection(baseUrl, apiKey.trim() ? apiKey : null);
            if (!conn.ok) {
                const msg = conn.message || "Forge test connection failed.";
                setError(msg);
                setState("error");
                onError?.(msg);
                return;
            }
        } catch (e) {
            const msg = `Forge test failed: ${String(e)}`;
            setError(msg);
            setState("error");
            onError?.(msg);
            return;
        }

        setState("queuing");
        try {
            if (isBatch) {
                const result: ForgeBatchSendResult = await forgeSendToImages(
                    effectiveIds,
                    baseUrl,
                    apiKey.trim() ? apiKey : null,
                    outputDir,
                    includeSeed,
                    adetailerEnabled,
                    adetailerModel,
                    loraTokens,
                    loraWeight,
                    overrides,
                    mutationOps
                );
                const fallback = `batch-${Date.now()}`;
                const qid = extractQueueId(result.message, fallback);
                setQueueId(qid);
                setState(result.failed === 0 ? "done" : "error");
                if (result.failed > 0) {
                    setError(result.message);
                    onError?.(result.message);
                } else {
                    onQueued?.(qid, result);
                }
            } else {
                const result: ForgeSendResult = await forgeSendToImage(
                    effectiveIds[0],
                    baseUrl,
                    apiKey.trim() ? apiKey : null,
                    outputDir,
                    includeSeed,
                    adetailerEnabled,
                    adetailerModel,
                    loraTokens,
                    loraWeight,
                    overrides,
                    mutationOps
                );
                const fallback = `requeue-${Date.now()}`;
                const qid = extractQueueId(result.message, fallback);
                if (!result.ok) {
                    setError(result.message);
                    setState("error");
                    onError?.(result.message);
                    return;
                }
                setQueueId(qid);
                setState("done");
                onQueued?.(qid, result);
            }
        } catch (e) {
            const msg = `Requeue failed: ${String(e)}`;
            setError(msg);
            setState("error");
            onError?.(msg);
        }
    }, [
        effectiveIds,
        baseUrl,
        apiKey,
        outputDir,
        includeSeed,
        adetailerEnabled,
        adetailerModel,
        loraTokens,
        loraWeight,
        overrides,
        mutationOps,
        isBatch,
        validate,
        onQueued,
        onError,
    ]);

    const isBusy = state === "testing" || state === "queuing";
    const buttonLabel =
        label ??
        (isBatch
            ? state === "testing"
                ? "Testing Forge…"
                : state === "queuing"
                  ? `Queuing ${effectiveIds.length}…`
                  : `Requeue ${effectiveIds.length} to Forge`
            : state === "testing"
              ? "Testing Forge…"
              : state === "queuing"
                ? "Queuing…"
                : "Requeue to Forge");

    return (
        <div className="forge-requeue-wrap" style={{ display: "inline-flex", flexDirection: "column", gap: 6 }}>
            <button
                type="button"
                className={className ?? "viewer-action-button primary"}
                onClick={handleRequeue}
                disabled={disabled || isBusy || effectiveIds.length === 0}
                title="Test connection then requeue with pinned override_settings (seed/sampler/cfg/LoRA/model)"
            >
                {buttonLabel}
            </button>
            {queueId ? (
                <span
                    className="forge-requeue-queue-id"
                    style={{ fontSize: 12, color: "var(--text-muted, #888)" }}
                    aria-live="polite"
                >
                    Queue: {queueId}
                </span>
            ) : null}
            {error ? (
                <span
                    className="forge-requeue-error"
                    style={{ fontSize: 12, color: "var(--danger, #c33)" }}
                    role="alert"
                >
                    {error}
                </span>
            ) : state === "done" && queueId ? (
                <span
                    className="forge-requeue-success"
                    style={{ fontSize: 12, color: "var(--success, #2a7)" }}
                    aria-live="polite"
                >
                    Queued {queueId}
                </span>
            ) : null}
        </div>
    );
}

export default ForgeRequeueButton;
