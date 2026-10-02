use forge_meta_link_lib::{
    database::{CullMode, Database},
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
        "forge_p2_test_{}_{}_{:?}.db",
        std::process::id(),
        nanos,
        tid
    ));
    Database::new(&path, StorageProfile::Hdd).expect("failed to create test db")
}

#[test]
fn test_p2_trash_cull_hides_from_live_keeps_columns_removes_tags() {
    let db = test_db();
    let conn = db.pool_get_for_test().expect("pool get");

    let p = GenerationParams {
        prompt: "cyberpunk skyline with neon rain".to_string(),
        negative_prompt: "bad quality".to_string(),
        steps: Some("25".to_string()),
        sampler: Some("Euler a".to_string()),
        schedule_type: Some("karras".to_string()),
        cfg_scale: Some("7.5".to_string()),
        seed: Some("123456".to_string()),
        width: Some(512),
        height: Some(512),
        model_name: Some("dreamshaper_v8".to_string()),
        model_hash: Some("deadbeef".to_string()),
        raw_metadata: "cyberpunk skyline with neon rain".to_string(),
        ..Default::default()
    };

    let id = db
        .upsert_image("/images/skyline.png", "skyline.png", "/images", &p, Some(1000))
        .expect("upsert image");
    db.replace_image_tags(id, &["cyberpunk".to_string(), "neon".to_string()])
        .expect("set tags");

    // Cull with Trash mode
    let count = db.cull_images(&[id], CullMode::Trash).expect("cull trash");
    assert_eq!(count, 1);

    // Live count must be 0
    assert_eq!(db.get_total_count().unwrap(), 0);
    assert!(db.get_image_by_id(id).unwrap().is_none());

    // Row in images table still has culled_at set and prompt intact
    let (culled_at, prompt, filepath): (Option<i64>, String, String) = conn
        .query_row(
            "SELECT culled_at, prompt, filepath FROM images WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("select culled row");

    assert!(culled_at.is_some(), "culled_at must be populated");
    assert_eq!(prompt, "cyberpunk skyline with neon rain", "prompt preserved in trash mode");
    assert_eq!(filepath, "/images/skyline.png", "original filepath preserved in trash mode");

    // Tags for that image removed
    let tag_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM image_tags WHERE image_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .expect("count image_tags");
    assert_eq!(tag_count, 0, "image_tags must be removed on cull");
}

#[test]
fn test_p2_permanent_cull_blanks_text_evicts_fts_and_assigns_ghost_path() {
    let db = test_db();
    let conn = db.pool_get_for_test().expect("pool get");

    let p1 = GenerationParams {
        prompt: "secret confidential prompt text one".to_string(),
        negative_prompt: "bad stuff".to_string(),
        steps: Some("30".to_string()),
        sampler: Some("DPM++ 2M".to_string()),
        schedule_type: Some("exponential".to_string()),
        cfg_scale: Some("6.0".to_string()),
        seed: Some("999001".to_string()),
        width: Some(768),
        height: Some(768),
        model_name: Some("sd_xl_base_1.0".to_string()),
        model_hash: Some("31e35c80".to_string()),
        raw_metadata: "secret confidential prompt text one".to_string(),
        ..Default::default()
    };
    let id1 = db
        .upsert_image("/images/img1.png", "img1.png", "/images", &p1, Some(1000))
        .expect("upsert image 1");

    let p2 = GenerationParams {
        prompt: "secret confidential prompt text two".to_string(),
        negative_prompt: "bad stuff".to_string(),
        steps: Some("30".to_string()),
        sampler: Some("DPM++ 2M".to_string()),
        schedule_type: Some("exponential".to_string()),
        cfg_scale: Some("6.0".to_string()),
        seed: Some("999002".to_string()),
        width: Some(768),
        height: Some(768),
        model_name: Some("sd_xl_base_1.0".to_string()),
        model_hash: Some("31e35c80".to_string()),
        raw_metadata: "secret confidential prompt text two".to_string(),
        ..Default::default()
    };
    let id2 = db
        .upsert_image("/images/img2.png", "img2.png", "/images", &p2, Some(2000))
        .expect("upsert image 2");

    // Permanent cull both
    let count = db.cull_images(&[id1, id2], CullMode::Permanent).expect("cull permanent");
    assert_eq!(count, 2);

    // Verify row 1
    let (prompt1, neg1, raw1, fp1, recipe1_str): (String, String, String, String, Option<String>) = conn
        .query_row(
            "SELECT prompt, negative_prompt, raw_metadata, filepath, ghost_recipe FROM images WHERE id = ?1",
            params![id1],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .expect("query id1");

    assert_eq!(prompt1, "", "prompt must be blanked");
    assert_eq!(neg1, "", "negative_prompt must be blanked");
    assert_eq!(raw1, "", "raw_metadata must be blanked");
    assert_eq!(fp1, format!("ghost://{}", id1), "filepath must be ghost://<id>");
    assert!(recipe1_str.is_some(), "ghost_recipe must be present");

    let recipe1: serde_json::Value = serde_json::from_str(&recipe1_str.unwrap()).expect("parse recipe");
    assert_eq!(recipe1["seed"], "999001");
    assert_eq!(recipe1["cfg"], "6.0");
    assert_eq!(recipe1["steps"], "30");
    assert_eq!(recipe1["sampler"], "DPM++ 2M");
    assert_eq!(recipe1["scheduler"], "exponential");
    assert_eq!(recipe1["model"], "sd_xl_base_1.0");

    // Verify row 2 filepath does not collide with row 1
    let fp2: String = conn
        .query_row(
            "SELECT filepath FROM images WHERE id = ?1",
            params![id2],
            |r| r.get(0),
        )
        .expect("query id2 fp");
    assert_eq!(fp2, format!("ghost://{}", id2));
    assert_ne!(fp1, fp2, "two permanent ghosts must not collide on unique filepath");

    // Verify FTS eviction: searching for 'confidential' must return 0 results
    let fts_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM images_fts WHERE images_fts MATCH 'confidential'",
            [],
            |r| r.get(0),
        )
        .expect("fts count");
    assert_eq!(fts_count, 0, "FTS table must evict confidential prompt text upon permanent cull");
}

#[test]
fn test_p2_rescan_upsert_resurrects_trash_culled_image() {
    let db = test_db();

    let p = GenerationParams {
        prompt: "vintage astronaut painting".to_string(),
        steps: Some("20".to_string()),
        sampler: Some("Euler".to_string()),
        seed: Some("55555".to_string()),
        raw_metadata: "vintage astronaut painting".to_string(),
        ..Default::default()
    };
    let path = "/gallery/astronaut.png";
    let id = db.upsert_image(path, "astronaut.png", "/gallery", &p, Some(1000)).unwrap();

    // Cull with Trash
    db.cull_images(&[id], CullMode::Trash).unwrap();
    assert_eq!(db.get_total_count().unwrap(), 0);

    // Rescan / re-upsert same filepath
    let updated_p = GenerationParams {
        prompt: "vintage astronaut painting restored".to_string(),
        steps: Some("22".to_string()),
        sampler: Some("Euler".to_string()),
        seed: Some("55555".to_string()),
        raw_metadata: "vintage astronaut painting restored".to_string(),
        ..Default::default()
    };
    let res_id = db.upsert_image(path, "astronaut.png", "/gallery", &updated_p, Some(1500)).unwrap();
    assert_eq!(res_id, id, "upsert must preserve same row id on resurrection");

    // Live count is back to 1
    assert_eq!(db.get_total_count().unwrap(), 1, "image must be resurrected into images_live");
    let rec = db.get_image_by_id(id).unwrap().expect("record exists");
    assert_eq!(rec.prompt, "vintage astronaut painting restored");
}
