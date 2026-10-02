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

function parseI64(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    const n = Number(value.trim());
    return Number.isFinite(n) && Number.isInteger(n) ? n : undefined;
}

function extractLoraTokens(prompt: string): Array<{ name: string; weight: string }> {
    const tokens: Array<{ name: string; weight: string }> = [];
    const lower = prompt.toLowerCase();
    let cursor = 0;
    while (true) {
        const found = lower.indexOf("<lora:", cursor);
        if (found === -1) break;
        const start = found + "<lora:".length;
        const end = prompt.indexOf(">", start);
        const sliceEnd = end === -1 ? prompt.length : end;
        const inner = prompt.slice(start, sliceEnd);
        const colon = inner.indexOf(":");
        let name: string;
        let weight: string;
        if (colon !== -1) {
            name = inner.slice(0, colon).trim();
            weight = inner.slice(colon + 1).trim();
        } else {
            name = inner.trim();
            weight = "1.0";
        }
        if (name && !tokens.some((t) => t.name === name)) {
            const w = Number(weight);
            tokens.push({ name, weight: Number.isFinite(w) ? String(w) : "1.0" });
        }
        cursor = sliceEnd + 1;
        if (cursor >= prompt.length) break;
    }
    return tokens;
}

function buildLoraAlwaysOn(params: GenerationParams): Record<string, unknown> | undefined {
    const entries: Array<Record<string, unknown>> = [];
    for (const tok of extractLoraTokens(params.prompt)) {
        entries.push({ name: tok.name, weight: Number(tok.weight) });
    }
    for (const [key, val] of Object.entries(params.extra_params ?? {})) {
        if (key.toLowerCase().includes("lora")) {
            const name = val.split(":")[0]?.trim().replace(/^"|"$/g, "") ?? "";
            if (name && !entries.some((e) => e["name"] === name)) {
                entries.push({ name, weight: 1.0 });
            }
        }
    }
    if (entries.length === 0) return undefined;
    return { LoRA: { args: entries } };
}

function mergeAlwaysOn(
    a: Record<string, unknown> | undefined,
    b: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    if (!a && !b) return undefined;
    if (a && !b) return a;
    if (!a && b) return b;
    return { ...(a as object), ...(b as object) };
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

    const loraScripts = buildLoraAlwaysOn(params);
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
    const alwaysonScripts = mergeAlwaysOn(loraScripts, adetailerScripts);

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
        save_images: true,
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

    if (!next.alwayson_scripts) {
        const lora = buildLoraAlwaysOn(params);
        if (lora) next.alwayson_scripts = lora;
    }

    return next;
}

export function payloadToJson(payload: ForgeTxt2ImgPayload): string {
    return JSON.stringify(payload);
}
