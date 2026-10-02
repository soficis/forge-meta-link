#[tauri::command]
pub fn get_file_mtimes(
    limit: Option<u32>,
    offset: Option<u32>,
    state: tauri::State<AppState>,
) -> Result<Vec<i64>, String> {
    let lim = limit.unwrap_or(50000).clamp(1, 50000);
    let off = offset.unwrap_or(0);
    let started = std::time::Instant::now();
    let result = state.db.get_file_mtimes_paginated(lim, off).map_err(|e| e.to_string());
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    match &result {
        Ok(v) => log::info!("get_file_mtimes returned {} mtimes in {:.1}ms (limit={} offset={})", v.len(), elapsed, lim, off),
        Err(e) => log::warn!("get_file_mtimes failed in {:.1}ms: {}", elapsed, e),
    }
    result
}

#[tauri::command]
pub fn get_file_mtimes_for_query(
    query: String,
    limit: Option<u32>,
    state: tauri::State<AppState>,
) -> Result<Vec<i64>, String> {
    let lim = limit.unwrap_or(50000).clamp(1, 50000);
    let started = std::time::Instant::now();
    if query.trim().is_empty() {
        let result = state.db.get_file_mtimes_paginated(lim, 0).map_err(|e| e.to_string());
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        match &result {
            Ok(v) => log::info!("get_file_mtimes_for_query(empty) returned {} in {:.1}ms", v.len(), elapsed),
            Err(e) => log::warn!("get_file_mtimes_for_query(empty) failed {:.1}ms: {}", elapsed, e),
        }
        return result;
    }
    let result = state.db.get_file_mtimes_for_query(&query, lim).map_err(|e| e.to_string());
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    match &result {
        Ok(v) => log::info!("get_file_mtimes_for_query '{}' returned {} in {:.1}ms", query, v.len(), elapsed),
        Err(e) => log::warn!("get_file_mtimes_for_query failed {:.1}ms: {}", elapsed, e),
    }
    result
}
