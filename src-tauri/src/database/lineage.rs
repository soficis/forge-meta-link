use super::{
    contains_search_token, gallery_image_record_from_row, parse_seed_int, pool_error,
    sanitize_fts_query, Database, GalleryImageRecord,
};
use rusqlite::{params, params_from_iter, types::Value, Result as SqlResult};
use serde::{Deserialize, Serialize};

struct ChildRow {
    id: i64,
    filepath: String,
    seed: Option<String>,
    model_hash: Option<String>,
    directory: String,
    file_mtime: Option<i64>,
    prompt: String,
}

fn strip_lora_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<lora:") {
        out.push_str(&rest[..start]);
        let after_start = &rest[start..];
        if let Some(end) = after_start.find('>') {
            rest = &after_start[end + 1..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn prompt_tokens(prompt: &str) -> std::collections::HashSet<String> {
    let lower = prompt.to_lowercase();
    let stripped = strip_lora_tags(&lower);
    stripped
        .split(|c: char| c.is_whitespace() || c == ',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

pub fn prompt_jaccard(prompt_a: &str, prompt_b: &str) -> f64 {
    let set_a = prompt_tokens(prompt_a);
    let set_b = prompt_tokens(prompt_b);
    let union_len = set_a.union(&set_b).count();
    if union_len == 0 {
        return 0.0;
    }
    let intersection_len = set_a.intersection(&set_b).count();
    intersection_len as f64 / union_len as f64
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LineageEdge {
    pub child_filepath: String,
    pub parent_filepath: String,
    pub relation: String,
    pub confidence: f64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LineageCursor {
    pub ancestors: Vec<LineageEdge>,
    pub children: Vec<LineageEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TagProvenance {
    pub tag: String,
    pub count: u32,
    pub first_seen: Option<i64>,
    pub last_seen: Option<i64>,
    pub sample_filepaths: Vec<String>,
}

/// Opaque cursor payload for lineage pagination (future-proof).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineageOpaqueCursor {
    pub last_confidence: f64,
    pub last_created_at: i64,
    pub last_child: Option<String>,
    pub last_parent: Option<String>,
}

fn lineage_edge_from_row(row: &rusqlite::Row<'_>) -> SqlResult<LineageEdge> {
    Ok(LineageEdge {
        child_filepath: row.get(0)?,
        parent_filepath: row.get(1)?,
        relation: row.get(2)?,
        confidence: row.get(3)?,
        created_at: row.get(4)?,
    })
}

impl Database {
    /// Returns lineage cursor for a filepath: up to 3 ancestors and 2 children
    /// ordered by confidence DESC, created_at DESC. Overrides win: unlink hides,
    /// link injects.
    pub fn get_lineage_cursor(&self, filepath: &str) -> SqlResult<LineageCursor> {
        let conn = self.pool.get().map_err(pool_error)?;

        // Ancestors: where child = filepath, exclude unlink overrides, include link overrides
        // Use UNION to merge lineage (filtered) + overrides link
        let mut ancestors: Vec<LineageEdge> = Vec::new();
        {
            let sql = "
                SELECT child_filepath, parent_filepath, relation, confidence, created_at FROM (
                    SELECT l.child_filepath, l.parent_filepath, l.relation, l.confidence, l.created_at
                    FROM lineage l
                    LEFT JOIN lineage_overrides o ON o.child_filepath = l.child_filepath AND o.parent_filepath = l.parent_filepath AND o.action = 'unlink'
                    WHERE l.child_filepath = ?1 AND o.child_filepath IS NULL
                    UNION
                    SELECT child_filepath, parent_filepath, relation, confidence, created_at
                    FROM lineage_overrides
                    WHERE child_filepath = ?1 AND action = 'link'
                )
                ORDER BY confidence DESC, created_at DESC
                LIMIT 3
            ";
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![filepath], lineage_edge_from_row)?;
            for row in rows {
                ancestors.push(row?);
            }
        }

        let mut children: Vec<LineageEdge> = Vec::new();
        {
            let sql = "
                SELECT child_filepath, parent_filepath, relation, confidence, created_at FROM (
                    SELECT l.child_filepath, l.parent_filepath, l.relation, l.confidence, l.created_at
                    FROM lineage l
                    LEFT JOIN lineage_overrides o ON o.child_filepath = l.child_filepath AND o.parent_filepath = l.parent_filepath AND o.action = 'unlink'
                    WHERE l.parent_filepath = ?1 AND o.child_filepath IS NULL
                    UNION
                    SELECT child_filepath, parent_filepath, relation, confidence, created_at
                    FROM lineage_overrides
                    WHERE parent_filepath = ?1 AND action = 'link'
                )
                ORDER BY confidence DESC, created_at DESC
                LIMIT 2
            ";
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![filepath], lineage_edge_from_row)?;
            for row in rows {
                children.push(row?);
            }
        }

        Ok(LineageCursor {
            ancestors,
            children,
        })
    }

    /// Seed walk: seed proximity +-16 + model_hash + directory/time 7d, optional FTS prompt cluster join.
    pub fn get_seed_walk(
        &self,
        seed: &str,
        prompt_like: Option<&str>,
        limit: u32,
    ) -> SqlResult<Vec<GalleryImageRecord>> {
        let conn = self.pool.get().map_err(pool_error)?;
        let lim = limit.clamp(1, 100) as i64;
        let seed_trim = seed.trim();
        if seed_trim.is_empty() {
            return Ok(Vec::new());
        }

        // Try parse numeric seed for proximity
        let seed_int: Option<i64> = seed_trim.parse::<i64>().ok();

        // Find reference image to get model_hash, directory, file_mtime for contextual filters
        let mut ref_model_hash: Option<String> = None;
        let mut ref_directory: Option<String> = None;
        let mut ref_mtime: Option<i64> = None;
        if let Some(si) = seed_int {
            // Find first image with exact seed numeric
            let mut stmt = conn.prepare(
                "SELECT model_hash, directory, file_mtime FROM images WHERE seed_int = ?1 LIMIT 1",
            )?;
            let result = stmt.query_row(params![si], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            });
            if let Ok((mh, dir, mt)) = result {
                ref_model_hash = mh;
                ref_directory = dir;
                ref_mtime = mt;
            }
            // Fallback: if not found via integer cast, try exact string match
            if ref_model_hash.is_none() && ref_directory.is_none() {
                let mut stmt2 = conn.prepare(
                    "SELECT model_hash, directory, file_mtime FROM images WHERE seed = ?1 LIMIT 1",
                )?;
                if let Ok((mh, dir, mt)) = stmt2.query_row(params![seed_trim], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                }) {
                    ref_model_hash = mh;
                    ref_directory = dir;
                    ref_mtime = mt;
                }
            }
        } else {
            // Non-numeric seed: use exact match reference
            let mut stmt = conn.prepare(
                "SELECT model_hash, directory, file_mtime FROM images WHERE seed = ?1 LIMIT 1",
            )?;
            if let Ok((mh, dir, mt)) = stmt.query_row(params![seed_trim], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            }) {
                ref_model_hash = mh;
                ref_directory = dir;
                ref_mtime = mt;
            }
        }

        // Build FTS filter if prompt_like provided
        let mut fts_sanitized: Option<String> = None;
        let mut trigram_match: Option<String> = None;
        if let Some(q) = prompt_like {
            let trimmed = q.trim();
            if !trimmed.is_empty() {
                let sanitized = sanitize_fts_query(trimmed);
                if !sanitized.is_empty() {
                    fts_sanitized = Some(sanitized);
                } else if contains_search_token(trimmed) {
                    trigram_match = Some(format!("\"{}\"", trimmed.replace('"', "\"\"")));
                }
            }
        }

        // Build SQL dynamically
        // Base select
        let mut sql = String::from(
            "SELECT id, filepath, filename, directory, seed, width, height, model_name, is_favorite, is_locked, file_mtime FROM images WHERE 1=1",
        );
        let mut params_vec: Vec<Value> = Vec::new();

        if let Some(si) = seed_int {
            sql.push_str(" AND seed_int BETWEEN ? AND ?");
            params_vec.push(Value::Integer(si - 16));
            params_vec.push(Value::Integer(si + 16));
        } else {
            sql.push_str(" AND seed = ?");
            params_vec.push(Value::Text(seed_trim.to_string()));
        }

        if let Some(mh) = &ref_model_hash {
            if !mh.trim().is_empty() {
                sql.push_str(" AND (model_hash = ? OR model_hash IS NULL)");
                params_vec.push(Value::Text(mh.clone()));
            }
        }
        if let Some(dir) = &ref_directory {
            if !dir.trim().is_empty() {
                sql.push_str(" AND directory = ?");
                params_vec.push(Value::Text(dir.clone()));
            }
        }
        if let Some(mt) = ref_mtime {
            sql.push_str(" AND (file_mtime IS NULL OR ABS(file_mtime - ?) <= 604800)");
            params_vec.push(Value::Integer(mt));
        }

        if let Some(sanitized) = &fts_sanitized {
            sql.push_str(" AND id IN (SELECT rowid FROM images_fts WHERE images_fts MATCH ?)");
            params_vec.push(Value::Text(sanitized.clone()));
        } else if let Some(tri) = &trigram_match {
            sql.push_str(
                " AND id IN (SELECT rowid FROM images_fts_tri WHERE images_fts_tri MATCH ?)",
            );
            params_vec.push(Value::Text(tri.clone()));
        }

        // Order by seed proximity then mtime
        if let Some(si) = seed_int {
            sql.push_str(" ORDER BY ABS(seed_int - ?) ASC, file_mtime DESC LIMIT ?");
            params_vec.push(Value::Integer(si));
            params_vec.push(Value::Integer(lim));
        } else {
            sql.push_str(" ORDER BY file_mtime DESC LIMIT ?");
            params_vec.push(Value::Integer(lim));
        }

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params_vec), gallery_image_record_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Tag provenance: count, first/last seen, sample filepaths via FTS? just join.
    pub fn get_tag_provenance(&self, tag: &str) -> SqlResult<TagProvenance> {
        let conn = self.pool.get().map_err(pool_error)?;
        let normalized = tag.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return Ok(TagProvenance {
                tag: normalized,
                count: 0,
                first_seen: None,
                last_seen: None,
                sample_filepaths: Vec::new(),
            });
        }

        let mut stmt = conn.prepare(
            "SELECT COUNT(*), MIN(images.file_mtime), MAX(images.file_mtime)
             FROM images
             JOIN image_tags ON image_tags.image_id = images.id
             JOIN tags ON tags.id = image_tags.tag_id
             WHERE tags.tag = ?1",
        )?;
        let (count, first_seen, last_seen): (i64, Option<i64>, Option<i64>) = stmt
            .query_row(params![normalized], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;

        let mut sample_filepaths: Vec<String> = Vec::new();
        if count > 0 {
            let mut stmt2 = conn.prepare(
                "SELECT images.filepath
                 FROM images
                 JOIN image_tags ON image_tags.image_id = images.id
                 JOIN tags ON tags.id = image_tags.tag_id
                 WHERE tags.tag = ?1
                 ORDER BY images.file_mtime DESC
                 LIMIT 5",
            )?;
            let rows = stmt2.query_map(params![normalized], |row| row.get::<_, String>(0))?;
            for row in rows {
                sample_filepaths.push(row?);
            }
        }

        Ok(TagProvenance {
            tag: normalized,
            count: count as u32,
            first_seen,
            last_seen,
            sample_filepaths,
        })
    }

    /// Insert or update lineage override (manual link/unlink wins over infer)
    pub fn upsert_lineage_override(
        &self,
        child_filepath: &str,
        parent_filepath: &str,
        relation: &str,
        confidence: f64,
        action: &str,
    ) -> SqlResult<()> {
        let conn = self.pool.get().map_err(pool_error)?;
        conn.execute(
            "INSERT INTO lineage_overrides(child_filepath, parent_filepath, relation, confidence, action)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(child_filepath, parent_filepath) DO UPDATE SET relation=excluded.relation, confidence=excluded.confidence, action=excluded.action",
            params![child_filepath, parent_filepath, relation, confidence, action],
        )?;
        // If action is link, also ensure lineage contains it with high confidence
        if action == "link" {
            conn.execute(
                "INSERT INTO lineage(child_filepath, parent_filepath, relation, confidence)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(child_filepath, parent_filepath) DO UPDATE SET relation=excluded.relation, confidence=excluded.confidence",
                params![child_filepath, parent_filepath, relation, confidence],
            )?;
        }
        // If unlink, remove from lineage if exists so cursor hides it
        if action == "unlink" {
            conn.execute(
                "DELETE FROM lineage WHERE child_filepath = ?1 AND parent_filepath = ?2",
                params![child_filepath, parent_filepath],
            )?;
        }
        Ok(())
    }

    /// Deletes only inferred seed_walk edges, preserving manual link overrides.
    /// Returns the number of edges deleted.
    pub fn reset_inferred_lineage(&self) -> SqlResult<usize> {
        let conn = self.pool.get().map_err(pool_error)?;
        conn.execute(
            "DELETE FROM lineage
             WHERE relation = 'seed_walk'
               AND NOT EXISTS (
                 SELECT 1 FROM lineage_overrides o
                 WHERE o.child_filepath = lineage.child_filepath
                   AND o.parent_filepath = lineage.parent_filepath
                   AND o.action = 'link')",
            [],
        )
    }

    /// Returns the total number of lineage edges in the database.
    pub fn get_total_lineage_edges(&self) -> SqlResult<usize> {
        let conn = self.pool.get().map_err(pool_error)?;
        conn.query_row("SELECT COUNT(*) FROM lineage", [], |row| row.get(0))
    }

    /// Deletes all inferred seed_walk edges (keeping manual link overrides)
    /// and re-runs exact-seed inference. Returns the total count of lineage edges in the database.
    pub fn rebuild_lineage(&self) -> SqlResult<usize> {
        self.reset_inferred_lineage()?;
        self.infer_lineage()?;
        self.get_total_lineage_edges()
    }

    /// Runs one-time startup migrations for lineage:
    /// - If `lineage_reset_v2` is absent: resets inferred edges, runs a full infer,
    ///   and records both `lineage_reset_v2` and `lineage_backfill_v1`.
    /// - Otherwise, if `lineage_backfill_v1` is absent: runs full infer and records it.
    ///
    /// Returns `Ok(Some(count))` if inference ran, `Ok(None)` if already up to date.
    pub fn run_lineage_migrations_if_needed(&self) -> SqlResult<Option<usize>> {
        let conn = self.pool.get().map_err(pool_error)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_migrations (
                name TEXT PRIMARY KEY,
                applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );",
        )?;
        let has_v2: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'lineage_reset_v2')",
            [],
            |row| row.get(0),
        )?;
        let has_v1: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'lineage_backfill_v1')",
            [],
            |row| row.get(0),
        )?;
        drop(conn);

        if !has_v2 {
            self.reset_inferred_lineage()?;
            let edges = self.infer_lineage()?;
            let conn = self.pool.get().map_err(pool_error)?;
            conn.execute_batch(
                "INSERT OR IGNORE INTO app_migrations (name) VALUES ('lineage_backfill_v1');
                 INSERT OR IGNORE INTO app_migrations (name) VALUES ('lineage_reset_v2');",
            )?;
            return Ok(Some(edges));
        }

        if !has_v1 {
            let edges = self.infer_lineage()?;
            let conn = self.pool.get().map_err(pool_error)?;
            conn.execute(
                "INSERT INTO app_migrations (name) VALUES ('lineage_backfill_v1')",
                [],
            )?;
            return Ok(Some(edges));
        }

        Ok(None)
    }

    /// Backward-compatibility alias for `run_lineage_migrations_if_needed`.
    pub fn run_lineage_backfill_if_needed(&self) -> SqlResult<Option<usize>> {
        self.run_lineage_migrations_if_needed()
    }

    /// Infers lineage edges via heuristics: exact seed, same directory, same model when both have one, parent older than child within 7 days, confidence 0.9 when prompt token-Jaccard ≥ 0.6 else 0.6.
    /// Transactional 500 edges/tx, idempotent, overrides win. Returns inserted count.
    pub fn infer_lineage(&self) -> SqlResult<usize> {
        self.infer_lineage_for_files(None)
    }

    /// Infers lineage edges via heuristics: exact seed, same directory, same model when both have one, parent older than child within 7 days, confidence 0.9 when prompt token-Jaccard ≥ 0.6 else 0.6.
    /// Transactional 500 edges/tx, idempotent, overrides win. Returns inserted count.
    pub fn infer_lineage_for_files(&self, filepaths: Option<&[String]>) -> SqlResult<usize> {
        let conn = self.pool.get().map_err(pool_error)?;
        let mut children: Vec<ChildRow> = Vec::new();

        if let Some(target_fps) = filepaths {
            if target_fps.is_empty() {
                return Ok(0);
            }
            for chunk in target_fps.chunks(500) {
                let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                let sql = format!(
                    "SELECT id, filepath, seed, model_hash, directory, file_mtime, prompt FROM images WHERE seed_int IS NOT NULL AND filepath IN ({})",
                    placeholders
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(
                    params_from_iter(chunk.iter().map(|s| Value::Text(s.clone()))),
                    |row| {
                        Ok(ChildRow {
                            id: row.get(0)?,
                            filepath: row.get(1)?,
                            seed: row.get(2)?,
                            model_hash: row.get(3)?,
                            directory: row.get(4)?,
                            file_mtime: row.get(5)?,
                            prompt: row.get(6)?,
                        })
                    },
                )?;
                for row in rows {
                    children.push(row?);
                }
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, filepath, seed, model_hash, directory, file_mtime, prompt FROM images WHERE seed_int IS NOT NULL",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(ChildRow {
                    id: row.get(0)?,
                    filepath: row.get(1)?,
                    seed: row.get(2)?,
                    model_hash: row.get(3)?,
                    directory: row.get(4)?,
                    file_mtime: row.get(5)?,
                    prompt: row.get(6)?,
                })
            })?;
            for row in rows {
                children.push(row?);
            }
        }

        let mut unlink_overrides = std::collections::HashSet::new();
        {
            let mut ostmt = conn.prepare(
                "SELECT child_filepath, parent_filepath FROM lineage_overrides WHERE action = 'unlink'",
            )?;
            let orows = ostmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for r in orows {
                unlink_overrides.insert(r?);
            }
        }

        let mut existing_edges = std::collections::HashSet::new();
        {
            let mut estmt = conn.prepare("SELECT child_filepath, parent_filepath FROM lineage")?;
            let erows = estmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for r in erows {
                existing_edges.insert(r?);
            }
        }

        let mut edges: Vec<(String, String, String, f64)> = Vec::new();

        for child in &children {
            let seed_str = match &child.seed {
                Some(s) => s.trim().to_string(),
                None => continue,
            };
            if seed_str.is_empty() {
                continue;
            }
            let si = match parse_seed_int(&seed_str) {
                Some(v) => v,
                None => continue,
            };
            let child_mtime = match child.file_mtime {
                Some(v) => v,
                None => continue,
            };

            let mut candidate_sql = String::from(
                "SELECT filepath, prompt FROM images WHERE filepath != ? AND seed_int = ? AND directory = ? AND file_mtime BETWEEN ? AND ? AND (file_mtime < ? OR (file_mtime = ? AND id < ?))",
            );
            let mut candidate_params: Vec<Value> = vec![
                Value::Text(child.filepath.clone()),
                Value::Integer(si),
                Value::Text(child.directory.clone()),
                Value::Integer(child_mtime - 604800),
                Value::Integer(child_mtime),
                Value::Integer(child_mtime),
                Value::Integer(child_mtime),
                Value::Integer(child.id),
            ];

            if let Some(mh) = &child.model_hash {
                let mh_trim = mh.trim();
                if !mh_trim.is_empty() {
                    candidate_sql
                        .push_str(" AND (model_hash = ? OR model_hash IS NULL OR model_hash = '')");
                    candidate_params.push(Value::Text(mh_trim.to_string()));
                }
            }

            candidate_sql.push_str(" ORDER BY file_mtime DESC, id DESC LIMIT 2");

            let mut cstmt = conn.prepare_cached(&candidate_sql)?;
            let crows = cstmt.query_map(params_from_iter(candidate_params), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for crow in crows {
                let (parent_fp, parent_prompt) = crow?;
                if unlink_overrides.contains(&(child.filepath.clone(), parent_fp.clone())) {
                    continue;
                }
                if existing_edges.contains(&(child.filepath.clone(), parent_fp.clone())) {
                    continue;
                }
                let sim = prompt_jaccard(&child.prompt, &parent_prompt);
                let confidence = if sim >= 0.6 { 0.9 } else { 0.6 };
                existing_edges.insert((child.filepath.clone(), parent_fp.clone()));
                edges.push((
                    child.filepath.clone(),
                    parent_fp,
                    "seed_walk".to_string(),
                    confidence,
                ));
            }
        }

        if edges.is_empty() {
            return Ok(0);
        }

        // Dedup edges by (child,parent)
        let mut seen = std::collections::HashSet::new();
        let mut deduped: Vec<(String, String, String, f64)> = Vec::new();
        for e in edges {
            let key = format!("{}|{}", e.0, e.1);
            if seen.insert(key) {
                deduped.push(e);
            }
        }

        // Transactional 500 edges/tx, idempotent via INSERT OR IGNORE
        let mut inserted = 0usize;
        let mut conn_mut = self.pool.get().map_err(pool_error)?;
        for chunk in deduped.chunks(500) {
            let tx = conn_mut.transaction()?;
            {
                let mut stmt = tx.prepare(
                    "INSERT OR IGNORE INTO lineage(child_filepath, parent_filepath, relation, confidence) VALUES (?1, ?2, ?3, ?4)",
                )?;
                for (child, parent, rel, conf) in chunk {
                    if unlink_overrides.contains(&(child.clone(), parent.clone())) {
                        continue;
                    }
                    let changed = stmt.execute(params![child, parent, rel, conf])?;
                    if changed > 0 {
                        inserted += 1;
                    }
                }
            }
            tx.commit()?;
        }

        Ok(inserted)
    }

    /// Helper to encode opaque cursor JSON (for future pagination)
    pub fn encode_lineage_cursor(last: &LineageEdge) -> String {
        serde_json::json!({
            "confidence": last.confidence,
            "created_at": last.created_at,
            "child": last.child_filepath,
            "parent": last.parent_filepath
        })
        .to_string()
    }

    pub fn decode_lineage_cursor(cursor: &str) -> Option<LineageOpaqueCursor> {
        serde_json::from_str(cursor).ok()
    }
}

