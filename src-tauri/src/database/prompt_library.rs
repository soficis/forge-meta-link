//! Prompt library (N2): user-owned saved prompts, independent of the image rows.
//!
//! Entries keep their own copy of the text, so culling or permanently deleting the source
//! image never alters a saved entry (`source_image_id` is `ON DELETE SET NULL`).

use super::{pool_error, sanitize_fts_query, Database};
use rusqlite::{params, params_from_iter, types::Value, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PROMPT_LIBRARY_MAX_ENTRIES_PER_IMPORT: usize = 10_000;
const TITLE_MAX_CHARS: usize = 120;
const DEFAULT_TITLE_CHARS: usize = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromptEntry {
    #[serde(default)]
    pub id: i64,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: String,
    /// Normalized: lowercase, comma-separated, deduplicated, no empty segments.
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub source_image_id: Option<i64>,
    #[serde(default)]
    pub use_count: i64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SavePromptResult {
    pub entry: PromptEntry,
    /// False when an identical prompt+negative already existed (its `updated_at` was bumped).
    pub created: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportPromptsResult {
    pub inserted: usize,
    pub skipped_duplicates: usize,
    pub skipped_invalid: usize,
}

/// Lowercase, trim, split on commas, drop empties, dedupe preserving order.
pub fn normalize_tags(raw: &str) -> String {
    let mut seen = Vec::<String>::new();
    for part in raw.split(',') {
        let t = part.trim().to_lowercase();
        if !t.is_empty() && !seen.contains(&t) {
            seen.push(t);
        }
    }
    seen.join(",")
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Hash over whitespace/case-normalized prompt + negative prompt.
pub fn prompt_content_hash(prompt: &str, negative: &str) -> String {
    let mut h = Sha256::new();
    h.update(collapse_ws(prompt).as_bytes());
    h.update(b"\n--negative--\n");
    h.update(collapse_ws(negative).as_bytes());
    format!("{:x}", h.finalize())
}

fn clamp_title(title: Option<&str>, prompt: &str) -> String {
    let t = title.map(str::trim).unwrap_or("");
    let source = if t.is_empty() { prompt.trim() } else { t };
    let limit = if t.is_empty() { DEFAULT_TITLE_CHARS } else { TITLE_MAX_CHARS };
    source.chars().take(limit).collect()
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

const SELECT_COLS: &str = "id, title, prompt, negative_prompt, tags, notes, source_image_id, \
                           use_count, created_at, updated_at";

fn row_to_entry(row: &rusqlite::Row<'_>) -> SqlResult<PromptEntry> {
    Ok(PromptEntry {
        id: row.get(0)?,
        title: row.get(1)?,
        prompt: row.get(2)?,
        negative_prompt: row.get(3)?,
        tags: row.get(4)?,
        notes: row.get(5)?,
        source_image_id: row.get(6)?,
        use_count: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn get_entry(conn: &Connection, id: i64) -> SqlResult<Option<PromptEntry>> {
    let sql = format!("SELECT {SELECT_COLS} FROM prompt_library WHERE id = ?1");
    match conn.query_row(&sql, params![id], row_to_entry) {
        Ok(e) => Ok(Some(e)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Insert-or-bump on `content_hash`. Returns (entry, created).
fn save_in(
    conn: &Connection,
    title: Option<&str>,
    prompt: &str,
    negative: &str,
    tags: &str,
    notes: &str,
    source_image_id: Option<i64>,
) -> SqlResult<(PromptEntry, bool)> {
    let hash = prompt_content_hash(prompt, negative);
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM prompt_library WHERE content_hash = ?1",
            params![hash],
            |r| r.get(0),
        )
        .ok();
    if let Some(id) = existing {
        conn.execute(
            "UPDATE prompt_library SET updated_at = strftime('%s','now') WHERE id = ?1",
            params![id],
        )?;
        let entry = get_entry(conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        return Ok((entry, false));
    }
    conn.execute(
        "INSERT INTO prompt_library
            (title, prompt, negative_prompt, tags, notes, source_image_id, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            clamp_title(title, prompt),
            prompt.trim(),
            negative.trim(),
            normalize_tags(tags),
            notes.trim(),
            source_image_id,
            hash
        ],
    )?;
    let id = conn.last_insert_rowid();
    let entry = get_entry(conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    Ok((entry, true))
}

impl Database {
    /// Saves a prompt. Empty (whitespace-only) prompts are rejected.
    pub fn save_prompt(
        &self,
        title: Option<&str>,
        prompt: &str,
        negative: &str,
        tags: &str,
        notes: &str,
        source_image_id: Option<i64>,
    ) -> SqlResult<SavePromptResult> {
        if prompt.trim().is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "prompt must not be empty".to_string(),
            ));
        }
        let conn = self.pool.get().map_err(pool_error)?;
        let (entry, created) =
            save_in(&conn, title, prompt, negative, tags, notes, source_image_id)?;
        Ok(SavePromptResult { entry, created })
    }

    /// Lists entries. `query` uses FTS (best match first); otherwise most recently updated first.
    pub fn list_prompts(
        &self,
        query: Option<&str>,
        tag: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> SqlResult<Vec<PromptEntry>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let limit = limit.clamp(1, 500) as i64;
        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<Value> = Vec::new();
        let mut order = "p.updated_at DESC, p.id DESC".to_string();
        let mut join = String::new();

        if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
            let fts = sanitize_fts_query(q);
            if fts.is_empty() {
                return Ok(Vec::new());
            }
            join = "JOIN prompt_library_fts f ON f.rowid = p.id".to_string();
            clauses.push("prompt_library_fts MATCH ?".to_string());
            args.push(Value::Text(fts));
            order = "f.rank, p.id DESC".to_string();
        }
        if let Some(t) = tag.map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()) {
            clauses.push("(',' || p.tags || ',') LIKE ? ESCAPE '\\'".to_string());
            args.push(Value::Text(format!("%,{},%", escape_like(&t))));
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let sql = format!(
            "SELECT p.id, p.title, p.prompt, p.negative_prompt, p.tags, p.notes, \
                    p.source_image_id, p.use_count, p.created_at, p.updated_at \
             FROM prompt_library p {join} {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
        );
        args.push(Value::Integer(limit));
        args.push(Value::Integer(offset as i64));
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args.iter()), row_to_entry)?;
        rows.collect()
    }

    /// All distinct tags with counts, most used first.
    pub fn list_prompt_tags(&self) -> SqlResult<Vec<(String, i64)>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt = conn.prepare("SELECT tags FROM prompt_library WHERE tags != ''")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut counts = std::collections::HashMap::<String, i64>::new();
        for row in rows {
            for t in row?.split(',').filter(|t| !t.is_empty()) {
                *counts.entry(t.to_string()).or_insert(0) += 1;
            }
        }
        let mut out: Vec<_> = counts.into_iter().collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        Ok(out)
    }

    /// Replaces an entry's editable fields. Fails if the new text duplicates another entry.
    pub fn update_prompt(
        &self,
        id: i64,
        title: Option<&str>,
        prompt: &str,
        negative: &str,
        tags: &str,
        notes: &str,
    ) -> SqlResult<PromptEntry> {
        if prompt.trim().is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "prompt must not be empty".to_string(),
            ));
        }
        let conn = self.pool.get().map_err(pool_error)?;
        let hash = prompt_content_hash(prompt, negative);
        let clash: Option<i64> = conn
            .query_row(
                "SELECT id FROM prompt_library WHERE content_hash = ?1 AND id != ?2",
                params![hash, id],
                |r| r.get(0),
            )
            .ok();
        if clash.is_some() {
            return Err(rusqlite::Error::InvalidParameterName(
                "another library entry already has this prompt".to_string(),
            ));
        }
        let changed = conn.execute(
            "UPDATE prompt_library SET title=?1, prompt=?2, negative_prompt=?3, tags=?4,
                    notes=?5, content_hash=?6, updated_at=strftime('%s','now')
             WHERE id=?7",
            params![
                clamp_title(title, prompt),
                prompt.trim(),
                negative.trim(),
                normalize_tags(tags),
                notes.trim(),
                hash,
                id
            ],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        get_entry(&conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn delete_prompt(&self, id: i64) -> SqlResult<bool> {
        let conn = self.pool.get().map_err(pool_error)?;
        Ok(conn.execute("DELETE FROM prompt_library WHERE id = ?1", params![id])? > 0)
    }

    /// Records that an entry was applied. Does not touch `updated_at` (keeps list order stable).
    pub fn mark_prompt_used(&self, id: i64) -> SqlResult<()> {
        let conn = self.pool.get().map_err(pool_error)?;
        conn.execute(
            "UPDATE prompt_library SET use_count = use_count + 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn export_prompts(&self) -> SqlResult<Vec<PromptEntry>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let sql = format!("SELECT {SELECT_COLS} FROM prompt_library ORDER BY id ASC");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_entry)?;
        rows.collect()
    }

    /// Imports entries in one transaction. Duplicates (by content hash) are skipped (their
    /// `updated_at` is bumped, nothing else changes); ids, counters and `source_image_id` from the file are ignored on purpose
    /// (they refer to another machine's database).
    pub fn import_prompts(&self, entries: &[PromptEntry]) -> SqlResult<ImportPromptsResult> {
        let mut conn = self.pool.get().map_err(pool_error)?;
        let tx = conn.transaction()?;
        let mut result = ImportPromptsResult {
            inserted: 0,
            skipped_duplicates: 0,
            skipped_invalid: 0,
        };
        for e in entries.iter().take(PROMPT_LIBRARY_MAX_ENTRIES_PER_IMPORT) {
            if e.prompt.trim().is_empty() {
                result.skipped_invalid += 1;
                continue;
            }
            let (_, created) = save_in(
                &tx,
                Some(&e.title),
                &e.prompt,
                &e.negative_prompt,
                &e.tags,
                &e.notes,
                None,
            )?;
            if created {
                result.inserted += 1;
            } else {
                result.skipped_duplicates += 1;
            }
        }
        if entries.len() > PROMPT_LIBRARY_MAX_ENTRIES_PER_IMPORT {
            result.skipped_invalid += entries.len() - PROMPT_LIBRARY_MAX_ENTRIES_PER_IMPORT;
        }
        tx.commit()?;
        Ok(result)
    }
}
