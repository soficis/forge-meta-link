use forge_meta_link_lib::{
    database::{CursorQueryOptions, Database, FilterCursorParams, SearchCursorParams},
    parser::GenerationParams,
    StorageProfile,
};

fn test_db() -> Database {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tid = std::thread::current().id();
    let path = std::env::temp_dir().join(format!(
        "forge_sort_matrix_{}_{}_{:?}.db",
        std::process::id(),
        nanos,
        tid
    ));
    Database::new(&path, StorageProfile::Hdd).expect("db")
}

fn insert(
    db: &Database,
    filepath: &str,
    filename: &str,
    prompt: &str,
    model: Option<&str>,
    generation_type: Option<&str>,
) -> i64 {
    let params = GenerationParams {
        prompt: prompt.to_string(),
        raw_metadata: prompt.to_string(),
        model_name: model.map(|s| s.to_string()),
        generation_type: generation_type.map(|s| s.to_string()),
        ..Default::default()
    };
    db.upsert_image(filepath, filename, "C:/test", &params, Some(1))
        .expect("insert")
}

fn seed_matrix(db: &Database) -> Vec<i64> {
    // All prompts contain "cat" so the porter MATCH is non-empty.
    let a = insert(
        db,
        "C:/test/c.png",
        "c.png",
        "cat hero one",
        Some("zebra"),
        Some("upscale"),
    );
    let b = insert(
        db,
        "C:/test/a.png",
        "a.png",
        "cat hero two",
        Some("apple"),
        Some("img2img"),
    );
    let c = insert(
        db,
        "C:/test/b.png",
        "b.png",
        "cat hero three",
        None,
        Some("txt2img"),
    );
    vec![a, b, c]
}

fn filenames(db: &Database, ids: &[i64]) -> Vec<String> {
    ids.iter()
        .map(|id| db.get_image_by_id(*id).unwrap().unwrap().filename)
        .collect()
}

fn models(db: &Database, ids: &[i64]) -> Vec<Option<String>> {
    ids.iter()
        .map(|id| db.get_image_by_id(*id).unwrap().unwrap().model_name)
        .collect()
}

fn generation_types(db: &Database, ids: &[i64]) -> Vec<String> {
    let conn = db.pool_get_for_test().unwrap();
    ids.iter()
        .map(|id| {
            conn.query_row(
                "SELECT generation_type FROM images WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get::<_, Option<String>>(0),
            )
            .unwrap()
            .unwrap_or_default()
        })
        .collect()
}

