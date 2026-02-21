use super::*;

impl Database {
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

    /// Deletes images by id and prunes orphaned tags in one transaction.
    pub fn delete_images_by_ids(&self, ids: &[i64]) -> SqlResult<usize> {
        if ids.is_empty() {
            return Ok(0);
        }

        let mut conn = self.pool.get().map_err(pool_error)?;
        let tx = conn.transaction()?;
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!("DELETE FROM images WHERE id IN ({})", placeholders);
        let params: Vec<Value> = ids.iter().map(|id| Value::Integer(*id)).collect();
        let deleted = tx.execute(&sql, params_from_iter(params))?;

        tx.execute(
            "DELETE FROM tags
             WHERE id NOT IN (
                SELECT DISTINCT tag_id FROM image_tags
             )",
            [],
        )?;

        tx.commit()?;
        Ok(deleted)
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

    pub fn set_image_favorite(&self, image_id: i64, is_favorite: bool) -> SqlResult<()> {
        let conn = self.pool.get().map_err(pool_error)?;
        conn.execute(
            "UPDATE images SET is_favorite = ?1 WHERE id = ?2",
            params![is_favorite, image_id],
        )?;
        Ok(())
    }

    pub fn set_images_favorite(&self, ids: &[i64], is_favorite: bool) -> SqlResult<usize> {
        if ids.is_empty() {
            return Ok(0);
        }

        let conn = self.pool.get().map_err(pool_error)?;
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "UPDATE images SET is_favorite = ? WHERE id IN ({})",
            placeholders
        );
        let mut params: Vec<Value> = Vec::with_capacity(ids.len() + 1);
        params.push(Value::Integer(if is_favorite { 1 } else { 0 }));
        params.extend(ids.iter().map(|id| Value::Integer(*id)));
        conn.execute(&sql, params_from_iter(params))
    }

    pub fn set_image_locked(&self, image_id: i64, is_locked: bool) -> SqlResult<()> {
        let conn = self.pool.get().map_err(pool_error)?;
        conn.execute(
            "UPDATE images SET is_locked = ?1 WHERE id = ?2",
            params![is_locked, image_id],
        )?;
        Ok(())
    }

    pub fn set_images_locked(&self, ids: &[i64], is_locked: bool) -> SqlResult<usize> {
        if ids.is_empty() {
            return Ok(0);
        }

        let conn = self.pool.get().map_err(pool_error)?;
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "UPDATE images SET is_locked = ? WHERE id IN ({})",
            placeholders
        );
        let mut params: Vec<Value> = Vec::with_capacity(ids.len() + 1);
        params.push(Value::Integer(if is_locked { 1 } else { 0 }));
        params.extend(ids.iter().map(|id| Value::Integer(*id)));
        conn.execute(&sql, params_from_iter(params))
    }

    pub fn update_image_location(
        &self,
        image_id: i64,
        filepath: &str,
        filename: &str,
        directory: &str,
    ) -> SqlResult<bool> {
        let conn = self.pool.get().map_err(pool_error)?;
        let updated = conn.execute(
            "UPDATE images
             SET filepath = ?1, filename = ?2, directory = ?3
             WHERE id = ?4",
            params![filepath, filename, directory, image_id],
        )?;
        Ok(updated > 0)
    }
}
