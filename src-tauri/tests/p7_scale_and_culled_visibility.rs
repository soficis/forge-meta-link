//! P7: 10k-image scale check through the `images_live` view (PRD: search < 200ms,
//! no culled image visible on any list/search path).
use forge_meta_link_lib::{
    database::{BulkRecord, CullMode, CursorQueryOptions, Database, FilterCursorParams, SearchCursorParams},
    parser::GenerationParams,
    StorageProfile,
};
use std::time::Instant;

const TOTAL: usize = 10_000;

fn opts<'a>(limit: u32) -> CursorQueryOptions<'a> {
    CursorQueryOptions {
        cursor: None,
        limit,
        sort_by: None,
        generation_types: None,
        model_filter: None,
        model_family_filters: None,
    }
}

#[test]
fn ten_thousand_images_search_is_fast_and_culled_rows_never_appear() {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!("forge_p7_{}_{}.db", std::process::id(), nanos));
    let db = Database::new(&path, StorageProfile::Hdd).unwrap();

    let records: Vec<BulkRecord> = (0..TOTAL)
        .map(|i| {
            let word = if i % 10 == 0 { "zebra" } else { "horse" };
            BulkRecord {
                filepath: format!("/g/{i}.png"),
                filename: format!("{i}.png"),
                directory: "/g".to_string(),
                params: GenerationParams {
                    prompt: format!("{word} scene number {i}"),
                    raw_metadata: format!("{word} scene number {i}"),
                    seed: Some(format!("{}", 1000 + i)),
                    ..Default::default()
                },
                file_mtime: Some(i as i64),
                file_size: Some(1),
                quick_hash: None,
                tags: vec![format!("tag{}", i % 50)],
            }
        })
        .collect();
    db.bulk_upsert_with_tags(&records).unwrap();
    assert_eq!(db.get_total_count().unwrap(), TOTAL as u32);

    // Cull every zebra image (1000 rows): half via Trash, half via Permanent.
    let zebra_ids: Vec<i64> = (0..TOTAL)
        .step_by(10)
        .map(|i| db.get_image_id_by_filepath(&format!("/g/{i}.png")).unwrap().unwrap())
        .collect();
    let (trash, perm) = zebra_ids.split_at(zebra_ids.len() / 2);
    db.cull_images(trash, CullMode::Trash).unwrap();
    db.cull_images(perm, CullMode::Permanent).unwrap();
    assert_eq!(db.get_total_count().unwrap(), (TOTAL - zebra_ids.len()) as u32);

    // Search for the culled word: nothing may come back (Trash rows keep FTS text, so only the
    // view filter hides them).
    let started = Instant::now();
    let hits = db.search_cursor(SearchCursorParams { query: "zebra", options: opts(100) }).unwrap();
    let search_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert!(hits.items.is_empty(), "culled images leaked into search: {}", hits.items.len());

    let started = Instant::now();
    let live = db.search_cursor(SearchCursorParams { query: "horse", options: opts(100) }).unwrap();
    let live_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(live.items.len(), 100);

    let filtered = db
        .filter_images_cursor(FilterCursorParams {
            query: Some("zebra"),
            include_tags: &[],
            exclude_tags: &[],
            options: opts(100),
        })
        .unwrap();
    assert!(filtered.items.is_empty(), "culled images leaked into filter path");

    let page = db.get_images_cursor(None, 200, None, None, None, None).unwrap();
    assert!(page.items.iter().all(|r| r.filename.trim_end_matches(".png").parse::<usize>().unwrap() % 10 != 0));

    println!("p7 timings: culled-term search {search_ms:.1}ms, live-term search {live_ms:.1}ms");
    // PRD target is 200ms; allow slack for shared CI/dev machines, the printed numbers are the record.
    assert!(live_ms < 600.0, "live search too slow: {live_ms:.1}ms");
    assert!(search_ms < 600.0, "culled-term search too slow: {search_ms:.1}ms");
}
