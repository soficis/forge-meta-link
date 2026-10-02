use crate::database::{GalleryImageRecord, LineageCursor, LineageTrace, TagProvenance};

#[tauri::command]
pub fn get_lineage_trace(
    image_id: i64,
    state: tauri::State<AppState>,
) -> Result<LineageTrace, String> {
    let started = std::time::Instant::now();
    let result = state.db.get_lineage_trace(image_id).map_err(|e| e.to_string());
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    match &result {
        Ok(trace) => log::info!(
            "get_lineage_trace image_id={} -> {} nodes in {:.1}ms",
            image_id,
            trace.nodes.len(),
            elapsed
        ),
        Err(e) => log::warn!("get_lineage_trace image_id={} failed {:.1}ms: {}", image_id, elapsed, e),
    }
    result
}

#[tauri::command]
pub fn get_lineage_cursor(
    filepath: String,
    state: tauri::State<AppState>,
) -> Result<LineageCursor, String> {
    let started = std::time::Instant::now();
    let result = state.db.get_lineage_cursor(&filepath).map_err(|e| e.to_string());
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    match &result {
        Ok(cursor) => log::info!(
            "get_lineage_cursor '{}' -> {} ancestors {} children in {:.1}ms",
            filepath,
            cursor.ancestors.len(),
            cursor.children.len(),
            elapsed
        ),
        Err(e) => log::warn!("get_lineage_cursor '{}' failed {:.1}ms: {}", filepath, elapsed, e),
    }
    result
}

#[tauri::command]
pub fn get_seed_walk(
    seed: String,
    prompt_like: Option<String>,
    limit: Option<u32>,
    state: tauri::State<AppState>,
) -> Result<Vec<GalleryImageRecord>, String> {
    let lim = limit.unwrap_or(16).clamp(1, 100);
    let started = std::time::Instant::now();
    let result = state
        .db
        .get_seed_walk(&seed, prompt_like.as_deref(), lim)
        .map_err(|e| e.to_string());
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    match &result {
        Ok(v) => log::info!(
            "get_seed_walk seed={} prompt_like={:?} limit={} -> {} results in {:.1}ms",
            seed,
            prompt_like,
            lim,
            v.len(),
            elapsed
        ),
        Err(e) => log::warn!("get_seed_walk seed={} failed {:.1}ms: {}", seed, elapsed, e),
    }
    result
}

#[tauri::command]
pub fn get_tag_provenance(
    tag: String,
    state: tauri::State<AppState>,
) -> Result<TagProvenance, String> {
    let started = std::time::Instant::now();
    let result = state.db.get_tag_provenance(&tag).map_err(|e| e.to_string());
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    match &result {
        Ok(p) => log::info!(
            "get_tag_provenance '{}' -> count {} in {:.1}ms",
            tag,
            p.count,
            elapsed
        ),
        Err(e) => log::warn!("get_tag_provenance '{}' failed {:.1}ms: {}", tag, elapsed, e),
    }
    result
}

#[tauri::command]
pub async fn infer_lineage(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    let started = std::time::Instant::now();
    let db = state.db.clone();
    let result = tauri::async_runtime::spawn_blocking(move || db.rebuild_lineage())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string());
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    match &result {
        Ok(n) => {
            log::info!("rebuild_lineage finished with {} edges in {:.1}ms", n, elapsed);
            let _ = app.emit("lineage-updated", serde_json::json!({ "edges": n }));
        }
        Err(e) => log::warn!("rebuild_lineage failed {:.1}ms: {}", elapsed, e),
    }
    result
}

#[tauri::command]
pub fn set_lineage_override(
    child_filepath: String,
    parent_filepath: String,
    relation: String,
    confidence: f64,
    action: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    state
        .db
        .upsert_lineage_override(
            &child_filepath,
            &parent_filepath,
            &relation,
            confidence,
            &action,
        )
        .map_err(|e| e.to_string())
}
