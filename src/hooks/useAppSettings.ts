import type { Dispatch, SetStateAction } from "react";
import {
    usePersistedState,
    booleanStorage,
    numberStorage,
    stringArrayStorage,
} from "./usePersistedState";
import type { DeleteMode, GenerationType, SortOption } from "../types/metadata";

const SORT_OPTIONS = new Set<SortOption>([
    "newest",
    "oldest",
    "name_asc",
    "name_desc",
    "model",
    "generation_type",
]);

const GENERATION_TYPE_FILTER_OPTIONS = new Set<GenerationType | "all">([
    "all",
    "txt2img",
    "img2img",
    "inpaint",
    "grid",
    "upscale",
    "unknown",
]);

const sortOptionStorage = {
    serialize: (value: SortOption) => value,
    deserialize: (raw: string): SortOption | undefined =>
        SORT_OPTIONS.has(raw as SortOption) ? (raw as SortOption) : undefined,
};

const generationTypeStorage = {
    serialize: (value: GenerationType | "all") => value,
    deserialize: (raw: string): GenerationType | "all" | undefined =>
        GENERATION_TYPE_FILTER_OPTIONS.has(raw as GenerationType | "all")
            ? (raw as GenerationType | "all")
            : undefined,
};

const deleteModeStorage = {
    serialize: (value: DeleteMode) => value,
    deserialize: (raw: string): DeleteMode | undefined =>
        raw === "trash" || raw === "permanent" ? raw : undefined,
};

export interface AppSettings {
    columnCount: number;
    setColumnCount: Dispatch<SetStateAction<number>>;
    isSidebarCollapsed: boolean;
    setIsSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
    sortBy: SortOption;
    setSortBy: Dispatch<SetStateAction<SortOption>>;
    generationTypeFilter: GenerationType | "all";
    setGenerationTypeFilter: Dispatch<SetStateAction<GenerationType | "all">>;
    selectedModelFilter: string;
    setSelectedModelFilter: Dispatch<SetStateAction<string>>;
    selectedLoraFilter: string;
    setSelectedLoraFilter: Dispatch<SetStateAction<string>>;
    selectedCheckpointFamilies: string[];
    setSelectedCheckpointFamilies: Dispatch<SetStateAction<string[]>>;
    deleteMode: DeleteMode;
    setDeleteMode: Dispatch<SetStateAction<DeleteMode>>;
    autoLockFavorites: boolean;
    setAutoLockFavorites: Dispatch<SetStateAction<boolean>>;
}

/** Extracts UI / layout settings from localStorage. */
export function useAppSettings(): AppSettings {
    const [columnCount, setColumnCount] = usePersistedState(
        "columnCount",
        6,
        numberStorage
    );
    const [isSidebarCollapsed, setIsSidebarCollapsed] = usePersistedState(
        "isSidebarCollapsed",
        false,
        booleanStorage
    );
    const [sortBy, setSortBy] = usePersistedState<SortOption>(
        "sortBy",
        "newest",
        sortOptionStorage
    );
    const [generationTypeFilter, setGenerationTypeFilter] = usePersistedState<
        GenerationType | "all"
    >("generationTypeFilter", "all", generationTypeStorage);
    const [selectedModelFilter, setSelectedModelFilter] = usePersistedState(
        "selectedModelFilter",
        ""
    );
    const [selectedLoraFilter, setSelectedLoraFilter] = usePersistedState(
        "selectedLoraFilter",
        ""
    );
    const [selectedCheckpointFamilies, setSelectedCheckpointFamilies] =
        usePersistedState<string[]>(
            "selectedCheckpointFamilies",
            [],
            stringArrayStorage
        );
    const [deleteMode, setDeleteMode] = usePersistedState<DeleteMode>(
        "deleteMode",
        "trash",
        deleteModeStorage
    );
    const [autoLockFavorites, setAutoLockFavorites] = usePersistedState(
        "autoLockFavorites",
        true,
        booleanStorage
    );

    return {
        columnCount,
        setColumnCount,
        isSidebarCollapsed,
        setIsSidebarCollapsed,
        sortBy,
        setSortBy,
        generationTypeFilter,
        setGenerationTypeFilter,
        selectedModelFilter,
        setSelectedModelFilter,
        selectedLoraFilter,
        setSelectedLoraFilter,
        selectedCheckpointFamilies,
        setSelectedCheckpointFamilies,
        deleteMode,
        setDeleteMode,
        autoLockFavorites,
        setAutoLockFavorites,
    };
}
