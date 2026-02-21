use crate::{
    parser::{infer_generation_type, GenerationParams},
    StorageProfile,
};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, params_from_iter, types::Value, Connection, Result as SqlResult, Row};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Thread-safe database wrapper backed by an r2d2 connection pool.
#[derive(Clone)]
pub struct Database {
    pool: Pool<SqliteConnectionManager>,
}

fn pool_error<E>(err: E) -> rusqlite::Error
where
    E: std::error::Error + Send + Sync + 'static,
{
    rusqlite::Error::ToSqlConversionFailure(Box::new(err))
}

const HDD_FRIENDLY_DB_POOL_SIZE: u32 = 4;
const SSD_FRIENDLY_DB_POOL_SIZE: u32 = 12;

fn db_pool_size(profile: StorageProfile) -> u32 {
    if let Ok(raw) = std::env::var("FORGE_DB_POOL_SIZE") {
        if let Ok(parsed) = raw.parse::<u32>() {
            return parsed.clamp(1, 32);
        }
    }

    let cpu_count = std::thread::available_parallelism()
        .map(|count| count.get() as u32)
        .unwrap_or(4);
    match profile {
        StorageProfile::Hdd => cpu_count.clamp(2, HDD_FRIENDLY_DB_POOL_SIZE),
        StorageProfile::Ssd => cpu_count.clamp(4, SSD_FRIENDLY_DB_POOL_SIZE),
    }
}

fn apply_connection_pragmas(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys=ON;
         PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA cache_size=-262144;
         PRAGMA mmap_size=1073741824;
         PRAGMA temp_store=MEMORY;
         PRAGMA busy_timeout=5000;
         PRAGMA wal_autocheckpoint=4000;
         PRAGMA journal_size_limit=134217728;",
    )?;
    Ok(())
}

/// Lightweight row used by gallery and infinite-scroll views.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GalleryImageRecord {
    pub id: i64,
    pub filepath: String,
    pub filename: String,
    pub directory: String,
    pub seed: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub model_name: Option<String>,
    pub is_favorite: bool,
    pub is_locked: bool,
}

/// Full row used by detail/export workflows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageRecord {
    pub id: i64,
    pub filepath: String,
    pub filename: String,
    pub directory: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub steps: Option<String>,
    pub sampler: Option<String>,
    pub cfg_scale: Option<String>,
    pub seed: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub model_hash: Option<String>,
    pub model_name: Option<String>,
    pub raw_metadata: String,
    pub is_favorite: bool,
    pub is_locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

/// A page of results with an opaque cursor for keyset pagination.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorPage {
    pub items: Vec<GalleryImageRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct CursorQueryOptions<'a> {
    pub cursor: Option<&'a str>,
    pub limit: u32,
    pub sort_by: Option<&'a str>,
    pub generation_types: Option<&'a [String]>,
    pub model_filter: Option<&'a str>,
    pub model_family_filters: Option<&'a [String]>,
}

#[derive(Debug, Clone, Copy)]
pub struct SearchCursorParams<'a> {
    pub query: &'a str,
    pub options: CursorQueryOptions<'a>,
}

#[derive(Debug, Clone, Copy)]
pub struct FilterCursorParams<'a> {
    pub query: Option<&'a str>,
    pub include_tags: &'a [String],
    pub exclude_tags: &'a [String],
    pub options: CursorQueryOptions<'a>,
}

/// Directory entry with image count for grouping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryEntry {
    pub directory: String,
    pub count: u32,
}

/// Model entry with image count for grouping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub model_name: String,
    pub count: u32,
}

/// Record for bulk insert operations.
pub struct BulkRecord {
    pub filepath: String,
    pub filename: String,
    pub directory: String,
    pub params: GenerationParams,
    pub file_mtime: Option<i64>,
    pub file_size: Option<i64>,
    pub quick_hash: Option<String>,
    pub tags: Vec<String>,
}

impl Database {
    /// Opens or creates the SQLite database at the given path using a connection pool.
    pub fn new(db_path: &Path, storage_profile: StorageProfile) -> SqlResult<Self> {
        let manager =
            SqliteConnectionManager::file(db_path).with_init(|conn| apply_connection_pragmas(conn));
        let pool = Pool::builder()
            .max_size(db_pool_size(storage_profile))
            .build(manager)
            .map_err(pool_error)?;

        let db = Database { pool };
        db.init_schema()?;
        Ok(db)
    }

