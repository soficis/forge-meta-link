// ────────────────────────── Image queries ──────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchImagesCursorRequest {
    pub query: String,
    pub cursor: Option<String>,
    pub limit: u32,
    pub generation_types: Option<Vec<String>>,
    pub sort_by: Option<String>,
    pub model_filter: Option<String>,
    pub model_family_filters: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterImagesCursorRequest {
    pub tags_include: Vec<String>,
    pub tags_exclude: Vec<String>,
    pub query: Option<String>,
    pub cursor: Option<String>,
    pub limit: u32,
    pub generation_types: Option<Vec<String>>,
    pub sort_by: Option<String>,
    pub model_filter: Option<String>,
    pub model_family_filters: Option<Vec<String>>,
}

/// Cursor-based pagination for infinite scroll with optional sorting.
#[tauri::command]
pub fn get_images_cursor(
    cursor: Option<String>,
    limit: u32,
    sort_by: Option<String>,
    generation_types: Option<Vec<String>>,
    model_filter: Option<String>,
    model_family_filters: Option<Vec<String>>,
    state: tauri::State<AppState>,
) -> Result<CursorPage, String> {
    let started = std::time::Instant::now();
    let result = state
        .db
        .get_images_cursor(
            cursor.as_deref(),
            limit,
            sort_by.as_deref(),
            generation_types.as_deref(),
            model_filter.as_deref(),
            model_family_filters.as_deref(),
        );
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    match &result {
        Ok(page) => log::info!(
            "Query get_images_cursor returned {} items in {:.1} ms (limit={}, sort={})",
            page.items.len(),
            elapsed_ms,
            limit,
            sort_by.as_deref().unwrap_or("newest")
        ),
        Err(error) => log::warn!(
            "Query get_images_cursor failed in {:.1} ms: {}",
            elapsed_ms,
            error
        ),
    }
    result.map_err(|e| e.to_string())
}

/// Cursor-based search.
#[tauri::command]
pub fn search_images_cursor(
    request: SearchImagesCursorRequest,
    state: tauri::State<AppState>,
) -> Result<CursorPage, String> {
    let SearchImagesCursorRequest {
        query,
        cursor,
        limit,
        generation_types,
        sort_by,
        model_filter,
        model_family_filters,
    } = request;
    let started = std::time::Instant::now();
    if query.trim().is_empty() {
        let result = state
            .db
            .get_images_cursor(
                cursor.as_deref(),
                limit,
                sort_by.as_deref(),
                generation_types.as_deref(),
                model_filter.as_deref(),
                model_family_filters.as_deref(),
            );
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        match &result {
            Ok(page) => log::info!(
                "Query search_images_cursor(empty) returned {} items in {:.1} ms (limit={})",
                page.items.len(),
                elapsed_ms,
                limit
            ),
            Err(error) => log::warn!(
                "Query search_images_cursor(empty) failed in {:.1} ms: {}",
                elapsed_ms,
                error
            ),
        }
        return result.map_err(|e| e.to_string());
    }

    let result = state
        .db
        .search_cursor(crate::database::SearchCursorParams {
            query: &query,
            options: crate::database::CursorQueryOptions {
                cursor: cursor.as_deref(),
                limit,
                sort_by: sort_by.as_deref(),
                generation_types: generation_types.as_deref(),
                model_filter: model_filter.as_deref(),
                model_family_filters: model_family_filters.as_deref(),
            },
        });
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    match &result {
        Ok(page) => log::info!(
            "Query search_images_cursor returned {} items in {:.1} ms (limit={}, query_len={})",
            page.items.len(),
            elapsed_ms,
            limit,
            query.len()
        ),
        Err(error) => log::warn!(
            "Query search_images_cursor failed in {:.1} ms: {}",
            elapsed_ms,
            error
        ),
    }
    result.map_err(|e| e.to_string())
}

/// Cursor-based filtering.
#[tauri::command]
pub fn filter_images_cursor(
    request: FilterImagesCursorRequest,
    state: tauri::State<AppState>,
) -> Result<CursorPage, String> {
    let FilterImagesCursorRequest {
        tags_include,
        tags_exclude,
        query,
        cursor,
        limit,
        generation_types,
        sort_by,
        model_filter,
        model_family_filters,
    } = request;
    let started = std::time::Instant::now();
    let result = state
        .db
        .filter_images_cursor(crate::database::FilterCursorParams {
            query: query.as_deref(),
            include_tags: &tags_include,
            exclude_tags: &tags_exclude,
            options: crate::database::CursorQueryOptions {
                cursor: cursor.as_deref(),
                limit,
                sort_by: sort_by.as_deref(),
                generation_types: generation_types.as_deref(),
                model_filter: model_filter.as_deref(),
                model_family_filters: model_family_filters.as_deref(),
            },
        });
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    match &result {
        Ok(page) => log::info!(
            "Query filter_images_cursor returned {} items in {:.1} ms (limit={}, include_tags={}, exclude_tags={}, query={})",
            page.items.len(),
            elapsed_ms,
            limit,
            tags_include.len(),
            tags_exclude.len(),
            query.as_deref().unwrap_or("").len()
        ),
        Err(error) => log::warn!(
            "Query filter_images_cursor failed in {:.1} ms: {}",
            elapsed_ms,
            error
        ),
    }
    result.map_err(|e| e.to_string())
}

// ────────────────────────── Tag queries ──────────────────────────

#[tauri::command]
pub fn list_tags(
    prefix: Option<String>,
    limit: u32,
    state: tauri::State<AppState>,
) -> Result<Vec<String>, String> {
    let started = std::time::Instant::now();
    let result = state
        .db
        .list_tags(prefix.as_deref(), limit)
        .map_err(|e| e.to_string());
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    if let Ok(tags) = &result {
        log::info!(
            "Query list_tags returned {} tags in {:.1} ms (prefix={}, limit={})",
            tags.len(),
            elapsed_ms,
            prefix.as_deref().unwrap_or(""),
            limit
        );
    }
    result
}

#[tauri::command]
pub fn get_top_tags(limit: u32, state: tauri::State<AppState>) -> Result<Vec<TagCount>, String> {
    let started = std::time::Instant::now();
    let result = state.db.get_top_tags(limit).map_err(|e| e.to_string());
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    if let Ok(tags) = &result {
        log::info!(
            "Query get_top_tags returned {} tags in {:.1} ms (limit={})",
            tags.len(),
            elapsed_ms,
            limit
        );
    }
    result
}

#[tauri::command]
pub fn get_image_tags(id: i64, state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    state.db.get_tags_for_image(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_image_detail(
    id: i64,
    state: tauri::State<AppState>,
) -> Result<Option<ImageRecord>, String> {
    state.db.get_image_by_id(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_total_count(state: tauri::State<AppState>) -> Result<u32, String> {
    state.db.get_total_count().map_err(|e| e.to_string())
}

// ────────────────────────── Group-by queries ──────────────────────────

/// Returns unique directories with image counts for group-by view.
#[tauri::command]
pub fn get_directories(state: tauri::State<AppState>) -> Result<Vec<DirectoryEntry>, String> {
    state.db.get_unique_directories().map_err(|e| e.to_string())
}

/// Returns unique model names with image counts for group-by view.
#[tauri::command]
pub fn get_models(state: tauri::State<AppState>) -> Result<Vec<ModelEntry>, String> {
    state.db.get_unique_models().map_err(|e| e.to_string())
}
