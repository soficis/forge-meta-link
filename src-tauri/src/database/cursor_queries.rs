use super::*;

impl Database {
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
        let normalized_model_family_filters = normalize_model_family_filters(model_family_filters);
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
                "SELECT id, filepath, filename, directory, seed, width, height, model_name, is_favorite, is_locked
                 FROM images
                 WHERE 1=1",
            )
        } else {
            format!(
                "SELECT id, filepath, filename, directory, seed, width, height, model_name, is_favorite, is_locked, {} AS sort_value
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
                    row.get::<_, String>(10)?,
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
    pub fn search_cursor(&self, params: SearchCursorParams<'_>) -> SqlResult<CursorPage> {
        let porter = self.search_cursor_porter(params)?;
        if !porter.items.is_empty() {
            return Ok(porter);
        }
        self.search_cursor_trigram(params)
    }

    fn search_cursor_porter(&self, params: SearchCursorParams<'_>) -> SqlResult<CursorPage> {
        let query = params.query;
        let CursorQueryOptions {
            cursor,
            limit,
            sort_by,
            generation_types,
            model_filter,
            model_family_filters,
        } = params.options;
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
        let normalized_model_family_filters = normalize_model_family_filters(model_family_filters);
        let mut params_vec = vec![Value::Text(sanitized)];
        let mut sql = if sort.field == "id" {
            String::from(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, images.is_favorite, images.is_locked
                 FROM images
                 JOIN images_fts ON images.id = images_fts.rowid
                 WHERE images_fts MATCH ?",
            )
        } else {
            format!(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, images.is_favorite, images.is_locked, {} AS sort_value
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
                    row.get::<_, String>(10)?,
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

    fn search_cursor_trigram(&self, params: SearchCursorParams<'_>) -> SqlResult<CursorPage> {
        let query = params.query;
        let CursorQueryOptions {
            cursor,
            limit,
            sort_by,
            generation_types,
            model_filter,
            model_family_filters,
        } = params.options;
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
        let normalized_model_family_filters = normalize_model_family_filters(model_family_filters);

        let mut sql = if sort.field == "id" {
            String::from(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, images.is_favorite, images.is_locked
                 FROM images
                 JOIN images_fts_tri ON images.id = images_fts_tri.rowid
                 WHERE images_fts_tri MATCH ?",
            )
        } else {
            format!(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, images.is_favorite, images.is_locked, {} AS sort_value
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
                    row.get::<_, String>(10)?,
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
    pub fn filter_images_cursor(&self, params: FilterCursorParams<'_>) -> SqlResult<CursorPage> {
        let porter = self.filter_images_cursor_porter(params)?;
        if !porter.items.is_empty() {
            return Ok(porter);
        }

        let Some(query) = params.query else {
            return Ok(porter);
        };
        if query.trim().is_empty() {
            return Ok(porter);
        }

        self.filter_images_cursor_trigram(FilterCursorParams {
            query: Some(query),
            include_tags: params.include_tags,
            exclude_tags: params.exclude_tags,
            options: params.options,
        })
    }

    fn filter_images_cursor_porter(&self, params: FilterCursorParams<'_>) -> SqlResult<CursorPage> {
        let query = params.query;
        let include_tags = params.include_tags;
        let exclude_tags = params.exclude_tags;
        let CursorQueryOptions {
            cursor,
            limit,
            sort_by,
            generation_types,
            model_filter,
            model_family_filters,
        } = params.options;
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
        let normalized_model_family_filters = normalize_model_family_filters(model_family_filters);

        let mut params_vec = Vec::<Value>::new();

        let fts_join = if query.is_some() {
            " JOIN images_fts ON images.id = images_fts.rowid"
        } else {
            ""
        };

        let mut sql = if sort.field == "id" {
            format!(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, images.is_favorite, images.is_locked
                 FROM images{}",
                fts_join
            )
        } else {
            format!(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, images.is_favorite, images.is_locked, {} AS sort_value
                 FROM images{}",
                sort.sort_expr(),
                fts_join
            )
        };

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
                    row.get::<_, String>(10)?,
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
        params: FilterCursorParams<'_>,
    ) -> SqlResult<CursorPage> {
        let query = params.query.unwrap_or_default();
        let include_tags = params.include_tags;
        let exclude_tags = params.exclude_tags;
        let CursorQueryOptions {
            cursor,
            limit,
            sort_by,
            generation_types,
            model_filter,
            model_family_filters,
        } = params.options;
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
        let normalized_model_family_filters = normalize_model_family_filters(model_family_filters);

        let mut sql = if sort.field == "id" {
            String::from(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, images.is_favorite, images.is_locked
                 FROM images
                 JOIN images_fts_tri ON images.id = images_fts_tri.rowid
                 WHERE images_fts_tri MATCH ?",
            )
        } else {
            format!(
                "SELECT images.id, images.filepath, images.filename, images.directory,
                        images.seed, images.width, images.height, images.model_name, images.is_favorite, images.is_locked, {} AS sort_value
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
                    row.get::<_, String>(10)?,
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
}
