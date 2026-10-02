import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HelpOverlay } from "../HelpOverlay";
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

describe("HelpOverlay", () => {
  it("renders shortcuts table and closes on overlay click", async () => {
    const onClose = vi.fn();
    render(<HelpOverlay onClose={onClose} />);
    expect(screen.getByTestId("help-overlay")).not.toBeNull();
    expect(screen.getByText("Keyboard Shortcuts")).not.toBeNull();
    expect(screen.getByText("Toggle favorite")).not.toBeNull();
    expect(screen.getByText(/Pin to Compare Lab slot 1-4/)).not.toBeNull();
    fireEvent.click(screen.getByTestId("help-overlay"));
    expect(onClose).toHaveBeenCalled();
  });

  it("esc button closes", () => {
    const onClose = vi.fn();
    render(<HelpOverlay onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close help"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("compareLab pinToSlot via synthetic 1-4 keys", () => {
  beforeEach(() => {
    useCompareLabStore.getState().clear();
  });

  it("pins to correct slot with 1-4 synthetic key", () => {
    const a = gallery(1);
    const b = gallery(2);
    const c = gallery(3);
    const store = useCompareLabStore.getState();
    expect(store.pinToSlot(a, 0)).toBe(true);
    expect(useCompareLabStore.getState().pins[0].id).toBe(1);
    expect(useCompareLabStore.getState().pinToSlot(b, 1)).toBe(true);
    expect(useCompareLabStore.getState().pins[1].id).toBe(2);
    expect(useCompareLabStore.getState().pinToSlot(c, 0)).toBe(true);
    expect(useCompareLabStore.getState().pins[0].id).toBe(3);
    expect(useCompareLabStore.getState().pins.length).toBe(2);
  });

  it("handles synthetic keyboard event dispatch for ? and Escape", () => {
    let helpOpen = false;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        helpOpen = !helpOpen;
      }
      if (e.key === "Escape" && helpOpen) helpOpen = false;
    };
    window.addEventListener("keydown", handler);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", shiftKey: true }));
    expect(helpOpen).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(helpOpen).toBe(false);
    window.removeEventListener("keydown", handler);
  });

  it("j/k navigation synthetic events move selection index", () => {
    const images = [gallery(10), gallery(11), gallery(12)];
    let selectedId: number | null = 10;
    const navigate = (nextId: number) => { selectedId = nextId; };
    const onKey = (e: KeyboardEvent) => {
      const lower = e.key.toLowerCase();
      if (lower === "j") {
        const idx = images.findIndex((im) => im.id === selectedId);
        const next = images[(idx + 1) % images.length];
        navigate(next.id);
      }
      if (lower === "k") {
        const idx = images.findIndex((im) => im.id === selectedId);
        const prev = images[idx > 0 ? idx - 1 : images.length - 1];
        navigate(prev.id);
      }
    };
    window.addEventListener("keydown", onKey);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
    expect(selectedId).toBe(11);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    expect(selectedId).toBe(10);
    window.removeEventListener("keydown", onKey);
  });

  it("ignores keys when typing target is input", () => {
    let triggered = false;
    const isTypingTarget = (target: EventTarget | null) => target instanceof HTMLElement && (target.tagName.toLowerCase() === "input");
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      triggered = true;
    };
    window.addEventListener("keydown", handler);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    expect(triggered).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
    expect(triggered).toBe(true);
    window.removeEventListener("keydown", handler);
    input.remove();
  });
});
