import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchBar } from "../SearchBar";
import { MetadataDeltaTable } from "../MetadataDeltaTable";
import type { GalleryImageRecord } from "../../types/metadata";

const gallery = (id: number): GalleryImageRecord => ({
    id,
    filepath: `/lib/${id}.png`,
    filename: `${id}.png`,
    directory: "/lib",
    seed: String(id),
    width: 512,
    height: 512,
    model_name: "pony-v7.safetensors",
    is_favorite: false,
    is_locked: false,
    file_mtime: 1000 + id,
});

function renderSearchBar() {
    render(
        <SearchBar
            searchValue=""
            onSearch={() => {}}
            totalCount={2}
            resultCount={2}
            hasMoreResults={false}
            sortBy="newest"
            onSortChange={() => {}}
            generationTypeFilter="all"
            onGenerationTypeChange={() => {}}
            selectedCount={0}
            onSelectAll={() => {}}
            modelFilter=""
            modelOptions={[]}
            onModelFilterChange={() => {}}
            loraFilter=""
            loraOptions={[]}
            onLoraFilterChange={() => {}}
            tagFilterInput=""
            onTagFilterInputChange={() => {}}
            onApplyTagFilter={() => {}}
            checkpointFamilyFilters={[]}
            onToggleCheckpointFamilyFilter={() => {}}
            activeFilters={[]}
            onClearAllFilters={() => {}}
        />
    );
}

describe("controlled vocabulary in owned components", () => {
    it("SearchBar uses Checkpoint instead of Model for the sort and filter controls", () => {
        renderSearchBar();
        expect(screen.getByRole("option", { name: "Sort: Checkpoint" })).toBeTruthy();
        expect(screen.queryByRole("option", { name: "Sort: Model" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Filters" }));
        expect(screen.getByText("Checkpoint")).toBeTruthy();
        expect(screen.getByRole("option", { name: "All checkpoints" })).toBeTruthy();
        expect(screen.queryByText("Model")).toBeNull();
    });

    it("MetadataDeltaTable uses Scheduler, Checkpoint and Winner labels", () => {
        render(
            <MetadataDeltaTable
                pins={[gallery(1), gallery(2)]}
                winnerId={1}
                onPickWinner={() => {}}
                onMutateWinner={() => {}}
            />
        );
        expect(screen.getByText("Scheduler")).toBeTruthy();
        expect(screen.getByText("Checkpoint")).toBeTruthy();
        expect(screen.getAllByText("Winner").length).toBeGreaterThan(0);
        expect(screen.queryByText("Pick Winner")).toBeNull();
        expect(screen.queryByText("Schedule")).toBeNull();
    });
});
