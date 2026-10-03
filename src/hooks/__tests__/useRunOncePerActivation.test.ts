import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRunOncePerActivation } from "../useRunOncePerActivation";

describe("useRunOncePerActivation", () => {
    it("does not run while inactive", () => {
        const run = vi.fn();
        renderHook(() => useRunOncePerActivation(false, run));
        expect(run).not.toHaveBeenCalled();
    });

    it("runs once on activation and not again while it stays active, even if run changes every render", () => {
        const calls: number[] = [];
        let render = 0;
        const { rerender } = renderHook(
            ({ active }) => {
                const n = ++render;
                // a new function identity on every render, like an inline arrow in a component
                useRunOncePerActivation(active, () => calls.push(n));
            },
            { initialProps: { active: true } }
        );
        for (let i = 0; i < 5; i++) rerender({ active: true });
        expect(calls).toHaveLength(1);
    });

    it("runs again each time it is re-activated and uses the latest run", () => {
        const first = vi.fn();
        const second = vi.fn();
        const { rerender } = renderHook(
            ({ active, fn }) => useRunOncePerActivation(active, fn),
            { initialProps: { active: true, fn: first } }
        );
        expect(first).toHaveBeenCalledTimes(1);
        rerender({ active: false, fn: first });
        rerender({ active: true, fn: second });
        expect(second).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledTimes(1);
    });
});
