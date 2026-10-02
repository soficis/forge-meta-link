import { useState, useEffect, useRef } from "react";
import type { GenerationType, SortOption } from "../types/metadata";
import { CHECKPOINT_FAMILY_OPTIONS } from "../utils/checkpointFamilies";

export interface ActiveFilterChip {
    id: string;
    label: string;
    onRemove: () => void;
}

interface SearchBarProps {
    searchValue: string;
    onSearch: (query: string) => void;
    totalCount: number;
    resultCount: number;
    hasMoreResults: boolean;
    sortBy: SortOption;
    onSortChange: (sort: SortOption) => void;
    generationTypeFilter: GenerationType | "all";
    onGenerationTypeChange: (value: GenerationType | "all") => void;
    selectedCount: number;
    onSelectAll: () => void;
    modelFilter: string;
    modelOptions: string[];
    onModelFilterChange: (value: string) => void;
    loraFilter: string;
    loraOptions: string[];
    onLoraFilterChange: (value: string) => void;
    tagFilterInput: string;
    onTagFilterInputChange: (value: string) => void;
    onApplyTagFilter: (value: string) => void;
    checkpointFamilyFilters: string[];
    onToggleCheckpointFamilyFilter: (family: string) => void;
    activeFilters: ActiveFilterChip[];
    onClearAllFilters: () => void;
}

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
    { value: "newest", label: "Newest" },
    { value: "oldest", label: "Oldest" },
    { value: "name_asc", label: "Name A-Z" },
    { value: "name_desc", label: "Name Z-A" },
    { value: "model", label: "Model" },
    { value: "generation_type", label: "Gen Type" },
];

const GENERATION_TYPE_OPTIONS: {
    value: GenerationType | "all";
    label: string;
}[] = [
    { value: "all", label: "All types" },
    { value: "txt2img", label: "txt2img" },
    { value: "img2img", label: "img2img" },
    { value: "inpaint", label: "inpaint" },
    { value: "grid", label: "grids" },
    { value: "upscale", label: "upscale" },
    { value: "unknown", label: "unknown" },
];

