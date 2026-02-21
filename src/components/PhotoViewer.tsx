import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
    exportImages,
    exportImagesAsFiles,
    forgeGetOptions,
    forgeSendToImage,
    getDisplayImagePath,
    getImageClipboardPayload,
    getImageDetail,
    getSidecarData,
    getThumbnailPath,
    getThumbnailPaths,
    openFileLocation,
    saveSidecarTags,
} from "../services/commands";
import {
    copyJpegImageToClipboard,
    copyCompressedImageForDiscord,
    formatBytes,
} from "../utils/imageClipboard";
import type {
    DeleteMode,
    ForgePayloadOverrides,
    GalleryImageRecord,
    ImageExportFormat,
    ImageRecord,
} from "../types/metadata";
import { usePersistedState } from "../hooks/usePersistedState";
import type { ShowToastOptions } from "../hooks/useToast";

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
    onForgeModelsPathChange: (value: string) => void;
    onForgeModelsScanSubfoldersChange: (value: boolean) => void;
    forgeLoraPath: string;
    forgeLoraScanSubfolders: boolean;
    onForgeLoraPathChange: (value: string) => void;
    onForgeLoraScanSubfoldersChange: (value: boolean) => void;
    forgeSelectedLoras: string[];
    onForgeSelectedLorasChange: (values: string[]) => void;
    forgeLoraWeight: string;
    onForgeLoraWeightChange: (value: string) => void;
    forgeIncludeSeed: boolean;
    forgeAdetailerFaceEnabled: boolean;
    forgeAdetailerFaceModel: string;
    onSearchBySeed: (seed: string) => void;
    onDeleteCurrentImage: (image: GalleryImageRecord) => void;
    isDeletingCurrentImage: boolean;
    deleteMode: DeleteMode;
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
type ResolutionPresetFamily = "pony_sdxl" | "flux" | "zimage_turbo";

const RESOLUTION_PRESETS: Record<
    ResolutionPresetFamily,
    Array<{ label: string; width: string; height: string }>
> = {
    pony_sdxl: [
        { label: "768 x 1344", width: "768", height: "1344" },
        { label: "832 x 1216", width: "832", height: "1216" },
        { label: "896 x 1152", width: "896", height: "1152" },
        { label: "1024 x 1024", width: "1024", height: "1024" },
        { label: "1152 x 896", width: "1152", height: "896" },
        { label: "1216 x 832", width: "1216", height: "832" },
        { label: "1344 x 768", width: "1344", height: "768" },
    ],
    flux: [
        { label: "1024 x 1024", width: "1024", height: "1024" },
        { label: "896 x 1152", width: "896", height: "1152" },
        { label: "1152 x 896", width: "1152", height: "896" },
        { label: "768 x 1344", width: "768", height: "1344" },
        { label: "1344 x 768", width: "1344", height: "768" },
    ],
    zimage_turbo: [
        { label: "1024 x 1024", width: "1024", height: "1024" },
        { label: "896 x 1152", width: "896", height: "1152" },
        { label: "1152 x 896", width: "1152", height: "896" },
        { label: "768 x 1344", width: "768", height: "1344" },
        { label: "1344 x 768", width: "1344", height: "768" },
    ],
};
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

