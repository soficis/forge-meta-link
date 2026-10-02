import { describe, it, expect } from "vitest";
import {
    extractLoras,
    computeDelta,
    isKeyChanged,
    toCompareMetadata,
    parseScheduleType,
} from "../metadata";
import type { GalleryImageRecord, ImageRecord } from "../../types/metadata";

function gallery(over: Partial<GalleryImageRecord> & { id: number }): GalleryImageRecord {
    return {
        filepath: `/tmp/${over.id}.png`,
        filename: `${over.id}.png`,
        directory: "/tmp",
        seed: null,
        width: null,
        height: null,
        model_name: null,
        is_favorite: false,
        is_locked: false,
        file_mtime: null,
        ...over,
    } as GalleryImageRecord;
}

function detail(over: Partial<ImageRecord> & { id: number }): ImageRecord {
    return {
        filepath: `/tmp/${over.id}.png`,
        filename: `${over.id}.png`,
        directory: "/tmp",
        prompt: "",
        negative_prompt: "",
        steps: null,
        sampler: null,
        cfg_scale: null,
        model_hash: null,
        model_name: null,
        seed: null,
        width: null,
        height: null,
        raw_metadata: "",
        is_favorite: false,
        is_locked: false,
        file_mtime: null,
        ...over,
    } as ImageRecord;
}

describe("extractLoras", () => {
    it("extracts lora tags case-insensitive, deduped sorted", () => {
        const txt = "foo <lora:MyLoRA:0.7> bar <lora:other:1> <lora:MyLoRA:0.8>";
        expect(extractLoras(txt)).toEqual(["mylora", "other"]);
    });
    it("empty returns []", () => {
        expect(extractLoras(null)).toEqual([]);
        expect(extractLoras("no loras here")).toEqual([]);
    });
});

describe("parseScheduleType", () => {
    it("parses Schedule type", () => {
        expect(parseScheduleType("Steps: 20, Schedule type: Karras, CFG: 7")).toBe("Karras");
        expect(parseScheduleType("Schedule: Euler, Seed: 1")).toBe("Euler");
        expect(parseScheduleType("no schedule")).toBeNull();
    });
});

describe("computeDelta - highlight changed keys", () => {
    it("detects seed change", () => {
        const g1 = gallery({ id: 1, seed: "123" });
        const g2 = gallery({ id: 2, seed: "999" });
        const metas = [toCompareMetadata(g1), toCompareMetadata(g2)];
        const delta = computeDelta(metas);
        expect(isKeyChanged(metas, "seed")).toBe(true);
        expect(delta.changedKeys.has("seed")).toBe(true);
    });

    it("no change when identical", () => {
        const g1 = gallery({ id: 1, seed: "42", model_name: "pony", width: 512, height: 512 });
        const g2 = gallery({ id: 2, seed: "42", model_name: "pony", width: 512, height: 512 });
        const d1 = detail({ id: 1, seed: "42", sampler: "Euler", cfg_scale: "7", model_name: "pony", width: 512, height: 512, raw_metadata: "Steps: 20, Sampler: Euler, CFG scale: 7, Schedule type: Karras", prompt: "" });
        const d2 = detail({ id: 2, seed: "42", sampler: "Euler", cfg_scale: "7", model_name: "pony", width: 512, height: 512, raw_metadata: "Steps: 20, Sampler: Euler, CFG scale: 7, Schedule type: Karras", prompt: "" });
        const metas = [toCompareMetadata(g1, d1), toCompareMetadata(g2, d2)];
        const delta = computeDelta(metas);
        expect(delta.hasAnyChange).toBe(false);
        expect(delta.changedKeys.size).toBe(0);
    });

    it("detects cfg / sampler / schedule / model / lora / resolution", () => {
        const g1 = gallery({ id: 1, seed: "1", model_name: "modelA", width: 512, height: 768 });
        const g2 = gallery({ id: 2, seed: "1", model_name: "modelB", width: 768, height: 512 });
        const d1 = detail({
            id: 1, seed: "1", cfg_scale: "5", sampler: "Euler", model_name: "modelA", width: 512, height: 768,
            raw_metadata: "Steps: 20, Sampler: Euler, CFG scale: 5, Schedule type: Karras, Model: modelA <lora:foo:0.7>", prompt: "<lora:foo:0.7> cat"
        });
        const d2 = detail({
            id: 2, seed: "1", cfg_scale: "7", sampler: "DPM++", model_name: "modelB", width: 768, height: 512,
            raw_metadata: "Steps: 20, Sampler: DPM++, CFG scale: 7, Schedule type: Normal, Model: modelB", prompt: "dog"
        });
        const metas = [toCompareMetadata(g1, d1), toCompareMetadata(g2, d2)];
        expect(isKeyChanged(metas, "cfg")).toBe(true);
        expect(isKeyChanged(metas, "sampler")).toBe(true);
        expect(isKeyChanged(metas, "schedule")).toBe(true);
        expect(isKeyChanged(metas, "model")).toBe(true);
        expect(isKeyChanged(metas, "lora")).toBe(true);
        expect(isKeyChanged(metas, "resolution")).toBe(true);
        expect(isKeyChanged(metas, "seed")).toBe(false);
    });

    it("delta rows highlight flag matches changedKeys", () => {
        const g1 = gallery({ id: 1, seed: "10" });
        const g2 = gallery({ id: 2, seed: "20" });
        const metas = [toCompareMetadata(g1), toCompareMetadata(g2)];
        const { rows } = computeDelta(metas);
        const seedRow = rows.find((r) => r.key === "seed")!;
        expect(seedRow.isChanged).toBe(true);
        expect(seedRow.values).toEqual(["10", "20"]);
        const cfgRow = rows.find((r) => r.key === "cfg")!;
        expect(cfgRow.isChanged).toBe(false);
    });

    it("handles 2-4 pins resolution diff", () => {
        const metas = [
            toCompareMetadata(gallery({ id: 1, width: 1024, height: 1024 })),
            toCompareMetadata(gallery({ id: 2, width: 512, height: 512 })),
            toCompareMetadata(gallery({ id: 3, width: 1024, height: 1024 })),
        ];
        expect(isKeyChanged(metas, "resolution")).toBe(true);
        const same = [
            toCompareMetadata(gallery({ id: 1, width: 512, height: 512 })),
            toCompareMetadata(gallery({ id: 2, width: 512, height: 512 })),
        ];
        expect(isKeyChanged(same, "resolution")).toBe(false);
    });
});
