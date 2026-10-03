import type { ForgePayload } from "../types/metadata";

export interface GenerationParams {
    prompt: string;
    negative_prompt: string;
    steps: string | null;
    sampler: string | null;
    schedule_type: string | null;
    cfg_scale: string | null;
    seed: string | null;
    width: number | null;
    height: number | null;
    model_hash: string | null;
    model_name: string | null;
    generation_type: string | null;
    extra_params: Record<string, string>;
    raw_metadata: string;
}

export interface ForgeTxt2ImgPayload extends ForgePayload {
    scheduler?: string;
    override_settings?: Record<string, unknown>;
    alwayson_scripts?: Record<string, unknown>;
    send_images?: boolean;
    save_images?: boolean;
}

function parseOptionalText(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    const t = value.trim();
    return t ? t : undefined;
}

function parseU32(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    const n = Number(value.trim());
    return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function parseF32(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : undefined;
}

// JS numbers are exact only up to 2^53-1. A larger seed would be sent silently altered,
// so it is rejected here; the production requeue path (Rust) carries seeds as exact i64 strings.
function parseI64(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : undefined;
}

export function buildForgePayload(
    params: GenerationParams,
    options?: {
        includeSeed?: boolean;
        adetailerEnabled?: boolean;
        adetailerModel?: string;
    }
): ForgeTxt2ImgPayload {
    const includeSeed = options?.includeSeed ?? true;
    const samplerName = parseOptionalText(params.sampler);
    const scheduler = parseOptionalText(params.schedule_type);
    const modelCheckpoint = parseOptionalText(params.model_name);

    const overrideSettings: Record<string, unknown> | undefined = modelCheckpoint
        ? { sd_model_checkpoint: modelCheckpoint }
        : undefined;

    // LoRAs are applied by Forge from the <lora:name:weight> tags in the prompt. A "LoRA"
    // always-on script does not exist and makes Forge answer HTTP 422.
    const adetailerScripts: Record<string, unknown> | undefined = options?.adetailerEnabled
        ? {
              ADetailer: {
                  args: [
                      true,
                      false,
                      { ad_model: options.adetailerModel?.trim() || "face_yolov8n.pt" },
                  ],
              },
          }
        : undefined;
    const alwaysonScripts = adetailerScripts;

    return {
        prompt: params.prompt,
        negative_prompt: params.negative_prompt,
        steps: parseU32(params.steps),
        sampler_name: samplerName,
        scheduler,
        cfg_scale: parseF32(params.cfg_scale),
        seed: includeSeed ? parseI64(params.seed) : undefined,
        width: params.width ?? undefined,
        height: params.height ?? undefined,
        override_settings: overrideSettings,
        alwayson_scripts: alwaysonScripts,
        send_images: true,
        save_images: false,
        batch_size: 1,
        n_iter: 1,
    };
}

export function buildRequeuePayload(
    params: GenerationParams,
    includeSeed = true
): ForgeTxt2ImgPayload {
    const base = buildForgePayload(params, { includeSeed });
    const overrides: Record<string, unknown> = { ...(base.override_settings ?? {}) };

    const sampler = parseOptionalText(params.sampler);
    const scheduler = parseOptionalText(params.schedule_type);
    const cfg = parseF32(params.cfg_scale);
    const seed = parseI64(params.seed);
    const model = parseOptionalText(params.model_name);

    if (model) overrides["sd_model_checkpoint"] = model;
    if (sampler) {
        overrides["sd_sampler"] = sampler;
        overrides["sampler_name"] = sampler;
    }
    if (scheduler) overrides["sd_scheduler"] = scheduler;
    if (cfg !== undefined) overrides["cfg_scale"] = cfg;
    if (includeSeed && seed !== undefined) overrides["seed"] = seed;
    if (!includeSeed) delete overrides["seed"];

    const next: ForgeTxt2ImgPayload = {
        ...base,
        override_settings: Object.keys(overrides).length > 0 ? overrides : undefined,
    };


    return next;
}

export function payloadToJson(payload: ForgeTxt2ImgPayload): string {
    return JSON.stringify(payload);
}
