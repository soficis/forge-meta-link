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
    /** All PNG text chunks (tEXt/zTXt/iTXt); empty when the record carries none. Never inferred. */
    text_chunks: Record<string, string>;
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

// Mirrors Rust `build_requeue_payload` (forge_api.rs:775-786): either Clip skip key is accepted,
// but only a whole number becomes the numeric Forge option `CLIP_stop_at_last_layers`.
function parseClipSkip(extraParams: Record<string, string>): number | undefined {
    const raw = (extraParams["Clip skip"] ?? extraParams["clip_skip"])?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) ? value : undefined;
}

export function normalizeScheduler(value: string): string {
    const lowered = value.trim().toLowerCase();
    switch (lowered) {
        case "karras":
            return "karras";
        case "exponential":
            return "exponential";
        case "sgm uniform":
            return "sgm_uniform";
        case "simple":
            return "simple";
        case "beta":
            return "beta";
        case "linear":
            return "linear";
        case "ddim uniform":
            return "ddim_uniform";
        case "normal":
            return "normal";
        case "uniform":
            return "uniform";
        default:
            return lowered.split(/\s+/).filter(Boolean).join("_");
    }
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
    const schedulerRaw = parseOptionalText(params.schedule_type);
    const scheduler = schedulerRaw === undefined ? undefined : normalizeScheduler(schedulerRaw);
    const modelCheckpoint = parseOptionalText(params.model_name);

    // Only valid Forge options belong in override_settings (sd_model_checkpoint and Clip skip),
    // matching the Rust requeue payload. Sampler/scheduler/cfg/seed stay top-level fields.
    const overrides: Record<string, unknown> = {};
    if (modelCheckpoint) overrides["sd_model_checkpoint"] = modelCheckpoint;
    const clipSkip = parseClipSkip(params.extra_params);
    if (clipSkip !== undefined) overrides["CLIP_stop_at_last_layers"] = clipSkip;
    const overrideSettings = Object.keys(overrides).length > 0 ? overrides : undefined;

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

/**
 * Requeue mirrors Rust `build_requeue_payload` (forge_api.rs:757-793): override_settings holds
 * only `sd_model_checkpoint` and integer Clip skip. Sampler, scheduler, cfg and seed are
 * top-level payload fields — never injected into override_settings. `buildForgePayload` already
 * builds that shape and gates the top-level seed on includeSeed, so the two paths stay identical.
 */
export function buildRequeuePayload(
    params: GenerationParams,
    includeSeed = true
): ForgeTxt2ImgPayload {
    return buildForgePayload(params, { includeSeed });
}

export function payloadToJson(payload: ForgeTxt2ImgPayload): string {
    return JSON.stringify(payload);
}
