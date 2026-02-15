import { useState, useEffect, useRef } from "react";
import type { GenerationType, SortOption } from "../types/metadata";

interface SearchBarProps {
    searchValue: string;
    onSearch: (query: string) => void;
    totalCount: number;
    resultCount: number;
    sortBy: SortOption;
    onSortChange: (sort: SortOption) => void;
    generationTypeFilter: GenerationType | "all";
    onGenerationTypeChange: (value: GenerationType | "all") => void;
    selectedCount: number;
    onSelectAll: () => void;
    onDeselectAll: () => void;
    modelFilter: string;
    modelOptions: string[];
    onModelFilterChange: (value: string) => void;
    loraFilter: string;
    loraOptions: string[];
    onLoraFilterChange: (value: string) => void;
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
    { value: "all", label: "All Types" },
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
    sortBy,
    onSortChange,
    generationTypeFilter,
    onGenerationTypeChange,
    selectedCount,
    onSelectAll,
    onDeselectAll,
    modelFilter,
    modelOptions,
    onModelFilterChange,
    loraFilter,
    loraOptions,
    onLoraFilterChange,
}: SearchBarProps) {
    const [value, setValue] = useState(searchValue);
    const [showHelp, setShowHelp] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    return (
        <div className="search-bar">
            <div className="search-input-wrapper">
                <svg
                    className="search-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                >
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                    type="text"
                    placeholder='Search prompts, models, seeds...'
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="search-input"
                />
                {value && (
                    <button
                        className="search-clear"
                        onClick={() => {
                            setValue("");
                            onSearch("");
                        }}
                        title="Clear search"
                    >
                        &#x2715;
                    </button>
                )}
                <button
                    type="button"
                    className="search-help-btn"
                    onClick={() => setShowHelp((prev) => !prev)}
                    title="Search syntax help"
                    aria-expanded={showHelp}
                >
                    ?
                </button>
            </div>

            <select
                className="sort-select"
                value={sortBy}
                onChange={(e) => onSortChange(e.target.value as SortOption)}
            >
                {SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                        {opt.label}
                    </option>
                ))}
            </select>

            <select
                className="sort-select"
                value={generationTypeFilter}
                onChange={(e) =>
                    onGenerationTypeChange(e.target.value as GenerationType | "all")
                }
                title="Filter by generation type"
            >
                {GENERATION_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                        {opt.label}
                    </option>
                ))}
            </select>

            <select
                className="sort-select"
                value={modelFilter}
                onChange={(e) => onModelFilterChange(e.target.value)}
                title="Filter by detected model"
            >
                <option value="">All Models</option>
                {modelOptions.map((model) => (
                    <option key={model} value={model}>
                        {model}
                    </option>
                ))}
            </select>

            <select
                className="sort-select"
                value={loraFilter}
                onChange={(e) => onLoraFilterChange(e.target.value)}
                title="Filter by detected LoRA tag"
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

            <button
                className="search-select-all"
                onClick={selectedCount > 0 ? onDeselectAll : onSelectAll}
                title={selectedCount > 0 ? "Deselect all images" : "Select all loaded images"}
            >
                {selectedCount > 0 ? "Deselect All" : "Select All"}
            </button>

            {selectedCount > 0 && (
                <span className="search-selection-info">{selectedCount} selected</span>
            )}

            <div className="search-stats">
                {value.trim() || modelFilter || loraFilter ? (
                    <span>{resultCount} results</span>
                ) : (
                    <span>{totalCount.toLocaleString()} images</span>
                )}
            </div>

            {showHelp && (
                <div className="search-help-popup">
                    <div className="search-help-header">
                        <strong>Search Syntax</strong>
                        <button onClick={() => setShowHelp(false)} className="search-help-close">&#x2715;</button>
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
                            <span>Booru-style include/exclude tags in Tag Filters</span>
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
