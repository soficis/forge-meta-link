import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
    XyzRebuilder,
    buildGrid,
    getAxisOptions,
    MISSING_GROUP_LABEL,
    type XyzAxisField,
} from "../XyzRebuilder";
import type { ImageRecord } from "../../types/metadata";

function image(id: number, over: Partial<ImageRecord> = {}): ImageRecord {
    return {
        id,
        filepath: `/lib/${id}.png`,
        filename: `${id}.png`,
        directory: "/lib",
        seed: String(id * 100),
        width: 512,
        height: 512,
        model_name: "model.safetensors",
        is_favorite: false,
        is_locked: false,
        file_mtime: 1000 + id,
        prompt: "a photo",
        negative_prompt: "",
        steps: "20",
        sampler: "Euler a",
        schedule_type: "Normal",
        extra_params: null,
        text_chunks: null,
        cfg_scale: "7",
        model_hash: null,
        raw_metadata: "",
        ...over,
    };
}

function renderRebuilder(
    images: ImageRecord[],
    onPin = vi.fn(),
    onClose = vi.fn()
) {
    render(<XyzRebuilder images={images} onPin={onPin} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Rebuild X/Y/Z grid" });
    return { dialog, onPin, onClose };
}

describe("XyzRebuilder axis derivation", () => {
    it("derives options from structured fields only, never from filenames", () => {
        const records = [
            image(1, {
                filename: "cfg99-steps1-samplerFake.png",
                cfg_scale: "7",
                steps: "20",
                sampler: "Euler a",
            }),
            image(2, {
                filename: "cfg2-steps3-samplerOther.png",
                cfg_scale: "12",
                steps: "30",
                sampler: "DPM++ 2M",
            }),
        ];

        expect(getAxisOptions(records, "cfg_scale").map((option) => option.value)).toEqual([
            "7",
            "12",
        ]);
        expect(getAxisOptions(records, "steps").map((option) => option.value)).toEqual([
            "20",
            "30",
        ]);
        expect(getAxisOptions(records, "sampler").map((option) => option.value)).toEqual([
            "DPM++ 2M",
            "Euler a",
        ]);
        for (const field of ["seed", "cfg_scale", "steps", "sampler", "schedule_type", "model_name"] as XyzAxisField[]) {
            const labels = getAxisOptions(records, field).map((option) => option.label);
            expect(labels.some((label) => /99|Fake|Other|steps1/.test(label))).toBe(false);
        }
    });

    it("sorts numeric fields ascending and strings with localeCompare", () => {
        const records = [
            image(1, { cfg_scale: "10", sampler: "zeta" }),
            image(2, { cfg_scale: "2", sampler: "alpha" }),
            image(3, { cfg_scale: "7", sampler: "mid" }),
            image(4, { cfg_scale: "2", sampler: "alpha" }),
        ];

        expect(getAxisOptions(records, "cfg_scale").map((option) => option.value)).toEqual([
            "2",
            "7",
            "10",
        ]);
        expect(getAxisOptions(records, "sampler").map((option) => option.value)).toEqual([
            "alpha",
            "mid",
            "zeta",
        ]);
    });

    it("labels missing structured values as a distinct group instead of a number", () => {
        const records = [
            image(1, { cfg_scale: null }),
            image(2, { cfg_scale: "  " }),
            image(3, { cfg_scale: "7" }),
        ];
        const options = getAxisOptions(records, "cfg_scale");

        expect(options.map((option) => option.label)).toEqual(["7", MISSING_GROUP_LABEL]);
        expect(options[1].isMissing).toBe(true);
        expect(options.some((option) => option.label === "0")).toBe(false);
    });
});

describe("XyzRebuilder grouping and interaction", () => {
    it("renders an X by Y grid with explicit gaps for absent combinations", () => {
        const records = [
            image(1, { cfg_scale: "2", steps: "10", sampler: "Euler" }),
            image(2, { cfg_scale: "10", steps: "30", sampler: "Euler" }),
        ];
        const grid = buildGrid(records, "cfg_scale", "steps", "sampler");

        expect(grid.xOptions.map((option) => option.value)).toEqual(["2", "10"]);
        expect(grid.yOptions.map((option) => option.value)).toEqual(["10", "30"]);
        expect(grid.cells).toHaveLength(2);

        renderRebuilder(records);
        const table = screen.getByTestId("xyz-grid");
        expect(within(table).getByTestId("xyz-cell-2-10")).toBeTruthy();
        expect(within(table).getByTestId("xyz-cell-10-30")).toBeTruthy();
        const gaps = within(table).getAllByTestId(/xyz-gap-/);
        expect(gaps).toHaveLength(2);
        expect(gaps[0].textContent).toBe("—");
        expect(gaps[0].getAttribute("aria-label")).toContain("No images for X");
        expect(screen.getByTestId("xyz-result-count").textContent).toContain("2 images");
    });

    it("shows the missing group in headers and cells when a field is not recorded", () => {
        const records = [
            image(1, { cfg_scale: null, steps: "10", sampler: "Euler" }),
            image(2, { cfg_scale: "7", steps: "10", sampler: "Euler" }),
        ];

        renderRebuilder(records);
        const table = screen.getByTestId("xyz-grid");
        expect(within(table).getByTestId("xyz-x-header-")).toBeTruthy();
        expect(within(table).getAllByText(MISSING_GROUP_LABEL).length).toBeGreaterThan(0);
    });

    it("calls onPin with all ids of the clicked cell and highlights it", () => {
        const records = [
            image(3, { cfg_scale: "7", steps: "20", sampler: "Euler" }),
            image(1, { cfg_scale: "7", steps: "20", sampler: "Euler" }),
        ];
        const { onPin } = renderRebuilder(records);

        const cell = screen.getByTestId("xyz-cell-7-20");
        fireEvent.click(cell);

        expect(onPin).toHaveBeenCalledTimes(1);
        expect(onPin).toHaveBeenCalledWith([1, 3]);
        expect(cell.getAttribute("aria-pressed")).toBe("true");
    });

    it("rebuilds the grid when an axis select changes", () => {
        const records = [
            image(1, { cfg_scale: "7", steps: "20", sampler: "Euler" }),
            image(2, { cfg_scale: "12", steps: "20", sampler: "DPM" }),
        ];
        renderRebuilder(records);

        expect(screen.getByTestId("xyz-x-header-7")).toBeTruthy();
        expect(screen.getByTestId("xyz-x-header-12")).toBeTruthy();

        fireEvent.change(screen.getByLabelText("X axis"), { target: { value: "sampler" } });

        expect(screen.queryByTestId("xyz-x-header-7")).toBeNull();
        expect(screen.getByTestId("xyz-x-header-DPM")).toBeTruthy();
        expect(screen.getByTestId("xyz-x-header-Euler")).toBeTruthy();
    });

    it("shows the metadata delta when two cells are selected", () => {
        const records = [
            image(1, { cfg_scale: "7", steps: "20", sampler: "Euler" }),
            image(2, { cfg_scale: "12", steps: "20", sampler: "Euler" }),
        ];
        renderRebuilder(records);

        fireEvent.click(screen.getByTestId("xyz-cell-7-20"));
        expect(screen.queryByTestId("xyz-delta")).toBeNull();
        fireEvent.click(screen.getByTestId("xyz-cell-12-20"));

        expect(screen.getByTestId("xyz-delta")).toBeTruthy();
        expect(screen.getByTestId("metadata-delta-table")).toBeTruthy();
    });

    it("is a labelled modal dialog with labelled selects and closes on Escape", () => {
        const { dialog, onClose } = renderRebuilder([
            image(1, { cfg_scale: "7", steps: "20", sampler: "Euler" }),
        ]);

        expect(dialog.getAttribute("aria-modal")).toBe("true");
        expect(dialog.getAttribute("aria-labelledby")).toBe("xyz-rebuilder-title");
        expect(screen.getByLabelText("X axis")).toBeTruthy();
        expect(screen.getByLabelText("Y axis")).toBeTruthy();
        expect(screen.getByLabelText("Z axis")).toBeTruthy();
        expect(screen.getByTestId("xyz-result-count").getAttribute("aria-live")).toBe("polite");
        expect(document.activeElement).toBe(dialog);

        fireEvent.keyDown(dialog, { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Reset restores the default axes and clears selected cells", () => {
        const { onPin } = renderRebuilder([
            image(1, { cfg_scale: "7", steps: "20", sampler: "Euler" }),
        ]);

        fireEvent.click(screen.getByTestId("xyz-cell-7-20"));
        expect(onPin).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("xyz-cell-7-20").getAttribute("aria-pressed")).toBe("true");

        fireEvent.click(screen.getByText("Reset"));
        expect(screen.getByTestId("xyz-cell-7-20").getAttribute("aria-pressed")).toBe("false");
        expect(screen.getByLabelText("X axis")).toBeTruthy();
    });
});