export function SearchBar({
    searchValue,
    onSearch,
    totalCount,
    resultCount,
    hasMoreResults,
    sortBy,
    onSortChange,
    generationTypeFilter,
    onGenerationTypeChange,
    selectedCount,
    onSelectAll,
    modelFilter,
    modelOptions,
    onModelFilterChange,
    loraFilter,
    loraOptions,
    onLoraFilterChange,
    tagFilterInput,
    onTagFilterInputChange,
    onApplyTagFilter,
    checkpointFamilyFilters,
    onToggleCheckpointFamilyFilter,
    activeFilters,
    onClearAllFilters,
}: SearchBarProps) {
    const [value, setValue] = useState(searchValue);
    const [showHelp, setShowHelp] = useState(false);
    const [showFilters, setShowFilters] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const filterCount = activeFilters.filter((chip) => chip.id !== "search").length;
    const isFiltered = activeFilters.length > 0;

    useEffect(() => {
        setValue(searchValue);
    }, [searchValue]);

    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            onSearch(value);
        }, 300);

        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [value, onSearch]);

    // Ctrl/Cmd+F focuses search. Skipped while a modal dialog owns the keyboard.
    useEffect(() => {
        const handleKey = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
            if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, []);

    return (
        <div className="search-bar-wrapper">
            <div className="search-bar">
                <div className="search-input-wrapper">
                    <svg
                        className="search-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                    >
                        <circle cx="11" cy="11" r="8" />
                        <path d="m21 21-4.3-4.3" />
                    </svg>
                    <input
                        ref={inputRef}
                        type="text"
                        placeholder="Search prompts, models, seeds… (Ctrl+F)"
                        aria-label="Search images"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape" && value) {
                                e.preventDefault();
                                e.stopPropagation();
                                setValue("");
                                onSearch("");
                            }
                        }}
                        className="search-input"
                    />
                    {value && (
                        <button
                            type="button"
                            className="search-clear"
                            onClick={() => {
                                setValue("");
                                onSearch("");
                            }}
                            title="Clear search"
                            aria-label="Clear search"
                        >
                            &#x2715;
                        </button>
                    )}
                    <button
                        type="button"
                        className="search-help-btn"
                        onClick={() => setShowHelp((prev) => !prev)}
                        title="Search syntax help"
                        aria-label="Search syntax help"
                        aria-expanded={showHelp}
                    >
                        ?
                    </button>
                </div>

                <button
                    type="button"
                    className={`search-filter-toggle ${showFilters || filterCount > 0 ? "active" : ""}`}
                    onClick={() => setShowFilters((prev) => !prev)}
                    aria-expanded={showFilters}
                >
                    Filters{filterCount > 0 ? ` (${filterCount})` : ""}
                </button>

                <select
                    className="sort-select"
                    value={sortBy}
                    onChange={(e) => onSortChange(e.target.value as SortOption)}
                    aria-label="Sort order"
                >
                    {SORT_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                            Sort: {opt.label}
                        </option>
                    ))}
                </select>

                <div className="search-stats" aria-live="polite">
                    {isFiltered ? (
                        <span
                            title={
                                hasMoreResults
                                    ? "More matches load as you scroll"
                                    : undefined
                            }
                        >
                            {resultCount.toLocaleString()}
                            {hasMoreResults ? "+" : ""} match{resultCount === 1 && !hasMoreResults ? "" : "es"}
                        </span>
                    ) : (
                        <span>{totalCount.toLocaleString()} images</span>
                    )}
                    {selectedCount === 0 && resultCount > 0 && (
                        <button
                            type="button"
                            className="search-select-all"
                            onClick={onSelectAll}
                            title="Select all loaded images (Ctrl+A)"
                        >
                            Select all
                        </button>
                    )}
                </div>
            </div>

            {showFilters && (
                <div className="search-filters-panel">
                    <div className="search-filters-row">
                        <label className="search-filter-field">
                            <span>Type</span>
                            <select
                                className="sort-select"
                                value={generationTypeFilter}
                                onChange={(e) =>
                                    onGenerationTypeChange(e.target.value as GenerationType | "all")
                                }
                            >
                                {GENERATION_TYPE_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="search-filter-field">
                            <span>Model</span>
                            <select
                                className="sort-select"
                                value={modelFilter}
                                onChange={(e) => onModelFilterChange(e.target.value)}
                            >
                                <option value="">All models</option>
                                {modelOptions.map((model) => (
                                    <option key={model} value={model}>
                                        {model}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="search-filter-field">
                            <span>LoRA</span>
                            <select
                                className="sort-select"
                                value={loraFilter}
                                onChange={(e) => onLoraFilterChange(e.target.value)}
                            >
                                <option value="">All LoRAs</option>
                                {loraOptions.map((loraTag) => {
                                    const display = loraTag.startsWith("lora:")
                                        ? loraTag.slice("lora:".length)
                                        : loraTag;
                                    return (
                                        <option key={loraTag} value={loraTag}>
                                            {display}
                                        </option>
                                    );
                                })}
                            </select>
                        </label>

                        <form
                            className="search-filter-field search-filter-tags"
                            onSubmit={(event) => {
                                event.preventDefault();
                                onApplyTagFilter(tagFilterInput);
                            }}
                        >
                            <label htmlFor="tag-filter-input">Tags</label>
                            <div className="search-filter-inline">
                                <input
                                    id="tag-filter-input"
                                    className="sidebar-input"
                                    value={tagFilterInput}
                                    placeholder="1girl -nsfw"
                                    aria-describedby="tag-filter-hint"
                                    onChange={(event) => onTagFilterInputChange(event.target.value)}
                                />
                                <button type="submit" className="search-select-all">
                                    Apply
                                </button>
                            </div>
                            <span id="tag-filter-hint" className="search-filter-hint">
                                Separate tags with spaces. Put - in front to exclude.
                            </span>
                        </form>
                    </div>

                    <div className="search-filters-row" role="group" aria-label="Checkpoint family">
                        <span className="search-filter-label">Checkpoint family</span>
                        {CHECKPOINT_FAMILY_OPTIONS.map((option) => {
                            const active = checkpointFamilyFilters.includes(option.value);
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    className={`checkpoint-family-toggle ${active ? "active" : ""}`}
                                    aria-pressed={active}
                                    onClick={() => onToggleCheckpointFamilyFilter(option.value)}
                                >
                                    {option.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {activeFilters.length > 0 && (
                <div className="active-filter-row" role="group" aria-label="Active filters">
                    {activeFilters.map((chip) => (
                        <span key={chip.id} className="active-filter-chip">
                            {chip.label}
                            <button
                                type="button"
                                onClick={chip.onRemove}
                                aria-label={`Remove filter: ${chip.label}`}
                                title="Remove filter"
                            >
                                ✕
                            </button>
                        </span>
                    ))}
                    {activeFilters.length > 1 && (
                        <button type="button" className="active-filter-clear" onClick={onClearAllFilters}>
                            Clear all
                        </button>
                    )}
                </div>
            )}

            {showHelp && (
                <div className="search-help-popup">
                    <div className="search-help-header">
                        <strong>Search Syntax</strong>
                        <button
                            type="button"
                            onClick={() => setShowHelp(false)}
                            className="search-help-close"
                            aria-label="Close search help"
                        >
                            &#x2715;
                        </button>
                    </div>
                    <div className="search-help-body">
                        <div className="search-help-row">
                            <code>cat</code>
                            <span>Prefix match (finds "cat", "catgirl", etc.)</span>
                        </div>
                        <div className="search-help-row">
                            <code>"best quality"</code>
                            <span>Exact phrase match</span>
                        </div>
                        <div className="search-help-row">
                            <code>cat dog</code>
                            <span>Both terms must match (AND)</span>
                        </div>
                        <div className="search-help-row">
                            <code>tag1 -tag2</code>
                            <span>Include/exclude tags: use the Tags box under Filters</span>
                        </div>
                        <div className="search-help-row">
                            <code>cat*</code>
                            <span>Explicit wildcard prefix</span>
                        </div>
                        <div className="search-help-row">
                            <code>euler</code>
                            <span>Searches prompts, models, and metadata</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