#[cfg(test)]
mod cursor {
    use super::*;
    use crate::parser::GenerationParams;
    use crate::StorageProfile;

    fn mem_db() -> Database {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tid = std::thread::current().id();
        let path = std::env::temp_dir().join(format!(
            "forge_lineage_test_{}_{}_{:?}.db",
            std::process::id(),
            nanos,
            tid
        ));
        Database::new(&path, StorageProfile::Hdd).expect("mem db")
    }

    fn insert_image(
        db: &Database,
        filepath: &str,
        seed: Option<&str>,
        model_hash: Option<&str>,
        prompt: &str,
        mtime: Option<i64>,
    ) {
        let params = GenerationParams {
            prompt: prompt.to_string(),
            raw_metadata: prompt.to_string(),
            seed: seed.map(|s| s.to_string()),
            model_hash: model_hash.map(|s| s.to_string()),
            ..Default::default()
        };
        let filename = filepath.rsplit('/').next().unwrap_or(filepath);
        let dir = filepath
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or("c:\\images")
            .to_string();
        // Use the directory param as provided? Simplify
        let dir2 = dir;
        db.upsert_image(filepath, filename, &dir2, &params, mtime)
            .expect("insert");
        // Also update file_mtime if needed beyond upsert default? upsert uses file_mtime param
    }

