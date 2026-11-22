import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ImageRecord } from "../types/metadata";
import { MetadataDeltaTable } from "./MetadataDeltaTable";

/** Axis fields are limited to structured metadata. Filenames and raw text are never parsed. */
export type XyzAxisField =
    | "seed"
    | "cfg_scale"
    | "steps"
    | "sampler"
    | "schedule_type"
    | "model_name";

export const XYZ_AXIS_FIELDS: readonly XyzAxisField[] = [
    "seed",
    "cfg_scale",
    "steps",
    "sampler",
    "schedule_type",
    "model_name",
] as const;

const PREFERRED_AXES: readonly XyzAxisField[] = ["cfg_scale", "steps", "sampler"] as const;
const NUMERIC_AXES: ReadonlySet<XyzAxisField> = new Set<XyzAxisField>([
    "seed",
    "cfg_scale",
    "steps",
]);

const AXIS_LABELS: Record<XyzAxisField, string> = {
    seed: "Seed",
    cfg_scale: "CFG scale",
    steps: "Steps",
    sampler: "Sampler",
    schedule_type: "Schedule",
    model_name: "Model",
};

/** The empty string is reserved for the missing group; recorded values are non-empty. */
export const MISSING_GROUP = "";
export const MISSING_GROUP_LABEL = "(not recorded)";

export interface AxisOption {
    value: string;
    label: string;
    isMissing: boolean;
}

export interface XyzCell {
    key: string;
    xValue: string;
    yValue: string;
    zValue: string;
    imageIds: number[];
    images: ImageRecord[];
}

export interface XyzGrid {
    xOptions: AxisOption[];
    yOptions: AxisOption[];
    zOptions: AxisOption[];
    cells: XyzCell[];
}

function recordedValue(image: ImageRecord, field: XyzAxisField): string | null {
    const raw = image[field];
    if (raw == null) return null;
    const text = String(raw).trim();
    return text.length === 0 ? null : text;
}

function compareAxisValues(left: string, right: string, numeric: boolean): number {
    if (numeric) {
        const leftNumber = Number(left);
        const rightNumber = Number(right);
        const leftIsNumber = Number.isFinite(leftNumber);
        const rightIsNumber = Number.isFinite(rightNumber);
        if (leftIsNumber && rightIsNumber && leftNumber !== rightNumber) {
            return leftNumber - rightNumber;
        }
        if (leftIsNumber !== rightIsNumber) {
            return leftIsNumber ? -1 : 1;
        }
    }
    return left.localeCompare(right);
}

/** Deterministic options derived only from structured fields of the given records. */
export function getAxisOptions(
    images: ImageRecord[],
    field: XyzAxisField
): AxisOption[] {
    const values = new Set<string>();
    let hasMissing = false;
    for (const image of images) {
        const value = recordedValue(image, field);
        if (value == null) {
            hasMissing = true;
        } else {
            values.add(value);
        }
    }

    const numeric = NUMERIC_AXES.has(field);
    const options: AxisOption[] = Array.from(values)
        .sort((left, right) => compareAxisValues(left, right, numeric))
        .map((value) => ({ value, label: value, isMissing: false }));

    if (hasMissing) {
        options.push({ value: MISSING_GROUP, label: MISSING_GROUP_LABEL, isMissing: true });
    }
    return options;
}

function optionRank(options: AxisOption[], value: string): number {
    const index = options.findIndex((option) => option.value === value);
    return index < 0 ? options.length : index;
}

function cellKey(xValue: string, yValue: string, zValue: string): string {
    return JSON.stringify([xValue, yValue, zValue]);
}

