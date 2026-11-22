import { MODEL_FAMILIES } from "./modelFamilies";

// Derived from the single-source model registry so the checkpoint-family filter
// in the search bar can never drift from the detection/preset registry again.
export const CHECKPOINT_FAMILY_OPTIONS: Array<{ value: string; label: string }> = MODEL_FAMILIES.filter(
    (family) => family.id !== "unknown" && family.id !== "vace"
).map((family) => ({ value: family.id, label: family.label }));
