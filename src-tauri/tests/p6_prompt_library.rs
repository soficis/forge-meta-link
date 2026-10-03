use forge_meta_link_lib::{
    database::{CullMode, Database, PromptEntry},
    parser::GenerationParams,
    StorageProfile,
};

fn test_db() -> Database {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "forge_p6_test_{}_{}_{:?}.db",
        std::process::id(),
        nanos,
        std::thread::current().id()
    ));
    Database::new(&path, StorageProfile::Hdd).expect("failed to create test db")
}

#[test]
fn save_dedupes_on_normalized_prompt_and_negative() {
    let db = test_db();
    let a = db
        .save_prompt(None, "A  Red   Fox", "blurry", "Animals, fox", "", None)
        .unwrap();
    assert!(a.created);
    let b = db
        .save_prompt(Some("other title"), "a red fox", "BLURRY", "x", "", None)
        .unwrap();
    assert!(!b.created, "whitespace/case-only differences must dedupe");
    assert_eq!(a.entry.id, b.entry.id);
    assert_eq!(
        b.entry.tags, "animals,fox",
        "dedupe must not overwrite existing fields"
    );
    // different negative prompt = different entry
    let c = db.save_prompt(None, "a red fox", "", "", "", None).unwrap();
    assert!(c.created);
    assert_eq!(db.list_prompts(None, None, 50, 0).unwrap().len(), 2);
}

#[test]
fn empty_prompt_is_rejected() {
    let db = test_db();
    assert!(db.save_prompt(None, "   \n", "", "", "", None).is_err());
}

#[test]
fn fts_search_and_tag_filter() {
    let db = test_db();
    db.save_prompt(
        Some("Portrait"),
        "studio portrait of an astronaut",
        "",
        "scifi,portrait",
        "",
        None,
    )
    .unwrap();
    db.save_prompt(
        Some("Landscape"),
        "misty mountain valley",
        "",
        "nature",
        "",
        None,
    )
    .unwrap();

    let hits = db.list_prompts(Some("astronaut"), None, 50, 0).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "Portrait");

    assert_eq!(
        db.list_prompts(None, Some("NATURE"), 50, 0).unwrap().len(),
        1
    );
    assert_eq!(
        db.list_prompts(Some("astronaut"), Some("nature"), 50, 0)
            .unwrap()
            .len(),
        0
    );
    // LIKE metacharacters in a tag filter must not act as wildcards
    assert_eq!(db.list_prompts(None, Some("%"), 50, 0).unwrap().len(), 0);
    assert_eq!(
        db.list_prompts(None, Some("nat_re"), 50, 0).unwrap().len(),
        0
    );
    // hostile FTS input must not error
    assert!(db
        .list_prompts(Some("\"unbalanced AND ( OR *"), None, 50, 0)
        .is_ok());
}

#[test]
fn update_reindexes_fts_and_rejects_duplicate_text() {
    let db = test_db();
    let a = db
        .save_prompt(None, "old words here", "", "", "", None)
        .unwrap()
        .entry;
    let b = db
        .save_prompt(None, "second entry", "", "", "", None)
        .unwrap()
        .entry;

    db.update_prompt(a.id, None, "brand new text", "", "t1, T1 ,t2", "n")
        .unwrap();
    assert_eq!(
        db.list_prompts(Some("old"), None, 50, 0).unwrap().len(),
        0,
        "stale FTS row must be evicted"
    );
    assert_eq!(
        db.list_prompts(Some("brand"), None, 50, 0).unwrap().len(),
        1
    );
    assert_eq!(
        db.list_prompts(None, Some("t1"), 50, 0).unwrap()[0].tags,
        "t1,t2"
    );

    assert!(db
        .update_prompt(b.id, None, "brand new text", "", "", "")
        .is_err());
    assert!(db
        .update_prompt(9999, None, "whatever", "", "", "")
        .is_err());
}

