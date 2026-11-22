use super::*;

/// `(model_name, prompt, extra_params_raw)` for one indexed image.
type AssetReferenceRow = (Option<String>, String, Option<String>);

/// A group of images sharing the same quick_hash (exact duplicates).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DuplicateGroup {
    pub quick_hash: String,
    pub count: u32,
    pub sample_filepaths: Vec<String>,
}

/// Exact production SQL for the top-tags hot query. The EXPLAIN test in
/// `database.rs` reuses this const so the plan it asserts is the plan we ship.
pub(crate) const TOP_TAGS_SQL: &str = "SELECT tags.tag, COUNT(*) as usage_count
             FROM tags
             JOIN image_tags INDEXED BY idx_image_tags_tag_id_image_id ON image_tags.tag_id = tags.id
             JOIN images_live ON images_live.id = image_tags.image_id
             GROUP BY tags.id, tags.tag
             ORDER BY usage_count DESC, tags.tag ASC
             LIMIT ?1";

impl Database {
    /// Returns (model_name, prompt, extra_params_raw) for images in the given directories.
    /// An empty `dirs` list returns rows for every indexed image.
    /// Bad rows are skipped, never panicked on.
    pub fn get_asset_reference_rows(&self, dirs: &[String]) -> SqlResult<Vec<AssetReferenceRow>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let cleaned: Vec<String> = dirs
            .iter()
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .collect();

