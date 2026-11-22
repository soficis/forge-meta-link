import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { RecipeClipboardPanel } from "../RecipeClipboardPanel";
import { buildWinnerRecipe, countRecipeFields } from "../../utils/recipeWinner";
import { CompareLab } from "../CompareLab";
import { useCompareLabStore } from "../../store/compareLabStore";
import {
    encodeRecipeBundle,
    encodeRecipe,
    decodeRecipe,
    decodeRecipeBundle,
} from "../../utils/recipeClipboard";
import type { GalleryImageRecord, ImageRecord } from "../../types/metadata";

function gallery(id: number): GalleryImageRecord {
    return {
        id,
        filepath: `/tmp/${id}.png`,
        filename: `${id}.png`,
        directory: "/tmp",
        seed: "12345",
        width: 1024,
        height: 768,
        model_name: "flux2-dev.safetensors",
        is_favorite: false,
        is_locked: false,
        file_mtime: null,
    };
}

// The backend detail carries generation_type even though the legacy TS ImageRecord omits it.
function detail(id: number): ImageRecord & { generation_type: string } {
    return {
        ...gallery(id),
        prompt: "a lighthouse, <lora:DetailTuner:[0.8@t1, 0.6@t2]>",
        negative_prompt: "blurry",
        steps: "20",
        sampler: "e_uler",
        cfg_scale: "7.0",
        schedule_type: "Karras",
        generation_type: "txt2img",
        extra_params: {},
        text_chunks: {
            parameters: "Steps: 20, Sampler: e_uler, Schedule type: Karras",
            workflow: '{\n  "nodes": [{ "id": 1, "type": "KSampler" }]\n}',
            invokeai_metadata: "Généré par InvokeAI — café ☕",
        },
        model_hash: "a1b2c3d4",
        raw_metadata:
            "Steps: 20, Sampler: e_uler, Schedule type: Karras, <lora:DetailTuner:[0.8@t1, 0.6@t2]>",
    };
}

const writeText = vi.fn();
const readText = vi.fn();
const invoke = vi.fn();

beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    readText.mockReset();
    invoke.mockReset().mockResolvedValue(null);

    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText, readText },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        value: {
            convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
            invoke,
            transformCallback: () => 0,
        },
    });
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
        configurable: true,
        value: { unregisterListener: () => {} },
    });
    useCompareLabStore.getState().clear();
});

afterAll(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
});

function statusText(): string {
    return screen.getByTestId("recipe-clipboard-status").textContent ?? "";
}

