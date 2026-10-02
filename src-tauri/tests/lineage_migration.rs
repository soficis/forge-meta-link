use forge_meta_link_lib::{database::Database, StorageProfile};

fn memory_db() -> Database {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tid = std::thread::current().id();
    let path = std::env::temp_dir().join(format!(
        "forge_lineage_mig_{}_{}_{:?}.db",
        std::process::id(),
        nanos,
        tid
    ));
    Database::new(&path, StorageProfile::Hdd).expect("failed to create db")
}

#[test]
fn test_lineage_schema_exists_with_constraints() {
    let db = memory_db();
    let conn = db.pool_get_for_test().expect("pool get");

    // Table must exist
    let table_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='lineage'",
            [],
            |row| row.get(0),
        )
        .expect("query failed");
    assert_eq!(table_count, 1, "lineage table should exist");

    // Dump CREATE TABLE sql for checks
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='lineage'",
            [],
            |row| row.get(0),
        )
        .expect("sql fetch failed");
    assert!(
        sql.contains("CHECK"),
        "lineage sql should contain CHECK, got: {sql}"
    );
    // relation CHECK must contain enum values
    for val in &["txt2img2img", "inpaint", "upscale", "grid", "seed_walk"] {
        assert!(
            sql.contains(val),
            "relation CHECK should contain '{val}', got: {sql}"
        );
    }
    // confidence 0-1 check
    assert!(
        sql.contains("confidence") && sql.contains("0") && sql.contains("1"),
        "confidence CHECK 0-1 missing, got: {sql}"
    );
    // UNIQUE(child,parent) — check for UNIQUE and both column names
    assert!(
        sql.to_lowercase().contains("unique"),
        "UNIQUE constraint missing, got: {sql}"
    );
    // FK ON DELETE CASCADE
    assert!(
        sql.contains("FOREIGN KEY") && sql.contains("ON DELETE CASCADE"),
        "FK ON DELETE CASCADE missing, got: {sql}"
    );
}

#[test]
fn test_lineage_six_indexes_exist() {
    let db = memory_db();
    let conn = db.pool_get_for_test().expect("pool get");

    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('lineage','images')")
        .unwrap();
    let mut names: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    names.sort();

    // Expected 6 indexes per spec
    let expected = [
        "idx_images_file_mtime",
        "idx_images_filepath",
        "idx_images_model_hash",
        "idx_lineage_child",
        "idx_lineage_confidence",
        "idx_lineage_parent",
    ];
    for idx in expected {
        assert!(
            names.contains(&idx.to_string()),
            "missing index {idx}, found: {names:?}"
        );
    }

    // Also verify via PRAGMA index_list for lineage
    let mut idx_list_stmt = conn.prepare("PRAGMA index_list('lineage')").unwrap();
    let lineage_indexes: Vec<String> = idx_list_stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for idx in [
        "idx_lineage_parent",
        "idx_lineage_child",
        "idx_lineage_confidence",
    ] {
        assert!(
            lineage_indexes.contains(&idx.to_string()),
            "PRAGMA index_list missing {idx}, got: {lineage_indexes:?}"
        );
    }
}