    /// Initializes schema, indexes, and compatibility migrations.
    fn init_schema(&self) -> SqlResult<()> {
        let conn = self.pool.get().map_err(pool_error)?;
        apply_connection_pragmas(&conn)?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filepath TEXT UNIQUE NOT NULL,
                filename TEXT NOT NULL,
                directory TEXT NOT NULL,
                prompt TEXT NOT NULL DEFAULT '',
                negative_prompt TEXT NOT NULL DEFAULT '',
                steps TEXT,
                sampler TEXT,
                schedule_type TEXT,
                cfg_scale TEXT,
                seed TEXT,
                width INTEGER,
                height INTEGER,
                model_hash TEXT,
                model_name TEXT,
                generation_type TEXT,
                raw_metadata TEXT NOT NULL DEFAULT '',
                extra_params TEXT,
                file_mtime INTEGER,
                file_size INTEGER,
                quick_hash TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );",
        )?;
        Self::ensure_optional_columns(&conn)?;
        Self::backfill_generation_types(&conn)?;

        // ── Porter FTS (ranked word-boundary search) ──
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
                prompt,
                negative_prompt,
                raw_metadata,
                model_name,
                content='images',
                content_rowid='id',
                tokenize='porter unicode61'
            );",
        )?;

        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS images_ai AFTER INSERT ON images BEGIN
                INSERT INTO images_fts(rowid, prompt, negative_prompt, raw_metadata, model_name)
                VALUES (new.id, new.prompt, new.negative_prompt, new.raw_metadata, new.model_name);
            END;",
        )?;
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS images_ad AFTER DELETE ON images BEGIN
                INSERT INTO images_fts(images_fts, rowid, prompt, negative_prompt, raw_metadata, model_name)
                VALUES ('delete', old.id, old.prompt, old.negative_prompt, old.raw_metadata, old.model_name);
            END;",
        )?;
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS images_au AFTER UPDATE ON images BEGIN
                INSERT INTO images_fts(images_fts, rowid, prompt, negative_prompt, raw_metadata, model_name)
                VALUES ('delete', old.id, old.prompt, old.negative_prompt, old.raw_metadata, old.model_name);
                INSERT INTO images_fts(rowid, prompt, negative_prompt, raw_metadata, model_name)
                VALUES (new.id, new.prompt, new.negative_prompt, new.raw_metadata, new.model_name);
            END;",
        )?;

        // ── Trigram FTS (infix substring search) ──
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS images_fts_tri USING fts5(
                prompt,
                negative_prompt,
                raw_metadata,
                model_name,
                content='images',
                content_rowid='id',
                tokenize='trigram'
            );",
        )?;

        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS images_ai_tri AFTER INSERT ON images BEGIN
                INSERT INTO images_fts_tri(rowid, prompt, negative_prompt, raw_metadata, model_name)
                VALUES (new.id, new.prompt, new.negative_prompt, new.raw_metadata, new.model_name);
            END;",
        )?;
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS images_ad_tri AFTER DELETE ON images BEGIN
                INSERT INTO images_fts_tri(images_fts_tri, rowid, prompt, negative_prompt, raw_metadata, model_name)
                VALUES ('delete', old.id, old.prompt, old.negative_prompt, old.raw_metadata, old.model_name);
            END;",
        )?;
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS images_au_tri AFTER UPDATE ON images BEGIN
                INSERT INTO images_fts_tri(images_fts_tri, rowid, prompt, negative_prompt, raw_metadata, model_name)
                VALUES ('delete', old.id, old.prompt, old.negative_prompt, old.raw_metadata, old.model_name);
                INSERT INTO images_fts_tri(rowid, prompt, negative_prompt, raw_metadata, model_name)
                VALUES (new.id, new.prompt, new.negative_prompt, new.raw_metadata, new.model_name);
            END;",
        )?;

        // Backfill trigram FTS for any existing rows not yet indexed.
        conn.execute_batch(
            "INSERT OR IGNORE INTO images_fts_tri(rowid, prompt, negative_prompt, raw_metadata, model_name)
             SELECT id, prompt, negative_prompt, raw_metadata, model_name FROM images
             WHERE id NOT IN (SELECT rowid FROM images_fts_tri);",
        )?;

        // ── Tags ──
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tag TEXT UNIQUE NOT NULL
            );",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS image_tags (
                image_id INTEGER NOT NULL,
                tag_id INTEGER NOT NULL,
                PRIMARY KEY (image_id, tag_id),
                FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE,
                FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
            );",
        )?;

        // ── Indexes ──
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_images_seed ON images(seed);")?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_images_sampler ON images(sampler);")?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_images_model_hash ON images(model_hash);",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_images_directory ON images(directory);",
        )?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);")?;
        conn.execute_batch("DROP INDEX IF EXISTS idx_image_tags_tag_id;")?;
        conn.execute_batch("DROP INDEX IF EXISTS idx_images_model_name;")?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_images_filename ON images(filename);")?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_images_file_mtime ON images(file_mtime);",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_images_file_size ON images(file_size);",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_images_quick_hash ON images(quick_hash);",
        )?;
        conn.execute_batch("DROP INDEX IF EXISTS idx_images_generation_type;")?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_image_tags_tag_id_image_id ON image_tags(tag_id, image_id);",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_images_model_name_nocase_id ON images(model_name COLLATE NOCASE, id DESC);",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_images_generation_type_id ON images(generation_type, id DESC);",
        )?;

        Ok(())
    }

    fn ensure_optional_columns(conn: &Connection) -> SqlResult<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(images)")?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;

        let mut existing_columns = HashSet::new();
        for column in columns {
            existing_columns.insert(column?);
        }

        for (name, sql_type) in [
            ("file_mtime", "INTEGER"),
            ("file_size", "INTEGER"),
            ("quick_hash", "TEXT"),
            ("generation_type", "TEXT"),
            ("is_favorite", "INTEGER NOT NULL DEFAULT 0"),
            ("is_locked", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            if existing_columns.contains(name) {
                continue;
            }

            if let Err(err) = conn.execute_batch(&format!(
                "ALTER TABLE images ADD COLUMN {} {};",
                name, sql_type
            )) {
                let err_text = err.to_string().to_lowercase();
                if !err_text.contains("duplicate column") {
                    return Err(err);
                }
            }
        }

        Ok(())
    }

    fn backfill_generation_types(conn: &Connection) -> SqlResult<()> {
        let mut select_stmt = conn.prepare(
            "SELECT id, raw_metadata
             FROM images
             WHERE generation_type IS NULL OR TRIM(generation_type) = ''",
        )?;
        let rows = select_stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut updates = Vec::<(i64, String)>::new();
        for row in rows {
            let (id, raw_metadata) = row?;
            updates.push((id, infer_generation_type(&raw_metadata)));
        }

        if updates.is_empty() {
            return Ok(());
        }

        let mut update_stmt =
            conn.prepare("UPDATE images SET generation_type = ?1 WHERE id = ?2")?;
        for (id, generation_type) in updates {
            update_stmt.execute(params![generation_type, id])?;
        }
        Ok(())
    }
}

