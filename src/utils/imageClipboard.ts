import { convertFileSrc } from "@tauri-apps/api/core";
import {
    getDisplayImagePath,
    getImageClipboardPayload,
} from "../services/commands";

const DISCORD_SAFE_MAX_BYTES = 8 * 1024 * 1024;
const DISCORD_SAFE_MAX_EDGE = 1920;
const JPEG_QUALITY_STEPS = [0.9, 0.84, 0.78, 0.72, 0.66, 0.6, 0.54];

export interface ClipboardCompressionResult {
    width: number;
    height: number;
    bytes: number;
    mime: string;
}

function supportsClipboardMime(mime: string): boolean {
    if (typeof ClipboardItem === "undefined") {
        return false;
    }
    const supportsFn = (ClipboardItem as unknown as { supports?: (type: string) => boolean })
        .supports;
    if (typeof supportsFn !== "function") {
        return true;
    }
    try {
        return supportsFn(mime);
    } catch {
        return true;
    }
}

async function writeBlobToClipboard(
    preferredBlob: Blob,
    fallbackBlob?: Blob
): Promise<Blob> {
    if (
        typeof ClipboardItem === "undefined" ||
        !navigator.clipboard ||
        typeof navigator.clipboard.write !== "function"
    ) {
        throw new Error("Image clipboard write is not supported in this environment");
    }

    const candidates: Blob[] = [];
    if (supportsClipboardMime(preferredBlob.type)) {
        candidates.push(preferredBlob);
    }
    if (fallbackBlob && fallbackBlob.type !== preferredBlob.type) {
        candidates.push(fallbackBlob);
    }
    if (candidates.length === 0) {
        candidates.push(preferredBlob);
        if (fallbackBlob && fallbackBlob.type !== preferredBlob.type) {
            candidates.push(fallbackBlob);
        }
    }

    let lastError: unknown = null;
    for (const candidate of candidates) {
        try {
            const clipboardItem = new ClipboardItem({ [candidate.type]: candidate });
            await navigator.clipboard.write([clipboardItem]);
            return candidate;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError ?? "Clipboard write failed"));
}

function fitToMaxEdge(width: number, height: number, maxEdge: number): {
    width: number;
    height: number;
} {
    if (width <= maxEdge && height <= maxEdge) {
        return { width, height };
    }
    if (width >= height) {
        const ratio = maxEdge / width;
        return {
            width: maxEdge,
            height: Math.max(1, Math.round(height * ratio)),
        };
    }
    const ratio = maxEdge / height;
    return {
        width: Math.max(1, Math.round(width * ratio)),
        height: maxEdge,
    };
}

async function loadImage(filepath: string): Promise<HTMLImageElement> {
    const resolvedPath = await getDisplayImagePath(filepath).catch(() => filepath);
    const payload = await getImageClipboardPayload(resolvedPath);
    const normalizedBase64 = payload.base64.replace(/\s+/g, "");
    const binary = atob(normalizedBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }

    const blob = new Blob([bytes], {
        type: payload.mime?.trim() ? payload.mime : "application/octet-stream",
    });
    const blobUrl = URL.createObjectURL(blob);

    try {
        return await new Promise((resolve, reject) => {
            const image = new Image();
            image.decoding = "async";
            image.onload = () => resolve(image);
            image.onerror = () =>
                reject(new Error(`Failed to load image for clipboard: ${filepath}`));
            image.src = blobUrl;
        });
    } catch {
        return await new Promise((resolve, reject) => {
            const image = new Image();
            image.decoding = "async";
            image.crossOrigin = "anonymous";
            image.onload = () => resolve(image);
            image.onerror = () =>
                reject(new Error(`Failed to load image for clipboard: ${filepath}`));
            image.src = convertFileSrc(filepath);
        });
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

function drawResizedImage(
    source: HTMLImageElement,
    width: number,
    height: number
): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("Canvas context unavailable");
    }

    // Flatten alpha for broad clipboard/paste compatibility.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    return canvas;
}

async function canvasToBlob(
    canvas: HTMLCanvasElement,
    mime: string,
    quality: number
): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (!blob) {
                    reject(new Error("Image encode failed"));
                    return;
                }
                resolve(blob);
            },
            mime,
            quality
        );
    });
}

export async function copyCompressedImageForDiscord(
    filepath: string
): Promise<ClipboardCompressionResult> {
    const source = await loadImage(filepath);
    let maxEdge = DISCORD_SAFE_MAX_EDGE;
    let bestBlob: Blob | null = null;
    let bestCanvas: HTMLCanvasElement | null = null;
    let bestWidth = source.naturalWidth;
    let bestHeight = source.naturalHeight;

    for (let resizePass = 0; resizePass < 4; resizePass += 1) {
        const fitted = fitToMaxEdge(source.naturalWidth, source.naturalHeight, maxEdge);
        const canvas = drawResizedImage(source, fitted.width, fitted.height);

        for (const quality of JPEG_QUALITY_STEPS) {
            const encoded = await canvasToBlob(canvas, "image/jpeg", quality);
            bestBlob = encoded;
            bestCanvas = canvas;
            bestWidth = fitted.width;
            bestHeight = fitted.height;
            if (encoded.size <= DISCORD_SAFE_MAX_BYTES) {
                break;
            }
        }

        if (bestBlob && bestBlob.size <= DISCORD_SAFE_MAX_BYTES) {
            break;
        }
        maxEdge = Math.max(640, Math.floor(maxEdge * 0.84));
    }

    if (!bestBlob) {
        throw new Error("Unable to encode image for clipboard");
    }

    const pngFallbackBlob = bestCanvas
        ? await canvasToBlob(bestCanvas, "image/png", 1)
        : undefined;
    const writtenBlob = await writeBlobToClipboard(bestBlob, pngFallbackBlob);

    return {
        width: bestWidth,
        height: bestHeight,
        bytes: writtenBlob.size,
        mime: writtenBlob.type,
    };
}

export async function copyJpegImageToClipboard(
    filepath: string,
    quality: number = 0.95
): Promise<ClipboardCompressionResult> {
    const source = await loadImage(filepath);
    const canvas = drawResizedImage(source, source.naturalWidth, source.naturalHeight);
    const encoded = await canvasToBlob(canvas, "image/jpeg", quality);
    const pngFallbackBlob = await canvasToBlob(canvas, "image/png", 1);
    const writtenBlob = await writeBlobToClipboard(encoded, pngFallbackBlob);

    return {
        width: source.naturalWidth,
        height: source.naturalHeight,
        bytes: writtenBlob.size,
        mime: writtenBlob.type,
    };
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 B";
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const kb = bytes / 1024;
    if (kb < 1024) {
        return `${kb.toFixed(1)} KB`;
    }
    return `${(kb / 1024).toFixed(2)} MB`;
}
