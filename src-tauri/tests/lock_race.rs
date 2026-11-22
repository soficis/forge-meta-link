use forge_meta_link_lib::{
    commands::{delete_images_sync, DeleteImagesRequest, DeleteMode},
    database::{CullMode, Database},
    parser::GenerationParams,
    StorageProfile,
};
use std::collections::HashSet;
use std::sync::{Arc, RwLock};

fn test_db(dir: &std::path::Path) -> Database {
    Database::new(&dir.join("test.db"), StorageProfile::Hdd).expect("db")
}

fn gen_params(prompt: &str) -> GenerationParams {
    GenerationParams {
        prompt: prompt.to_string(),
        raw_metadata: prompt.to_string(),
        ..Default::default()
    }
}

#[test]
fn cull_respects_lock_set_between_resolution_and_cull() {
    let root = std::env::temp_dir().join(format!(
        "fml_lock_race_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let db = test_db(&root);

    let locked_path = root.join("locked.png");
    let open_path = root.join("open.png");
    std::fs::write(&locked_path, b"locked").unwrap();
    std::fs::write(&open_path, b"open").unwrap();

    let locked_id = db
        .upsert_image(
            locked_path.to_str().unwrap(),
            "locked.png",
            root.to_str().unwrap(),
            &gen_params("cat hero locked"),
            Some(1),
        )
        .unwrap();
    let open_id = db
        .upsert_image(
            open_path.to_str().unwrap(),
            "open.png",
            root.to_str().unwrap(),
            &gen_params("cat hero open"),
            Some(1),
        )
        .unwrap();

    // Resolve the set (as the delete path does) while nothing is locked.
    let resolved = db
        .get_images_by_ids(&[locked_id, open_id])
        .expect("resolve");
    assert_eq!(resolved.len(), 2);

    // Race: the lock lands after resolution but before the cull.
    db.set_image_locked(locked_id, true).expect("lock");

    let (culled, blocked) = db
        .cull_images_with_blocked(&[locked_id, open_id], CullMode::Trash)
        .expect("cull");
    assert_eq!(culled, 1, "only the unlocked row may be culled");
    assert_eq!(blocked, vec![locked_id]);

    // images_live invariant: locked row still live, open row culled.
    let live = db.get_all_image_filepaths_desc().expect("live");
    assert!(
        live.iter().any(|p| p.contains("locked")),
        "locked row must stay live, got {live:?}"
    );
    assert!(
        !live.iter().any(|p| p == open_path.to_str().unwrap()),
        "open row must be culled, got {live:?}"
    );

    // Cull never touches the filesystem, so both files survive this step.
    assert!(locked_path.exists());
    assert!(open_path.exists());

    // Permanent path also honors the lock and leaves tags of blocked rows alone.
    db.replace_image_tags(locked_id, &["keepme".to_string()])
        .unwrap();
    let (culled_p, blocked_p) = db
        .cull_images_with_blocked(&[locked_id], CullMode::Permanent)
        .expect("perm cull");
    assert_eq!(culled_p, 0);
    assert_eq!(blocked_p, vec![locked_id]);
    assert_eq!(db.get_tags_for_image(locked_id).unwrap(), vec!["keepme"]);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn delete_reports_blocked_and_keeps_locked_file() {
    let root = std::env::temp_dir().join(format!(
        "fml_lock_race_del_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(root.join("cache")).unwrap();
    let db = test_db(&root);
    let cache_dir = root.join("cache");
    let thumbnail_index: Arc<RwLock<HashSet<String>>> = Default::default();
    let failed: Arc<RwLock<HashSet<String>>> = Default::default();

    let locked_path = root.join("locked2.png");
    let open_path = root.join("open2.png");
    std::fs::write(&locked_path, b"locked").unwrap();
    std::fs::write(&open_path, b"open").unwrap();

    let locked_id = db
        .upsert_image(
            locked_path.to_str().unwrap(),
            "locked2.png",
            root.to_str().unwrap(),
            &gen_params("cat hero locked2"),
            Some(1),
        )
        .unwrap();
    let open_id = db
        .upsert_image(
            open_path.to_str().unwrap(),
            "open2.png",
            root.to_str().unwrap(),
            &gen_params("cat hero open2"),
            Some(1),
        )
        .unwrap();

    // Resolve while unlocked, then lock before the delete call (which
    // re-resolves internally before touching the filesystem).
    let _resolved = db
        .get_images_by_ids(&[locked_id, open_id])
        .expect("resolve");
    db.set_image_locked(locked_id, true).expect("lock");

    let result = delete_images_sync(
        DeleteImagesRequest {
            ids: vec![locked_id, open_id],
            mode: DeleteMode::Permanent,
        },
        &db,
        &cache_dir,
        &thumbnail_index,
        &failed,
    )
    .expect("delete");

    assert!(
        result.blocked_protected_ids.contains(&locked_id),
        "locked id must be reported as blocked, got {:?}",
        result.blocked_protected_ids
    );
    assert!(
        !result.deleted_ids.contains(&locked_id),
        "blocked id must never be reported as deleted, got {:?}",
        result.deleted_ids
    );
    assert!(
        result.deleted_ids.contains(&open_id),
        "open id must be deleted, got {:?}",
        result.deleted_ids
    );
    assert!(locked_path.exists(), "locked file must survive the race");
    assert!(!open_path.exists(), "unlocked file must be deleted");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn update_image_location_refuses_locked_row() {
    let root = std::env::temp_dir().join(format!(
        "fml_lock_race_move_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let db = test_db(&root);

    let src_path = root.join("src.png");
    std::fs::write(&src_path, b"src").unwrap();
    let id = db
        .upsert_image(
            src_path.to_str().unwrap(),
            "src.png",
            root.to_str().unwrap(),
            &gen_params("move me"),
            Some(1),
        )
        .unwrap();
    db.set_image_locked(id, true).expect("lock");

    let before = db.get_images_by_ids(&[id]).expect("resolve")[0].clone();
    let moved = db
        .update_image_location(
            id,
            root.join("dst.png").to_str().unwrap(),
            "dst.png",
            root.to_str().unwrap(),
        )
        .expect("update");
    assert!(!moved, "locked row must refuse the location update");
    let after = db.get_images_by_ids(&[id]).expect("resolve")[0].clone();
    assert_eq!(after.filepath, before.filepath);
    assert_eq!(after.filename, before.filename);
    assert_eq!(after.directory, before.directory);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn cull_trash_locked_row_keeps_tags() {
    let root = std::env::temp_dir().join(format!(
        "fml_lock_race_cull_locked_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let db = test_db(&root);

    let path = root.join("locked_tag.png");
    std::fs::write(&path, b"locked").unwrap();
    let id = db
        .upsert_image(
            path.to_str().unwrap(),
            "locked_tag.png",
            root.to_str().unwrap(),
            &gen_params("locked tag"),
            Some(1),
        )
        .unwrap();
    db.replace_image_tags(id, &["keepme".to_string()]).unwrap();
    db.set_image_locked(id, true).expect("lock");

    let (culled, blocked) = db
        .cull_images_with_blocked(&[id], CullMode::Trash)
        .expect("cull");
    assert_eq!(culled, 0);
    assert!(
        blocked.contains(&id),
        "locked id must be blocked, got {blocked:?}"
    );
    let live = db.get_all_image_filepaths_desc().expect("live");
    assert!(
        live.iter().any(|p| p == path.to_str().unwrap()),
        "locked row must not be culled, got {live:?}"
    );
    assert_eq!(
        db.get_tags_for_image(id).unwrap(),
        vec!["keepme"],
        "locked row must keep its tags"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn cull_trash_unlocked_row_removes_tags() {
    let root = std::env::temp_dir().join(format!(
        "fml_lock_race_cull_open_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let db = test_db(&root);

    let path = root.join("open_tag.png");
    std::fs::write(&path, b"open").unwrap();
    let id = db
        .upsert_image(
            path.to_str().unwrap(),
            "open_tag.png",
            root.to_str().unwrap(),
            &gen_params("open tag"),
            Some(1),
        )
        .unwrap();
    db.replace_image_tags(id, &["keepme".to_string()]).unwrap();

    let (culled, blocked) = db
        .cull_images_with_blocked(&[id], CullMode::Trash)
        .expect("cull");
    assert_eq!(culled, 1);
    assert!(
        !blocked.contains(&id),
        "open id must not be blocked, got {blocked:?}"
    );
    assert!(
        db.get_tags_for_image(id).unwrap().is_empty(),
        "culled row must lose its tags"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn delete_final_cull_guard_never_removes_locked_file_sidecar_or_thumbnail() {
    // Regression for the final-closure P1: `delete_images` must decide the DB
    // cull first, then touch the filesystem only for ids actually culled.
    // A lock that lands after the initial resolution but before the DB cull
    // must leave the file, its sidecar, and its cached thumbnail untouched
    // and report the id as protected.
    //
    // A single-threaded test cannot interleave a lock between the re-resolve
    // and the cull *inside* `delete_images_sync`, so this exercises the same
    // order from the outside (resolve -> lock -> cull-first delete) plus a
    // full command-level call where the lock lands before the call and is
    // caught by both the re-resolve and the final cull guard. The file-level
    // interleaving inside the command is therefore covered by ordering, not
    // by a true concurrent race.
    let root = std::env::temp_dir().join(format!(
        "fml_lock_race_final_guard_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(root.join("cache")).unwrap();
    let db = test_db(&root);
    let cache_dir = root.join("cache");
    let thumbnail_index: Arc<RwLock<HashSet<String>>> = Default::default();
    let failed: Arc<RwLock<HashSet<String>>> = Default::default();

    let locked_path = root.join("guard_locked.png");
    let open_path = root.join("guard_open.png");
    std::fs::write(&locked_path, b"locked").unwrap();
    std::fs::write(&open_path, b"open").unwrap();
    let locked_sidecar = root.join("guard_locked.json");
    let open_sidecar = root.join("guard_open.json");
    std::fs::write(&locked_sidecar, b"{}").unwrap();
    std::fs::write(&open_sidecar, b"{}").unwrap();

    let locked_id = db
        .upsert_image(
            locked_path.to_str().unwrap(),
            "guard_locked.png",
            root.to_str().unwrap(),
            &gen_params("guard locked"),
            Some(1),
        )
        .unwrap();
    let open_id = db
        .upsert_image(
            open_path.to_str().unwrap(),
            "guard_open.png",
            root.to_str().unwrap(),
            &gen_params("guard open"),
            Some(1),
        )
        .unwrap();

    let locked_thumb =
        forge_meta_link_lib::image_processing::get_thumbnail_cache_path(&locked_path, &cache_dir);
    let open_thumb =
        forge_meta_link_lib::image_processing::get_thumbnail_cache_path(&open_path, &cache_dir);
    std::fs::write(&locked_thumb, b"jpeg").unwrap();
    std::fs::write(&open_thumb, b"jpeg").unwrap();

    // Resolve while unlocked, then the lock lands before the DB cull.
    let _resolved = db
        .get_images_by_ids(&[locked_id, open_id])
        .expect("resolve");
    db.set_image_locked(locked_id, true).expect("lock");

    let result = delete_images_sync(
        DeleteImagesRequest {
            ids: vec![locked_id, open_id],
            mode: DeleteMode::Permanent,
        },
        &db,
        &cache_dir,
        &thumbnail_index,
        &failed,
    )
    .expect("delete");

    assert!(
        result.blocked_protected_ids.contains(&locked_id),
        "locked id must be reported as blocked, got {:?}",
        result.blocked_protected_ids
    );
    assert!(
        !result.deleted_ids.contains(&locked_id),
        "blocked id must never be reported as deleted, got {:?}",
        result.deleted_ids
    );
    assert!(
        result.deleted_ids.contains(&open_id),
        "open id must be deleted, got {:?}",
        result.deleted_ids
    );
    assert_eq!(result.removed_from_db, 1);
    // Single-threaded execution hits the re-resolve before the cull, so the
    // lock is reported via blocked_protected_ids; the
    // "(protected: locked before cull)" failed_path is produced by the final
    // cull guard when a lock lands after the re-resolve (not deterministically
    // reproducible here). Either way the id must be protected, not deleted.
    assert!(
        result.blocked_protected_ids.contains(&locked_id),
        "locked id must stay protected, got {:?}",
        result.blocked_protected_ids
    );
    assert!(locked_path.exists(), "locked file must survive the race");
    assert!(
        locked_sidecar.exists(),
        "locked sidecar must survive the race"
    );
    assert!(
        locked_thumb.exists(),
        "locked thumbnail must survive the race"
    );
    assert!(!open_path.exists(), "unlocked file must be deleted");
    assert!(!open_sidecar.exists(), "unlocked sidecar must be deleted");
    assert!(!open_thumb.exists(), "unlocked thumbnail must be deleted");

    let _ = std::fs::remove_dir_all(&root);
}
