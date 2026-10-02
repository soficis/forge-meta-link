export interface Bucket {
    start: number;
    end: number;
    count: number;
    intensity: number;
}

export const DAY_SEC = 86400;
export const WEEK_SEC = 604800;

export function chooseBucketSize(mtimes: number[]): number {
    if (mtimes.length === 0) return DAY_SEC;
    let min = mtimes[0];
    let max = mtimes[0];
    for (let i = 1; i < mtimes.length; i++) {
        const v = mtimes[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const spanDays = (max - min) / DAY_SEC;
    if (spanDays <= 45) return DAY_SEC;
    return WEEK_SEC;
}

export function bucketMtimes(mtimes: number[], bucketSec?: number): Bucket[] {
    if (mtimes.length === 0) return [];
    const size = bucketSec ?? chooseBucketSize(mtimes);
    let min = mtimes[0];
    let max = mtimes[0];
    for (let i = 1; i < mtimes.length; i++) {
        const v = mtimes[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const startBucket = Math.floor(min / size) * size;
    const endBucket = Math.floor(max / size) * size;
    const bucketCount = Math.floor((endBucket - startBucket) / size) + 1;
    if (bucketCount > 500) {
        return bucketMtimes(mtimes, WEEK_SEC);
    }
    const counts = new Map<number, number>();
    for (const t of mtimes) {
        const b = Math.floor(t / size) * size;
        counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    let maxCount = 0;
    for (const c of counts.values()) if (c > maxCount) maxCount = c;
    if (maxCount === 0) maxCount = 1;
    const buckets: Bucket[] = [];
    for (let b = startBucket; b <= endBucket; b += size) {
        const c = counts.get(b) ?? 0;
        buckets.push({ start: b, end: b + size, count: c, intensity: c / maxCount });
    }
    return buckets;
}

export function formatBucketLabel(startSec: number, bucketSec: number): string {
    const d = new Date(startSec * 1000);
    if (bucketSec === DAY_SEC) {
        return d.toISOString().slice(0, 10);
    }
    const end = new Date((startSec + bucketSec - 1) * 1000);
    return `${d.toISOString().slice(0, 10)}→${end.toISOString().slice(0, 10)}`;
}
