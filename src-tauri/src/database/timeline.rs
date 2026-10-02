use super::*;

impl Database {
    /// Paginated file_mtime histogram source — uses idx_images_file_mtime.
    /// SELECT file_mtime FROM images WHERE file_mtime IS NOT NULL ORDER BY file_mtime ASC LIMIT ? OFFSET ?
    pub fn get_file_mtimes_paginated(&self, limit: u32, offset: u32) -> SqlResult<Vec<i64>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let clamped_limit = limit.clamp(1, 50000) as i64;
        let clamped_offset = offset as i64;
        let mut stmt = conn.prepare(
            "SELECT file_mtime FROM images WHERE file_mtime IS NOT NULL ORDER BY file_mtime ASC LIMIT ?1 OFFSET ?2",
        )?;
        let rows = stmt.query_map(params![clamped_limit, clamped_offset], |row| {
            row.get::<_, i64>(0)
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Filtered file_mtime source via FTS5 reuse (porter + trigram fallback).
    /// Returns up to `limit` mtimes matching the prompt cluster query, ordered ASC.
    pub fn get_file_mtimes_for_query(&self, query: &str, limit: u32) -> SqlResult<Vec<i64>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let clamped_limit = limit.clamp(1, 50000) as i64;
        let sanitized = sanitize_fts_query(query);
        // Try porter first
        if !sanitized.is_empty() {
            let mut stmt = conn.prepare(
                "SELECT images.file_mtime FROM images JOIN images_fts ON images.id = images_fts.rowid WHERE images_fts MATCH ?1 AND images.file_mtime IS NOT NULL ORDER BY images.file_mtime ASC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![sanitized, clamped_limit], |row| {
                row.get::<_, i64>(0)
            })?;
            let mut out: Vec<i64> = Vec::new();
            for row in rows {
                out.push(row?);
            }
            if !out.is_empty() {
                return Ok(out);
            }
        }
        // Fallback trigram (infix)
        let trimmed = query.trim();
        if trimmed.is_empty() || !contains_search_token(trimmed) {
            return Ok(Vec::new());
        }
        let match_expr = format!("\"{}\"", trimmed.replace('"', "\"\""));
        let mut stmt = conn.prepare(
            "SELECT images.file_mtime FROM images JOIN images_fts_tri ON images.id = images_fts_tri.rowid WHERE images_fts_tri MATCH ?1 AND images.file_mtime IS NOT NULL ORDER BY images.file_mtime ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![match_expr, clamped_limit], |row| {
            row.get::<_, i64>(0)
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn timeline_paginated_uses_index_and_returns_sorted() {
        let db = Database::new(Path::new(":memory:"), crate::StorageProfile::Hdd).unwrap();
        for i in 0..5 {
            let p = crate::parser::GenerationParams {
                prompt: format!("test {i}"),
                raw_metadata: format!("test {i}"),
                ..Default::default()
            };
            let fp = format!("f{i}.png");
            db.upsert_image(&fp, &fp, "c:\\x", &p, Some(100 + i * 10))
                .unwrap();
        }
        let mtimes = db.get_file_mtimes_paginated(50000, 0).unwrap();
        assert_eq!(mtimes, vec![100, 110, 120, 130, 140]);
    }

    #[test]
    fn timeline_cluster_filter_via_fts() {
        let db = Database::new(Path::new(":memory:"), crate::StorageProfile::Hdd).unwrap();
        let p1 = crate::parser::GenerationParams {
            prompt: "cat hero".into(),
            raw_metadata: "cat hero".into(),
            ..Default::default()
        };
        let p2 = crate::parser::GenerationParams {
            prompt: "dog landscape".into(),
            raw_metadata: "dog landscape".into(),
            ..Default::default()
        };
        db.upsert_image("a.png", "a.png", "c:\\x", &p1, Some(100))
            .unwrap();
        db.upsert_image("b.png", "b.png", "c:\\x", &p2, Some(200))
            .unwrap();
        let mtimes = db.get_file_mtimes_for_query("cat", 50000).unwrap();
        assert_eq!(mtimes, vec![100]);
    }
}
