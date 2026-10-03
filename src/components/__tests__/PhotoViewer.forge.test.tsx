import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { PhotoViewer } from "../PhotoViewer";
import { installTauriMock, type Handlers, type TauriMock } from "../../test/tauriMock";
import type { GalleryImageRecord, ImageRecord, LineageTrace, PromptEntry } from "../../types/metadata";

const gallery = (id: number, name: string): GalleryImageRecord => ({
    id,
    filepath: `/lib/${name}.png`,
    filename: `${name}.png`,
    directory: "/lib",
    seed: String(id * 111),
    width: 128,
    height: 128,
    model_name: "m.safetensors",
    is_favorite: false,
    is_locked: false,
    file_mtime: null,
});

const detail = (id: number, name: string, prompt: string): ImageRecord => ({
    ...gallery(id, name),
    prompt,
    negative_prompt: "blurry",
    steps: "4",
    sampler: id === 1 ? "Euler a" : "DPM++ 2M",
    cfg_scale: id === 1 ? "5.5" : "7.0",
    model_hash: "abc",
    raw_metadata: `${prompt}\nSteps: 4, Sampler: Euler a, Schedule type: Karras, CFG scale: 5.5, Seed: ${id * 111}`,
});

const IMAGES = [gallery(1, "lighthouse"), gallery(2, "forest")];
const DETAILS: Record<number, ImageRecord> = {
    1: detail(1, "lighthouse", "a lighthouse at dusk"),
    2: detail(2, "forest", "a misty forest"),
};

let mock: TauriMock;

function baseHandlers(extra: Handlers = {}): Handlers {
    return {
        get_image_detail: ({ id }) => DETAILS[id as number] ?? null,
        get_display_image_path: ({ filepath }) => filepath,
        get_thumbnail_paths: () => [],
        get_thumbnail_path: ({ filepath }) => filepath,
        get_lineage_cursor: () => ({ ancestors: [], children: [] }),
        get_lineage_trace: ({ imageId }) => ({ target_id: imageId, nodes: [] }),
        get_sidecar_data: () => ({ tags: [], notes: "" }),
        forge_get_options: () => ({
            models: [],
            loras: [],
            samplers: ["Euler a", "DPM++ 2M"],
            schedulers: ["karras", "simple", "bong_tangent"],
            warnings: ["LoRA directory not configured"],
        }),
        ...extra,
    };
}

function viewer(index: number) {
    return (
        <PhotoViewer
            images={IMAGES}
            currentIndex={index}
            onNavigate={vi.fn()}
            onClose={() => {}}
            forgeBaseUrl="http://127.0.0.1:7860"
            forgeApiKey=""
            forgeOutputDir=""
            forgeModelsPath=""
            forgeModelsScanSubfolders={false}
            forgeLoraPath=""
            forgeLoraScanSubfolders={false}
            onOpenForgeSettings={() => {}}
            forgeSelectedLoras={[]}
            onForgeSelectedLorasChange={() => {}}
            forgeLoraWeight="1.0"
            onForgeLoraWeightChange={() => {}}
            forgeIncludeSeed={true}
            forgeAdetailerFaceEnabled={false}
            forgeAdetailerFaceModel="face_yolov8n.pt"
            onSearchBySeed={() => {}}
            onDeleteCurrentImage={() => {}}
            isDeletingCurrentImage={false}
            onToggleFavorite={() => {}}
            onToggleLocked={() => {}}
            onShowToast={() => {}}
        />
    );
}

const promptBox = () => screen.getByPlaceholderText("Prompt") as HTMLTextAreaElement;
const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/**
 * Polls `read` until it has not changed for `quietMs`, then returns it. A loop that keeps
 * changing the value never settles and the helper throws, so no fixed sleep has to guess how
 * long "long enough" is on a slow machine.
 */
async function settled(read: () => number, quietMs = 500, timeoutMs = 5000): Promise<number> {
    const start = Date.now();
    let last = read();
    let since = Date.now();
    while (Date.now() - since < quietMs) {
        if (Date.now() - start > timeoutMs) throw new Error(`value never settled (still changing at ${read()})`);
        await sleep(25);
        const now = read();
        if (now !== last) {
            last = now;
            since = Date.now();
        }
    }
    return last;
}

beforeEach(() => {
    localStorage.clear();
});

