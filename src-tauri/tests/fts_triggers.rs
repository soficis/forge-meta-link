use forge_meta_link_lib::{database::Database, parser::GenerationParams, StorageProfile};

fn mem_db() -> Database {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tid = std::thread::current().id();
    let path = std::env::temp_dir().join(format!(
        "forge_fts_test_{}_{}_{:?}.db",
        std::process::id(),
        nanos,
        tid
    ));
    Database::new(&path, StorageProfile::Hdd).expect("mem db")
}

#[test]
fn test_fts_triggers_scoped_in_sqlite_master() {
    let db = mem_db();
    let conn = db.pool_get_for_test().unwrap();

    let trigger_au: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'images_au'",
            [],
            |r| r.get(0),
        )
        .expect("images_au trigger exists");
    assert!(
        trigger_au.contains("UPDATE OF prompt, negative_prompt, raw_metadata, model_name"),
        "images_au must be scoped: {}",
        trigger_au
    );

    let trigger_au_tri: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'images_au_tri'",
            [],
            |r| r.get(0),
        )
        .expect("images_au_tri trigger exists");
    assert!(
        trigger_au_tri.contains("UPDATE OF prompt, negative_prompt, raw_metadata, model_name"),
        "images_au_tri must be scoped: {}",
        trigger_au_tri
    );

    let migration_applied: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'fts_triggers_scoped_v1')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(migration_applied, "fts_triggers_scoped_v1 must be recorded");
}

#[test]
fn test_fts_triggers_do_not_rewrite_on_locked_or_filepath_but_update_on_prompt() {
    let db = mem_db();
    let params = GenerationParams {
        prompt: "futuristic astronaut exploring mars".to_string(),
        negative_prompt: "blurry".to_string(),
        seed: Some("12345".to_string()),
        ..Default::default()
    };
    db.upsert_image("/images/1.png", "1.png", "/images", &params, Some(1000))
        .expect("insert");

    let conn = db.pool_get_for_test().unwrap();
    let initial_fts_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM images_fts WHERE images_fts MATCH 'astronaut'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(initial_fts_count, 1);

    // Non-text updates must not delete or rewrite FTS index
    conn.execute(
        "UPDATE images SET is_locked = 1 WHERE filepath = '/images/1.png'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE images SET filepath = '/images/moved.png', filename = 'moved.png' WHERE filepath = '/images/1.png'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE images SET seed_int = 99999 WHERE filepath = '/images/moved.png'",
        [],
    )
    .unwrap();

    let count_after_updates: i64 = conn
        .query_row(
            "SELECT count(*) FROM images_fts WHERE images_fts MATCH 'astronaut'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        count_after_updates, 1,
        "search still finds astronaut after non-text updates"
    );

    // Updating prompt updates FTS index
    conn.execute(
        "UPDATE images SET prompt = 'cyberpunk samurai on motorcycle' WHERE filepath = '/images/moved.png'",
        [],
    )
    .unwrap();

    let old_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM images_fts WHERE images_fts MATCH 'astronaut'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(old_count, 0, "old prompt term removed from FTS");

    let new_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM images_fts WHERE images_fts MATCH 'samurai'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(new_count, 1, "new prompt term indexed in FTS");
}

#[test]
fn test_fts_triggers_migration_from_unscoped() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("forge_fts_mig_{}_{}.db", std::process::id(), nanos));

    // Create full initial database
    {
        let db_initial = Database::new(&path, StorageProfile::Hdd).expect("initial create");
        drop(db_initial);
    }

    // Manually downgrade triggers to unscoped and remove migration record
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "DELETE FROM app_migrations WHERE name = 'fts_triggers_scoped_v1';
             DROP TRIGGER IF EXISTS images_au;
             DROP TRIGGER IF EXISTS images_au_tri;
             CREATE TRIGGER images_au AFTER UPDATE ON images BEGIN
                 INSERT INTO images_fts(images_fts, rowid, prompt, negative_prompt, raw_metadata, model_name)
                 VALUES ('delete', old.id, old.prompt, old.negative_prompt, old.raw_metadata, old.model_name);
                 INSERT INTO images_fts(rowid, prompt, negative_prompt, raw_metadata, model_name)
                 VALUES (new.id, new.prompt, new.negative_prompt, new.raw_metadata, new.model_name);
             END;
             CREATE TRIGGER images_au_tri AFTER UPDATE ON images BEGIN
                 INSERT INTO images_fts_tri(images_fts_tri, rowid, prompt, negative_prompt, raw_metadata, model_name)
                 VALUES ('delete', old.id, old.prompt, old.negative_prompt, old.raw_metadata, old.model_name);
                 INSERT INTO images_fts_tri(rowid, prompt, negative_prompt, raw_metadata, model_name)
                 VALUES (new.id, new.prompt, new.negative_prompt, new.raw_metadata, new.model_name);
             END;",
        )
        .unwrap();
    }

    // Now open via Database::new — migration should run
    let db = Database::new(&path, StorageProfile::Hdd).expect("open and migrate");
    let conn = db.pool_get_for_test().unwrap();

    let trigger_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'images_au'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        trigger_sql.contains("UPDATE OF prompt, negative_prompt, raw_metadata, model_name"),
        "migrated trigger must be scoped: {}",
        trigger_sql
    );

    let migrated: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'fts_triggers_scoped_v1')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(migrated, "fts_triggers_scoped_v1 must be marked as applied");
}