    #[test]
    fn test_lineage_cursor_empty_returns_empty() {
        let db = mem_db();
        insert_image(
            &db,
            "/a.png",
            Some("100"),
            Some("abc"),
            "cat hero",
            Some(1000),
        );
        let cursor = db.get_lineage_cursor("/a.png").expect("cursor");
        assert!(
            cursor.ancestors.is_empty(),
            "ancestors should be empty when no lineage"
        );
        assert!(
            cursor.children.is_empty(),
            "children should be empty when no lineage"
        );
    }

    #[test]
    fn test_lineage_cursor_missing_filepath_returns_empty() {
        let db = mem_db();
        let cursor = db.get_lineage_cursor("/nonexistent.png").expect("cursor");
        assert!(cursor.ancestors.is_empty());
        assert!(cursor.children.is_empty());
    }

    #[test]
    fn test_lineage_cursor_ordered_by_confidence_and_created_at() {
        let db = mem_db();
        let conn = db.pool_get_for_test().unwrap();
        conn.execute("INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/parent1.png','parent1.png','/','x')", []).unwrap();
        conn.execute("INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/parent2.png','parent2.png','/','y')", []).unwrap();
        conn.execute("INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/child.png','child.png','/','z')", []).unwrap();
        // Insert lineage edges with different confidences
        conn.execute("INSERT INTO lineage(child_filepath, parent_filepath, relation, confidence, created_at) VALUES ('/child.png','/parent1.png','seed_walk',0.6, 100)", []).unwrap();
        conn.execute("INSERT INTO lineage(child_filepath, parent_filepath, relation, confidence, created_at) VALUES ('/child.png','/parent2.png','seed_walk',0.9, 200)", []).unwrap();
        let cursor = db.get_lineage_cursor("/child.png").unwrap();
        assert_eq!(cursor.ancestors.len(), 2);
        assert_eq!(cursor.ancestors[0].parent_filepath, "/parent2.png");
        assert_eq!(cursor.ancestors[0].confidence, 0.9);
        assert_eq!(cursor.ancestors[1].parent_filepath, "/parent1.png");
    }

