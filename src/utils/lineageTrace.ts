import type { LineageTraceNode } from "../types/metadata";

/**
 * Formats a human-readable ops label from the ops_json payload stamped on lineage edges.
 * Example: `{"ops":[{"kind":"seed_step","value":2},{"kind":"cfg_delta","value":1.0}]}` -> "seed+2, cfg+1"
 */
export function formatOpsLabel(opsJson: string | null | undefined): string | null {
    if (!opsJson) return null;
    try {
        const parsed = JSON.parse(opsJson);
        const ops = parsed.ops;
        const labels: string[] = [];
        if (Array.isArray(ops)) {
            for (const op of ops) {
                if (op.kind === "seed_step") {
                    labels.push(`seed+${op.value}`);
                } else if (op.kind === "cfg_delta") {
                    labels.push(`cfg${op.value > 0 ? `+${op.value}` : op.value}`);
                } else if (op.kind === "steps_delta") {
                    labels.push(`steps${op.value > 0 ? `+${op.value}` : op.value}`);
                } else if (op.kind === "sampler_scheduler_swap") {
                    if (op.sampler) labels.push(String(op.sampler));
                    if (op.scheduler) labels.push(String(op.scheduler));
                }
            }
        }
        if (parsed.variant_label && parsed.variant_label !== "unprocessed") {
            labels.push(String(parsed.variant_label));
        }
        return labels.length > 0 ? labels.join(", ") : null;
    } catch {
        return null;
    }
}

/**
 * Formats a text-only recipe string for culled/ghost ancestor nodes.
 * Example: "culled ancestor · seed 1234 · cfg 7 · Euler a"
 */
export function formatGhostRecipeText(node: LineageTraceNode): string {
    const parts: string[] = ["culled ancestor"];
    if (node.seed) parts.push(`seed ${node.seed}`);
    if (node.cfg_scale) parts.push(`cfg ${node.cfg_scale}`);
    if (node.steps) parts.push(`steps ${node.steps}`);
    if (node.sampler) parts.push(node.sampler);
    if (node.scheduler && node.scheduler !== "Automatic") parts.push(node.scheduler);
    if (node.model_name) parts.push(node.model_name.replace(/\.[^/.]+$/, ""));
    return parts.join(" · ");
}