#[test]
fn sort_matrix_search_and_filter_agree_and_order_correctly() {
    let sorts: Vec<Option<&str>> = vec![
        None,
        Some("oldest"),
        Some("name_asc"),
        Some("name_desc"),
        Some("model"),
        Some("generation_type"),
    ];
    for sort in sorts {
        let db = test_db();
        let inserted = seed_matrix(&db);
        for use_filter in [false, true] {
            let (ids, label): (Vec<i64>, String) = if use_filter {
                let page = db
                    .filter_images_cursor(FilterCursorParams {
                        query: Some("cat"),
                        include_tags: &[],
                        exclude_tags: &[],
                        options: CursorQueryOptions {
                            cursor: None,
                            limit: 10,
                            sort_by: sort,
                            generation_types: None,
                            model_filter: None,
                            model_family_filters: None,
                        },
                    })
                    .unwrap_or_else(|e| panic!("filter sort={sort:?} failed: {e}"));
                (
                    page.items.iter().map(|i| i.id).collect(),
                    format!("filter sort={sort:?}"),
                )
            } else {
                let page = db
                    .search_cursor(SearchCursorParams {
                        query: "cat",
                        options: CursorQueryOptions {
                            cursor: None,
                            limit: 10,
                            sort_by: sort,
                            generation_types: None,
                            model_filter: None,
                            model_family_filters: None,
                        },
                    })
                    .unwrap_or_else(|e| panic!("search sort={sort:?} failed: {e}"));
                (
                    page.items.iter().map(|i| i.id).collect(),
                    format!("search sort={sort:?}"),
                )
            };
            assert_eq!(ids.len(), 3, "{label} should match all three rows");
            match sort {
                None => {
                    // newest default: id DESC
                    let mut expected = inserted.clone();
                    expected.sort_unstable_by(|a, b| b.cmp(a));
                    assert_eq!(ids, expected, "{label} newest order");
                }
                Some("oldest") => {
                    let mut expected = inserted.clone();
                    expected.sort_unstable();
                    assert_eq!(ids, expected, "{label} oldest order");
                }
                Some("name_asc") => {
                    let mut expected = inserted.clone();
                    expected.sort_by_key(|id| filenames(&db, &[*id])[0].clone());
                    assert_eq!(ids, expected, "{label} name_asc order");
                    let names = filenames(&db, &ids);
                    let mut sorted = names.clone();
                    sorted.sort();
                    assert_eq!(names, sorted, "{label} filenames ascending");
                }
                Some("name_desc") => {
                    let mut expected = inserted.clone();
                    expected.sort_by_key(|id| filenames(&db, &[*id])[0].clone());
                    expected.reverse();
                    assert_eq!(ids, expected, "{label} name_desc order");
                    let names = filenames(&db, &ids);
                    let mut sorted = names.clone();
                    sorted.sort();
                    sorted.reverse();
                    assert_eq!(names, sorted, "{label} filenames descending");
                }
                Some("model") => {
                    // COALESCE(model_name, '~') ASC, id ASC
                    let mut expected = inserted.clone();
                    expected.sort_by(|a, b| {
                        let ma = models(&db, &[*a])[0]
                            .clone()
                            .unwrap_or_else(|| "~".to_string());
                        let mb = models(&db, &[*b])[0]
                            .clone()
                            .unwrap_or_else(|| "~".to_string());
                        ma.cmp(&mb).then(a.cmp(b))
                    });
                    assert_eq!(ids, expected, "{label} model order");
                    // NULL model must sort last for ASC (sentinel '~').
                    let ms = models(&db, &ids);
                    assert!(
                        ms.last().unwrap().is_none(),
                        "{label} null model last, got {ms:?}"
                    );
                }
                Some("generation_type") => {
                    let mut expected = inserted.clone();
                    expected.sort_by(|a, b| {
                        let ga = generation_types(&db, &[*a])[0].clone();
                        let gb = generation_types(&db, &[*b])[0].clone();
                        ga.cmp(&gb).then(a.cmp(b))
                    });
                    assert_eq!(ids, expected, "{label} generation_type order");
                }
                Some(other) => panic!("unexpected sort {other}"),
            }
        }
    }
}

#[test]
fn trigram_fallback_fires_only_on_first_page() {
    let db = test_db();
    insert(
        &db,
        "C:/test/hero.png",
        "hero.png",
        "cat hero",
        Some("m1"),
        Some("txt2img"),
    );
    insert(
        &db,
        "C:/test/concat.png",
        "concat.png",
        "concatenation",
        Some("m1"),
        Some("txt2img"),
    );

    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = db
            .search_cursor(SearchCursorParams {
                query: "cat",
                options: CursorQueryOptions {
                    cursor: cursor.as_deref(),
                    limit: 1,
                    sort_by: None,
                    generation_types: None,
                    model_filter: None,
                    model_family_filters: None,
                },
            })
            .expect("search page failed");
        for item in &page.items {
            seen.push(item.filepath.clone());
        }
        match page.next_cursor {
            Some(c) if !page.items.is_empty() => cursor = Some(c),
            _ => break,
        }
        if seen.len() > 10 {
            break;
        }
    }
    assert!(
        seen.iter().any(|p| p.contains("hero")),
        "porter first page must contain the cat hero row, saw {seen:?}"
    );
    assert!(
        !seen.iter().any(|p| p.contains("concat")),
        "exhausted later pages must not fall back to trigram substring matches, saw {seen:?}"
    );

    // Same invariant through the filter path.
    let mut seen_f: Vec<String> = Vec::new();
    let mut cursor_f: Option<String> = None;
    loop {
        let page = db
            .filter_images_cursor(FilterCursorParams {
                query: Some("cat"),
                include_tags: &[],
                exclude_tags: &[],
                options: CursorQueryOptions {
                    cursor: cursor_f.as_deref(),
                    limit: 1,
                    sort_by: None,
                    generation_types: None,
                    model_filter: None,
                    model_family_filters: None,
                },
            })
            .expect("filter page failed");
        for item in &page.items {
            seen_f.push(item.filepath.clone());
        }
        match page.next_cursor {
            Some(c) if !page.items.is_empty() => cursor_f = Some(c),
            _ => break,
        }
        if seen_f.len() > 10 {
            break;
        }
    }
    assert!(
        !seen_f.iter().any(|p| p.contains("concat")),
        "filter exhausted pages must not fall back to trigram, saw {seen_f:?}"
    );
}