function detectResolutionFamilyFromModelName(modelName: string | null | undefined): ResolutionPresetFamily {
    const lowered = (modelName ?? "").toLowerCase();
    if (lowered.includes("flux")) {
        return "flux";
    }
    if (lowered.includes("z-image") || lowered.includes("zimage") || lowered.includes("turbo")) {
        return "zimage_turbo";
    }
    return "pony_sdxl";
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
    onForgeModelsPathChange,
    onForgeModelsScanSubfoldersChange,
    forgeLoraPath,
    forgeLoraScanSubfolders,
    onForgeLoraPathChange,
    onForgeLoraScanSubfoldersChange,
    forgeSelectedLoras,
    onForgeSelectedLorasChange,
    forgeLoraWeight,
    onForgeLoraWeightChange,
    forgeIncludeSeed,
    forgeAdetailerFaceEnabled,
    forgeAdetailerFaceModel,
    onSearchBySeed,
    onDeleteCurrentImage,
    isDeletingCurrentImage,
    deleteMode,
    onToggleFavorite,
    onToggleLocked,
    onShowToast,
}: PhotoViewerProps) {
    const currentImage = images[currentIndex] ?? null;
    const [currentDetail, setCurrentDetail] = useState<ImageRecord | null>(null);
    const [isDetailLoading, setIsDetailLoading] = useState(false);

    const [isSendingToForge, setIsSendingToForge] = useState(false);
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
    const [infoPanelTab, setInfoPanelTab] = useState<"info" | "forge">("info");
    const [isSlideshow, setIsSlideshow] = useState(false);
    const [slideshowIntervalMs, setSlideshowIntervalMs] = usePersistedState(
        "viewerSlideshowIntervalMs",
        DEFAULT_SLIDESHOW_INTERVAL,
        slideshowIntervalStorage
    );
    const [selectedResolutionFamily, setSelectedResolutionFamily] =
        useState<ResolutionPresetFamily>("pony_sdxl");
    const [isLoraDropdownOpen, setIsLoraDropdownOpen] = useState(false);
    const [loraSearch, setLoraSearch] = useState("");

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
        const presets = RESOLUTION_PRESETS[selectedResolutionFamily];
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
        const compatible = modelDropdownOptions.filter(
            (modelName) =>
                detectResolutionFamilyFromModelName(modelName) === detectedModelFamily
        );
        return compatible.length > 0 ? compatible : modelDropdownOptions;
    }, [detectedModelFamily, modelDropdownOptions]);

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
        if (!current) {
            return forgeSchedulerOptions;
        }
        return forgeSchedulerOptions.includes(current)
            ? forgeSchedulerOptions
            : [current, ...forgeSchedulerOptions];
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
    const hasForgeValidationErrors =
        stepsValidationError != null ||
        cfgScaleValidationError != null ||
        loraWeightValidationError != null;
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
        setIsDetailLoading(true);

        getImageDetail(imageId)
            .then((detail) => {
                if (cancelled || detailRequestRef.current !== requestId) {
                    return;
                }
                setCurrentDetail(detail);
            })
            .catch(() => {
                if (cancelled || detailRequestRef.current !== requestId) {
                    return;
                }
                setCurrentDetail(null);
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
    }, [currentImage?.id]);

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
        if (forgeOverridesImageIdRef.current === currentImage.id) {
            return;
        }
        setForgeOverrides(createForgeOverrides(currentImage, currentDetail));
        forgeOverridesImageIdRef.current = currentImage.id;
    }, [currentDetail, currentImage]);

    useEffect(() => {
        if (!forgeBaseUrl.trim()) {
            setForgeModelOptions([]);
            setForgeLoraOptions([]);
            setForgeSamplerOptions([]);
            setForgeSchedulerOptions([]);
            setForgeOptionsWarning(null);
            return;
        }

        let cancelled = false;
        setIsLoadingForgeOptions(true);
        setForgeOptionsWarning(null);

        forgeGetOptions(
            forgeBaseUrl,
            forgeApiKey.trim() ? forgeApiKey : null,
            forgeModelsPath.trim() ? forgeModelsPath : null,
            forgeModelsScanSubfolders,
            forgeLoraPath.trim() ? forgeLoraPath : null,
            forgeLoraScanSubfolders
        )
            .then((options) => {
                if (cancelled) {
                    return;
                }
                setForgeModelOptions(options.models);
                setForgeLoraOptions(options.loras);
                setForgeSamplerOptions(options.samplers);
                setForgeSchedulerOptions(options.schedulers);
                setForgeOptionsWarning(
                    options.warnings.length > 0 ? options.warnings.join(" | ") : null
                );
            })
            .catch((error) => {
                if (cancelled) {
                    return;
                }
                setForgeModelOptions([]);
                setForgeLoraOptions([]);
                setForgeSamplerOptions([]);
                setForgeSchedulerOptions([]);
                setForgeOptionsWarning(`Forge options unavailable: ${String(error)}`);
            })
            .finally(() => {
                if (cancelled) {
                    return;
                }
                setIsLoadingForgeOptions(false);
            });

        return () => {
            cancelled = true;
        };
    }, [
        forgeApiKey,
        forgeBaseUrl,
        forgeLoraPath,
        forgeLoraScanSubfolders,
        forgeModelsPath,
        forgeModelsScanSubfolders,
    ]);

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

    const handleSelectForgeModelsFolder = useCallback(async () => {
        const selected = await open({
            directory: true,
            multiple: false,
            title: "Select Forge models directory",
        });
        if (selected && typeof selected === "string") {
            onForgeModelsPathChange(selected);
        }
    }, [onForgeModelsPathChange]);

    const handleSelectForgeLoraFolder = useCallback(async () => {
        const selected = await open({
            directory: true,
            multiple: false,
            title: "Select Forge LoRA directory",
        });
        if (selected && typeof selected === "string") {
            onForgeLoraPathChange(selected);
        }
    }, [onForgeLoraPathChange]);

    const toggleLoraSelection = useCallback(
        (loraToken: string) => {
            const token = loraToken.trim();
            if (!token) {
                return;
            }
            if (forgeSelectedLoras.includes(token)) {
                onForgeSelectedLorasChange(
                    forgeSelectedLoras.filter((value) => value !== token)
                );
                return;
            }
            onForgeSelectedLorasChange([...forgeSelectedLoras, token]);
        },
        [forgeSelectedLoras, onForgeSelectedLorasChange]
    );

    const removeSelectedLora = useCallback(
        (loraToken: string) => {
            onForgeSelectedLorasChange(
                forgeSelectedLoras.filter((value) => value !== loraToken)
            );
        },
        [forgeSelectedLoras, onForgeSelectedLorasChange]
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
            showViewerToast(`Loaded preset: ${name}`, "success", 2400);
        },
        [
            forgePayloadPresets,
            onForgeLoraWeightChange,
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
        };

        setForgePayloadPresets((prev) => ({ ...prev, [name]: preset }));
        setSelectedForgePreset(name);
        setForgePresetNameInput(name);
        showViewerToast(`Saved preset: ${name}`, "success", 2400);
    }, [
        adetailerFaceModelForCurrentRequest,
        forgeLoraWeight,
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
        if (currentImage.is_locked || currentImage.is_favorite) {
            showViewerToast(
                "This image is protected. Unlock or unfavorite it first.",
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

    const handleSendToForge = useCallback(async () => {
        if (!currentImage) {
            return;
        }
        if (!hasValidForgeUrl) {
            showViewerToast(
                forgeUrlValidationError ?? "Forge URL is invalid.",
                "error"
            );
            return;
        }
        if (hasForgeValidationErrors) {
            showViewerToast(
                "Fix invalid Forge payload fields before sending.",
                "error"
            );
            return;
        }

        setIsSendingToForge(true);
        try {
            const result = await forgeSendToImage(
                currentImage.id,
                forgeBaseUrl,
                forgeApiKey.trim() ? forgeApiKey : null,
                forgeOutputDir.trim() ? forgeOutputDir : null,
                sendSeedForCurrentRequest,
                useAdetailerForCurrentRequest,
                adetailerFaceModelForCurrentRequest.trim()
                    ? adetailerFaceModelForCurrentRequest
                    : null,
                forgeSelectedLoras.length > 0 ? forgeSelectedLoras : null,
                forgeLoraWeight.trim() ? Number(forgeLoraWeight) : null,
                forgeOverrides
            );
            showViewerToast(result.message, result.ok ? "success" : "warning");
        } catch (error) {
            showViewerToast(`Forge send failed: ${String(error)}`, "error");
        } finally {
            setIsSendingToForge(false);
        }
    }, [
        currentImage,
        forgeApiKey,
        forgeBaseUrl,
        forgeOutputDir,
        forgeSelectedLoras,
        forgeLoraWeight,
        sendSeedForCurrentRequest,
        useAdetailerForCurrentRequest,
        adetailerFaceModelForCurrentRequest,
        forgeOverrides,
        forgeUrlValidationError,
        hasValidForgeUrl,
        hasForgeValidationErrors,
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
                            className="viewer-control-button danger"
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
                                >
                                    Info
                                </button>
                                <button
                                    type="button"
                                    className={`photo-viewer-tab ${infoPanelTab === "forge" ? "active" : ""}`}
                                    onClick={() => setInfoPanelTab("forge")}
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
                                    title="Copy Metadata"
                                >
                                    Meta
                                </button>
                                <button
                                    className="viewer-toolbar-btn"
                                    onClick={() =>
                                        currentDetail &&
                                        copyText(currentDetail.prompt, "Prompt copied")
                                    }
                                    disabled={!currentDetail || isDetailLoading}
                                    title="Copy Prompt"
                                >
                                    Prompt
                                </button>
                                <button
                                    className="viewer-toolbar-btn"
                                    onClick={handleOpenFileLocation}
                                    title="Open file in Explorer"
                                >
                                    Locate
                                </button>
                                <button
                                    className="viewer-toolbar-btn danger"
                                    onClick={handleDeleteCurrentImage}
                                    disabled={
                                        isDeletingCurrentImage ||
                                        Boolean(
                                            currentImage?.is_locked || currentImage?.is_favorite
                                        )
                                    }
                                    title={
                                        currentImage?.is_locked || currentImage?.is_favorite
                                            ? "Protected image: unlock or unfavorite first"
                                            : deleteMode === "trash"
                                              ? "Move this image to Trash"
                                              : "Permanently delete this image"
                                    }
                                >
                                    {isDeletingCurrentImage
                                        ? "Deleting..."
                                        : deleteMode === "trash"
                                          ? "Trash"
                                          : "Delete"}
                                </button>
                                <button
                                    className="viewer-toolbar-btn"
                                    onClick={handleSearchSameSeed}
                                    disabled={!currentSeed || isDeletingCurrentImage}
                                    title="Find Same Seed"
                                >
                                    Seed
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
                                            ? "Remove favorite protection"
                                            : "Mark as favorite (protected from delete)"
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
                                <>
                                    <section className="photo-viewer-section">
                                        <h4>Forge Payload</h4>
                                        {!hasValidForgeUrl && (
                                            <div className="input-error" role="alert">
                                                {forgeUrlValidationError}
                                            </div>
                                        )}
                                        {isLoadingForgeOptions && (
                                            <div className="photo-viewer-note">Loading Forge options...</div>
                                        )}
                                        {forgeOptionsWarning && (
                                            <div className="photo-viewer-note">{forgeOptionsWarning}</div>
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
                                        <div className="viewer-form-label">Models Folder</div>
                                        <div className="viewer-form-grid">
                                            <input
                                                className="viewer-input"
                                                value={forgeModelsPath}
                                                onChange={(event) =>
                                                    onForgeModelsPathChange(event.target.value)
                                                }
                                                placeholder="Select Forge models folder"
                                            />
                                            <button
                                                className="viewer-control-button"
                                                onClick={handleSelectForgeModelsFolder}
                                                type="button"
                                            >
                                                Browse
                                            </button>
                                        </div>
                                        <label className="viewer-toggle-row">
                                            <input
                                                type="checkbox"
                                                checked={forgeModelsScanSubfolders}
                                                onChange={(event) =>
                                                    onForgeModelsScanSubfoldersChange(
                                                        event.target.checked
                                                    )
                                                }
                                            />
                                            Scan model subfolders
                                        </label>
                                        <div className="viewer-form-label">LoRA Folder</div>
                                        <div className="viewer-form-grid">
                                            <input
                                                className="viewer-input"
                                                value={forgeLoraPath}
                                                onChange={(event) =>
                                                    onForgeLoraPathChange(event.target.value)
                                                }
                                                placeholder="Select Forge LoRA folder"
                                            />
                                            <button
                                                className="viewer-control-button"
                                                onClick={handleSelectForgeLoraFolder}
                                                type="button"
                                            >
                                                Browse
                                            </button>
                                        </div>
                                        <label className="viewer-toggle-row">
                                            <input
                                                type="checkbox"
                                                checked={forgeLoraScanSubfolders}
                                                onChange={(event) =>
                                                    onForgeLoraScanSubfoldersChange(
                                                        event.target.checked
                                                    )
                                                }
                                            />
                                            Scan LoRA subfolders
                                        </label>
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
                                            <div className="viewer-tag-chip-list">
                                                {forgeSelectedLoras.map((lora) => (
                                                    <button
                                                        key={lora}
                                                        className="viewer-tag-chip"
                                                        onClick={() => removeSelectedLora(lora)}
                                                        title="Remove LoRA"
                                                        type="button"
                                                    >
                                                        {lora}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                        <div className="viewer-form-label">LoRA Weight</div>
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
                                        <div className="viewer-form-label">Prompt</div>
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
                                        <label className="viewer-toggle-row">
                                            <input
                                                type="checkbox"
                                                checked={sendSeedForCurrentRequest}
                                                onChange={(event) =>
                                                    setSendSeedForCurrentRequest(event.target.checked)
                                                }
                                            />
                                            Send seed with request
                                        </label>
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
                                        <div className="viewer-form-label">Resolution Preset Family</div>
                                        <select
                                            className="viewer-input"
                                            value={selectedResolutionFamily}
                                            onChange={(event) =>
                                                setSelectedResolutionFamily(
                                                    event.target.value as ResolutionPresetFamily
                                                )
                                            }
                                        >
                                            <option value="pony_sdxl">PonyXL / SDXL</option>
                                            <option value="flux">Flux</option>
                                            <option value="zimage_turbo">Z-Image Turbo</option>
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
                                            {RESOLUTION_PRESETS[selectedResolutionFamily].map((option) => (
                                                <option
                                                    key={`${option.width}x${option.height}`}
                                                    value={`${option.width}x${option.height}`}
                                                >
                                                    {option.label}
                                                </option>
                                            ))}
                                        </select>
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
                                            <input
                                                className="viewer-input"
                                                value={forgeOverrides.seed}
                                                onChange={(event) =>
                                                    updateForgeOverride("seed", event.target.value)
                                                }
                                                placeholder="Seed"
                                                disabled={!sendSeedForCurrentRequest}
                                            />
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
                                        {(stepsValidationError || cfgScaleValidationError) && (
                                            <div className="input-error" role="alert">
                                                {stepsValidationError ?? cfgScaleValidationError}
                                            </div>
                                        )}
                                        <select
                                            className="viewer-input"
                                            value={
                                                familyCompatibleModelOptions.includes(
                                                    forgeOverrides.model_name
                                                )
                                                    ? forgeOverrides.model_name
                                                    : ""
                                            }
                                            onChange={(event) =>
                                                updateForgeOverride("model_name", event.target.value)
                                            }
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
                                        <button
                                            className="viewer-action-button primary"
                                            onClick={handleSendToForge}
                                            disabled={
                                                isSendingToForge ||
                                                !hasValidForgeUrl ||
                                                hasForgeValidationErrors ||
                                                isDetailLoading ||
                                                !currentDetail
                                            }
                                            style={{ marginTop: 6 }}
                                        >
                                            {isSendingToForge ? "Sending..." : "Send to Forge"}
                                        </button>
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
        </div>
    );
}