describe("PhotoViewer Forge panel", () => {
    it("fills the form from the CURRENT image after navigating, even when its detail loads slowly", async () => {
        mock = installTauriMock(
            baseHandlers({
                // image 2's detail is slow, so the previous image's record is the stale currentDetail
                get_image_detail: async ({ id }) => {
                    if (id === 2) await new Promise((r) => setTimeout(r, 80));
                    return DETAILS[id as number];
                },
            })
        );
        const { rerender } = render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        await waitFor(() => expect(promptBox().value).toBe("a lighthouse at dusk"));

        rerender(viewer(1));
        await waitFor(() => expect(promptBox().value).toBe("a misty forest"), { timeout: 3000 });
        // the CFG field must follow too, not just the prompt
        expect(screen.getByDisplayValue("7.0")).toBeTruthy();
    });

    it("does not refetch Forge options in a loop while the warning is showing", async () => {
        mock = installTauriMock(
            baseHandlers({
                get_image_detail: () =>
                    detail(1, "lighthouse", "a lighthouse at dusk <lora:x:1>"),
            })
        );
        render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        const calls = await settled(() => mock.count("forge_get_options"));
        expect(calls).toBeGreaterThan(0);
        expect(calls).toBeLessThanOrEqual(3);
        expect(screen.getByText(/LoRA directory not configured/)).toBeTruthy();
    });

    it("hides the LoRA directory hint when prompt contains no LoRA tag and no LoRA is selected", async () => {
        mock = installTauriMock(baseHandlers());
        render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        await waitFor(() => expect(mock.count("forge_get_options")).toBeGreaterThan(0));
        await sleep(100);
        expect(screen.queryByText(/LoRA directory not configured/)).toBeNull();
    });

    it("toggling collapsible sections updates the open state, and Send to Forge stays in DOM when Sampling is collapsed", async () => {
        mock = installTauriMock(baseHandlers());
        render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        await waitFor(() => expect(promptBox().value).toBe("a lighthouse at dusk"));

        const promptDetails = screen.getByTestId("forge-section-prompt") as HTMLDetailsElement;
        const samplingDetails = screen.getByTestId("forge-section-sampling") as HTMLDetailsElement;
        const sizeDetails = screen.getByTestId("forge-section-size") as HTMLDetailsElement;
        const modelLoraDetails = screen.getByTestId("forge-section-model-lora") as HTMLDetailsElement;

        expect(promptDetails.open).toBe(true);
        expect(samplingDetails.open).toBe(true);
        expect(sizeDetails.open).toBe(false);
        expect(modelLoraDetails.open).toBe(false);

        // Toggle sampling closed
        samplingDetails.open = false;
        fireEvent(samplingDetails, new Event("toggle"));
        await waitFor(() => {
            expect(samplingDetails.open).toBe(false);
        });

        // Send to Forge button remains in the DOM in sticky footer
        expect(screen.getByRole("button", { name: "Send to Forge" })).toBeTruthy();

        // Toggle size open
        sizeDetails.open = true;
        fireEvent(sizeDetails, new Event("toggle"));
        await waitFor(() => {
            expect(sizeDetails.open).toBe(true);
        });
    });

    it.each([
        ["krea2-turbo.safetensors", "krea2_turbo", true],
        ["Krea 2 Turbo fp8.safetensors", "krea2_turbo", true],
        ["flux1-krea-dev.safetensors", "flux", false],
    ])("detects %s as %s and offers Krea 2 presets only for Krea 2", async (modelName, family, hasKreaPresets) => {
        mock = installTauriMock(
            baseHandlers({
                get_image_detail: () => ({ ...detail(1, "lighthouse", "a lighthouse"), model_name: modelName }),
            })
        );
        render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        await waitFor(() => expect(promptBox().value).toBe("a lighthouse"));
        expect(await screen.findByText(new RegExp(`Detected family: ${family}\\b`))).toBeTruthy();
        const option = screen.queryByRole("option", { name: "1376 x 768 (16:9)" });
        expect(option !== null).toBe(hasKreaPresets);
    });

    it("never offers a scheduler Forge rejects (bong_tangent)", async () => {
        mock = installTauriMock(baseHandlers());
        render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        await waitFor(() => expect(mock.count("forge_get_options")).toBeGreaterThan(0));
        await sleep(100);
        const options = Array.from(document.querySelectorAll("option")).map((o) => o.textContent);
        expect(options).toContain("karras");
        expect(options).not.toContain("bong_tangent");
    });
});