/** Groups records into an X × Y grid for every Z slice. */
export function buildGrid(
    images: ImageRecord[],
    xField: XyzAxisField,
    yField: XyzAxisField,
    zField: XyzAxisField
): XyzGrid {
    const xOptions = getAxisOptions(images, xField);
    const yOptions = getAxisOptions(images, yField);
    const zOptions = getAxisOptions(images, zField);

    interface Accumulator {
        key: string;
        xValue: string;
        yValue: string;
        zValue: string;
        images: ImageRecord[];
    }
    const grouped = new Map<string, Accumulator>();

    for (const image of images) {
        const xValue = recordedValue(image, xField) ?? MISSING_GROUP;
        const yValue = recordedValue(image, yField) ?? MISSING_GROUP;
        const zValue = recordedValue(image, zField) ?? MISSING_GROUP;
        const key = cellKey(xValue, yValue, zValue);
        const existing = grouped.get(key);
        if (existing) {
            existing.images.push(image);
        } else {
            grouped.set(key, { key, xValue, yValue, zValue, images: [image] });
        }
    }

    const cells: XyzCell[] = Array.from(grouped.values())
        .map((entry) => ({
            key: entry.key,
            xValue: entry.xValue,
            yValue: entry.yValue,
            zValue: entry.zValue,
            images: entry.images,
            imageIds: entry.images.map((image) => image.id).sort((left, right) => left - right),
        }))
        .sort((left, right) => {
            const byZ = optionRank(zOptions, left.zValue) - optionRank(zOptions, right.zValue);
            if (byZ !== 0) return byZ;
            const byY = optionRank(yOptions, left.yValue) - optionRank(yOptions, right.yValue);
            if (byY !== 0) return byY;
            return optionRank(xOptions, left.xValue) - optionRank(xOptions, right.xValue);
        });

    return { xOptions, yOptions, zOptions, cells };
}

function chooseDefaultAxes(images: ImageRecord[]): {
    x: XyzAxisField;
    y: XyzAxisField;
    z: XyzAxisField;
} {
    const hasValue = new Set<XyzAxisField>();
    for (const field of XYZ_AXIS_FIELDS) {
        if (images.some((image) => recordedValue(image, field) != null)) {
            hasValue.add(field);
        }
    }

    const chosen: XyzAxisField[] = [];
    const add = (field: XyzAxisField) => {
        if (chosen.length < 3 && !chosen.includes(field)) chosen.push(field);
    };
    for (const field of PREFERRED_AXES) {
        if (hasValue.has(field)) add(field);
    }
    for (const field of XYZ_AXIS_FIELDS) {
        if (hasValue.has(field)) add(field);
    }
    for (const field of PREFERRED_AXES) add(field);
    for (const field of XYZ_AXIS_FIELDS) add(field);

    return {
        x: chosen[0] ?? "cfg_scale",
        y: chosen[1] ?? "steps",
        z: chosen[2] ?? "sampler",
    };
}

function countLabel(count: number): string {
    return `${count} image${count === 1 ? "" : "s"}`;
}

const FOCUS_STYLES = `
.xyz-rebuilder :focus-visible {
    outline: 2px solid #6aa9ff;
    outline-offset: 2px;
}
.xyz-rebuilder [role="dialog"]:focus {
    outline: 2px solid #6aa9ff;
    outline-offset: 2px;
}
`;

export interface XyzRebuilderProps {
    images: ImageRecord[];
    onClose: () => void;
    onPin?: (ids: number[]) => void;
}

