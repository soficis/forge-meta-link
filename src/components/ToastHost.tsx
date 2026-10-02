import type { ToastState } from "../hooks/useToast";

interface ToastHostProps {
    toast?: ToastState | null;
    toasts?: ToastState[];
    onDismiss?: () => void;
    onDismissToast?: (id: number) => void;
}

export function ToastHost({ toast, toasts, onDismiss, onDismissToast }: ToastHostProps) {
    const list = toasts ?? (toast ? [toast] : []);
    if (list.length === 0) {
        return null;
    }

    return (
        <div className="app-toast-stack" role="region" aria-label="Notifications">
            {list.map((item) => (
                <div
                    className={`app-toast app-toast-${item.tone}`}
                    role={item.tone === "error" ? "alert" : "status"}
                    aria-live={item.tone === "error" ? "assertive" : "polite"}
                    key={item.id}
                >
                    <span>{item.message}</span>
                    {item.actionLabel && item.onAction && (
                        <button
                            type="button"
                            className="app-toast-action"
                            onClick={() => {
                                item.onAction?.();
                                if (onDismissToast) {
                                    onDismissToast(item.id);
                                } else if (onDismiss) {
                                    onDismiss();
                                }
                            }}
                        >
                            {item.actionLabel}
                        </button>
                    )}
                    <button
                        type="button"
                        className="app-toast-dismiss"
                        onClick={() => {
                            if (onDismissToast) {
                                onDismissToast(item.id);
                            } else if (onDismiss) {
                                onDismiss();
                            }
                        }}
                        aria-label="Dismiss notification"
                    >
                        ×
                    </button>
                </div>
            ))}
        </div>
    );
}
