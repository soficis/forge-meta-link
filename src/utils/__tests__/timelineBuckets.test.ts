import { describe, it, expect } from "vitest";
import { bucketMtimes, chooseBucketSize, DAY_SEC, WEEK_SEC } from "../timelineBuckets";

describe("chooseBucketSize", () => {
    it("picks DAY for span <=45d", () => {
        const now = 1700000000;
        expect(chooseBucketSize([now, now + 10 * DAY_SEC])).toBe(DAY_SEC);
        expect(chooseBucketSize([now, now + 45 * DAY_SEC])).toBe(DAY_SEC);
    });
    it("picks WEEK for span >45d", () => {
        const now = 1700000000;
        expect(chooseBucketSize([now, now + 60 * DAY_SEC])).toBe(WEEK_SEC);
        expect(chooseBucketSize([now, now + 400 * DAY_SEC])).toBe(WEEK_SEC);
    });
});

describe("bucketMtimes", () => {
    it("buckets single day correctly", () => {
        const base = 1710000000;
        const dayStart = Math.floor(base / DAY_SEC) * DAY_SEC;
        const mtimes = [dayStart + 100, dayStart + 200, dayStart + 5000, dayStart + DAY_SEC + 100];
        const buckets = bucketMtimes(mtimes, DAY_SEC);
        expect(buckets.length).toBe(2);
        expect(buckets[0].count).toBe(3);
        expect(buckets[1].count).toBe(1);
        expect(buckets[0].intensity).toBe(1);
        expect(buckets[1].intensity).toBeCloseTo(1 / 3);
    });

    it("empty returns []", () => {
        expect(bucketMtimes([])).toEqual([]);
    });

    it("handles 50k synthetic in <1s and covers all items", () => {
        const base = 1700000000;
        const mtimes: number[] = new Array(50000);
        for (let i = 0; i < 50000; i++) mtimes[i] = base + (i % 60) * DAY_SEC + (i % 86400);
        const t0 = performance.now();
        const buckets = bucketMtimes(mtimes);
        const dt = performance.now() - t0;
        expect(dt).toBeLessThan(1000);
        const total = buckets.reduce((s, b) => s + b.count, 0);
        expect(total).toBe(50000);
        expect(buckets.length).toBeGreaterThan(0);
        expect(buckets.length).toBeLessThan(500);
    });

    it("adaptive switches to week for large span", () => {
        const base = 1700000000;
        const mtimes: number[] = [];
        for (let i = 0; i < 100; i++) mtimes.push(base + i * 10 * DAY_SEC);
        const buckets = bucketMtimes(mtimes);
        const span = mtimes[mtimes.length - 1] - mtimes[0];
        const chosen = span / DAY_SEC > 45 ? WEEK_SEC : DAY_SEC;
        expect(buckets[1].end - buckets[1].start).toBe(chosen);
    });
});
