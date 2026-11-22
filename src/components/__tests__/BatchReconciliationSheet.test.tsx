import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { installTauriMock, type Handlers, type TauriMock } from "../../test/tauriMock";
import { BatchReconciliationSheet, type BatchReconciliationSheetProps } from "../BatchReconciliationSheet";
import type { ForgeSendResult, ImageRecord } from "../../types/metadata";

const detail = (id: number, seed: string, lora: string): ImageRecord => ({
    id,
    filepath: `/lib/${id}.png`,
    filename: `${id}.png`,
    directory: "/lib",
    seed,
    width: 512,
    height: 768,
    model_name: `model-${id}.safetensors`,
    is_favorite: false,
    is_locked: false,
    file_mtime: null,
    prompt: `portrait ${lora}`,
    negative_prompt: "blurry",
    steps: String(10 + id),
    sampler: id === 1 ? "Euler a" : "DPM++ 2M",
    schedule_type: id === 2 ? "Karras" : null,
    extra_params:
        id === 3 ? { "Forge additional modules": "models/LoRA/extra.safetensors" } : {},
    text_chunks: null,
    cfg_scale: id === 1 ? "5.5" : "7",
    model_hash: "hash",
    raw_metadata: "",
});

const DETAILS: Record<number, ImageRecord> = {
    1: detail(1, "111", "<lora:style_a:0.6>"),
    2: detail(2, "222", "<lora:style_b:0.7> [0.4@detail_tweaker]"),
    3: detail(3, "333", "<lora:style_c:0.8>"),
};

const sendOk = (): ForgeSendResult => ({
    ok: true,
    message: "Saved 1 generated image to out",
    output_dir: "out",
    generated_count: 1,
    saved_paths: [],
    children: [],
});

function handlers(extra: Handlers = {}): Handlers {
    return {
        get_image_detail: ({ id }) => DETAILS[id as number] ?? null,
        forge_send_to_image: () => sendOk(),
        ...extra,
    };
}

