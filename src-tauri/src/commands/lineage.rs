use crate::database::{GalleryImageRecord, LineageCursor, LineageTrace, TagProvenance};

#[tauri::command]
pub fn get_lineage_trace(
    image_id: i64,
    state: tauri::State<AppState>,
) -> Result<LineageTrace, String> {
    let started = std::time::Instant::now();
    let result = state
        .db
        .get_lineage_trace(image_id)
        .map_err(|e| e.to_string())
        .map(|mut trace| {
            attach_ghost_thumbnails(&mut trace, &state.cache_dir);
            trace
        });
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

/// Points Trash-culled ancestors at their cached thumbnail when one still exists. Only an
/// existing cache file counts: nothing is generated (the source is in the OS trash) and nothing
/// is marked failed, so a later restore still thumbnails normally. Permanent ghosts have a
/// `ghost://` path and no thumbnail by design.
pub fn attach_ghost_thumbnails(trace: &mut LineageTrace, cache_dir: &Path) {
    for node in trace.nodes.iter_mut() {
        if !node.is_ghost || node.filepath.starts_with("ghost://") {
            continue;
        }
        let cached = image_processing::get_thumbnail_cache_path(Path::new(&node.filepath), cache_dir);
        if cached.exists() {
            node.thumbnail_path = Some(cached.to_string_lossy().to_string());
        }
    }
}

#[cfg(test)]
mod ghost_thumbnail_tests {
    use super::*;
    use crate::database::LineageTraceNode;

    fn node(id: i64, filepath: &str, is_ghost: bool) -> LineageTraceNode {
        LineageTraceNode {
            id,
            filepath: filepath.to_string(),
            filename: "x.png".to_string(),
            is_ghost,
            ghost_recipe: None,
            ops_json: None,
            source: "root".to_string(),
            parent_id: None,
            depth: 0,
            seed: None,
            cfg_scale: None,
            steps: None,
            sampler: None,
            scheduler: None,
            model_name: None,
            prompt: None,
            thumbnail_path: None,
        }
    }

    #[test]
    fn only_trash_ghosts_with_an_existing_cache_file_get_a_thumbnail() {
        let cache = std::env::temp_dir().join(format!("forge_ghost_thumbs_{}", std::process::id()));
        std::fs::create_dir_all(&cache).unwrap();

        let cached_src = "/gone/cached.png";
        std::fs::write(
            image_processing::get_thumbnail_cache_path(Path::new(cached_src), &cache),
            b"jpeg",
        )
        .unwrap();

        let mut trace = LineageTrace {
            target_id: 1,
            nodes: vec![
                node(1, "/live/a.png", false),
                node(2, cached_src, true),
                node(3, "/gone/uncached.png", true),
                node(4, "ghost://4", true),
            ],
        };
        // A cache file for a live node must be ignored too: the UI resolves those itself.
        std::fs::write(
            image_processing::get_thumbnail_cache_path(Path::new("/live/a.png"), &cache),
            b"jpeg",
        )
        .unwrap();

        attach_ghost_thumbnails(&mut trace, &cache);
        assert!(trace.nodes[0].thumbnail_path.is_none(), "live node untouched");
        assert!(trace.nodes[1].thumbnail_path.is_some(), "cached Trash ghost gets its thumbnail");
        assert!(trace.nodes[2].thumbnail_path.is_none(), "no cache file, no thumbnail, nothing generated");
        assert!(trace.nodes[3].thumbnail_path.is_none(), "Permanent ghost never has one");
        let _ = std::fs::remove_dir_all(&cache);
    }
}