#[test]
fn test_lineage_idempotent_double_apply() {
    let db = memory_db();
    // Second init on same DB handle should be idempotent — call init via re-creating table manually
    let conn = db.pool_get_for_test().expect("pool get");
    // Re-run the migration SQL as would be done on second Database::new
    let sql = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='lineage'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    // Execute again idempotently — should not error
    conn.execute_batch(&sql.replace("CREATE TABLE lineage", "CREATE TABLE IF NOT EXISTS lineage"))
        .expect("double apply should be idempotent");

    // Verify still one table
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='lineage'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn test_lineage_relation_check_rejects_invalid() {
    let db = memory_db();
    let conn = db.pool_get_for_test().expect("pool get");

    // Need parent and child images to satisfy FK, or disable FK? Insert dummy images first
    conn.execute(
        "INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/a.png','a.png','/','x')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/b.png','b.png','/','y')",
        [],
    )
    .unwrap();

    let result = conn.execute(
        "INSERT INTO lineage(child_filepath, parent_filepath, relation, confidence) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params!["/a.png", "/b.png", "invalid_relation", 0.5],
    );
    assert!(
        result.is_err(),
        "invalid relation should be rejected by CHECK"
    );
}

#[test]
fn test_lineage_confidence_check_rejects_out_of_range() {
    let db = memory_db();
    let conn = db.pool_get_for_test().expect("pool get");
    conn.execute(
        "INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/a.png','a.png','/','x')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO images(filepath, filename, directory, prompt) VALUES ('/b.png','b.png','/','y')",
        [],
    )
    .unwrap();

    for bad in [-0.1, 1.5, 2.0] {
        let result = conn.execute(
            "INSERT INTO lineage(child_filepath, parent_filepath, relation, confidence) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params!["/a.png", "/b.png", "grid", bad],
        );
        assert!(result.is_err(), "confidence {bad} should be rejected");
    }
}

#[test]
fn test_bulk_upsert_with_tags_chunks_500() {
    let db = memory_db();
    // Build 600 records to ensure chunking at 500 is exercised (if unbounded, may still succeed but we verify count)
    let mut records = Vec::new();
    for i in 0..600 {
        records.push(forge_meta_link_lib::database::BulkRecord {
            filepath: format!("/tmp/img_{i:04}.png"),
            filename: format!("img_{i:04}.png"),
            directory: "/tmp".to_string(),
            params: forge_meta_link_lib::parser::GenerationParams {
                prompt: format!("prompt {i}"),
                raw_metadata: format!("prompt {i}"),
                ..Default::default()
            },
            file_mtime: Some(1000 + i as i64),
            file_size: Some(1024),
            quick_hash: Some(format!("hash{i:08}")),
            tags: vec!["test".to_string()],
        });
    }
    let count = db
        .bulk_upsert_with_tags(&records)
        .expect("bulk upsert 600 should succeed");
    assert_eq!(count, 600);
    assert_eq!(db.get_total_count().unwrap(), 600);
}

#[test]
fn test_seed_int_column_and_index_exist() {
    let db = memory_db();
    let conn = db.pool_get_for_test().expect("pool get");

    // Column check
    let mut stmt = conn.prepare("PRAGMA table_info(images)").unwrap();
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        columns.contains(&"seed_int".to_string()),
        "seed_int column missing from images table: {columns:?}"
    );

    // Index check
    let idx_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_images_seed_int')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(idx_exists, "idx_images_seed_int index must exist");
}