    #[test]
    fn test_seed_walk_proximity_and_fts() {
        let db = mem_db();
        insert_image(
            &db,
            "/img_1234.png",
            Some("1234"),
            Some("hash1"),
            "cat hero portrait",
            Some(1000),
        );
        insert_image(
            &db,
            "/img_1240.png",
            Some("1240"),
            Some("hash1"),
            "cat hero portrait",
            Some(1005),
        );
        insert_image(
            &db,
            "/img_1300.png",
            Some("1300"),
            Some("hash1"),
            "cat hero portrait",
            Some(1010),
        );
        insert_image(
            &db,
            "/img_1235_diffmodel.png",
            Some("1235"),
            Some("other"),
            "cat hero portrait",
            Some(1002),
        );

        let results = db.get_seed_walk("1234", Some("cat hero"), 16).unwrap();
        let filepaths: Vec<String> = results.iter().map(|r| r.filepath.clone()).collect();
        assert!(filepaths.contains(&"/img_1234.png".to_string()));
        assert!(filepaths.contains(&"/img_1240.png".to_string()));
        assert!(
            !filepaths.contains(&"/img_1300.png".to_string()),
            "1300 outside +-16 should be excluded"
        );
        assert!(
            !filepaths.contains(&"/img_1235_diffmodel.png".to_string()),
            "different model_hash filtered"
        );
    }

