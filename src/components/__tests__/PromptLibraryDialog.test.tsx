import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { PromptEntry } from "../../types/metadata";

const entry = (id: number, title: string, tags = ""): PromptEntry => ({
    id,
    title,
    prompt: `${title} prompt text`,
    negative_prompt: "blurry",
    tags,
    notes: "",
    source_image_id: null,
    use_count: 0,
    created_at: 0,
    updated_at: 0,
});

const commands = vi.hoisted(() => ({
    listPrompts: vi.fn(),
    listPromptTags: vi.fn(),
    markPromptUsed: vi.fn(),
    deletePrompt: vi.fn(),
    savePrompt: vi.fn(),
    updatePrompt: vi.fn(),
    exportPromptLibrary: vi.fn(),
    importPromptLibrary: vi.fn(),
}));

vi.mock("../../services/commands", () => commands);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { PromptLibraryDialog } from "../PromptLibraryDialog";

beforeEach(() => {
    vi.clearAllMocks();
    commands.listPrompts.mockResolvedValue([entry(1, "Portrait", "scifi"), entry(2, "Landscape")]);
    commands.listPromptTags.mockResolvedValue([{ tag: "scifi", count: 1 }]);
    commands.markPromptUsed.mockResolvedValue(undefined);
    commands.savePrompt.mockResolvedValue({ entry: entry(3, "New"), created: true });
});

