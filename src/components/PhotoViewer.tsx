import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
    exportImages,
    exportImagesAsFiles,
    forgeGetOptions,
    forgeSendToImage,
    getDisplayImagePath,
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
    ForgePayloadOverrides,
    GalleryImageRecord,
    ImageExportFormat,
    ImageRecord,
} from "../types/metadata";

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
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const ZOOM_STEP = 0.2;
const FILMSTRIP_RADIUS = 80;
const FILMSTRIP_CHUNK_SIZE = 64;
const FILMSTRIP_CONCURRENCY = Math.max(
    3,
    Math.min(12, navigator.hardwareConcurrency || 8)
);
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

interface ForgePayloadPreset {
    forge_overrides: ForgePayloadOverrides;
    send_seed_with_request: boolean;
    adetailer_face_enabled: boolean;
    adetailer_face_model: string;
    lora_tokens: string[];
    lora_weight: string;
}

function readForgePayloadPresets(): Record<string, ForgePayloadPreset> {
    const raw = localStorage.getItem(FORGE_PAYLOAD_PRESETS_STORAGE_KEY);
    if (!raw) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
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
        return {};
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
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
}: PhotoViewerProps) {
    const currentImage = images[currentIndex] ?? null;
    const [currentDetail, setCurrentDetail] = useState<ImageRecord | null>(null);
    const [isDetailLoading, setIsDetailLoading] = useState(false);

    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const [isSendingToForge, setIsSendingToForge] = useState(false);
    const [isSavingSidecar, setIsSavingSidecar] = useState(false);

    const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null);
    const [displayImagePath, setDisplayImagePath] = useState<string | null>(null);
    const [fullResLoaded, setFullResLoaded] = useState(false);
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
    const [forgePayloadPresets, setForgePayloadPresets] = useState<
        Record<string, ForgePayloadPreset>
    >(readForgePayloadPresets);
    const [selectedForgePreset, setSelectedForgePreset] = useState("");
    const [forgePresetNameInput, setForgePresetNameInput] = useState("");
    const [singleImageExportFormat, setSingleImageExportFormat] =
        useState<ImageExportFormat>("original");
    const [singleImageExportQuality, setSingleImageExportQuality] = useState(85);

    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [isInfoOpen, setIsInfoOpen] = useState(true);
    const [isSlideshow, setIsSlideshow] = useState(false);
    const [slideshowIntervalMs, setSlideshowIntervalMs] = useState(() => {
        const raw = localStorage.getItem("viewerSlideshowIntervalMs");
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed >= 1000
            ? parsed
            : DEFAULT_SLIDESHOW_INTERVAL;
    });
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

    useEffect(() => {
        localStorage.setItem("viewerSlideshowIntervalMs", String(slideshowIntervalMs));
    }, [slideshowIntervalMs]);

    const fullImageSrc = useMemo(
        () => (displayImagePath ? convertFileSrc(displayImagePath) : ""),
        [displayImagePath]
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
        localStorage.setItem(
            FORGE_PAYLOAD_PRESETS_STORAGE_KEY,
            JSON.stringify(forgePayloadPresets)
        );
    }, [forgePayloadPresets]);

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

    const filmstripStart = Math.max(0, currentIndex - FILMSTRIP_RADIUS);
    const filmstripEnd = Math.min(images.length, currentIndex + FILMSTRIP_RADIUS + 1);
    const filmstripImages = useMemo(
        () => images.slice(filmstripStart, filmstripEnd),
        [filmstripEnd, filmstripStart, images]
    );

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

    const applyForgePayloadPreset = useCallback(
        (name: string) => {
            const preset = forgePayloadPresets[name];
            if (!preset) {
                setStatusMessage(`Preset not found: ${name}`);
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
            setStatusMessage(`Loaded preset: ${name}`);
            window.setTimeout(() => setStatusMessage(null), 2400);
        },
        [forgePayloadPresets, onForgeLoraWeightChange, onForgeSelectedLorasChange]
    );

    const saveCurrentAsForgePreset = useCallback(() => {
        const name = forgePresetNameInput.trim();
        if (!name) {
            setStatusMessage("Enter a preset name");
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
        setStatusMessage(`Saved preset: ${name}`);
        window.setTimeout(() => setStatusMessage(null), 2400);
    }, [
        adetailerFaceModelForCurrentRequest,
        forgeLoraWeight,
        forgeOverrides,
        forgePresetNameInput,
        forgeSelectedLoras,
        sendSeedForCurrentRequest,
        useAdetailerForCurrentRequest,
    ]);

    const deleteForgePreset = useCallback(() => {
        const name = selectedForgePreset.trim();
        if (!name) {
            setStatusMessage("Select a preset to delete");
            return;
        }

        setForgePayloadPresets((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
        });
        setSelectedForgePreset("");
        setStatusMessage(`Deleted preset: ${name}`);
        window.setTimeout(() => setStatusMessage(null), 2400);
    }, [selectedForgePreset]);

    const copyText = useCallback(async (value: string, successMessage: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setStatusMessage(successMessage);
            window.setTimeout(() => setStatusMessage(null), 2400);
        } catch {
            setStatusMessage("Clipboard write failed");
        }
    }, []);

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
            setStatusMessage(
                `Copied ${mimeLabel} ${currentImage.filename} (${result.width}x${result.height}, ${formatBytes(
                    result.bytes
                )})`
            );
            window.setTimeout(() => setStatusMessage(null), 2800);
        } catch (error) {
            setStatusMessage(`Copy failed: ${String(error)}`);
            window.setTimeout(() => setStatusMessage(null), 2800);
        }
    }, [currentImage]);

    const copyJpegCurrentImage = useCallback(async () => {
        if (!currentImage) {
            return;
        }
        setImageContextMenu(null);
        try {
            const result = await copyJpegImageToClipboard(currentImage.filepath);
            const mimeLabel = result.mime.replace("image/", "").toUpperCase();
            setStatusMessage(
                `Copied ${mimeLabel} ${currentImage.filename} (${result.width}x${result.height}, ${formatBytes(
                    result.bytes
                )})`
            );
            window.setTimeout(() => setStatusMessage(null), 2800);
        } catch (error) {
            setStatusMessage(`JPEG copy failed: ${String(error)}`);
            window.setTimeout(() => setStatusMessage(null), 2800);
        }
    }, [currentImage]);

    const handleOpenFileLocation = useCallback(async () => {
        if (!currentImage) return;
        try {
            await openFileLocation(currentImage.filepath);
        } catch (error) {
            setStatusMessage(`Failed: ${String(error)}`);
        }
    }, [currentImage]);

    const handleSearchSameSeed = useCallback(() => {
        if (!currentSeed) {
            setStatusMessage("No seed found for this image");
            return;
        }
        onSearchBySeed(currentSeed);
    }, [currentSeed, onSearchBySeed]);

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
                setStatusMessage(`Exported to ${result.output_path}`);
                window.setTimeout(() => setStatusMessage(null), 3000);
            } catch (error) {
                setStatusMessage(`Export failed: ${String(error)}`);
            }
        },
        [currentImage]
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
            setStatusMessage("Exporting image...");
            const result = await exportImagesAsFiles(
                [currentImage.id],
                singleImageExportFormat,
                singleImageExportFormat === "original"
                    ? null
                    : singleImageExportQuality,
                outputPath
            );
            setStatusMessage(`Exported image to ${result.output_path}`);
            window.setTimeout(() => setStatusMessage(null), 3200);
        } catch (error) {
            setStatusMessage(`Image export failed: ${String(error)}`);
        }
    }, [
        currentImage,
        singleImageExportFormat,
        singleImageExportQuality,
    ]);

    const handleSendToForge = useCallback(async () => {
        if (!currentImage) {
            return;
        }
        setIsSendingToForge(true);
        setStatusMessage(null);
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
            setStatusMessage(result.message);
        } catch (error) {
            setStatusMessage(`Forge send failed: ${String(error)}`);
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
    ]);

    const handleSaveSidecar = useCallback(async () => {
        if (!currentImage) {
            return;
        }
        setIsSavingSidecar(true);
        try {
            await saveSidecarTags(currentImage.filepath, sidecarTags, sidecarNotes || null);
            setStatusMessage("Sidecar saved");
            window.setTimeout(() => setStatusMessage(null), 2200);
        } catch (error) {
            setStatusMessage(`Save failed: ${String(error)}`);
        } finally {
            setIsSavingSidecar(false);
        }
    }, [currentImage, sidecarNotes, sidecarTags]);

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

        setFullResLoaded(false);
        setStatusMessage(null);
        setImageContextMenu(null);
        resetTransform();

        setThumbnailSrc(null);
        setDisplayImagePath(null);
        getThumbnailPath(filepath)
            .then((thumbPath) => {
                if (cancelled) {
                    return;
                }
                setThumbnailSrc(convertFileSrc(thumbPath));
            })
            .catch(() => {});
        getDisplayImagePath(filepath)
            .then((resolvedPath) => {
                if (cancelled) {
                    return;
                }
                setDisplayImagePath(resolvedPath);
            })
            .catch(() => {
                if (cancelled) {
                    return;
                }
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
            preload.src = convertFileSrc(images[index].filepath);
        }
    }, [currentImage, currentIndex, images]);

    useEffect(() => {
        let cancelled = false;
        const missing = filmstripImages
            .map((image) => image.filepath)
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
        Promise.allSettled(workers).catch(() => {});

        return () => {
            cancelled = true;
        };
    }, [filmstripImages]);

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
                        >
                            Open Location
                        </button>
                        <button
                            className={`viewer-control-button ${isSlideshow ? "active" : ""}`}
                            onClick={toggleSlideshow}
                            title="Toggle slideshow (S)"
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
                        >
                            {isInfoOpen ? "Hide Info" : "Show Info"}
                        </button>
                        <button className="viewer-control-button danger" onClick={onClose}>
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
                            >
                                Prev
                            </button>
                            <button className="viewer-control-button" onClick={zoomOut}>
                                -
                            </button>
                            <span className="viewer-zoom-label">{Math.round(zoom * 100)}%</span>
                            <button className="viewer-control-button" onClick={zoomIn}>
                                +
                            </button>
                            <button className="viewer-control-button" onClick={resetTransform}>
                                Reset
                            </button>
                            <button
                                className="viewer-control-button"
                                onClick={goNext}
                                disabled={!canGoNext}
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
                                    className="photo-viewer-image preview"
                                />
                            )}
                            <img
                                key={`main-${currentImage.id}-${fullImageSrc}`}
                                src={fullImageSrc}
                                alt={currentImage.filename}
                                className="photo-viewer-image main"
                                loading="eager"
                                decoding="async"
                                onLoad={() => setFullResLoaded(true)}
                                style={{
                                    opacity: fullResLoaded ? 1 : 0,
                                    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                                    cursor: zoom > 1 ? (isPanning ? "grabbing" : "grab") : "default",
                                }}
                            />
                        </div>

                        <div className="photo-viewer-filmstrip">
                            {filmstripImages.map((image, localIndex) => {
                                const absoluteIndex = filmstripStart + localIndex;
                                const thumbPath =
                                    filmstripThumbPaths[image.filepath] ?? null;
                                return (
                                    <button
                                        key={`filmstrip-${image.id}`}
                                        className={`photo-viewer-thumb ${
                                            absoluteIndex === currentIndex ? "active" : ""
                                        }`}
                                        onClick={() => onNavigate(absoluteIndex)}
                                        title={image.filename}
                                    >
                                        {thumbPath ? (
                                            <img
                                                src={convertFileSrc(thumbPath)}
                                                alt={image.filename}
                                                loading="lazy"
                                                decoding="async"
                                            />
                                        ) : (
                                            <span
                                                style={{
                                                    width: "100%",
                                                    height: "100%",
                                                    display: "block",
                                                    background: "var(--bg-tertiary)",
                                                }}
                                            />
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    <aside className={`photo-viewer-info-panel ${isInfoOpen ? "open" : "closed"}`}>
                        <div className="photo-viewer-info-scroll">
                            <div className="photo-viewer-actions">
                                <button
                                    className="viewer-action-button"
                                    onClick={() =>
                                        currentDetail &&
                                        copyText(currentDetail.raw_metadata, "Raw metadata copied")
                                    }
                                    disabled={!currentDetail || isDetailLoading}
                                >
                                    Copy Metadata
                                </button>
                                <button
                                    className="viewer-action-button"
                                    onClick={() =>
                                        currentDetail &&
                                        copyText(currentDetail.prompt, "Prompt copied")
                                    }
                                    disabled={!currentDetail || isDetailLoading}
                                >
                                    Copy Prompt
                                </button>
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
                                <button
                                    className="viewer-action-button"
                                    onClick={handleSendToForge}
                                    disabled={
                                        isSendingToForge ||
                                        !forgeBaseUrl.trim() ||
                                        isDetailLoading ||
                                        !currentDetail
                                    }
                                >
                                    {isSendingToForge ? "Sending..." : "Send to Forge"}
                                </button>
                                <button
                                    className="viewer-action-button"
                                    onClick={handleOpenFileLocation}
                                >
                                    Open Location
                                </button>
                                <button
                                    className="viewer-action-button"
                                    onClick={handleSearchSameSeed}
                                    disabled={!currentSeed}
                                >
                                    Find Same Seed
                                </button>
                            </div>

                            <section className="photo-viewer-section">
                                <h4>Export Image</h4>
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
                                        Export Image ZIP
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
                            </section>

                            {statusMessage && (
                                <div className="photo-viewer-note">{statusMessage}</div>
                            )}
                            {isDetailLoading && (
                                <div className="photo-viewer-note">Loading metadata...</div>
                            )}

                            <section className="photo-viewer-section">
                                <h4>Forge Payload</h4>
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
                                                setStatusMessage("Select a preset to load");
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
                                        className="viewer-input"
                                        value={forgeLoraWeight}
                                        onChange={(event) =>
                                            onForgeLoraWeightChange(event.target.value)
                                        }
                                        placeholder="1.00"
                                    />
                                </div>
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
                                        className="viewer-input"
                                        value={forgeOverrides.steps}
                                        onChange={(event) =>
                                            updateForgeOverride("steps", event.target.value)
                                        }
                                        placeholder="Steps"
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
                                        className="viewer-input"
                                        value={forgeOverrides.cfg_scale}
                                        onChange={(event) =>
                                            updateForgeOverride("cfg_scale", event.target.value)
                                        }
                                        placeholder="CFG Scale"
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
