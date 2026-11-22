import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MutationPopover } from "../MutationPopover";
import { installTauriMock, type TauriMock } from "../../test/tauriMock";
import type { GalleryImageRecord, ImageRecord, ForgeSendResult } from "../../types/metadata";

const STORAGE_KEY = "fml.mutationSweep.selection";

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
    schedule_type: "Exponential",
    extra_params: {},
    text_chunks: null,
    model_hash: "abc",
    raw_metadata: "a lighthouse\nSteps: 20, Sampler: Euler a, Schedule type: Exponential, CFG scale: 5.5, Seed: 100",
    ...over,
});

const sendOk: ForgeSendResult = {
    ok: true,
    message: "ok",
    output_dir: "/out",
    generated_count: 1,
    saved_paths: [],
    children: [],
};

let mock: TauriMock;

function renderPopover(
    winnerDetails: ImageRecord | null | undefined,
    sendImpl?: (call: number) => unknown
) {
    mock = installTauriMock({
        forge_send_to_image: () => sendImpl?.(mock.count("forge_send_to_image")) ?? sendOk,
    });
    const onQueued = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const view = render(
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
    return { onQueued, onError, onClose, ...view };
}

const tick = (id: string) => fireEvent.click(screen.getByTestId(id));
const sendBtn = () => screen.getByTestId("sweep-send-btn") as HTMLButtonElement;
const sentOps = () =>
    mock.argsOf("forge_send_to_image").map((a) => {
        const req = a.request as { options: { mutationOps: unknown } };
        return req.options.mutationOps;
    });
const sentOverrides = () =>
    mock.argsOf("forge_send_to_image").map((a) => {
        const req = a.request as { options: { overrides: Record<string, string> } };
        return req.options.overrides;
    });

beforeEach(() => {
    localStorage.clear();
});

describe("MutationPopover correctness", () => {
    it("does not fabricate CFG/steps when details are unavailable; Send is blocked with a visible banner", () => {
        const { onQueued } = renderPopover(undefined);

        expect(screen.getByTestId("sweep-details-unavailable").textContent).toMatch(/Winner details are still loading/);
        expect(sendBtn().disabled).toBe(true);

        // Without a detail record there is no CFG to mutate. A fabricated "7.0" would have
        // produced a preview row instead of this error.
        tick("checkbox-cfg-plus-1");
        expect(screen.getByText(/no CFG scale recorded/)).toBeTruthy();
        expect(onQueued).not.toHaveBeenCalled();
        expect(mock.count("forge_send_to_image")).toBe(0);
    });

    it("calls onQueued for the variants that succeeded before a later one fails, while still reporting the error", async () => {
        const { onQueued, onError } = renderPopover(details(), (call) => {
            if (call === 2) throw new Error("Forge down");
            return sendOk;
        });

        tick("checkbox-seed-1");
        tick("checkbox-seed-2");
        fireEvent.click(sendBtn());

        await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
        expect(onError.mock.calls[0][0]).toMatch(/Variant 2\/2 failed after 1 were sent/);
        expect(onError.mock.calls[0][0]).toMatch(/Forge down/);
        expect(screen.getByTestId("sweep-error-message")).toBeTruthy();
        expect(onQueued).toHaveBeenCalledTimes(1);
        expect(onQueued.mock.calls[0][0]).toHaveLength(1);
    });

    it("after Stop, a second Send queues only the variants that were not already sent", async () => {
        let releaseFirst: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const { onQueued } = renderPopover(details(), async (call) => {
            if (call === 1) await gate;
            return sendOk;
        });

        tick("checkbox-seed-1");
        tick("checkbox-seed-2");
        fireEvent.click(sendBtn());

        await screen.findByTestId("sweep-stop-btn");
        tick("sweep-stop-btn");
        releaseFirst();

        await waitFor(() => expect(screen.getByText(/Stopped after 1 of 2/)).toBeTruthy());
        expect(mock.count("forge_send_to_image")).toBe(1);
        expect(onQueued).toHaveBeenCalledTimes(1);
        expect(sentOps()).toEqual([[{ kind: "seed_step", value: 1 }]]);
        expect(screen.getByTestId("sweep-overlap-hint").textContent).toMatch(/1 of these were already queued/);

        // Re-enabling Send must top up the sweep, not re-queue seed+1.
        fireEvent.click(sendBtn());
        await waitFor(() => expect(mock.count("forge_send_to_image")).toBe(2));
        expect(sentOps()).toEqual([
            [{ kind: "seed_step", value: 1 }],
            [{ kind: "seed_step", value: 2 }],
        ]);
        expect(onQueued).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId("sweep-all-queued-hint")).toBeTruthy();
    });

    it("Escape in the >8 confirm dismisses only the confirm and restores focus to Send", () => {
        const { onClose, onQueued } = renderPopover(details());
        [1, 2, 3, 4].forEach((n) => tick(`checkbox-seed-${n}`));
        ["minus-1", "minus-0-5", "plus-0-5", "plus-1"].forEach((id) => tick(`checkbox-cfg-${id}`));
        expect(screen.getByTestId("sweep-count-badge").textContent).toContain("16 variants");

        fireEvent.click(sendBtn());
        const dialog = screen.getByRole("dialog");
        expect(screen.getByTestId("sweep-confirm-dialog")).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByTestId("sweep-confirm-proceed-btn"));

        fireEvent.keyDown(dialog, { key: "Escape" });

        expect(screen.queryByTestId("sweep-confirm-dialog")).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        expect(onQueued).not.toHaveBeenCalled();
        expect(mock.count("forge_send_to_image")).toBe(0);
        expect(document.activeElement).toBe(sendBtn());
        expect(screen.getByTestId("sweep-count-badge").textContent).toContain("16 variants");
    });

    it("persists the last-used selection and re-applies it on mount so Send is usable on open", () => {
        const first = renderPopover(details());
        // One seed step x one CFG delta is ONE variant; two seed steps make two.
        tick("checkbox-seed-1");
        tick("checkbox-seed-2");
        tick("checkbox-cfg-plus-1");
        expect(screen.getByTestId("sweep-count-badge").textContent).toContain("2 variants");
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({
            seedSteps: [1, 2],
            cfgDeltas: [1],
        });
        first.unmount();

        renderPopover(details());
        expect(screen.getByTestId("sweep-count-badge").textContent).toContain("2 variants");
        expect((screen.getByTestId("checkbox-seed-1") as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId("checkbox-seed-2") as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId("checkbox-cfg-plus-1") as HTMLInputElement).checked).toBe(true);
        expect(sendBtn().disabled).toBe(false);
    });

    it("shows a visible 'Select at least one operator' hint beside a disabled Send when nothing is selected", () => {
        renderPopover(details());
        expect(screen.getByTestId("sweep-empty-hint").textContent).toBe("Select at least one operator");
        expect(sendBtn().disabled).toBe(true);
    });

    it("tolerates a corrupt persisted selection", () => {
        localStorage.setItem(STORAGE_KEY, "{not json");
        renderPopover(details());
        expect(screen.getByTestId("sweep-empty-hint")).toBeTruthy();
        expect(sendBtn().disabled).toBe(true);
    });

    it("keeps Send disabled when the detail record has no steps and no CFG scale", () => {
        const { onQueued } = renderPopover(details({ steps: null, cfg_scale: null }));

        expect(screen.getByTestId("sweep-details-unavailable").textContent).toMatch(/Winner details are still loading/);
        expect(sendBtn().disabled).toBe(true);

        // Even with operators selected, no trustworthy CFG/steps means nothing may be sent.
        tick("checkbox-seed-1");
        tick("checkbox-cfg-plus-1");
        expect(sendBtn().disabled).toBe(true);
        expect(onQueued).not.toHaveBeenCalled();
        expect(mock.count("forge_send_to_image")).toBe(0);
    });

    it("ignores off-vocabulary sampler/scheduler values from a hand-edited persisted selection", () => {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                seedSteps: [],
                cfgDeltas: [],
                stepsDeltas: [],
                sampler: "Made Up Sampler",
                scheduler: "bogus_schedule",
            })
        );

        renderPopover(details());

        expect((screen.getByTestId("select-sampler-swap") as HTMLSelectElement).value).toBe("");
        expect((screen.getByTestId("select-scheduler-swap") as HTMLSelectElement).value).toBe("");
        expect(screen.getByTestId("sweep-empty-hint")).toBeTruthy();
        expect(sendBtn().disabled).toBe(true);
    });

    it("does not resurrect the already-sent recipe when the selection is widened with a CFG delta after Stop", async () => {
        let releaseFirst: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const { onQueued } = renderPopover(details(), async (call) => {
            if (call === 1) await gate;
            return sendOk;
        });

        tick("checkbox-seed-1");
        tick("checkbox-seed-2");
        fireEvent.click(sendBtn());

        await screen.findByTestId("sweep-stop-btn");
        tick("sweep-stop-btn");
        releaseFirst();

        await waitFor(() => expect(screen.getByText(/Stopped after 1 of 2/)).toBeTruthy());
        expect(sentOverrides()).toEqual([{ seed: "101" }]);

        // Adding CFG -0.5 changes every generated op shape. The exact recipe already sent
        // ({seed:"101"}) must not be queued again just because the ops now look different.
        tick("checkbox-cfg-minus-0-5");
        expect(screen.getByTestId("sweep-count-badge").textContent).toContain("2 variants");

        fireEvent.click(sendBtn());
        await waitFor(() => expect(mock.count("forge_send_to_image")).toBe(3));
        expect(sentOverrides().slice(1)).toEqual([
            { cfg_scale: "5", seed: "101" },
            { cfg_scale: "5", seed: "102" },
        ]);
        // The first (pre-widening) send is history; none of the NEW sends may repeat it.
        expect(sentOverrides().slice(1)).not.toContainEqual({ seed: "101" });
        expect(onQueued).toHaveBeenCalledTimes(2);
    });

    it("does not dedupe or count a variant whose send saved no images (ok:false)", async () => {
        const sendFail: ForgeSendResult = {
            ok: false,
            message: "Forge rejected the request",
            output_dir: "/out",
            generated_count: 0,
            saved_paths: [],
            children: [],
        };
        const { onQueued, onError, onClose } = renderPopover(details(), () => sendFail);

        tick("checkbox-seed-1");
        fireEvent.click(sendBtn());

        await waitFor(() =>
            expect(screen.getByTestId("sweep-status-message").textContent).toMatch(/1 variant failed/),
        );
        expect(onQueued).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        // The failed variant was not recorded as queued: no overlap hint and Send stays usable.
        expect(screen.queryByTestId("sweep-overlap-hint")).toBeNull();
        expect(sendBtn().disabled).toBe(false);

        // A second Send must retry the same variant rather than skipping a "sent" key.
        fireEvent.click(sendBtn());
        await waitFor(() => expect(mock.count("forge_send_to_image")).toBe(2));
        expect(sentOps()).toEqual([
            [{ kind: "seed_step", value: 1 }],
            [{ kind: "seed_step", value: 1 }],
        ]);
        expect(onQueued).not.toHaveBeenCalled();
    });

    it("dedupes by resolved recipe, not op shape, so changing a swap cannot re-queue a sent variant", async () => {
        let releaseFirst: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const { onQueued } = renderPopover(details(), async (call) => {
            if (call === 1) await gate;
            return sendOk;
        });

        tick("checkbox-seed-1");
        tick("checkbox-seed-2");
        fireEvent.change(screen.getByTestId("select-sampler-swap"), { target: { value: "Euler a" } });
        fireEvent.change(screen.getByTestId("select-scheduler-swap"), { target: { value: "karras" } });
        expect(screen.getByTestId("sweep-count-badge").textContent).toContain("2 variants");

        fireEvent.click(sendBtn());
        await screen.findByTestId("sweep-stop-btn");
        tick("sweep-stop-btn");
        releaseFirst();

        await waitFor(() => expect(screen.getByText(/Stopped after 1 of 2/)).toBeTruthy());
        expect(sentOverrides()).toEqual([{ scheduler: "karras", seed: "101" }]);
        expect(screen.getByTestId("sweep-overlap-hint").textContent).toMatch(/1 of these were already queued/);

        // "Euler a" equals the base sampler, so switching back to "keep current" produces a
        // different op shape but the identical recipe. The sent variant must stay deduped.
        fireEvent.change(screen.getByTestId("select-sampler-swap"), { target: { value: "" } });
        expect(screen.getByTestId("sweep-count-badge").textContent).toContain("2 variants");
        expect(screen.getByTestId("sweep-overlap-hint").textContent).toMatch(/1 of these were already queued/);

        fireEvent.click(sendBtn());
        await waitFor(() => expect(mock.count("forge_send_to_image")).toBe(2));
        expect(sentOverrides()).toEqual([
            { scheduler: "karras", seed: "101" },
            { scheduler: "karras", seed: "102" },
        ]);
        expect(onQueued).toHaveBeenCalledTimes(2);
    });
});
