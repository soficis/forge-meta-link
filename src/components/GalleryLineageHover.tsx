import { useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { GalleryImageRecord, LineageCursor } from "../types/metadata";

function toAssetSrc(filepath: string): string {
    return convertFileSrc(filepath.replace(/\\/g, "/"));
}

interface GalleryLineageHoverProps {
    image: GalleryImageRecord;
    cursor: LineageCursor | null;
    anchor: { left: number; top: number; width: number; height: number };
    filepathToImage: Map<string, GalleryImageRecord>;
    thumbnailCache: Map<string, string>;
    onNavigate: (target: GalleryImageRecord, origin: GalleryImageRecord) => void;
    onHoverEnter: () => void;
    onHoverLeave: () => void;
}

function lineageThumbSrc(
    filepath: string,
    thumbnailCache: Map<string, string>
): string {
    const thumb = thumbnailCache.get(filepath);
    const src = thumb ?? filepath;
    return toAssetSrc(src);
}

function LineageThumb({
    filepath,
    thumbnailCache,
    onClick,
    label,
}: {
    filepath: string;
    thumbnailCache: Map<string, string>;
    onClick: () => void;
    label: string;
}) {
    const isGhost = filepath.startsWith("ghost://");
    const src = useMemo(
        () => (isGhost ? "" : lineageThumbSrc(filepath, thumbnailCache)),
        [filepath, thumbnailCache, isGhost]
    );
    const filename = filepath.replace(/\\/g, "/").split("/").pop() ?? filepath;

    if (isGhost) {
        return (
            <div
                className="gallery-lineage-thumb is-ghost"
                title="culled ancestor"
                aria-label={`Culled ${label}`}
                style={{
                    width: 56,
                    height: 56,
                    background: "rgba(245, 158, 11, 0.08)",
                    border: "1px dashed rgba(245, 158, 11, 0.4)",
                    borderRadius: "4px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "10px",
                    color: "#fbbf24",
                }}
                data-testid="gallery-lineage-ghost-thumb"
            >
                <span style={{ fontSize: "16px" }}>👻</span>
                <span style={{ fontSize: "9px", opacity: 0.8 }}>culled</span>
            </div>
        );
    }

    return (
        <button
            type="button"
            className="gallery-lineage-thumb"
            onClick={onClick}
            aria-label={`Navigate to ${label} ${filename}`}
            title={filename}
        >
            <img
                src={src}
                alt={filename}
                loading="lazy"
                decoding="async"
                width={56}
                height={56}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
            <span className="gallery-lineage-thumb-label" aria-hidden="true">
                {filename.length > 14 ? `${filename.slice(0, 12)}…` : filename}
            </span>
        </button>
    );
}

export function GalleryLineageHover({
    image,
    cursor,
    anchor,
    filepathToImage,
    thumbnailCache,
    onNavigate,
    onHoverEnter,
    onHoverLeave,
}: GalleryLineageHoverProps) {
    const ancestors = cursor?.ancestors ?? [];
    const children = cursor?.children ?? [];

    // Fixed viewport positioning: appear below/right of anchor, clamped.
    const style: React.CSSProperties = useMemo(() => {
        const width = 280;
        const height = 156;
        const gap = 8;
        let left = anchor.left;
        let top = anchor.top + anchor.height + gap;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (left + width > vw - 8) left = Math.max(8, vw - width - 8);
        if (top + height > vh - 8) {
            top = anchor.top - height - gap;
            if (top < 8) top = Math.max(8, vh - height - 8);
        }
        return {
            position: "fixed",
            left,
            top,
            width,
            zIndex: 30,
        };
    }, [anchor]);

    const handleAncestorClick = (parentFilepath: string) => {
        const target = filepathToImage.get(parentFilepath);
        if (target) {
            onNavigate(target, image);
        }
    };

    const handleChildClick = (childFilepath: string) => {
        const target = filepathToImage.get(childFilepath);
        if (target) {
            onNavigate(target, image);
        }
    };

    return (
        <div
            className="gallery-lineage-hover"
            role="dialog"
            aria-label={`Lineage for ${image.filename}`}
            style={style}
            onMouseEnter={onHoverEnter}
            onMouseLeave={onHoverLeave}
        >
            <div className="gallery-lineage-hover-header">
                <span className="gallery-lineage-hover-title" title={image.filename}>
                    {image.filename}
                </span>
                <span className="gallery-lineage-hover-subtitle">
                    {ancestors.length} ancestors · {children.length} children
                </span>
            </div>

            <div className="gallery-lineage-hover-rows">
                <div className="gallery-lineage-row" aria-label="Ancestors">
                    <span className="gallery-lineage-row-label">↑ Ancestors</span>
                    <div className="gallery-lineage-row-items">
                        {ancestors.length === 0 ? (
                            <span className="gallery-lineage-empty">No ancestors</span>
                        ) : (
                            ancestors.slice(0, 3).map((edge) => (
                                <LineageThumb
                                    key={`${edge.child_filepath}|${edge.parent_filepath}`}
                                    filepath={edge.parent_filepath}
                                    thumbnailCache={thumbnailCache}
                                    onClick={() => handleAncestorClick(edge.parent_filepath)}
                                    label="ancestor"
                                />
                            ))
                        )}
                        {ancestors.length > 0 &&
                            ancestors.length < 3 &&
                            Array.from({ length: 3 - ancestors.length }).map((_, idx) => (
                                <span
                                    key={`a-placeholder-${idx}`}
                                    className="gallery-lineage-thumb placeholder"
                                    aria-hidden="true"
                                />
                            ))}
                    </div>
                </div>

                <div className="gallery-lineage-row" aria-label="Children">
                    <span className="gallery-lineage-row-label">↓ Children</span>
                    <div className="gallery-lineage-row-items">
                        {children.length === 0 ? (
                            <span className="gallery-lineage-empty">No children</span>
                        ) : (
                            children.slice(0, 2).map((edge) => (
                                <LineageThumb
                                    key={`${edge.child_filepath}|${edge.parent_filepath}`}
                                    filepath={edge.child_filepath}
                                    thumbnailCache={thumbnailCache}
                                    onClick={() => handleChildClick(edge.child_filepath)}
                                    label="child"
                                />
                            ))
                        )}
                        {children.length > 0 &&
                            children.length < 2 &&
                            Array.from({ length: 2 - children.length }).map((_, idx) => (
                                <span
                                    key={`c-placeholder-${idx}`}
                                    className="gallery-lineage-thumb placeholder"
                                    aria-hidden="true"
                                />
                            ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