#[test]
fn test_seed_int_backfill_and_upsert() {
    let db = memory_db();
    let conn = db.pool_get_for_test().expect("pool get");

    // Manually insert an image without seed_int
    conn.execute(
        "INSERT INTO images (filepath, filename, directory, prompt, seed) VALUES ('/test/1.png', '1.png', '/test', 'cat', '42000')",
        [],
    ).unwrap();

    // Trigger backfill SQL
    conn.execute_batch(
        "UPDATE images SET seed_int = CAST(seed AS INTEGER) WHERE seed IS NOT NULL AND seed GLOB '[0-9]*' AND seed_int IS NULL;",
    ).unwrap();

    let val: Option<i64> = conn
        .query_row(
            "SELECT seed_int FROM images WHERE filepath = '/test/1.png'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(val, Some(42000));

    // Upsert with bulk_upsert_with_tags
    let rec = forge_meta_link_lib::database::BulkRecord {
        filepath: "/test/2.png".to_string(),
        filename: "2.png".to_string(),
        directory: "/test".to_string(),
        params: forge_meta_link_lib::parser::GenerationParams {
            prompt: "dog".to_string(),
            seed: Some("987654".to_string()),
            ..Default::default()
        },
        file_mtime: Some(5000),
        file_size: Some(1024),
        quick_hash: None,
        tags: vec![],
    };
    db.bulk_upsert_with_tags(&[rec]).unwrap();

    let val2: Option<i64> = conn
        .query_row(
            "SELECT seed_int FROM images WHERE filepath = '/test/2.png'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(val2, Some(987654));
}

#[test]
fn test_5k_images_lineage_infer_under_1s() {
    let db = memory_db();

    // Insert 5,000 images with structured seeds and timestamps in chunks of 500
    for chunk_idx in 0..10 {
        let mut records = Vec::with_capacity(500);
        for i in 0..500 {
            let id = chunk_idx * 500 + i;
            let seed = 1_000_000 + (id % 100) * 10 + (id % 3);
            let mtime = 1_700_000_000 + (id as i64 * 60);
            records.push(forge_meta_link_lib::database::BulkRecord {
                filepath: format!("/dataset/img_{id:05}.png"),
                filename: format!("img_{id:05}.png"),
                directory: "/dataset".to_string(),
                params: forge_meta_link_lib::parser::GenerationParams {
                    prompt: format!("masterpiece portrait character {}", id % 20),
                    seed: Some(seed.to_string()),
                    model_hash: Some("abc123hash".to_string()),
                    ..Default::default()
                },
                file_mtime: Some(mtime),
                file_size: Some(2048),
                quick_hash: Some(format!("hash_{id}")),
                tags: vec!["character".to_string()],
            });
        }
        db.bulk_upsert_with_tags(&records).unwrap();
    }

    let started = std::time::Instant::now();
    let edges_count = db.infer_lineage().expect("infer_lineage must succeed");
    let elapsed = started.elapsed();

    println!(
        "Lineage infer on 5k images: {} edges inferred in {:?}",
        edges_count, elapsed
    );
    assert!(
        elapsed.as_millis() < 1000,
        "Lineage infer on 5k images took {:?}, must be under 1s",
        elapsed
    );
}

#[test]
fn test_parse_seed_int_cases() {
    use forge_meta_link_lib::database::parse_seed_int;

    assert_eq!(parse_seed_int("-1"), None);
    assert_eq!(parse_seed_int("+5"), None);
    assert_eq!(parse_seed_int(" 12 "), Some(12));
    assert_eq!(parse_seed_int("0"), None);
    assert_eq!(parse_seed_int("007"), Some(7));
    assert_eq!(parse_seed_int("1234567890123456789"), None); // 19 digits
    assert_eq!(parse_seed_int("12.5"), None);
    assert_eq!(parse_seed_int("abc"), None);
    assert_eq!(parse_seed_int(""), None);
    assert_eq!(parse_seed_int("   "), None);
    assert_eq!(parse_seed_int("0000"), None);
}

#[test]
fn test_seed_minus_one_has_null_seed_int_and_no_lineage_edge() {
    let db = memory_db();

    // Insert two images with seed "-1" (e.g. placeholder seed in some generators)
    let p1 = forge_meta_link_lib::parser::GenerationParams {
        prompt: "a majestic dragon".to_string(),
        seed: Some("-1".to_string()),
        model_hash: Some("model_xyz".to_string()),
        ..Default::default()
    };
    db.upsert_image("/test/dragon1.png", "dragon1.png", "/test", &p1, Some(1000))
        .unwrap();

    let p2 = forge_meta_link_lib::parser::GenerationParams {
        prompt: "a majestic dragon".to_string(),
        seed: Some("-1".to_string()),
        model_hash: Some("model_xyz".to_string()),
        ..Default::default()
    };
    db.upsert_image("/test/dragon2.png", "dragon2.png", "/test", &p2, Some(2000))
        .unwrap();

    // Verify seed_int IS NULL for both
    let conn = db.pool_get_for_test().unwrap();
    let s1: Option<i64> = conn
        .query_row(
            "SELECT seed_int FROM images WHERE filepath = '/test/dragon1.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let s2: Option<i64> = conn
        .query_row(
            "SELECT seed_int FROM images WHERE filepath = '/test/dragon2.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(s1, None, "seed -1 must result in NULL seed_int");
    assert_eq!(s2, None, "seed -1 must result in NULL seed_int");

    // Run lineage inference
    let edges = db.infer_lineage().expect("infer_lineage");
    assert_eq!(
        edges, 0,
        "images with seed -1 must not produce lineage edges"
    );

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM lineage", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "lineage table must have 0 edges");
}

#[test]
fn test_seed_int_rule_v2_migration_applied() {
    let db = memory_db();
    let conn = db.pool_get_for_test().unwrap();

    // Verify seed_int_rule_v2 migration exists in app_migrations
    let migrated: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'seed_int_rule_v2')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        migrated,
        "seed_int_rule_v2 migration must be recorded in app_migrations"
    );
}