function traceNode(
    id: number,
    filepath: string,
    ghost: boolean,
    thumb: string | null,
    over: { prompt?: string | null; ops_json?: string | null } = {}
) {
    return {
        id,
        filepath,
        filename: filepath.split("/").pop() ?? "",
        is_ghost: ghost,
        ghost_recipe: null,
        ops_json: over.ops_json ?? null,
        source: "forge_requeue",
        parent_id: null,
        depth: 0,
        seed: "1234",
        cfg_scale: "7",
        steps: "20",
        sampler: "Euler a",
        scheduler: "Karras",
        model_name: "m.safetensors",
        prompt: over.prompt ?? null,
        thumbnail_path: thumb,
    };
}

describe("PhotoViewer trace-back", () => {
    const trace = (target: number): LineageTrace => ({
        target_id: target,
        nodes: [
            traceNode(target, "/lib/forest.png", false, null),
            traceNode(50, "/gone/with-thumb.png", true, "/cache/with-thumb.jpg"),
            traceNode(51, "ghost://51", true, null),
        ],
    });

    it("shows a thumbnail only for the culled ancestor that still has one", async () => {
        mock = installTauriMock(baseHandlers({ get_lineage_trace: ({ imageId }) => trace(imageId as number) }));
        render(viewer(1));
        fireEvent.click(await screen.findByTestId("viewer-tab-lineage"));
        const withThumb = await screen.findByTestId("lineage-trace-ghost-thumb-50");
        expect((withThumb as HTMLImageElement).src).toContain(encodeURIComponent("/cache/with-thumb.jpg"));
        expect(screen.getByTestId("lineage-trace-ghost-51")).toBeTruthy();
        expect(screen.queryByTestId("lineage-trace-ghost-thumb-51")).toBeNull();
        expect(screen.getAllByText(/culled ancestor/).length).toBe(2);
    });

    it("expands ghost row on click or Enter/Space to reveal recipe fields, omitting prompt when null", async () => {
        const traceWithPrompt: LineageTrace = {
            target_id: 2,
            nodes: [
                traceNode(2, "/lib/forest.png", false, null),
                traceNode(50, "/gone/with-thumb.png", true, "/cache/with-thumb.jpg", {
                    ops_json: JSON.stringify({ ops: [{ kind: "seed_step", value: 1 }] }),
                }),
                traceNode(51, "ghost://51", true, null, {
                    prompt: "a mysterious mountain",
                }),
            ],
        };
        mock = installTauriMock(baseHandlers({ get_lineage_trace: () => traceWithPrompt }));
        render(viewer(1));
        fireEvent.click(await screen.findByTestId("viewer-tab-lineage"));

        const ghostRow50 = await screen.findByTestId("lineage-trace-ghost-50");
        const toggle50 = within(ghostRow50).getByRole("button");
        expect(toggle50.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByTestId("lineage-trace-ghost-details-50")).toBeNull();

        // Click to expand
        fireEvent.click(toggle50);
        expect(toggle50.getAttribute("aria-expanded")).toBe("true");
        const details50 = screen.getByTestId("lineage-trace-ghost-details-50");
        expect(within(details50).getByTestId("ghost-detail-ops").textContent).toContain("seed+1");
        expect(within(details50).getByTestId("ghost-detail-model").textContent).toContain("m.safetensors");
        expect(within(details50).getByTestId("ghost-detail-model").textContent).toContain("Euler a");
        expect(within(details50).getByTestId("ghost-detail-model").textContent).toContain("Karras");
        expect(within(details50).getByTestId("ghost-detail-sampling").textContent).toContain("Seed: 1234");
        expect(within(details50).getByTestId("ghost-detail-sampling").textContent).toContain("CFG: 7");
        expect(within(details50).getByTestId("ghost-detail-sampling").textContent).toContain("Steps: 20");
        // Node 50 has prompt: null -> no prompt section
        expect(within(details50).queryByTestId("ghost-detail-prompt")).toBeNull();

        // Keyboard navigation (Enter key) on ghost 51
        const ghostRow51 = screen.getByTestId("lineage-trace-ghost-51");
        const toggle51 = within(ghostRow51).getByRole("button");
        expect(toggle51.getAttribute("aria-expanded")).toBe("false");
        fireEvent.keyDown(toggle51, { key: "Enter" });
        expect(toggle51.getAttribute("aria-expanded")).toBe("true");
        const details51 = screen.getByTestId("lineage-trace-ghost-details-51");
        expect(within(details51).getByTestId("ghost-detail-prompt").textContent).toContain("a mysterious mountain");

        // Space key collapses ghost 51 again
        fireEvent.keyDown(toggle51, { key: " " });
        expect(toggle51.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByTestId("lineage-trace-ghost-details-51")).toBeNull();
    });
});

