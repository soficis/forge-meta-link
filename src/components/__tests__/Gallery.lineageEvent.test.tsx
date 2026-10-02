import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { Gallery } from "../Gallery";
import type { GalleryImageRecord, LineageCursor } from "../../types/metadata";
import * as commands from "../../services/commands";

type ListenerCallback = (event: { payload: unknown }) => void;
const listeners: Record<string, ListenerCallback[]> = {};

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn((eventName: string, callback: ListenerCallback) => {
        if (!listeners[eventName]) {
            listeners[eventName] = [];
        }
        listeners[eventName].push(callback);
        return Promise.resolve(() => {
            listeners[eventName] = (listeners[eventName] || []).filter((cb) => cb !== callback);
        });
    }),
}));

vi.mock("@tauri-apps/api/core", () => ({
    convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
        getVirtualItems: () =>
            Array.from({ length: Math.min(count, 1) }, (_, index) => ({
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

vi.mock("../../services/commands", () => ({
    getThumbnailPaths: vi.fn().mockResolvedValue([]),
    getLineageCursor: vi.fn(),
}));

function mockImage(id: number, filepath: string): GalleryImageRecord {
    return {
        id,
        filepath,
        filename: `${id}.png`,
        directory: "/dir",
        seed: "123",
        width: 512,
        height: 512,
        model_name: "test-model",
        is_favorite: false,
        is_locked: false,
        file_mtime: 1000,
    };
}

describe("Gallery lineage-updated event listener", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const k of Object.keys(listeners)) {
            delete listeners[k];
        }
    });

    it("registers a listener for lineage-updated and unlistens on unmount", async () => {
        const { unmount } = render(
            <Gallery
                images={[mockImage(1, "/dir/1.png")]}
                onSelect={() => {}}
                selectedId={null}
                selectedIds={new Set()}
                onToggleSelected={() => {}}
                onAddToSelection={() => {}}
                onSelectAll={() => {}}
                onClearSelection={() => {}}
                onDeleteSelected={() => {}}
                isDeletingSelected={false}
                onLoadMore={() => {}}
                hasMore={false}
                isFetchingNextPage={false}
                columnCount={4}
                storageProfile="hdd"
                onShowToast={() => {}}
                emptyState={{ title: "Empty", message: "No images" }}
            />
        );

        await act(async () => {
            await Promise.resolve();
        });

        expect(listeners["lineage-updated"]).toBeDefined();
        expect(listeners["lineage-updated"].length).toBe(1);

        unmount();

        expect(listeners["lineage-updated"].length).toBe(0);
    });

    it("clears lineage cache and re-queries cursor when lineage-updated fires", async () => {
        const cursor1: LineageCursor = {
            ancestors: [],
            children: [],
        };
        const cursor2: LineageCursor = {
            ancestors: [
                {
                    child_filepath: "/dir/1.png",
                    parent_filepath: "/dir/parent.png",
                    relation: "seed_walk",
                    confidence: 0.9,
                    created_at: 1000,
                },
            ],
            children: [],
        };

        const getLineageCursorSpy = vi
            .mocked(commands.getLineageCursor)
            .mockResolvedValueOnce(cursor1)
            .mockResolvedValueOnce(cursor2);

        vi.useFakeTimers();

        const { container } = render(
            <Gallery
                images={[mockImage(1, "/dir/1.png")]}
                onSelect={() => {}}
                selectedId={null}
                selectedIds={new Set()}
                onToggleSelected={() => {}}
                onAddToSelection={() => {}}
                onSelectAll={() => {}}
                onClearSelection={() => {}}
                onDeleteSelected={() => {}}
                isDeletingSelected={false}
                onLoadMore={() => {}}
                hasMore={false}
                isFetchingNextPage={false}
                columnCount={4}
                storageProfile="hdd"
                onShowToast={() => {}}
                emptyState={{ title: "Empty", message: "No images" }}
            />
        );

        await act(async () => {
            await Promise.resolve();
        });

        const card = container.querySelector('[data-image-id="1"]');
        expect(card).not.toBeNull();

        // Hover over the card to trigger scheduleLineageFetch
        fireEvent.mouseEnter(card!);
        await act(async () => {
            vi.advanceTimersByTime(250);
            await Promise.resolve();
        });

        expect(getLineageCursorSpy).toHaveBeenCalledTimes(1);
        expect(getLineageCursorSpy).toHaveBeenCalledWith("/dir/1.png");

        // Hover again while cached - should NOT fetch again
        fireEvent.mouseLeave(card!);
        fireEvent.mouseEnter(card!);
        await act(async () => {
            vi.advanceTimersByTime(250);
            await Promise.resolve();
        });
        expect(getLineageCursorSpy).toHaveBeenCalledTimes(1);

        // Fire lineage-updated event: cache must be cleared and hover item refetched
        await act(async () => {
            for (const cb of listeners["lineage-updated"] || []) {
                cb({ payload: { edges: 5 } });
            }
            vi.advanceTimersByTime(250);
            await Promise.resolve();
        });

        expect(getLineageCursorSpy).toHaveBeenCalledTimes(2);

        vi.useRealTimers();
    });
});
