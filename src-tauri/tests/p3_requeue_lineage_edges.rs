use forge_meta_link_lib::{
    database::{BulkRecord, BulkRecordWithLineage, CullMode, Database, LineageEdgeRecord},
    forge_api,
    parser::GenerationParams,
    StorageProfile,
};
use rusqlite::params;
use std::collections::HashMap;

fn test_db() -> Database {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tid = std::thread::current().id();
    let path = std::env::temp_dir().join(format!(
        "forge_p3_test_{}_{}_{:?}.db",
        std::process::id(),
        nanos,
        tid
    ));
    Database::new(&path, StorageProfile::Hdd).expect("failed to create test db")
}

fn sample_record(filepath: &str, filename: &str) -> BulkRecord {
    BulkRecord {
        filepath: filepath.to_string(),
        filename: filename.to_string(),
        directory: "C:/test".to_string(),
        params: GenerationParams {
            prompt: "a majestic mountain".to_string(),
            negative_prompt: "blurry".to_string(),
            steps: Some("25".to_string()),
            sampler: Some("Euler a".to_string()),
            schedule_type: Some("Karras".to_string()),
            cfg_scale: Some("7.0".to_string()),
            seed: Some("12345".to_string()),
            width: Some(512),
            height: Some(512),
            model_hash: Some("abc1234".to_string()),
            model_name: Some("v1-5-pruned".to_string()),
            generation_type: Some("txt2img".to_string()),
            extra_params: HashMap::new(),
            raw_metadata: "prompt text".to_string(),
        },
        file_mtime: Some(1700000000),
        file_size: Some(1024),
        quick_hash: Some("hash123".to_string()),
        tags: vec!["mountain".to_string(), "landscape".to_string()],
    }
}

#[test]
fn test_requeue_payload_enforces_batch_size_one() {
    let params = sample_record("C:/test/1.png", "1.png").params;
    let payload = forge_api::build_payload_from_generation_params(&params, true, false, None);
    assert_eq!(payload.batch_size, Some(1));
    assert_eq!(payload.n_iter, Some(1));

    let requeue_payload = forge_api::build_requeue_payload(&params, true);
    assert_eq!(requeue_payload.batch_size, Some(1));
    assert_eq!(requeue_payload.n_iter, Some(1));
}

#[test]
fn test_bulk_upsert_with_lineage_atomic_and_edges() {
    let db = test_db();

    // 1. Insert parent
    let parent_rec = sample_record("C:/test/parent.png", "parent.png");
    let count = db.bulk_upsert_with_tags(&[parent_rec]).unwrap();
    assert_eq!(count, 1);

    let parent_id = db
        .get_image_id_by_filepath("C:/test/parent.png")
        .unwrap()
        .expect("parent found");

    // 2. Insert two children from ADetailer run (unprocessed + adetailer)
    let child1_rec = sample_record("C:/test/child1_unprocessed.png", "child1_unprocessed.png");
    let child2_rec = sample_record("C:/test/child2_adetailer.png", "child2_adetailer.png");

    let ops1 = serde_json::json!({
        "ops": [{ "kind": "seed_step", "value": 2 }],
        "variant_label": "unprocessed"
    });
    let ops2 = serde_json::json!({
        "ops": [{ "kind": "seed_step", "value": 2 }],
        "variant_label": "adetailer"
    });

    let items = vec![
        BulkRecordWithLineage {
            record: child1_rec,
            edge: Some(LineageEdgeRecord {
                parent_id,
                ops_json: Some(serde_json::to_string(&ops1).unwrap()),
                source: "forge_requeue".to_string(),
            }),
        },
        BulkRecordWithLineage {
            record: child2_rec,
            edge: Some(LineageEdgeRecord {
                parent_id,
                ops_json: Some(serde_json::to_string(&ops2).unwrap()),
                source: "forge_requeue".to_string(),
            }),
        },
    ];

    let inserted = db.bulk_upsert_with_lineage(&items).unwrap();
    assert_eq!(inserted.len(), 2);
    let child1_id = inserted[0];
    let child2_id = inserted[1];

    // Assert edges exist in DB
    let conn = db.pool_get_for_test().unwrap();
    let mut stmt = conn
        .prepare("SELECT child_id, parent_id, ops_json, source FROM lineage_edges WHERE parent_id = ?1 ORDER BY id ASC")
        .unwrap();
    let edges: Vec<(i64, i64, String, String)> = stmt
        .query_map(params![parent_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();

    assert_eq!(edges.len(), 2);
    assert_eq!(edges[0].0, child1_id);
    assert_eq!(edges[0].1, parent_id);
    assert!(edges[0].2.contains("\"variant_label\":\"unprocessed\""));
    assert_eq!(edges[0].3, "forge_requeue");

    assert_eq!(edges[1].0, child2_id);
    assert_eq!(edges[1].1, parent_id);
    assert!(edges[1].2.contains("\"variant_label\":\"adetailer\""));
    assert_eq!(edges[1].3, "forge_requeue");

    // 3. Cull parent in Trash mode -> assert edges remain
    db.cull_images(&[parent_id], CullMode::Trash).unwrap();
    let edge_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM lineage_edges WHERE parent_id = ?1",
            params![parent_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(edge_count, 2, "edges must remain after parent is trashed");

    // 4. Cull parent in Permanent mode -> assert edges remain
    db.cull_images(&[parent_id], CullMode::Permanent).unwrap();
    let edge_count_perm: i64 = conn
        .query_row(
            "SELECT count(*) FROM lineage_edges WHERE parent_id = ?1",
            params![parent_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        edge_count_perm, 2,
        "edges must remain after parent is permanently ghosted"
    );
}

#[test]
fn test_bulk_upsert_failure_rolls_back_entire_chunk() {
    let db = test_db();
    let conn = db.pool_get_for_test().unwrap();

    // Add a trigger that causes an abort when inserting filepath = 'FORCED_FAIL'
    conn.execute_batch(
        "CREATE TRIGGER abort_forced_fail BEFORE INSERT ON images
         WHEN NEW.filepath = 'FORCED_FAIL'
         BEGIN
             SELECT RAISE(ABORT, 'forced test failure');
         END;",
    )
    .unwrap();

    let parent_rec = sample_record("C:/test/parent_rollback.png", "parent_rollback.png");
    db.bulk_upsert_with_tags(&[parent_rec]).unwrap();
    let parent_id = db
        .get_image_id_by_filepath("C:/test/parent_rollback.png")
        .unwrap()
        .expect("parent found");

    let child_rec = sample_record(
        "C:/test/child_should_rollback.png",
        "child_should_rollback.png",
    );
    let failing_rec = sample_record("FORCED_FAIL", "FORCED_FAIL");

    let items = vec![
        BulkRecordWithLineage {
            record: child_rec,
            edge: Some(LineageEdgeRecord {
                parent_id,
                ops_json: Some(r#"{"ops":[]}"#.to_string()),
                source: "forge_requeue".to_string(),
            }),
        },
        BulkRecordWithLineage {
            record: failing_rec,
            edge: None,
        },
    ];

    let result = db.bulk_upsert_with_lineage(&items);
    assert!(result.is_err(), "upsert must fail due to trigger");

    // Assert child was rolled back completely: image not in images, edge not in lineage_edges
    let child_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM images WHERE filepath = 'C:/test/child_should_rollback.png')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!child_exists, "child image must NOT exist after rollback");

    let edge_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM lineage_edges WHERE parent_id = ?1)",
            params![parent_id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!edge_exists, "lineage edge must NOT exist after rollback");
}