const savedPrompt = (over: Partial<PromptEntry> = {}): PromptEntry => ({
    id: 7,
    title: "Studio portrait",
    prompt: "studio portrait, soft light",
    negative_prompt: "harsh shadows",
    tags: "portrait",
    notes: "",
    source_image_id: null,
    use_count: 0,
    created_at: 0,
    updated_at: 0,
    ...over,
});

describe("PhotoViewer prompt library wiring", () => {
    const libraryHandlers = (entries: PromptEntry[]) =>
        baseHandlers({
            list_prompts: () => entries,
            list_prompt_tags: () => [],
            use_prompt: () => null,
            save_prompt: ({ prompt: text }) => ({
                created: true,
                entry: savedPrompt({ prompt: String(text) }),
            }),
        });

    it("Apply from the viewer's Library fills prompt and negative prompt, records the use and closes", async () => {
        mock = installTauriMock(libraryHandlers([savedPrompt()]));
        render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        await waitFor(() => expect(promptBox().value).toBe("a lighthouse at dusk"));

        fireEvent.click(screen.getByRole("button", { name: "Library" }));
        const dialog = await screen.findByRole("dialog", { name: "Prompt library" });
        await within(dialog).findByText("Studio portrait");
        expect(
            within(dialog).queryByText(
                "Open an image's Forge tab to apply a prompt to a request. Copy works anywhere."
            )
        ).toBeNull();
        fireEvent.click(within(dialog).getByText("Apply"));

        await waitFor(() => expect(promptBox().value).toBe("studio portrait, soft light"));
        const negative = screen.getByPlaceholderText("Negative prompt") as HTMLTextAreaElement;
        expect(negative.value).toBe("harsh shadows");
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Prompt library" })).toBeNull());
        expect(mock.argsOf("use_prompt")).toEqual([{ id: 7 }]);
        expect(screen.getByText(/Applied "Studio portrait"/)).toBeTruthy();
    });

    it("an applied prompt survives a re-render of the same image", async () => {
        mock = installTauriMock(libraryHandlers([savedPrompt()]));
        const { rerender } = render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        await waitFor(() => expect(promptBox().value).toBe("a lighthouse at dusk"));
        fireEvent.click(screen.getByRole("button", { name: "Library" }));
        const dialog = await screen.findByRole("dialog", { name: "Prompt library" });
        await within(dialog).findByText("Studio portrait");
        fireEvent.click(within(dialog).getByText("Apply"));
        await waitFor(() => expect(promptBox().value).toBe("studio portrait, soft light"));
        rerender(viewer(0));
        await act(async () => {
            await Promise.resolve();
        });
        expect(promptBox().value).toBe("studio portrait, soft light");
    });

    it("Save to library sends the text in the box (edited or not) with the current image as source", async () => {
        mock = installTauriMock(libraryHandlers([]));
        render(viewer(1));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        await waitFor(() => expect(promptBox().value).toBe("a misty forest"));
        fireEvent.change(promptBox(), { target: { value: "a misty forest, volumetric fog" } });

        fireEvent.click(screen.getByRole("button", { name: "Save to library" }));
        await waitFor(() => expect(mock.count("save_prompt")).toBe(1));
        expect(mock.argsOf("save_prompt")[0]).toMatchObject({
            prompt: "a misty forest, volumetric fog",
            negativePrompt: "blurry",
            sourceImageId: 2,
        });
        expect(await screen.findByText("Saved to prompt library.")).toBeTruthy();
    });

    it("Save to library refuses an empty prompt without calling the backend", async () => {
        mock = installTauriMock(libraryHandlers([]));
        render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        await waitFor(() => expect(promptBox().value).toBe("a lighthouse at dusk"));
        fireEvent.change(promptBox(), { target: { value: "   " } });
        fireEvent.click(screen.getByRole("button", { name: "Save to library" }));
        expect(await screen.findByText(/Nothing to save/)).toBeTruthy();
        expect(mock.count("save_prompt")).toBe(0);
    });

    it("Save to library and Library buttons are not inside a summary, and summaries do not have aria-expanded", async () => {
        mock = installTauriMock(baseHandlers());
        render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));

        const saveBtn = await screen.findByRole("button", { name: "Save to library" });
        const libBtn = screen.getByRole("button", { name: "Library" });

        expect(saveBtn.closest("summary")).toBeNull();
        expect(libBtn.closest("summary")).toBeNull();

        const summaries = document.querySelectorAll("summary");
        expect(summaries.length).toBeGreaterThan(0);
        for (const s of summaries) {
            expect(s.hasAttribute("aria-expanded")).toBe(false);
        }
    });
});

