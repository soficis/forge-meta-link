import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
    exportImages,
    exportImagesAsFiles,
    forgeGetOptions,
    forgeGetUpscalers,
    forgeUpscaleImage,
    getDisplayImagePath,
    getImageClipboardPayload,
    getImageDetail,
    getLineageCursor,
    getLineageTrace,
    getSidecarData,
    getThumbnailPath,
    getThumbnailPaths,
    openFileLocation,
    savePrompt,
    saveSidecarTags,
    setLineageOverride,
} from "../services/commands";
import { PromptLibraryDialog } from "./PromptLibraryDialog";
import { useRunOncePerActivation } from "../hooks/useRunOncePerActivation";
import { shouldPopulateForgeOverrides } from "../utils/forgeOverridesGuard";
import { REJECTED_SCHEDULERS } from "../utils/mutations";
import {
    copyJpegImageToClipboard,
    copyCompressedImageForDiscord,
    formatBytes,
} from "../utils/imageClipboard";
import { formatOpsLabel, formatGhostRecipeText } from "../utils/lineageTrace";
import type {
    ForgePayloadOverrides,
    GalleryImageRecord,
    ImageExportFormat,
    ImageRecord,
    LineageCursor,
    LineageEdge,
    LineageTrace,
} from "../types/metadata";
import { usePersistedState, booleanStorage } from "../hooks/usePersistedState";
import type { ShowToastOptions } from "../hooks/useToast";
import { useCompareLabStore } from "../store/compareLabStore";
import { ForgeRequeueButton } from "./ForgeRequeueButton";
import { GhostIcon, BookmarkIcon } from "./icons";
import { isTypingTarget } from "../utils/typingTarget";
import { buildLoraWeightMap, parseBatchCount } from "../utils/forgeSendOptions";
import {
    MODEL_FAMILIES,
    RESOLUTION_PRESETS,
    detectResolutionFamilyFromModelName,
} from "../utils/modelFamilies";
import type { ModelFamilyId } from "../utils/modelFamilies";

interface PhotoViewerProps {
    images: GalleryImageRecord[];
    currentIndex: number;
    onNavigate: (index: number) => void;
    onClose: () => void;
    forgeBaseUrl: string;
    forgeApiKey: string;
    forgeOutputDir: string;
    forgeModelsPath: string;
    forgeModelsScanSubfolders: boolean;
    forgeLoraPath: string;
    forgeLoraScanSubfolders: boolean;
    /** Opens Settings at the Forge section; folder paths are edited only there. */
    onOpenForgeSettings: () => void;
    forgeSelectedLoras: string[];
    onForgeSelectedLorasChange: (values: string[]) => void;
    forgeLoraWeight: string;
    onForgeLoraWeightChange: (value: string) => void;
    /** Per-LoRA weight overrides keyed by LoRA token (typed text). Missing = use forgeLoraWeight. */
    forgeLoraWeights: Record<string, string>;
    onForgeLoraWeightsChange: (value: Record<string, string>) => void;
    forgeBatchCount: string;
    onForgeBatchCountChange: (value: string) => void;
    forgeSaveCopy: boolean;
    onForgeSaveCopyChange: (value: boolean) => void;
    forgeIncludeSeed: boolean;
    forgeAdetailerFaceEnabled: boolean;
    forgeAdetailerFaceModel: string;
    onSearchBySeed: (seed: string) => void;
    onDeleteCurrentImage: (image: GalleryImageRecord) => void;
    isDeletingCurrentImage: boolean;
    onToggleFavorite: (image: GalleryImageRecord) => void;
    onToggleLocked: (image: GalleryImageRecord) => void;
    onShowToast: (message: string, options?: ShowToastOptions) => void;
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const ZOOM_STEP = 0.2;
const FILMSTRIP_ITEM_WIDTH = 76;
const FILMSTRIP_PREFETCH_OVERSCAN = 20;
const FILMSTRIP_CHUNK_SIZE = 64;
const FILMSTRIP_CONCURRENCY = Math.max(
    3,
    Math.min(12, navigator.hardwareConcurrency || 8)
);
const FORGE_STEPS_MIN = 1;
const FORGE_STEPS_MAX = 150;
const FORGE_CFG_SCALE_MIN = 1;
const FORGE_CFG_SCALE_MAX = 30;
const FORGE_LORA_WEIGHT_MIN = 0;
const FORGE_LORA_WEIGHT_MAX = 2;
const DEFAULT_SLIDESHOW_INTERVAL = 4000;
const SLIDESHOW_INTERVAL_OPTIONS = [
    { label: "2s", value: 2000 },
    { label: "4s", value: 4000 },
    { label: "6s", value: 6000 },
    { label: "8s", value: 8000 },
];
const SINGLE_IMAGE_EXPORT_OPTIONS: { value: ImageExportFormat; label: string }[] = [
    { value: "original", label: "Original (ZIP)" },
    { value: "png", label: "PNG" },
    { value: "jpeg", label: "JPEG" },
    { value: "webp", label: "WebP" },
    { value: "jxl", label: "JPEG XL" },
];
const ADETAILER_FACE_MODELS = ["face_yolov8n.pt", "face_yolov8s.pt"];
const FORGE_PAYLOAD_PRESETS_STORAGE_KEY = "forgePayloadPresets";

function toAssetSrc(filepath: string): string {
    return convertFileSrc(filepath.replace(/\\/g, "/"));
}

interface ForgePayloadPreset {
    forge_overrides: ForgePayloadOverrides;
    send_seed_with_request: boolean;
    adetailer_face_enabled: boolean;
    adetailer_face_model: string;
    lora_tokens: string[];
    lora_weight: string;
    /** Per-LoRA weights; absent in presets saved before per-LoRA weights existed. */
    lora_weights?: Record<string, string>;
}

function parseForgePayloadPresets(
    raw: string
): Record<string, ForgePayloadPreset> | undefined {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return undefined;
        }
        return Object.entries(parsed).reduce<Record<string, ForgePayloadPreset>>(
            (acc, [name, value]) => {
                if (!name || !value || typeof value !== "object") {
                    return acc;
                }
                const candidate = value as Partial<ForgePayloadPreset>;
                if (!candidate.forge_overrides || typeof candidate.forge_overrides !== "object") {
                    return acc;
                }
                acc[name] = {
                    forge_overrides: {
                        ...createEmptyForgeOverrides(),
                        ...candidate.forge_overrides,
                    },
                    send_seed_with_request: Boolean(candidate.send_seed_with_request),
                    adetailer_face_enabled: Boolean(candidate.adetailer_face_enabled),
                    adetailer_face_model:
                        typeof candidate.adetailer_face_model === "string" &&
                        candidate.adetailer_face_model.trim()
                            ? candidate.adetailer_face_model
                            : "face_yolov8n.pt",
                    lora_tokens: Array.isArray(candidate.lora_tokens)
                        ? candidate.lora_tokens.filter(
                              (entry): entry is string =>
                                  typeof entry === "string" && entry.trim().length > 0
                          )
                        : [],
                    lora_weight:
                        typeof candidate.lora_weight === "string" &&
                        candidate.lora_weight.trim()
                            ? candidate.lora_weight
                            : "1.0",
                    lora_weights:
                        candidate.lora_weights &&
                        typeof candidate.lora_weights === "object" &&
                        !Array.isArray(candidate.lora_weights)
                            ? Object.fromEntries(
                                  Object.entries(candidate.lora_weights).filter(
                                      (entry): entry is [string, string] =>
                                          typeof entry[1] === "string"
                                  )
                              )
                            : {},
                };
                return acc;
            },
            {}
        );
    } catch {
        return undefined;
    }
}

const forgePayloadPresetStorage = {
    serialize: (value: Record<string, ForgePayloadPreset>) =>
        JSON.stringify(value),
    deserialize: parseForgePayloadPresets,
};

const slideshowIntervalStorage = {
    serialize: (value: number) => String(value),
    deserialize: (raw: string): number | undefined => {
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed >= 1000
            ? parsed
            : undefined;
    },
};

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function validateOptionalInteger(
    value: string,
    min: number,
    max: number,
    fieldLabel: string
): string | null {
    const normalized = value.trim();
    if (!normalized) {
        return null;
    }
    const parsed = Number(normalized);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        return `${fieldLabel} must be an integer from ${min} to ${max}.`;
    }
    return null;
}

function validateOptionalFloat(
    value: string,
    min: number,
    max: number,
    fieldLabel: string
): string | null {
    const normalized = value.trim();
    if (!normalized) {
        return null;
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        return `${fieldLabel} must be between ${min} and ${max}.`;
    }
    return null;
}

