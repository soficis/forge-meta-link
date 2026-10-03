use forge_meta_link_lib::{
    database::{CursorQueryOptions, Database, FilterCursorParams, SearchCursorParams},
    parser::GenerationParams,
    StorageProfile,
};
use rusqlite::params;

fn test_db() -> Database {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tid = std::thread::current().id();
    let path = std::env::temp_dir().join(format!(
        "forge_p1_test_{}_{}_{:?}.db",
        std::process::id(),
        nanos,
        tid
    ));
    Database::new(&path, StorageProfile::Hdd).expect("failed to create test db")
}

#[test]
fn test_p1_migrations_recorded_in_app_migrations() {
    let db = test_db();
    let conn = db.pool_get_for_test().expect("pool get");

    let culled_migrated: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'culled_at_v1')",
            [],
            |r| r.get(0),
        )
        .expect("query culled_at_v1");
    assert!(culled_migrated, "culled_at_v1 must be in app_migrations");

    let edges_migrated: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'lineage_edges_v1')",
            [],
            |r| r.get(0),
        )
        .expect("query lineage_edges_v1");
    assert!(edges_migrated, "lineage_edges_v1 must be in app_migrations");
}

#[test]
fn test_p1_culled_schema_and_view_exist() {
    let db = test_db();
    let conn = db.pool_get_for_test().expect("pool get");

    // Check columns
    let mut stmt = conn.prepare("PRAGMA table_info(images)").unwrap();
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert!(
        columns.contains(&"culled_at".to_string()),
        "images.culled_at must exist"
    );
    assert!(
        columns.contains(&"ghost_recipe".to_string()),
        "images.ghost_recipe must exist"
    );

    // Check index
    let idx_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_images_culled_at')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(idx_exists, "idx_images_culled_at must exist");

    // Check images_live view
    let view_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='view' AND name='images_live')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(view_exists, "images_live view must exist");
}

#[test]
fn test_p1_lineage_edges_schema_exists() {
    let db = test_db();
    let conn = db.pool_get_for_test().expect("pool get");

    let table_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='lineage_edges')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(table_exists, "lineage_edges table must exist");

    let idx_child: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_lineage_edges_child')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(idx_child, "idx_lineage_edges_child must exist");

    let idx_parent: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_lineage_edges_parent')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(idx_parent, "idx_lineage_edges_parent must exist");
}

