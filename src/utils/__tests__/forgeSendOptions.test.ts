import { describe, it, expect } from "vitest";
import {
    buildLoraWeightMap,
    parseBatchCount,
    FORGE_BATCH_COUNT_MAX,
} from "../forgeSendOptions";

describe("buildLoraWeightMap", () => {
    it("includes only selected LoRAs with a valid typed weight", () => {
        const map = buildLoraWeightMap(["a", "b", "c"], {
            a: "0.55",
            b: "  ",
            removed: "2",
            c: "abc",
        });
        expect(map).toEqual({ a: 0.55 });
    });

    it("keeps a weight of 0 and negative weights", () => {
        expect(buildLoraWeightMap(["a", "b"], { a: "0", b: "-0.5" })).toEqual({ a: 0, b: -0.5 });
    });

    it("returns null when nothing is overridden", () => {
        expect(buildLoraWeightMap(["a"], {})).toBeNull();
        expect(buildLoraWeightMap([], { a: "1" })).toBeNull();
    });
});

describe("parseBatchCount", () => {
    it("treats an empty field as no override", () => {
        expect(parseBatchCount("")).toEqual({ value: null, error: null });
        expect(parseBatchCount("  ")).toEqual({ value: null, error: null });
    });

    it("accepts whole numbers in range", () => {
        expect(parseBatchCount("1").value).toBe(1);
        expect(parseBatchCount(String(FORGE_BATCH_COUNT_MAX)).value).toBe(FORGE_BATCH_COUNT_MAX);
    });

    it.each(["0", "-1", "2.5", "abc", String(FORGE_BATCH_COUNT_MAX + 1)])(
        "rejects %s",
        (text) => {
            const result = parseBatchCount(text);
            expect(result.value).toBeNull();
            expect(result.error).toMatch(/whole number/);
        }
    );
});
