use super::*;

impl Database {
    // ────────────────────────────── Bulk Operations ──────────────────────────────

    /// Fetches all stored file mtimes in a single query for fast lookup.
    /// Returns a HashMap<filepath, mtime> enabling O(1) changed-file detection.
    /// Culled (tombstoned) rows are excluded so a file restored from the OS trash
    /// with an unchanged mtime is re-processed and resurrected instead of skipped.
    pub fn get_all_file_mtimes(&self) -> SqlResult<HashMap<String, i64>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut stmt =
            conn.prepare("SELECT filepath, file_mtime FROM images WHERE file_mtime IS NOT NULL AND culled_at IS NULL")?;
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

    /// Batch upsert images and their tags (and optional lineage edges) in a single transaction.
    /// Returns the inserted/updated image ids.
    pub fn bulk_upsert_with_lineage(&self, items: &[BulkRecordWithLineage]) -> SqlResult<Vec<i64>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = self.pool.get().map_err(pool_error)?;
        let mut inserted_ids = Vec::with_capacity(items.len());
        let mut tag_id_cache: HashMap<String, i64> = HashMap::with_capacity(4096);

        for chunk in items.chunks(500) {
            let tx = conn.transaction()?;
            {
                let mut upsert_image_stmt = tx.prepare_cached(
                    "INSERT INTO images
                        (filepath, filename, directory, prompt, negative_prompt, steps, sampler,
                         schedule_type, cfg_scale, seed, seed_int, width, height, model_hash, model_name,
                         generation_type, raw_metadata, extra_params, file_mtime, file_size, quick_hash)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
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
                         seed_int=excluded.seed_int,
                         width=excluded.width,
                         height=excluded.height,
                         model_hash=excluded.model_hash,
                         model_name=excluded.model_name,
                         generation_type=excluded.generation_type,
                         raw_metadata=excluded.raw_metadata,
                         extra_params=excluded.extra_params,
                         file_mtime=excluded.file_mtime,
                         file_size=excluded.file_size,
                         quick_hash=excluded.quick_hash,
                         culled_at=NULL,
                         ghost_recipe=NULL
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
                let mut insert_lineage_edge_stmt = tx.prepare_cached(
                    "INSERT INTO lineage_edges (child_id, parent_id, ops_json, source)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(child_id, parent_id, source) DO UPDATE SET
                         ops_json = excluded.ops_json",
                )?;

                for item in chunk {
                    let record = &item.record;
                    let extra =
                        serde_json::to_string(&record.params.extra_params).unwrap_or_default();
                    let generation_type = record
                        .params
                        .generation_type
                        .clone()
                        .unwrap_or_else(|| infer_generation_type(&record.params.raw_metadata));
                    let seed_int: Option<i64> =
                        record.params.seed.as_deref().and_then(parse_seed_int);

                    demote_stale_culled_row(&tx, &record.filepath, record.quick_hash.as_deref())?;

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
                            seed_int,
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
                                .query_row(params![normalized.as_str()], |row| {
                                    row.get::<_, i64>(0)
                                })?;
                            tag_id_cache.insert(normalized.clone(), created_or_existing);
                            created_or_existing
                        };

                        insert_image_tag_stmt.execute(params![id, tag_id])?;
                    }

                    if let Some(edge) = &item.edge {
                        insert_lineage_edge_stmt.execute(params![
                            id,
                            edge.parent_id,
                            edge.ops_json,
                            edge.source
                        ])?;
                    }

                    inserted_ids.push(id);
                }
            }

