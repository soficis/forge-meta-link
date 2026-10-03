import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MutationPopover } from "../MutationPopover";
import { installTauriMock, type TauriMock } from "../../test/tauriMock";
import type { GalleryImageRecord, ImageRecord } from "../../types/metadata";

const winner: GalleryImageRecord = {
    id: 42,
    filepath: "/lib/winner.png",
    filename: "winner.png",
    directory: "/lib",
    seed: "100",
    width: 128,
    height: 128,
    model_name: "m.safetensors",
    is_favorite: false,
    is_locked: false,
    file_mtime: null,
};

const details = (over: Partial<ImageRecord> = {}): ImageRecord => ({
    ...winner,
    prompt: "a lighthouse <lora:x:0.6>",
    negative_prompt: "blurry",
    steps: "20",
    sampler: "Euler a",
    cfg_scale: "5.5",
    model_hash: "abc",
    raw_metadata: "a lighthouse\nSteps: 20, Sampler: Euler a, Schedule type: Exponential, CFG scale: 5.5, Seed: 100",
    ...over,
});

let mock: TauriMock;
let sendResult: (call: number) => unknown;

function setup(winnerDetails: ImageRecord | null, handlers: { fail?: (call: number) => boolean } = {}) {
    mock = installTauriMock({
        forge_send_to_image: () => {
            const call = mock.count("forge_send_to_image");
            if (handlers.fail?.(call)) throw new Error("Forge unreachable");
            return sendResult(call);
        },
    });
    const onQueued = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    render(
        <MutationPopover
            winner={winner}
            winnerDetails={winnerDetails}
            baseUrl="http://127.0.0.1:7860"
            apiKey={null}
            onClose={onClose}
            onQueued={onQueued}
            onError={onError}
        />
    );
    return { onQueued, onError, onClose };
}

const tick = (id: string) => fireEvent.click(screen.getByTestId(id));
const sent = () =>
    mock.argsOf("forge_send_to_image").map((a) => {
        const req = a.request as { imageId: number; options: { overrides: Record<string, unknown>; mutationOps: unknown } };
        return { imageId: req.imageId, overrides: req.options.overrides, ops: req.options.mutationOps };
    });

beforeEach(() => {
    sendResult = () => ({ ok: true, message: "ok", output_dir: "/out", generated_count: 1, saved_paths: [], children: [] });
});

describe("MutationPopover sweep", () => {
    it("sends only the fields each variant changed, never the scheduler or guessed defaults", async () => {
        const { onQueued } = setup(details());
        tick("checkbox-seed-1");
        tick("checkbox-seed-2");
        tick("checkbox-cfg-plus-1");
        expect(screen.getByTestId("sweep-count-badge").textContent).toContain("2 variants");
        fireEvent.click(screen.getByTestId("sweep-send-btn"));
        await waitFor(() => expect(onQueued).toHaveBeenCalled());

        const calls = sent();
        expect(calls).toHaveLength(2);
        expect(calls[0]).toEqual({
            imageId: 42,
            overrides: { seed: "101", cfg_scale: "6.5" },
            ops: [
                { kind: "seed_step", value: 1 },
                { kind: "cfg_delta", value: 1 },
            ],
        });
        expect(calls[1].overrides).toEqual({ seed: "102", cfg_scale: "6.5" });
        for (const c of calls) {
            for (const forbidden of ["scheduler", "sampler_name", "steps", "prompt", "negative_prompt"]) {
                expect(c.overrides).not.toHaveProperty(forbidden);
            }
        }
    });

    it("a sampler swap overrides only the sampler", async () => {
        const { onQueued } = setup(details());
        fireEvent.change(screen.getByTestId("select-sampler-swap"), { target: { value: "Euler" } });
        fireEvent.click(screen.getByTestId("sweep-send-btn"));
        await waitFor(() => expect(onQueued).toHaveBeenCalled());
        expect(sent().map((c) => c.overrides)).toEqual([{ sampler_name: "Euler" }]);
    });

    it("refuses a CFG delta when the winner has no CFG recorded, and sends nothing", async () => {
        const { onError, onQueued } = setup(details({ cfg_scale: null }));
        tick("checkbox-cfg-plus-1");
        fireEvent.click(screen.getByTestId("sweep-send-btn"));
        await waitFor(() => expect(onError).toHaveBeenCalled());
        expect(onError.mock.calls[0][0]).toMatch(/no CFG/);
        expect(mock.count("forge_send_to_image")).toBe(0);
        expect(onQueued).not.toHaveBeenCalled();
    });

    it("reports how many variants were already sent when a later one fails", async () => {
        const { onError } = setup(details(), { fail: (call) => call === 2 });
        tick("checkbox-seed-1");
        tick("checkbox-seed-2");
        fireEvent.click(screen.getByTestId("sweep-send-btn"));
        await waitFor(() => expect(onError).toHaveBeenCalled());
        const message = onError.mock.calls[0][0] as string;
        expect(message).toMatch(/Variant 2\/2 failed after 1 were sent/);
        expect(message).toMatch(/Forge unreachable/);
    });

    it("asks for confirmation above 8 variants and sends nothing until confirmed", async () => {
        const { onQueued } = setup(details());
        [1, 2, 3, 4].forEach((n) => tick(`checkbox-seed-${n}`));
        tick("checkbox-cfg-minus-1");
        tick("checkbox-cfg-plus-1");
        tick("checkbox-steps-minus-5");
        tick("checkbox-steps-plus-5");
        expect(screen.getByTestId("sweep-count-badge").textContent).toContain("16 variants");
        fireEvent.click(screen.getByTestId("sweep-send-btn"));
        expect(screen.getByTestId("sweep-confirm-dialog")).toBeTruthy();
        expect(mock.count("forge_send_to_image")).toBe(0);

        fireEvent.click(screen.getByTestId("sweep-confirm-cancel-btn"));
        expect(mock.count("forge_send_to_image")).toBe(0);

        fireEvent.click(screen.getByTestId("sweep-send-btn"));
        fireEvent.click(screen.getByTestId("sweep-confirm-proceed-btn"));
        await waitFor(() => expect(onQueued).toHaveBeenCalled(), { timeout: 4000 });
        expect(mock.count("forge_send_to_image")).toBe(16);
    });

    it("disables the seed step for a random (-1) seed", () => {
        setup(details({ seed: "-1" }));
        const seed1 = screen.getByTestId("checkbox-seed-1") as HTMLInputElement;
        expect(seed1.disabled).toBe(true);
    });
});