mod bulk_operations;
mod cursor_queries;
mod read_queries;

// ────────────────────── Sort configuration ──────────────────────

struct SortConfig {
    descending: bool,
    field: &'static str,
}

impl SortConfig {
    fn from_str(sort_by: &str) -> Self {
        match sort_by {
            "oldest" => SortConfig {
                field: "id",
                descending: false,
            },
            "name_asc" => SortConfig {
                field: "filename",
                descending: false,
            },
            "name_desc" => SortConfig {
                field: "filename",
                descending: true,
            },
            "model" => SortConfig {
                field: "model_name",
                descending: false,
            },
            "generation_type" => SortConfig {
                field: "generation_type",
                descending: false,
            },
            _ => SortConfig {
                field: "id",
                descending: true,
            }, // "newest" default
        }
    }

    fn order_clause(&self) -> String {
        let dir = if self.descending { "DESC" } else { "ASC" };
        if self.field == "id" {
            format!("id {}", dir)
        } else {
            format!("{} {}, id {}", self.sort_expr(), dir, dir)
        }
    }

    fn cursor_op(&self) -> &'static str {
        if self.descending {
            "<"
        } else {
            ">"
        }
    }

    fn sort_expr(&self) -> String {
        if self.field == "id" {
            return "id".to_string();
        }

        let null_sentinel = if self.descending { "" } else { "~" };
        format!("COALESCE({}, '{}')", self.field, null_sentinel)
    }
}