#[test]
fn delete_evicts_from_fts_and_use_count_does_not_reorder() {
    let db = test_db();
    let a = db
        .save_prompt(None, "alpha prompt", "", "", "", None)
        .unwrap()
        .entry;
    let b = db
        .save_prompt(None, "beta prompt", "", "", "", None)
        .unwrap()
        .entry;
    db.mark_prompt_used(a.id).unwrap();
    let list = db.list_prompts(None, None, 50, 0).unwrap();
    assert_eq!(list.iter().find(|e| e.id == a.id).unwrap().use_count, 1);
    assert!(db.delete_prompt(b.id).unwrap());
    assert!(!db.delete_prompt(b.id).unwrap());
    assert_eq!(db.list_prompts(Some("beta"), None, 50, 0).unwrap().len(), 0);
}

#[test]
fn entry_survives_source_image_cull_and_permanent_delete() {
    let db = test_db();
    let p = GenerationParams {
        prompt: "unique saved wording".to_string(),
        raw_metadata: "unique saved wording".to_string(),
        ..Default::default()
    };
    let img = db
        .upsert_image("/g/a.png", "a.png", "/g", &p, Some(1))
        .unwrap();
    let saved = db
        .save_prompt(None, "unique saved wording", "", "", "", Some(img))
        .unwrap()
        .entry;
    assert_eq!(saved.source_image_id, Some(img));

    db.cull_images(&[img], CullMode::Permanent).unwrap();
    let after = db.list_prompts(Some("unique"), None, 50, 0).unwrap();
    assert_eq!(
        after.len(),
        1,
        "library entry is user-owned and must survive"
    );
    assert_eq!(after[0].prompt, "unique saved wording");
}

#[test]
fn import_export_roundtrip_skips_duplicates_and_ignores_foreign_ids() {
    let db = test_db();
    db.save_prompt(Some("keep"), "existing prompt", "", "a", "", None)
        .unwrap();
    let exported = db.export_prompts().unwrap();
    assert_eq!(exported.len(), 1);

    let incoming = vec![
        PromptEntry {
            id: 777,
            title: "dup".into(),
            prompt: "Existing   Prompt".into(),
            negative_prompt: "".into(),
            tags: "".into(),
            notes: "".into(),
            source_image_id: Some(42),
            use_count: 99,
            created_at: 0,
            updated_at: 0,
        },
        PromptEntry {
            id: 778,
            title: "new".into(),
            prompt: "fresh prompt".into(),
            negative_prompt: "".into(),
            tags: "B, b".into(),
            notes: "".into(),
            source_image_id: Some(42),
            use_count: 99,
            created_at: 0,
            updated_at: 0,
        },
        PromptEntry {
            id: 779,
            title: "bad".into(),
            prompt: "  ".into(),
            negative_prompt: "".into(),
            tags: "".into(),
            notes: "".into(),
            source_image_id: None,
            use_count: 0,
            created_at: 0,
            updated_at: 0,
        },
    ];
    let r = db.import_prompts(&incoming).unwrap();
    assert_eq!(
        (r.inserted, r.skipped_duplicates, r.skipped_invalid),
        (1, 1, 1)
    );
    let all = db.export_prompts().unwrap();
    let fresh = all.iter().find(|e| e.title == "new").unwrap();
    assert_eq!(
        fresh.source_image_id, None,
        "foreign image ids must not be imported"
    );
    assert_eq!(fresh.use_count, 0);
    assert_eq!(fresh.tags, "b");
}

#[test]
fn migration_is_idempotent_on_reopen() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "forge_p6_reopen_{}_{}.db",
        std::process::id(),
        nanos
    ));
    {
        let db = Database::new(&path, StorageProfile::Hdd).unwrap();
        db.save_prompt(None, "persisted", "", "", "", None).unwrap();
    }
    let db = Database::new(&path, StorageProfile::Hdd).unwrap();
    assert_eq!(
        db.list_prompts(Some("persisted"), None, 50, 0)
            .unwrap()
            .len(),
        1
    );
}
