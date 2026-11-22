import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { installTauriMock, type Handlers } from "../../test/tauriMock";
import type { AssetReport, AssetStatus } from "../../types/assets";
import { MissingAssetsPanel } from "../MissingAssetsPanel";

const asset = (
    name: string,
    found: boolean,
    pathHint: string | null,
    referencingImageCount: number
): AssetStatus => ({
    name,
    found,
    path_hint: pathHint,
    referencing_image_count: referencingImageCount,
});

const reportWithMissing: AssetReport = {
    models: [
        asset("model-a.safetensors", false, null, 7),
        asset("model-b.safetensors", false, "C:\\models\\model-b.safetensors", 5),
        asset("model-found.safetensors", true, "C:\\models\\model-found.safetensors", 2),
    ],
    loras: [
        asset("style_a", false, null, 4),
        asset("style_b", false, "C:\\models\\Lora\\style_b.safetensors", 6),
        asset("style_found", true, "C:\\models\\Lora\\style_found.safetensors", 1),
    ],
    total_referenced_models: 3,
    total_referenced_loras: 3,
};

const allFoundReport: AssetReport = {
    models: [asset("model-found.safetensors", true, "C:\\models\\model-found.safetensors", 2)],
    loras: [asset("style_found", true, "C:\\models\\Lora\\style_found.safetensors", 1)],
    total_referenced_models: 1,
    total_referenced_loras: 1,
};

const MODELS_DIR = "C:\\Forge\\models";
const LORAS_DIR = "C:\\Forge\\models\\Lora";

const forgeOptions = {
    models: [],
    loras: [],
    samplers: [],
    schedulers: [],
    models_scan_dir: MODELS_DIR as string | null,
    loras_scan_dir: LORAS_DIR as string | null,
    warnings: [],
};

function handlers(extra: Handlers = {}): Handlers {
    return {
        forge_get_options: () => forgeOptions,
        detect_missing_assets: () => allFoundReport,
        ...extra,
    };
}

const baseUrl = "http://127.0.0.1:7860";

