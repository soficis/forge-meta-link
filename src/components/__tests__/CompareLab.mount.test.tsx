import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompareLab } from "../CompareLab";
import { useCompareLabStore } from "../../store/compareLabStore";
import type { GalleryImageRecord } from "../../types/metadata";

function gallery(id: number): GalleryImageRecord {
  return {
    id,
    filepath: `/tmp/${id}.png`,
    filename: `${id}.png`,
    directory: "/tmp",
    seed: null,
    width: 512,
    height: 512,
    model_name: null,
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
});
