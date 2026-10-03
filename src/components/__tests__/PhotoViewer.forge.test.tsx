import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { PhotoViewer } from "../PhotoViewer";
import { installTauriMock, type Handlers, type TauriMock } from "../../test/tauriMock";
import type { GalleryImageRecord, ImageRecord, LineageTrace } from "../../types/metadata";

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
        await sleep(250);
        await waitFor(() => expect(promptBox().value).toBe("a misty forest"));
        // the CFG field must follow too, not just the prompt
        expect(screen.getByDisplayValue("7.0")).toBeTruthy();
    });

    it("does not refetch Forge options in a loop while the warning is showing", async () => {
        mock = installTauriMock(baseHandlers());
        render(viewer(0));
        fireEvent.click(await screen.findByTestId("viewer-tab-forge"));
        await sleep(400);
        const settled = mock.count("forge_get_options");
        await sleep(600);
        expect(mock.count("forge_get_options")).toBe(settled);
        expect(settled).toBeLessThanOrEqual(3);
        expect(screen.getByText(/LoRA directory not configured/)).toBeTruthy();
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

function traceNode(id: number, filepath: string, ghost: boolean, thumb: string | null) {
    return {
        id,
        filepath,
        filename: filepath.split("/").pop() ?? "",
        is_ghost: ghost,
        ghost_recipe: null,
        ops_json: null,
        source: "forge_requeue",
        parent_id: null,
        depth: 0,
        seed: "1234",
        cfg_scale: "7",
        steps: "20",
        sampler: "Euler a",
        scheduler: "Karras",
        model_name: "m.safetensors",
        prompt: null,
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
});