export function XyzRebuilder({ images, onClose, onPin }: XyzRebuilderProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const [axes, setAxes] = useState(() => chooseDefaultAxes(images));
    const [activeZ, setActiveZ] = useState<string | null>(null);
    const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
    const [selectionKey, setSelectionKey] = useState<string | null>(null);

    const grid = useMemo(
        () => buildGrid(images, axes.x, axes.y, axes.z),
        [images, axes]
    );
    // Derive the active Z tab rather than syncing it in an effect: an invalid
    // stored value (or an axis change) simply falls back to the first option.
    const effectiveZ = grid.zOptions.some((option) => option.value === activeZ)
        ? activeZ
        : (grid.zOptions[0]?.value ?? null);
    const currentSelectionKey = `${JSON.stringify(axes)}|${effectiveZ ?? ""}`;
    const effectiveSelectedKeys =
        selectionKey === currentSelectionKey ? selectedKeys : [];
    const cellsByKey = useMemo(
        () => new Map(grid.cells.map((cell) => [cell.key, cell] as const)),
        [grid.cells]
    );
    const detailsMap = useMemo(
        () => new Map(images.map((image) => [image.id, image] as const)),
        [images]
    );

    useEffect(() => {
        dialogRef.current?.focus();
    }, []);

    const visibleCells = useMemo(
        () => grid.cells.filter((cell) => cell.zValue === effectiveZ),
        [grid.cells, effectiveZ]
    );
    const resultCount = visibleCells.reduce(
        (total, cell) => total + cell.imageIds.length,
        0
    );

    const deltaPins = useMemo(() => {
        const pins: ImageRecord[] = [];
        for (const key of effectiveSelectedKeys) {
            const cell = cellsByKey.get(key);
            const representative = cell?.images[0];
            if (representative) pins.push(representative);
            if (pins.length === 2) break;
        }
        return pins;
    }, [effectiveSelectedKeys, cellsByKey]);

    const handleAxisChange = (axis: "x" | "y" | "z", value: string) => {
        if (!XYZ_AXIS_FIELDS.some((field) => field === value)) return;
        const field = value as XyzAxisField;
        if (axis === "x") {
            setAxes((previous) => ({ ...previous, x: field }));
        } else if (axis === "y") {
            setAxes((previous) => ({ ...previous, y: field }));
        } else {
            setAxes((previous) => ({ ...previous, z: field }));
        }
    };

    const handleCellClick = (cell: XyzCell) => {
        if (cell.imageIds.length === 0) return;
        onPin?.(cell.imageIds.slice());
        setSelectionKey(currentSelectionKey);
        setSelectedKeys((previous) => {
            const base = selectionKey === currentSelectionKey ? previous : [];
            if (base.includes(cell.key)) {
                return base.filter((key) => key !== cell.key);
            }
            const next = [...base, cell.key];
            return next.length > 2 ? next.slice(next.length - 2) : next;
        });
    };

    const handleReset = () => {
        setAxes(chooseDefaultAxes(images));
        setActiveZ(null);
        setSelectedKeys([]);
        setSelectionKey(null);
    };

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
            event.preventDefault();
            onClose();
        }
    };

    return (
        <div className="xyz-rebuilder">
            <style>{FOCUS_STYLES}</style>
            <div
                className="xyz-rebuilder-backdrop"
                style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0, 0, 0, 0.55)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 60,
                }}
            >
                <div
                    ref={dialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="xyz-rebuilder-title"
                    tabIndex={-1}
                    onKeyDown={handleKeyDown}
                    style={{
                        background: "#1b1b1f",
                        color: "#f2f2f5",
                        borderRadius: "10px",
                        padding: "18px",
                        maxWidth: "min(1100px, 94vw)",
                        maxHeight: "88vh",
                        overflow: "auto",
                        boxShadow: "0 18px 48px rgba(0, 0, 0, 0.5)",
                    }}
                >
                    <header
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "16px",
                        }}
                    >
                        <h2 id="xyz-rebuilder-title" style={{ margin: 0, fontSize: "18px" }}>
                            Rebuild X/Y/Z grid
                        </h2>
                        <div style={{ display: "flex", gap: "8px" }}>
                            <button type="button" onClick={handleReset}>
                                Reset
                            </button>
                            <button
                                type="button"
                                aria-label="Close X/Y/Z rebuilder"
                                onClick={onClose}
                            >
                                Close
                            </button>
                        </div>
                    </header>

                    <p style={{ margin: "8px 0 14px", color: "#b9b9c4", fontSize: "13px" }}>
                        Axes come only from recorded generation parameters. Missing values are
                        grouped as {MISSING_GROUP_LABEL}.
                    </p>

                    <div
                        style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "12px",
                            marginBottom: "14px",
                        }}
                    >
                        {(["x", "y", "z"] as const).map((axis) => (
                            <label
                                key={axis}
                                htmlFor={`xyz-axis-${axis}`}
                                style={{ display: "flex", flexDirection: "column", gap: "4px" }}
                            >
                                <span>{axis.toUpperCase()} axis</span>
                                <select
                                    id={`xyz-axis-${axis}`}
                                    aria-label={`${axis.toUpperCase()} axis`}
                                    value={axes[axis]}
                                    onChange={(event) =>
                                        handleAxisChange(axis, event.target.value)
                                    }
                                >
                                    {XYZ_AXIS_FIELDS.map((field) => (
                                        <option key={field} value={field}>
                                            {AXIS_LABELS[field]}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        ))}
                    </div>

                    <div
                        data-testid="xyz-result-count"
                        aria-live="polite"
                        style={{ marginBottom: "10px", fontSize: "13px" }}
                    >
                        {`${countLabel(resultCount)} in this Z slice · ${countLabel(images.length)} loaded`}
                    </div>

                    {grid.zOptions.length === 0 ? (
                        <p data-testid="xyz-empty" role="status">
                            No images available to rebuild.
                        </p>
                    ) : (
                        <>
                            <div
                                role="tablist"
                                aria-label="Z axis value"
                                style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "12px" }}
                            >
                                {grid.zOptions.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        role="tab"
                                        aria-selected={option.value === effectiveZ}
                                        onClick={() => setActiveZ(option.value)}
                                    >
                                        {`${AXIS_LABELS[axes.z]}: ${option.label}`}
                                    </button>
                                ))}
                            </div>

                            <table
                                data-testid="xyz-grid"
                                aria-label="Rebuilt X by Y grid"
                                style={{ borderCollapse: "collapse", width: "100%" }}
                            >
                                <thead>
                                    <tr>
                                        <th scope="col" style={{ textAlign: "left" }}>
                                            {`${AXIS_LABELS[axes.y]} \\ ${AXIS_LABELS[axes.x]}`}
                                        </th>
                                        {grid.xOptions.map((option) => (
                                            <th
                                                key={option.value}
                                                scope="col"
                                                data-testid={`xyz-x-header-${option.value}`}
                                                style={{ textAlign: "left", padding: "6px" }}
                                            >
                                                {option.label}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {grid.yOptions.map((yOption) => (
                                        <tr key={yOption.value}>
                                            <th
                                                scope="row"
                                                data-testid={`xyz-y-header-${yOption.value}`}
                                                style={{ textAlign: "left", padding: "6px" }}
                                            >
                                                {yOption.label}
                                            </th>
                                            {grid.xOptions.map((xOption) => {
                                                const cell = cellsByKey.get(
                                                    cellKey(xOption.value, yOption.value, effectiveZ ?? MISSING_GROUP)
                                                );
                                                if (!cell || cell.imageIds.length === 0) {
                                                    return (
                                                        <td
                                                            key={xOption.value}
                                                            className="xyz-empty-cell"
                                                            data-empty-cell="true"
                                                            data-testid={`xyz-gap-${xOption.value}-${yOption.value}`}
                                                            aria-label={`No images for X ${xOption.label}, Y ${yOption.label}`}
                                                            style={{ padding: "6px", textAlign: "center" }}
                                                        >
                                                            —
                                                        </td>
                                                    );
                                                }
                                                const isSelected = effectiveSelectedKeys.includes(cell.key);
                                                return (
                                                    <td key={xOption.value} style={{ padding: "6px" }}>
                                                        <button
                                                            type="button"
                                                            aria-pressed={isSelected}
                                                            aria-label={`Select cell X ${xOption.label}, Y ${yOption.label}, ${countLabel(cell.imageIds.length)}`}
                                                            data-testid={`xyz-cell-${xOption.value}-${yOption.value}`}
                                                            onClick={() => handleCellClick(cell)}
                                                            style={{
                                                                background: isSelected ? "#2f5f9e" : "#2a2a31",
                                                                color: "#fff",
                                                                border: isSelected
                                                                    ? "2px solid #6aa9ff"
                                                                    : "1px solid #44444e",
                                                                borderRadius: "6px",
                                                                padding: "6px 8px",
                                                                cursor: "pointer",
                                                            }}
                                                        >
                                                            {cell.imageIds
                                                                .map((id) => `#${id}`)
                                                                .join(" ")}
                                                        </button>
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </>
                    )}

                    {deltaPins.length === 2 && (
                        <section data-testid="xyz-delta" style={{ marginTop: "16px" }}>
                            <h3 style={{ fontSize: "14px", margin: "0 0 8px" }}>
                                Side-by-side metadata delta
                            </h3>
                            <MetadataDeltaTable
                                pins={deltaPins}
                                detailsMap={detailsMap}
                                compact
                            />
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
}

export default XyzRebuilder;