describe("RecipeClipboardPanel — loading guard", () => {
    it("disables Copy recipe and shows a visible Details still loading label", () => {
        render(<RecipeClipboardPanel winner={gallery(1)} />);

        expect((screen.getByTestId("recipe-copy-btn") as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId("recipe-details-loading").textContent).toBe("Details still loading");
        // Paste does not depend on the winner detail and stays available.
        expect((screen.getByTestId("recipe-paste-btn") as HTMLButtonElement).disabled).toBe(false);
    });

    it("enables Copy once the resolved detail arrives in CompareLab", async () => {
        const resolvers = new Map<number, (value: ImageRecord) => void>();
        invoke.mockImplementation((command: string, args?: { id?: number }) => {
            if (command === "get_image_detail" && typeof args?.id === "number") {
                return new Promise<ImageRecord>((resolve) => {
                    resolvers.set(args.id!, resolve);
                });
            }
            return Promise.resolve(null);
        });
        useCompareLabStore.setState({ pins: [gallery(1), gallery(2)], winnerId: 1 });
        render(<CompareLab />);

        expect(screen.getByTestId("winner-recipe-panel")).not.toBeNull();
        expect((screen.getByTestId("recipe-copy-btn") as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText("Details still loading")).not.toBeNull();

        await act(async () => {
            for (const [id, resolve] of resolvers) resolve(detail(id));
        });
        await waitFor(() =>
            expect((screen.getByTestId("recipe-copy-btn") as HTMLButtonElement).disabled).toBe(false),
        );
    });
});

describe("RecipeClipboardPanel — copy path", () => {
    it("copies the full bundle with LoRA timing, reports the field count, and makes no invoke calls", async () => {
        const winner = gallery(1);
        const resolved = detail(1);
        render(<RecipeClipboardPanel winner={winner} winnerDetails={resolved} pins={[winner]} />);

        fireEvent.click(screen.getByTestId("recipe-copy-btn"));

        await waitFor(() => expect(statusText()).toMatch(/^Copied \d+ fields$/));
        const expected = countRecipeFields(buildWinnerRecipe(winner, resolved, [winner]));
        expect(statusText()).toBe(`Copied ${expected} fields`);
        expect(writeText).toHaveBeenCalledTimes(1);

        const payload = String(writeText.mock.calls[0][0]);
        expect(payload).toContain("forgemetalink.recipe-bundle");
        expect(payload).toContain("0.8@t1");
        expect(payload).toContain("0.6@t2");
        // The copied bundle must carry every PNG text chunk from the winner detail.
        const copied = decodeRecipeBundle(payload)[0];
        expect(copied.text_chunks).toEqual(resolved.text_chunks);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("surfaces an unsupported clipboard in the status line without a raw Error: prefix", async () => {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: undefined,
        });
        render(<RecipeClipboardPanel winner={gallery(1)} winnerDetails={detail(1)} />);

        fireEvent.click(screen.getByTestId("recipe-copy-btn"));

        await waitFor(() => expect(statusText()).toMatch(/Clipboard write is unavailable/));
        expect(statusText()).toContain("Copy failed:");
        expect(statusText()).not.toContain("Error:");
    });
});

describe("RecipeClipboardPanel — winner recipe round-trip", () => {
    it("carries the winner's scheduler, generation type, extra params and LoRA timing through buildWinnerRecipe", () => {
        const winner = gallery(9);
        const resolved = detail(9);
        resolved.extra_params = { "Clip skip": "2", "My custom key": "value" };
        const recipe = buildWinnerRecipe(winner, resolved, [winner]);

        expect(recipe.scheduler).toBe(resolved.schedule_type);
        expect(recipe.scheduler).toBe("Karras");
        expect(recipe.generation_type).toBe(resolved.generation_type);
        expect(recipe.generation_type).toBe("txt2img");
        expect(recipe.extra_params).toEqual(resolved.extra_params);
        expect(recipe.text_chunks).toEqual(resolved.text_chunks);

        const timed = recipe.loras.find((lora) => lora.name === "DetailTuner");
        expect(timed).toBeDefined();
        expect(timed?.tokens).toBe("[0.8@t1, 0.6@t2]");
        expect(recipe.loras.map((lora) => `${lora.weight}@${lora.timing}`)).toEqual([
            "0.8@t1",
            "0.6@t2",
        ]);

        // Bundle copy/paste must preserve all of it too.
        const decoded = decodeRecipe(encodeRecipe(recipe));
        expect(decoded.scheduler).toBe(resolved.schedule_type);
        expect(decoded.generation_type).toBe(resolved.generation_type);
        expect(decoded.extra_params).toEqual(resolved.extra_params);
        expect(decoded.text_chunks).toEqual(resolved.text_chunks);
        expect(decoded.loras).toEqual(recipe.loras);
    });
});

describe("RecipeClipboardPanel — paste path", () => {
    it("shows a validation message for malformed pasted JSON", async () => {
        readText.mockResolvedValue("{not json");
        render(<RecipeClipboardPanel winner={gallery(1)} />);

        fireEvent.click(screen.getByTestId("recipe-paste-btn"));

        await waitFor(() => expect(statusText()).toMatch(/^Invalid recipe:/));
        expect(statusText()).toMatch(/invalid JSON/);
        expect(statusText()).not.toContain("Error:");
    });

    it("names the invalid field for a well-formed payload with the wrong format", async () => {
        readText.mockResolvedValue(JSON.stringify({ format: "wrong", version: 1 }));
        render(<RecipeClipboardPanel winner={gallery(1)} />);

        fireEvent.click(screen.getByTestId("recipe-paste-btn"));

        await waitFor(() => expect(statusText()).toContain('"format"'));
        expect(statusText()).toMatch(/^Invalid recipe:/);
    });

    it("shows a field-count summary and stages the recipe without faking a pinned slot or a send", async () => {
        const winner = gallery(1);
        const recipe = buildWinnerRecipe(winner, detail(1), [winner]);
        readText.mockResolvedValue(encodeRecipeBundle([recipe]));
        const onPinPastedRecipe = vi.fn().mockReturnValue(false);
        render(<RecipeClipboardPanel winner={winner} onPinPastedRecipe={onPinPastedRecipe} />);

        fireEvent.click(screen.getByTestId("recipe-paste-btn"));

        await waitFor(() => expect(statusText()).toContain("Pasted recipe for"));
        const count = countRecipeFields(recipe);
        expect(statusText()).toContain(`${count} fields validated`);
        expect(statusText()).toContain("no pinned slot created");
        expect(statusText()).toContain("Manual entry needed:");
        expect(screen.getByTestId("recipe-field-count").textContent).toBe(`${count} fields validated`);
        expect(onPinPastedRecipe).toHaveBeenCalledTimes(1);
        expect(invoke).not.toHaveBeenCalled();
    });
});
