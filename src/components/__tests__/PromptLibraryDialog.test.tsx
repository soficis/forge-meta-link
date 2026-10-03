import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
});