fn image_record_from_row(row: &Row<'_>) -> SqlResult<ImageRecord> {
    Ok(ImageRecord {
        id: row.get(0)?,
        filepath: row.get(1)?,
        filename: row.get(2)?,
        directory: row.get(3)?,
        prompt: row.get(4)?,
        negative_prompt: row.get(5)?,
        steps: row.get(6)?,
        sampler: row.get(7)?,
        cfg_scale: row.get(8)?,
        seed: row.get(9)?,
        width: row.get(10)?,
        height: row.get(11)?,
        model_hash: row.get(12)?,
        model_name: row.get(13)?,
        raw_metadata: row.get(14)?,
        is_favorite: row.get(15)?,
        is_locked: row.get(16)?,
    })
}

fn gallery_image_record_from_row(row: &Row<'_>) -> SqlResult<GalleryImageRecord> {
    Ok(GalleryImageRecord {
        id: row.get(0)?,
        filepath: row.get(1)?,
        filename: row.get(2)?,
        directory: row.get(3)?,
        seed: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        model_name: row.get(7)?,
        is_favorite: row.get(8)?,
        is_locked: row.get(9)?,
    })
}

fn normalize_generation_type(value: &str) -> Option<&'static str> {
    let lowered = value.trim().to_ascii_lowercase();
    match lowered.as_str() {
        "txt2img" | "txt2image" => Some("txt2img"),
        "img2img" | "image2image" => Some("img2img"),
        "inpaint" | "inpainting" => Some("inpaint"),
        "grid" | "grids" => Some("grid"),
        "upscale" | "extras" => Some("upscale"),
        "unknown" => Some("unknown"),
        _ => None,
    }
}

fn normalize_generation_types(generation_types: Option<&[String]>) -> Vec<String> {
    let Some(values) = generation_types else {
        return Vec::new();
    };

    let mut seen = HashSet::<String>::new();
    let mut normalized = Vec::new();
    for value in values {
        if let Some(canonical) = normalize_generation_type(value) {
            let canonical_owned = canonical.to_string();
            if seen.insert(canonical_owned.clone()) {
                normalized.push(canonical_owned);
            }
        }
    }
    normalized
}

fn append_generation_type_filter(
    sql: &mut String,
    params: &mut Vec<Value>,
    generation_types: &[String],
) {
    if generation_types.is_empty() {
        return;
    }

    sql.push_str(" AND (");
    for (index, generation_type) in generation_types.iter().enumerate() {
        if index > 0 {
            sql.push_str(" OR ");
        }

        if generation_type == "grid" {
            // Some Forge/A1111 grid outputs are stored under *-grids folders and can be
            // misclassified in older scans. Keep grid filtering reliable by including
            // path/filename/metadata fallbacks.
            sql.push_str(
                "(images.generation_type = ?
                  OR LOWER(images.directory) LIKE ?
                  OR LOWER(images.directory) LIKE ?
                  OR LOWER(images.directory) LIKE ?
                  OR LOWER(images.directory) LIKE ?
                  OR LOWER(images.filename) LIKE ?
                  OR LOWER(images.filename) LIKE ?
                  OR LOWER(images.raw_metadata) LIKE ?
                  OR LOWER(images.raw_metadata) LIKE ?
                  OR LOWER(images.raw_metadata) LIKE ?
                  OR LOWER(images.raw_metadata) LIKE ?)",
            );
            params.push(Value::Text("grid".to_string()));
            params.push(Value::Text("%txt2img-grids%".to_string()));
            params.push(Value::Text("%img2img-grids%".to_string()));
            params.push(Value::Text("%/grids/%".to_string()));
            params.push(Value::Text("%\\grids\\%".to_string()));
            params.push(Value::Text("grid-%".to_string()));
            params.push(Value::Text("%_grid-%".to_string()));
            params.push(Value::Text("%script: x/y/z plot%".to_string()));
            params.push(Value::Text("%script: xyz plot%".to_string()));
            params.push(Value::Text("%x values:%".to_string()));
            params.push(Value::Text("%y values:%".to_string()));
        } else {
            sql.push_str("images.generation_type = ?");
            params.push(Value::Text(generation_type.clone()));
        }
    }
    sql.push(')');
}

