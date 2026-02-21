use super::*;

impl Database {
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
                    model_hash, model_name, raw_metadata, is_favorite, is_locked
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
                    model_hash, model_name, raw_metadata, is_favorite, is_locked
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
}