        let sql = if cleaned.is_empty() {
            "SELECT model_name, prompt, extra_params FROM images_live".to_string()
        } else {
            let placeholders = vec!["?"; cleaned.len()].join(", ");
            format!(
                "SELECT model_name, prompt, extra_params FROM images_live WHERE directory IN ({})",
                placeholders
            )
        };
        let params: Vec<Value> = cleaned.iter().map(|d| Value::Text(d.clone())).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params), |row| {
            let model_name: Option<String> = row.get::<_, Option<String>>(0).unwrap_or(None);
            let prompt: String = row
                .get::<_, Option<String>>(1)
                .unwrap_or(None)
                .unwrap_or_default();
            let extra_params: Option<String> = row.get::<_, Option<String>>(2).unwrap_or(None);
            Ok((model_name, prompt, extra_params))
        })?;

        let mut out = Vec::new();
        for row in rows {
            match row {
                Ok(r) => out.push(r),
                Err(_) => continue,
            }
        }
        Ok(out)
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
        let mut stmt = conn.prepare(TOP_TAGS_SQL)?;

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
             JOIN images_live ON images_live.id = image_tags.image_id
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
             FROM images_live
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
             FROM images_live
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

    // ────────────────────── Duplicate detection ──────────────────────

    /// Returns groups of images sharing the same quick_hash, ordered by
    /// group size descending. NULL and singleton hashes are excluded.
    /// Uses the idx_images_quick_hash index for the grouping scan.
    pub fn get_duplicate_groups(&self, limit: u32, offset: u32) -> SqlResult<Vec<DuplicateGroup>> {
        let conn = self.pool.get().map_err(pool_error)?;

        let mut stmt = conn.prepare(
            "SELECT quick_hash, COUNT(*) as cnt
             FROM images_live
             WHERE quick_hash IS NOT NULL
             GROUP BY quick_hash
             HAVING COUNT(*) > 1
             ORDER BY cnt DESC, quick_hash ASC
             LIMIT ?1 OFFSET ?2",
        )?;
        let rows = stmt.query_map(params![limit, offset], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
        })?;

        let mut hashes: Vec<(String, u32)> = Vec::new();
        for row in rows {
            hashes.push(row?);
        }

        let mut groups: Vec<DuplicateGroup> = Vec::with_capacity(hashes.len());
        for (quick_hash, count) in hashes {
            let mut sample_stmt = conn.prepare(
                "SELECT filepath FROM images_live
                 WHERE quick_hash = ?1
                 ORDER BY file_mtime DESC
                 LIMIT 5",
            )?;
            let sample_rows =
                sample_stmt.query_map(params![quick_hash], |row| row.get::<_, String>(0))?;
            let mut sample_filepaths: Vec<String> = Vec::new();
            for row in sample_rows {
                sample_filepaths.push(row?);
            }
            groups.push(DuplicateGroup {
                quick_hash,
                count,
                sample_filepaths,
            });
        }
        Ok(groups)
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
                    model_hash, model_name, raw_metadata, is_favorite, is_locked,
                    schedule_type, extra_params, text_chunks
             FROM images_live
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
        conn.query_row("SELECT COUNT(*) FROM images_live", [], |row| {
            row.get::<_, u32>(0)
        })
    }

    /// Returns all indexed source image paths ordered newest-first.
    pub fn get_all_image_filepaths_desc(&self) -> SqlResult<Vec<String>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt = conn.prepare("SELECT filepath FROM images_live ORDER BY id DESC")?;
        let rows = stmt.query_map([], |row: &Row<'_>| row.get::<_, String>(0))?;

        let mut filepaths = Vec::new();
        for row in rows {
            filepaths.push(row?);
        }
        Ok(filepaths)
    }

    pub fn get_image_filepaths_batch_after(
        &self,
        after: Option<&str>,
        limit: u32,
    ) -> SqlResult<Vec<String>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut filepaths = Vec::new();
        if let Some(cursor) = after {
            let mut stmt = conn.prepare(
                "SELECT filepath FROM images_live WHERE filepath > ?1 ORDER BY filepath ASC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![cursor, limit], |row| row.get::<_, String>(0))?;
            for row in rows {
                filepaths.push(row?);
            }
        } else {
            let mut stmt =
                conn.prepare("SELECT filepath FROM images_live ORDER BY filepath ASC LIMIT ?1")?;
            let rows = stmt.query_map(params![limit], |row| row.get::<_, String>(0))?;
            for row in rows {
                filepaths.push(row?);
            }
        }
        Ok(filepaths)
    }

    /// Returns a single image by id.
    pub fn get_image_by_id(&self, id: i64) -> SqlResult<Option<ImageRecord>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt = conn.prepare(
            "SELECT id, filepath, filename, directory, prompt, negative_prompt,
                    steps, sampler, cfg_scale, seed, width, height,
                    model_hash, model_name, raw_metadata, is_favorite, is_locked,
                    schedule_type, extra_params, text_chunks
             FROM images_live
             WHERE id = ?1
             LIMIT 1",
        )?;

        let mut rows = stmt.query_map(params![id], image_record_from_row)?;
        match rows.next() {
            Some(Ok(record)) => Ok(Some(record)),
            _ => Ok(None),
        }
    }

    /// Live deletion-protection probe for TOCTOU re-checks.
    /// Reads the current `is_locked` value straight from `images` (not the
    /// `images_live` view); `NULL` counts as unlocked.
    pub fn is_image_locked_live(&self, id: i64) -> SqlResult<bool> {
        let conn = self.pool.get().map_err(pool_error)?;
        let locked: i64 = conn.query_row(
            "SELECT COALESCE(is_locked, 0) FROM images WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        Ok(locked != 0)
    }

    /// Counts indexed images sharing the same file stem in the given directory.
    pub fn count_images_with_stem(&self, directory: &str, stem: &str) -> SqlResult<usize> {
        let conn = self.pool.get().map_err(pool_error)?;
        let escaped_stem = stem
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("{}.%", escaped_stem);
        let mut stmt = conn.prepare_cached(
            "SELECT filename FROM images_live WHERE directory = ?1 AND (filename = ?2 OR filename LIKE ?3 ESCAPE '\\')",
        )?;
        let rows = stmt.query_map(params![directory, stem, pattern], |row| {
            row.get::<_, String>(0)
        })?;
        let mut count = 0;
        let target_stem_lower = stem.to_lowercase();
        for row in rows {
            let filename = row?;
            if let Some(s) = Path::new(&filename).file_stem().and_then(|s| s.to_str()) {
                let matches = if cfg!(windows) {
                    s.to_lowercase() == target_stem_lower
                } else {
                    s == stem
                };
                if matches {
                    count += 1;
                }
            }
        }
        Ok(count)
    }
}

#[cfg(test)]
mod duplicate_groups {
    use super::*;
    use crate::StorageProfile;

    fn mem_db() -> Database {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tid = std::thread::current().id();
        let path = std::env::temp_dir().join(format!(
            "forge_dup_test_{}_{}_{:?}.db",
            std::process::id(),
            nanos,
            tid
        ));
        Database::new(&path, StorageProfile::Hdd).expect("mem db")
    }

    fn insert_with_hash(db: &Database, filepath: &str, hash: Option<&str>, mtime: i64) {
        let conn = db.pool_get_for_test().expect("conn");
        let filename = filepath.rsplit('/').next().unwrap_or(filepath);
        conn.execute(
            "INSERT INTO images(filepath, filename, directory, prompt, quick_hash, file_mtime)
             VALUES (?1, ?2, '/', 'p', ?3, ?4)",
            params![filepath, filename, hash, mtime],
        )
        .expect("insert");
    }