fn append_model_filter(
    sql: &mut String,
    params: &mut Vec<Value>,
    model_filter: Option<&str>,
    table_prefix: Option<&str>,
) {
    let Some(raw_model_filter) = model_filter else {
        return;
    };
    let normalized = raw_model_filter.trim();
    if normalized.is_empty() {
        return;
    }

    if let Some(prefix) = table_prefix {
        sql.push_str(&format!(" AND {}.model_name = ? COLLATE NOCASE", prefix));
    } else {
        sql.push_str(" AND model_name = ? COLLATE NOCASE");
    }
    params.push(Value::Text(normalized.to_string()));
}

const FAMILY_PATTERNS_PONYXL: &[&str] = &["%ponyxl%", "%pony xl%", "%pony diffusion%", "%pony%"];
const FAMILY_PATTERNS_SDXL: &[&str] = &["%sdxl%", "%stable diffusion xl%"];
const FAMILY_PATTERNS_FLUX: &[&str] = &["%flux%"];
const FAMILY_PATTERNS_ZIMAGE_TURBO: &[&str] =
    &["%z-image turbo%", "%zimage turbo%", "%z-image%", "%zimage%"];
const FAMILY_PATTERNS_SD15: &[&str] = &["%sd1.5%", "%sd15%", "%stable diffusion 1.5%"];
const FAMILY_PATTERNS_SD21: &[&str] = &["%sd2.1%", "%sd21%", "%stable diffusion 2.1%"];
const FAMILY_PATTERNS_CHROMA: &[&str] = &["%chroma%"];
const FAMILY_PATTERNS_VACE: &[&str] = &["%vace%"];

fn normalize_model_family(value: &str) -> Option<&'static str> {
    let compact: String = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();

    match compact.as_str() {
        "pony" | "ponyxl" => Some("ponyxl"),
        "sdxl" => Some("sdxl"),
        "flux" => Some("flux"),
        "zimage" | "zimageturbo" => Some("zimage_turbo"),
        "sd15" | "stablediffusion15" | "sdv15" => Some("sd15"),
        "sd21" | "stablediffusion21" | "sdv21" => Some("sd21"),
        "chroma" => Some("chroma"),
        "vace" => Some("vace"),
        _ => None,
    }
}

fn normalize_model_family_filters(model_family_filters: Option<&[String]>) -> Vec<String> {
    let Some(filters) = model_family_filters else {
        return Vec::new();
    };

    let mut seen = HashSet::<String>::new();
    let mut normalized = Vec::new();
    for filter in filters {
        let Some(canonical) = normalize_model_family(filter) else {
            continue;
        };
        let owned = canonical.to_string();
        if seen.insert(owned.clone()) {
            normalized.push(owned);
        }
    }
    normalized
}

fn family_patterns(family: &str) -> &'static [&'static str] {
    match family {
        "ponyxl" => FAMILY_PATTERNS_PONYXL,
        "sdxl" => FAMILY_PATTERNS_SDXL,
        "flux" => FAMILY_PATTERNS_FLUX,
        "zimage_turbo" => FAMILY_PATTERNS_ZIMAGE_TURBO,
        "sd15" => FAMILY_PATTERNS_SD15,
        "sd21" => FAMILY_PATTERNS_SD21,
        "chroma" => FAMILY_PATTERNS_CHROMA,
        "vace" => FAMILY_PATTERNS_VACE,
        _ => &[],
    }
}

fn append_model_family_filter(
    sql: &mut String,
    params: &mut Vec<Value>,
    model_family_filters: &[String],
    table_prefix: Option<&str>,
) {
    if model_family_filters.is_empty() {
        return;
    }

    let column = if let Some(prefix) = table_prefix {
        format!("LOWER({}.model_name)", prefix)
    } else {
        "LOWER(model_name)".to_string()
    };

    let groups: Vec<&[&str]> = model_family_filters
        .iter()
        .map(|family| family_patterns(family))
        .filter(|patterns| !patterns.is_empty())
        .collect();
    if groups.is_empty() {
        return;
    }

    sql.push_str(" AND (");
    for (group_idx, group_patterns) in groups.iter().enumerate() {
        if group_idx > 0 {
            sql.push_str(" OR ");
        }
        sql.push('(');
        for (pattern_idx, pattern) in group_patterns.iter().enumerate() {
            if pattern_idx > 0 {
                sql.push_str(" OR ");
            }
            sql.push_str(&column);
            sql.push_str(" LIKE ?");
            params.push(Value::Text((*pattern).to_string()));
        }
        sql.push(')');
    }
    sql.push(')');
}

