import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useToast } from "../useToast";

describe("useToast", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("(a) pushing a plain toast after an Undo toast leaves both visible", () => {
        const { result } = renderHook(() => useToast());

        act(() => {
            result.current.showToast("Moved 9 images to Trash.", {
                tone: "warning",
                durationMs: 6000,
                actionLabel: "Undo",
                onAction: () => {},
            });
        });

        expect(result.current.toasts).toHaveLength(1);
        expect(result.current.toasts[0].message).toBe("Moved 9 images to Trash.");
        expect(result.current.toasts[0].actionLabel).toBe("Undo");

        // Push a plain toast (e.g. Compare Lab pin or timeline filter)
        act(() => {
            result.current.showToast("Pinned to Compare Lab slot 1", {
                tone: "info",
                durationMs: 2200,
            });
        });

        // Both toasts must be visible simultaneously
        expect(result.current.toasts).toHaveLength(2);
        expect(result.current.toasts[0].actionLabel).toBe("Undo");
        expect(result.current.toasts[1].message).toBe("Pinned to Compare Lab slot 1");
    });

    it("(b) the Undo toast survives until its own timeout", () => {
        const { result } = renderHook(() => useToast());

        act(() => {
            result.current.showToast("Moved 9 images to Trash.", {
                tone: "warning",
                durationMs: 6000,
                actionLabel: "Undo",
                onAction: () => {},
            });
        });

        act(() => {
            result.current.showToast("Pinned to Compare Lab slot 1", {
                tone: "info",
                durationMs: 2200,
            });
        });

        expect(result.current.toasts).toHaveLength(2);

        // Advance 2200ms: plain toast expires, Undo toast survives!
        act(() => {
            vi.advanceTimersByTime(2200);
        });

        expect(result.current.toasts).toHaveLength(1);
        expect(result.current.toasts[0].actionLabel).toBe("Undo");

        // Advance remaining 3800ms: Undo toast expires
        act(() => {
            vi.advanceTimersByTime(3800);
        });

        expect(result.current.toasts).toHaveLength(0);
    });

    it("caps visible toasts at 3 and displaces oldest non-actionable toast while preserving Undo", () => {
        const { result } = renderHook(() => useToast());

        // 1: Actionable Undo toast (6000ms)
        act(() => {
            result.current.showToast("Undo delete", {
                durationMs: 6000,
                actionLabel: "Undo",
                onAction: () => {},
            });
        });

        // 2: Plain toast A (5000ms)
        act(() => {
            result.current.showToast("Plain A", { durationMs: 5000 });
        });

        // 3: Plain toast B (5000ms)
        act(() => {
            result.current.showToast("Plain B", { durationMs: 5000 });
        });

        expect(result.current.toasts).toHaveLength(3);

        // 4: Plain toast C pushed - reaches cap 3. Should displace Plain A (oldest non-actionable).
        act(() => {
            result.current.showToast("Plain C", { durationMs: 5000 });
        });

        expect(result.current.toasts).toHaveLength(3);
        const messages = result.current.toasts.map((t) => t.message);
        expect(messages).toEqual(["Undo delete", "Plain B", "Plain C"]);
    });

    it("allows dismissing an individual toast by ID", () => {
        const { result } = renderHook(() => useToast());

        act(() => {
            result.current.showToast("Toast 1", { durationMs: 5000 });
            result.current.showToast("Toast 2", { durationMs: 5000 });
        });

        expect(result.current.toasts).toHaveLength(2);
        const toast1Id = result.current.toasts[0].id;

        act(() => {
            result.current.dismissToast(toast1Id);
        });

        expect(result.current.toasts).toHaveLength(1);
        expect(result.current.toasts[0].message).toBe("Toast 2");
    });

    it("clearToast clears all toasts and timers", () => {
        const { result } = renderHook(() => useToast());

        act(() => {
            result.current.showToast("Toast 1", { durationMs: 5000 });
            result.current.showToast("Toast 2", { durationMs: 5000 });
        });

        expect(result.current.toasts).toHaveLength(2);

        act(() => {
            result.current.clearToast();
        });

        expect(result.current.toasts).toHaveLength(0);
    });
});