    #[test]
    fn duplicate_groups_orders_and_excludes_singletons_and_nulls() {
        let db = mem_db();
        insert_with_hash(&db, "/a1.png", Some("dup_a"), 100);
        insert_with_hash(&db, "/a2.png", Some("dup_a"), 200);
        insert_with_hash(&db, "/a3.png", Some("dup_a"), 300);
        insert_with_hash(&db, "/b1.png", Some("dup_b"), 100);
        insert_with_hash(&db, "/b2.png", Some("dup_b"), 50);
        insert_with_hash(&db, "/solo.png", Some("solo"), 100);
        insert_with_hash(&db, "/null.png", None, 100);

        let groups = db.get_duplicate_groups(100, 0).expect("groups");
        assert_eq!(
            groups.len(),
            2,
            "singletons and NULL hashes must be excluded"
        );
        assert_eq!(groups[0].quick_hash, "dup_a");
        assert_eq!(groups[0].count, 3);
        assert_eq!(groups[1].quick_hash, "dup_b");
        assert_eq!(groups[1].count, 2);
        assert_eq!(groups[0].sample_filepaths.len(), 3);
        assert_eq!(
            groups[0].sample_filepaths[0], "/a3.png",
            "samples must be newest-first by file_mtime"
        );
    }

    #[test]
    fn duplicate_groups_respects_limit_and_offset() {
        let db = mem_db();
        for i in 0..3 {
            insert_with_hash(&db, &format!("/x{}.png", i), Some("hash_big"), i);
        }
        for i in 0..2 {
            insert_with_hash(&db, &format!("/y{}.png", i), Some("hash_mid"), i);
        }
        for i in 0..2 {
            insert_with_hash(&db, &format!("/z{}.png", i), Some("hash_low"), i);
        }

        let first = db.get_duplicate_groups(1, 0).expect("limit 1");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].quick_hash, "hash_big");
        assert_eq!(first[0].count, 3);

        let rest = db.get_duplicate_groups(10, 1).expect("offset 1");
        assert_eq!(rest.len(), 2, "offset must skip the first group");
        assert_eq!(rest[0].quick_hash, "hash_low");
        assert_eq!(rest[1].quick_hash, "hash_mid");
    }

    #[test]
    fn duplicate_groups_empty_db_returns_empty() {
        let db = mem_db();
        let groups = db.get_duplicate_groups(100, 0).expect("groups");
        assert!(groups.is_empty());
    }

    fn insert_test_image(db: &Database, directory: &str, filename: &str) {
        let conn = db.pool_get_for_test().expect("conn");
        let filepath = format!("{}/{}", directory, filename);
        conn.execute(
            "INSERT INTO images(filepath, filename, directory, prompt, quick_hash, file_mtime)
             VALUES (?1, ?2, ?3, 'p', NULL, 100)",
            params![filepath, filename, directory],
        )
        .expect("insert");
    }

    #[test]
    fn test_count_images_with_stem() {
        let db = mem_db();
        insert_test_image(&db, "C:/images", "test.png");
        insert_test_image(&db, "C:/images", "test.webp");
        insert_test_image(&db, "C:/images", "other.png");
        insert_test_image(&db, "D:/images", "test.png");

        assert_eq!(db.count_images_with_stem("C:/images", "test").unwrap(), 2);
        assert_eq!(db.count_images_with_stem("C:/images", "other").unwrap(), 1);
        assert_eq!(
            db.count_images_with_stem("C:/images", "nonexistent")
                .unwrap(),
            0
        );
        assert_eq!(db.count_images_with_stem("D:/images", "test").unwrap(), 1);
    }

    #[test]
    fn test_count_images_with_stem_shares_case_insensitive_windows() {
        let db = mem_db();
        insert_test_image(&db, "C:/images", "A.png");
        insert_test_image(&db, "C:/images", "a.webp");

        let count_upper = db.count_images_with_stem("C:/images", "A").unwrap();
        let count_lower = db.count_images_with_stem("C:/images", "a").unwrap();

        if cfg!(windows) {
            assert_eq!(count_upper, 2, "A.png and a.webp share stem on Windows");
            assert_eq!(count_lower, 2, "A.png and a.webp share stem on Windows");
        } else {
            assert_eq!(count_upper, 1);
            assert_eq!(count_lower, 1);
        }
    }
}

