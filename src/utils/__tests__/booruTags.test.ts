import { describe, it, expect } from "vitest";
import { parseBooruTagFilter } from "../booruTags";

describe("parseBooruTagFilter", () => {
    it("handles empty or whitespace strings", () => {
        expect(parseBooruTagFilter("")).toEqual({ include: [], exclude: [] });
        expect(parseBooruTagFilter("   ")).toEqual({ include: [], exclude: [] });
    });

    it("parses simple inclusions and exclusions", () => {
        const result = parseBooruTagFilter("cat dog -fish -bird");
        expect(result.include).toEqual(["cat", "dog"]);
        expect(result.exclude).toEqual(["fish", "bird"]);
    });

    it("handles quoted phrases for inclusion and exclusion", () => {
        const result = parseBooruTagFilter('"blue eyes" -"bad hands" -"mutated fingers" "master piece"');
        expect(result.include).toEqual(["blue eyes", "master piece"]);
        expect(result.exclude).toEqual(["bad hands", "mutated fingers"]);
    });

    it("handles comma-separated tokens without keeping trailing commas", () => {
        const result = parseBooruTagFilter("cat, dog, -bad_hands, -lowres,");
        expect(result.include).toEqual(["cat", "dog"]);
        expect(result.exclude).toEqual(["bad_hands", "lowres"]);
    });

    it("handles mixed quotes, commas, and explicit plus prefix", () => {
        const result = parseBooruTagFilter('+anime, +"high res", -"low quality", bad_anatomy');
        expect(result.include).toEqual(["anime", "high res", "bad_anatomy"]);
        expect(result.exclude).toEqual(["low quality"]);
    });

    it("prioritizes exclusion when a tag appears in both include and exclude", () => {
        const result = parseBooruTagFilter("cat -cat dog");
        expect(result.include).toEqual(["dog"]);
        expect(result.exclude).toEqual(["cat"]);
    });

    it("normalizes to lowercase and deduplicates tokens", () => {
        const result = parseBooruTagFilter("Cat CAT -DOG -dog");
        expect(result.include).toEqual(["cat"]);
        expect(result.exclude).toEqual(["dog"]);
    });
});
