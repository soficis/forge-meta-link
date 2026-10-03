import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useRef, useState } from "react";
import { Modal } from "../Modal";

describe("Modal component", () => {
    it("moves focus to initialFocusRef or first focusable element on mount", () => {
        const onClose = vi.fn();
        const { unmount } = render(
            <Modal onClose={onClose} label="Test Modal">
                <button type="button" data-testid="btn-1">First</button>
                <button type="button" data-testid="btn-2">Second</button>
            </Modal>
        );

        expect(document.activeElement).toBe(screen.getByTestId("btn-1"));
        unmount();

        function WithInitialFocus() {
            const btn2Ref = useRef<HTMLButtonElement>(null);
            return (
                <Modal onClose={onClose} label="Test Modal 2" initialFocusRef={btn2Ref}>
                    <button type="button" data-testid="btn-1">First</button>
                    <button ref={btn2Ref} type="button" data-testid="btn-2">Second</button>
                </Modal>
            );
        }

        render(<WithInitialFocus />);
        expect(document.activeElement).toBe(screen.getByTestId("btn-2"));
    });

    it("cycles Tab from last to first and Shift+Tab from first to last (focus trap)", () => {
        const onClose = vi.fn();
        render(
            <Modal onClose={onClose} label="Focus Trap Modal">
                <button type="button" data-testid="first-btn">First</button>
                <input type="text" data-testid="middle-input" />
                <button type="button" data-testid="last-btn">Last</button>
            </Modal>
        );

        const first = screen.getByTestId("first-btn");
        const middle = screen.getByTestId("middle-input");
        const last = screen.getByTestId("last-btn");

        // Start at last element and press Tab -> wraps to first
        last.focus();
        expect(document.activeElement).toBe(last);
        fireEvent.keyDown(last, { key: "Tab" });
        expect(document.activeElement).toBe(first);

        // From first element, press Shift+Tab -> wraps to last
        fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
        expect(document.activeElement).toBe(last);

        // When focus is in the middle, Tab allows normal navigation
        middle.focus();
        expect(document.activeElement).toBe(middle);
    });

    it("Esc closes and does not reach a keydown listener on window", () => {
        const onClose = vi.fn();
        const windowListener = vi.fn();
        window.addEventListener("keydown", windowListener);

        render(
            <Modal onClose={onClose} label="Esc Modal">
                <button type="button" data-testid="modal-btn">Inside</button>
            </Modal>
        );

        const btn = screen.getByTestId("modal-btn");
        fireEvent.keyDown(btn, { key: "Escape" });

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(windowListener).not.toHaveBeenCalled();

        window.removeEventListener("keydown", windowListener);
    });

    it("restores focus to the opener element after unmount", () => {
        const onClose = vi.fn();

        function TestOpener() {
            const [isOpen, setIsOpen] = useState(false);
            return (
                <div>
                    <button
                        type="button"
                        data-testid="opener-btn"
                        onClick={() => setIsOpen(true)}
                    >
                        Open
                    </button>
                    {isOpen && (
                        <Modal onClose={() => { setIsOpen(false); onClose(); }} label="Restoration Modal">
                            <button type="button" data-testid="modal-btn">Inside</button>
                        </Modal>
                    )}
                </div>
            );
        }

        render(<TestOpener />);
        const opener = screen.getByTestId("opener-btn");
        opener.focus();
        expect(document.activeElement).toBe(opener);

        fireEvent.click(opener);
        expect(document.activeElement).toBe(screen.getByTestId("modal-btn"));

        // Close via Esc
        fireEvent.keyDown(screen.getByTestId("modal-btn"), { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(opener);
    });

    it("backdrop click closes but a click inside the panel does not", () => {
        const onClose = vi.fn();
        const { container } = render(
            <Modal onClose={onClose} label="Backdrop Modal">
                <div data-testid="panel-content">
                    <button type="button" data-testid="inner-btn">Action</button>
                </div>
            </Modal>
        );

        const backdrop = container.querySelector(".settings-backdrop") as HTMLDivElement;
        const panelContent = screen.getByTestId("panel-content");

        // Click inside the panel -> does not close
        fireEvent.mouseDown(panelContent);
        fireEvent.click(panelContent);
        expect(onClose).not.toHaveBeenCalled();

        // Click on the backdrop -> closes
        fireEvent.mouseDown(backdrop);
        fireEvent.click(backdrop);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("respects closeOnBackdrop=false and closeOnEscape=false", () => {
        const onClose = vi.fn();
        const { container } = render(
            <Modal onClose={onClose} label="Strict Modal" closeOnBackdrop={false} closeOnEscape={false}>
                <button type="button" data-testid="inner-btn">Stay Open</button>
            </Modal>
        );

        const backdrop = container.querySelector(".settings-backdrop") as HTMLDivElement;
        const btn = screen.getByTestId("inner-btn");

        fireEvent.mouseDown(backdrop);
        fireEvent.click(backdrop);
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(btn, { key: "Escape" });
        expect(onClose).not.toHaveBeenCalled();
    });

    it("drag-release cases: mousedown on panel then release on backdrop does not close; mousedown on backdrop then release on panel does not close", () => {
        const onClose = vi.fn();
        const { container } = render(
            <Modal onClose={onClose} label="Drag Modal">
                <div data-testid="panel-content">
                    <button type="button" data-testid="inner-btn">Action</button>
                </div>
            </Modal>
        );

        const backdrop = container.querySelector(".settings-backdrop") as HTMLDivElement;
        const panelContent = screen.getByTestId("panel-content");

        // 1. Mousedown inside panel, click/release on backdrop -> does not close
        fireEvent.mouseDown(panelContent);
        fireEvent.click(backdrop);
        expect(onClose).not.toHaveBeenCalled();

        // 2. Mousedown on backdrop, click/release on panel -> does not close
        fireEvent.mouseDown(backdrop);
        fireEvent.click(panelContent);
        expect(onClose).not.toHaveBeenCalled();
    });
});