#[cfg(test)]
mod schedule_extra_parity {
    use super::*;
    use crate::parser::GenerationParams;
    use crate::StorageProfile;
    use std::collections::HashMap;

    fn temp_db(tag: &str) -> Database {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "forge_parity_{tag}_{}_{nanos}.db",
            std::process::id()
        ));
        Database::new(&path, StorageProfile::Hdd).expect("temp db")
    }

    fn parity_params() -> GenerationParams {
        let mut extra = HashMap::new();
        extra.insert("distilled_cfg_scale".to_string(), "6.5".to_string());
        extra.insert(
            "img2img_background_color".to_string(),
            "(255,255,255)".to_string(),
        );
        GenerationParams {
            prompt: "parity probe".to_string(),
            raw_metadata: "parity probe".to_string(),
            schedule_type: Some("karras".to_string()),
            extra_params: extra,
            ..Default::default()
        }
    }

    #[test]
    fn by_id_readers_return_schedule_type_and_extra_params() {
        let db = temp_db("ok");
        let id = db
            .upsert_image(
                "/parity/a.png",
                "a.png",
                "/parity",
                &parity_params(),
                Some(1),
            )
            .expect("upsert");

        let by_id = db
            .get_image_by_id(id)
            .expect("get_image_by_id")
            .expect("row missing");
        assert_eq!(by_id.schedule_type.as_deref(), Some("karras"));
        let extra = by_id.extra_params.as_ref().expect("extra_params missing");
        assert_eq!(
            extra.get("distilled_cfg_scale").map(String::as_str),
            Some("6.5")
        );
        assert_eq!(
            extra.get("img2img_background_color").map(String::as_str),
            Some("(255,255,255)")
        );

        let by_ids = db.get_images_by_ids(&[id]).expect("get_images_by_ids");
        assert_eq!(by_ids.len(), 1);
        assert_eq!(by_ids[0].schedule_type.as_deref(), Some("karras"));
        assert_eq!(by_ids[0].extra_params, by_id.extra_params);
    }

    #[test]
    fn corrupt_or_absent_extra_params_json_reads_as_none() {
        let db = temp_db("corrupt");
        let id = db
            .upsert_image(
                "/parity/b.png",
                "b.png",
                "/parity",
                &parity_params(),
                Some(1),
            )
            .expect("upsert");

        let conn = db.pool_get_for_test().expect("conn");
        conn.execute(
            "UPDATE images SET extra_params = 'not-json{{{' WHERE id = ?1",
            params![id],
        )
        .expect("corrupt extra_params");

        let corrupt = db
            .get_image_by_id(id)
            .expect("get_image_by_id")
            .expect("row missing");
        assert_eq!(corrupt.extra_params, None);
        assert_eq!(
            corrupt.schedule_type.as_deref(),
            Some("karras"),
            "a bad extra_params cell must not fail the row read"
        );
        let corrupt_batch = db.get_images_by_ids(&[id]).expect("get_images_by_ids");
        assert_eq!(corrupt_batch.len(), 1);
        assert_eq!(corrupt_batch[0].extra_params, None);

        conn.execute(
            "UPDATE images SET extra_params = NULL WHERE id = ?1",
            params![id],
        )
        .expect("null extra_params");
        let nulled = db
            .get_image_by_id(id)
            .expect("get_image_by_id")
            .expect("row missing");
        assert_eq!(nulled.extra_params, None);
    }

    #[test]
    fn text_chunks_round_trip_through_both_by_id_readers() {
        let db = temp_db("chunks");
        let mut params = parity_params();
        params.text_chunks.insert(
            "parameters".to_string(),
            "a\nSteps: 1, Sampler: Euler".to_string(),
        );
        params
            .text_chunks
            .insert("comment".to_string(), "from ztxt".to_string());
        params
            .text_chunks
            .insert("description".to_string(), "from itxt".to_string());
        let id = db
            .upsert_image("/parity/c.png", "c.png", "/parity", &params, Some(1))
            .expect("upsert");

        for record in [
            db.get_image_by_id(id)
                .expect("get_image_by_id")
                .expect("row missing"),
            db.get_images_by_ids(&[id])
                .expect("get_images_by_ids")
                .into_iter()
                .next()
                .expect("row missing"),
        ] {
            let chunks = record.text_chunks.as_ref().expect("text_chunks missing");
            assert_eq!(
                chunks.get("parameters").map(String::as_str),
                Some("a\nSteps: 1, Sampler: Euler")
            );
            assert_eq!(chunks.get("comment").map(String::as_str), Some("from ztxt"));
            assert_eq!(
                chunks.get("description").map(String::as_str),
                Some("from itxt")
            );
        }

        // Bulk path persists text_chunks too.
        let mut bulk_params = parity_params();
        bulk_params
            .text_chunks
            .insert("parameters".to_string(), "bulk".to_string());
        let bulk_record = crate::database::BulkRecord {
            filepath: "/parity/bulk.png".to_string(),
            filename: "bulk.png".to_string(),
            directory: "/parity".to_string(),
            params: bulk_params,
            file_mtime: Some(2),
            file_size: None,
            quick_hash: None,
            tags: Vec::new(),
        };
        let inserted = db
            .bulk_upsert_with_tags(std::slice::from_ref(&bulk_record))
            .expect("bulk upsert");
        assert_eq!(inserted, 1);
        let bulk_id = db
            .get_image_id_by_filepath("/parity/bulk.png")
            .expect("lookup")
            .expect("row missing");
        let bulk_row = db
            .get_image_by_id(bulk_id)
            .expect("get_image_by_id")
            .expect("row missing");
        assert_eq!(
            bulk_row
                .text_chunks
                .as_ref()
                .and_then(|m| m.get("parameters"))
                .map(String::as_str),
            Some("bulk")
        );
    }

    #[test]
    fn corrupt_or_absent_text_chunks_json_reads_as_none() {
        let db = temp_db("chunks-corrupt");
        let mut params = parity_params();
        params
            .text_chunks
            .insert("parameters".to_string(), "x".to_string());
        let id = db
            .upsert_image("/parity/d.png", "d.png", "/parity", &params, Some(1))
            .expect("upsert");

        let conn = db.pool_get_for_test().expect("conn");
        conn.execute(
            "UPDATE images SET text_chunks = 'not-json{{{' WHERE id = ?1",
            params![id],
        )
        .expect("corrupt text_chunks");

        for record in [
            db.get_image_by_id(id)
                .expect("get_image_by_id")
                .expect("row missing"),
            db.get_images_by_ids(&[id])
                .expect("get_images_by_ids")
                .into_iter()
                .next()
                .expect("row missing"),
        ] {
            assert_eq!(record.text_chunks, None);
            assert_eq!(
                record.schedule_type.as_deref(),
                Some("karras"),
                "a bad text_chunks cell must not fail the row read"
            );
        }

        conn.execute(
            "UPDATE images SET text_chunks = NULL WHERE id = ?1",
            params![id],
        )
        .expect("null text_chunks");
        let nulled = db
            .get_image_by_id(id)
            .expect("get_image_by_id")
            .expect("row missing");
        assert_eq!(nulled.text_chunks, None);
    }
}

