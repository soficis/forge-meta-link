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
        StorageProfile::Hdd => cpu_count.min(HDD_FRIENDLY_DB_POOL_SIZE).max(2),
        StorageProfile::Ssd => cpu_count.min(SSD_FRIENDLY_DB_POOL_SIZE).max(4),
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
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_image_tags_tag_id ON image_tags(tag_id);",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_images_model_name ON images(model_name);",
        )?;
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
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_images_generation_type ON images(generation_type);",
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

    // ────────────────────────────── Bulk Operations ──────────────────────────────

    /// Fetches all stored file mtimes in a single query for fast lookup.
    /// Returns a HashMap<filepath, mtime> enabling O(1) changed-file detection.
    pub fn get_all_file_mtimes(&self) -> SqlResult<HashMap<String, i64>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt =
            conn.prepare("SELECT filepath, file_mtime FROM images WHERE file_mtime IS NOT NULL")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;

        let mut map = HashMap::new();
        for row in rows {
            let (path, mtime) = row?;
            map.insert(path, mtime);
        }
        Ok(map)
    }

    /// Batch upsert images and their tags in a single transaction.
    /// Dramatically faster than individual upserts (10-50x for large libraries)
    /// because SQLite only syncs to disk once at commit time.
    pub fn bulk_upsert_with_tags(&self, records: &[BulkRecord]) -> SqlResult<usize> {
        if records.is_empty() {
            return Ok(0);
        }

        let mut conn = self.pool.get().map_err(pool_error)?;
        let tx = conn.transaction()?;
        let mut count = 0usize;
        {
            let mut upsert_image_stmt = tx.prepare_cached(
                "INSERT INTO images
                    (filepath, filename, directory, prompt, negative_prompt, steps, sampler,
                     schedule_type, cfg_scale, seed, width, height, model_hash, model_name,
                     generation_type, raw_metadata, extra_params, file_mtime, file_size, quick_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
                 ON CONFLICT(filepath) DO UPDATE SET
                     filename=excluded.filename,
                     directory=excluded.directory,
                     prompt=excluded.prompt,
                     negative_prompt=excluded.negative_prompt,
                     steps=excluded.steps,
                     sampler=excluded.sampler,
                     schedule_type=excluded.schedule_type,
                     cfg_scale=excluded.cfg_scale,
                     seed=excluded.seed,
                     width=excluded.width,
                     height=excluded.height,
                     model_hash=excluded.model_hash,
                     model_name=excluded.model_name,
                     generation_type=excluded.generation_type,
                     raw_metadata=excluded.raw_metadata,
                     extra_params=excluded.extra_params,
                     file_mtime=excluded.file_mtime,
                     file_size=excluded.file_size,
                     quick_hash=excluded.quick_hash
                 RETURNING id",
            )?;
            let mut delete_image_tags_stmt =
                tx.prepare_cached("DELETE FROM image_tags WHERE image_id = ?1")?;
            let mut upsert_tag_stmt = tx.prepare_cached(
                "INSERT INTO tags(tag) VALUES (?1)
                 ON CONFLICT(tag) DO UPDATE SET tag=excluded.tag
                 RETURNING id",
            )?;
            let mut insert_image_tag_stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO image_tags(image_id, tag_id) VALUES (?1, ?2)",
            )?;
            let mut tag_id_cache: HashMap<String, i64> = HashMap::with_capacity(4096);

            for record in records {
                let extra = serde_json::to_string(&record.params.extra_params).unwrap_or_default();
                let generation_type = record
                    .params
                    .generation_type
                    .clone()
                    .unwrap_or_else(|| infer_generation_type(&record.params.raw_metadata));

                let id: i64 = upsert_image_stmt.query_row(
                    params![
                        record.filepath,
                        record.filename,
                        record.directory,
                        record.params.prompt,
                        record.params.negative_prompt,
                        record.params.steps,
                        record.params.sampler,
                        record.params.schedule_type,
                        record.params.cfg_scale,
                        record.params.seed,
                        record.params.width,
                        record.params.height,
                        record.params.model_hash,
                        record.params.model_name,
                        generation_type,
                        record.params.raw_metadata,
                        extra,
                        record.file_mtime,
                        record.file_size,
                        record.quick_hash,
                    ],
                    |row| row.get::<_, i64>(0),
                )?;

                // Replace tags within the same transaction
                delete_image_tags_stmt.execute(params![id])?;
                let mut seen_tags: HashSet<String> = HashSet::with_capacity(record.tags.len());

                for tag in &record.tags {
                    let normalized = tag.trim().to_ascii_lowercase();
                    if normalized.is_empty() || !seen_tags.insert(normalized.clone()) {
                        continue;
                    }

                    let tag_id = if let Some(existing) = tag_id_cache.get(&normalized) {
                        *existing
                    } else {
                        let created_or_existing: i64 = upsert_tag_stmt
                            .query_row(params![normalized.as_str()], |row| row.get::<_, i64>(0))?;
                        tag_id_cache.insert(normalized, created_or_existing);
                        created_or_existing
                    };

                    insert_image_tag_stmt.execute(params![id, tag_id])?;
                }

                count += 1;
            }
        }

        tx.commit()?;
        Ok(count)
    }

    // ────────────────────────────── Writes ──────────────────────────────

    /// Inserts or updates an image and returns its stable row id.
    pub fn upsert_image(
        &self,
        filepath: &str,
        filename: &str,
        directory: &str,
        params: &GenerationParams,
        file_mtime: Option<i64>,
    ) -> SqlResult<i64> {
        let conn = self.pool.get().map_err(pool_error)?;
        let extra = serde_json::to_string(&params.extra_params).unwrap_or_default();
        let generation_type = params
            .generation_type
            .clone()
            .unwrap_or_else(|| infer_generation_type(&params.raw_metadata));

        conn.query_row(
            "INSERT INTO images
                (filepath, filename, directory, prompt, negative_prompt, steps, sampler,
                 schedule_type, cfg_scale, seed, width, height, model_hash, model_name,
                 generation_type, raw_metadata, extra_params, file_mtime, file_size, quick_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
             ON CONFLICT(filepath) DO UPDATE SET
                 filename=excluded.filename,
                 directory=excluded.directory,
                 prompt=excluded.prompt,
                 negative_prompt=excluded.negative_prompt,
                 steps=excluded.steps,
                 sampler=excluded.sampler,
                 schedule_type=excluded.schedule_type,
                 cfg_scale=excluded.cfg_scale,
                 seed=excluded.seed,
                 width=excluded.width,
                 height=excluded.height,
                 model_hash=excluded.model_hash,
                 model_name=excluded.model_name,
                 generation_type=excluded.generation_type,
                 raw_metadata=excluded.raw_metadata,
                 extra_params=excluded.extra_params,
                 file_mtime=excluded.file_mtime,
                 file_size=excluded.file_size,
                 quick_hash=excluded.quick_hash
             RETURNING id",
            params![
                filepath,
                filename,
                directory,
                params.prompt,
                params.negative_prompt,
                params.steps,
                params.sampler,
                params.schedule_type,
                params.cfg_scale,
                params.seed,
                params.width,
                params.height,
                params.model_hash,
                params.model_name,
                generation_type,
                params.raw_metadata,
                extra,
                file_mtime,
                Option::<i64>::None,
                Option::<String>::None,
            ],
            |row| row.get::<_, i64>(0),
        )
    }

    /// Replaces image tags atomically.
    pub fn replace_image_tags(&self, image_id: i64, tags: &[String]) -> SqlResult<()> {
        let mut conn = self.pool.get().map_err(pool_error)?;
        let tx = conn.transaction()?;
        {
            let mut delete_stmt =
                tx.prepare_cached("DELETE FROM image_tags WHERE image_id = ?1")?;
            let mut upsert_tag_stmt = tx.prepare_cached(
                "INSERT INTO tags(tag) VALUES (?1)
                 ON CONFLICT(tag) DO UPDATE SET tag=excluded.tag
                 RETURNING id",
            )?;
            let mut insert_stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO image_tags(image_id, tag_id) VALUES (?1, ?2)",
            )?;

            delete_stmt.execute(params![image_id])?;
            let mut seen_tags: HashSet<String> = HashSet::with_capacity(tags.len());

            for tag in tags {
                let normalized_tag = tag.trim().to_ascii_lowercase();
                if normalized_tag.is_empty() || !seen_tags.insert(normalized_tag.clone()) {
                    continue;
                }

                let tag_id: i64 = upsert_tag_stmt
                    .query_row(params![normalized_tag.as_str()], |row| row.get::<_, i64>(0))?;

                insert_stmt.execute(params![image_id, tag_id])?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    // ────────────────────────────── Reads ──────────────────────────────

    /// Returns stored mtime for a filepath (unix seconds), if present.
    pub fn get_file_mtime(&self, filepath: &str) -> SqlResult<Option<i64>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt = conn.prepare("SELECT file_mtime FROM images WHERE filepath = ?1 LIMIT 1")?;
        let result = stmt.query_row(params![filepath], |row: &Row<'_>| {
            row.get::<_, Option<i64>>(0)
        });
        match result {
            Ok(mtime) => Ok(mtime),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Returns image id for a filepath if it exists.
    pub fn get_image_id_by_filepath(&self, filepath: &str) -> SqlResult<Option<i64>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt = conn.prepare("SELECT id FROM images WHERE filepath = ?1 LIMIT 1")?;
        match stmt.query_row(params![filepath], |row: &Row<'_>| row.get::<_, i64>(0)) {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Full-text search: tries porter (ranked) first, falls back to trigram (infix).
    pub fn search(&self, query: &str, limit: u32, offset: u32) -> SqlResult<Vec<ImageRecord>> {
        let porter_results = self.query_images(Some(query), &[], &[], limit, offset)?;
        if !porter_results.is_empty() {
            return Ok(porter_results);
        }
        // Porter returned nothing -- try infix/substring via trigram.
        self.search_trigram(query, limit, offset)
    }

    /// Trigram-based infix substring search (fallback).
    fn search_trigram(&self, query: &str, limit: u32, offset: u32) -> SqlResult<Vec<ImageRecord>> {
        self.query_images_trigram(query, &[], &[], limit, offset)
    }

    /// Filter images by optional query and tag include/exclude sets.
    pub fn filter_images(
        &self,
        query: Option<&str>,
        include_tags: &[String],
        exclude_tags: &[String],
        limit: u32,
        offset: u32,
    ) -> SqlResult<Vec<ImageRecord>> {
        self.query_images(query, include_tags, exclude_tags, limit, offset)
    }

    /// Gets all images with pagination for the gallery view.
    pub fn get_all_images(&self, limit: u32, offset: u32) -> SqlResult<Vec<ImageRecord>> {
        self.query_images(None, &[], &[], limit, offset)
    }

    // ────────────────────── Cursor-based pagination ──────────────────────

    /// Gets images using keyset (cursor) pagination -- O(1) at any depth.
    /// Supports optional sort_by field for different orderings.
    pub fn get_images_cursor(
        &self,
        cursor: Option<&str>,
        limit: u32,
        sort_by: Option<&str>,
        generation_types: Option<&[String]>,
        model_filter: Option<&str>,
        model_family_filters: Option<&[String]>,
    ) -> SqlResult<CursorPage> {
        let conn = self.pool.get().map_err(pool_error)?;
        let sort = SortConfig::from_str(sort_by.unwrap_or("newest"));
        let normalized_generation_types = normalize_generation_types(generation_types);
        let normalized_model_family_filters =
            normalize_model_family_filters(model_family_filters);
        let cursor_value = cursor.and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok());
        let cursor_id = cursor_value
            .as_ref()
            .and_then(|value| value.get("id")?.as_i64());
        let cursor_sort = cursor_value.as_ref().and_then(|value| {
            value
                .get("sort")
                .and_then(serde_json::Value::as_str)
                .map(|sort_value| sort_value.to_string())
        });

        let mut sql = if sort.field == "id" {
            String::from(
                "SELECT id, filepath, filename, directory, seed, width, height, model_name
                 FROM images
                 WHERE 1=1",
            )
        } else {
            format!(
                "SELECT id, filepath, filename, directory, seed, width, height, model_name, {} AS sort_value
                 FROM images
                 WHERE 1=1",
                sort.sort_expr()
            )
        };
        let mut par = Vec::<Value>::new();
        append_generation_type_filter(&mut sql, &mut par, &normalized_generation_types);
        append_model_filter(&mut sql, &mut par, model_filter, None);
        append_model_family_filter(&mut sql, &mut par, &normalized_model_family_filters, None);

        if let Some(cid) = cursor_id {
            if sort.field == "id" {
                sql.push_str(&format!(" AND id {} ?", sort.cursor_op()));
                par.push(Value::Integer(cid));
            } else if let Some(sort_value) = cursor_sort {
                let op = sort.cursor_op();
                let sort_expr = sort.sort_expr();
                sql.push_str(&format!(
                    " AND ({} {} ? OR ({} = ? AND id {} ?))",
                    sort_expr, op, sort_expr, op
                ));
                par.push(Value::Text(sort_value.clone()));
                par.push(Value::Text(sort_value));
                par.push(Value::Integer(cid));
            } else {
                sql.push_str(&format!(" AND id {} ?", sort.cursor_op()));
                par.push(Value::Integer(cid));
            }
        }
        sql.push_str(&format!(" ORDER BY {} LIMIT ?", sort.order_clause()));
        par.push(Value::Integer(limit as i64));

        let mut stmt = conn.prepare(&sql)?;
        let mut items = Vec::new();
        let next_cursor = if sort.field == "id" {
            let rows = stmt.query_map(params_from_iter(par), gallery_image_record_from_row)?;
            for row in rows {
                items.push(row?);
            }
            items
                .last()
                .map(|last| serde_json::json!({"id": last.id}).to_string())
        } else {
            let rows = stmt.query_map(params_from_iter(par), |row| {
                Ok((
                    gallery_image_record_from_row(row)?,
                    row.get::<_, String>(8)?,
                ))
            })?;
            let mut last_cursor = None::<(i64, String)>;
            for row in rows {
                let (record, sort_value) = row?;
                last_cursor = Some((record.id, sort_value));
                items.push(record);
            }
            last_cursor.map(|(id, sort_value)| {
                serde_json::json!({"id": id, "sort": sort_value}).to_string()
            })
        };

        Ok(CursorPage { items, next_cursor })
    }

    /// Cursor-based search: tries porter first, falls back to trigram.
    pub fn search_cursor(
        &self,
        query: &str,
        cursor: Option<&str>,
        limit: u32,
        generation_types: Option<&[String]>,
        sort_by: Option<&str>,
        model_filter: Option<&str>,
        model_family_filters: Option<&[String]>,
    ) -> SqlResult<CursorPage> {
        let porter = self.search_cursor_porter(
            query,
            cursor,
            limit,
            generation_types,
            sort_by,
            model_filter,
            model_family_filters,
        )?;
        if !porter.items.is_empty() {
            return Ok(porter);
        }
        self.search_cursor_trigram(
            query,
            cursor,
            limit,
            generation_types,
            sort_by,
            model_filter,
            model_family_filters,
        )
    }

    fn search_cursor_porter(
        &self,
        query: &str,
        cursor: Option<&str>,
        limit: u32,
        generation_types: Option<&[String]>,
        sort_by: Option<&str>,
        model_filter: Option<&str>,
        model_family_filters: Option<&[String]>,
    ) -> SqlResult<CursorPage> {
        let conn = self.pool.get().map_err(pool_error)?;

        let sanitized = sanitize_fts_query(query);
        if sanitized.is_empty() {
            return Ok(CursorPage {
                items: Vec::new(),
                next_cursor: None,
            });
        }

        let sort = SortConfig::from_str(sort_by.unwrap_or("newest"));
        let cursor_value = cursor.and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok());
        let cursor_id = cursor_value
            .as_ref()
            .and_then(|value| value.get("id")?.as_i64());
        let cursor_sort = cursor_value.as_ref().and_then(|value| {
            value
                .get("sort")
                .and_then(serde_json::Value::as_str)
                .map(|sort_value| sort_value.to_string())
        });
        let normalized_generation_types = normalize_generation_types(generation_types);
        let normalized_model_family_filters =
            normalize_model_family_filters(model_family_filters);
        let mut params_vec = vec![Value::Text(sanitized)];
        let mut sql = if sort.field == "id" {
            String::from(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name
                 FROM images
                 JOIN images_fts ON images.id = images_fts.rowid
                 WHERE images_fts MATCH ?",
            )
        } else {
            format!(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, {} AS sort_value
                 FROM images
                 JOIN images_fts ON images.id = images_fts.rowid
                 WHERE images_fts MATCH ?",
                sort.sort_expr()
            )
        };
        append_generation_type_filter(&mut sql, &mut params_vec, &normalized_generation_types);
        append_model_filter(&mut sql, &mut params_vec, model_filter, Some("images"));
        append_model_family_filter(
            &mut sql,
            &mut params_vec,
            &normalized_model_family_filters,
            Some("images"),
        );

        if let Some(cid) = cursor_id {
            if sort.field == "id" {
                sql.push_str(&format!(" AND images.id {} ?", sort.cursor_op()));
                params_vec.push(Value::Integer(cid));
            } else if let Some(sort_value) = cursor_sort {
                let op = sort.cursor_op();
                let sort_expr = sort.sort_expr();
                sql.push_str(&format!(
                    " AND ({} {} ? OR ({} = ? AND images.id {} ?))",
                    sort_expr, op, sort_expr, op
                ));
                params_vec.push(Value::Text(sort_value.clone()));
                params_vec.push(Value::Text(sort_value));
                params_vec.push(Value::Integer(cid));
            } else {
                sql.push_str(&format!(" AND images.id {} ?", sort.cursor_op()));
                params_vec.push(Value::Integer(cid));
            }
        }

        sql.push_str(&format!(" ORDER BY {} LIMIT ?", sort.order_clause()));
        params_vec.push(Value::Integer(limit as i64));

        let mut stmt = conn.prepare(&sql)?;
        if sort.field == "id" {
            let rows =
                stmt.query_map(params_from_iter(params_vec), gallery_image_record_from_row)?;
            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            let next_cursor = items
                .last()
                .map(|last| serde_json::json!({"id": last.id}).to_string());
            Ok(CursorPage { items, next_cursor })
        } else {
            let rows = stmt.query_map(params_from_iter(params_vec), |row| {
                Ok((
                    gallery_image_record_from_row(row)?,
                    row.get::<_, String>(8)?,
                ))
            })?;

            let mut items = Vec::new();
            let mut last_cursor = None::<(i64, String)>;
            for row in rows {
                let (record, sort_value) = row?;
                last_cursor = Some((record.id, sort_value));
                items.push(record);
            }

            let next_cursor = last_cursor.map(|(id, sort_value)| {
                serde_json::json!({"id": id, "sort": sort_value}).to_string()
            });

            Ok(CursorPage { items, next_cursor })
        }
    }

    fn search_cursor_trigram(
        &self,
        query: &str,
        cursor: Option<&str>,
        limit: u32,
        generation_types: Option<&[String]>,
        sort_by: Option<&str>,
        model_filter: Option<&str>,
        model_family_filters: Option<&[String]>,
    ) -> SqlResult<CursorPage> {
        let conn = self.pool.get().map_err(pool_error)?;

        let sanitized = query.trim();
        if sanitized.is_empty() || !contains_search_token(sanitized) {
            return Ok(CursorPage {
                items: Vec::new(),
                next_cursor: None,
            });
        }

        let sort = SortConfig::from_str(sort_by.unwrap_or("newest"));
        let match_expr = format!("\"{}\"", sanitized.replace('"', "\"\""));
        let normalized_generation_types = normalize_generation_types(generation_types);
        let cursor_value = cursor.and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok());
        let cursor_id = cursor_value
            .as_ref()
            .and_then(|value| value.get("id")?.as_i64());
        let cursor_sort = cursor_value.as_ref().and_then(|value| {
            value
                .get("sort")
                .and_then(serde_json::Value::as_str)
                .map(|sort_value| sort_value.to_string())
        });
        let normalized_model_family_filters =
            normalize_model_family_filters(model_family_filters);

        let mut sql = if sort.field == "id" {
            String::from(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name
                 FROM images
                 JOIN images_fts_tri ON images.id = images_fts_tri.rowid
                 WHERE images_fts_tri MATCH ?",
            )
        } else {
            format!(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, {} AS sort_value
                 FROM images
                 JOIN images_fts_tri ON images.id = images_fts_tri.rowid
                 WHERE images_fts_tri MATCH ?",
                sort.sort_expr()
            )
        };
        let mut params_vec = vec![Value::Text(match_expr)];
        append_generation_type_filter(&mut sql, &mut params_vec, &normalized_generation_types);
        append_model_filter(&mut sql, &mut params_vec, model_filter, Some("images"));
        append_model_family_filter(
            &mut sql,
            &mut params_vec,
            &normalized_model_family_filters,
            Some("images"),
        );
        if let Some(cid) = cursor_id {
            if sort.field == "id" {
                sql.push_str(&format!(" AND images.id {} ?", sort.cursor_op()));
                params_vec.push(Value::Integer(cid));
            } else if let Some(sort_value) = cursor_sort {
                let op = sort.cursor_op();
                let sort_expr = sort.sort_expr();
                sql.push_str(&format!(
                    " AND ({} {} ? OR ({} = ? AND images.id {} ?))",
                    sort_expr, op, sort_expr, op
                ));
                params_vec.push(Value::Text(sort_value.clone()));
                params_vec.push(Value::Text(sort_value));
                params_vec.push(Value::Integer(cid));
            } else {
                sql.push_str(&format!(" AND images.id {} ?", sort.cursor_op()));
                params_vec.push(Value::Integer(cid));
            }
        }
        sql.push_str(&format!(" ORDER BY {} LIMIT ?", sort.order_clause()));
        params_vec.push(Value::Integer(limit as i64));

        let mut stmt = conn.prepare(&sql)?;
        if sort.field == "id" {
            let rows =
                stmt.query_map(params_from_iter(params_vec), gallery_image_record_from_row)?;
            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            let next_cursor = items
                .last()
                .map(|last| serde_json::json!({"id": last.id}).to_string());
            Ok(CursorPage { items, next_cursor })
        } else {
            let rows = stmt.query_map(params_from_iter(params_vec), |row| {
                Ok((
                    gallery_image_record_from_row(row)?,
                    row.get::<_, String>(8)?,
                ))
            })?;
            let mut items = Vec::new();
            let mut last_cursor = None::<(i64, String)>;
            for row in rows {
                let (record, sort_value) = row?;
                last_cursor = Some((record.id, sort_value));
                items.push(record);
            }
            let next_cursor = last_cursor.map(|(id, sort_value)| {
                serde_json::json!({"id": id, "sort": sort_value}).to_string()
            });
            Ok(CursorPage { items, next_cursor })
        }
    }

    /// Cursor-based filtering with tag include/exclude sets.
    pub fn filter_images_cursor(
        &self,
        query: Option<&str>,
        include_tags: &[String],
        exclude_tags: &[String],
        cursor: Option<&str>,
        limit: u32,
        generation_types: Option<&[String]>,
        sort_by: Option<&str>,
        model_filter: Option<&str>,
        model_family_filters: Option<&[String]>,
    ) -> SqlResult<CursorPage> {
        let porter = self.filter_images_cursor_porter(
            query,
            include_tags,
            exclude_tags,
            cursor,
            limit,
            generation_types,
            sort_by,
            model_filter,
            model_family_filters,
        )?;
        if !porter.items.is_empty() {
            return Ok(porter);
        }

        let Some(query) = query else {
            return Ok(porter);
        };
        if query.trim().is_empty() {
            return Ok(porter);
        }

        self.filter_images_cursor_trigram(
            query,
            include_tags,
            exclude_tags,
            cursor,
            limit,
            generation_types,
            sort_by,
            model_filter,
            model_family_filters,
        )
    }

    fn filter_images_cursor_porter(
        &self,
        query: Option<&str>,
        include_tags: &[String],
        exclude_tags: &[String],
        cursor: Option<&str>,
        limit: u32,
        generation_types: Option<&[String]>,
        sort_by: Option<&str>,
        model_filter: Option<&str>,
        model_family_filters: Option<&[String]>,
    ) -> SqlResult<CursorPage> {
        let conn = self.pool.get().map_err(pool_error)?;
        let sort = SortConfig::from_str(sort_by.unwrap_or("newest"));
        let cursor_value = cursor.and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok());
        let cursor_id = cursor_value
            .as_ref()
            .and_then(|value| value.get("id")?.as_i64());
        let cursor_sort = cursor_value.as_ref().and_then(|value| {
            value
                .get("sort")
                .and_then(serde_json::Value::as_str)
                .map(|sort_value| sort_value.to_string())
        });
        let normalized_generation_types = normalize_generation_types(generation_types);
        let normalized_model_family_filters =
            normalize_model_family_filters(model_family_filters);

        let mut sql = if sort.field == "id" {
            String::from(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name
                 FROM images
                 LEFT JOIN images_fts ON images.id = images_fts.rowid",
            )
        } else {
            format!(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, {} AS sort_value
                 FROM images
                 LEFT JOIN images_fts ON images.id = images_fts.rowid",
                sort.sort_expr()
            )
        };
        let mut params_vec = Vec::<Value>::new();

        let mut has_fts = false;
        if let Some(q) = query {
            let sanitized = sanitize_fts_query(q);
            if sanitized.is_empty() {
                return Ok(CursorPage {
                    items: Vec::new(),
                    next_cursor: None,
                });
            }
            sql.push_str(" WHERE images_fts MATCH ?");
            params_vec.push(Value::Text(sanitized));
            has_fts = true;
        } else {
            sql.push_str(" WHERE 1=1");
        }

        append_generation_type_filter(&mut sql, &mut params_vec, &normalized_generation_types);
        append_model_filter(&mut sql, &mut params_vec, model_filter, Some("images"));
        append_model_family_filter(
            &mut sql,
            &mut params_vec,
            &normalized_model_family_filters,
            Some("images"),
        );

        for tag in include_tags {
            sql.push_str(
                " AND EXISTS (
                    SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
                    WHERE it.image_id = images.id AND t.tag = ?
                )",
            );
            params_vec.push(Value::Text(tag.trim().to_ascii_lowercase()));
        }

        for tag in exclude_tags {
            sql.push_str(
                " AND NOT EXISTS (
                    SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
                    WHERE it.image_id = images.id AND t.tag = ?
                )",
            );
            params_vec.push(Value::Text(tag.trim().to_ascii_lowercase()));
        }

        if let Some(cid) = cursor_id {
            if sort.field == "id" {
                sql.push_str(&format!(" AND images.id {} ?", sort.cursor_op()));
                params_vec.push(Value::Integer(cid));
            } else if let Some(sort_value) = cursor_sort {
                let op = sort.cursor_op();
                let sort_expr = sort.sort_expr();
                sql.push_str(&format!(
                    " AND ({} {} ? OR ({} = ? AND images.id {} ?))",
                    sort_expr, op, sort_expr, op
                ));
                params_vec.push(Value::Text(sort_value.clone()));
                params_vec.push(Value::Text(sort_value));
                params_vec.push(Value::Integer(cid));
            } else {
                sql.push_str(&format!(" AND images.id {} ?", sort.cursor_op()));
                params_vec.push(Value::Integer(cid));
            }
        }

        let _ = has_fts;
        sql.push_str(&format!(" ORDER BY {} LIMIT ?", sort.order_clause()));
        params_vec.push(Value::Integer(limit as i64));

        let mut stmt = conn.prepare(&sql)?;
        if sort.field == "id" {
            let rows =
                stmt.query_map(params_from_iter(params_vec), gallery_image_record_from_row)?;
            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            let next_cursor = items
                .last()
                .map(|last| serde_json::json!({"id": last.id}).to_string());
            Ok(CursorPage { items, next_cursor })
        } else {
            let rows = stmt.query_map(params_from_iter(params_vec), |row| {
                Ok((
                    gallery_image_record_from_row(row)?,
                    row.get::<_, String>(8)?,
                ))
            })?;
            let mut items = Vec::new();
            let mut last_cursor = None::<(i64, String)>;
            for row in rows {
                let (record, sort_value) = row?;
                last_cursor = Some((record.id, sort_value));
                items.push(record);
            }
            let next_cursor = last_cursor.map(|(id, sort_value)| {
                serde_json::json!({"id": id, "sort": sort_value}).to_string()
            });
            Ok(CursorPage { items, next_cursor })
        }
    }

    fn filter_images_cursor_trigram(
        &self,
        query: &str,
        include_tags: &[String],
        exclude_tags: &[String],
        cursor: Option<&str>,
        limit: u32,
        generation_types: Option<&[String]>,
        sort_by: Option<&str>,
        model_filter: Option<&str>,
        model_family_filters: Option<&[String]>,
    ) -> SqlResult<CursorPage> {
        let conn = self.pool.get().map_err(pool_error)?;
        let sanitized = query.trim();
        if sanitized.is_empty() || !contains_search_token(sanitized) {
            return Ok(CursorPage {
                items: Vec::new(),
                next_cursor: None,
            });
        }

        let sort = SortConfig::from_str(sort_by.unwrap_or("newest"));
        let cursor_value = cursor.and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok());
        let cursor_id = cursor_value
            .as_ref()
            .and_then(|value| value.get("id")?.as_i64());
        let cursor_sort = cursor_value.as_ref().and_then(|value| {
            value
                .get("sort")
                .and_then(serde_json::Value::as_str)
                .map(|sort_value| sort_value.to_string())
        });
        let normalized_generation_types = normalize_generation_types(generation_types);
        let normalized_model_family_filters =
            normalize_model_family_filters(model_family_filters);

        let mut sql = if sort.field == "id" {
            String::from(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name
                 FROM images
                 JOIN images_fts_tri ON images.id = images_fts_tri.rowid
                 WHERE images_fts_tri MATCH ?",
            )
        } else {
            format!(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, {} AS sort_value
                 FROM images
                 JOIN images_fts_tri ON images.id = images_fts_tri.rowid
                 WHERE images_fts_tri MATCH ?",
                sort.sort_expr()
            )
        };
        let mut params_vec = vec![Value::Text(format!(
            "\"{}\"",
            sanitized.replace('"', "\"\"")
        ))];

        append_generation_type_filter(&mut sql, &mut params_vec, &normalized_generation_types);
        append_model_filter(&mut sql, &mut params_vec, model_filter, Some("images"));
        append_model_family_filter(
            &mut sql,
            &mut params_vec,
            &normalized_model_family_filters,
            Some("images"),
        );

        if let Some(cid) = cursor_id {
            if sort.field == "id" {
                sql.push_str(&format!(" AND images.id {} ?", sort.cursor_op()));
                params_vec.push(Value::Integer(cid));
            } else if let Some(sort_value) = cursor_sort {
                let op = sort.cursor_op();
                let sort_expr = sort.sort_expr();
                sql.push_str(&format!(
                    " AND ({} {} ? OR ({} = ? AND images.id {} ?))",
                    sort_expr, op, sort_expr, op
                ));
                params_vec.push(Value::Text(sort_value.clone()));
                params_vec.push(Value::Text(sort_value));
                params_vec.push(Value::Integer(cid));
            } else {
                sql.push_str(&format!(" AND images.id {} ?", sort.cursor_op()));
                params_vec.push(Value::Integer(cid));
            }
        }

        for tag in include_tags {
            sql.push_str(
                " AND EXISTS (
                    SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
                    WHERE it.image_id = images.id AND t.tag = ?
                )",
            );
            params_vec.push(Value::Text(tag.trim().to_ascii_lowercase()));
        }

        for tag in exclude_tags {
            sql.push_str(
                " AND NOT EXISTS (
                    SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
                    WHERE it.image_id = images.id AND t.tag = ?
                )",
            );
            params_vec.push(Value::Text(tag.trim().to_ascii_lowercase()));
        }

        sql.push_str(&format!(" ORDER BY {} LIMIT ?", sort.order_clause()));
        params_vec.push(Value::Integer(limit as i64));

        let mut stmt = conn.prepare(&sql)?;
        if sort.field == "id" {
            let rows =
                stmt.query_map(params_from_iter(params_vec), gallery_image_record_from_row)?;
            let mut items = Vec::new();
            for row in rows {
                items.push(row?);
            }
            let next_cursor = items
                .last()
                .map(|last| serde_json::json!({"id": last.id}).to_string());
            Ok(CursorPage { items, next_cursor })
        } else {
            let rows = stmt.query_map(params_from_iter(params_vec), |row| {
                Ok((
                    gallery_image_record_from_row(row)?,
                    row.get::<_, String>(8)?,
                ))
            })?;
            let mut items = Vec::new();
            let mut last_cursor = None::<(i64, String)>;
            for row in rows {
                let (record, sort_value) = row?;
                last_cursor = Some((record.id, sort_value));
                items.push(record);
            }
            let next_cursor = last_cursor.map(|(id, sort_value)| {
                serde_json::json!({"id": id, "sort": sort_value}).to_string()
            });
            Ok(CursorPage { items, next_cursor })
        }
    }

    // ────────────────────────── Tag queries ──────────────────────────

    /// Lists tags for autocomplete.
    pub fn list_tags(&self, prefix: Option<&str>, limit: u32) -> SqlResult<Vec<String>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut tags: Vec<String> = Vec::new();

        if let Some(prefix) = prefix {
            let mut stmt = conn.prepare(
                "SELECT tag FROM tags
                 WHERE tag LIKE ?1
                 ORDER BY tag ASC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(
                params![format!("{}%", prefix.trim().to_ascii_lowercase()), limit],
                |row: &Row<'_>| row.get::<_, String>(0),
            )?;
            for row in rows {
                tags.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT tag FROM tags
                 ORDER BY tag ASC
                 LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit], |row: &Row<'_>| row.get::<_, String>(0))?;
            for row in rows {
                tags.push(row?);
            }
        }

        Ok(tags)
    }

    /// Returns most common tags for quick filtering.
    pub fn get_top_tags(&self, limit: u32) -> SqlResult<Vec<TagCount>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt = conn.prepare(
            "SELECT tags.tag, COUNT(*) as usage_count
             FROM tags
             JOIN image_tags ON image_tags.tag_id = tags.id
             GROUP BY tags.id, tags.tag
             ORDER BY usage_count DESC, tags.tag ASC
             LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit], |row| {
            Ok(TagCount {
                tag: row.get::<_, String>(0)?,
                count: row.get::<_, u32>(1)?,
            })
        })?;

        let mut tags: Vec<TagCount> = Vec::new();
        for row in rows {
            tags.push(row?);
        }
        Ok(tags)
    }

    /// Returns tags attached to a specific image.
    pub fn get_tags_for_image(&self, image_id: i64) -> SqlResult<Vec<String>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt = conn.prepare(
            "SELECT tags.tag
             FROM image_tags
             JOIN tags ON tags.id = image_tags.tag_id
             WHERE image_tags.image_id = ?1
             ORDER BY tags.tag ASC",
        )?;
        let rows = stmt.query_map(params![image_id], |row: &Row<'_>| row.get::<_, String>(0))?;

        let mut tags: Vec<String> = Vec::new();
        for row in rows {
            tags.push(row?);
        }
        Ok(tags)
    }

    // ────────────────────── Group-by queries ──────────────────────

    /// Returns unique directories with image counts for group-by view.
    pub fn get_unique_directories(&self) -> SqlResult<Vec<DirectoryEntry>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt = conn.prepare(
            "SELECT directory, COUNT(*) as cnt
             FROM images
             GROUP BY directory
             ORDER BY cnt DESC, directory ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DirectoryEntry {
                directory: row.get::<_, String>(0)?,
                count: row.get::<_, u32>(1)?,
            })
        })?;

        let mut dirs = Vec::new();
        for row in rows {
            dirs.push(row?);
        }
        Ok(dirs)
    }

    /// Returns unique model names with image counts for group-by view.
    pub fn get_unique_models(&self) -> SqlResult<Vec<ModelEntry>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt = conn.prepare(
            "SELECT COALESCE(model_name, 'Unknown') as model, COUNT(*) as cnt
             FROM images
             GROUP BY model
             ORDER BY cnt DESC, model ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(ModelEntry {
                model_name: row.get::<_, String>(0)?,
                count: row.get::<_, u32>(1)?,
            })
        })?;

        let mut models = Vec::new();
        for row in rows {
            models.push(row?);
        }
        Ok(models)
    }

    // ────────────────────────── By-id queries ──────────────────────────

    /// Fetches records by explicit ids (used by export).
    pub fn get_images_by_ids(&self, ids: &[i64]) -> SqlResult<Vec<ImageRecord>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.pool.get().map_err(pool_error)?;
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "SELECT id, filepath, filename, directory, prompt, negative_prompt,
                    steps, sampler, cfg_scale, seed, width, height,
                    model_hash, model_name, raw_metadata
             FROM images
             WHERE id IN ({})
             ORDER BY id DESC",
            placeholders
        );

        let params: Vec<Value> = ids.iter().map(|id| Value::Integer(*id)).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params), image_record_from_row)?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Returns total indexed image count.
    pub fn get_total_count(&self) -> SqlResult<u32> {
        let conn = self.pool.get().map_err(pool_error)?;
        conn.query_row("SELECT COUNT(*) FROM images", [], |row| {
            row.get::<_, u32>(0)
        })
    }

    /// Returns all indexed source image paths ordered newest-first.
    pub fn get_all_image_filepaths_desc(&self) -> SqlResult<Vec<String>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt = conn.prepare("SELECT filepath FROM images ORDER BY id DESC")?;
        let rows = stmt.query_map([], |row: &Row<'_>| row.get::<_, String>(0))?;

        let mut filepaths = Vec::new();
        for row in rows {
            filepaths.push(row?);
        }
        Ok(filepaths)
    }

    /// Returns a single image by id.
    pub fn get_image_by_id(&self, id: i64) -> SqlResult<Option<ImageRecord>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt = conn.prepare(
            "SELECT id, filepath, filename, directory, prompt, negative_prompt,
                    steps, sampler, cfg_scale, seed, width, height,
                    model_hash, model_name, raw_metadata
             FROM images
             WHERE id = ?1
             LIMIT 1",
        )?;

        let mut rows = stmt.query_map(params![id], image_record_from_row)?;
        match rows.next() {
            Some(Ok(record)) => Ok(Some(record)),
            _ => Ok(None),
        }
    }

    // ────────────────────── Offset-based (legacy) ──────────────────────

    fn query_images(
        &self,
        query: Option<&str>,
        include_tags: &[String],
        exclude_tags: &[String],
        limit: u32,
        offset: u32,
    ) -> SqlResult<Vec<ImageRecord>> {
        let porter_results =
            self.query_images_porter(query, include_tags, exclude_tags, limit, offset)?;
        if !porter_results.is_empty() {
            return Ok(porter_results);
        }

        let Some(query) = query else {
            return Ok(porter_results);
        };
        if query.trim().is_empty() {
            return Ok(porter_results);
        }

        self.query_images_trigram(query, include_tags, exclude_tags, limit, offset)
    }

    fn query_images_porter(
        &self,
        query: Option<&str>,
        include_tags: &[String],
        exclude_tags: &[String],
        limit: u32,
        offset: u32,
    ) -> SqlResult<Vec<ImageRecord>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut sql = String::from(
            "SELECT images.id, images.filepath, images.filename, images.directory,
                    images.prompt, images.negative_prompt, images.steps, images.sampler,
                    images.cfg_scale, images.seed, images.width, images.height,
                    images.model_hash, images.model_name, images.raw_metadata
             FROM images",
        );
        let mut params = Vec::<Value>::new();

        let mut has_fts = false;
        if let Some(query) = query {
            let sanitized = sanitize_fts_query(query);
            if sanitized.is_empty() {
                return Ok(Vec::new());
            }
            sql.push_str(" JOIN images_fts ON images.id = images_fts.rowid");
            sql.push_str(" WHERE images_fts MATCH ?");
            params.push(Value::Text(sanitized));
            has_fts = true;
        } else {
            sql.push_str(" WHERE 1=1");
        }

        for tag in include_tags {
            sql.push_str(
                " AND EXISTS (
                    SELECT 1
                    FROM image_tags it
                    JOIN tags t ON t.id = it.tag_id
                    WHERE it.image_id = images.id
                      AND t.tag = ?
                )",
            );
            params.push(Value::Text(tag.trim().to_ascii_lowercase()));
        }

        for tag in exclude_tags {
            sql.push_str(
                " AND NOT EXISTS (
                    SELECT 1
                    FROM image_tags it
                    JOIN tags t ON t.id = it.tag_id
                    WHERE it.image_id = images.id
                      AND t.tag = ?
                )",
            );
            params.push(Value::Text(tag.trim().to_ascii_lowercase()));
        }

        if has_fts {
            sql.push_str(" ORDER BY images_fts.rank");
        } else {
            sql.push_str(" ORDER BY images.id DESC");
        }

        sql.push_str(" LIMIT ? OFFSET ?");
        params.push(Value::Integer(limit as i64));
        params.push(Value::Integer(offset as i64));

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params), image_record_from_row)?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    fn query_images_trigram(
        &self,
        query: &str,
        include_tags: &[String],
        exclude_tags: &[String],
        limit: u32,
        offset: u32,
    ) -> SqlResult<Vec<ImageRecord>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let sanitized = query.trim();
        if sanitized.is_empty() || !contains_search_token(sanitized) {
            return Ok(Vec::new());
        }

        let mut sql = String::from(
            "SELECT images.id, images.filepath, images.filename, images.directory,
                    images.prompt, images.negative_prompt, images.steps, images.sampler,
                    images.cfg_scale, images.seed, images.width, images.height,
                    images.model_hash, images.model_name, images.raw_metadata
             FROM images
             JOIN images_fts_tri ON images.id = images_fts_tri.rowid
             WHERE images_fts_tri MATCH ?",
        );
        let mut params = vec![Value::Text(format!(
            "\"{}\"",
            sanitized.replace('"', "\"\"")
        ))];

        for tag in include_tags {
            sql.push_str(
                " AND EXISTS (
                    SELECT 1
                    FROM image_tags it
                    JOIN tags t ON t.id = it.tag_id
                    WHERE it.image_id = images.id
                      AND t.tag = ?
                )",
            );
            params.push(Value::Text(tag.trim().to_ascii_lowercase()));
        }

        for tag in exclude_tags {
            sql.push_str(
                " AND NOT EXISTS (
                    SELECT 1
                    FROM image_tags it
                    JOIN tags t ON t.id = it.tag_id
                    WHERE it.image_id = images.id
                      AND t.tag = ?
                )",
            );
            params.push(Value::Text(tag.trim().to_ascii_lowercase()));
        }

        sql.push_str(" ORDER BY images.id DESC LIMIT ? OFFSET ?");
        params.push(Value::Integer(limit as i64));
        params.push(Value::Integer(offset as i64));

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params), image_record_from_row)?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
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
    let normalized = raw_model_filter.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return;
    }

    if let Some(prefix) = table_prefix {
        sql.push_str(&format!(" AND LOWER({}.model_name) = ?", prefix));
    } else {
        sql.push_str(" AND LOWER(model_name) = ?");
    }
    params.push(Value::Text(normalized));
}