function sheetProps(
    overrides: Partial<BatchReconciliationSheetProps> = {}
): BatchReconciliationSheetProps {
    return {
        imageIds: [1, 2, 3],
        baseUrl: "http://127.0.0.1:7860",
        apiKey: "",
        outputDir: null,
        includeSeed: false,
        adetailerEnabled: false,
        adetailerModel: null,
        loraWeight: null,
        saveForgeCopy: false,
        onQueued: vi.fn(),
        onError: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
}

async function renderSheet(props: BatchReconciliationSheetProps) {
    render(<BatchReconciliationSheet {...props} />);
    const dialog = await screen.findByRole("dialog", { name: "Review Forge batch send" });
    await within(dialog).findByTestId("batch-reconciliation-row-3");
    return dialog;
}

function sendOptions(mock: TauriMock): Array<Record<string, unknown>> {
    return mock.argsOf("forge_send_to_image").map(
        (args) => (args.request as { options: Record<string, unknown> }).options
    );
}

function rowOverrides(options: Record<string, unknown>): Record<string, unknown> {
    return (options.overrides ?? {}) as Record<string, unknown>;
}

describe("BatchReconciliationSheet", () => {
    it("shows one preview row per image with its own seed, LoRAs, modules and 'not recorded'", async () => {
        const mock = installTauriMock(handlers());
        const dialog = await renderSheet(sheetProps());

        for (const id of [1, 2, 3]) {
            expect(within(dialog).getByTestId(`batch-reconciliation-row-${id}`)).toBeTruthy();
        }
        expect(within(dialog).getByTestId("row-seed-1").textContent).toBe("111");
        expect(within(dialog).getByTestId("row-loras-1").textContent).toContain("<lora:style_a:0.6>");
        expect(within(dialog).getByTestId("row-loras-2").textContent).toContain(
            "[0.4@detail_tweaker]"
        );
        expect(within(dialog).getByTestId("row-modules-3").textContent).toContain(
            "models/LoRA/extra.safetensors"
        );
        expect(within(dialog).getByTestId("row-scheduler-1").textContent).toBe("not recorded");
        expect(mock.count("get_image_detail")).toBe(3);
    });

    it("sends one single-image invoke per id with distinct stored overrides and toolbar LoRAs", async () => {
        const mock = installTauriMock(handlers());
        const onQueued = vi.fn();
        const props = sheetProps({
            loraTokens: ["toolbar_a", "toolbar_b"],
            loraWeight: 0.7,
            loraWeights: { toolbar_b: 0.4 },
            onQueued,
        });
        const dialog = await renderSheet(props);

        fireEvent.click(within(dialog).getByRole("button", { name: "Send 3 images" }));
        await waitFor(() => expect(mock.count("forge_send_to_image")).toBe(3));
        expect(mock.count("forge_send_to_images")).toBe(0);

        const options = sendOptions(mock);
        expect(options.map((entry) => rowOverrides(entry).seed)).toEqual(["111", "222", "333"]);
        expect(options.map((entry) => entry.loraTokens)).toEqual([
            ["toolbar_a", "toolbar_b"],
            ["toolbar_a", "toolbar_b"],
            ["toolbar_a", "toolbar_b"],
        ]);
        expect(options.every((entry) => entry.loraWeight === 0.7)).toBe(true);
        expect(options.map((entry) => entry.loraWeights)).toEqual([
            { toolbar_b: 0.4 },
            { toolbar_b: 0.4 },
            { toolbar_b: 0.4 },
        ]);
        expect(onQueued).toHaveBeenCalledTimes(1);
        const aggregate = onQueued.mock.calls[0][1] as ForgeSendResult;
        expect(aggregate.generated_count).toBe(3);
        expect(aggregate.ok).toBe(true);
    });

    it("applies the toolbar's -1 seed override in shared mode", async () => {
        const mock = installTauriMock(handlers());
        const onQueued = vi.fn();
        const props = sheetProps({
            includeSeed: true,
            overrides: { seed: "-1", steps: "99" },
            loraTokens: ["shared_lora"],
            onQueued,
        });
        const dialog = await renderSheet(props);

        fireEvent.click(within(dialog).getByRole("radio", { name: "Apply shared overrides" }));
        fireEvent.click(within(dialog).getByRole("button", { name: "Send 3 images" }));
        await waitFor(() => expect(mock.count("forge_send_to_image")).toBe(3));

        const options = sendOptions(mock);
        expect(options.map((entry) => rowOverrides(entry).seed)).toEqual(["-1", "-1", "-1"]);
        expect(options.map((entry) => rowOverrides(entry).steps)).toEqual(["99", "99", "99"]);
        expect(options.map((entry) => entry.loraTokens)).toEqual([
            ["shared_lora"],
            ["shared_lora"],
            ["shared_lora"],
        ]);
        expect(onQueued).toHaveBeenCalledTimes(1);
    });

    it("uses -1 in stored mode when includeSeed is true", async () => {
        const mock = installTauriMock(handlers());
        const dialog = await renderSheet(sheetProps({ includeSeed: true }));

        fireEvent.click(within(dialog).getByRole("button", { name: "Send 3 images" }));
        await waitFor(() => expect(mock.count("forge_send_to_image")).toBe(3));
        expect(sendOptions(mock).map((entry) => rowOverrides(entry).seed)).toEqual([
            "-1",
            "-1",
            "-1",
        ]);
    });

    it("honors a per-row includeSeed opt-out", async () => {
        const mock = installTauriMock(handlers());
        const dialog = await renderSheet(sheetProps());

        fireEvent.click(
            within(dialog).getByLabelText("Include stored seed for image 2")
        );
        fireEvent.click(within(dialog).getByRole("button", { name: "Send 3 images" }));
        await waitFor(() => expect(mock.count("forge_send_to_image")).toBe(3));

        const options = sendOptions(mock);
        expect(options[1].includeSeed).toBe(false);
        expect(rowOverrides(options[1]).seed).toBeUndefined();
        expect(options[0].includeSeed).toBe(true);
    });

    it("reports a row whose detail could not be loaded", async () => {
        const mock = installTauriMock(
            handlers({
                get_image_detail: ({ id }) => {
                    if (id === 2) throw new Error("db busy");
                    return DETAILS[id as number];
                },
            })
        );
        const onError = vi.fn();
        const dialog = await renderSheet(sheetProps({ onError }));

        const rowError = await within(dialog).findByTestId("row-error-2");
        expect(rowError.textContent).toContain("db busy");

        fireEvent.click(within(dialog).getByRole("button", { name: "Send 3 images" }));
        await waitFor(() => expect(mock.count("forge_send_to_image")).toBe(2));
        await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
        expect(onError.mock.calls[0][0] as string).toContain("db busy");
    });

    it("focuses the first control, closes on Escape and restores focus to the opener", async () => {
        installTauriMock(handlers());
        const onClose = vi.fn();

        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setOpen(true)}>
                        Open review
                    </button>
                    {open ? (
                        <BatchReconciliationSheet
                            {...sheetProps({
                                onClose: () => {
                                    setOpen(false);
                                    onClose();
                                },
                            })}
                        />
                    ) : null}
                </>
            );
        }

        render(<Harness />);
        const opener = screen.getByRole("button", { name: "Open review" });
        opener.focus();
        fireEvent.click(opener);

        const dialog = await screen.findByRole("dialog", { name: "Review Forge batch send" });
        expect(document.activeElement).toBe(
            within(dialog).getByRole("radio", { name: "Use each image's stored params" })
        );

        fireEvent.keyDown(dialog, { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(opener);
    });
});