/// Sanitizes a user query for FTS5 MATCH syntax with advanced features:
/// - `"exact phrase"` -> kept as FTS5 phrase query
/// - `word` -> `word*` (prefix matching)
/// - `word*` -> preserved as explicit prefix wildcard
/// - Multiple terms are ANDed together
fn sanitize_fts_query(query: &str) -> String {
    let mut parts = Vec::new();
    let mut remaining = query.trim();

    // Extract quoted phrases first
    loop {
        if let Some(start) = remaining.find('"') {
            // Process text before the quote as regular words
            let before = &remaining[..start];
            process_unquoted_words(before, &mut parts);

            // Find the closing quote
            if let Some(end) = remaining[start + 1..].find('"') {
                let phrase = &remaining[start + 1..start + 1 + end];
                let cleaned: String = phrase
                    .chars()
                    .filter(|ch| ch.is_alphanumeric() || ch.is_whitespace() || *ch == '_')
                    .collect();
                let trimmed: Vec<&str> = cleaned.split_whitespace().collect();
                let joined = trimmed.join(" ");
                if !joined.is_empty() {
                    parts.push(format!("\"{}\"", joined.to_lowercase()));
                }
                remaining = &remaining[start + 1 + end + 1..];
            } else {
                // Unmatched quote -- treat rest as regular text
                remaining = &remaining[start + 1..];
            }
        } else {
            // No more quotes
            process_unquoted_words(remaining, &mut parts);
            break;
        }
    }

    parts.join(" ")
}

fn process_unquoted_words(text: &str, parts: &mut Vec<String>) {
    for word in text.split_whitespace() {
        let has_wildcard = word.contains('*');
        let cleaned: String = word
            .chars()
            .filter(|ch| ch.is_alphanumeric() || *ch == '_' || *ch == '*')
            .collect();

        if cleaned.is_empty() || cleaned == "*" {
            continue;
        }

        if has_wildcard {
            // Preserve explicit wildcard position
            parts.push(cleaned.to_lowercase());
        } else {
            parts.push(format!("{}*", cleaned.to_lowercase()));
        }
    }
}

