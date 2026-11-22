import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RapidCullBoard } from "../RapidCullBoard";
import { installTauriMock, type Handlers, type TauriMock } from "../../test/tauriMock";
import type { DeleteImagesResult, GalleryImageRecord } from "../../types/metadata";

function image(id: number, over: Partial<GalleryImageRecord> = {}): GalleryImageRecord {
    return {
        id,
        filepath: `/lib/${id}.png`,
        filename: `${id}.png`,
        directory: "/lib",
        seed: String(id * 100),
        width: 1024,
        height: 768,
        model_name: "model.safetensors",
        is_favorite: false,
        is_locked: false,
        file_mtime: null,
        ...over,
    };
}

function okResult(ids: number[]): DeleteImagesResult {
    return {
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
}

let mock: TauriMock;

function renderBoard(images: GalleryImageRecord[], overrides: Handlers = {}) {
    mock = installTauriMock({
        get_thumbnail_paths: () => [],
        delete_images: ({ request }) => okResult((request as { ids: number[] }).ids),
        ...overrides,
    });
    const onClose = vi.fn();
    const onCulled = vi.fn();
    render(<RapidCullBoard images={images} onClose={onClose} onCulled={onCulled} />);
    const dialog = screen.getByRole("dialog", { name: "Rapid cull board" });
    return { onClose, onCulled, dialog };
}

/** The first cull is gated: Space arms it, then Y twice inside 3s confirms it. */
function confirmFirstCull(dialog: HTMLElement) {
    fireEvent.keyDown(dialog, { key: " " });
    fireEvent.keyDown(dialog, { key: "y" });
    fireEvent.keyDown(dialog, { key: "y" });
}

const cell = (id: number) => screen.getByTestId(`rapid-cull-cell-${id}`);

beforeEach(() => {
    vi.useRealTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("RapidCullBoard", () => {
    it("arrow and A/D navigation moves the current cell without scrolling the page", () => {
        const { dialog } = renderBoard([image(1), image(2), image(3)]);

        expect(cell(1).getAttribute("aria-selected")).toBe("true");
        // fireEvent returns false when the handler called preventDefault().
        expect(fireEvent.keyDown(dialog, { key: "ArrowRight" })).toBe(false);
        expect(cell(2).getAttribute("aria-selected")).toBe("true");
        fireEvent.keyDown(dialog, { key: "ArrowRight" });
        expect(cell(3).getAttribute("aria-selected")).toBe("true");
        fireEvent.keyDown(dialog, { key: "ArrowRight" });
        expect(cell(3).getAttribute("aria-selected")).toBe("true"); // clamped at the end

        fireEvent.keyDown(dialog, { key: "a" });
        expect(cell(2).getAttribute("aria-selected")).toBe("true");
        fireEvent.keyDown(dialog, { key: "d" });
        expect(cell(3).getAttribute("aria-selected")).toBe("true");
        expect(fireEvent.keyDown(dialog, { key: "ArrowLeft" })).toBe(false);
        expect(cell(2).getAttribute("aria-selected")).toBe("true");
    });

    it("Space culls the current id with mode trash and removes it from the grid", async () => {
        const { dialog, onCulled } = renderBoard([image(1), image(2), image(3)]);

        // A single Space must not cull: the first cull needs a confirmation.
        fireEvent.keyDown(dialog, { key: " " });
        expect(mock.count("delete_images")).toBe(0);
        confirmFirstCull(dialog);

        await waitFor(() => expect(mock.count("delete_images")).toBe(1));
        expect(mock.argsOf("delete_images")[0]).toEqual({
            request: { ids: [1], mode: "trash" },
        });
        await waitFor(() => expect(screen.queryByTestId("rapid-cull-cell-1")).toBeNull());
        expect(cell(2).getAttribute("aria-selected")).toBe("true");
        expect(onCulled).toHaveBeenCalledWith(1);
        expect(screen.getByTestId("rapid-cull-progress").textContent).toContain("culled 1");
        expect(screen.getByText("Culled this session")).toBeTruthy();
        expect(screen.getByText("Culled")).toBeTruthy();

        // Confirmation is session-wide, so later culls are a single keypress.
        fireEvent.keyDown(dialog, { key: " " });
        await waitFor(() => expect(mock.count("delete_images")).toBe(2));
        expect(mock.argsOf("delete_images")[1]).toEqual({
            request: { ids: [2], mode: "trash" },
        });
        await waitFor(() => expect(screen.queryByTestId("rapid-cull-cell-2")).toBeNull());
    });

    it("X also culls to trash (never permanent) once the session is confirmed", async () => {
        const { dialog } = renderBoard([image(7), image(8)]);
        confirmFirstCull(dialog);
        await waitFor(() => expect(mock.count("delete_images")).toBe(1));

        fireEvent.keyDown(dialog, { key: "x" });
        await waitFor(() => expect(mock.count("delete_images")).toBe(2));
        for (const args of mock.argsOf("delete_images")) {
            expect((args.request as { mode: string }).mode).toBe("trash");
        }
    });

    it("a failed invoke keeps the image in place with an inline error", async () => {
        const { dialog, onCulled } = renderBoard([image(1), image(2)], {
            delete_images: () => {
                throw new Error("disk busy");
            },
        });

        confirmFirstCull(dialog);
        await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
        expect(screen.getByRole("alert").textContent).toContain("Cull failed: disk busy");
        expect(screen.getByTestId("rapid-cull-cell-1")).toBeTruthy();
        expect(screen.getByTestId("rapid-cull-notice").textContent).toMatch(/stays in the board/);
        expect(onCulled).not.toHaveBeenCalled();
        expect(screen.getByTestId("rapid-cull-progress").textContent).toContain("culled 0");
    });

    it("a null delete result fails closed and keeps the image in place", async () => {
        const { dialog, onCulled } = renderBoard([image(1), image(2)], {
            delete_images: () => null,
        });

        confirmFirstCull(dialog);
        await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
        expect(screen.getByRole("alert").textContent).toContain(
            "no images were removed"
        );
        expect(screen.getByTestId("rapid-cull-cell-1")).toBeTruthy();
        expect(screen.getByTestId("rapid-cull-progress").textContent).toContain("culled 0");
        expect(onCulled).not.toHaveBeenCalled();
    });

    it("a locked image shows a lock badge and is skipped without any invoke", () => {
        const { dialog } = renderBoard([image(1, { is_locked: true }), image(2)]);

        expect(screen.getByText(/Locked — cannot cull/)).toBeTruthy();
        fireEvent.keyDown(dialog, { key: " " });
        expect(mock.count("delete_images")).toBe(0);
        expect(screen.getByTestId("rapid-cull-notice").textContent).toMatch(
            /locked images cannot be culled/
        );
        expect(screen.getByTestId("rapid-cull-cell-1")).toBeTruthy();
    });

    it("Escape and Enter close the board without culling", () => {
        const { dialog, onClose } = renderBoard([image(1), image(2)]);

        fireEvent.keyDown(dialog, { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(dialog, { key: "Enter" });
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(mock.count("delete_images")).toBe(0);
    });

    it("Z reports that undo is unavailable instead of inventing a restore command", () => {
        const { dialog } = renderBoard([image(1)]);

        fireEvent.keyDown(dialog, { key: "z" });
        expect(screen.getByTestId("rapid-cull-notice").textContent).toBe(
            "Undo unavailable in this session; use Recently Deleted"
        );
        expect(mock.calls.some((call) => /restore|undelete/i.test(call.cmd))).toBe(false);
    });

    it("the two Y confirmations must both land inside the 3 second window", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
            const { dialog } = renderBoard([image(1), image(2)]);
            fireEvent.keyDown(dialog, { key: " " });
            fireEvent.keyDown(dialog, { key: "y" });

            vi.setSystemTime(new Date("2026-01-01T00:00:04.000Z"));
            fireEvent.keyDown(dialog, { key: "y" }); // expired: restarts the window
            expect(mock.count("delete_images")).toBe(0);

            fireEvent.keyDown(dialog, { key: "y" }); // immediate second press confirms
            await waitFor(() => expect(mock.count("delete_images")).toBe(1));
        } finally {
            vi.useRealTimers();
        }
    });

    it("is a labelled modal dialog, keeps focus inside, and announces progress", () => {
        const { dialog } = renderBoard([image(1), image(2)]);

        expect(dialog.getAttribute("aria-modal")).toBe("true");
        expect(dialog.getAttribute("aria-labelledby")).toBe("rapid-cull-title");
        expect(screen.getByTestId("rapid-cull-status").getAttribute("aria-live")).toBe("polite");
        expect(document.activeElement).toBe(dialog);
        expect(screen.getByTestId("rapid-cull-progress").textContent).toMatch(
            /^kept \d+ \/ culled \d+ \/ remaining \d+$/
        );
        expect(screen.getByTestId("rapid-cull-current").textContent).toContain(
            "model.safetensors"
        );
        expect(screen.getByTestId("rapid-cull-current").textContent).toContain("seed 100");
        expect(screen.getByTestId("rapid-cull-current").textContent).toContain("1024×768");

        const close = screen.getByLabelText("Close rapid cull board");
        close.focus();
        fireEvent.keyDown(close, { key: "Tab" });
        expect(document.activeElement).toBe(dialog);
    });
});