describe("PromptLibraryDialog", () => {
    it("lists entries and tag chips", async () => {
        render(<PromptLibraryDialog onClose={() => {}} />);
        expect(await screen.findByText("Portrait")).toBeTruthy();
        expect(screen.getByText("Landscape")).toBeTruthy();
        expect(screen.getByText("scifi (1)")).toBeTruthy();
    });

    it("hides Apply when no onApply handler is given", async () => {
        render(<PromptLibraryDialog onClose={() => {}} />);
        await screen.findByText("Portrait");
        expect(screen.queryByText("Apply")).toBeNull();
    });

    it("Apply passes the entry to the caller, records the use, and closes", async () => {
        const onApply = vi.fn();
        const onClose = vi.fn();
        render(<PromptLibraryDialog onClose={onClose} onApply={onApply} />);
        await screen.findByText("Portrait");
        fireEvent.click(screen.getAllByText("Apply")[0]);
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: 1, prompt: "Portrait prompt text" }));
        expect(commands.markPromptUsed).toHaveBeenCalledWith(1);
    });

    it("still applies when recording the use fails", async () => {
        commands.markPromptUsed.mockRejectedValue(new Error("db busy"));
        const onApply = vi.fn();
        const onClose = vi.fn();
        render(<PromptLibraryDialog onClose={onClose} onApply={onApply} />);
        await screen.findByText("Portrait");
        fireEvent.click(screen.getAllByText("Apply")[0]);
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(onApply).toHaveBeenCalledTimes(1);
    });

    it("searches with the typed query and active tag", async () => {
        render(<PromptLibraryDialog onClose={() => {}} />);
        await screen.findByText("Portrait");
        fireEvent.change(screen.getByLabelText("Search prompt library"), { target: { value: "astro" } });
        await waitFor(() => expect(commands.listPrompts).toHaveBeenCalledWith("astro", undefined));
        fireEvent.click(screen.getByText("scifi (1)"));
        await waitFor(() => expect(commands.listPrompts).toHaveBeenCalledWith("astro", "scifi"));
    });

    it("New requires a non-empty prompt before Save is enabled, then saves", async () => {
        render(<PromptLibraryDialog onClose={() => {}} />);
        await screen.findByText("Portrait");
        fireEvent.click(screen.getByText("New"));
        const save = screen.getByText("Save") as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        fireEvent.change(screen.getByPlaceholderText("Prompt"), { target: { value: "a cat" } });
        expect(save.disabled).toBe(false);
        fireEvent.click(save);
        await waitFor(() =>
            expect(commands.savePrompt).toHaveBeenCalledWith(
                expect.objectContaining({ prompt: "a cat" })
            )
        );
    });

    it("Escape closes the dialog but only leaves the editor when one is open", async () => {
        const onClose = vi.fn();
        render(<PromptLibraryDialog onClose={onClose} />);
        await screen.findByText("Portrait");
        fireEvent.click(screen.getByText("New"));
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("inline two-step delete removes entry, Keep cancels, Undo restores within 6s, and window.confirm is never called", async () => {
        const confirmSpy = vi.spyOn(window, "confirm");
        render(<PromptLibraryDialog onClose={() => {}} />);
        await screen.findByText("Portrait");

        // 1. Click Delete on first entry
        const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
        fireEvent.click(deleteButtons[0]);

        expect(screen.getByText("Delete?")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Yes, delete" })).toBeTruthy();
        const keepBtn = screen.getByRole("button", { name: "Keep" });

        // Keep focused
        expect(document.activeElement).toBe(keepBtn);

        // Click Keep -> cancels confirmation, calls no backend
        fireEvent.click(keepBtn);
        expect(commands.deletePrompt).not.toHaveBeenCalled();
        expect(screen.queryByText("Delete?")).toBeNull();

        // Click Delete again -> click Yes, delete
        fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
        const confirmYesBtn = screen.getByRole("button", { name: "Yes, delete" });
        fireEvent.click(confirmYesBtn);

        await waitFor(() => expect(commands.deletePrompt).toHaveBeenCalledWith(1));
        expect(confirmSpy).not.toHaveBeenCalled();

        // Status shows Deleted "Portrait". Undo
        expect(screen.getByText(/Deleted "Portrait"\./)).toBeTruthy();
        const undoBtn = screen.getByRole("button", { name: "Undo" });
        expect(undoBtn).toBeTruthy();

        // Click Undo -> calls savePrompt with original fields
        fireEvent.click(undoBtn);
        await waitFor(() =>
            expect(commands.savePrompt).toHaveBeenCalledWith({
                title: "Portrait",
                prompt: "Portrait prompt text",
                negativePrompt: "blurry",
                tags: "scifi",
                notes: "",
            })
        );

        confirmSpy.mockRestore();
    });

    it("shows apply hint when onApply is not provided, and hides it when onApply is provided", async () => {
        const { unmount } = render(<PromptLibraryDialog onClose={() => {}} />);
        expect(
            await screen.findByText(
                "Open an image's Forge tab to apply a prompt to a request. Copy works anywhere."
            )
        ).toBeTruthy();
        unmount();

        render(<PromptLibraryDialog onClose={() => {}} onApply={() => {}} />);
        await screen.findByText("Portrait");
        expect(
            screen.queryByText(
                "Open an image's Forge tab to apply a prompt to a request. Copy works anywhere."
            )
        ).toBeNull();
    });

    it("deleting two entries in sequence creates an undo stack, popping newest first until cleared", async () => {
        render(<PromptLibraryDialog onClose={() => {}} />);
        await screen.findByText("Portrait");

        // Delete first entry ("Portrait")
        const deleteButtons1 = screen.getAllByRole("button", { name: "Delete" });
        fireEvent.click(deleteButtons1[0]);
        fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
        await waitFor(() => expect(commands.deletePrompt).toHaveBeenCalledWith(1));

        expect(screen.getByText(/Deleted "Portrait"\./)).toBeTruthy();
        expect(screen.queryByText(/\(\+1 more\)/)).toBeNull();

        // Delete second entry ("Landscape")
        const deleteButtons2 = screen.getAllByRole("button", { name: "Delete" });
        fireEvent.click(deleteButtons2[1]);
        fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
        await waitFor(() => expect(commands.deletePrompt).toHaveBeenCalledWith(2));

        // Status shows Deleted "Landscape". Undo (+1 more)
        expect(screen.getByText(/Deleted "Landscape"\./)).toBeTruthy();
        expect(screen.getByText(/\(\+1 more\)/)).toBeTruthy();

        // Click Undo -> restores Landscape (newest)
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
        await waitFor(() =>
            expect(commands.savePrompt).toHaveBeenCalledWith(
                expect.objectContaining({ title: "Landscape" })
            )
        );

        // Status shows Deleted "Portrait". Undo
        expect(screen.getByText(/Deleted "Portrait"\./)).toBeTruthy();
        expect(screen.queryByText(/\(\+1 more\)/)).toBeNull();

        // Click Undo -> restores Portrait
        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
        await waitFor(() =>
            expect(commands.savePrompt).toHaveBeenCalledWith(
                expect.objectContaining({ title: "Portrait" })
            )
        );

        // Status clears
        await waitFor(() => {
            expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
            expect(screen.queryByText(/Deleted/)).toBeNull();
        });
    });

    it("advance fake timers 6s clears the undo stack and UI disappears", async () => {
        render(<PromptLibraryDialog onClose={() => {}} />);
        await screen.findByText("Portrait");

        vi.useFakeTimers();
        try {
            // Delete first entry
            await act(async () => {
                fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
            });
            await act(async () => {
                fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
                await vi.advanceTimersByTimeAsync(50);
            });

            expect(screen.getByText(/Deleted "Portrait"\./)).toBeTruthy();
            expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();

            // Advance timers past 6000ms
            await act(async () => {
                await vi.advanceTimersByTimeAsync(6500);
            });

            expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
            expect(screen.queryByText(/Deleted/)).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