describe("PhotoViewer detail load failure", () => {
    it("says so instead of showing silently empty fields, and Retry recovers", async () => {
        let failing = true;
        mock = installTauriMock(
            baseHandlers({
                get_image_detail: ({ id }) => {
                    if (failing) throw new Error("db busy");
                    return DETAILS[id as number];
                },
            })
        );
        render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        expect(await screen.findByTestId("forge-detail-error")).toBeTruthy();
        expect(promptBox().value).toBe("");

        failing = false;
        fireEvent.click(within(screen.getByTestId("forge-detail-error")).getByText("Retry"));
        await waitFor(() => expect(screen.queryByTestId("forge-detail-error")).toBeNull());
        await waitFor(() => expect(promptBox().value).toBe("a lighthouse at dusk"));
    });
});

describe("PhotoViewer: Lineage trace ghost row accessibility", () => {
    it("toggles on Enter / Space, updates aria-expanded, and correctly displays seed 0 and CFG 0", async () => {
        const ghostTrace: LineageTrace = {
            target_id: 1,
            nodes: [
                {
                    id: 1,
                    filepath: "/lib/lighthouse.png",
                    filename: "lighthouse.png",
                    is_ghost: false,
                    ghost_recipe: null,
                    ops_json: null,
                    source: "txt2img",
                    parent_id: 99,
                    depth: 0,
                    seed: "111",
                    cfg_scale: "7",
                    steps: "20",
                    sampler: "Euler a",
                    scheduler: "karras",
                    model_name: "model.safetensors",
                    prompt: "test",
                },
                {
                    id: 99,
                    filepath: "ghost://ancestor/99",
                    filename: "ghost_99.png",
                    is_ghost: true,
                    ghost_recipe: "txt2img -> img2img",
                    ops_json: JSON.stringify([{ op: "seed_step", delta: 1 }]),
                    source: "txt2img",
                    parent_id: null,
                    depth: 1,
                    seed: 0 as unknown as string,
                    cfg_scale: 0 as unknown as string,
                    steps: "15",
                    sampler: "Euler a",
                    scheduler: "normal",
                    model_name: "base.safetensors",
                    prompt: "ghost prompt",
                },
            ],
        };

        mock = installTauriMock(
            baseHandlers({
                get_lineage_trace: () => ghostTrace,
                get_lineage_cursor: () => ({
                    ancestors: [
                        {
                            parent_filepath: "ghost://ancestor/99",
                            relation: "derived",
                            confidence: 1.0,
                        },
                    ],
                    children: [],
                }),
            })
        );

        render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-lineage"));

        const toggleBtn = await screen.findByTestId("lineage-trace-ghost-toggle-99");
        expect(toggleBtn.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByTestId("lineage-trace-ghost-details-99")).toBeNull();

        // Toggle open via Enter key
        fireEvent.keyDown(toggleBtn, { key: "Enter" });
        expect(toggleBtn.getAttribute("aria-expanded")).toBe("true");

        const details = await screen.findByTestId("lineage-trace-ghost-details-99");
        expect(details).toBeTruthy();

        // Check sampling renders Seed: 0 and CFG: 0 instead of em-dash
        const sampling = screen.getByTestId("ghost-detail-sampling");
        expect(sampling.textContent).toContain("Seed: 0");
        expect(sampling.textContent).toContain("CFG: 0");
        expect(sampling.textContent).toContain("Steps: 15");
        expect(sampling.textContent).not.toContain("—");

        // Toggle closed via Space key
        fireEvent.keyDown(toggleBtn, { key: " " });
        expect(toggleBtn.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByTestId("lineage-trace-ghost-details-99")).toBeNull();
    });
});