const FAMILY_PATTERNS_PONYXL: &[&str] = &[
    "%ponyxl%",
    "%pony xl%",
    "%pony diffusion%",
    "%pony%",
];
const FAMILY_PATTERNS_SDXL: &[&str] = &["%sdxl%", "%stable diffusion xl%"];
const FAMILY_PATTERNS_FLUX: &[&str] = &["%flux%"];
const FAMILY_PATTERNS_ZIMAGE_TURBO: &[&str] = &[
    "%z-image turbo%",
    "%zimage turbo%",
    "%z-image%",
    "%zimage%",
];
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

        let results = db.search("cat hero", 10, 0).expect("search failed");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].filepath, "a.png");
    }

    #[test]
    fn test_filter_images_by_include_and_exclude_tags() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");
        insert_with_prompt(&db, "a.png", "cat hero portrait", &["cat", "hero"]);
        insert_with_prompt(&db, "b.png", "cat landscape", &["cat", "landscape"]);

        let include = vec!["cat".to_string()];
        let exclude = vec!["landscape".to_string()];
        let results = db
            .filter_images(None, &include, &exclude, 10, 0)
            .expect("filter failed");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].filepath, "a.png");
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

        let results = db
            .search_trigram("cat", 10, 0)
            .expect("trigram search failed");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].filepath, "a.png");
    }

    #[test]
    fn test_filter_images_falls_back_to_trigram_for_substring_queries() {
        let db = Database::new(Path::new(":memory:"), StorageProfile::Hdd)
            .expect("failed to create in-memory db");
        insert_with_prompt(&db, "a.png", "donald trump portrait", &["portrait"]);
        insert_with_prompt(&db, "b.png", "landscape painting", &["landscape"]);

        let include = vec!["portrait".to_string()];
        let results = db
            .filter_images(Some("ump"), &include, &[], 10, 0)
            .expect("filter failed");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].filepath, "a.png");
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
}