            tx.commit()?;
        }

        Ok(inserted_ids)
    }

    /// Batch upsert images and their tags in a single transaction.
    /// Dramatically faster than individual upserts (10-50x for large libraries)
    /// because SQLite only syncs to disk once at commit time.
    pub fn bulk_upsert_with_tags(&self, records: &[BulkRecord]) -> SqlResult<usize> {
        let items: Vec<BulkRecordWithLineage> = records
            .iter()
            .cloned()
            .map(|record| BulkRecordWithLineage { record, edge: None })
            .collect();
        self.bulk_upsert_with_lineage(&items).map(|ids| ids.len())
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

        let seed_int: Option<i64> = params.seed.as_deref().and_then(parse_seed_int);

        conn.query_row(
            "INSERT INTO images
                (filepath, filename, directory, prompt, negative_prompt, steps, sampler,
                 schedule_type, cfg_scale, seed, seed_int, width, height, model_hash, model_name,
                 generation_type, raw_metadata, extra_params, file_mtime, file_size, quick_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
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
                 seed_int=excluded.seed_int,
                 width=excluded.width,
                 height=excluded.height,
                 model_hash=excluded.model_hash,
                 model_name=excluded.model_name,
                 generation_type=excluded.generation_type,
                 raw_metadata=excluded.raw_metadata,
                 extra_params=excluded.extra_params,
                 file_mtime=excluded.file_mtime,
                 file_size=excluded.file_size,
                 quick_hash=excluded.quick_hash,
                 culled_at=NULL,
                 ghost_recipe=NULL
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
                seed_int,
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

    /// Culls images using either Trash mode (culled_at tombstone) or Permanent mode
    /// (ghost recipe + blank text + ghost://<id> filepath to evict FTS while preserving lineage).
    pub fn cull_images(&self, ids: &[i64], mode: CullMode) -> SqlResult<usize> {
        if ids.is_empty() {
            return Ok(0);
        }

        let mut conn = self.pool.get().map_err(pool_error)?;
        let tx = conn.transaction()?;

        let placeholders = vec!["?"; ids.len()].join(", ");
        let params_ids: Vec<Value> = ids.iter().map(|id| Value::Integer(*id)).collect();

        // 1. Remove image_tags for the culled ids
        tx.execute(
            &format!(
                "DELETE FROM image_tags WHERE image_id IN ({})",
                placeholders
            ),
            params_from_iter(params_ids.clone()),
        )?;

        // 2. Prune orphaned tags
        tx.execute(
            "DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM image_tags)",
            [],
        )?;

        // 3. Apply culling per mode; `culled` counts rows actually changed.
        let culled = match mode {
            CullMode::Trash => {
                let sql = format!(
                    "UPDATE images SET culled_at = strftime('%s','now') WHERE id IN ({})",
                    placeholders
                );
                tx.execute(&sql, params_from_iter(params_ids))?
            }
            CullMode::Permanent => {
                let mut select_stmt = tx.prepare(
                    "SELECT filepath, seed, cfg_scale, steps, sampler, schedule_type, model_name
                     FROM images WHERE id = ?1",
                )?;
                let mut update_stmt = tx.prepare(
                    "UPDATE images SET
                        culled_at = strftime('%s','now'),
                        ghost_recipe = ?1,
                        prompt = '',
                        negative_prompt = '',
                        raw_metadata = '',
                        extra_params = NULL,
                        model_name = NULL,
                        model_hash = NULL,
                        filename = 'ghost',
                        directory = '',
                        quick_hash = NULL,
                        filepath = ?2
                     WHERE id = ?3",
                )?;
                let mut del_lineage = tx.prepare(
                    "DELETE FROM lineage WHERE child_filepath = ?1 OR parent_filepath = ?1",
                )?;
                let mut del_lineage_overrides = tx.prepare(
                    "DELETE FROM lineage_overrides WHERE child_filepath = ?1 OR parent_filepath = ?1",
                )?;

                let mut culled = 0usize;
                for id in ids {
                    let row_res = select_stmt.query_row(params![id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, Option<String>>(5)?,
                            row.get::<_, Option<String>>(6)?,
                        ))
                    });

                    // A missing row is skipped (and not counted); any other error aborts the whole
                    // transaction so a file that is already gone is never left fully indexed.
                    let found = match row_res {
                        Ok(row) => Some(row),
                        Err(rusqlite::Error::QueryReturnedNoRows) => None,
                        Err(e) => return Err(e),
                    };
                    if let Some((old_fp, seed, cfg, steps, sampler, scheduler, model)) = found {
                        del_lineage.execute(params![old_fp])?;
                        del_lineage_overrides.execute(params![old_fp])?;

                        let recipe = serde_json::json!({
                            "seed": seed,
                            "cfg": cfg,
                            "steps": steps,
                            "sampler": sampler,
                            "scheduler": scheduler,
                            "model": model,
                        });
                        let ghost_path = format!("ghost://{}", id);
                        update_stmt.execute(params![recipe.to_string(), ghost_path, id])?;
                        culled += 1;
                    }
                }
                culled
            }
        };

        tx.commit()?;
        Ok(culled)
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

    /// Returns true if the given filepath is indexed in the images table.
    pub fn is_indexed_path(&self, filepath: &str) -> bool {
        let Ok(conn) = self.pool.get() else {
            return false;
        };

        // 1. Direct query
        if conn
            .query_row(
                "SELECT 1 FROM images WHERE filepath = ?1 LIMIT 1",
                params![filepath],
                |_| Ok(()),
            )
            .is_ok()
        {
            return true;
        }

        // 2. Query with alternate slash separators
        let alt = if filepath.contains('\\') {
            filepath.replace('\\', "/")
        } else if filepath.contains('/') {
            filepath.replace('/', "\\")
        } else {
            String::new()
        };
        if !alt.is_empty()
            && conn
                .query_row(
                    "SELECT 1 FROM images WHERE filepath = ?1 LIMIT 1",
                    params![alt],
                    |_| Ok(()),
                )
                .is_ok()
        {
            return true;
        }

        // 3. Canonicalized path check if file exists
        if let Ok(canon) = std::fs::canonicalize(filepath) {
            let canon_str = canon.to_string_lossy().to_string();
            let stripped = canon_str.strip_prefix(r"\\?\").unwrap_or(&canon_str);
            if conn
                .query_row(
                    "SELECT 1 FROM images WHERE filepath = ?1 LIMIT 1",
                    params![stripped],
                    |_| Ok(()),
                )
                .is_ok()
            {
                return true;
            }
            let stripped_slash = stripped.replace('\\', "/");
            if conn
                .query_row(
                    "SELECT 1 FROM images WHERE filepath = ?1 LIMIT 1",
                    params![stripped_slash],
                    |_| Ok(()),
                )
                .is_ok()
            {
                return true;
            }
        }

        false
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
        use rusqlite::OptionalExtension;

        let mut conn = self.pool.get().map_err(pool_error)?;
        let tx = conn.transaction()?;
        tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;

        let old_filepath: Option<String> = tx
            .query_row(
                "SELECT filepath FROM images WHERE id = ?1",
                params![image_id],
                |row| row.get(0),
            )
            .optional()?;

        let Some(old_filepath) = old_filepath else {
            return Ok(false);
        };

        let updated = tx.execute(
            "UPDATE images
             SET filepath = ?1, filename = ?2, directory = ?3
             WHERE id = ?4",
            params![filepath, filename, directory, image_id],
        )?;

        if old_filepath != filepath {
            tx.execute(
                "UPDATE lineage SET child_filepath = ?1 WHERE child_filepath = ?2",
                params![filepath, old_filepath],
            )?;
            tx.execute(
                "UPDATE lineage SET parent_filepath = ?1 WHERE parent_filepath = ?2",
                params![filepath, old_filepath],
            )?;
            tx.execute(
                "UPDATE lineage_overrides SET child_filepath = ?1 WHERE child_filepath = ?2",
                params![filepath, old_filepath],
            )?;
            tx.execute(
                "UPDATE lineage_overrides SET parent_filepath = ?1 WHERE parent_filepath = ?2",
                params![filepath, old_filepath],
            )?;
        }

        tx.commit()?;
        Ok(updated > 0)
    }
}

/// A Trash-culled row keeps its unique `filepath`. If a DIFFERENT file (different content
/// fingerprint) is later saved at that path, upserting would resurrect the old row, and the old
/// row's children would then claim the unrelated new image as their parent. Move the culled row
/// aside to a `ghost://` path first; a restored copy of the same file (same fingerprint) is left
/// alone so the normal resurrection still applies.
fn demote_stale_culled_row(
    tx: &rusqlite::Transaction<'_>,
    filepath: &str,
    new_hash: Option<&str>,
) -> SqlResult<()> {
    let Some(new_hash) = new_hash else {
        return Ok(());
    };
    let existing: Option<(i64, Option<String>, Option<i64>)> = tx
        .query_row(
            "SELECT id, quick_hash, culled_at FROM images WHERE filepath = ?1",
            params![filepath],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    if let Some((id, Some(old_hash), Some(_))) = existing {
        if old_hash != new_hash {
            tx.execute(
                "UPDATE images SET filepath = ?1 WHERE id = ?2",
                params![format!("ghost://{}", id), id],
            )?;
        }
    }
    Ok(())
}
