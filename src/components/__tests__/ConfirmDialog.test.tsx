import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "../ConfirmDialog";

describe("ConfirmDialog", () => {
    it("renders with alertdialog role, correct title, filenames summary, and warning message", () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();

        render(
            <ConfirmDialog
                count={5}
                filenames={["image1.png", "image2.png", "image3.png", "image4.png", "image5.png"]}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />
        );

        const dialog = screen.getByRole("alertdialog");
        expect(dialog).not.toBeNull();
        expect(dialog.getAttribute("aria-modal")).toBe("true");

        expect(screen.getByText("Delete 5 images permanently?")).not.toBeNull();
        expect(screen.getByText("image1.png, image2.png, image3.png, and 2 more.")).not.toBeNull();
        expect(screen.getByText("Prompt text is removed; seed, CFG, steps, sampler, scheduler and model are kept so lineage can still be traced.")).not.toBeNull();
        expect(screen.getByText("Delete 5 permanently")).not.toBeNull();
    });

    it("focuses the Cancel button initially", () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();

        render(
            <ConfirmDialog
                count={1}
                filenames={["single.png"]}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />
        );

        const cancelButton = screen.getByRole("button", { name: "Cancel" });
        expect(document.activeElement).toBe(cancelButton);
        expect(screen.getByText("Delete 1 image permanently?")).not.toBeNull();
        expect(screen.getByText("Delete 1 permanently")).not.toBeNull();
    });

    it("cancels when Esc is pressed and stops propagation of keydown events", () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();

        render(
            <ConfirmDialog
                count={2}
                filenames={["a.png", "b.png"]}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />
        );

        const dialog = screen.getByRole("alertdialog");
        const stopPropagationSpy = vi.fn();

        fireEvent.keyDown(dialog, {
            key: "Escape",
            stopPropagation: stopPropagationSpy,
        });

        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("triggers onConfirm when destructive button is clicked", () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();

        render(
            <ConfirmDialog
                count={3}
                filenames={["a.png", "b.png", "c.png"]}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />
        );

        const confirmButton = screen.getByRole("button", { name: "Delete 3 permanently" });
        fireEvent.click(confirmButton);
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
    });

    it("renders trash mode copy correctly", () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();

        render(
            <ConfirmDialog
                count={30}
                filenames={["1.png", "2.png", "3.png"]}
                mode="trash"
                onConfirm={onConfirm}
                onCancel={onCancel}
            />
        );

        expect(screen.getByText("Move 30 images to Trash?")).not.toBeNull();
        expect(screen.getByText("They will be moved to the Recycle Bin.")).not.toBeNull();
        expect(screen.getByText("Move 30 to Trash")).not.toBeNull();
    });
});
