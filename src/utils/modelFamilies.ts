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
    | "qwen_image_edit"
    | "qwen_image"
    | "flux2_klein"
    | "flux"
    | "krea_identity_edit"
    | "krea2_turbo"
    | "zimage_turbo"
    | "anima"
    | "moss_image"
    | "ernie_image"
    | "ponyxl"
    | "sdxl"
    | "sd15"
    | "lumina"
    | "pixart"
    | "kolors"
    | "auraflow"
    | "hunyuan"
    | "sana"
    | "wan"
    | "chroma_hd"
    | "chroma"
    | "vace"
    | "pid"
    | "mugen"
    | "unknown";

export const RESOLUTION_PRESETS: Record<string, ResolutionPreset[]> = MODEL_FAMILIES.reduce(
    (acc, family) => {
        acc[family.id] = family.presets;
        return acc;
    },
    {} as Record<string, ResolutionPreset[]>
);

// Pre-compiled regexes for family detection ordered specific before generic.
// Specific ordering guarantees the edit/2.x variants win over their base families
// (Qwen-Edit before Qwen, Flux.2 before Flux, Krea Identity before Krea 2 Turbo,
// Chroma1-HD before Chroma), while PiD comes last so its SDXL/Qwen/Flux variants
// keep their more specific family.
const DETECTION_RULES: Array<{ id: ModelFamilyId; test: (lowered: string) => boolean }> = [
    {
        id: "qwen_image_edit",
        test: (s) =>
            s.includes("qwen") &&
            (s.includes("edit") || /qwen[\s_-]*2[._-]?1/.test(s)),
    },
    {
        id: "qwen_image",
        test: (s) =>
            s.includes("qwen") ||
            s.includes("2512") ||
            /qwen[\s_-]*image/.test(s) ||
            /qwen[\s_-]*2[._-]?5/.test(s),
    },
    {
        id: "krea_identity_edit",
        test: (s) => s.includes("krea") && s.includes("identity"),
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
        id: "flux2_klein",
        test: (s) =>
            s.includes("flux") &&
            (s.includes("klein") || s.includes("flux2") || s.includes("flux.2")),
    },
    {
        id: "flux",
        test: (s) => s.includes("flux"),
    },
    {
        id: "chroma_hd",
        test: (s) => s.includes("chroma") && s.includes("hd"),
    },
    { id: "anima", test: (s) => s.includes("anima") },
    { id: "moss_image", test: (s) => s.includes("moss") },
    { id: "ernie_image", test: (s) => s.includes("ernie") },
    { id: "mugen", test: (s) => s.includes("mugen") },
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
            /sd[\s_-]*1[._-]?5/.test(s) ||
            s.includes("sd15") ||
            s.includes("stable diffusion 1.5") ||
            s.includes("v1-5"),
    },
    { id: "lumina", test: (s) => s.includes("lumina") },
    { id: "pixart", test: (s) => s.includes("pixart") },
    { id: "kolors", test: (s) => s.includes("kolors") },
    { id: "auraflow", test: (s) => s.includes("auraflow") },
    { id: "hunyuan", test: (s) => s.includes("hunyuan") },
    {
        id: "wan",
        test: (s) =>
            /wan[\s_-]*2/.test(s) ||
            s.includes("wanvideo") ||
            /(?:^|[\s_-])wan(?:[\s_.-]|$)/.test(s),
    },
    { id: "sana", test: (s) => /(?:^|[\s_-])sana(?:[\s_.-]|$)/.test(s) },
    {
        id: "chroma",
        test: (s) => s.includes("chroma"),
    },
    { id: "vace", test: (s) => s.includes("vace") },
    {
        // Word boundary keeps "pixel" / "rapid" out; placed last so PiD variants
        // of SDXL/Qwen/Flux keep their more specific detection.
        id: "pid",
        test: (s) => /(?:^|[^a-z])pid(?![a-z])/.test(s),
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
