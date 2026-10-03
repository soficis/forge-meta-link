import modelFamiliesData from "../constants/model_families.json";

export interface ResolutionPreset {
    label: string;
    width: string;
    height: string;
}

export interface ModelFamilyDefinition {
    id: string;
    label: string;
    compact_names: string[];
    like_patterns: string[];
    match_regex: string;
    presets: ResolutionPreset[];
}

export const MODEL_FAMILIES: ModelFamilyDefinition[] = modelFamiliesData as ModelFamilyDefinition[];

export type ModelFamilyId =
    | "qwen_image"
    | "flux"
    | "krea2_turbo"
    | "zimage_turbo"
    | "ponyxl"
    | "sdxl"
    | "sd35"
    | "sd3"
    | "sd15"
    | "sd21"
    | "lumina"
    | "pixart"
    | "kolors"
    | "auraflow"
    | "hunyuan"
    | "sana"
    | "wan"
    | "chroma"
    | "vace"
    | "unknown";

export const RESOLUTION_PRESETS: Record<string, ResolutionPreset[]> = MODEL_FAMILIES.reduce(
    (acc, family) => {
        acc[family.id] = family.presets;
        return acc;
    },
    {} as Record<string, ResolutionPreset[]>
);

// Pre-compiled regexes for family detection ordered specific before generic.
// Specific ordering guarantees e.g. SD3.5 is checked before SD3, WAN2 before WAN, Krea 2 before Turbo, etc.
const DETECTION_RULES: Array<{ id: ModelFamilyId; test: (lowered: string) => boolean }> = [
    {
        id: "qwen_image",
        test: (s) =>
            s.includes("qwen") ||
            s.includes("2512") ||
            /qwen[\\s_-]*image/.test(s) ||
            /qwen[\\s_-]*2[\\._-]?5/.test(s),
    },
    {
        id: "krea2_turbo",
        test: (s) => /krea[\s_-]*2/.test(s),
    },
    {
        id: "zimage_turbo",
        test: (s) => s.includes("z-image") || s.includes("zimage"),
    },
    {
        id: "flux",
        test: (s) => s.includes("flux"),
    },
    {
        id: "sd35",
        test: (s) => /sd[\s_-]*3[\._-]?5/.test(s),
    },
    {
        id: "sd3",
        test: (s) => /sd[\s_-]*3(?:[^0-9.]|$)/.test(s) || s.includes("stable diffusion 3"),
    },
    {
        id: "ponyxl",
        test: (s) => s.includes("pony"),
    },
    {
        id: "sdxl",
        test: (s) => s.includes("sdxl") || s.includes("sd_xl") || s.includes("sd-xl") || s.includes("stable diffusion xl"),
    },
    {
        id: "sd15",
        test: (s) =>
            /sd[\s_-]*1[\._-]?5/.test(s) ||
            s.includes("sd15") ||
            s.includes("stable diffusion 1.5") ||
            s.includes("v1-5"),
    },
    {
        id: "sd21",
        test: (s) =>
            /sd[\s_-]*2[\._-]?1/.test(s) ||
            s.includes("sd21") ||
            s.includes("stable diffusion 2.1") ||
            s.includes("v2-1"),
    },
    {
        id: "lumina",
        test: (s) => s.includes("lumina"),
    },
    {
        id: "pixart",
        test: (s) => s.includes("pixart"),
    },
    {
        id: "kolors",
        test: (s) => s.includes("kolors"),
    },
    {
        id: "auraflow",
        test: (s) => s.includes("auraflow"),
    },
    {
        id: "hunyuan",
        test: (s) => s.includes("hunyuan"),
    },
    {
        id: "wan",
        test: (s) =>
            /wan[\s_-]*2/.test(s) ||
            s.includes("wanvideo") ||
            /(?:^|[\s_-])wan(?:[\s_\.-]|$)/.test(s),
    },
    {
        id: "sana",
        test: (s) => /(?:^|[\s_-])sana(?:[\s_\.-]|$)/.test(s),
    },
    {
        id: "chroma",
        test: (s) => s.includes("chroma"),
    },
    {
        id: "vace",
        test: (s) => s.includes("vace"),
    },
];

export function detectResolutionFamilyFromModelName(
    modelName: string | null | undefined
): ModelFamilyId {
    const lowered = (modelName ?? "").toLowerCase().trim();
    if (!lowered) {
        return "unknown";
    }

    for (const rule of DETECTION_RULES) {
        if (rule.test(lowered)) {
            return rule.id;
        }
    }

    return "unknown";
}

export function getModelFamilyDefinition(id: string): ModelFamilyDefinition {
    const found = MODEL_FAMILIES.find((f) => f.id === id);
    return found ?? MODEL_FAMILIES.find((f) => f.id === "unknown")!;
}