describe("MissingAssetsPanel", () => {
    it("renders only missing rows and the missing-of-total counts via the mock IPC", async () => {
        const mock = installTauriMock(
            handlers({ detect_missing_assets: () => reportWithMissing })
        );

        render(
            <MissingAssetsPanel
                onClose={vi.fn()}
                forgeBaseUrl={baseUrl}
                forgeApiKey="secret"
            />
        );
        const dialog = await screen.findByRole("dialog", { name: "Missing assets" });

        expect(mock.count("forge_get_options")).toBe(1);
        expect(mock.argsOf("forge_get_options")[0]).toMatchObject({
            baseUrl,
            apiKey: "secret",
        });
        expect(mock.count("detect_missing_assets")).toBe(1);
        expect(mock.argsOf("detect_missing_assets")).toEqual([
            { dirs: [], modelsDir: MODELS_DIR, lorasDir: LORAS_DIR },
        ]);
        expect(within(dialog).getByText("missing 2 of 3 models")).toBeTruthy();
        expect(within(dialog).getByText("missing 2 of 3 loras")).toBeTruthy();

        const models = within(dialog).getByTestId("missing-assets-models");
        expect(within(models).getByText("Missing models")).toBeTruthy();
        expect(within(models).getByText("model-a.safetensors")).toBeTruthy();
        expect(within(models).getByText("no path hint")).toBeTruthy();
        expect(within(models).getByText("7")).toBeTruthy();
        expect(within(models).getByText("model-b.safetensors")).toBeTruthy();
        expect(within(models).getByText("C:\\models\\model-b.safetensors")).toBeTruthy();
        expect(within(models).getByText("5")).toBeTruthy();
        expect(within(models).queryByText("model-found.safetensors")).toBeNull();

        const loras = within(dialog).getByTestId("missing-assets-loras");
        expect(within(loras).getByText("Missing LoRAs")).toBeTruthy();
        expect(within(loras).getByText("style_a")).toBeTruthy();
        expect(within(loras).getByText("4")).toBeTruthy();
        expect(within(loras).getByText("style_b")).toBeTruthy();
        expect(within(loras).getByText("C:\\models\\Lora\\style_b.safetensors")).toBeTruthy();
        expect(within(loras).getByText("6")).toBeTruthy();
        expect(within(loras).queryByText("style_found")).toBeNull();
    });

    it("shows an honest inline error and never calls the detector when Forge reports no scan dirs", async () => {
        const mock = installTauriMock(
            handlers({
                forge_get_options: () => ({ ...forgeOptions, models_scan_dir: null }),
            })
        );

        render(<MissingAssetsPanel onClose={vi.fn()} forgeBaseUrl={baseUrl} />);
        const dialog = await screen.findByRole("dialog", { name: "Missing assets" });
        const error = await within(dialog).findByTestId("missing-assets-error");

        expect(
            within(error).getByText("Forge did not report a models/LoRA scan directory")
        ).toBeTruthy();
        expect(mock.count("detect_missing_assets")).toBe(0);
    });

    it("shows the all-found state when every referenced asset has found = true", async () => {
        installTauriMock(handlers());

        render(<MissingAssetsPanel onClose={vi.fn()} forgeBaseUrl={baseUrl} />);
        const dialog = await screen.findByRole("dialog", { name: "Missing assets" });

        expect(within(dialog).getByText("missing 0 of 1 models")).toBeTruthy();
        expect(within(dialog).getByText("missing 0 of 1 loras")).toBeTruthy();
        expect(
            await within(dialog).findByText("Every referenced model and LoRA was found.")
        ).toBeTruthy();
        expect(within(dialog).queryByTestId("missing-assets-models")).toBeNull();
        expect(within(dialog).queryByTestId("missing-assets-loras")).toBeNull();
    });

    it("shows a friendly inline error with Retry, then reloads successfully", async () => {
        let attempts = 0;
        const mock = installTauriMock(
            handlers({
                detect_missing_assets: () => {
                    attempts += 1;
                    if (attempts === 1) {
                        throw new Error("backend offline");
                    }
                    return allFoundReport;
                },
            })
        );

        render(<MissingAssetsPanel onClose={vi.fn()} forgeBaseUrl={baseUrl} />);
        const dialog = await screen.findByRole("dialog", { name: "Missing assets" });
        const error = await within(dialog).findByTestId("missing-assets-error");

        expect(error.getAttribute("role")).toBe("alert");
        expect(error.getAttribute("aria-live")).toBe("assertive");
        expect(within(error).getByText(/could not be completed/)).toBeTruthy();
        expect(dialog.textContent ?? "").not.toContain("Error:");
        expect(mock.count("detect_missing_assets")).toBe(1);

        fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(mock.count("detect_missing_assets")).toBe(2));
        expect(
            await within(dialog).findByText("Every referenced model and LoRA was found.")
        ).toBeTruthy();
        expect(within(dialog).queryByTestId("missing-assets-error")).toBeNull();
    });

    it("announces loading with aria-live while detection is pending", async () => {
        let resolvePending: (value: AssetReport) => void = () => {};
        const pending = new Promise<AssetReport>((resolve) => {
            resolvePending = resolve;
        });
        installTauriMock(handlers({ detect_missing_assets: () => pending }));

        render(<MissingAssetsPanel onClose={vi.fn()} forgeBaseUrl={baseUrl} />);
        const loading = await screen.findByTestId("missing-assets-loading");
        expect(loading.getAttribute("role")).toBe("status");
        expect(loading.getAttribute("aria-live")).toBe("polite");
        expect(within(loading).getByText(/Checking referenced models and LoRAs/)).toBeTruthy();

        await act(async () => {
            resolvePending(allFoundReport);
        });
        await waitFor(() => expect(screen.queryByTestId("missing-assets-loading")).toBeNull());
    });

    it("focuses the close button on open and closes on Escape", async () => {
        const onClose = vi.fn();
        installTauriMock(handlers());

        render(<MissingAssetsPanel onClose={onClose} forgeBaseUrl={baseUrl} />);
        const dialog = await screen.findByRole("dialog", { name: "Missing assets" });
        const closeButton = within(dialog).getByRole("button", { name: "Close missing assets" });

        expect(document.activeElement).toBe(closeButton);
        fireEvent.keyDown(dialog, { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
