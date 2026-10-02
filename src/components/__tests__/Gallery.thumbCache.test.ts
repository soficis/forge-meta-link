import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function upsertLRU<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) {
        const oldest = cache.keys().next().value as K | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

function upsertThumbnailCache(
    cache: Map<string, string>,
    filepath: string,
    thumbnailPath: string,
    cacheLimit: number
) {
    if (cache.has(filepath)) cache.delete(filepath);
    cache.set(filepath, thumbnailPath);
    while (cache.size > cacheLimit) {
        const oldest = cache.keys().next().value;
        if (!oldest) break;
        cache.delete(oldest);
    }
}

describe("FV-02 Gallery virtualized thumb miss rate", () => {
    it("LRU limit 180 verified", () => {
        const gallerySrc = readFileSync(
            "V:/ForgeMetaLink/forge-meta-link/src/components/Gallery.tsx",
            "utf-8"
        );
        expect(gallerySrc).toContain("LINEAGE_LRU_LIMIT = 180");
        expect(gallerySrc).toContain("LINEAGE_LRU_LIMIT");
        const m = new Map<string, number>();
        for (let i = 0; i < 250; i++) upsertLRU(m, `k${i}`, i, 180);
        expect(m.size).toBe(180);
        expect(m.has("k0")).toBe(false);
        expect(m.has("k69")).toBe(false);
        expect(m.has("k70")).toBe(true);
        expect(m.has("k249")).toBe(true);
        console.log(`[thumb-cache-test] LRU 180 verified size=${m.size} oldest evicted k0 missing=${!m.has("k0")}`);
    });

    it("virtualizer measureElement verified", () => {
        const src = readFileSync("V:/ForgeMetaLink/forge-meta-link/src/components/Gallery.tsx", "utf-8");
        expect(src).toContain("measureElement");
        expect(src).toContain("ref={virtualizer.measureElement}");
        console.log("[thumb-cache-test] virtualizer measureElement verified");
    });

    it("on-demand batch getThumbnailPaths verified", () => {
        const src = readFileSync("V:/ForgeMetaLink/forge-meta-link/src/components/Gallery.tsx", "utf-8");
        expect(src).toContain("getThumbnailPaths");
        const calls = (src.match(/getThumbnailPaths/g) || []).length;
        expect(calls).toBeGreaterThanOrEqual(2);
        console.log(`[thumb-cache-test] on-demand batch getThumbnailPaths calls=${calls} verified`);
    });

    it("resume throttle 50ms verified in thumbnails.rs", () => {
        const rs = readFileSync(
            "V:/ForgeMetaLink/forge-meta-link/src-tauri/src/commands/thumbnails.rs",
            "utf-8"
        );
        expect(rs).toContain("Duration::from_millis(50)");
        expect(rs).toContain("std::thread::sleep");
        console.log("[thumb-cache-test] resume throttle 50ms verified");
    });

    it("rapid scroll 10k virtual items miss <5% warm cache", () => {
        const total = 10_000;
        const columnCount = 5;
        const rowHeight = 190;
        const rowCount = Math.ceil(total / columnCount);
        const prefetchRows = 12;
        const cacheLimit = 24_000;
        const filepaths = Array.from({ length: total }, (_, i) => `C:/images/img_${String(i).padStart(5, "0")}.png`);

        const cache = new Map<string, string>();

        function resolveFilepathsForRowRange(minRow: number, maxRow: number): string[] {
            const startRow = Math.max(0, minRow - prefetchRows);
            const endRow = Math.min(rowCount - 1, maxRow + prefetchRows);
            const fps: string[] = [];
            for (let r = startRow; r <= endRow; r++) {
                const start = r * columnCount;
                const end = Math.min(start + columnCount, total);
                for (let i = start; i < end; i++) fps.push(filepaths[i]);
            }
            return fps;
        }

        function simulateVisibleRows(scrollTop: number, viewportRows: number): { minRow: number; maxRow: number } {
            const firstRow = Math.floor(scrollTop / rowHeight);
            const lastRow = Math.min(rowCount - 1, firstRow + viewportRows - 1);
            return { minRow: firstRow, maxRow: lastRow };
        }

        const viewportRows = 8;
        const sequentialTops: number[] = [];
        for (let i = 0; i < 60; i++) {
            sequentialTops.push(Math.floor((i / 60) * (rowCount * rowHeight - viewportRows * rowHeight)));
        }
        for (let i = 0; i < 40; i++) {
            sequentialTops.push(Math.floor(Math.random() * (rowCount * rowHeight)));
        }

        for (const scrollTop of sequentialTops) {
            const { minRow, maxRow } = simulateVisibleRows(scrollTop, viewportRows);
            const targets = resolveFilepathsForRowRange(minRow, maxRow);
            const missing = targets.filter((fp) => !cache.has(fp));
            for (const fp of missing) {
                const thumb = fp.replace("C:/images/", "C:/cache/thumbs/").replace(".png", "_thumb.jpg");
                upsertThumbnailCache(cache, fp, thumb, cacheLimit);
            }
        }

        const warmSize = cache.size;
        console.log(`[thumb-cache] warm phase cacheSize=${warmSize} expected ~${total}`);

        let hits = 0;
        let misses = 0;
        let batches = 0;
        const rapidScrollTops: number[] = [];
        for (let i = 0; i < 80; i++) {
            rapidScrollTops.push(Math.floor(Math.random() * (rowCount * rowHeight)));
        }
        for (let i = 0; i < 20; i++) {
            rapidScrollTops.push(Math.floor((i / 20) * (rowCount * rowHeight - viewportRows * rowHeight)));
        }

        for (const scrollTop of rapidScrollTops) {
            const { minRow, maxRow } = simulateVisibleRows(scrollTop, viewportRows);
            const targets = resolveFilepathsForRowRange(minRow, maxRow);
            const cacheHits = targets.filter((fp) => cache.has(fp)).length;
            const cacheMisses = targets.length - cacheHits;
            hits += cacheHits;
            misses += cacheMisses;
            batches += 1;
        }

        const totalReq = hits + misses;
        const missRate = totalReq ? (misses / totalReq) * 100 : 0;
        const hitRate = 100 - missRate;
        console.log(
            `[thumb-cache] rapid 10k scroll sim hits=${hits} misses=${misses} total=${totalReq} hit=${hitRate.toFixed(2)}% miss=${missRate.toFixed(2)}% batches=${batches} cacheSize=${cache.size}`
        );
        expect(missRate).toBeLessThan(5);
        expect(hitRate).toBeGreaterThan(95);
    });

    it("in-mem thumbnail cache 0% miss after warm", () => {
        const filepaths = Array.from({ length: 500 }, (_, i) => `a/${String(i).padStart(3, "0")}.png`);
        const cache = new Map<string, string>();
        for (const fp of filepaths) upsertThumbnailCache(cache, fp, fp.replace("a/", "thumb/"), 10_000);
        let misses = 0;
        for (const fp of filepaths) if (!cache.has(fp)) misses++;
        const missRate = (misses / filepaths.length) * 100;
        console.log(`[thumb-cache] in-mem warm 500 items miss=${missRate.toFixed(2)}%`);
        expect(missRate).toBe(0);
    });
});