#[cfg(test)]
mod live_lock_probe {
    use super::*;
    use crate::StorageProfile;

    fn temp_db(tag: &str) -> Database {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "forge_livelock_{tag}_{}_{nanos}.db",
            std::process::id()
        ));
        Database::new(&path, StorageProfile::Hdd).expect("temp db")
    }

    #[test]
    fn is_image_locked_live_tracks_locks_set_after_initial_resolve() {
        let db = temp_db("probe");
        let conn = db.pool_get_for_test().expect("conn");
        conn.execute(
            "INSERT INTO images(filepath, filename, directory, prompt, quick_hash, file_mtime)
             VALUES ('/live/a.png', 'a.png', '/live', 'p', NULL, 100)",
            [],
        )
        .expect("insert");
        let id: i64 = conn.last_insert_rowid();
        drop(conn);

        // Initial resolve sees the row unlocked (stale snapshot analogue).
        let stale = db.get_images_by_ids(&[id]).expect("resolve");
        assert_eq!(stale.len(), 1);
        assert!(!stale[0].is_locked);
        assert!(!db.is_image_locked_live(id).expect("probe"));

        // Lock lands after the initial resolve: the live probe must see it.
        db.set_image_locked(id, true).expect("lock");
        assert!(db.is_image_locked_live(id).expect("probe locked"));

        // Unlock is visible too; a missing row surfaces an error.
        db.set_image_locked(id, false).expect("unlock");
        assert!(!db.is_image_locked_live(id).expect("probe unlocked"));
        assert!(db.is_image_locked_live(id + 10_000).is_err());
    }
}