    #[test]
    fn test_infer_lineage_idempotent_500_tx() {
        let db = mem_db();
        // Create 3 images that should link: same dir, model_hash, mtime within 7d, seed +-16, prompt cluster
        for i in 0..3 {
            let fp = format!("/dir/img_{}.png", i);
            insert_image(
                &db,
                &fp,
                Some("1000"),
                Some("h1"),
                "castle landscape",
                Some(1000 + i * 10),
            );
        }
        let inserted1 = db.infer_lineage().unwrap();
        assert!(inserted1 > 0, "should insert edges");
        let inserted2 = db.infer_lineage().unwrap();
        assert_eq!(
            inserted2, 0,
            "second run should be idempotent, no new edges"
        );

        // Verify that all inserted edges are retrievable via cursor
        let cursor = db.get_lineage_cursor("/dir/img_2.png").unwrap();
        assert!(!cursor.ancestors.is_empty());
    }

    #[test]
    fn test_lineage_overrides_win() {
        let db = mem_db();
        let conn = db.pool_get_for_test().unwrap();
        conn.execute("INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/p.png','p.png','/','x')", []).unwrap();
        conn.execute("INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/c.png','c.png','/','y')", []).unwrap();
        conn.execute("INSERT INTO lineage(child_filepath, parent_filepath, relation, confidence) VALUES ('/c.png','/p.png','seed_walk',0.6)", []).unwrap();
        // Override unlink should hide
        db.upsert_lineage_override("/c.png", "/p.png", "seed_walk", 0.9, "unlink")
            .unwrap();
        let cursor = db.get_lineage_cursor("/c.png").unwrap();
        assert!(
            cursor.ancestors.is_empty(),
            "unlink override should hide edge"
        );

        // Link override should show even without lineage row
        conn.execute("INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/p2.png','p2.png','/','z')", []).unwrap();
        db.upsert_lineage_override("/c.png", "/p2.png", "seed_walk", 1.0, "link")
            .unwrap();
        let cursor2 = db.get_lineage_cursor("/c.png").unwrap();
        assert_eq!(cursor2.ancestors.len(), 1);
        assert_eq!(cursor2.ancestors[0].parent_filepath, "/p2.png");
        assert_eq!(cursor2.ancestors[0].confidence, 1.0);
    }

    #[test]
    fn test_tag_provenance_counts_and_samples() {
        let db = mem_db();
        // Insert images with tags
        let gen = GenerationParams {
            prompt: "cat".into(),
            raw_metadata: "cat".into(),
            ..Default::default()
        };
        let id1 = db
            .upsert_image("/a.png", "a.png", "/", &gen, Some(100))
            .unwrap();
        let id2 = db
            .upsert_image("/b.png", "b.png", "/", &gen, Some(200))
            .unwrap();
        db.replace_image_tags(id1, &["mytag".to_string()]).unwrap();
        db.replace_image_tags(id2, &["mytag".to_string()]).unwrap();

        let prov = db.get_tag_provenance("mytag").unwrap();
        assert_eq!(prov.count, 2);
        assert_eq!(prov.first_seen, Some(100));
        assert_eq!(prov.last_seen, Some(200));
        assert_eq!(prov.sample_filepaths.len(), 2);
    }
}
