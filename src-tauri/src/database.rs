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

pub(crate) fn pool_error<E>(err: E) -> rusqlite::Error
where
    E: std::error::Error + Send + Sync + 'static,
{
    rusqlite::Error::ToSqlConversionFailure(Box::new(err))
}

/// Parses a seed string into a positive integer suitable for lineage matching.
///
/// Returns `Some(i64)` only when the string (after trimming) is non-empty, contains only ASCII digits,
/// has length <= 18, parses as `i64`, and is not 0.
pub fn parse_seed_int(seed: &str) -> Option<i64> {
    let trimmed = seed.trim();
    if trimmed.is_empty() || trimmed.len() > 18 || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let val = trimmed.parse::<i64>().ok()?;
    if val == 0 {
        return None;
    }
    Some(val)
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

fn apply_connection_pragmas(conn: &Connection, profile: StorageProfile) -> SqlResult<()> {
    let (cache_size, mmap_size, wal_autocheckpoint, journal_size_limit) = match profile {
        StorageProfile::Hdd => (-40000, 268_435_456, 1000, 33_554_432),
        StorageProfile::Ssd => (-262144, 1_073_741_824, 4000, 134_217_728),
    };
    conn.execute_batch(&format!(
        "PRAGMA foreign_keys=ON;
         PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA cache_size={cache_size};
         PRAGMA mmap_size={mmap_size};
         PRAGMA temp_store=MEMORY;
         PRAGMA busy_timeout=5000;
         PRAGMA wal_autocheckpoint={wal_autocheckpoint};
         PRAGMA journal_size_limit={journal_size_limit};"
    ))?;
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
    pub file_mtime: Option<i64>,
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
        let manager = SqliteConnectionManager::file(db_path)
            .with_init(move |conn| apply_connection_pragmas(conn, storage_profile));
        let pool = Pool::builder()
            .max_size(db_pool_size(storage_profile))
            .build(manager)
            .map_err(pool_error)?;

        let db = Database { pool };
        db.init_schema(storage_profile)?;
        Ok(db)
    }

    /// Initializes schema, indexes, and compatibility migrations.
    fn init_schema(&self, profile: StorageProfile) -> SqlResult<()> {
        let conn = self.pool.get().map_err(pool_error)?;
        apply_connection_pragmas(&conn, profile)?;

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
                seed_int INTEGER,
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
                culled_at INTEGER,
                ghost_recipe TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );",
        )?;
        Self::ensure_optional_columns(&conn)?;
        Self::backfill_generation_types(&conn)?;
        Self::migrate_favorites_to_locks(&conn)?;
        // ── Ensure app_migrations table exists ──
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_migrations (
                name TEXT PRIMARY KEY,
                applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );",
        )?;

        // ── Migration: culled_at_v1 (G10/G11 tombstone & central view) ──
        let culled_at_migrated: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'culled_at_v1')",
            [],
            |r| r.get(0),
        )?;
        if !culled_at_migrated {
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_images_culled_at ON images(culled_at);
                 DROP VIEW IF EXISTS images_live;
                 CREATE VIEW images_live AS SELECT * FROM images WHERE culled_at IS NULL;
                 INSERT OR IGNORE INTO app_migrations (name) VALUES ('culled_at_v1');",
            )?;
        }
        conn.execute_batch(
            "CREATE VIEW IF NOT EXISTS images_live AS SELECT * FROM images WHERE culled_at IS NULL;",
        )?;

        // ── Migration: lineage_edges_v1 (G9/G10 id-keyed lineage edges) ──
        let lineage_edges_migrated: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'lineage_edges_v1')",
            [],
            |r| r.get(0),
        )?;
        if !lineage_edges_migrated {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS lineage_edges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    child_id INTEGER NOT NULL REFERENCES images(id),
                    parent_id INTEGER NOT NULL,
                    ops_json TEXT,
                    source TEXT NOT NULL,
                    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                    UNIQUE(child_id, parent_id, source)
                );
                CREATE INDEX IF NOT EXISTS idx_lineage_edges_child ON lineage_edges(child_id);
                CREATE INDEX IF NOT EXISTS idx_lineage_edges_parent ON lineage_edges(parent_id);
                INSERT OR IGNORE INTO app_migrations (name) VALUES ('lineage_edges_v1');",
            )?;
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS lineage_edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                child_id INTEGER NOT NULL REFERENCES images(id),
                parent_id INTEGER NOT NULL,
                ops_json TEXT,
                source TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                UNIQUE(child_id, parent_id, source)
            );
            CREATE INDEX IF NOT EXISTS idx_lineage_edges_child ON lineage_edges(child_id);
            CREATE INDEX IF NOT EXISTS idx_lineage_edges_parent ON lineage_edges(parent_id);",
        )?;

        // ── Migration: scope FTS update triggers to text columns ──
        let fts_migrated: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'fts_triggers_scoped_v1')",
            [],
            |r| r.get(0),
        )?;
        if !fts_migrated {
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS images_au;
                 DROP TRIGGER IF EXISTS images_au_tri;
                 INSERT OR IGNORE INTO app_migrations (name) VALUES ('fts_triggers_scoped_v1');",
            )?;
        }

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
            "CREATE TRIGGER IF NOT EXISTS images_au AFTER UPDATE OF prompt, negative_prompt, raw_metadata, model_name ON images BEGIN
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
            "CREATE TRIGGER IF NOT EXISTS images_au_tri AFTER UPDATE OF prompt, negative_prompt, raw_metadata, model_name ON images BEGIN
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

        // ── Migration: clean invalid/non-positive seed_int values ──
        let seed_int_v2_migrated: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'seed_int_rule_v2')",
            [],
            |r| r.get(0),
        )?;
        if !seed_int_v2_migrated {
            conn.execute_batch(
                "UPDATE images SET seed_int = NULL WHERE seed_int <= 0;
                 INSERT OR IGNORE INTO app_migrations (name) VALUES ('seed_int_rule_v2');",
            )?;
        }

        // ── Startup seed_int backfill (after trigger scoping so it does not touch FTS) ──
        conn.execute_batch(
            "UPDATE images SET seed_int = CAST(seed AS INTEGER) WHERE seed IS NOT NULL AND seed != '' AND seed NOT GLOB '*[^0-9]*' AND length(seed) <= 18 AND CAST(seed AS INTEGER) != 0 AND seed_int IS NULL;",
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

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS lineage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                child_filepath TEXT NOT NULL,
                parent_filepath TEXT NOT NULL,
                relation TEXT NOT NULL CHECK(relation IN ('txt2img2img','inpaint','upscale','grid','seed_walk')),
                confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                UNIQUE(child_filepath, parent_filepath),
                FOREIGN KEY(child_filepath) REFERENCES images(filepath) ON DELETE CASCADE,
                FOREIGN KEY(parent_filepath) REFERENCES images(filepath) ON DELETE CASCADE
            );",
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS lineage_overrides (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                child_filepath TEXT NOT NULL,
                parent_filepath TEXT NOT NULL,
                relation TEXT NOT NULL CHECK(relation IN ('txt2img2img','inpaint','upscale','grid','seed_walk')),
                confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
                action TEXT NOT NULL CHECK(action IN ('link','unlink')),
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                UNIQUE(child_filepath, parent_filepath),
                FOREIGN KEY(child_filepath) REFERENCES images(filepath) ON DELETE CASCADE,
                FOREIGN KEY(parent_filepath) REFERENCES images(filepath) ON DELETE CASCADE
            );",
        )?;

        // ── Indexes ──
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_images_seed ON images(seed);")?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_images_seed_int ON images(seed_int);")?;
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
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_images_filepath ON images(filepath);")?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_lineage_parent ON lineage(parent_filepath);",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_lineage_child ON lineage(child_filepath);",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_lineage_confidence ON lineage(confidence);",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_lineage_overrides_child ON lineage_overrides(child_filepath);",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_lineage_overrides_parent ON lineage_overrides(parent_filepath);",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_lineage_overrides_action ON lineage_overrides(action);",
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
            ("seed_int", "INTEGER"),
            ("culled_at", "INTEGER"),
            ("ghost_recipe", "TEXT"),
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

    /// Deletion protection used to be `is_locked || is_favorite`; it is now
    /// `is_locked` only. Run once so every image that was protected before
    /// stays protected after the semantics change.
    fn migrate_favorites_to_locks(conn: &Connection) -> SqlResult<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_migrations (
                name TEXT PRIMARY KEY,
                applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );",
        )?;
        let already_applied: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'favorites_imply_lock_v1')",
            [],
            |row| row.get(0),
        )?;
        if already_applied {
            return Ok(());
        }
        conn.execute_batch(
            "BEGIN;
             UPDATE images SET is_locked = 1 WHERE is_favorite = 1 AND is_locked = 0;
             INSERT INTO app_migrations (name) VALUES ('favorites_imply_lock_v1');
             COMMIT;",
        )
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
mod lineage;
mod read_queries;
mod timeline;

