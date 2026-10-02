import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CompareLab } from "../CompareLab";
import { useCompareLabStore } from "../../store/compareLabStore";
import type { GalleryImageRecord } from "../../types/metadata";

function gallery(id: number, seed: string | null = "12345"): GalleryImageRecord {
  return {
    id,
    filepath: `/tmp/${id}.png`,
    filename: `${id}.png`,
    directory: "/tmp",
    seed,
    width: 512,
    height: 512,
    model_name: "test_model.safetensors",
    is_favorite: false,
    is_locked: false,
    file_mtime: null,
  };
}

beforeAll(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      convertFileSrc: (filePath: string) =>
        `asset://localhost/${encodeURIComponent(filePath)}`,
      invoke: () => Promise.reject(new Error("invoke unavailable in tests")),
      transformCallback: () => 0,
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("CompareLab mount smoke", () => {
  beforeEach(() => {
    useCompareLabStore.getState().clear();
  });

  it("renders the compare-lab dock when two images are pinned", () => {
    useCompareLabStore.setState({ pins: [gallery(1), gallery(2)] });
    render(<CompareLab />);
    expect(screen.getByTestId("compare-lab")).not.toBeNull();
    expect(screen.getByTestId("compare-count").textContent).toContain("2/4");
    expect(screen.getByTestId("swipe-slider")).not.toBeNull();
  });

  it("renders nothing when no images are pinned", () => {
    render(<CompareLab />);
    expect(screen.queryByTestId("compare-lab")).toBeNull();
  });

  it("handles winner selection, opens mutation popover, and tracks sweep combinatorics", () => {
    useCompareLabStore.setState({ pins: [gallery(1), gallery(2)] });
    render(<CompareLab />);

    // Initially no mutate winner button
    expect(screen.queryByTestId("mutate-winner-btn")).toBeNull();

    // Click win button on pin 1
    const winBtn1 = screen.getByTestId("pin-winner-1");
    fireEvent.click(winBtn1);

    expect(useCompareLabStore.getState().winnerId).toBe(1);

    // Mutate winner button should now appear
    const mutateBtn = screen.getByTestId("mutate-winner-btn");
    expect(mutateBtn).not.toBeNull();

    // Click mutate winner button to open popover
    fireEvent.click(mutateBtn);

    const dialog = screen.getByTestId("mutation-popover");
    expect(dialog).not.toBeNull();

    // Select Seed +1, +2, +3 (3 options)
    fireEvent.click(screen.getByTestId("checkbox-seed-1"));
    fireEvent.click(screen.getByTestId("checkbox-seed-2"));
    fireEvent.click(screen.getByTestId("checkbox-seed-3"));

    // Select CFG -1.0, +1.0 (2 options)
    fireEvent.click(screen.getByTestId("checkbox-cfg-minus-1"));
    fireEvent.click(screen.getByTestId("checkbox-cfg-plus-1"));

    // Select Steps -5, +5 (2 options) => 3 * 2 * 2 = 12 variants (> 8, triggers warning)
    fireEvent.click(screen.getByTestId("checkbox-steps-minus-5"));
    fireEvent.click(screen.getByTestId("checkbox-steps-plus-5"));

    // Sweep size badge should show 12 variants
    const badge = screen.getByTestId("sweep-count-badge");
    expect(badge.textContent).toBe("12 variants");

    // Because 12 > 8, confirmation notice should be displayed
    expect(screen.getByText(/Confirmation required \(>8\)/)).not.toBeNull();

    // Clicking Send Sweep triggers the confirm dialog overlay
    fireEvent.click(screen.getByTestId("sweep-send-btn"));
    const confirmDialog = screen.getByTestId("sweep-confirm-dialog");
    expect(confirmDialog).not.toBeNull();
    expect(confirmDialog.textContent).toContain("Generate 12 variants?");

    // Close button dismisses popover
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByTestId("mutation-popover")).toBeNull();
  });

  it("unpinning winner resets winnerId to null", () => {
    useCompareLabStore.setState({ pins: [gallery(1), gallery(2)], winnerId: 1 });
    render(<CompareLab />);

    expect(screen.getByTestId("mutate-winner-btn")).not.toBeNull();

    // Remove pin 1
    const removeBtn1 = screen.getByLabelText("Remove 1.png");
    fireEvent.click(removeBtn1);

    expect(useCompareLabStore.getState().winnerId).toBeNull();
    expect(screen.queryByTestId("mutate-winner-btn")).toBeNull();
  });
});

