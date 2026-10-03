import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
    deletePrompt,
    exportPromptLibrary,
    importPromptLibrary,
    listPromptTags,
    listPrompts,
    markPromptUsed,
    savePrompt,
    updatePrompt,
} from "../services/commands";
import type { PromptEntry, PromptTagCount } from "../types/metadata";
import { Modal } from "./Modal";
import "./PromptLibrary.css";

export interface PromptLibraryDialogProps {
    onClose: () => void;
    /** When provided, an "Apply" button fills the caller's prompt fields. */
    onApply?: (entry: PromptEntry) => void;
}

interface Draft {
    id: number | null;
    title: string;
    prompt: string;
    negative_prompt: string;
    tags: string;
    notes: string;
}

const EMPTY_DRAFT: Draft = { id: null, title: "", prompt: "", negative_prompt: "", tags: "", notes: "" };

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function PromptLibraryDialog({ onClose, onApply }: PromptLibraryDialogProps) {
    const [entries, setEntries] = useState<PromptEntry[]>([]);
    const [tags, setTags] = useState<PromptTagCount[]>([]);
    const [query, setQuery] = useState("");
    const [activeTag, setActiveTag] = useState<string | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: "", error: false });
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [deletedEntries, setDeletedEntries] = useState<PromptEntry[]>([]);
    const undoTimerRef = useRef<number | null>(null);
    const requestSeq = useRef(0);
    const searchInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        return () => {
            if (undoTimerRef.current) {
                window.clearTimeout(undoTimerRef.current);
            }
        };
    }, []);

    const refresh = useCallback(async () => {
        const seq = ++requestSeq.current;
        try {
            const [rows, tagRows] = await Promise.all([
                listPrompts(query, activeTag ?? undefined),
                listPromptTags(),
            ]);
            if (seq !== requestSeq.current) return; // a newer search superseded this one
            setEntries(rows);
            setTags(tagRows);
        } catch (error) {
            if (seq === requestSeq.current) setStatus({ text: errorText(error), error: true });
        }
    }, [query, activeTag]);

    useEffect(() => {
        const handle = window.setTimeout(() => void refresh(), 150);
        return () => window.clearTimeout(handle);
    }, [refresh]);

    const report = (text: string, error = false) => setStatus({ text, error });

    const handleCopy = async (entry: PromptEntry) => {
        try {
            await navigator.clipboard.writeText(entry.prompt);
            await markPromptUsed(entry.id);
            report("Prompt copied.");
            void refresh();
        } catch (error) {
            report(errorText(error), true);
        }
    };

    const handleApply = async (entry: PromptEntry) => {
        onApply?.(entry);
        try {
            await markPromptUsed(entry.id);
        } catch {
            // use_count is cosmetic; applying must not fail because of it
        }
        onClose();
    };

    const handleConfirmDelete = async (entry: PromptEntry) => {
        setDeletingId(null);
        try {
            await deletePrompt(entry.id);
            setDeletedEntries((prev) => {
                const next = [...prev, entry];
                return next.length > 5 ? next.slice(next.length - 5) : next;
            });
            // One shared timer for the whole stack: each delete restarts the 6s window,
            // and when it fires it clears ALL pending entries, not just the oldest.
            if (undoTimerRef.current) {
                window.clearTimeout(undoTimerRef.current);
            }
            undoTimerRef.current = window.setTimeout(() => {
                setDeletedEntries([]);
                undoTimerRef.current = null;
            }, 6000);
            void refresh();
        } catch (error) {
            report(errorText(error), true);
        }
    };

    const handleUndo = async () => {
        if (deletedEntries.length === 0) return;
        const toRestore = deletedEntries[deletedEntries.length - 1];
        const remaining = deletedEntries.slice(0, deletedEntries.length - 1);
        setDeletedEntries(remaining);
        if (undoTimerRef.current) {
            window.clearTimeout(undoTimerRef.current);
            undoTimerRef.current = null;
        }
        if (remaining.length > 0) {
            undoTimerRef.current = window.setTimeout(() => {
                setDeletedEntries([]);
                undoTimerRef.current = null;
            }, 6000);
        }
        try {
            // NOTE: savePrompt creates a new row with a new id, resetting use_count to 0
            // and dropping any other columns not accepted by save_prompt (e.g. created_at/updated_at).
            // This is a known backend schema limitation.
            await savePrompt({
                title: toRestore.title,
                prompt: toRestore.prompt,
                negativePrompt: toRestore.negative_prompt,
                tags: toRestore.tags,
                notes: toRestore.notes,
            });
            report("");
            void refresh();
        } catch (error) {
            report(errorText(error), true);
        }
    };

    const handleSaveDraft = async () => {
        if (!draft) return;
        try {
            const fields = {
                title: draft.title,
                prompt: draft.prompt,
                negativePrompt: draft.negative_prompt,
                tags: draft.tags,
                notes: draft.notes,
            };
            if (draft.id == null) {
                const result = await savePrompt(fields);
                report(result.created ? "Saved." : "An identical prompt already exists.");
            } else {
                await updatePrompt(draft.id, fields);
                report("Updated.");
            }
            setDraft(null);
            void refresh();
        } catch (error) {
            report(errorText(error), true);
        }
    };

    const handleExport = async () => {
        try {
            const path = await save({
                defaultPath: "prompt-library.json",
                filters: [{ name: "Prompt library", extensions: ["json"] }],
            });
            if (!path) return;
            const count = await exportPromptLibrary(path);
            report(`Exported ${count} prompt${count === 1 ? "" : "s"}.`);
        } catch (error) {
            report(errorText(error), true);
        }
    };

    const handleImport = async () => {
        try {
            const path = await open({
                multiple: false,
                filters: [{ name: "Prompt library", extensions: ["json"] }],
            });
            if (typeof path !== "string") return;
            const r = await importPromptLibrary(path);
            report(
                `Imported ${r.inserted}; skipped ${r.skipped_duplicates} duplicate(s), ${r.skipped_invalid} invalid.`
            );
            void refresh();
        } catch (error) {
            report(errorText(error), true);
        }
    };

    return (
        <Modal
            label="Prompt library"
            className="prompt-library"
            onClose={onClose}
            initialFocusRef={searchInputRef}
            closeOnEscape={false}
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    if (draft) setDraft(null);
                    else onClose();
                }
            }}
        >
            <header className="prompt-library-header">
                <h2>Prompt library</h2>
                <button type="button" className="sidebar-button" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                    New
                </button>
                <button type="button" className="sidebar-button" onClick={() => void handleImport()}>
                    Import
                </button>
                <button type="button" className="sidebar-button" onClick={() => void handleExport()}>
                    Export
                </button>
                <button type="button" className="sidebar-button" onClick={onClose} aria-label="Close prompt library">
                    Close
                </button>
            </header>

            {!onApply && (
                <div className="prompt-library-apply-hint">
                    Open an image&apos;s Forge tab to apply a prompt to a request. Copy works anywhere.
                </div>
            )}

            {draft ? (
                <div className="prompt-library-list">
                    <div className="prompt-library-form">
                        <input
                            className="viewer-input"
                            placeholder="Title (optional)"
                            value={draft.title}
                            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                        />
                        <textarea
                            className="viewer-textarea"
                            rows={5}
                            placeholder="Prompt"
                            value={draft.prompt}
                            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                        />
                        <textarea
                            className="viewer-textarea"
                            rows={3}
                            placeholder="Negative prompt"
                            value={draft.negative_prompt}
                            onChange={(e) => setDraft({ ...draft, negative_prompt: e.target.value })}
                        />
                        <input
                            className="viewer-input"
                            placeholder="Tags, comma separated"
                            value={draft.tags}
                            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                        />
                        <textarea
                            className="viewer-textarea"
                            rows={2}
                            placeholder="Notes"
                            value={draft.notes}
                            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                        />
                        <div className="prompt-library-item-actions">
                            <button
                                type="button"
                                className="sidebar-button"
                                disabled={!draft.prompt.trim()}
                                onClick={() => void handleSaveDraft()}
                            >
                                {draft.id == null ? "Save" : "Update"}
                            </button>
                            <button type="button" className="sidebar-button" onClick={() => setDraft(null)}>
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            ) : (
                <>
                    <div className="prompt-library-toolbar">
                        <input
                            ref={searchInputRef}
                            className="viewer-input"
                            type="search"
                            placeholder="Search prompts, titles, tags, notes"
                            aria-label="Search prompt library"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            autoFocus
                        />
                    </div>
                        {tags.length > 0 && (
                            <div className="prompt-library-tags">
                                {tags.map((t) => (
                                    <button
                                        key={t.tag}
                                        type="button"
                                        className="prompt-library-tag"
                                        aria-pressed={activeTag === t.tag}
                                        onClick={() => setActiveTag(activeTag === t.tag ? null : t.tag)}
                                    >
                                        {t.tag} ({t.count})
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="prompt-library-list">
                            {entries.length === 0 ? (
                                <div className="prompt-library-empty">
                                    {query || activeTag
                                        ? "No prompts match."
                                        : "No saved prompts yet. Use Save to library in the viewer, or click New."}
                                </div>
                            ) : (
                                entries.map((entry) => (
                                    <div key={entry.id} className="prompt-library-item">
                                        <div className="prompt-library-item-head">
                                            <span className="prompt-library-item-title" title={entry.title}>
                                                {entry.title}
                                            </span>
                                            <span className="prompt-library-item-meta">
                                                used {entry.use_count}x{entry.tags ? ` · ${entry.tags}` : ""}
                                            </span>
                                        </div>
                                        <div className="prompt-library-item-text">{entry.prompt}</div>
                                        <div className="prompt-library-item-actions">
                                            {onApply && (
                                                <button
                                                    type="button"
                                                    className="sidebar-button"
                                                    onClick={() => void handleApply(entry)}
                                                >
                                                    Apply
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                className="sidebar-button"
                                                onClick={() => void handleCopy(entry)}
                                            >
                                                Copy
                                            </button>
                                            <button
                                                type="button"
                                                className="sidebar-button"
                                                onClick={() =>
                                                    setDraft({
                                                        id: entry.id,
                                                        title: entry.title,
                                                        prompt: entry.prompt,
                                                        negative_prompt: entry.negative_prompt,
                                                        tags: entry.tags,
                                                        notes: entry.notes,
                                                    })
                                                }
                                            >
                                                Edit
                                            </button>
                                            {deletingId === entry.id ? (
                                                <div className="prompt-library-delete-confirm">
                                                    <span className="prompt-library-delete-confirm-label">Delete?</span>
                                                    <button
                                                        type="button"
                                                        className="sidebar-button danger"
                                                        onClick={() => void handleConfirmDelete(entry)}
                                                    >
                                                        Yes, delete
                                                    </button>
                                                    <button
                                                        ref={(el) => el?.focus()}
                                                        type="button"
                                                        className="sidebar-button"
                                                        onClick={() => setDeletingId(null)}
                                                    >
                                                        Keep
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    type="button"
                                                    className="sidebar-button danger"
                                                    onClick={() => setDeletingId(entry.id)}
                                                >
                                                    Delete
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </>
                )}
                <div className="prompt-library-status" role="status" data-error={status.error}>
                    {deletedEntries.length > 0 ? (
                        <span>
                            Deleted &quot;{deletedEntries[deletedEntries.length - 1].title}&quot;.{" "}
                            <button
                                type="button"
                                className="prompt-library-undo-btn"
                                onClick={() => void handleUndo()}
                            >
                                Undo
                            </button>
                            {deletedEntries.length > 1 && ` (+${deletedEntries.length - 1} more)`}
                        </span>
                    ) : (
                        status.text
                    )}
                </div>
        </Modal>
    );
}