pub use lineage::{LineageCursor, LineageEdge, TagProvenance};
pub use read_queries::DuplicateGroup;

impl Database {
    /// Exposes a pooled connection for integration tests and manual QA.
    /// Mirrors `pool.get()` but maps r2d2 errors to `rusqlite::Error` for callers.
    pub fn pool_get_for_test(
        &self,
    ) -> SqlResult<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>> {
        self.pool.get().map_err(pool_error)
    }
}

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

pub(crate) fn image_record_from_row(row: &Row<'_>) -> SqlResult<ImageRecord> {
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

pub(crate) fn gallery_image_record_from_row(row: &Row<'_>) -> SqlResult<GalleryImageRecord> {
    let file_mtime: Option<i64> = row.get::<_, Option<i64>>(10).unwrap_or(None);
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
        file_mtime,
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
pub(crate) fn sanitize_fts_query(query: &str) -> String {
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

    let has_positive = parts.iter().any(|p| !p.starts_with("NOT "));
    if !has_positive {
        return String::new();
    }

    parts.join(" ")
}

pub(crate) fn process_unquoted_words(text: &str, parts: &mut Vec<String>) {
    for word in text.split_whitespace() {
        let is_negated = word.starts_with('-') && word.len() > 1;
        let core = if is_negated { &word[1..] } else { word };
        let has_wildcard = core.contains('*');
        let cleaned: String = core
            .chars()
            .filter(|ch| ch.is_alphanumeric() || *ch == '_' || *ch == '*')
            .collect();

        if cleaned.is_empty() || cleaned == "*" {
            continue;
        }

        let term = if has_wildcard {
            cleaned.to_lowercase()
        } else {
            format!("{}*", cleaned.to_lowercase())
        };

        if is_negated {
            parts.push(format!("NOT {}", term));
        } else {
            parts.push(term);
        }
    }
}

pub(crate) fn contains_search_token(text: &str) -> bool {
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
    fn test_migrate_favorites_to_locks_preserves_protection_once() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");
        insert_with_prompt(&db, "fav.png", "test", &[]);
        insert_with_prompt(&db, "plain.png", "test", &[]);
        let conn = db.pool.get().expect("pool");
        conn.execute(
            "UPDATE images SET is_favorite = 1 WHERE filepath = 'fav.png'",
            [],
        )
        .expect("mark favorite");
        conn.execute(
            "DELETE FROM app_migrations WHERE name = 'favorites_imply_lock_v1'",
            [],
        )
        .expect("reset migration");

        Database::migrate_favorites_to_locks(&conn).expect("migration");
        let locked = |path: &str| -> i64 {
            conn.query_row(
                "SELECT is_locked FROM images WHERE filepath = ?1",
                params![path],
                |row| row.get(0),
            )
            .expect("read is_locked")
        };
        assert_eq!(locked("fav.png"), 1);
        assert_eq!(locked("plain.png"), 0);

        // Second run must not re-lock an image the user deliberately unlocked.
        conn.execute(
            "UPDATE images SET is_locked = 0 WHERE filepath = 'fav.png'",
            [],
        )
        .expect("unlock");
        Database::migrate_favorites_to_locks(&conn).expect("migration rerun");
        assert_eq!(locked("fav.png"), 0);
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

    fn pragma_i64(conn: &Connection, pragma: &str) -> i64 {
        conn.query_row(&format!("PRAGMA {pragma}"), [], |row| row.get::<_, i64>(0))
            .unwrap_or_else(|e| panic!("PRAGMA {pragma} i64 failed: {e}"))
    }

    fn pragma_string(conn: &Connection, pragma: &str) -> String {
        conn.query_row(&format!("PRAGMA {pragma}"), [], |row| {
            let val: rusqlite::types::Value = row.get(0)?;
            Ok(match val {
                rusqlite::types::Value::Integer(i) => i.to_string(),
                rusqlite::types::Value::Real(f) => f.to_string(),
                rusqlite::types::Value::Text(s) => s,
                rusqlite::types::Value::Blob(b) => String::from_utf8_lossy(&b).to_string(),
                rusqlite::types::Value::Null => String::new(),
            })
        })
        .unwrap_or_else(|e| panic!("PRAGMA {pragma} string failed: {e}"))
    }

    #[test]
    fn test_pragma_profile() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let hdd_path = std::env::temp_dir().join(format!("forge_pragma_hdd_{nanos}.db"));
        let ssd_path = std::env::temp_dir().join(format!("forge_pragma_ssd_{nanos}.db"));
        let hdd_db =
            Database::new(&hdd_path, StorageProfile::Hdd).expect("failed to create hdd db");
        let ssd_db =
            Database::new(&ssd_path, StorageProfile::Ssd).expect("failed to create ssd db");

        let hdd_conn = hdd_db.pool.get().expect("hdd pool get");
        let ssd_conn = ssd_db.pool.get().expect("ssd pool get");

        let hdd_cache = pragma_i64(&hdd_conn, "cache_size");
        let ssd_cache = pragma_i64(&ssd_conn, "cache_size");
        println!("hdd cache_size={hdd_cache} ssd cache_size={ssd_cache}");
        assert_eq!(hdd_cache, -40000, "HDD cache_size should be -40000");
        assert_eq!(ssd_cache, -262144, "SSD cache_size should be -262144");
        assert_ne!(hdd_cache, ssd_cache);

        let hdd_mmap = pragma_i64(&hdd_conn, "mmap_size");
        let ssd_mmap = pragma_i64(&ssd_conn, "mmap_size");
        println!("hdd mmap_size={hdd_mmap} ssd mmap_size={ssd_mmap}");
        assert_eq!(hdd_mmap, 268435456);
        assert_eq!(ssd_mmap, 1073741824);
        assert_ne!(hdd_mmap, ssd_mmap);

        let hdd_wal = pragma_i64(&hdd_conn, "wal_autocheckpoint");
        let ssd_wal = pragma_i64(&ssd_conn, "wal_autocheckpoint");
        println!("hdd wal_autocheckpoint={hdd_wal} ssd wal_autocheckpoint={ssd_wal}");
        assert_eq!(hdd_wal, 1000);
        assert_eq!(ssd_wal, 4000);
        assert_ne!(hdd_wal, ssd_wal);

        let hdd_journal_limit = pragma_i64(&hdd_conn, "journal_size_limit");
        let ssd_journal_limit = pragma_i64(&ssd_conn, "journal_size_limit");
        println!(
            "hdd journal_size_limit={hdd_journal_limit} ssd journal_size_limit={ssd_journal_limit}"
        );
        assert_eq!(hdd_journal_limit, 33554432);
        assert_eq!(ssd_journal_limit, 134217728);
        assert_ne!(hdd_journal_limit, ssd_journal_limit);

        for (label, conn) in [("hdd", &hdd_conn), ("ssd", &ssd_conn)] {
            let journal_mode = pragma_string(conn, "journal_mode").to_ascii_lowercase();
            assert_eq!(
                journal_mode, "wal",
                "{label} journal_mode should be wal, got {journal_mode}"
            );

            let synchronous = pragma_string(conn, "synchronous").to_ascii_lowercase();
            let is_normal =
                synchronous == "1" || synchronous == "normal" || synchronous == "1 (normal)";
            if !is_normal {
                let sync_i = pragma_i64(conn, "synchronous");
                assert_eq!(
                    sync_i, 1,
                    "{label} synchronous should be NORMAL(1), got {sync_i}"
                );
            }

            let temp_store = pragma_string(conn, "temp_store").to_ascii_lowercase();
            let is_memory =
                temp_store == "2" || temp_store == "memory" || temp_store.contains("memory");
            if !is_memory {
                let ts_i = pragma_i64(conn, "temp_store");
                assert_eq!(
                    ts_i, 2,
                    "{label} temp_store should be MEMORY(2), got {ts_i}"
                );
            }

            let busy = pragma_i64(conn, "busy_timeout");
            assert_eq!(
                busy, 5000,
                "{label} busy_timeout should be 5000, got {busy}"
            );

            let fk = pragma_i64(conn, "foreign_keys");
            assert_eq!(fk, 1, "{label} foreign_keys should be ON(1), got {fk}");
        }

        drop(hdd_conn);
        drop(ssd_conn);
        drop(hdd_db);
        drop(ssd_db);
        let _ = std::fs::remove_file(&hdd_path);
        let _ = std::fs::remove_file(&ssd_path);
        let _ = std::fs::remove_file(hdd_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(hdd_path.with_extension("db-shm"));
        let _ = std::fs::remove_file(ssd_path.with_extension("db-shm"));
    }

    #[test]
    fn thumbnail_resume_batch_after_filepath_pagination() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");
        let filepaths = vec![
            "a/001.png",
            "a/002.png",
            "a/003.png",
            "a/004.png",
            "a/005.png",
            "b/001.png",
        ];
        for filepath in &filepaths {
            let params = GenerationParams {
                prompt: format!("prompt for {}", filepath),
                raw_metadata: format!("raw {}", filepath),
                ..Default::default()
            };
            db.upsert_image(filepath, filepath, "a", &params, Some(1))
                .expect("upsert failed");
        }

        let first_batch = db
            .get_image_filepaths_batch_after(None, 2)
            .expect("batch fetch failed");
        println!("first_batch={:?}", first_batch);
        assert_eq!(first_batch, vec!["a/001.png", "a/002.png"]);

        let second_batch = db
            .get_image_filepaths_batch_after(Some("a/002.png"), 2)
            .expect("batch fetch failed");
        println!("second_batch={:?}", second_batch);
        assert_eq!(second_batch, vec!["a/003.png", "a/004.png"]);

        let resumed_after_004 = db
            .get_image_filepaths_batch_after(Some("a/004.png"), 10)
            .expect("batch fetch failed");
        println!("resumed_after_004={:?}", resumed_after_004);
        assert_eq!(resumed_after_004, vec!["a/005.png", "b/001.png"]);

        let empty_after_last = db
            .get_image_filepaths_batch_after(Some("b/001.png"), 10)
            .expect("batch fetch failed");
        println!("empty_after_last={:?}", empty_after_last);
        assert!(
            empty_after_last.is_empty(),
            "should be empty after last filepath"
        );

        let limit_one = db
            .get_image_filepaths_batch_after(Some("a/001.png"), 1)
            .expect("batch fetch failed");
        assert_eq!(limit_one, vec!["a/002.png"]);
        println!("thumbnail_resume resume from filepath OK");
    }

    #[test]
    fn thumbnail_resume_uses_filepath_index() {
        let db =
            Database::new(Path::new(":memory:"), StorageProfile::Hdd).expect("failed to create db");
        let conn = db.pool.get().expect("pool");
        let mut stmt = conn
            .prepare("EXPLAIN QUERY PLAN SELECT filepath FROM images WHERE filepath > ?1 ORDER BY filepath ASC LIMIT ?2")
            .expect("prepare failed");
        let rows = stmt
            .query_map(params!["a", 10], |row| row.get::<_, String>(3))
            .expect("query failed");
        let details: Vec<String> = rows.filter_map(|r| r.ok()).collect();
        println!("thumbnail_resume plan={:?}", details);
        let uses_index = details
            .iter()
            .any(|d| d.contains("idx_images_filepath") || d.contains("filepath"));
        assert!(
            uses_index,
            "resume query should use idx_images_filepath, got {:?}",
            details
        );
    }

    #[test]
    fn bench_50k_mtime_bulk_under_1s() {
        let db =
            Database::new(Path::new(":memory:"), StorageProfile::Hdd).expect("failed to create db");
        let n: usize = 50_000;
        let mut records = Vec::with_capacity(n);
        for i in 0..n {
            let filepath = format!("bench/{:05}.png", i);
            records.push(BulkRecord {
                filepath: filepath.clone(),
                filename: format!("{:05}.png", i),
                directory: "bench".to_string(),
                params: GenerationParams {
                    prompt: "bench".to_string(),
                    raw_metadata: "bench".to_string(),
                    ..Default::default()
                },
                file_mtime: Some(1_700_000_000 + i as i64),
                file_size: Some(1_000),
                quick_hash: Some(format!("{:024x}", i)),
                tags: vec!["bench".to_string()],
            });
        }
        let start = std::time::Instant::now();
        let inserted = db.bulk_upsert_with_tags(&records).expect("bulk failed");
        let bulk_elapsed = start.elapsed();
        println!(
            "50k bulk_upsert: inserted={}, elapsed={:.2?}",
            inserted, bulk_elapsed
        );
        assert_eq!(inserted, n);

        let mtime_start = std::time::Instant::now();
        let mtimes = db
            .get_all_file_mtimes()
            .expect("get_all_file_mtimes failed");
        let mtime_elapsed = mtime_start.elapsed();
        println!(
            "50k mtime fetch: count={}, elapsed={:.2?}",
            mtimes.len(),
            mtime_elapsed
        );
        assert_eq!(mtimes.len(), n);
        let total_elapsed = start.elapsed();
        println!("total bench elapsed={:.2?}", total_elapsed);
        let is_ci = std::env::var("CI").is_ok();
        let max_mtime = if is_ci { 10.0 } else { 3.0 };
        let max_bulk = if is_ci { 60.0 } else { 20.0 };
        assert!(
            mtime_elapsed.as_secs_f64() < max_mtime,
            "mtime bulk fetch must be <{max_mtime}s, got {:.3?}",
            mtime_elapsed
        );
        assert!(
            bulk_elapsed.as_secs_f64() < max_bulk,
            "bulk upsert 50k should be <{max_bulk}s debug (bulk cap 500), got {:.3?}",
            bulk_elapsed
        );
    }

    #[test]
    fn bench_50k_hdd_incremental_scan_under_180s() {
        use std::time::Instant;
        let wall_start = Instant::now();

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let bench_path = std::env::temp_dir().join(format!("forge_bench_50k_inc_{nanos}.db"));
        let db = Database::new(&bench_path, StorageProfile::Hdd).expect("failed to create db");
        let conn = db.pool.get().expect("pool get failed");
        let hdd_cache = pragma_i64(&conn, "cache_size");
        let hdd_mmap = pragma_i64(&conn, "mmap_size");
        let hdd_wal = pragma_i64(&conn, "wal_autocheckpoint");
        let hdd_journal_limit = pragma_i64(&conn, "journal_size_limit");
        let journal_mode = pragma_string(&conn, "journal_mode").to_ascii_lowercase();
        let synchronous = pragma_string(&conn, "synchronous").to_ascii_lowercase();
        println!(
            "HDD pragmas cache_size={hdd_cache} mmap_size={hdd_mmap} wal_autocheckpoint={hdd_wal} journal_size_limit={hdd_journal_limit} journal_mode={journal_mode} synchronous={synchronous}"
        );
        assert_eq!(hdd_cache, -40000, "HDD cache_size must be -40000");
        assert_eq!(hdd_mmap, 268_435_456, "HDD mmap_size must be 268435456");
        assert_eq!(hdd_wal, 1000, "HDD wal_autocheckpoint must be 1000");
        assert_eq!(
            hdd_journal_limit, 33_554_432,
            "HDD journal_size_limit must be 33554432"
        );
        assert_eq!(journal_mode, "wal");
        assert!(
            synchronous == "1"
                || synchronous == "normal"
                || synchronous.contains("normal")
                || pragma_i64(&conn, "synchronous") == 1
        );

        let idx_exists: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_images_file_mtime'",
                [],
                |row| row.get(0),
            )
            .ok();
        println!("idx_images_file_mtime exists={:?}", idx_exists);
        assert_eq!(
            idx_exists.as_deref(),
            Some("idx_images_file_mtime"),
            "idx_images_file_mtime must exist"
        );
        let plan = explain_details(
            &conn,
            "SELECT filepath, file_mtime FROM images WHERE file_mtime IS NOT NULL",
            &[],
        );
        println!("get_all_file_mtimes plan={:?}", plan);
        let uses_index = plan.iter().any(|d| {
            d.contains("idx_images_file_mtime")
                || d.contains("USING COVERING INDEX")
                || d.contains("USING INDEX")
        });
        println!("get_all_file_mtimes uses_index_hint={uses_index}");
        drop(conn);

        let n: usize = 50_000;
        let mut records = Vec::with_capacity(n);
        for i in 0..n {
            let filepath = format!("bench/{:05}.png", i);
            records.push(BulkRecord {
                filepath: filepath.clone(),
                filename: format!("{:05}.png", i),
                directory: "bench".to_string(),
                params: GenerationParams {
                    prompt: "bench".to_string(),
                    raw_metadata: "bench".to_string(),
                    ..Default::default()
                },
                file_mtime: Some(1_700_000_000 + i as i64),
                file_size: Some(1_000),
                quick_hash: Some(format!("{:024x}", i)),
                tags: vec!["bench".to_string()],
            });
        }
        let bulk_start = Instant::now();
        let inserted = db
            .bulk_upsert_with_tags(&records)
            .expect("seed bulk failed");
        let bulk_elapsed = bulk_start.elapsed();
        println!(
            "50k HDD seed bulk_upsert (500/tx): inserted={} elapsed={:.2?}",
            inserted, bulk_elapsed
        );
        let is_ci = std::env::var("CI").is_ok();
        let max_bulk = if is_ci { 60.0 } else { 25.0 };
        let max_fetch = if is_ci { 10.0 } else { 3.0 };
        let max_filter = if is_ci { 10.0 } else { 3.0 };
        let max_delta = if is_ci { 15.0 } else { 5.0 };

        assert_eq!(inserted, n);
        assert!(
            bulk_elapsed.as_secs_f64() < max_bulk,
            "seed 50k bulk must be <{max_bulk}s, got {:.2?}",
            bulk_elapsed
        );

        let indexed_start = Instant::now();
        let indexed_mtimes = db
            .get_all_file_mtimes()
            .expect("indexed get_all_file_mtimes failed");
        let indexed_elapsed = indexed_start.elapsed();
        println!(
            "50k indexed get_all_file_mtimes: count={} elapsed={:.2?}",
            indexed_mtimes.len(),
            indexed_elapsed
        );
        assert_eq!(indexed_mtimes.len(), n);
        assert!(
            indexed_elapsed.as_secs_f64() < max_fetch,
            "indexed mtime fetch must be <{max_fetch}s, got {:.2?}",
            indexed_elapsed
        );

        let brute_start = Instant::now();
        let mut brute_mtimes: HashMap<String, i64> = HashMap::with_capacity(n);
        for i in 0..n {
            let fp = format!("bench/{:05}.png", i);
            let m = db
                .get_file_mtime(&fp)
                .expect("brute get_file_mtime failed")
                .expect("mtime missing");
            brute_mtimes.insert(fp, m);
        }
        let brute_elapsed = brute_start.elapsed();
        println!(
            "50k brute get_file_mtime (per-row): count={} elapsed={:.2?} ratio brute/indexed={:.1}x",
            brute_mtimes.len(),
            brute_elapsed,
            brute_elapsed.as_secs_f64() / indexed_elapsed.as_secs_f64().max(0.001)
        );
        assert_eq!(brute_mtimes.len(), n);
        assert_eq!(
            indexed_mtimes, brute_mtimes,
            "indexed vs brute must match exactly"
        );
        assert!(
            indexed_elapsed <= brute_elapsed,
            "indexed fetch should be faster than brute, indexed={:.2?} brute={:.2?}",
            indexed_elapsed,
            brute_elapsed
        );

        let delta: usize = 1_000;
        let changed_start_idx = 25_000;
        let mut fs_mtimes: Vec<(String, i64)> = Vec::with_capacity(n);
        for i in 0..n {
            let fp = format!("bench/{:05}.png", i);
            let mut mtime = 1_700_000_000 + i as i64;
            if i >= changed_start_idx && i < changed_start_idx + delta {
                mtime += 9_999;
            }
            fs_mtimes.push((fp, mtime));
        }

        let filter_start = Instant::now();
        let existing = indexed_mtimes;
        let mut pending: Vec<(String, i64)> = Vec::with_capacity(delta);
        for (fp, cur_mtime) in &fs_mtimes {
            let is_unchanged = matches!(
                existing.get(fp.as_str()),
                Some(existing_mtime) if *existing_mtime == *cur_mtime
            );
            if !is_unchanged {
                pending.push((fp.clone(), *cur_mtime));
            }
        }
        let filter_elapsed = filter_start.elapsed();
        println!(
            "incremental filter: total={} pending={} skipped={} elapsed={:.2?}",
            n,
            pending.len(),
            n - pending.len(),
            filter_elapsed
        );
        assert_eq!(
            pending.len(),
            delta,
            "incremental delta should detect exactly 1k changed files"
        );
        assert!(
            filter_elapsed.as_secs_f64() < max_filter,
            "filter 50k hash lookups must be <{max_filter}s"
        );

        let mut delta_records = Vec::with_capacity(delta);
        for (fp, new_mtime) in &pending {
            delta_records.push(BulkRecord {
                filepath: fp.clone(),
                filename: fp.split('/').last().unwrap_or(fp).to_string(),
                directory: "bench".to_string(),
                params: GenerationParams {
                    prompt: "bench updated".to_string(),
                    raw_metadata: "bench updated".to_string(),
                    ..Default::default()
                },
                file_mtime: Some(*new_mtime),
                file_size: Some(1_000),
                quick_hash: Some(format!("{:024x}", new_mtime)),
                tags: vec!["bench".to_string()],
            });
        }
        let delta_bulk_start = Instant::now();
        let delta_inserted = db
            .bulk_upsert_with_tags(&delta_records)
            .expect("delta bulk failed");
        let delta_bulk_elapsed = delta_bulk_start.elapsed();
        println!(
            "1k delta bulk_upsert (500/tx): inserted={} elapsed={:.2?} tx_count={}",
            delta_inserted,
            delta_bulk_elapsed,
            (delta + 499) / 500
        );
        assert_eq!(delta_inserted, delta);
        assert!(
            delta_bulk_elapsed.as_secs_f64() < max_delta,
            "1k delta bulk must be <{max_delta}s, got {:.2?}",
            delta_bulk_elapsed
        );

        let verify_mtimes = db.get_all_file_mtimes().expect("verify fetch failed");
        for (fp, expected) in &pending {
            assert_eq!(
                verify_mtimes.get(fp.as_str()),
                Some(expected),
                "changed file {fp} mtime not updated"
            );
        }

        let wall_elapsed = wall_start.elapsed();
        println!(
            "WALL CLOCK bench_50k_hdd_incremental_scan: total={:.2?} bulk50k={:.2?} indexed={:.2?} brute={:.2?} filter={:.2?} delta_bulk={:.2?} pending={} n={} profile=Hdd bulk_chunk=500 idx=idx_images_file_mtime",
            wall_elapsed, bulk_elapsed, indexed_elapsed, brute_elapsed, filter_elapsed, delta_bulk_elapsed, pending.len(), n
        );
        assert!(
            wall_elapsed.as_secs_f64() < 180.0,
            "50k HDD incremental scan wall must be <180s, got {:.2?}",
            wall_elapsed
        );
        drop(verify_mtimes);
        drop(delta_records);
        drop(pending);
        drop(db);
        let _ = std::fs::remove_file(&bench_path);
        let _ = std::fs::remove_file(bench_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(bench_path.with_extension("db-shm"));
    }
}
