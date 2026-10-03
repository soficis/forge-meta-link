import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { installTauriMock, type Handlers, type TauriMock } from "../../test/tauriMock";
import { queryClient } from "../../queryClient";
import type { DeleteImagesResult, GalleryImageRecord, PromptEntry } from "../../types/metadata";

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                start: index * estimateSize(),
                size: estimateSize(),
                key: index,
            })),
        getTotalSize: () => count * estimateSize(),
        measure: () => {},
        measureElement: () => {},
        scrollToIndex: () => {},
    }),
}));

const image = (id: number, name: string, locked = false): GalleryImageRecord => ({
    id,
    filepath: `/lib/${name}.png`,
    filename: `${name}.png`,
    directory: "/lib",
    seed: String(id),
    width: 64,
    height: 64,
    model_name: "m.safetensors",
    is_favorite: false,
    is_locked: locked,
    file_mtime: 1000 + id,
});

const prompt = (id: number, title: string): PromptEntry => ({
    id,
    title,
    prompt: `${title} prompt`,
    negative_prompt: "",
    tags: "",
    notes: "",
    source_image_id: null,
    use_count: 0,
    created_at: 0,
    updated_at: 0,
});

/** A tiny stateful backend: deleting really removes rows, so the refetch after delete is honest. */
let library: GalleryImageRecord[];
let mock: TauriMock;

function backend(extra: Handlers = {}): Handlers {
    return {
        get_storage_profile: () => "ssd",
        get_file_mtimes: () => [],
        get_forge_api_key: () => "",
        get_total_count: () => library.length,
        get_top_tags: () => [],
        get_models: () => [],
        list_tags: () => [],
        get_thumbnail_paths: () => [],
        get_images_cursor: () => ({ items: [...library], next_cursor: null }),
        delete_images: ({ request }) => {
            const { ids } = request as { ids: number[]; mode: string };
            library = library.filter((i) => !ids.includes(i.id));
            const result: DeleteImagesResult = {
                requested: ids.length,
                removed_from_db: ids.length,
                deleted_ids: ids,
                deleted_files: ids.length,
                missing_files: 0,
                failed_files: 0,
                deleted_sidecars: 0,
                deleted_thumbnails: 0,
                blocked_protected: 0,
                blocked_protected_ids: [],
                failed_paths: [],
            };
            return result;
        },
        list_prompts: () => [prompt(1, "Saved portrait")],
        list_prompt_tags: () => [],
        ...extra,
    };
}

async function mountApp() {
    const { default: App } = await import("../../App");
    render(<App />);
    await screen.findByText("a.png");
}

const present = (name: string) => screen.queryByText(name) !== null;
const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(() => {
    localStorage.clear();
    queryClient.clear(); // the client is app-wide; stale cache from the previous test would leak in
    library = [image(1, "a"), image(2, "b"), image(3, "c")];
});

afterEach(() => {
    vi.useRealTimers();
});

describe("App wiring: prompt library", () => {
    it("the sidebar Prompt library button opens the dialog, which loads entries and closes again", async () => {
        mock = installTauriMock(backend());
        await mountApp();
        expect(screen.queryByRole("dialog", { name: "Prompt library" })).toBeNull();

        fireEvent.click(screen.getByLabelText("Prompt library"));
        const dialog = await screen.findByRole("dialog", { name: "Prompt library" });
        await within(dialog).findByText("Saved portrait");
        expect(mock.count("list_prompts")).toBeGreaterThan(0);

        fireEvent.click(within(dialog).getByLabelText("Close prompt library"));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Prompt library" })).toBeNull());
    });

    it("opened from the sidebar there is no Apply button (nothing to fill), but Copy is offered", async () => {
        mock = installTauriMock(backend());
        await mountApp();
        fireEvent.click(screen.getByLabelText("Prompt library"));
        const dialog = await screen.findByRole("dialog", { name: "Prompt library" });
        await within(dialog).findByText("Saved portrait");
        expect(within(dialog).queryByText("Apply")).toBeNull();
        expect(within(dialog).getByText("Copy")).toBeTruthy();
    });
});

