import type { ToastState } from "../hooks/useToast";

interface ToastHostProps {
    toast: ToastState | null;
    onDismiss: () => void;
}

export function ToastHost({ toast, onDismiss }: ToastHostProps) {
    if (!toast) {
        return null;
    }

    return (
        <div
            className={`app-toast app-toast-${toast.tone}`}
            role={toast.tone === "error" ? "alert" : "status"}
            aria-live={toast.tone === "error" ? "assertive" : "polite"}
            key={toast.id}
        >
            <span>{toast.message}</span>
            {toast.actionLabel && toast.onAction && (
                <button
                    type="button"
                    className="app-toast-action"
                    onClick={toast.onAction}
                >
                    {toast.actionLabel}
                </button>
            )}
            <button
                type="button"
                className="app-toast-dismiss"
                onClick={onDismiss}
                aria-label="Dismiss notification"
            >
                ×
            </button>
        </div>
    );
}
