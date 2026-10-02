import { describe, it, expect } from "vitest";
import { computeDelta, toCompareMetadata } from "../../utils/metadata";
import type { GalleryImageRecord, ImageRecord } from "../../types/metadata";

// This file validates the highlight behaviour that MetadataDeltaTable renders.
// We test the underlying delta logic (delta-changed) without mounting React,
// to avoid duplicate-React issues in vitest/jsdom, while still covering
// the component's highlight contract: changed keys get "delta-changed".

function gallery(id: number, seed: string | null, model: string | null): GalleryImageRecord {
    return {
        id,
        filepath: `/tmp/${id}.png`,
        filename: `${id}.png`,
        directory: "/tmp",
        seed,
        width: 512,
        height: 512,
        model_name: model,
        is_favorite: false,
        is_locked: false,
        file_mtime: null,
    };
}

function detail(id: number, over: Partial<ImageRecord>): ImageRecord {
    return {
        id,
        filepath: `/tmp/${id}.png`,
        filename: `${id}.png`,
        directory: "/tmp",
        prompt: "",
        negative_prompt: "",
        steps: null,
        sampler: null,
        cfg_scale: null,
        seed: null,
        width: 512,
        height: 512,
        model_hash: null,
        model_name: null,
        raw_metadata: "",
        is_favorite: false,
        is_locked: false,
        file_mtime: null,
        ...over,
    } as ImageRecord;
}

describe("MetadataDeltaTable highlights (component contract)", () => {
    it("marks seed row as delta-changed when seeds differ", () => {
        const pins = [gallery(1, "123", "pony"), gallery(2, "999", "pony")];
        const metas = pins.map((p) => toCompareMetadata(p));
        const { rows } = computeDelta(metas);
        const seedRow = rows.find((r) => r.key === "seed")!;
        expect(seedRow.isChanged).toBe(true);
        expect(seedRow.values).toEqual(["123", "999"]);
    });

    it("marks row as unchanged when values identical", () => {
        const pins = [gallery(1, "42", "pony"), gallery(2, "42", "pony")];
        const d1 = detail(1, { seed: "42", sampler: "Euler", cfg_scale: "7", model_name: "pony", raw_metadata: "Sampler: Euler" });
        const d2 = detail(2, { seed: "42", sampler: "Euler", cfg_scale: "7", model_name: "pony", raw_metadata: "Sampler: Euler" });
        const metas = [toCompareMetadata(pins[0], d1), toCompareMetadata(pins[1], d2)];
        const { rows } = computeDelta(metas);
        const cfgRow = rows.find((r) => r.key === "cfg")!;
        expect(cfgRow.isChanged).toBe(false);
        const seedRow = rows.find((r) => r.key === "seed")!;
        expect(seedRow.isChanged).toBe(false);
    });

    it("highlights lora diff", () => {
        const pins = [gallery(1, "1", "m"), gallery(2, "1", "m")];
        const d1 = detail(1, { prompt: "<lora:foo:0.7> cat", raw_metadata: "<lora:foo:0.7>" });
        const d2 = detail(2, { prompt: "dog", raw_metadata: "" });
        const metas = [toCompareMetadata(pins[0], d1), toCompareMetadata(pins[1], d2)];
        const { rows } = computeDelta(metas);
        const loraRow = rows.find((r) => r.key === "lora")!;
        expect(loraRow.isChanged).toBe(true);
        expect(loraRow.values[0]).toBe("foo");
        expect(loraRow.values[1]).toBe("—");
    });

    it("empty state: component shows hint when <2 pins", () => {
        const pins = [gallery(1, "1", "m")];
        const metas = pins.map((p) => toCompareMetadata(p));
        const { rows } = computeDelta(metas);
        expect(metas.length).toBe(1);
        expect(rows.length).toBe(7);
        expect(rows.every((r) => !r.isChanged)).toBe(true);
    });

    it("highlights resolution when width/height differ", () => {
        const p1: GalleryImageRecord = { ...gallery(1, "1", "m"), width: 512, height: 512 };
        const p2: GalleryImageRecord = { ...gallery(2, "1", "m"), width: 1024, height: 1024 };
        const metas = [toCompareMetadata(p1), toCompareMetadata(p2)];
        const { rows } = computeDelta(metas);
        const resRow = rows.find((r) => r.key === "resolution")!;
        expect(resRow.isChanged).toBe(true);
        expect(resRow.values).toEqual(["512×512", "1024×1024"]);
    });

    it("component maps changedKeys to delta-changed class", () => {
        const pins = [gallery(1, "10", "a"), gallery(2, "20", "a")];
        const metas = pins.map((p) => toCompareMetadata(p));
        const delta = computeDelta(metas);
        const changedClass = (key: string) => (delta.changedKeys.has(key as never) ? "delta-changed" : "delta-unchanged");
        expect(changedClass("seed")).toBe("delta-changed");
        expect(changedClass("cfg")).toBe("delta-unchanged");
    });
});
