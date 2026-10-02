use forge_meta_link_lib::{database::Database, parser::GenerationParams, StorageProfile};

fn mem_db() -> Database {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tid = std::thread::current().id();
    let path = std::env::temp_dir().join(format!(
        "forge_lineage_int_{}_{}_{:?}.db",
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
    let dir = filepath.rsplit_once('/').map(|(d, _)| d).unwrap_or("/");
    db.upsert_image(filepath, filename, dir, &params, mtime)
        .expect("insert");
}

#[test]
fn cursor_empty_returns_no_ancestors_children() {
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
        "ancestors should be empty when no lineage, got {:?}",
        cursor.ancestors
    );
    assert!(
        cursor.children.is_empty(),
        "children should be empty when no lineage"
    );
}

#[test]
fn cursor_missing_filepath_returns_empty() {
    let db = mem_db();
    let cursor = db.get_lineage_cursor("/nonexistent.png").expect("cursor");
    assert!(
        cursor.ancestors.is_empty(),
        "missing filepath ancestors should be empty"
    );
    assert!(
        cursor.children.is_empty(),
        "missing filepath children should be empty"
    );
}

#[test]
fn cursor_respects_confidence_ordering_and_limits() {
    let db = mem_db();
    let conn = db.pool_get_for_test().unwrap();
    conn.execute("INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/p1.png','p1.png','/','x')", []).unwrap();
    conn.execute("INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/p2.png','p2.png','/','y')", []).unwrap();
    conn.execute("INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/p3.png','p3.png','/','z')", []).unwrap();
    conn.execute("INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/p4.png','p4.png','/','w')", []).unwrap();
    conn.execute("INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/child.png','child.png','/','c')", []).unwrap();
    // 4 ancestors with varying confidence, only 3 should be returned ordered
    conn.execute("INSERT INTO lineage(child_filepath, parent_filepath, relation, confidence, created_at) VALUES ('/child.png','/p1.png','seed_walk',0.5, 10)", []).unwrap();
    conn.execute("INSERT INTO lineage(child_filepath, parent_filepath, relation, confidence, created_at) VALUES ('/child.png','/p2.png','seed_walk',0.9, 20)", []).unwrap();
    conn.execute("INSERT INTO lineage(child_filepath, parent_filepath, relation, confidence, created_at) VALUES ('/child.png','/p3.png','seed_walk',0.7, 30)", []).unwrap();
    conn.execute("INSERT INTO lineage(child_filepath, parent_filepath, relation, confidence, created_at) VALUES ('/child.png','/p4.png','seed_walk',0.95, 5)", []).unwrap();
    let cursor = db.get_lineage_cursor("/child.png").unwrap();
    assert_eq!(
        cursor.ancestors.len(),
        3,
        "should limit to 3 ancestors, got {}",
        cursor.ancestors.len()
    );
    assert_eq!(cursor.ancestors[0].parent_filepath, "/p4.png");
    assert_eq!(cursor.ancestors[1].parent_filepath, "/p2.png");
    assert_eq!(cursor.ancestors[2].parent_filepath, "/p3.png");
}

#[test]
fn seed_walk_limits_and_proximity() {
    let db = mem_db();
    insert_image(
        &db,
        "/s_1000.png",
        Some("1000"),
        Some("h1"),
        "castle",
        Some(1000),
    );
    insert_image(
        &db,
        "/s_1005.png",
        Some("1005"),
        Some("h1"),
        "castle",
        Some(1010),
    );
    insert_image(
        &db,
        "/s_1020.png",
        Some("1020"),
        Some("h1"),
        "castle",
        Some(1020),
    );
    let results = db.get_seed_walk("1000", Some("castle"), 16).unwrap();
    let fps: Vec<String> = results.iter().map(|r| r.filepath.clone()).collect();
    assert!(fps.contains(&"/s_1000.png".to_string()));
    assert!(fps.contains(&"/s_1005.png".to_string()));
    assert!(
        !fps.contains(&"/s_1020.png".to_string()),
        "1020 beyond +-16 should be filtered, got {:?}",
        fps
    );
}

#[test]
fn infer_lineage_idempotent_and_respects_overrides() {
    let db = mem_db();
    for i in 0..3 {
        insert_image(
            &db,
            &format!("/dir/a_{}.png", i),
            Some("2000"),
            Some("hm"),
            "forest",
            Some(5000 + i * 10),
        );
    }
    let first = db.infer_lineage().unwrap();
    assert!(first > 0);
    let second = db.infer_lineage().unwrap();
    assert_eq!(second, 0, "idempotent second run");
    // overrides unlink
    let conn = db.pool_get_for_test().unwrap();
    let existing: String = conn
        .query_row("SELECT child_filepath FROM lineage LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    let parent: String = conn
        .query_row("SELECT parent_filepath FROM lineage LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    drop(conn);
    db.upsert_lineage_override(&existing, &parent, "seed_walk", 0.9, "unlink")
        .unwrap();
    let cursor = db.get_lineage_cursor(&existing).unwrap();
    assert!(
        cursor.ancestors.iter().all(|e| e.parent_filepath != parent),
        "unlink should hide"
    );
}

#[test]
fn test_update_image_location_child_with_lineage_and_override() {
    let db = mem_db();
    insert_image(&db, "/p.png", Some("100"), Some("h1"), "prompt", Some(1000));
    insert_image(&db, "/c.png", Some("100"), Some("h1"), "prompt", Some(2000));

    let conn = db.pool_get_for_test().unwrap();
    conn.execute(
        "INSERT INTO lineage (child_filepath, parent_filepath, relation, confidence) VALUES ('/c.png', '/p.png', 'seed_walk', 0.9)",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO lineage_overrides (child_filepath, parent_filepath, relation, confidence, action) VALUES ('/c.png', '/p.png', 'seed_walk', 0.9, 'link')",
        [],
    ).unwrap();
    let child_id: i64 = conn
        .query_row("SELECT id FROM images WHERE filepath = '/c.png'", [], |r| {
            r.get(0)
        })
        .unwrap();
    drop(conn);

    let moved = db
        .update_image_location(child_id, "/moved_c.png", "moved_c.png", "/")
        .expect("move child should succeed");
    assert!(moved);

    let conn = db.pool_get_for_test().unwrap();
    let child_edge_path: String = conn
        .query_row(
            "SELECT child_filepath FROM lineage WHERE parent_filepath = '/p.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(child_edge_path, "/moved_c.png");

    let override_child_path: String = conn
        .query_row(
            "SELECT child_filepath FROM lineage_overrides WHERE parent_filepath = '/p.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(override_child_path, "/moved_c.png");

    let fk_violations: Vec<String> = conn
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |r| {
            Ok(format!(
                "{}:{}",
                r.get::<_, String>(0)?,
                r.get::<_, String>(2)?
            ))
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(
        fk_violations.is_empty(),
        "foreign key violations: {:?}",
        fk_violations
    );
}

#[test]
fn test_update_image_location_parent_updates_parent_filepath() {
    let db = mem_db();
    insert_image(&db, "/p.png", Some("100"), Some("h1"), "prompt", Some(1000));
    insert_image(&db, "/c.png", Some("100"), Some("h1"), "prompt", Some(2000));

    let conn = db.pool_get_for_test().unwrap();
    conn.execute(
        "INSERT INTO lineage (child_filepath, parent_filepath, relation, confidence) VALUES ('/c.png', '/p.png', 'seed_walk', 0.9)",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO lineage_overrides (child_filepath, parent_filepath, relation, confidence, action) VALUES ('/c.png', '/p.png', 'seed_walk', 0.9, 'link')",
        [],
    ).unwrap();
    let parent_id: i64 = conn
        .query_row("SELECT id FROM images WHERE filepath = '/p.png'", [], |r| {
            r.get(0)
        })
        .unwrap();
    drop(conn);

    let moved = db
        .update_image_location(parent_id, "/moved_p.png", "moved_p.png", "/")
        .expect("move parent should succeed");
    assert!(moved);

    let conn = db.pool_get_for_test().unwrap();
    let parent_edge_path: String = conn
        .query_row(
            "SELECT parent_filepath FROM lineage WHERE child_filepath = '/c.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(parent_edge_path, "/moved_p.png");

    let override_parent_path: String = conn
        .query_row(
            "SELECT parent_filepath FROM lineage_overrides WHERE child_filepath = '/c.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(override_parent_path, "/moved_p.png");

    let fk_violations: Vec<String> = conn
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |r| {
            Ok(format!(
                "{}:{}",
                r.get::<_, String>(0)?,
                r.get::<_, String>(2)?
            ))
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(
        fk_violations.is_empty(),
        "foreign key violations: {:?}",
        fk_violations
    );
}

#[test]
fn test_update_image_location_same_path_succeeds() {
    let db = mem_db();
    insert_image(
        &db,
        "/same.png",
        Some("100"),
        Some("h1"),
        "prompt",
        Some(1000),
    );
    let conn = db.pool_get_for_test().unwrap();
    let id: i64 = conn
        .query_row(
            "SELECT id FROM images WHERE filepath = '/same.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    drop(conn);

    let moved = db
        .update_image_location(id, "/same.png", "same.png", "/")
        .expect("move to same path should succeed");
    assert!(moved);
}

#[test]
fn test_lineage_backfill_migration() {
    let db = mem_db();
    insert_image(
        &db,
        "/dir/p.png",
        Some("100"),
        Some("h1"),
        "prompt A",
        Some(1000),
    );
    insert_image(
        &db,
        "/dir/c.png",
        Some("100"),
        Some("h1"),
        "prompt A",
        Some(2000),
    );

    let res = db.run_lineage_backfill_if_needed().expect("backfill 1");
    assert!(res.is_some());
    assert!(res.unwrap() > 0, "should have found edges");

    let conn = db.pool_get_for_test().unwrap();
    let row_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'lineage_backfill_v1')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(row_exists, "migration row should exist");

    let edge_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM lineage", [], |r| r.get(0))
        .unwrap();
    assert!(edge_count > 0, "lineage edges should exist");
    drop(conn);

    let res2 = db.run_lineage_backfill_if_needed().expect("backfill 2");
    assert_eq!(res2, None, "second run should do nothing");
}