describe("App wiring: delete, undo, finalize", () => {
    async function selectAllAndTrash() {
        fireEvent.click(await screen.findByText("Select all"));
        fireEvent.click(await screen.findByText("Trash", { selector: "button" }));
    }

    it("trash removes the images at once but only calls the backend after the undo window", async () => {
        mock = installTauriMock(backend());
        await mountApp();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });

        await selectAllAndTrash();
        await waitFor(() => expect(present("a.png")).toBe(false));
        expect(present("b.png")).toBe(false);
        expect(screen.getByText(/Moving 3 images to Trash/)).toBeTruthy();
        expect(mock.count("delete_images")).toBe(0);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(6200);
        });
        await waitFor(() => expect(mock.count("delete_images")).toBe(1));
        expect(mock.argsOf("delete_images")[0]).toEqual({ request: { ids: [1, 2, 3], mode: "trash" } });
        await waitFor(() => expect(screen.getAllByText(/Moved to Trash 3 images/).length).toBeGreaterThan(0));
    });

    it("Undo inside the window restores the images and the backend is never called", async () => {
        mock = installTauriMock(backend());
        await mountApp();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });

        await selectAllAndTrash();
        await waitFor(() => expect(present("a.png")).toBe(false));

        fireEvent.click(await screen.findByText("Undo"));
        await waitFor(() => expect(present("a.png")).toBe(true));
        expect(present("b.png")).toBe(true);
        expect(present("c.png")).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(8000);
        });
        expect(mock.count("delete_images")).toBe(0);
        expect(library).toHaveLength(3);
    });

    it("locked images are skipped and stay in the gallery", async () => {
        library = [image(1, "a", true), image(2, "b"), image(3, "c")];
        mock = installTauriMock(backend());
        await mountApp();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });

        await selectAllAndTrash();
        await waitFor(() => expect(present("b.png")).toBe(false));
        expect(present("a.png")).toBe(true);
        expect(screen.getByText(/1 locked image were skipped/)).toBeTruthy();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(6200);
        });
        await waitFor(() => expect(mock.count("delete_images")).toBe(1));
        expect(mock.argsOf("delete_images")[0]).toEqual({ request: { ids: [2, 3], mode: "trash" } });
    });

    it("permanent delete asks first, says what is kept, and Cancel deletes nothing", async () => {
        mock = installTauriMock(backend());
        await mountApp();

        fireEvent.click(await screen.findByText("Select all"));
        fireEvent.click(await screen.findByText("Delete permanently…"));
        const dialog = await screen.findByRole("alertdialog");
        expect(within(dialog).getByText(/Delete 3 images permanently/)).toBeTruthy();
        expect(within(dialog).getByText(/seed, CFG, steps, sampler, scheduler and model are kept/)).toBeTruthy();

        fireEvent.click(within(dialog).getByText("Cancel"));
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await sleep(300);
        expect(mock.count("delete_images")).toBe(0);
        expect(present("a.png")).toBe(true);
    });

    it("confirming a permanent delete schedules it (with undo) and then sends mode=permanent", async () => {
        mock = installTauriMock(backend());
        await mountApp();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });

        fireEvent.click(await screen.findByText("Select all"));
        fireEvent.click(await screen.findByText("Delete permanently…"));
        const dialog = await screen.findByRole("alertdialog");
        fireEvent.click(within(dialog).getByText(/Delete 3 permanently/));
        await waitFor(() => expect(present("a.png")).toBe(false));
        expect(mock.count("delete_images")).toBe(0);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(6200);
        });
        await waitFor(() => expect(mock.count("delete_images")).toBe(1));
        expect(mock.argsOf("delete_images")[0]).toEqual({ request: { ids: [1, 2, 3], mode: "permanent" } });
    });
});
