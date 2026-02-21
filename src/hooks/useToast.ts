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

export function useToast() {
    const [toast, setToast] = useState<ToastState | null>(null);
    const timeoutRef = useRef<number | null>(null);
    const idRef = useRef(0);

    const clearToast = useCallback(() => {
        setToast(null);
        if (timeoutRef.current != null) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
    }, []);

    const showToast = useCallback(
        (message: string, options: ShowToastOptions = {}) => {
            const durationMs = options.durationMs ?? DEFAULT_TOAST_DURATION_MS;
            const tone = options.tone ?? "info";

            if (timeoutRef.current != null) {
                window.clearTimeout(timeoutRef.current);
            }

            idRef.current += 1;
            setToast({
                id: idRef.current,
                message,
                tone,
                actionLabel: options.actionLabel,
                onAction: options.onAction,
            });

            timeoutRef.current = window.setTimeout(() => {
                setToast(null);
                timeoutRef.current = null;
            }, durationMs);
        },
        []
    );

    useEffect(() => clearToast, [clearToast]);

    return {
        toast,
        showToast,
        clearToast,
    };
}