fn contains_search_token(text: &str) -> bool {
    text.chars().any(|ch| ch.is_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_with_prompt(db: &Database, filepath: &str, prompt: &str, tags: &[&str]) {
        let params = GenerationParams {
            prompt: prompt.to_string(),
            raw_metadata: prompt.to_string(),
            ..Default::default()
        };

        let image_id = db
            .upsert_image(filepath, filepath, "c:\\images", &params, Some(1))
            .expect("failed to insert image");

        let normalized_tags: Vec<String> = tags.iter().map(|tag| tag.to_string()).collect();
        db.replace_image_tags(image_id, &normalized_tags)
            .expect("failed to insert tags");
    }

    #[test]
    fn test_sanitize_fts_query_builds_safe_prefix_terms() {
        let query = r#" Model:XL cat++ seed:123 "#;
        let sanitized = sanitize_fts_query(query);
        assert_eq!(sanitized, "modelxl* cat* seed123*");
    }

    #[test]
    fn test_sanitize_fts_query_all_special_chars_is_empty() {
        let query = r#" ::: ??? +++  "#;
        let sanitized = sanitize_fts_query(query);
        assert!(sanitized.is_empty());
    }

    #[test]
    fn test_sanitize_fts_query_quoted_phrase() {
        let query = r#""best quality" cat"#;
        let sanitized = sanitize_fts_query(query);
        assert_eq!(sanitized, r#""best quality" cat*"#);
    }

    #[test]
    fn test_sanitize_fts_query_wildcard_preserved() {
        let query = "cat* dog";
        let sanitized = sanitize_fts_query(query);
        assert_eq!(sanitized, "cat* dog*");
    }

    #[test]
    fn test_search_uses_prefix_query_and_returns_expected_best_match() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");
        insert_with_prompt(&db, "a.png", "cat hero portrait", &["cat", "hero"]);
        insert_with_prompt(&db, "b.png", "cat landscape", &["cat", "landscape"]);

        let page = db
            .search_cursor(SearchCursorParams {
                query: "cat hero",
                options: CursorQueryOptions {
                    cursor: None,
                    limit: 10,
                    sort_by: None,
                    generation_types: None,
                    model_filter: None,
                    model_family_filters: None,
                },
            })
            .expect("search failed");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].filepath, "a.png");
    }

    #[test]
    fn test_filter_images_by_include_and_exclude_tags() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");
        insert_with_prompt(&db, "a.png", "cat hero portrait", &["cat", "hero"]);
        insert_with_prompt(&db, "b.png", "cat landscape", &["cat", "landscape"]);

        let include = vec!["cat".to_string()];
        let exclude = vec!["landscape".to_string()];
        let page = db
            .filter_images_cursor(FilterCursorParams {
                query: None,
                include_tags: &include,
                exclude_tags: &exclude,
                options: CursorQueryOptions {
                    cursor: None,
                    limit: 10,
                    sort_by: None,
                    generation_types: None,
                    model_filter: None,
                    model_family_filters: None,
                },
            })
            .expect("filter failed");

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].filepath, "a.png");
    }

    #[test]
    fn test_cursor_pagination_returns_correct_pages() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");
        insert_with_prompt(&db, "a.png", "first", &[]);
        insert_with_prompt(&db, "b.png", "second", &[]);
        insert_with_prompt(&db, "c.png", "third", &[]);

        let page1 = db
            .get_images_cursor(None, 2, None, None, None, None)
            .expect("cursor query failed");
        assert_eq!(page1.items.len(), 2);
        assert!(page1.next_cursor.is_some());

        let page2 = db
            .get_images_cursor(page1.next_cursor.as_deref(), 2, None, None, None, None)
            .expect("cursor query failed");
        assert_eq!(page2.items.len(), 1);
    }

    #[test]
    fn test_trigram_search_finds_substring() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");
        insert_with_prompt(&db, "a.png", "concatenation is fun", &[]);
        insert_with_prompt(&db, "b.png", "hello world", &[]);

        let page = db
            .search_cursor(SearchCursorParams {
                query: "cat",
                options: CursorQueryOptions {
                    cursor: None,
                    limit: 10,
                    sort_by: None,
                    generation_types: None,
                    model_filter: None,
                    model_family_filters: None,
                },
            })
            .expect("trigram search failed");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].filepath, "a.png");
    }

    #[test]
    fn test_filter_images_falls_back_to_trigram_for_substring_queries() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");
        insert_with_prompt(&db, "a.png", "donald trump portrait", &["portrait"]);
        insert_with_prompt(&db, "b.png", "landscape painting", &["landscape"]);

        let include = vec!["portrait".to_string()];
        let page = db
            .filter_images_cursor(FilterCursorParams {
                query: Some("ump"),
                include_tags: &include,
                exclude_tags: &[],
                options: CursorQueryOptions {
                    cursor: None,
                    limit: 10,
                    sort_by: None,
                    generation_types: None,
                    model_filter: None,
                    model_family_filters: None,
                },
            })
            .expect("filter failed");

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].filepath, "a.png");
    }

    #[test]
    fn test_grid_filter_matches_txt2img_grids_directory_fallback() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");

        let grid_path =
            "E:\\1AHOLD\\webui_forge_cu121_torch231\\webui\\outputs\\txt2img-grids\\2025-09-16\\grid-0001.png";
        let normal_path =
            "E:\\1AHOLD\\webui_forge_cu121_torch231\\webui\\outputs\\txt2img-images\\2025-09-16\\0001.png";

        let grid_params = GenerationParams {
            prompt: "test grid image".to_string(),
            raw_metadata: "test grid image".to_string(),
            ..Default::default()
        };
        let normal_params = GenerationParams {
            prompt: "test normal image".to_string(),
            raw_metadata: "test normal image".to_string(),
            ..Default::default()
        };

        db.upsert_image(
            grid_path,
            "grid-0001.png",
            "E:\\1AHOLD\\webui_forge_cu121_torch231\\webui\\outputs\\txt2img-grids\\2025-09-16",
            &grid_params,
            Some(1),
        )
        .expect("failed to insert grid image");
        db.upsert_image(
            normal_path,
            "0001.png",
            "E:\\1AHOLD\\webui_forge_cu121_torch231\\webui\\outputs\\txt2img-images\\2025-09-16",
            &normal_params,
            Some(1),
        )
        .expect("failed to insert non-grid image");

        let page = db
            .get_images_cursor(None, 50, None, Some(&["grid".to_string()]), None, None)
            .expect("grid cursor query failed");

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].filepath, grid_path);
    }

    #[test]
    fn test_bulk_upsert_with_tags() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");

        let records = vec![
            BulkRecord {
                filepath: "a.png".to_string(),
                filename: "a.png".to_string(),
                directory: "c:\\images".to_string(),
                params: GenerationParams {
                    prompt: "cat portrait".to_string(),
                    raw_metadata: "cat portrait".to_string(),
                    ..Default::default()
                },
                file_mtime: Some(100),
                file_size: Some(1000),
                quick_hash: Some("aaaabbbbccccdddd11112222".to_string()),
                tags: vec!["cat".to_string(), "portrait".to_string()],
            },
            BulkRecord {
                filepath: "b.png".to_string(),
                filename: "b.png".to_string(),
                directory: "c:\\images".to_string(),
                params: GenerationParams {
                    prompt: "dog landscape".to_string(),
                    raw_metadata: "dog landscape".to_string(),
                    ..Default::default()
                },
                file_mtime: Some(200),
                file_size: Some(2000),
                quick_hash: Some("eeeeffff0000111122223333".to_string()),
                tags: vec!["dog".to_string(), "landscape".to_string()],
            },
        ];

        let count = db
            .bulk_upsert_with_tags(&records)
            .expect("bulk upsert failed");
        assert_eq!(count, 2);
        assert_eq!(db.get_total_count().unwrap(), 2);
    }

    #[test]
    fn test_get_all_file_mtimes() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");
        insert_with_prompt(&db, "a.png", "test", &[]);
        insert_with_prompt(&db, "b.png", "test", &[]);

        let mtimes = db
            .get_all_file_mtimes()
            .expect("get_all_file_mtimes failed");
        assert_eq!(mtimes.len(), 2);
        assert_eq!(mtimes.get("a.png"), Some(&1));
        assert_eq!(mtimes.get("b.png"), Some(&1));
    }

    fn explain_details(
        conn: &Connection,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .expect("failed to prepare explain query");
        let rows = stmt
            .query_map(params, |row| row.get::<_, String>(3))
            .expect("failed to execute explain query");

        let mut details = Vec::new();
        for row in rows {
            details.push(row.expect("failed to decode explain row"));
        }
        details
    }

    #[test]
    fn test_hot_query_plans_use_expected_indexes() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");
        insert_with_prompt(&db, "a.png", "cat hero portrait", &["cat", "hero"]);
        insert_with_prompt(&db, "b.png", "cat landscape", &["cat", "landscape"]);

        let conn = db.pool.get().expect("failed to get db connection");

        let generation_plan = explain_details(
            &conn,
            "SELECT id FROM images WHERE generation_type = ?1 ORDER BY id DESC LIMIT 20",
            &[&"unknown"],
        );
        println!("generation_plan={generation_plan:?}");
        assert!(
            generation_plan
                .iter()
                .any(|detail| detail.contains("idx_images_generation_type_id")),
            "expected generation_type query to use idx_images_generation_type_id, got {generation_plan:?}"
        );

        let model_plan = explain_details(
            &conn,
            "SELECT id FROM images WHERE model_name = ?1 COLLATE NOCASE ORDER BY id DESC LIMIT 20",
            &[&"unknown"],
        );
        println!("model_plan={model_plan:?}");
        assert!(
            model_plan
                .iter()
                .any(|detail| detail.contains("idx_images_model_name_nocase_id")),
            "expected model_name query to use idx_images_model_name_nocase_id, got {model_plan:?}"
        );

        let top_tags_plan = explain_details(
            &conn,
            "SELECT tags.tag, COUNT(*) as usage_count
             FROM tags
             JOIN image_tags ON image_tags.tag_id = tags.id
             GROUP BY tags.id, tags.tag
             ORDER BY usage_count DESC, tags.tag ASC
             LIMIT 50",
            &[],
        );
        println!("top_tags_plan={top_tags_plan:?}");
        assert!(
            top_tags_plan
                .iter()
                .any(|detail| detail.contains("idx_image_tags_tag_id_image_id")),
            "expected top-tags query to use idx_image_tags_tag_id_image_id, got {top_tags_plan:?}"
        );
    }
}
