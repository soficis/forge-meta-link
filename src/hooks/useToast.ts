import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastState {
    id: number;
    message: string;
    tone: ToastTone;
    actionLabel?: string;
    onAction?: () => void;
}

export interface ShowToastOptions {
    tone?: ToastTone;
    durationMs?: number;
    actionLabel?: string;
    onAction?: () => void;
}

const DEFAULT_TOAST_DURATION_MS = 3200;
const MAX_VISIBLE_TOASTS = 3;

export function useToast() {
    const [toasts, setToasts] = useState<ToastState[]>([]);
    const timersRef = useRef<Map<number, number>>(new Map());
    const idRef = useRef(0);

    const dismissToast = useCallback((id: number) => {
        const timer = timersRef.current.get(id);
        if (timer != null) {
            window.clearTimeout(timer);
            timersRef.current.delete(id);
        }
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const clearToast = useCallback(() => {
        for (const timer of timersRef.current.values()) {
            window.clearTimeout(timer);
        }
        timersRef.current.clear();
        setToasts([]);
    }, []);

    const showToast = useCallback(
        (message: string, options: ShowToastOptions = {}) => {
            const durationMs = options.durationMs ?? DEFAULT_TOAST_DURATION_MS;
            const tone = options.tone ?? "info";

            idRef.current += 1;
            const id = idRef.current;

            const newToast: ToastState = {
                id,
                message,
                tone,
                actionLabel: options.actionLabel,
                onAction: options.onAction,
            };

            const timerId = window.setTimeout(() => {
                timersRef.current.delete(id);
                setToasts((prev) => prev.filter((t) => t.id !== id));
            }, durationMs);

            timersRef.current.set(id, timerId);

            setToasts((prev) => {
                if (prev.length < MAX_VISIBLE_TOASTS) {
                    return [...prev, newToast];
                }

                // If already at cap (3 visible), displace the oldest non-actionable toast.
                // Actionable toasts (e.g. Undo) are never displaced.
                const nonActionableIndex = prev.findIndex(
                    (t) => !t.actionLabel || !t.onAction
                );

                if (nonActionableIndex !== -1) {
                    const displaced = prev[nonActionableIndex];
                    if (displaced) {
                        const oldTimer = timersRef.current.get(displaced.id);
                        if (oldTimer != null) {
                            window.clearTimeout(oldTimer);
                            timersRef.current.delete(displaced.id);
                        }
                    }
                    const next = [...prev];
                    next.splice(nonActionableIndex, 1);
                    return [...next, newToast];
                }

                return [...prev, newToast];
            });
        },
        []
    );

    useEffect(() => {
        const timers = timersRef.current;
        return () => {
            for (const timer of timers.values()) {
                window.clearTimeout(timer);
            }
            timers.clear();
        };
    }, []);

    return {
        toast: toasts[toasts.length - 1] ?? null,
        toasts,
        showToast,
        pushToast: showToast,
        clearToast,
        dismissToast,
    };
}
