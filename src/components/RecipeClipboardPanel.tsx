import { useCallback, useState } from "react";
import type { GalleryImageRecord, ImageRecord } from "../types/metadata";
import type { Recipe } from "../types/recipe";
import { copyRecipeText, encodeRecipeBundle, readRecipeText, validateRecipe } from "../utils/recipeClipboard";
import { buildWinnerRecipe, countRecipeFields, readPastedRecipe } from "../utils/recipeWinner";

export interface RecipeClipboardPanelProps {
    /** The selected CompareLab winner pin. */
    winner: GalleryImageRecord;
    /** Resolved detail fetched by CompareLab; null/undefined while still loading. */
    winnerDetails?: ImageRecord | null;
    /** Compare pins — the matching pin supplies the recipe's source identity. */
    pins?: GalleryImageRecord[];
    /**
     * CompareLab's existing pin mechanism. Returning false means the recipe could not be
     * resolved to a real indexed image; this component never fabricates an image record.
     */
    onPinPastedRecipe?: (recipe: Recipe) => boolean;
}

function friendlyMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.replace(/^Error:\s*/i, "").trim() || "unknown error";
}

function missingEntryFields(recipe: Recipe): string {
    const missing: string[] = [];
    if (recipe.source?.id == null) missing.push("source.id");
    if (!recipe.source?.filepath) missing.push("source.filepath");
    if (!recipe.source?.filename) missing.push("source.filename");
    return missing.length > 0
        ? missing.join(", ")
        : "a matching indexed image for source.id / source.filepath";
}

export function RecipeClipboardPanel({
    winner,
    winnerDetails,
    pins = [],
    onPinPastedRecipe,
}: RecipeClipboardPanelProps) {
    const detailsUnavailable = winnerDetails == null;
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState<"copy" | "paste" | null>(null);
    const [staged, setStaged] = useState<Recipe | null>(null);

    const handleCopy = useCallback(async () => {
        if (detailsUnavailable) return;
        setBusy("copy");
        setStatus(null);
        try {
            const recipe = buildWinnerRecipe(winner, winnerDetails, pins);
            // Bundle text keeps the verbatim LoRA token string, including [0.8@t1, 0.6@t2].
            await copyRecipeText(encodeRecipeBundle([recipe]));
            setStatus(`Copied ${countRecipeFields(recipe)} fields`);
        } catch (err) {
            setStatus(`Copy failed: ${friendlyMessage(err)}`);
        } finally {
            setBusy(null);
        }
    }, [detailsUnavailable, winner, winnerDetails, pins]);

    const handlePaste = useCallback(async () => {
        setBusy("paste");
        setStatus(null);
        setStaged(null);
        try {
            const text = await readRecipeText();
            const recipe = readPastedRecipe(text);
            const count = countRecipeFields(recipe);
            setStaged(recipe); // "staged in internal state" is literal, not a claim of a send
            const model = recipe.model_name?.trim() || "unknown model";

            let pinned = false;
            if (onPinPastedRecipe) {
                try {
                    pinned = onPinPastedRecipe(recipe);
                } catch {
                    pinned = false;
                }
            }

            const absent = validateRecipe(recipe).length;
            const summary = `${count} fields validated${absent > 0 ? `, ${absent} absent` : ""}`;
            if (pinned) {
                setStatus(`Pasted recipe for ${model} — ${summary}`);
            } else {
                setStatus(
                    `Pasted recipe for ${model} — ${summary}; staged in internal state, no pinned slot created. Manual entry needed: ${missingEntryFields(recipe)}.`,
                );
            }
        } catch (err) {
            setStatus(`Invalid recipe: ${friendlyMessage(err)}`);
        } finally {
            setBusy(null);
        }
    }, [onPinPastedRecipe]);

    const isError = status?.startsWith("Invalid recipe:") === true || status?.startsWith("Copy failed:") === true;

    return (
        <div
            className="recipe-clipboard-panel"
            data-testid="recipe-clipboard-panel"
            style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
                padding: "6px 8px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--bg-card)",
            }}
        >
            <strong style={{ fontSize: 11, color: "var(--text-secondary)" }}>Winner recipe</strong>
            <button
                type="button"
                className="compare-lab-btn"
                onClick={() => void handleCopy()}
                disabled={detailsUnavailable || busy !== null}
                title={detailsUnavailable ? "Details still loading" : undefined}
                data-testid="recipe-copy-btn"
            >
                Copy recipe
            </button>
            {detailsUnavailable && (
                <span
                    style={{ fontSize: 11, color: "var(--text-tertiary)" }}
                    data-testid="recipe-details-loading"
                >
                    Details still loading
                </span>
            )}
            <button
                type="button"
                className="compare-lab-btn"
                onClick={() => void handlePaste()}
                disabled={busy !== null}
                data-testid="recipe-paste-btn"
            >
                Paste recipe
            </button>
            {staged !== null && (
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }} data-testid="recipe-field-count">
                    {countRecipeFields(staged)} fields validated
                </span>
            )}
            <span
                role="status"
                aria-live="polite"
                data-testid="recipe-clipboard-status"
                style={{ fontSize: 11, color: isError ? "var(--error)" : "var(--text-secondary)" }}
            >
                {status ?? ""}
            </span>
        </div>
    );
}

export default RecipeClipboardPanel;