#[test]
fn test_p1_central_filter_table_driven_all_reads_exclude_culled() {
    let db = test_db();
    let conn = db.pool_get_for_test().expect("pool get");

    // Insert live image
    let p_live = GenerationParams {
        prompt: "cyberpunk cat neon street".to_string(),
        negative_prompt: "lowres".to_string(),
        steps: Some("20".to_string()),
        sampler: Some("Euler".to_string()),
        cfg_scale: Some("7.0".to_string()),
        seed: Some("1111".to_string()),
        width: Some(512),
        height: Some(512),
        model_name: Some("v1-5-pruned".to_string()),
        model_hash: Some("abcd1234".to_string()),
        raw_metadata: "cyberpunk cat neon street".to_string(),
        ..Default::default()
    };
    let live_id = db
        .upsert_image(
            "/gallery/live_cat.png",
            "live_cat.png",
            "/gallery",
            &p_live,
            Some(1000),
        )
        .expect("insert live");
    db.replace_image_tags(live_id, &["cat".to_string(), "cyberpunk".to_string()])
        .expect("set live tags");

    // Insert culled image directly
    let p_culled = GenerationParams {
        prompt: "cyberpunk dog neon street".to_string(),
        negative_prompt: "lowres".to_string(),
        steps: Some("20".to_string()),
        sampler: Some("Euler".to_string()),
        cfg_scale: Some("7.0".to_string()),
        seed: Some("2222".to_string()),
        width: Some(512),
        height: Some(512),
        model_name: Some("v1-5-pruned".to_string()),
        model_hash: Some("abcd1234".to_string()),
        raw_metadata: "cyberpunk dog neon street".to_string(),
        ..Default::default()
    };
    let culled_id = db
        .upsert_image(
            "/gallery/culled_dog.png",
            "culled_dog.png",
            "/gallery",
            &p_culled,
            Some(2000),
        )
        .expect("insert culled");
    db.replace_image_tags(culled_id, &["dog".to_string(), "cyberpunk".to_string()])
        .expect("set culled tags");

    // Mark culled_at on culled image
    conn.execute(
        "UPDATE images SET culled_at = 1700000000 WHERE id = ?1",
        params![culled_id],
    )
    .expect("set culled_at");

    let default_options = CursorQueryOptions {
        cursor: None,
        limit: 100,
        sort_by: None,
        generation_types: None,
        model_filter: None,
        model_family_filters: None,
    };

    // 1. get_total_count() must be 1
    assert_eq!(
        db.get_total_count().unwrap(),
        1,
        "get_total_count must exclude culled"
    );

    // 2. get_image_by_id
    assert!(
        db.get_image_by_id(live_id).unwrap().is_some(),
        "live image must be found"
    );
    assert!(
        db.get_image_by_id(culled_id).unwrap().is_none(),
        "culled image must NOT be found by id"
    );

    // 3. get_images_by_ids
    let by_ids = db.get_images_by_ids(&[live_id, culled_id]).unwrap();
    assert_eq!(
        by_ids.len(),
        1,
        "get_images_by_ids must only return live image"
    );
    assert_eq!(by_ids[0].id, live_id);

    // 4. get_all_image_filepaths_desc
    let all_fps = db.get_all_image_filepaths_desc().unwrap();
    assert_eq!(
        all_fps,
        vec!["/gallery/live_cat.png"],
        "get_all_image_filepaths_desc must only return live paths"
    );

    // 5. get_image_filepaths_batch_after
    let batch_fps = db.get_image_filepaths_batch_after(None, 100).unwrap();
    assert_eq!(
        batch_fps,
        vec!["/gallery/live_cat.png"],
        "batch after must only return live paths"
    );

    // 6. get_unique_directories
    let dirs = db.get_unique_directories().unwrap();
    assert_eq!(dirs.len(), 1);
    assert_eq!(
        dirs[0].count, 1,
        "unique directory count must exclude culled"
    );

    // 7. get_unique_models
    let models = db.get_unique_models().unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].count, 1, "unique model count must exclude culled");

    // 8. get_images_cursor
    let page = db
        .get_images_cursor(None, 100, None, None, None, None)
        .unwrap();
    assert_eq!(
        page.items.len(),
        1,
        "cursor page must only contain live image"
    );
    assert_eq!(page.items[0].id, live_id);

    // 9. search_cursor (query matches both prompts: "cyberpunk")
    let search_res = db
        .search_cursor(SearchCursorParams {
            query: "cyberpunk",
            options: default_options,
        })
        .unwrap();
    assert_eq!(
        search_res.items.len(),
        1,
        "search_cursor must only find live image"
    );
    assert_eq!(search_res.items[0].id, live_id);

    // 10. filter_images_cursor
    let filter_res = db
        .filter_images_cursor(FilterCursorParams {
            query: Some("neon"),
            include_tags: &[],
            exclude_tags: &[],
            options: default_options,
        })
        .unwrap();
    assert_eq!(
        filter_res.items.len(),
        1,
        "filter_images_cursor must only find live image"
    );
    assert_eq!(filter_res.items[0].id, live_id);

    // 11. count_images_with_stem
    assert_eq!(
        db.count_images_with_stem("/gallery", "live_cat").unwrap(),
        1
    );
    assert_eq!(
        db.count_images_with_stem("/gallery", "culled_dog").unwrap(),
        0,
        "stem count must exclude culled"
    );

    // 12. get_file_mtimes_paginated
    let mtimes = db.get_file_mtimes_paginated(10, 0).unwrap();
    assert_eq!(mtimes, vec![1000], "file_mtimes must exclude culled");

    // 13. get_file_mtimes_for_query
    let query_mtimes = db.get_file_mtimes_for_query("cyberpunk", 10).unwrap();
    assert_eq!(query_mtimes, vec![1000], "query_mtimes must exclude culled");

    // 14. get_top_tags: tag "dog" was only on culled; tag "cyberpunk" was on both; count must be 1
    let top_tags = db.get_top_tags(10).unwrap();
    let cat_tag = top_tags.iter().find(|t| t.tag == "cat");
    let dog_tag = top_tags.iter().find(|t| t.tag == "dog");
    let cyber_tag = top_tags.iter().find(|t| t.tag == "cyberpunk");
    assert!(cat_tag.is_some(), "cat tag must be present");
    assert!(
        dog_tag.is_none(),
        "dog tag from culled image must NOT be present"
    );
    assert_eq!(
        cyber_tag.map(|t| t.count),
        Some(1),
        "cyberpunk tag count must be 1 (only live image)"
    );
}