function createEmptyForgeOverrides(): ForgePayloadOverrides {
    return {
        prompt: "",
        negative_prompt: "",
        steps: "",
        sampler_name: "",
        scheduler: "",
        cfg_scale: "",
        seed: "",
        width: "",
        height: "",
        model_name: "",
    };
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function createForgeOverrides(
    image: GalleryImageRecord | null,
    detail: ImageRecord | null
): ForgePayloadOverrides {
    if (!image) {
        return createEmptyForgeOverrides();
    }

    return {
        prompt: detail?.prompt ?? "",
        negative_prompt: detail?.negative_prompt ?? "",
        steps: detail?.steps ?? "",
        sampler_name: detail?.sampler ?? "",
        scheduler: "",
        cfg_scale: detail?.cfg_scale ?? "",
        seed: detail?.seed ?? image.seed ?? "",
        width: String(detail?.width ?? image.width ?? ""),
        height: String(detail?.height ?? image.height ?? ""),
        model_name: detail?.model_name ?? image.model_name ?? "",
    };
}

export function PhotoViewer({
    images,
    currentIndex,
    onNavigate,
    onClose,
    forgeBaseUrl,
    forgeApiKey,
    forgeOutputDir,
    forgeModelsPath,
    forgeModelsScanSubfolders,
    forgeLoraPath,
    forgeLoraScanSubfolders,
    onOpenForgeSettings,
    forgeSelectedLoras,
    onForgeSelectedLorasChange,
    forgeLoraWeight,
    onForgeLoraWeightChange,
    forgeLoraWeights,
    onForgeLoraWeightsChange,
    forgeBatchCount,
    onForgeBatchCountChange,
    forgeSaveCopy,
    onForgeSaveCopyChange,
    forgeIncludeSeed,
    forgeAdetailerFaceEnabled,
    forgeAdetailerFaceModel,
    onSearchBySeed,
    onDeleteCurrentImage,
    isDeletingCurrentImage,
    onToggleFavorite,
    onToggleLocked,
    onShowToast,
}: PhotoViewerProps) {
    const currentImage = images[currentIndex] ?? null;
    const [currentDetail, setCurrentDetail] = useState<ImageRecord | null>(null);
    const [isDetailLoading, setIsDetailLoading] = useState(false);
    const [detailFailed, setDetailFailed] = useState(false);
    const [detailReloadKey, setDetailReloadKey] = useState(0);

    const [isSavingSidecar, setIsSavingSidecar] = useState(false);

    const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null);
    const [displayImagePath, setDisplayImagePath] = useState<string | null>(null);
    const [fullResLoaded, setFullResLoaded] = useState(false);
    const [fullResError, setFullResError] = useState(false);
    const [fallbackDataUrl, setFallbackDataUrl] = useState<string | null>(null);
    const [imageContextMenu, setImageContextMenu] = useState<{
        x: number;
        y: number;
    } | null>(null);

    const [sidecarNotes, setSidecarNotes] = useState("");
    const [sidecarTags, setSidecarTags] = useState<string[]>([]);
    const [tagInput, setTagInput] = useState("");
    const [forgeOverrides, setForgeOverrides] = useState<ForgePayloadOverrides>(
        createEmptyForgeOverrides
    );
    const [sendSeedForCurrentRequest, setSendSeedForCurrentRequest] =
        useState(forgeIncludeSeed);
    const [useAdetailerForCurrentRequest, setUseAdetailerForCurrentRequest] = useState(
        forgeAdetailerFaceEnabled
    );
    const [adetailerFaceModelForCurrentRequest, setAdetailerFaceModelForCurrentRequest] =
        useState(forgeAdetailerFaceModel || "face_yolov8n.pt");
    const [forgeModelOptions, setForgeModelOptions] = useState<string[]>([]);
    const [forgeLoraOptions, setForgeLoraOptions] = useState<string[]>([]);
    const [forgeSamplerOptions, setForgeSamplerOptions] = useState<string[]>([]);
    const [forgeSchedulerOptions, setForgeSchedulerOptions] = useState<string[]>([]);
    const [forgeOptionsWarning, setForgeOptionsWarning] = useState<string | null>(null);
    const [isLoadingForgeOptions, setIsLoadingForgeOptions] = useState(false);
    const [forgePayloadPresets, setForgePayloadPresets] = usePersistedState<
        Record<string, ForgePayloadPreset>
    >(
        FORGE_PAYLOAD_PRESETS_STORAGE_KEY,
        {},
        forgePayloadPresetStorage
    );
    const [selectedForgePreset, setSelectedForgePreset] = useState("");
    const [forgePresetNameInput, setForgePresetNameInput] = useState("");
    const [singleImageExportFormat, setSingleImageExportFormat] =
        useState<ImageExportFormat>("original");
    const [singleImageExportQuality, setSingleImageExportQuality] = useState(85);

    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [isInfoOpen, setIsInfoOpen] = useState(true);
    const [infoPanelTab, setInfoPanelTab] = useState<"info" | "forge" | "lineage">("info");
    const [lineageCursor, setLineageCursor] = useState<LineageCursor | null>(null);
    const [lineageTrace, setLineageTrace] = useState<LineageTrace | null>(null);
    const [isLineageLoading, setIsLineageLoading] = useState(false);
    const [lineageThumbs, setLineageThumbs] = useState<Record<string, string>>({});
    const [linkParentInput, setLinkParentInput] = useState("");
    const [linkRelationInput, setLinkRelationInput] = useState("seed_walk");
    const [isLineageMutating, setIsLineageMutating] = useState(false);
    const [expandedGhostIds, setExpandedGhostIds] = useState<Set<number>>(() => new Set());
    const toggleGhostExpanded = useCallback((id: number) => {
        setExpandedGhostIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);
    const lineageRequestRef = useRef(0);
    const [isPromptLibraryOpen, setIsPromptLibraryOpen] = useState(false);
    const [promptLibraryNote, setPromptLibraryNote] = useState<string | null>(null);
    const [isSlideshow, setIsSlideshow] = useState(false);
    const [slideshowIntervalMs, setSlideshowIntervalMs] = usePersistedState(
        "viewerSlideshowIntervalMs",
        DEFAULT_SLIDESHOW_INTERVAL,
        slideshowIntervalStorage
    );
    const [selectedResolutionFamily, setSelectedResolutionFamily] =
        useState<ModelFamilyId>("unknown");
    const [filterModelsByFamily, setFilterModelsByFamily] = useState(false);
    const [isLoraDropdownOpen, setIsLoraDropdownOpen] = useState(false);
    const [loraSearch, setLoraSearch] = useState("");
    const [promptSectionOpen, setPromptSectionOpen] = usePersistedState(
        "forgeSectionPromptOpen",
        true,
        booleanStorage
    );
    const [samplingSectionOpen, setSamplingSectionOpen] = usePersistedState(
        "forgeSectionSamplingOpen",
        true,
        booleanStorage
    );
    const [sizeSectionOpen, setSizeSectionOpen] = usePersistedState(
        "forgeSectionSizeOpen",
        false,
        booleanStorage
    );
    const [modelLoraSectionOpen, setModelLoraSectionOpen] = usePersistedState(
        "forgeSectionModelLoraOpen",
        false,
        booleanStorage
    );
    const [upscaleSectionOpen, setUpscaleSectionOpen] = usePersistedState(
        "forgeSectionUpscaleOpen",
        false,
        booleanStorage
    );
    const [forgeUpscalerOptions, setForgeUpscalerOptions] = useState<string[]>([]);
    const [selectedUpscaler, setSelectedUpscaler] = useState<string>("");
    const [upscaleScale, setUpscaleScale] = useState<number>(2.0);
    const [isUpscaling, setIsUpscaling] = useState<boolean>(false);

    const panOriginRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(
        null
    );
    const slideshowRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const detailRequestRef = useRef(0);
    const forgeOverridesImageIdRef = useRef<number | null>(null);
    const loraDropdownRef = useRef<HTMLDivElement | null>(null);
    const filmstripRef = useRef<HTMLDivElement | null>(null);
    const viewerImageOpenStartRef = useRef<number | null>(null);

    const filmstripCacheRef = useRef<Map<string, string>>(new Map());
    const [filmstripThumbPaths, setFilmstripThumbPaths] = useState<Record<string, string>>({});

    const canGoPrev = currentIndex > 0;
    const canGoNext = currentIndex < images.length - 1;

    const goPrev = useCallback(() => {
        if (canGoPrev) {
            onNavigate(currentIndex - 1);
        }
    }, [canGoPrev, currentIndex, onNavigate]);

    const goNext = useCallback(() => {
        if (canGoNext) {
            onNavigate(currentIndex + 1);
        }
    }, [canGoNext, currentIndex, onNavigate]);

    const resetTransform = useCallback(() => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
    }, []);

    const zoomBy = useCallback((delta: number) => {
        setZoom((prev) => {
            const next = clamp(prev + delta, ZOOM_MIN, ZOOM_MAX);
            if (next <= ZOOM_MIN) {
                setPan({ x: 0, y: 0 });
            }
            return next;
        });
    }, []);

    const zoomIn = useCallback(() => {
        zoomBy(ZOOM_STEP);
    }, [zoomBy]);

    const zoomOut = useCallback(() => {
        zoomBy(-ZOOM_STEP);
    }, [zoomBy]);

    // Slideshow
    const toggleSlideshow = useCallback(() => {
        setIsSlideshow((prev) => !prev);
    }, []);

    useEffect(() => {
        if (!isSlideshow) {
            return;
        }
        slideshowRef.current = setInterval(() => {
            const next = currentIndex + 1;
            onNavigate(next < images.length ? next : 0);
        }, slideshowIntervalMs);
        return () => {
            if (slideshowRef.current) {
                clearInterval(slideshowRef.current);
                slideshowRef.current = null;
            }
        };
    }, [isSlideshow, currentIndex, images.length, onNavigate, slideshowIntervalMs]);

    const fullImageSrc = useMemo(
        () => {
            if (fallbackDataUrl) return fallbackDataUrl;
            return displayImagePath ? toAssetSrc(displayImagePath) : "";
        },
        [displayImagePath, fallbackDataUrl]
    );

    const currentParamEntries = useMemo(() => {
        if (!currentImage) {
            return [] as [string, string][];
        }

        const detail = currentDetail;
        const entries: [string, string][] = [];
        if (detail?.steps) entries.push(["Steps", detail.steps]);
        if (detail?.sampler) entries.push(["Sampler", detail.sampler]);
        if (detail?.cfg_scale) entries.push(["CFG Scale", detail.cfg_scale]);

        const seed = detail?.seed ?? currentImage.seed;
        if (seed) entries.push(["Seed", seed]);

        const width = detail?.width ?? currentImage.width;
        const height = detail?.height ?? currentImage.height;
        if (width && height) {
            entries.push(["Size", `${width}x${height}`]);
        }

        const modelName = detail?.model_name ?? currentImage.model_name;
        if (modelName) entries.push(["Model", modelName]);
        if (detail?.model_hash) entries.push(["Model Hash", detail.model_hash]);
        return entries;
    }, [currentDetail, currentImage]);

    const currentSeed = useMemo(
        () => (currentDetail?.seed ?? currentImage?.seed ?? "").trim(),
        [currentDetail?.seed, currentImage?.seed]
    );
    const showSingleImageExportQuality =
        singleImageExportFormat === "jpeg" || singleImageExportFormat === "webp";
    const imageContextMenuPosition = useMemo(() => {
        if (!imageContextMenu) {
            return null;
        }
        const menuWidth = 240;
        const menuHeight = 96;
        return {
            left: Math.max(
                8,
                Math.min(imageContextMenu.x, window.innerWidth - menuWidth - 8)
            ),
            top: Math.max(
                8,
                Math.min(imageContextMenu.y, window.innerHeight - menuHeight - 8)
            ),
        };
    }, [imageContextMenu]);

    const selectedResolutionPreset = useMemo(() => {
        const width = forgeOverrides.width.trim();
        const height = forgeOverrides.height.trim();
        const presets =
            RESOLUTION_PRESETS[selectedResolutionFamily] ??
            RESOLUTION_PRESETS["unknown"] ??
            [];
        const match = presets.find(
            (option) => option.width === width && option.height === height
        );
        return match ? `${match.width}x${match.height}` : "custom";
    }, [forgeOverrides.height, forgeOverrides.width, selectedResolutionFamily]);

    const detectedModelFamily = useMemo(
        () =>
            detectResolutionFamilyFromModelName(
                currentDetail?.model_name ?? currentImage?.model_name
            ),
        [currentDetail?.model_name, currentImage?.model_name]
    );

    const modelDropdownOptions = useMemo(() => {
        return forgeModelOptions;
    }, [forgeModelOptions]);

    const familyCompatibleModelOptions = useMemo(() => {
        if (!filterModelsByFamily) {
            return modelDropdownOptions;
        }
        const compatible = modelDropdownOptions.filter(
            (modelName) =>
                detectResolutionFamilyFromModelName(modelName) === detectedModelFamily
        );
        return compatible.length > 0 ? compatible : modelDropdownOptions;
    }, [detectedModelFamily, filterModelsByFamily, modelDropdownOptions]);

    const samplerDropdownOptions = useMemo(() => {
        const current = forgeOverrides.sampler_name.trim();
        if (!current) {
            return forgeSamplerOptions;
        }
        return forgeSamplerOptions.includes(current)
            ? forgeSamplerOptions
            : [current, ...forgeSamplerOptions];
    }, [forgeOverrides.sampler_name, forgeSamplerOptions]);

    const schedulerDropdownOptions = useMemo(() => {
        const current = forgeOverrides.scheduler.trim();
        // Schedulers Forge Neo lists but rejects with HTTP 500 are not offered for new picks.
        const usable = forgeSchedulerOptions.filter(
            (name) => !(REJECTED_SCHEDULERS as readonly string[]).includes(name.trim().toLowerCase())
        );
        if (!current) {
            return usable;
        }
        return usable.includes(current) ? usable : [current, ...usable];
    }, [forgeOverrides.scheduler, forgeSchedulerOptions]);

    const loraDropdownOptions = useMemo(() => {
        const merged = new Set<string>();
        for (const value of forgeSelectedLoras) {
            const normalized = value.trim();
            if (normalized) {
                merged.add(normalized);
            }
        }
        for (const value of forgeLoraOptions) {
            const normalized = value.trim();
            if (normalized) {
                merged.add(normalized);
            }
        }
        return Array.from(merged);
    }, [forgeLoraOptions, forgeSelectedLoras]);

    const filteredLoraOptions = useMemo(() => {
        const normalizedQuery = loraSearch.trim().toLowerCase();
        if (!normalizedQuery) {
            return loraDropdownOptions;
        }
        return loraDropdownOptions.filter((value) =>
            value.toLowerCase().includes(normalizedQuery)
        );
    }, [loraDropdownOptions, loraSearch]);

    const loraWeightSliderValue = useMemo(() => {
        const parsed = Number(forgeLoraWeight);
        if (!Number.isFinite(parsed)) {
            return 1;
        }
        return Math.max(0, Math.min(2, parsed));
    }, [forgeLoraWeight]);

    const stepsValidationError = useMemo(
        () =>
            validateOptionalInteger(
                forgeOverrides.steps,
                FORGE_STEPS_MIN,
                FORGE_STEPS_MAX,
                "Steps"
            ),
        [forgeOverrides.steps]
    );
    const cfgScaleValidationError = useMemo(
        () =>
            validateOptionalFloat(
                forgeOverrides.cfg_scale,
                FORGE_CFG_SCALE_MIN,
                FORGE_CFG_SCALE_MAX,
                "CFG Scale"
            ),
        [forgeOverrides.cfg_scale]
    );
    const loraWeightValidationError = useMemo(
        () =>
            validateOptionalFloat(
                forgeLoraWeight,
                FORGE_LORA_WEIGHT_MIN,
                FORGE_LORA_WEIGHT_MAX,
                "LoRA Weight"
            ),
        [forgeLoraWeight]
    );
    const loraWeightErrors = useMemo(() => {
        const errors: Record<string, string | null> = {};
        for (const lora of forgeSelectedLoras) {
            errors[lora] = validateOptionalFloat(
                forgeLoraWeights[lora] ?? "",
                FORGE_LORA_WEIGHT_MIN,
                FORGE_LORA_WEIGHT_MAX,
                `Weight for ${lora}`
            );
        }
        return errors;
    }, [forgeLoraWeights, forgeSelectedLoras]);
    const loraWeightErrorMessages = Object.values(loraWeightErrors).filter(
        (message): message is string => message != null
    );
    const effectiveLoraWeights = useMemo(
        () => buildLoraWeightMap(forgeSelectedLoras, forgeLoraWeights),
        [forgeLoraWeights, forgeSelectedLoras]
    );
    const batchCountParse = useMemo(() => parseBatchCount(forgeBatchCount), [forgeBatchCount]);
    const hasForgeValidationErrors =
        stepsValidationError != null ||
        cfgScaleValidationError != null ||
        loraWeightValidationError != null ||
        loraWeightErrorMessages.length > 0 ||
        batchCountParse.error != null;
    const forgeUrlValidationError = useMemo(() => {
        const normalized = forgeBaseUrl.trim();
        if (!normalized) {
            return "Forge URL is required before sending.";
        }
        try {
            const parsed = new URL(normalized);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                return "Forge URL must use http:// or https://.";
            }
            return null;
        } catch {
            return "Forge URL is invalid. Update it in sidebar settings.";
        }
    }, [forgeBaseUrl]);
    const hasValidForgeUrl = forgeUrlValidationError == null;

    const { forgeProblems, forgeHints } = useMemo(() => {
        if (!forgeOptionsWarning) {
            return { forgeProblems: [] as string[], forgeHints: [] as string[] };
        }
        const parts = forgeOptionsWarning.split(" | ");
        const problems: string[] = [];
        const hints: string[] = [];
        for (const part of parts) {
            if (part.startsWith("LoRA directory not configured")) {
                hints.push(part);
            } else {
                problems.push(part);
            }
        }
        return { forgeProblems: problems, forgeHints: hints };
    }, [forgeOptionsWarning]);

    const showLoraHint = useMemo(() => {
        const promptHasLora = forgeOverrides.prompt.includes("<lora:");
        const loraSelected = forgeSelectedLoras.length > 0;
        return (promptHasLora || loraSelected) && forgeHints.length > 0;
    }, [forgeOverrides.prompt, forgeSelectedLoras.length, forgeHints.length]);

    const adetailerModelDropdownOptions = useMemo(() => {
        const current = adetailerFaceModelForCurrentRequest.trim();
        if (!current) {
            return ADETAILER_FACE_MODELS;
        }
        return ADETAILER_FACE_MODELS.includes(current)
            ? ADETAILER_FACE_MODELS
            : [current, ...ADETAILER_FACE_MODELS];
    }, [adetailerFaceModelForCurrentRequest]);

    const detectedFunctionality = useMemo(() => {
        const prompt = (currentDetail?.prompt ?? "").toLowerCase();
        const raw = (currentDetail?.raw_metadata ?? "").toLowerCase();
        const tags = ["checkpoint"];
        if (prompt.includes("<lora:") || raw.includes("lora")) {
            tags.push("lora");
        }
        if (raw.includes("vae")) {
            tags.push("vae");
        }
        return tags.join(", ");
    }, [currentDetail?.prompt, currentDetail?.raw_metadata]);

    const forgePresetNames = useMemo(
        () => Object.keys(forgePayloadPresets).sort((left, right) => left.localeCompare(right)),
        [forgePayloadPresets]
    );

    useEffect(() => {
        const imageId = currentImage?.id;
        if (!imageId) {
            setCurrentDetail(null);
            setIsDetailLoading(false);
            return;
        }

        let cancelled = false;
        const requestId = detailRequestRef.current + 1;
        detailRequestRef.current = requestId;

        setCurrentDetail(null);
        setDetailFailed(false);
        setIsDetailLoading(true);

        getImageDetail(imageId)
            .then((detail) => {
                if (cancelled || detailRequestRef.current !== requestId) {
                    return;
                }
                setCurrentDetail(detail);
                setDetailFailed(detail == null);
            })
            .catch(() => {
                if (cancelled || detailRequestRef.current !== requestId) {
                    return;
                }
                setCurrentDetail(null);
                setDetailFailed(true);
            })
            .finally(() => {
                if (cancelled || detailRequestRef.current !== requestId) {
                    return;
                }
                setIsDetailLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [currentImage?.id, detailReloadKey]);

    useEffect(() => {
        forgeOverridesImageIdRef.current = null;
        setForgeOverrides(createEmptyForgeOverrides());
    }, [currentImage?.id]);

    useEffect(() => {
        setSendSeedForCurrentRequest(forgeIncludeSeed);
    }, [forgeIncludeSeed, currentImage?.id]);

    useEffect(() => {
        setUseAdetailerForCurrentRequest(forgeAdetailerFaceEnabled);
    }, [forgeAdetailerFaceEnabled, currentImage?.id]);

    useEffect(() => {
        setAdetailerFaceModelForCurrentRequest(
            forgeAdetailerFaceModel || "face_yolov8n.pt"
        );
    }, [forgeAdetailerFaceModel, currentImage?.id]);

    useEffect(() => {
        if (!currentImage || !currentDetail) {
            return;
        }
        if (
            !shouldPopulateForgeOverrides({
                imageId: currentImage.id,
                detailId: currentDetail.id,
                populatedForId: forgeOverridesImageIdRef.current,
            })
        ) {
            return;
        }
        setForgeOverrides(createForgeOverrides(currentImage, currentDetail));
        forgeOverridesImageIdRef.current = currentImage.id;
    }, [currentDetail, currentImage]);

    const refreshForgeOptions = useCallback(async () => {
        if (!forgeBaseUrl.trim()) {
            setForgeModelOptions([]);
            setForgeLoraOptions([]);
            setForgeSamplerOptions([]);
            setForgeSchedulerOptions([]);
            setForgeOptionsWarning(null);
            return;
        }

        setIsLoadingForgeOptions(true);
        setForgeOptionsWarning(null);

        try {
            const options = await forgeGetOptions(
                forgeBaseUrl,
                forgeApiKey.trim() ? forgeApiKey : null,
                forgeModelsPath.trim() ? forgeModelsPath : null,
                forgeModelsScanSubfolders,
                forgeLoraPath.trim() ? forgeLoraPath : null,
                forgeLoraScanSubfolders
            );
            setForgeModelOptions(options.models);
            setForgeLoraOptions(options.loras);
            setForgeSamplerOptions(options.samplers);
            setForgeSchedulerOptions(options.schedulers);
            setForgeOptionsWarning(
                options.warnings.length > 0 ? options.warnings.join(" | ") : null
            );

            try {
                const upscalers = await forgeGetUpscalers(
                    forgeBaseUrl,
                    forgeApiKey.trim() ? forgeApiKey : null
                );
                setForgeUpscalerOptions(upscalers);
                setSelectedUpscaler((prev) => {
                    if (prev && upscalers.includes(prev)) return prev;
                    const defaultChoice =
                        upscalers.find((u) => u.includes("R-ESRGAN 4x+")) ??
                        upscalers[0] ??
                        "";
                    return defaultChoice;
                });
            } catch {
                setForgeUpscalerOptions([]);
            }
        } catch (error) {
            setForgeModelOptions([]);
            setForgeLoraOptions([]);
            setForgeSamplerOptions([]);
            setForgeSchedulerOptions([]);
            setForgeUpscalerOptions([]);
            setForgeOptionsWarning(`Forge options unavailable: ${String(error)}`);
        } finally {
            setIsLoadingForgeOptions(false);
        }
    }, [
        forgeApiKey,
        forgeBaseUrl,
        forgeLoraPath,
        forgeLoraScanSubfolders,
        forgeModelsPath,
        forgeModelsScanSubfolders,
    ]);

    useEffect(() => {
        void refreshForgeOptions();
    }, [refreshForgeOptions]);

    // Retry once when the Forge tab is opened if the last load failed or came back empty. This used
    // to re-run on every warning/model change, and refreshForgeOptions itself changes both, so the
    // panel refetched in a loop and flickered while Forge was unreachable or returned warnings.
    useRunOncePerActivation(infoPanelTab === "forge", () => {
        if (forgeOptionsWarning != null || forgeModelOptions.length === 0) {
            void refreshForgeOptions();
        }
    });

    useEffect(() => {
        if (!forgeModelOptions.length) {
            return;
        }
        const currentModel = forgeOverrides.model_name.trim();
        if (!currentModel) {
            return;
        }
        if (!forgeModelOptions.includes(currentModel)) {
            setForgeOverrides((prev) => ({ ...prev, model_name: "" }));
        }
    }, [forgeModelOptions, forgeOverrides.model_name]);

    useEffect(() => {
        if (!currentImage) {
            return;
        }
        setSelectedResolutionFamily(detectedModelFamily);
    }, [currentImage, detectedModelFamily]);

    useEffect(() => {
        if (!isLoraDropdownOpen) {
            return;
        }
        const handleOutsideClick = (event: MouseEvent) => {
            const target = event.target as Node;
            if (!loraDropdownRef.current?.contains(target)) {
                setIsLoraDropdownOpen(false);
            }
        };
        window.addEventListener("mousedown", handleOutsideClick);
        return () => {
            window.removeEventListener("mousedown", handleOutsideClick);
        };
    }, [isLoraDropdownOpen]);

    useEffect(() => {
        if (!currentImage?.filepath) {
            setLineageCursor(null);
            setLineageTrace(null);
            setLineageThumbs({});
            setIsLineageLoading(false);
            return;
        }
        let cancelled = false;
        const reqId = lineageRequestRef.current + 1;
        lineageRequestRef.current = reqId;
        setIsLineageLoading(true);

        const pCursor = getLineageCursor(currentImage.filepath)
            .then((cursor) => {
                if (cancelled || lineageRequestRef.current !== reqId) return null;
                setLineageCursor(cursor);
                return cursor;
            })
            .catch(() => {
                if (cancelled || lineageRequestRef.current !== reqId) return null;
                setLineageCursor({ ancestors: [], children: [] });
                return null;
            });

        const pTrace = currentImage.id
            ? getLineageTrace(currentImage.id)
                  .then((trace) => {
                      if (cancelled || lineageRequestRef.current !== reqId) return null;
                      setLineageTrace(trace);
                      return trace;
                  })
                  .catch(() => {
                      if (cancelled || lineageRequestRef.current !== reqId) return null;
                      setLineageTrace(null);
                      return null;
                  })
            : Promise.resolve(null);

        Promise.all([pCursor, pTrace])
            .then(([cursor, trace]) => {
                if (cancelled || lineageRequestRef.current !== reqId) return;
                const allPaths: string[] = [];
                if (cursor) {
                    allPaths.push(
                        ...cursor.ancestors.map((e) => e.parent_filepath),
                        ...cursor.children.map((e) => e.child_filepath)
                    );
                }
                if (trace) {
                    allPaths.push(
                        ...trace.nodes
                            .filter((n) => !n.is_ghost && !n.filepath.startsWith("ghost://"))
                            .map((n) => n.filepath)
                    );
                }
                const uniquePaths = Array.from(new Set(allPaths.filter(Boolean)));
                if (uniquePaths.length === 0) {
                    setLineageThumbs({});
                    return;
                }
                return getThumbnailPaths(uniquePaths).then((mappings) => {
                    if (cancelled || lineageRequestRef.current !== reqId) return;
                    const next: Record<string, string> = {};
                    for (const m of mappings) {
                        if (m.thumbnail_path !== m.filepath) next[m.filepath] = m.thumbnail_path;
                    }
                    setLineageThumbs(next);
                });
            })
            .catch(() => {})
            .finally(() => {
                if (cancelled || lineageRequestRef.current !== reqId) return;
                setIsLineageLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [currentImage?.filepath, currentImage?.id]);

    useEffect(() => {
        if (zoom <= 1) {
            setPan({ x: 0, y: 0 });
        }
    }, [isInfoOpen, zoom]);

    useEffect(() => {
        const handleResize = () => {
            if (zoom <= 1) {
                setPan({ x: 0, y: 0 });
            }
        };
        window.addEventListener("resize", handleResize);
        return () => {
            window.removeEventListener("resize", handleResize);
        };
    }, [zoom]);

    useEffect(() => {
        if (!selectedForgePreset) {
            return;
        }
        if (forgePayloadPresets[selectedForgePreset]) {
            setForgePresetNameInput(selectedForgePreset);
            return;
        }
        setSelectedForgePreset("");
    }, [forgePayloadPresets, selectedForgePreset]);

    const filmstripVirtualizer = useVirtualizer({
        count: images.length,
        getScrollElement: () => filmstripRef.current,
        estimateSize: () => FILMSTRIP_ITEM_WIDTH,
        horizontal: true,
        overscan: 12,
    });
    const filmstripVirtualItems = filmstripVirtualizer.getVirtualItems();

    const filmstripPrefetchFilepaths = useMemo(() => {
        if (images.length === 0) {
            return [] as string[];
        }

        const indexSet = new Set<number>();
        indexSet.add(currentIndex);

        for (const virtualItem of filmstripVirtualItems) {
            const start = Math.max(0, virtualItem.index - FILMSTRIP_PREFETCH_OVERSCAN);
            const end = Math.min(
                images.length - 1,
                virtualItem.index + FILMSTRIP_PREFETCH_OVERSCAN
            );
            for (let index = start; index <= end; index += 1) {
                indexSet.add(index);
            }
        }

        return Array.from(indexSet)
            .sort((left, right) => left - right)
            .map((index) => images[index].filepath);
    }, [currentIndex, filmstripVirtualItems, images]);

    const addSidecarTag = useCallback((rawTag: string) => {
        const normalized = rawTag.trim().toLowerCase();
        if (!normalized) {
            return;
        }
        setSidecarTags((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
        setTagInput("");
    }, []);

    const removeSidecarTag = useCallback((tag: string) => {
        setSidecarTags((prev) => prev.filter((value) => value !== tag));
    }, []);

    const updateForgeOverride = useCallback(
        (field: keyof ForgePayloadOverrides, value: string) => {
            setForgeOverrides((prev) => ({ ...prev, [field]: value }));
        },
        []
    );

    const handleSavePromptToLibrary = useCallback(async () => {
        if (!forgeOverrides.prompt.trim()) {
            setPromptLibraryNote("Nothing to save: the prompt is empty.");
            return;
        }
        try {
            const result = await savePrompt({
                prompt: forgeOverrides.prompt,
                negativePrompt: forgeOverrides.negative_prompt,
                sourceImageId: currentImage?.id,
            });
            setPromptLibraryNote(
                result.created ? "Saved to prompt library." : "Already in the prompt library."
            );
        } catch (error) {
            setPromptLibraryNote(error instanceof Error ? error.message : String(error));
        }
    }, [forgeOverrides.prompt, forgeOverrides.negative_prompt, currentImage?.id]);

    const handleResolutionPresetChange = useCallback((value: string) => {
        if (value === "custom") {
            return;
        }
        const [width, height] = value.split("x");
        if (!width || !height) {
            return;
        }
        setForgeOverrides((prev) => ({ ...prev, width, height }));
    }, []);

    const removeSelectedLora = useCallback(
        (loraToken: string) => {
            onForgeSelectedLorasChange(
                forgeSelectedLoras.filter((value) => value !== loraToken)
            );
            if (loraToken in forgeLoraWeights) {
                const { [loraToken]: _dropped, ...rest } = forgeLoraWeights;
                onForgeLoraWeightsChange(rest);
            }
        },
        [forgeLoraWeights, forgeSelectedLoras, onForgeLoraWeightsChange, onForgeSelectedLorasChange]
    );

    const toggleLoraSelection = useCallback(
        (loraToken: string) => {
            const token = loraToken.trim();
            if (!token) {
                return;
            }
            if (forgeSelectedLoras.includes(token)) {
                removeSelectedLora(token);
                return;
            }
            onForgeSelectedLorasChange([...forgeSelectedLoras, token]);
        },
        [forgeSelectedLoras, onForgeSelectedLorasChange, removeSelectedLora]
    );

    const setLoraWeight = useCallback(
        (loraToken: string, value: string) => {
            onForgeLoraWeightsChange({ ...forgeLoraWeights, [loraToken]: value });
        },
        [forgeLoraWeights, onForgeLoraWeightsChange]
    );

    const showViewerToast = useCallback(
        (
            message: string,
            tone: ShowToastOptions["tone"] = "info",
            durationMs = 2800
        ) => {
            onShowToast(message, { tone, durationMs });
        },
        [onShowToast]
    );

    const handleLineageJump = useCallback(
        (filepath: string) => {
            const idx = images.findIndex((img) => img.filepath === filepath);
            if (idx === -1) {
                showViewerToast("Image not in current gallery view.", "warning");
                return;
            }
            onNavigate(idx);
        },
        [images, onNavigate, showViewerToast]
    );

    const refreshLineage = useCallback(async () => {
        if (!currentImage?.filepath) return;
        const reqId = lineageRequestRef.current + 1;
        lineageRequestRef.current = reqId;
        setIsLineageLoading(true);
        try {
            const cursor = await getLineageCursor(currentImage.filepath);
            if (lineageRequestRef.current !== reqId) return;
            setLineageCursor(cursor);
            const allPaths = [
                ...cursor.ancestors.map((e) => e.parent_filepath),
                ...cursor.children.map((e) => e.child_filepath),
            ];
            if (allPaths.length > 0) {
                try {
                    const mappings = await getThumbnailPaths(allPaths);
                    const next: Record<string, string> = {};
                    for (const m of mappings) {
                        if (m.thumbnail_path !== m.filepath) next[m.filepath] = m.thumbnail_path;
                    }
                    // Merge: replacing would drop the trace-back nodes' thumbnails loaded elsewhere.
                    setLineageThumbs((prev) => ({ ...prev, ...next }));
                } catch (_e) {
                    void _e;
                }
            }
        } catch (_e) {
            void _e;
            setLineageCursor({ ancestors: [], children: [] });
        } finally {
            if (lineageRequestRef.current === reqId) setIsLineageLoading(false);
        }
    }, [currentImage?.filepath]);

    const handleLineageUnlink = useCallback(
        async (edge: LineageEdge, direction: "ancestor" | "child") => {
            if (!currentImage) return;
            const child = direction === "ancestor" ? currentImage.filepath : edge.child_filepath;
            const parent = direction === "ancestor" ? edge.parent_filepath : currentImage.filepath;
            setIsLineageMutating(true);
            try {
                await setLineageOverride(child, parent, edge.relation, edge.confidence, "unlink");
                showViewerToast("Unlinked.", "success", 2200);
                await refreshLineage();
            } catch (e) {
                showViewerToast(`Unlink failed: ${String(e)}`, "error");
            } finally {
                setIsLineageMutating(false);
            }
        },
        [currentImage, refreshLineage, showViewerToast]
    );

    const handleLineageLink = useCallback(async () => {
        if (!currentImage) return;
        const parent = linkParentInput.trim();
        if (!parent) {
            showViewerToast("Enter parent filepath to link.", "warning");
            return;
        }
        const relation = linkRelationInput.trim() || "seed_walk";
        setIsLineageMutating(true);
        try {
            await setLineageOverride(currentImage.filepath, parent, relation, 1.0, "link");
            showViewerToast("Linked.", "success", 2200);
            setLinkParentInput("");
            await refreshLineage();
        } catch (e) {
            showViewerToast(`Link failed: ${String(e)}`, "error");
        } finally {
            setIsLineageMutating(false);
        }
    }, [currentImage, linkParentInput, linkRelationInput, refreshLineage, showViewerToast]);

    const handlePinCurrentToCompare = useCallback(() => {
        if (!currentImage) return;
        const ok = useCompareLabStore.getState().pin(currentImage);
        showViewerToast(ok ? "Pinned to Compare Lab." : "Compare Lab full (4 max).", ok ? "success" : "warning", 2200);
    }, [currentImage, showViewerToast]);

    const handlePinLineageToCompare = useCallback(
        (filepath: string) => {
            const found = images.find((img) => img.filepath === filepath);
            if (!found) {
                showViewerToast("Image not in current gallery view.", "warning");
                return;
            }
            const ok = useCompareLabStore.getState().pin(found);
            showViewerToast(ok ? `Pinned ${found.filename}` : "Compare Lab full (4 max).", ok ? "success" : "warning", 2200);
        },
        [images, showViewerToast]
    );

    const applyForgePayloadPreset = useCallback(
        (name: string) => {
            const preset = forgePayloadPresets[name];
            if (!preset) {
                showViewerToast(`Preset not found: ${name}`, "warning");
                return;
            }
            setForgeOverrides({
                ...createEmptyForgeOverrides(),
                ...preset.forge_overrides,
            });
            setSendSeedForCurrentRequest(preset.send_seed_with_request);
            setUseAdetailerForCurrentRequest(preset.adetailer_face_enabled);
            setAdetailerFaceModelForCurrentRequest(
                preset.adetailer_face_model || "face_yolov8n.pt"
            );
            onForgeSelectedLorasChange(preset.lora_tokens ?? []);
            onForgeLoraWeightChange(preset.lora_weight || "1.0");
            onForgeLoraWeightsChange(preset.lora_weights ?? {});
            showViewerToast(`Loaded preset: ${name}`, "success", 2400);
        },
        [
            forgePayloadPresets,
            onForgeLoraWeightChange,
            onForgeLoraWeightsChange,
            onForgeSelectedLorasChange,
            showViewerToast,
        ]
    );

    const saveCurrentAsForgePreset = useCallback(() => {
        const name = forgePresetNameInput.trim();
        if (!name) {
            showViewerToast("Enter a preset name.", "warning");
            return;
        }

        const preset: ForgePayloadPreset = {
            forge_overrides: { ...forgeOverrides },
            send_seed_with_request: sendSeedForCurrentRequest,
            adetailer_face_enabled: useAdetailerForCurrentRequest,
            adetailer_face_model:
                adetailerFaceModelForCurrentRequest || "face_yolov8n.pt",
            lora_tokens: [...forgeSelectedLoras],
            lora_weight: forgeLoraWeight || "1.0",
            lora_weights: Object.fromEntries(
                forgeSelectedLoras
                    .filter((lora) => (forgeLoraWeights[lora] ?? "").trim() !== "")
                    .map((lora) => [lora, forgeLoraWeights[lora]])
            ),
        };

        setForgePayloadPresets((prev) => ({ ...prev, [name]: preset }));
        setSelectedForgePreset(name);
        setForgePresetNameInput(name);
        showViewerToast(`Saved preset: ${name}`, "success", 2400);
    }, [
        adetailerFaceModelForCurrentRequest,
        forgeLoraWeight,
        forgeLoraWeights,
        forgeOverrides,
        forgePresetNameInput,
        forgeSelectedLoras,
        sendSeedForCurrentRequest,
        setForgePayloadPresets,
        showViewerToast,
        useAdetailerForCurrentRequest,
    ]);

    const deleteForgePreset = useCallback(() => {
        const name = selectedForgePreset.trim();
        if (!name) {
            showViewerToast("Select a preset to delete.", "warning");
            return;
        }

        setForgePayloadPresets((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
        });
        setSelectedForgePreset("");
        showViewerToast(`Deleted preset: ${name}`, "success", 2400);
    }, [selectedForgePreset, setForgePayloadPresets, showViewerToast]);

    const copyText = useCallback(async (value: string, successMessage: string) => {
        try {
            await navigator.clipboard.writeText(value);
            showViewerToast(successMessage, "success", 2400);
        } catch {
            showViewerToast("Clipboard write failed.", "error");
        }
    }, [showViewerToast]);

    const openImageContextMenu = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            event.preventDefault();
            setImageContextMenu({
                x: event.clientX,
                y: event.clientY,
            });
        },
        []
    );

    const copyCompressedCurrentImage = useCallback(async () => {
        if (!currentImage) {
            return;
        }
        setImageContextMenu(null);
        try {
            const result = await copyCompressedImageForDiscord(currentImage.filepath);
            const mimeLabel = result.mime.replace("image/", "").toUpperCase();
            showViewerToast(
                `Copied ${mimeLabel} ${currentImage.filename} (${result.width}x${result.height}, ${formatBytes(
                    result.bytes
                )})`,
                "success"
            );
        } catch (error) {
            showViewerToast(`Copy failed: ${String(error)}`, "error");
        }
    }, [currentImage, showViewerToast]);

    const copyJpegCurrentImage = useCallback(async () => {
        if (!currentImage) {
            return;
        }
        setImageContextMenu(null);
        try {
            const result = await copyJpegImageToClipboard(currentImage.filepath);
            const mimeLabel = result.mime.replace("image/", "").toUpperCase();
            showViewerToast(
                `Copied ${mimeLabel} ${currentImage.filename} (${result.width}x${result.height}, ${formatBytes(
                    result.bytes
                )})`,
                "success"
            );
        } catch (error) {
            showViewerToast(`JPEG copy failed: ${String(error)}`, "error");
        }
    }, [currentImage, showViewerToast]);

    const handleOpenFileLocation = useCallback(async () => {
        if (!currentImage) return;
        try {
            await openFileLocation(currentImage.filepath);
        } catch (error) {
            showViewerToast(`Failed: ${String(error)}`, "error");
        }
    }, [currentImage, showViewerToast]);

    const handleSearchSameSeed = useCallback(() => {
        if (!currentSeed) {
            showViewerToast("No seed found for this image.", "warning");
            return;
        }
        onSearchBySeed(currentSeed);
    }, [currentSeed, onSearchBySeed, showViewerToast]);

    const handleDeleteCurrentImage = useCallback(() => {
        if (!currentImage || isDeletingCurrentImage) {
            return;
        }
        if (currentImage.is_locked) {
            showViewerToast(
                "This image is locked. Unlock it to delete.",
                "warning"
            );
            return;
        }
        onDeleteCurrentImage(currentImage);
    }, [
        currentImage,
        isDeletingCurrentImage,
        onDeleteCurrentImage,
        showViewerToast,
    ]);

    const handleToggleFavorite = useCallback(() => {
        if (!currentImage || isDeletingCurrentImage) {
            return;
        }
        onToggleFavorite(currentImage);
    }, [currentImage, isDeletingCurrentImage, onToggleFavorite]);

    const handleToggleLocked = useCallback(() => {
        if (!currentImage || isDeletingCurrentImage) {
            return;
        }
        onToggleLocked(currentImage);
    }, [currentImage, isDeletingCurrentImage, onToggleLocked]);

    const handleExport = useCallback(
        async (format: "json" | "csv") => {
            if (!currentImage) {
                return;
            }
            const outputPath = await save({
                title: `Export ${format.toUpperCase()}`,
                defaultPath: `${currentImage.filename}.${format}`,
            });
            if (!outputPath || typeof outputPath !== "string") {
                return;
            }
            try {
                const result = await exportImages([currentImage.id], format, outputPath);
                showViewerToast(`Exported to ${result.output_path}`, "success", 3000);
            } catch (error) {
                showViewerToast(`Export failed: ${String(error)}`, "error");
            }
        },
        [currentImage, showViewerToast]
    );

    const handleExportSingleImage = useCallback(async () => {
        if (!currentImage) {
            return;
        }

        const filenameStem = currentImage.filename.replace(/\.[^/.]+$/, "");
        const archiveSuffix =
            singleImageExportFormat === "original"
                ? "original"
                : singleImageExportFormat;
        const outputPath = await save({
            title: `Export Image as ${
                singleImageExportFormat === "original"
                    ? "Original"
                    : singleImageExportFormat.toUpperCase()
            }`,
            defaultPath: `${filenameStem}-${archiveSuffix}.zip`,
            filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
        });
        if (!outputPath || typeof outputPath !== "string") {
            return;
        }

        try {
            showViewerToast("Exporting image...", "info", 1800);
            const result = await exportImagesAsFiles(
                [currentImage.id],
                singleImageExportFormat,
                singleImageExportFormat === "original"
                    ? null
                    : singleImageExportQuality,
                outputPath
            );
            showViewerToast(`Exported image to ${result.output_path}`, "success", 3200);
        } catch (error) {
            showViewerToast(`Image export failed: ${String(error)}`, "error");
        }
    }, [
        currentImage,
        singleImageExportFormat,
        singleImageExportQuality,
        showViewerToast,
    ]);

    const handleSaveSidecar = useCallback(async () => {
        if (!currentImage) {
            return;
        }
        setIsSavingSidecar(true);
        try {
            await saveSidecarTags(currentImage.filepath, sidecarTags, sidecarNotes || null);
            showViewerToast("Sidecar saved.", "success", 2200);
        } catch (error) {
            showViewerToast(`Save failed: ${String(error)}`, "error");
        } finally {
            setIsSavingSidecar(false);
        }
    }, [currentImage, showViewerToast, sidecarNotes, sidecarTags]);

    const handleMouseDown = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            if (zoom <= 1) {
                return;
            }
            panOriginRef.current = {
                x: event.clientX,
                y: event.clientY,
                panX: pan.x,
                panY: pan.y,
            };
            setIsPanning(true);
        },
        [pan.x, pan.y, zoom]
    );

    const handleWheel = useCallback(
        (event: React.WheelEvent<HTMLDivElement>) => {
            event.preventDefault();
            const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
            zoomBy(delta);
        },
        [zoomBy]
    );

    const handleImageDoubleClick = useCallback(() => {
        if (zoom > 1) {
            resetTransform();
        } else {
            setZoom(2);
        }
    }, [resetTransform, zoom]);

    useEffect(() => {
        if (!isPanning) {
            return;
        }

        const onMouseMove = (event: MouseEvent) => {
            if (!panOriginRef.current) {
                return;
            }
            const deltaX = event.clientX - panOriginRef.current.x;
            const deltaY = event.clientY - panOriginRef.current.y;
            setPan({
                x: panOriginRef.current.panX + deltaX,
                y: panOriginRef.current.panY + deltaY,
            });
        };

        const onMouseUp = () => {
            setIsPanning(false);
            panOriginRef.current = null;
        };

        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        };
    }, [isPanning]);

    useEffect(() => {
        if (!currentImage) {
            return;
        }
        let cancelled = false;
        const filepath = currentImage.filepath;
        viewerImageOpenStartRef.current = performance.now();
        console.info(
            `[perf] viewer-open-start image=${currentImage.id} filepath=${filepath}`
        );

        setFullResLoaded(false);
        setFullResError(false);
        setFallbackDataUrl(null);
        setImageContextMenu(null);
        resetTransform();

        setThumbnailSrc(null);
        setDisplayImagePath(null);
        getThumbnailPath(filepath)
            .then((thumbPath) => {
                if (cancelled) {
                    return;
                }
                setThumbnailSrc(toAssetSrc(thumbPath));
            })
            .catch((error) => {
                console.warn(
                    `Failed to resolve viewer preview thumbnail for ${filepath}:`,
                    error
                );
            });
        getDisplayImagePath(filepath)
            .then((resolvedPath) => {
                if (cancelled) {
                    return;
                }
                setDisplayImagePath(resolvedPath);
            })
            .catch((error) => {
                if (cancelled) {
                    return;
                }
                console.warn(
                    `Failed to resolve display image path for ${filepath}, falling back to original path:`,
                    error
                );
                setDisplayImagePath(filepath);
            });

        setSidecarNotes("");
        setSidecarTags([]);
        setTagInput("");
        getSidecarData(filepath).then((data) => {
            if (cancelled || !data) {
                return;
            }
            setSidecarTags(data.tags ?? []);
            setSidecarNotes(data.notes ?? "");
        });

        return () => {
            cancelled = true;
        };
    }, [currentImage, resetTransform]);

    useEffect(() => {
        if (!currentImage) {
            return;
        }
        const indexes = [
            currentIndex - 2,
            currentIndex - 1,
            currentIndex + 1,
            currentIndex + 2,
        ].filter((value) => value >= 0 && value < images.length);

        for (const index of indexes) {
            const preload = new Image();
            preload.decoding = "async";
            preload.src = toAssetSrc(images[index].filepath);
        }
    }, [currentImage, currentIndex, images]);

    useEffect(() => {
        if (!filmstripRef.current || images.length === 0) {
            return;
        }

        filmstripVirtualizer.scrollToIndex(currentIndex, { align: "center" });
    }, [currentIndex, filmstripVirtualizer, images.length]);

    useEffect(() => {
        let cancelled = false;
        const missing = filmstripPrefetchFilepaths
            .filter((filepath) => !filmstripCacheRef.current.has(filepath));

        if (missing.length === 0) {
            return;
        }

        const chunks: string[][] = [];
        for (let i = 0; i < missing.length; i += FILMSTRIP_CHUNK_SIZE) {
            chunks.push(missing.slice(i, i + FILMSTRIP_CHUNK_SIZE));
        }

        let chunkCursor = 0;
        const workerCount = Math.min(FILMSTRIP_CONCURRENCY, chunks.length);

        const runWorker = async () => {
            while (!cancelled) {
                const localIndex = chunkCursor;
                chunkCursor += 1;
                if (localIndex >= chunks.length) {
                    break;
                }

                try {
                    const mappings = await getThumbnailPaths(chunks[localIndex]);
                    if (cancelled) {
                        break;
                    }

                    for (const mapping of mappings) {
                        if (mapping.thumbnail_path === mapping.filepath) {
                            continue;
                        }
                        filmstripCacheRef.current.set(mapping.filepath, mapping.thumbnail_path);
                    }

                    setFilmstripThumbPaths((prev) => {
                        let changed = false;
                        const next = { ...prev };
                        for (const mapping of mappings) {
                            if (mapping.thumbnail_path === mapping.filepath) {
                                continue;
                            }
                            if (next[mapping.filepath] !== mapping.thumbnail_path) {
                                next[mapping.filepath] = mapping.thumbnail_path;
                                changed = true;
                            }
                        }
                        return changed ? next : prev;
                    });
                } catch (error) {
                    console.warn("Filmstrip thumbnail chunk failed:", error);
                }
            }
        };

        const workers = Array.from({ length: workerCount }, () => runWorker());
        void Promise.allSettled(workers).then((results) => {
            if (cancelled) {
                return;
            }
            const rejected = results.filter((result) => result.status === "rejected");
            if (rejected.length > 0) {
                console.warn(
                    `Filmstrip thumbnail workers reported ${rejected.length} rejection(s).`
                );
            }
        });

        return () => {
            cancelled = true;
        };
    }, [filmstripPrefetchFilepaths]);

    useEffect(() => {
        if (!imageContextMenu) {
            return;
        }

        const closeMenu = () => setImageContextMenu(null);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                closeMenu();
            }
        };

        window.addEventListener("mousedown", closeMenu);
        window.addEventListener("scroll", closeMenu, true);
        window.addEventListener("resize", closeMenu);
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("mousedown", closeMenu);
            window.removeEventListener("scroll", closeMenu, true);
            window.removeEventListener("resize", closeMenu);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [imageContextMenu]);

    useEffect(() => {
        if (!currentImage) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            const key = event.key.toLowerCase();

            // Typing in a field (preset name, prompt, ...) must not drive the viewer. Escape is
            // the one exception so the viewer can still be closed.
            if (event.key !== "Escape" && isTypingTarget(event.target)) {
                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                if (isSlideshow) {
                    setIsSlideshow(false);
                } else {
                    onClose();
                }
                return;
            }
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                goPrev();
                return;
            }
            if (event.key === "ArrowRight") {
                event.preventDefault();
                goNext();
                return;
            }
            if (event.key === "+" || event.key === "=") {
                event.preventDefault();
                zoomIn();
                return;
            }
            if (event.key === "-") {
                event.preventDefault();
                zoomOut();
                return;
            }
            if (key === "0") {
                event.preventDefault();
                resetTransform();
                return;
            }
            if (key === "i") {
                event.preventDefault();
                setIsInfoOpen((prev) => !prev);
                return;
            }
            if (key === "s" && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                toggleSlideshow();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [currentImage, goNext, goPrev, isSlideshow, onClose, resetTransform, toggleSlideshow, zoomIn, zoomOut]);

    useEffect(() => {
        if (zoom <= 1) {
            setPan({ x: 0, y: 0 });
        }
    }, [isInfoOpen, zoom]);

    if (!currentImage) {
        return null;
    }

    return (
        <div className="photo-viewer-overlay" role="dialog" aria-modal="true">
            <div className="photo-viewer-shell">
                <header className="photo-viewer-topbar">
                    <div className="photo-viewer-title-block">
                        <h2 className="photo-viewer-title" title={currentImage.filename}>
                            {currentImage.filename}
                        </h2>
                        <p className="photo-viewer-subtitle">
                            {currentIndex + 1} / {images.length}
                            {isSlideshow && " \u25B6 Slideshow"}
                        </p>
                    </div>
                    <div className="photo-viewer-top-actions">
                        <button
                            className="viewer-control-button"
                            onClick={handleOpenFileLocation}
                            title="Open file location in explorer"
                            type="button"
                            aria-label="Open file location"
                        >
                            Open Location
                        </button>
                        <button
                            className={`viewer-control-button ${isSlideshow ? "active" : ""}`}
                            onClick={toggleSlideshow}
                            title="Toggle slideshow (S)"
                            type="button"
                            aria-label={isSlideshow ? "Stop slideshow" : "Start slideshow"}
                        >
                            {isSlideshow ? "Stop" : "Slideshow"}
                        </button>
                        <select
                            className="viewer-input viewer-slideshow-speed"
                            value={slideshowIntervalMs}
                            onChange={(event) =>
                                setSlideshowIntervalMs(Number(event.target.value))
                            }
                            title="Slideshow speed"
                        >
                            {SLIDESHOW_INTERVAL_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                        <button
                            className="viewer-control-button"
                            onClick={() => {
                                setIsInfoOpen((prev) => !prev);
                                if (zoom <= 1) {
                                    setPan({ x: 0, y: 0 });
                                }
                            }}
                            type="button"
                            aria-label={isInfoOpen ? "Hide info panel" : "Show info panel"}
                        >
                            {isInfoOpen ? "Hide Info" : "Show Info"}
                        </button>
                        <button
                            className="viewer-control-button viewer-close-button"
                            onClick={onClose}
                            type="button"
                            aria-label="Close viewer"
                        >
                            Close
                        </button>
                    </div>
                </header>

                <div
                    className={`photo-viewer-content ${
                        isInfoOpen ? "info-open" : "info-closed"
                    }`}
                >
                    <section className="photo-viewer-stage-panel">
                        <div className="photo-viewer-stage-toolbar">
                            <button
                                className="viewer-control-button"
                                onClick={goPrev}
                                disabled={!canGoPrev}
                                type="button"
                                aria-label="Previous image"
                            >
                                Prev
                            </button>
                            <button
                                className="viewer-control-button"
                                onClick={zoomOut}
                                type="button"
                                aria-label="Zoom out"
                            >
                                -
                            </button>
                            <span className="viewer-zoom-label">{Math.round(zoom * 100)}%</span>
                            <button
                                className="viewer-control-button"
                                onClick={zoomIn}
                                type="button"
                                aria-label="Zoom in"
                            >
                                +
                            </button>
                            <button
                                className="viewer-control-button"
                                onClick={resetTransform}
                                type="button"
                                aria-label="Reset zoom and pan"
                            >
                                Reset
                            </button>
                            <button
                                className="viewer-control-button"
                                onClick={goNext}
                                disabled={!canGoNext}
                                type="button"
                                aria-label="Next image"
                            >
                                Next
                            </button>
                        </div>

                        <div
                            className="photo-viewer-stage"
                            onWheel={handleWheel}
                            onMouseDown={handleMouseDown}
                            onDoubleClick={handleImageDoubleClick}
                            onContextMenu={openImageContextMenu}
                        >
                            {thumbnailSrc && !fullResLoaded && (
                                <img
                                    key={`preview-${currentImage.id}-${thumbnailSrc}`}
                                    src={thumbnailSrc}
                                    alt={currentImage.filename}
                                    className={`photo-viewer-image ${fullResError ? "main" : "preview"}`}
                                    style={fullResError ? {
                                        transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                                        cursor: zoom > 1 ? (isPanning ? "grabbing" : "grab") : "default",
                                    } : undefined}
                                />
                            )}
                            {!fullResLoaded && !fullResError && (
                                <div className="photo-viewer-stage-loading">
                                    <span className="spinner" />
                                </div>
                            )}
                            {fullImageSrc && !fullResError && (
                                <img
                                    key={`main-${currentImage.id}-${fullImageSrc}`}
                                    src={fullImageSrc}
                                    alt={currentImage.filename}
                                    className="photo-viewer-image main"
                                    loading="eager"
                                    decoding="async"
                                    onLoad={() => {
                                        setFullResLoaded(true);
                                        if (viewerImageOpenStartRef.current != null) {
                                            const elapsedMs =
                                                performance.now() -
                                                viewerImageOpenStartRef.current;
                                            viewerImageOpenStartRef.current = null;
                                            console.info(
                                                `[perf] viewer-first-image image=${currentImage.id} elapsed_ms=${elapsedMs.toFixed(
                                                    1
                                                )}`
                                            );
                                        }
                                    }}
                                    onError={async () => {
                                        if (fallbackDataUrl) {
                                            console.warn(
                                                `Both asset protocol and base64 fallback failed for ${currentImage.filepath}`
                                            );
                                            setFullResError(true);
                                            onShowToast(
                                                "Could not load full-resolution image. Showing thumbnail preview.",
                                                { tone: "warning", durationMs: 4200 }
                                            );
                                            return;
                                        }
                                        console.warn(
                                            `Asset protocol failed for ${currentImage.filepath}, trying base64 fallback...`
                                        );
                                        try {
                                            const payload = await getImageClipboardPayload(
                                                currentImage.filepath
                                            );
                                            setFallbackDataUrl(
                                                `data:${payload.mime};base64,${payload.base64}`
                                            );
                                        } catch (fallbackError) {
                                            console.warn(
                                                "Base64 fallback also failed:",
                                                fallbackError
                                            );
                                            setFullResError(true);
                                            onShowToast(
                                                "Could not load full-resolution image. Showing thumbnail preview.",
                                                { tone: "warning", durationMs: 4200 }
                                            );
                                        }
                                    }}
                                    style={{
                                        opacity: fullResLoaded ? 1 : 0,
                                        transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                                        cursor: zoom > 1 ? (isPanning ? "grabbing" : "grab") : "default",
                                    }}
                                />
                            )}
                        </div>

                        <div
                            ref={filmstripRef}
                            className="photo-viewer-filmstrip"
                            aria-label="Image filmstrip"
                        >
                            <div
                                className="photo-viewer-filmstrip-content"
                                style={{
                                    width: `${filmstripVirtualizer.getTotalSize()}px`,
                                }}
                            >
                                {filmstripVirtualItems.map((virtualItem) => {
                                    const image = images[virtualItem.index];
                                    if (!image) {
                                        return null;
                                    }

                                    const thumbPath =
                                        filmstripThumbPaths[image.filepath] ?? null;
                                    return (
                                        <button
                                            key={`filmstrip-${image.id}`}
                                            className={`photo-viewer-thumb photo-viewer-thumb-virtual ${
                                                virtualItem.index === currentIndex
                                                    ? "active"
                                                    : ""
                                            }`}
                                            onClick={() => onNavigate(virtualItem.index)}
                                            title={image.filename}
                                            type="button"
                                            aria-label={`Open ${image.filename}`}
                                            style={{
                                                width: `${virtualItem.size - 4}px`,
                                                transform: `translateX(${virtualItem.start}px)`,
                                            }}
                                        >
                                            {thumbPath ? (
                                                <img
                                                    src={toAssetSrc(thumbPath)}
                                                    alt={image.filename}
                                                    loading="lazy"
                                                    decoding="async"
                                                    onError={(e) => {
                                                        const target = e.currentTarget;
                                                        const fallback = toAssetSrc(image.filepath);
                                                        if (target.src !== fallback) {
                                                            target.src = fallback;
                                                        }
                                                    }}
                                                />
                                            ) : (
                                                <span className="photo-viewer-thumb-loading">
                                                    <span className="spinner small" />
                                                    <span className="photo-viewer-thumb-loading-text">
                                                        Loading…
                                                    </span>
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </section>

                    <aside className={`photo-viewer-info-panel ${isInfoOpen ? "open" : "closed"}`}>
                        <div className="photo-viewer-info-scroll">
                            <div className="photo-viewer-tab-bar">
                                <button
                                    type="button"
                                    className={`photo-viewer-tab ${infoPanelTab === "info" ? "active" : ""}`}
                                    onClick={() => setInfoPanelTab("info")}
                                    data-testid="viewer-tab-info"
                                >
                                    Info
                                </button>
                                <button
                                    type="button"
                                    className={`photo-viewer-tab ${infoPanelTab === "lineage" ? "active" : ""}`}
                                    onClick={() => setInfoPanelTab("lineage")}
                                    data-testid="viewer-tab-lineage"
                                >
                                    Lineage
                                </button>
                                <button
                                    type="button"
                                    className={`photo-viewer-tab ${infoPanelTab === "forge" ? "active" : ""}`}
                                    onClick={() => setInfoPanelTab("forge")}
                                    data-testid="viewer-tab-forge"
                                >
                                    Forge
                                </button>
                            </div>

                            <div className="photo-viewer-actions-toolbar">
                                <button
                                    className="viewer-toolbar-btn"
                                    onClick={() =>
                                        currentDetail &&
                                        copyText(currentDetail.raw_metadata, "Raw metadata copied")
                                    }
                                    disabled={!currentDetail || isDetailLoading}
                                    title="Copy all metadata as text"
                                >
                                    Copy metadata
                                </button>
                                <button
                                    className="viewer-toolbar-btn"
                                    onClick={() =>
                                        currentDetail &&
                                        copyText(currentDetail.prompt, "Prompt copied")
                                    }
                                    disabled={!currentDetail || isDetailLoading}
                                    title="Copy the positive prompt"
                                >
                                    Copy prompt
                                </button>
                                <button
                                    className="viewer-toolbar-btn"
                                    onClick={handleOpenFileLocation}
                                    title="Open the folder containing this file"
                                >
                                    Show in folder
                                </button>
                                <button
                                    className="viewer-toolbar-btn"
                                    onClick={handleSearchSameSeed}
                                    disabled={!currentSeed || isDeletingCurrentImage}
                                    title="Search for other images with this seed"
                                >
                                    Same seed
                                </button>
                            </div>

                            <div className="photo-viewer-actions-toolbar">
                                <button
                                    className={`viewer-toolbar-btn ${
                                        currentImage?.is_favorite ? "active" : ""
                                    }`}
                                    onClick={handleToggleFavorite}
                                    disabled={!currentImage || isDeletingCurrentImage}
                                    title={
                                        currentImage?.is_favorite
                                            ? "Remove from favorites"
                                            : "Add to favorites"
                                    }
                                >
                                    {currentImage?.is_favorite ? "★ Favorited" : "☆ Favorite"}
                                </button>
                                <button
                                    className={`viewer-toolbar-btn ${
                                        currentImage?.is_locked ? "active" : ""
                                    }`}
                                    onClick={handleToggleLocked}
                                    disabled={!currentImage || isDeletingCurrentImage}
                                    title={
                                        currentImage?.is_locked
                                            ? "Unlock deletion protection"
                                            : "Lock image against deletion"
                                    }
                                >
                                    {currentImage?.is_locked ? "🔒 Locked" : "🔓 Lock"}
                                </button>
                                <span className="viewer-toolbar-spacer" aria-hidden="true" />
                                <button
                                    className="viewer-toolbar-btn danger"
                                    onClick={handleDeleteCurrentImage}
                                    disabled={
                                        isDeletingCurrentImage ||
                                        Boolean(currentImage?.is_locked)
                                    }
                                    title={
                                        currentImage?.is_locked
                                            ? "Locked image: unlock to delete"
                                            : "Move this image to Trash"
                                    }
                                >
                                    {isDeletingCurrentImage
                                        ? "Deleting..."
                                        : "Trash"}
                                </button>
                            </div>

                            {isDetailLoading && (
                                <div className="photo-viewer-note photo-viewer-loading-note">
                                    <span className="spinner" />
                                    Loading metadata...
                                </div>
                            )}

                            {infoPanelTab === "info" && (
                                <>
                                    {currentDetail?.prompt && (
                                        <section className="photo-viewer-section">
                                            <h4>Prompt</h4>
                                            <p>{currentDetail.prompt}</p>
                                        </section>
                                    )}

                                    {currentDetail?.negative_prompt && (
                                        <section className="photo-viewer-section">
                                            <h4>Negative Prompt</h4>
                                            <p>{currentDetail.negative_prompt}</p>
                                        </section>
                                    )}

                                    {currentParamEntries.length > 0 && (
                                        <section className="photo-viewer-section">
                                            <h4>Parameters</h4>
                                            <div className="viewer-key-value-grid">
                                                {currentParamEntries.map(([key, value]) => (
                                                    <div key={key} className="viewer-key-value-row">
                                                        <span>{key}</span>
                                                        <strong>{value}</strong>
                                                    </div>
                                                ))}
                                            </div>
                                        </section>
                                    )}

                                    <section className="photo-viewer-section">
                                        <h4>File</h4>
                                        <div className="viewer-key-value-grid">
                                            <div className="viewer-key-value-row">
                                                <span>Filename</span>
                                                <strong>{currentImage.filename}</strong>
                                            </div>
                                            <div className="viewer-key-value-row">
                                                <span>Directory</span>
                                                <strong>{currentImage.directory}</strong>
                                            </div>
                                            <div className="viewer-key-value-row">
                                                <span>Path</span>
                                                <strong className="viewer-path">{currentImage.filepath}</strong>
                                            </div>
                                        </div>
                                    </section>

                                    {currentDetail?.raw_metadata && (
                                        <section className="photo-viewer-section">
                                            <h4>Raw Metadata</h4>
                                            <pre
                                                className="viewer-raw-metadata"
                                                style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                                            >
                                                {escapeHtml(currentDetail.raw_metadata)}
                                            </pre>
                                        </section>
                                    )}

                                    <section className="photo-viewer-section">
                                        <h4>Sidecar</h4>
                                        <div className="viewer-tag-input-row">
                                            <input
                                                className="viewer-input"
                                                value={tagInput}
                                                placeholder="Add sidecar tag"
                                                onChange={(event) => setTagInput(event.target.value)}
                                                onKeyDown={(event) => {
                                                    if (event.key === "Enter") {
                                                        event.preventDefault();
                                                        addSidecarTag(tagInput);
                                                    }
                                                }}
                                            />
                                            <button
                                                className="viewer-control-button"
                                                onClick={() => addSidecarTag(tagInput)}
                                            >
                                                Add
                                            </button>
                                        </div>
                                        <div className="viewer-tag-chip-list">
                                            {sidecarTags.map((tag) => (
                                                <button
                                                    key={`sidecar-tag-${tag}`}
                                                    className="viewer-tag-chip"
                                                    onClick={() => removeSidecarTag(tag)}
                                                    title="Remove tag"
                                                >
                                                    {tag}
                                                </button>
                                            ))}
                                        </div>
                                        <textarea
                                            className="viewer-textarea"
                                            value={sidecarNotes}
                                            onChange={(event) => setSidecarNotes(event.target.value)}
                                            placeholder="Notes..."
                                            rows={4}
                                        />
                                        <button
                                            className="viewer-action-button primary"
                                            onClick={handleSaveSidecar}
                                            disabled={isSavingSidecar}
                                        >
                                            {isSavingSidecar ? "Saving..." : "Save Sidecar"}
                                        </button>
                                    </section>

                                    <section className="photo-viewer-section">
                                        <h4>Export</h4>
                                        <div className="viewer-form-grid">
                                            <select
                                                className="viewer-input"
                                                value={singleImageExportFormat}
                                                onChange={(event) =>
                                                    setSingleImageExportFormat(
                                                        event.target.value as ImageExportFormat
                                                    )
                                                }
                                            >
                                                {SINGLE_IMAGE_EXPORT_OPTIONS.map((option) => (
                                                    <option key={option.value} value={option.value}>
                                                        {option.label}
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                className="viewer-action-button"
                                                onClick={handleExportSingleImage}
                                            >
                                                Export ZIP
                                            </button>
                                        </div>
                                        {showSingleImageExportQuality && (
                                            <div className="export-quality-row">
                                                <span className="export-quality-label">Quality</span>
                                                <input
                                                    type="range"
                                                    className="export-quality-slider"
                                                    min={10}
                                                    max={100}
                                                    step={5}
                                                    value={singleImageExportQuality}
                                                    onChange={(event) =>
                                                        setSingleImageExportQuality(
                                                            Number(event.target.value)
                                                        )
                                                    }
                                                />
                                                <span className="export-quality-value">
                                                    {singleImageExportQuality}
                                                </span>
                                            </div>
                                        )}
                                        <div className="viewer-form-grid" style={{ marginTop: 4 }}>
                                            <button
                                                className="viewer-action-button"
                                                onClick={() => handleExport("json")}
                                            >
                                                Export JSON
                                            </button>
                                            <button
                                                className="viewer-action-button"
                                                onClick={() => handleExport("csv")}
                                            >
                                                Export CSV
                                            </button>
                                        </div>
                                    </section>
                                </>
                            )}

                            {infoPanelTab === "forge" && (
                                <div className="viewer-forge-panel">
                                    <section className="photo-viewer-section">
                                        <h4>Forge Payload</h4>
                                        {detailFailed && (
                                            <div className="input-error" role="alert" data-testid="forge-detail-error">
                                                Could not load this image&apos;s details, so the fields below are empty.{" "}
                                                <button
                                                    type="button"
                                                    className="viewer-control-button"
                                                    onClick={() => setDetailReloadKey((key) => key + 1)}
                                                >
                                                    Retry
                                                </button>
                                            </div>
                                        )}
                                        {!hasValidForgeUrl && (
                                            <div className="input-error" role="alert">
                                                {forgeUrlValidationError}
                                            </div>
                                        )}
                                        {isLoadingForgeOptions && (
                                            <div className="photo-viewer-note">Loading Forge options...</div>
                                        )}
                                        {forgeProblems.length > 0 && (
                                            <div
                                                className="photo-viewer-note input-error"
                                                role="alert"
                                                style={{
                                                    display: "flex",
                                                    justifyContent: "space-between",
                                                    alignItems: "center",
                                                    gap: "8px",
                                                }}
                                            >
                                                <span>{forgeProblems.join(" | ")}</span>
                                                <button
                                                    type="button"
                                                    className="viewer-link-button viewer-retry-button"
                                                    onClick={() => void refreshForgeOptions()}
                                                    disabled={isLoadingForgeOptions}
                                                >
                                                    {isLoadingForgeOptions ? "Checking…" : "↻ Retry connection"}
                                                </button>
                                            </div>
                                        )}
                                        {showLoraHint && (
                                            <div className="photo-viewer-note viewer-lora-hint">
                                                <span>{forgeHints.join(" | ")}</span>
                                            </div>
                                        )}
                                        <div className="viewer-form-label">Preset Manager</div>
                                        <select
                                            className="viewer-input"
                                            value={selectedForgePreset}
                                            onChange={(event) =>
                                                setSelectedForgePreset(event.target.value)
                                            }
                                        >
                                            <option value="">Select preset</option>
                                            {forgePresetNames.map((name) => (
                                                <option key={name} value={name}>
                                                    {name}
                                                </option>
                                            ))}
                                        </select>
                                        <div className="viewer-form-grid">
                                            <input
                                                className="viewer-input"
                                                value={forgePresetNameInput}
                                                onChange={(event) =>
                                                    setForgePresetNameInput(event.target.value)
                                                }
                                                placeholder="Preset name"
                                            />
                                            <button
                                                className="viewer-control-button"
                                                onClick={saveCurrentAsForgePreset}
                                                type="button"
                                            >
                                                Save
                                            </button>
                                            <button
                                                className="viewer-control-button"
                                                onClick={() => {
                                                    if (!selectedForgePreset) {
                                                        showViewerToast(
                                                            "Select a preset to load.",
                                                            "warning"
                                                        );
                                                        return;
                                                    }
                                                    applyForgePayloadPreset(selectedForgePreset);
                                                }}
                                                type="button"
                                            >
                                                Load
                                            </button>
                                            <button
                                                className="viewer-control-button"
                                                onClick={deleteForgePreset}
                                                type="button"
                                            >
                                                Delete
                                            </button>
                                        </div>

                                        {/* 1. Prompt section */}
                                        <details
                                            open={promptSectionOpen}
                                            onToggle={(e) => setPromptSectionOpen(e.currentTarget.open)}
                                            data-testid="forge-section-prompt"
                                            className="viewer-collapsible-section"
                                        >
                                            <summary className="viewer-section-summary">
                                                <span className="viewer-summary-title">Prompt</span>
                                            </summary>
                                            <div className="viewer-section-content">
                                                <div className="viewer-prompt-actions-row">
                                                    <button
                                                        type="button"
                                                        className="sidebar-button"
                                                        onClick={() => void handleSavePromptToLibrary()}
                                                        title="Save the prompt below to the prompt library"
                                                        aria-label="Save to library"
                                                    >
                                                        <BookmarkIcon size={14} />
                                                        <span>Save to library</span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="sidebar-button"
                                                        onClick={() => {
                                                            setPromptLibraryNote(null);
                                                            setIsPromptLibraryOpen(true);
                                                        }}
                                                        title="Browse the prompt library and apply a prompt"
                                                        aria-label="Library"
                                                    >
                                                        <BookmarkIcon size={14} />
                                                        <span>Library</span>
                                                    </button>
                                                </div>
                                                {promptLibraryNote && (
                                                    <div className="viewer-form-label" role="status">
                                                        {promptLibraryNote}
                                                    </div>
                                                )}
                                                <textarea
                                                    className="viewer-textarea"
                                                    value={forgeOverrides.prompt}
                                                    onChange={(event) =>
                                                        updateForgeOverride("prompt", event.target.value)
                                                    }
                                                    placeholder="Prompt"
                                                    rows={4}
                                                />
                                                <div className="viewer-form-label">Negative Prompt</div>
                                                <textarea
                                                    className="viewer-textarea"
                                                    value={forgeOverrides.negative_prompt}
                                                    onChange={(event) =>
                                                        updateForgeOverride(
                                                            "negative_prompt",
                                                            event.target.value
                                                        )
                                                    }
                                                    placeholder="Negative prompt"
                                                    rows={3}
                                                />
                                            </div>
                                        </details>

                                        {/* 2. Sampling section */}
                                        <details
                                            open={samplingSectionOpen}
                                            onToggle={(e) => setSamplingSectionOpen(e.currentTarget.open)}
                                            data-testid="forge-section-sampling"
                                            className="viewer-collapsible-section"
                                        >
                                            <summary className="viewer-section-summary">
                                                <span className="viewer-summary-title">Sampling</span>
                                            </summary>
                                            <div className="viewer-section-content">
                                                <div className="viewer-form-grid">
                                                    <input
                                                        className={`viewer-input ${
                                                            stepsValidationError ? "input-invalid" : ""
                                                        }`}
                                                        value={forgeOverrides.steps}
                                                        onChange={(event) =>
                                                            updateForgeOverride("steps", event.target.value)
                                                        }
                                                        placeholder="Steps"
                                                        aria-invalid={stepsValidationError != null}
                                                    />
                                                    <select
                                                        className="viewer-input"
                                                        value={forgeOverrides.sampler_name}
                                                        onChange={(event) =>
                                                            updateForgeOverride(
                                                                "sampler_name",
                                                                event.target.value
                                                            )
                                                        }
                                                    >
                                                        <option value="">Sampler (auto/default)</option>
                                                        {samplerDropdownOptions.map((sampler) => (
                                                            <option key={sampler} value={sampler}>
                                                                {sampler}
                                                            </option>
                                                        ))}
                                                    </select>
                                                    <select
                                                        className="viewer-input"
                                                        value={forgeOverrides.scheduler}
                                                        onChange={(event) =>
                                                            updateForgeOverride("scheduler", event.target.value)
                                                        }
                                                    >
                                                        <option value="">Scheduler (auto/default)</option>
                                                        {schedulerDropdownOptions.map((scheduler) => (
                                                            <option key={scheduler} value={scheduler}>
                                                                {scheduler}
                                                            </option>
                                                        ))}
                                                    </select>
                                                    <input
                                                        className={`viewer-input ${
                                                            cfgScaleValidationError ? "input-invalid" : ""
                                                        }`}
                                                        value={forgeOverrides.cfg_scale}
                                                        onChange={(event) =>
                                                            updateForgeOverride("cfg_scale", event.target.value)
                                                        }
                                                        placeholder="CFG Scale"
                                                        aria-invalid={cfgScaleValidationError != null}
                                                    />
                                                    <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                                                        <input
                                                            className="viewer-input"
                                                            style={{ flex: 1 }}
                                                            value={forgeOverrides.seed}
                                                            onChange={(event) =>
                                                                updateForgeOverride("seed", event.target.value)
                                                            }
                                                            placeholder="Seed (-1 for random)"
                                                            disabled={!sendSeedForCurrentRequest}
                                                        />
                                                        <button
                                                            type="button"
                                                            className="viewer-ghost-button"
                                                            title="Generate random seed"
                                                            disabled={!sendSeedForCurrentRequest}
                                                            onClick={() =>
                                                                updateForgeOverride(
                                                                    "seed",
                                                                    String(Math.floor(Math.random() * 4294967295))
                                                                )
                                                            }
                                                            style={{ padding: "6px 8px", fontSize: "12px" }}
                                                        >
                                                            🎲
                                                        </button>
                                                    </div>
                                                </div>
                                                <div className="viewer-seed-toggle-row">
                                                    <label className="viewer-toggle-row" style={{ margin: 0 }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={sendSeedForCurrentRequest}
                                                            onChange={(event) =>
                                                                setSendSeedForCurrentRequest(event.target.checked)
                                                            }
                                                        />
                                                        Send seed with request
                                                    </label>
                                                    <div style={{ display: "flex", gap: "4px" }}>
                                                        <button
                                                            type="button"
                                                            className="viewer-ghost-button viewer-seed-action-button"
                                                            title="Send with random seed (-1)"
                                                            onClick={() => {
                                                                setSendSeedForCurrentRequest(true);
                                                                updateForgeOverride("seed", "-1");
                                                            }}
                                                        >
                                                            🎲 Random (-1)
                                                        </button>
                                                        {currentSeed && (
                                                            <button
                                                                type="button"
                                                                className="viewer-ghost-button viewer-seed-action-button"
                                                                title={`Restore original seed (${currentSeed})`}
                                                                onClick={() => {
                                                                    setSendSeedForCurrentRequest(true);
                                                                    updateForgeOverride("seed", currentSeed);
                                                                }}
                                                            >
                                                                Original
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                                {(stepsValidationError || cfgScaleValidationError) && (
                                                    <div className="input-error" role="alert">
                                                        {stepsValidationError ?? cfgScaleValidationError}
                                                    </div>
                                                )}
                                            </div>
                                        </details>

                                        {/* 3. Size section */}
                                        <details
                                            open={sizeSectionOpen}
                                            onToggle={(e) => setSizeSectionOpen(e.currentTarget.open)}
                                            data-testid="forge-section-size"
                                            className="viewer-collapsible-section"
                                        >
                                            <summary className="viewer-section-summary">
                                                <span className="viewer-summary-title">Size</span>
                                            </summary>
                                            <div className="viewer-section-content">
                                                <div className="viewer-form-label">Resolution Preset Family</div>
                                                <select
                                                    className="viewer-input"
                                                    value={selectedResolutionFamily}
                                                    onChange={(event) =>
                                                        setSelectedResolutionFamily(
                                                            event.target.value as ModelFamilyId
                                                        )
                                                    }
                                                >
                                                    {MODEL_FAMILIES.map((family) => (
                                                        <option key={family.id} value={family.id}>
                                                            {family.label}
                                                        </option>
                                                    ))}
                                                </select>
                                                <div className="sidebar-help">
                                                    Detected family: {detectedModelFamily} | functionality:{" "}
                                                    {detectedFunctionality}
                                                </div>
                                                <div className="viewer-form-label">Resolution Presets</div>
                                                <select
                                                    className="viewer-input"
                                                    value={selectedResolutionPreset}
                                                    onChange={(event) =>
                                                        handleResolutionPresetChange(event.target.value)
                                                    }
                                                >
                                                    <option value="custom">Custom</option>
                                                    {(
                                                        RESOLUTION_PRESETS[selectedResolutionFamily] ??
                                                        RESOLUTION_PRESETS["unknown"] ??
                                                        []
                                                    ).map((option) => (
                                                        <option
                                                            key={`${option.width}x${option.height}`}
                                                            value={`${option.width}x${option.height}`}
                                                        >
                                                            {option.label}
                                                        </option>
                                                    ))}
                                                </select>
                                                <div className="viewer-form-label">Dimensions</div>
                                                <div className="viewer-form-grid">
                                                    <input
                                                        className="viewer-input"
                                                        value={forgeOverrides.width}
                                                        onChange={(event) =>
                                                            updateForgeOverride("width", event.target.value)
                                                        }
                                                        placeholder="Width"
                                                    />
                                                    <input
                                                        className="viewer-input"
                                                        value={forgeOverrides.height}
                                                        onChange={(event) =>
                                                            updateForgeOverride("height", event.target.value)
                                                        }
                                                        placeholder="Height"
                                                    />
                                                </div>
                                            </div>
                                        </details>

                                        {/* 4. Model & LoRA section */}
                                        <details
                                            open={modelLoraSectionOpen}
                                            onToggle={(e) => setModelLoraSectionOpen(e.currentTarget.open)}
                                            data-testid="forge-section-model-lora"
                                            className="viewer-collapsible-section"
                                        >
                                            <summary className="viewer-section-summary">
                                                <span className="viewer-summary-title">Model &amp; LoRA</span>
                                            </summary>
                                            <div className="viewer-section-content">
                                                <div className="viewer-form-label">Model Checkpoint</div>
                                                <label className="viewer-toggle-row" style={{ margin: "2px 0 6px 0", fontSize: "12px" }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={filterModelsByFamily}
                                                        onChange={(event) => setFilterModelsByFamily(event.target.checked)}
                                                    />
                                                    Filter to detected family ({detectedModelFamily})
                                                </label>
                                                <select
                                                    className="viewer-input"
                                                    value={
                                                        familyCompatibleModelOptions.includes(
                                                            forgeOverrides.model_name
                                                        )
                                                            ? forgeOverrides.model_name
                                                            : ""
                                                    }
                                                    onChange={(event) => {
                                                        const newModel = event.target.value;
                                                        updateForgeOverride("model_name", newModel);
                                                        if (newModel) {
                                                            const targetFamily = detectResolutionFamilyFromModelName(newModel);
                                                            if (targetFamily !== "unknown") {
                                                                setSelectedResolutionFamily(targetFamily);
                                                            }
                                                        }
                                                    }}
                                                >
                                                    <option value="">Model checkpoint (none/default)</option>
                                                    {familyCompatibleModelOptions.map((model) => (
                                                        <option key={model} value={model}>
                                                            {model}
                                                        </option>
                                                    ))}
                                                </select>
                                                {forgeOverrides.model_name &&
                                                    !familyCompatibleModelOptions.includes(
                                                        forgeOverrides.model_name
                                                    ) && (
                                                        <div className="photo-viewer-note">
                                                            Current image model is not in detected checkpoint scan.
                                                        </div>
                                                    )}
                                                <div className="viewer-forge-folders">
                                                    <div className="viewer-key-value-row">
                                                        <span>Models folder</span>
                                                        <strong className="viewer-path" title={forgeModelsPath || undefined}>
                                                            {forgeModelsPath || "Not set"}
                                                            {forgeModelsPath && forgeModelsScanSubfolders ? " (+ subfolders)" : ""}
                                                        </strong>
                                                    </div>
                                                    <div className="viewer-key-value-row">
                                                        <span>LoRA folder</span>
                                                        <strong className="viewer-path" title={forgeLoraPath || undefined}>
                                                            {forgeLoraPath || "Not set"}
                                                            {forgeLoraPath && forgeLoraScanSubfolders ? " (+ subfolders)" : ""}
                                                        </strong>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        className="viewer-control-button"
                                                        onClick={onOpenForgeSettings}
                                                    >
                                                        Change in Settings…
                                                    </button>
                                                </div>
                                                <div className="viewer-form-label">
                                                    LoRA Multi-Select
                                                </div>
                                                <div className="viewer-multiselect" ref={loraDropdownRef}>
                                                    <button
                                                        type="button"
                                                        className="viewer-control-button viewer-multiselect-trigger"
                                                        onClick={() =>
                                                            setIsLoraDropdownOpen((previous) => !previous)
                                                        }
                                                    >
                                                        {forgeSelectedLoras.length > 0
                                                            ? `${forgeSelectedLoras.length} selected`
                                                            : "Select LoRAs"}
                                                    </button>
                                                    {isLoraDropdownOpen && (
                                                        <div className="viewer-multiselect-menu">
                                                            <input
                                                                className="viewer-input"
                                                                placeholder="Filter LoRAs..."
                                                                value={loraSearch}
                                                                onChange={(event) =>
                                                                    setLoraSearch(event.target.value)
                                                                }
                                                            />
                                                            <div className="viewer-multiselect-list">
                                                                {filteredLoraOptions.map((lora) => (
                                                                    <label
                                                                        key={lora}
                                                                        className="viewer-multiselect-option"
                                                                    >
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={forgeSelectedLoras.includes(
                                                                                lora
                                                                            )}
                                                                            onChange={() =>
                                                                                toggleLoraSelection(lora)
                                                                            }
                                                                        />
                                                                        <span>{lora}</span>
                                                                    </label>
                                                                ))}
                                                                {filteredLoraOptions.length === 0 && (
                                                                    <div className="photo-viewer-note">
                                                                        No LoRAs match filter
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                                {forgeSelectedLoras.length > 0 && (
                                                    <div
                                                        className="viewer-lora-weight-list"
                                                        data-testid="lora-weight-list"
                                                    >
                                                        {forgeSelectedLoras.map((lora) => (
                                                            <div key={lora} className="viewer-lora-weight-row">
                                                                <span
                                                                    className="viewer-lora-weight-name"
                                                                    title={lora}
                                                                >
                                                                    {lora}
                                                                </span>
                                                                <input
                                                                    className={`viewer-input viewer-lora-weight-input ${
                                                                        loraWeightErrors[lora] ? "input-invalid" : ""
                                                                    }`}
                                                                    value={forgeLoraWeights[lora] ?? ""}
                                                                    placeholder={forgeLoraWeight.trim() || "1.0"}
                                                                    inputMode="decimal"
                                                                    aria-label={`Weight for ${lora}`}
                                                                    aria-invalid={loraWeightErrors[lora] != null}
                                                                    onChange={(event) =>
                                                                        setLoraWeight(lora, event.target.value)
                                                                    }
                                                                />
                                                                <button
                                                                    type="button"
                                                                    className="viewer-tag-chip"
                                                                    onClick={() => removeSelectedLora(lora)}
                                                                    title="Remove LoRA"
                                                                    aria-label={`Remove ${lora}`}
                                                                >
                                                                    ×
                                                                </button>
                                                            </div>
                                                        ))}
                                                        {loraWeightErrorMessages.map((message) => (
                                                            <div key={message} className="input-error" role="alert">
                                                                {message}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                                <div className="viewer-form-label">
                                                    Default LoRA weight
                                                    <span className="viewer-form-hint">
                                                        {" "}
                                                        (used for LoRAs without their own weight)
                                                    </span>
                                                </div>
                                                <div className="viewer-form-grid">
                                                    <input
                                                        className="viewer-input"
                                                        type="range"
                                                        min={0}
                                                        max={2}
                                                        step={0.05}
                                                        value={loraWeightSliderValue}
                                                        onChange={(event) =>
                                                            onForgeLoraWeightChange(
                                                                Number(event.target.value).toFixed(2)
                                                            )
                                                        }
                                                    />
                                                    <input
                                                        className={`viewer-input ${
                                                            loraWeightValidationError ? "input-invalid" : ""
                                                        }`}
                                                        value={forgeLoraWeight}
                                                        onChange={(event) =>
                                                            onForgeLoraWeightChange(event.target.value)
                                                        }
                                                        placeholder="1.00"
                                                        aria-invalid={loraWeightValidationError != null}
                                                    />
                                                </div>
                                                {loraWeightValidationError && (
                                                    <div className="input-error" role="alert">
                                                        {loraWeightValidationError}
                                                    </div>
                                                )}
                                                <label className="viewer-toggle-row">
                                                    <input
                                                        type="checkbox"
                                                        checked={useAdetailerForCurrentRequest}
                                                        onChange={(event) =>
                                                            setUseAdetailerForCurrentRequest(
                                                                event.target.checked
                                                            )
                                                        }
                                                    />
                                                    Enable ADetailer face fix
                                                </label>
                                                <select
                                                    className="viewer-input"
                                                    value={adetailerFaceModelForCurrentRequest}
                                                    onChange={(event) =>
                                                        setAdetailerFaceModelForCurrentRequest(
                                                            event.target.value
                                                        )
                                                    }
                                                    disabled={!useAdetailerForCurrentRequest}
                                                >
                                                    {adetailerModelDropdownOptions.map((model) => (
                                                        <option key={model} value={model}>
                                                            {model}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                        </details>

                                        {/* 5. Upscale section */}
                                        <details
                                            open={upscaleSectionOpen}
                                            onToggle={(e) => setUpscaleSectionOpen(e.currentTarget.open)}
                                            data-testid="forge-section-upscale"
                                            className="viewer-collapsible-section"
                                        >
                                            <summary className="viewer-section-summary">
                                                <span className="viewer-summary-title">Upscale</span>
                                            </summary>
                                            <div className="viewer-section-content">
                                                <div className="viewer-form-label">Upscaler</div>
                                                <select
                                                    className="viewer-input"
                                                    value={selectedUpscaler}
                                                    onChange={(e) => setSelectedUpscaler(e.target.value)}
                                                    disabled={forgeUpscalerOptions.length === 0}
                                                >
                                                    {forgeUpscalerOptions.length === 0 ? (
                                                        <option value="">No upscalers available (check Forge connection)</option>
                                                    ) : (
                                                        forgeUpscalerOptions.map((name) => (
                                                            <option key={name} value={name}>
                                                                {name}
                                                            </option>
                                                        ))
                                                    )}
                                                </select>

                                                <div className="viewer-form-label">Scale Factor</div>
                                                <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
                                                    {[1.5, 2.0, 4.0].map((factor) => (
                                                        <button
                                                            key={factor}
                                                            type="button"
                                                            className={`viewer-ghost-button ${upscaleScale === factor ? "active" : ""}`}
                                                            style={{
                                                                flex: 1,
                                                                padding: "6px 0",
                                                                fontWeight: upscaleScale === factor ? "bold" : "normal",
                                                                background:
                                                                    upscaleScale === factor
                                                                        ? "var(--color-accent-subtle, rgba(255,255,255,0.15))"
                                                                        : undefined,
                                                            }}
                                                            onClick={() => setUpscaleScale(factor)}
                                                        >
                                                            {factor}x
                                                        </button>
                                                    ))}
                                                </div>

                                                <button
                                                    type="button"
                                                    className="viewer-action-button primary"
                                                    style={{ width: "100%", marginTop: "4px" }}
                                                    disabled={
                                                        !hasValidForgeUrl ||
                                                        !selectedUpscaler ||
                                                        isUpscaling ||
                                                        !currentImage
                                                    }
                                                    onClick={async () => {
                                                        if (!currentImage) return;
                                                        setIsUpscaling(true);
                                                        try {
                                                            const result = await forgeUpscaleImage({
                                                                imageId: currentImage.id,
                                                                baseUrl: forgeBaseUrl,
                                                                apiKey: forgeApiKey.trim() ? forgeApiKey : null,
                                                                upscaler: selectedUpscaler,
                                                                scale: upscaleScale,
                                                                outputDir: forgeOutputDir.trim() ? forgeOutputDir : null,
                                                            });
                                                            if (result.ok) {
                                                                showViewerToast(result.message, "success");
                                                            } else {
                                                                showViewerToast(result.message, "error");
                                                            }
                                                        } catch (err) {
                                                            showViewerToast(`Upscale failed: ${String(err)}`, "error");
                                                        } finally {
                                                            setIsUpscaling(false);
                                                        }
                                                    }}
                                                >
                                                    {isUpscaling ? (
                                                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                                            <span className="spinner small" /> Upscaling with Forge…
                                                        </span>
                                                    ) : (
                                                        `Upscale with Forge (${upscaleScale}x)`
                                                    )}
                                                </button>
                                            </div>
                                        </details>
                                    </section>

                                    {/* Sticky footer with Send to Forge */}
                                    <div className="viewer-forge-sticky-footer">
                                        <div className="viewer-forge-send-options">
                                            <label className="viewer-batch-count-field">
                                                <span>Images per send</span>
                                                <input
                                                    className={`viewer-input viewer-batch-count-input ${
                                                        batchCountParse.error ? "input-invalid" : ""
                                                    }`}
                                                    value={forgeBatchCount}
                                                    placeholder="1"
                                                    inputMode="numeric"
                                                    aria-label="Images per send"
                                                    aria-invalid={batchCountParse.error != null}
                                                    onChange={(event) =>
                                                        onForgeBatchCountChange(event.target.value)
                                                    }
                                                />
                                            </label>
                                            <label className="viewer-toggle-row">
                                                <input
                                                    type="checkbox"
                                                    checked={forgeSaveCopy}
                                                    onChange={(event) =>
                                                        onForgeSaveCopyChange(event.target.checked)
                                                    }
                                                />
                                                Also let Forge save its own copy
                                            </label>
                                            {batchCountParse.error && (
                                                <div className="input-error" role="alert">
                                                    {batchCountParse.error}
                                                </div>
                                            )}
                                        </div>
                                        <ForgeRequeueButton
                                            imageId={currentImage?.id}
                                            baseUrl={forgeBaseUrl}
                                            apiKey={forgeApiKey}
                                            outputDir={
                                                forgeOutputDir.trim() ? forgeOutputDir : null
                                            }
                                            includeSeed={sendSeedForCurrentRequest}
                                            adetailerEnabled={useAdetailerForCurrentRequest}
                                            adetailerModel={
                                                adetailerFaceModelForCurrentRequest.trim()
                                                    ? adetailerFaceModelForCurrentRequest
                                                    : null
                                            }
                                            loraTokens={
                                                forgeSelectedLoras.length > 0
                                                    ? forgeSelectedLoras
                                                    : null
                                            }
                                            loraWeight={
                                                forgeLoraWeight.trim()
                                                    ? Number(forgeLoraWeight)
                                                    : null
                                            }
                                            loraWeights={effectiveLoraWeights}
                                            batchCount={batchCountParse.value}
                                            saveForgeCopy={forgeSaveCopy}
                                            overrides={forgeOverrides}
                                            disabled={
                                                !hasValidForgeUrl ||
                                                hasForgeValidationErrors ||
                                                isDetailLoading ||
                                                !currentDetail
                                            }
                                            validate={() => {
                                                if (!hasValidForgeUrl) {
                                                    return (
                                                        forgeUrlValidationError ??
                                                        "Forge URL is invalid."
                                                    );
                                                }
                                                if (hasForgeValidationErrors) {
                                                    return "Fix invalid Forge payload fields before sending.";
                                                }
                                                return null;
                                            }}
                                            onQueued={(_queueId, result) => {
                                                showViewerToast(result.message, "success");
                                                void refreshForgeOptions();
                                            }}
                                            onError={(message) =>
                                                showViewerToast(message, "error")
                                            }
                                            label="Send to Forge"
                                            className="viewer-action-button primary"
                                        />
                                    </div>
                                </div>
                            )}

                            {infoPanelTab === "lineage" && (
                                <>
                                    <section className="photo-viewer-section" data-testid="lineage-tab">
                                        <h4>Lineage</h4>
                                        {isLineageLoading && (
                                            <div className="photo-viewer-note"><span className="spinner small" /> Loading lineage…</div>
                                        )}
                                        {!isLineageLoading && lineageCursor && (
                                            <>
                                                <div className="viewer-form-label">Ancestors ({lineageCursor.ancestors.length}/3)</div>
                                                {lineageCursor.ancestors.length === 0 ? (
                                                    <div className="photo-viewer-note">No ancestors.</div>
                                                ) : (
                                                    <div className="viewer-lineage-list" data-testid="lineage-ancestors">
                                                        {lineageCursor.ancestors.map((edge) => {
                                                            const thumb = lineageThumbs[edge.parent_filepath];
                                                            const label = edge.parent_filepath.split(/[/\\]/).pop() ?? edge.parent_filepath;
                                                            return (
                                                                <div key={`${edge.child_filepath}|${edge.parent_filepath}`} className="viewer-lineage-row" data-testid="lineage-ancestor-row">
                                                                    <button
                                                                        type="button"
                                                                        className="viewer-lineage-thumb-btn"
                                                                        onClick={() => handleLineageJump(edge.parent_filepath)}
                                                                        title={`Jump to ${label}`}
                                                                        data-testid="lineage-jump-ancestor"
                                                                    >
                                                                        {thumb ? (
                                                                            <img src={toAssetSrc(thumb)} alt={label} loading="lazy" decoding="async" />
                                                                        ) : (
                                                                            <span className="viewer-lineage-thumb-placeholder">—</span>
                                                                        )}
                                                                    </button>
                                                                    <div className="viewer-lineage-meta">
                                                                        <span className="viewer-lineage-filename" title={edge.parent_filepath}>{label}</span>
                                                                        <span className="viewer-lineage-relation">{edge.relation} • {edge.confidence.toFixed(2)}</span>
                                                                    </div>
                                                                    <div className="viewer-lineage-actions">
                                                                        <button type="button" className="viewer-control-button" onClick={() => handleLineageJump(edge.parent_filepath)} data-testid="lineage-jump-btn">Jump</button>
                                                                        <button type="button" className="viewer-control-button" onClick={() => handlePinLineageToCompare(edge.parent_filepath)} data-testid="lineage-pin-btn">Pin</button>
                                                                        <button type="button" className="viewer-control-button danger" onClick={() => handleLineageUnlink(edge, "ancestor")} disabled={isLineageMutating} data-testid="lineage-unlink-btn">Unlink</button>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                                {lineageTrace && lineageTrace.nodes.length > 1 && (
                                                    <>
                                                        <div className="viewer-form-label" style={{ marginTop: "12px" }}>
                                                            Ancestry Trace-Back ({lineageTrace.nodes.length - 1} ancestor{lineageTrace.nodes.length - 1 === 1 ? "" : "s"})
                                                        </div>
                                                        <div className="viewer-lineage-list" data-testid="lineage-trace-list">
                                                            {lineageTrace.nodes.slice(1).map((node) => {
                                                                const opsLabel = formatOpsLabel(node.ops_json);
                                                                if (node.is_ghost) {
                                                                    const isExpanded = expandedGhostIds.has(node.id);
                                                                    const hasSeed = node.seed != null && node.seed !== "";
                                                                    const hasCfg = node.cfg_scale != null && node.cfg_scale !== "";
                                                                    const hasSteps = node.steps != null && node.steps !== "";
                                                                    return (
                                                                        <div
                                                                            key={`trace-ghost-${node.id}`}
                                                                            className={`viewer-lineage-row ghost-ancestor-row lineage-ghost-row ${isExpanded ? "expanded" : ""}`}
                                                                            data-testid={`lineage-trace-ghost-${node.id}`}
                                                                        >
                                                                            <button
                                                                                type="button"
                                                                                className="lineage-ghost-toggle-btn"
                                                                                data-testid={`lineage-trace-ghost-toggle-${node.id}`}
                                                                                aria-expanded={isExpanded}
                                                                                aria-controls={`ghost-details-${node.id}`}
                                                                                onClick={() => toggleGhostExpanded(node.id)}
                                                                                onKeyDown={(e) => {
                                                                                    if (e.key === "Enter" || e.key === " ") {
                                                                                        e.preventDefault();
                                                                                        toggleGhostExpanded(node.id);
                                                                                    }
                                                                                }}
                                                                            >
                                                                                {node.thumbnail_path && (
                                                                                    <img
                                                                                        src={toAssetSrc(node.thumbnail_path)}
                                                                                        alt="Culled ancestor thumbnail"
                                                                                        data-testid={`lineage-trace-ghost-thumb-${node.id}`}
                                                                                        loading="lazy"
                                                                                        decoding="async"
                                                                                        className="lineage-ghost-thumb"
                                                                                    />
                                                                                )}
                                                                                <span className="viewer-ghost-recipe-title">
                                                                                    <GhostIcon size={14} /> {formatGhostRecipeText(node)}
                                                                                </span>
                                                                                {opsLabel && (
                                                                                    <span className="viewer-ghost-recipe-mutations">
                                                                                        Mutations: {opsLabel}
                                                                                    </span>
                                                                                )}
                                                                            </button>
                                                                            {isExpanded && (
                                                                                <div
                                                                                    id={`ghost-details-${node.id}`}
                                                                                    className="viewer-ghost-expanded-details lineage-ghost-details"
                                                                                    data-testid={`lineage-trace-ghost-details-${node.id}`}
                                                                                >
                                                                                    {opsLabel && (
                                                                                        <div data-testid="ghost-detail-ops">
                                                                                            <strong>Ops:</strong> {opsLabel}
                                                                                        </div>
                                                                                    )}
                                                                                    {(node.sampler || node.scheduler || node.model_name) && (
                                                                                        <div data-testid="ghost-detail-model">
                                                                                            <strong>Model &amp; Sampler:</strong> {[node.model_name, node.sampler, node.scheduler].filter(Boolean).join(" · ")}
                                                                                        </div>
                                                                                    )}
                                                                                    {(hasSeed || hasCfg || hasSteps) && (
                                                                                        <div data-testid="ghost-detail-sampling">
                                                                                            <strong>Sampling:</strong> {[
                                                                                                hasSeed ? `Seed: ${node.seed}` : null,
                                                                                                hasCfg ? `CFG: ${node.cfg_scale}` : null,
                                                                                                hasSteps ? `Steps: ${node.steps}` : null,
                                                                                            ].filter(Boolean).join(" · ")}
                                                                                        </div>
                                                                                    )}
                                                                                    {node.prompt && (
                                                                                        <div className="viewer-ghost-prompt" data-testid="ghost-detail-prompt">
                                                                                            <strong>Prompt:</strong> {node.prompt}
                                                                                        </div>
                                                                                    )}
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                }
                                                                const thumb = lineageThumbs[node.filepath];
                                                                return (
                                                                    <div
                                                                        key={`trace-live-${node.id}`}
                                                                        className="viewer-lineage-row"
                                                                        data-testid={`lineage-trace-live-${node.id}`}
                                                                    >
                                                                        <button
                                                                            type="button"
                                                                            className="viewer-lineage-thumb-btn"
                                                                            onClick={() => handleLineageJump(node.filepath)}
                                                                            title={`Jump to ${node.filename}`}
                                                                            data-testid={`lineage-jump-trace-${node.id}`}
                                                                        >
                                                                            {thumb ? (
                                                                                <img src={toAssetSrc(thumb)} alt={node.filename} loading="lazy" decoding="async" />
                                                                            ) : (
                                                                                <span className="viewer-lineage-thumb-placeholder">—</span>
                                                                            )}
                                                                        </button>
                                                                        <div className="viewer-lineage-meta">
                                                                            <span className="viewer-lineage-filename" title={node.filepath}>
                                                                                {node.filename}
                                                                            </span>
                                                                            <span className="viewer-lineage-relation">
                                                                                {opsLabel ? opsLabel : `${node.source} • depth ${node.depth}`}
                                                                            </span>
                                                                        </div>
                                                                        <div className="viewer-lineage-actions">
                                                                            <button
                                                                                type="button"
                                                                                className="viewer-control-button"
                                                                                onClick={() => handleLineageJump(node.filepath)}
                                                                            >
                                                                                Jump
                                                                            </button>
                                                                            <button
                                                                                type="button"
                                                                                className="viewer-control-button"
                                                                                onClick={() => handlePinLineageToCompare(node.filepath)}
                                                                            >
                                                                                Pin
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </>
                                                )}
                                                <div className="viewer-form-label">Children ({lineageCursor.children.length}/2)</div>
                                                {lineageCursor.children.length === 0 ? (
                                                    <div className="photo-viewer-note">No children.</div>
                                                ) : (
                                                    <div className="viewer-lineage-list" data-testid="lineage-children">
                                                        {lineageCursor.children.map((edge) => {
                                                            const thumb = lineageThumbs[edge.child_filepath];
                                                            const label = edge.child_filepath.split(/[/\\]/).pop() ?? edge.child_filepath;
                                                            return (
                                                                <div key={`${edge.child_filepath}|${edge.parent_filepath}`} className="viewer-lineage-row" data-testid="lineage-child-row">
                                                                    <button
                                                                        type="button"
                                                                        className="viewer-lineage-thumb-btn"
                                                                        onClick={() => handleLineageJump(edge.child_filepath)}
                                                                        title={`Jump to ${label}`}
                                                                        data-testid="lineage-jump-child"
                                                                    >
                                                                        {thumb ? (
                                                                            <img src={toAssetSrc(thumb)} alt={label} loading="lazy" decoding="async" />
                                                                        ) : (
                                                                            <span className="viewer-lineage-thumb-placeholder">—</span>
                                                                        )}
                                                                    </button>
                                                                    <div className="viewer-lineage-meta">
                                                                        <span className="viewer-lineage-filename" title={edge.child_filepath}>{label}</span>
                                                                        <span className="viewer-lineage-relation">{edge.relation} • {edge.confidence.toFixed(2)}</span>
                                                                    </div>
                                                                    <div className="viewer-lineage-actions">
                                                                        <button type="button" className="viewer-control-button" onClick={() => handleLineageJump(edge.child_filepath)} data-testid="lineage-jump-btn">Jump</button>
                                                                        <button type="button" className="viewer-control-button" onClick={() => handlePinLineageToCompare(edge.child_filepath)} data-testid="lineage-pin-btn">Pin</button>
                                                                        <button type="button" className="viewer-control-button danger" onClick={() => handleLineageUnlink(edge, "child")} disabled={isLineageMutating} data-testid="lineage-unlink-btn">Unlink</button>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                                <div className="viewer-form-label">Manual Link</div>
                                                <div className="viewer-form-grid">
                                                    <input className="viewer-input" value={linkParentInput} onChange={(e) => setLinkParentInput(e.target.value)} placeholder="Parent filepath" data-testid="lineage-link-parent" />
                                                    <input className="viewer-input" value={linkRelationInput} onChange={(e) => setLinkRelationInput(e.target.value)} placeholder="relation" data-testid="lineage-link-relation" />
                                                </div>
                                                <button type="button" className="viewer-action-button primary" onClick={handleLineageLink} disabled={isLineageMutating || !linkParentInput.trim()} data-testid="lineage-link-btn">{isLineageMutating ? "Saving…" : "Link"}</button>
                                                <div className="viewer-form-label">Compare Lab</div>
                                                <button type="button" className="viewer-action-button" onClick={handlePinCurrentToCompare} data-testid="lineage-pin-current">Pin current to Compare Lab</button>
                                            </>
                                        )}
                                        {!isLineageLoading && !lineageCursor && (
                                            <div className="photo-viewer-note">No lineage data.</div>
                                        )}
                                    </section>
                                </>
                            )}
                        </div>
                    </aside>
                </div>
                {imageContextMenu && imageContextMenuPosition && (
                    <div
                        className="image-context-menu"
                        style={{
                            left: imageContextMenuPosition.left,
                            top: imageContextMenuPosition.top,
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <button
                            type="button"
                            className="image-context-menu-item"
                            onClick={copyCompressedCurrentImage}
                        >
                            Compress + Copy for Discord
                        </button>
                        <button
                            type="button"
                            className="image-context-menu-item"
                            onClick={copyJpegCurrentImage}
                        >
                            Copy JPEG to Clipboard
                        </button>
                    </div>
                )}
            </div>
            {isPromptLibraryOpen &&
                createPortal(
                    <PromptLibraryDialog
                        onClose={() => setIsPromptLibraryOpen(false)}
                        onApply={(entry) => {
                            setForgeOverrides((prev) => ({
                                ...prev,
                                prompt: entry.prompt,
                                negative_prompt: entry.negative_prompt,
                            }));
                            setPromptLibraryNote(`Applied "${entry.title}".`);
                        }}
                    />,
                    document.body
                )}
        </div>
    );
}
