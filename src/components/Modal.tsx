import React, { useEffect, useRef } from "react";

export interface ModalProps {
    labelledBy?: string;
    label?: string;
    onClose: () => void;
    initialFocusRef?: React.RefObject<HTMLElement | null>;
    role?: "dialog" | "alertdialog";
    children: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    closeOnBackdrop?: boolean;
    closeOnEscape?: boolean;
    onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
    "aria-describedby"?: string;
    "data-testid"?: string;
    backdropTestId?: string;
    panelTestId?: string;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
    const selector = [
        "a[href]",
        "button:not([disabled])",
        "input:not([disabled]):not([type=\"hidden\"])",
        "textarea:not([disabled])",
        "select:not([disabled])",
        "[tabindex]:not([tabindex=\"-1\"])",
    ].join(", ");

    const elements = Array.from(container.querySelectorAll<HTMLElement>(selector));
    return elements.filter((el) => {
        if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") {
            return false;
        }
        return true;
    });
}

export function Modal({
    labelledBy,
    label,
    onClose,
    initialFocusRef,
    role = "dialog",
    children,
    className,
    style,
    closeOnBackdrop = true,
    closeOnEscape = true,
    onKeyDown,
    "aria-describedby": ariaDescribedBy,
    "data-testid": dataTestId,
    backdropTestId,
    panelTestId,
}: ModalProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const openerRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        openerRef.current = document.activeElement as HTMLElement | null;

        if (initialFocusRef?.current) {
            initialFocusRef.current.focus();
        } else if (panelRef.current) {
            const focusables = getFocusableElements(panelRef.current);
            if (focusables.length > 0) {
                focusables[0].focus();
            } else {
                panelRef.current.focus();
            }
        }

        return () => {
            if (openerRef.current && document.contains(openerRef.current)) {
                openerRef.current.focus();
            }
        };
    }, [initialFocusRef]);


    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) {
            return;
        }

        if (event.key === "Escape") {
            if (closeOnEscape) {
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation?.();
                event.nativeEvent.stopPropagation?.();
                event.preventDefault();
                onClose();
                return;
            }
        }

        if (event.key === "Tab") {
            const panel = panelRef.current;
            if (!panel) return;

            const focusables = getFocusableElements(panel);
            if (focusables.length === 0) {
                event.preventDefault();
                panel.focus();
                return;
            }

            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement;

            if (event.shiftKey) {
                if (active === first || active === panel || !panel.contains(active)) {
                    event.preventDefault();
                    last.focus();
                }
            } else {
                if (active === last || active === panel || !panel.contains(active)) {
                    event.preventDefault();
                    first.focus();
                }
            }
        }
    };

    const mouseDownOnBackdrop = useRef(false);

    const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
        mouseDownOnBackdrop.current = event.target === event.currentTarget;
    };

    const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (closeOnBackdrop && event.target === event.currentTarget && mouseDownOnBackdrop.current) {
            onClose();
        }
        mouseDownOnBackdrop.current = false;
    };

    return (
        <div
            className="settings-backdrop"
            data-testid={backdropTestId}
            onMouseDown={handleMouseDown}
            onClick={handleClick}
        >
            <div
                ref={panelRef}
                className={className}
                style={style}
                role={role}
                aria-modal="true"
                aria-labelledby={labelledBy}
                aria-label={label}
                aria-describedby={ariaDescribedBy}
                tabIndex={-1}
                onKeyDown={handleKeyDown}
                data-testid={panelTestId ?? dataTestId}
            >
                {children}
            </div>
        </div>
    );
}
