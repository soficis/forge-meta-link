use forge_meta_link_lib::{database::Database, parser::GenerationParams, StorageProfile};

fn mem_db() -> Database {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tid = std::thread::current().id();
    let path = std::env::temp_dir().join(format!(
        "forge_lineage_heur_{}_{}_{:?}.db",
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
fn test_lineage_no_reverse_edge() {
    let db = mem_db();
    // A older than B, same seed, model and folder
    insert_image(
        &db,
        "/dir/a.png",
        Some("5000"),
        Some("model1"),
        "a beautiful cat",
        Some(1000),
    );
    insert_image(
        &db,
        "/dir/b.png",
        Some("5000"),
        Some("model1"),
        "a beautiful cat",
        Some(2000),
    );

    let count = db.infer_lineage().expect("infer");
    assert_eq!(count, 1, "expected exactly one edge");

    let conn = db.pool_get_for_test().unwrap();
    let edge: (String, String) = conn
        .query_row(
            "SELECT child_filepath, parent_filepath FROM lineage",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(edge.0, "/dir/b.png", "child should be B (newer)");
    assert_eq!(edge.1, "/dir/a.png", "parent should be A (older)");

    let reverse_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM lineage WHERE child_filepath = '/dir/a.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(reverse_count, 0, "no edge should have child A");
}

#[test]
fn test_lineage_batch_sibling_seed_plus_one_not_linked() {
    let db = mem_db();
    // A and B: same prompt, model, folder; B has seed = A.seed + 1
    insert_image(
        &db,
        "/dir/a.png",
        Some("5000"),
        Some("model1"),
        "masterpiece cat",
        Some(1000),
    );
    insert_image(
        &db,
        "/dir/b.png",
        Some("5001"),
        Some("model1"),
        "masterpiece cat",
        Some(2000),
    );

    let count = db.infer_lineage().expect("infer");
    assert_eq!(count, 0, "seed+1 sibling must not be linked in lineage");
}

#[test]
fn test_lineage_prompt_jaccard_confidence() {
    let db = mem_db();
    // High similarity: >= 0.6 token Jaccard -> 0.9 confidence
    insert_image(
        &db,
        "/dir/a1.png",
        Some("100"),
        Some("model1"),
        "masterpiece, best quality, 1girl, smiling <lora:cat:0.8>",
        Some(1000),
    );
    insert_image(
        &db,
        "/dir/b1.png",
        Some("100"),
        Some("model1"),
        "masterpiece, best quality, 1girl, smiling",
        Some(2000),
    );

    // Low similarity: < 0.6 token Jaccard -> 0.6 confidence
    insert_image(
        &db,
        "/dir/a2.png",
        Some("200"),
        Some("model1"),
        "cyberpunk city, neon lights, rainy night",
        Some(1000),
    );
    insert_image(
        &db,
        "/dir/b2.png",
        Some("200"),
        Some("model1"),
        "pastoral landscape, sunny hills, sheep grazing",
        Some(2000),
    );

    let count = db.infer_lineage().expect("infer");
    assert_eq!(count, 2);

    let conn = db.pool_get_for_test().unwrap();
    let conf1: f64 = conn
        .query_row(
            "SELECT confidence FROM lineage WHERE child_filepath = '/dir/b1.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(conf1, 0.9, "high similarity should yield confidence 0.9");

    let conf2: f64 = conn
        .query_row(
            "SELECT confidence FROM lineage WHERE child_filepath = '/dir/b2.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(conf2, 0.6, "low similarity should yield confidence 0.6");
}

#[test]
fn test_lineage_different_model_no_edge() {
    let db = mem_db();
    insert_image(
        &db,
        "/dir/a.png",
        Some("5000"),
        Some("model1"),
        "cat hero",
        Some(1000),
    );
    insert_image(
        &db,
        "/dir/b.png",
        Some("5000"),
        Some("model2"),
        "cat hero",
        Some(2000),
    );

    let count = db.infer_lineage().expect("infer");
    assert_eq!(count, 0, "different models should not produce edges");
}

#[test]
fn test_lineage_equal_mtime_id_direction() {
    let db = mem_db();
    // Same mtime: parent.id < child.id
    insert_image(
        &db,
        "/dir/a.png",
        Some("5000"),
        Some("model1"),
        "cat",
        Some(1000),
    );
    insert_image(
        &db,
        "/dir/b.png",
        Some("5000"),
        Some("model1"),
        "cat",
        Some(1000),
    );

    let count = db.infer_lineage().expect("infer");
    assert_eq!(count, 1, "expected exactly one edge");

    let conn = db.pool_get_for_test().unwrap();
    let edge: (String, String) = conn
        .query_row(
            "SELECT child_filepath, parent_filepath FROM lineage",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(edge.0, "/dir/b.png", "child should be B (higher id)");
    assert_eq!(edge.1, "/dir/a.png", "parent should be A (lower id)");
}

#[test]
fn test_rebuild_lineage_removes_noisy_edge_and_preserves_manual_link() {
    let db = mem_db();
    // A and B: same model and folder, seeds differ by 5 (noisy edge from previous heuristics)
    insert_image(
        &db,
        "/dir/a.png",
        Some("5000"),
        Some("model1"),
        "cat in garden",
        Some(1000),
    );
    insert_image(
        &db,
        "/dir/b.png",
        Some("5005"),
        Some("model1"),
        "cat in garden",
        Some(2000),
    );
    // C: same seed as A, newer -> exact seed match with A
    insert_image(
        &db,
        "/dir/c.png",
        Some("5000"),
        Some("model1"),
        "cat in garden",
        Some(3000),
    );
    // M1 and M2: manual link targets
    insert_image(
        &db,
        "/dir/m1.png",
        Some("9000"),
        Some("model2"),
        "manual parent",
        Some(1500),
    );
    insert_image(
        &db,
        "/dir/m2.png",
        Some("9100"),
        Some("model2"),
        "manual child",
        Some(2500),
    );

    // Insert an old-style noisy edge between /dir/a.png and /dir/b.png
    {
        let conn = db.pool_get_for_test().unwrap();
        conn.execute(
            "INSERT INTO lineage (child_filepath, parent_filepath, relation, confidence, created_at)
             VALUES ('/dir/b.png', '/dir/a.png', 'seed_walk', 0.8, 1000)",
            [],
        )
        .unwrap();
    }

    // Insert manual link override (which inserts into lineage_overrides AND lineage)
    db.upsert_lineage_override("/dir/m2.png", "/dir/m1.png", "seed_walk", 1.0, "link")
        .expect("upsert manual link");

    // Before rebuild, we have noisy edge and manual link
    {
        let conn = db.pool_get_for_test().unwrap();
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM lineage", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 2, "initial edges: noisy edge + manual link");
    }

    // Rebuild lineage
    let total_after = db.rebuild_lineage().expect("rebuild lineage");

    // Rebuild should have:
    // 1. Removed noisy edge (a -> b)
    // 2. Kept manual link (m1 -> m2)
    // 3. Inferred exact-seed edge (a -> c)
    // Total edges = 2 (manual link + exact seed edge)
    assert_eq!(total_after, 2, "rebuild should report 2 edges total");

    let conn = db.pool_get_for_test().unwrap();
    let noisy_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM lineage WHERE child_filepath = '/dir/b.png' AND parent_filepath = '/dir/a.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(noisy_count, 0, "noisy edge between a and b must be removed");

    let manual_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM lineage WHERE child_filepath = '/dir/m2.png' AND parent_filepath = '/dir/m1.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(manual_count, 1, "manual link must remain in lineage");

    let exact_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM lineage WHERE child_filepath = '/dir/c.png' AND parent_filepath = '/dir/a.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(exact_count, 1, "exact seed edge between a and c must exist");
}

#[test]
fn test_lineage_migrations_idempotent() {
    let db = mem_db();
    insert_image(
        &db,
        "/dir/a.png",
        Some("5000"),
        Some("model1"),
        "cat",
        Some(1000),
    );
    insert_image(
        &db,
        "/dir/b.png",
        Some("5000"),
        Some("model1"),
        "cat",
        Some(2000),
    );

    // First run of startup migrations: executes reset and full inference, records migrations
    let first_run = db
        .run_lineage_migrations_if_needed()
        .expect("first migration run");
    assert_eq!(first_run, Some(1), "should infer 1 edge on first run");

    // Second run: both lineage_reset_v2 and lineage_backfill_v1 exist, returns Ok(None)
    let second_run = db
        .run_lineage_migrations_if_needed()
        .expect("second migration run");
    assert_eq!(second_run, None, "second run should be a no-op");

    // Verify the edge is intact and nothing was deleted
    let total = db.get_total_lineage_edges().expect("total edges");
    assert_eq!(total, 1, "edge should remain intact");
}

#[test]
fn test_unlink_override_survives_rebuild_and_hides_inferred_edge() {
    let db = mem_db();
    insert_image(
        &db,
        "/dir/a.png",
        Some("5000"),
        Some("model1"),
        "cat",
        Some(1000),
    );
    insert_image(
        &db,
        "/dir/b.png",
        Some("5000"),
        Some("model1"),
        "cat",
        Some(2000),
    );

    // Initial inference creates edge a -> b
    db.infer_lineage().expect("infer");
    let cursor = db.get_lineage_cursor("/dir/b.png").expect("cursor");
    assert_eq!(cursor.ancestors.len(), 1, "b should have 1 ancestor (a)");

    // User unlinks a and b
    db.upsert_lineage_override("/dir/b.png", "/dir/a.png", "seed_walk", 0.0, "unlink")
        .expect("unlink");
    let cursor_after_unlink = db.get_lineage_cursor("/dir/b.png").expect("cursor");
    assert_eq!(
        cursor_after_unlink.ancestors.len(),
        0,
        "unlink should hide ancestor"
    );

    // Rebuild lineage (resets inferred edges and re-infers)
    db.rebuild_lineage().expect("rebuild");

    // Cursor for b should still hide a because the unlink override is preserved
    let cursor_after_rebuild = db.get_lineage_cursor("/dir/b.png").expect("cursor");
    assert_eq!(
        cursor_after_rebuild.ancestors.len(),
        0,
        "unlink override must still hide ancestor after rebuild"
    );
}
