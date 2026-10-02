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
        "forge_p5_test_{}_{}_{:?}.db",
        std::process::id(),
        nanos,
        tid
    ));
    Database::new(&path, StorageProfile::Hdd).expect("failed to create test db")
}

fn make_params(prompt: &str, seed: &str) -> GenerationParams {
    GenerationParams {
        prompt: prompt.to_string(),
        negative_prompt: "blurry".to_string(),
        steps: Some("30".to_string()),
        sampler: Some("Euler a".to_string()),
        schedule_type: Some("Automatic".to_string()),
        cfg_scale: Some("7.0".to_string()),
        seed: Some(seed.to_string()),
        width: Some(512),
        height: Some(512),
        model_hash: Some("abc12345".to_string()),
        model_name: Some("v1-5-pruned.safetensors".to_string()),
        raw_metadata: "raw".to_string(),
        ..Default::default()
    }
}

#[test]
fn test_p5_trace_chain_live_ghost_live() {
    let db = test_db();

    // 1. Insert grandparent, parent, child
    let gp_p = make_params("mountain landscape", "1000");
    let parent_p = make_params("mountain landscape snow", "1001");
    let child_p = make_params("mountain landscape blizzard", "1002");

    let gp_id = db
        .upsert_image("/dir/gp.png", "gp.png", "/dir", &gp_p, Some(1000))
        .expect("upsert gp");
    let parent_id = db
        .upsert_image("/dir/parent.png", "parent.png", "/dir", &parent_p, Some(1001))
        .expect("upsert parent");
    let child_id = db
        .upsert_image("/dir/child.png", "child.png", "/dir", &child_p, Some(1002))
        .expect("upsert child");

    // 2. Add lineage edges
    let conn = db.pool_get_for_test().expect("pool conn");
    conn.execute(
        "INSERT INTO lineage_edges (child_id, parent_id, ops_json, source) VALUES (?1, ?2, ?3, 'forge_requeue')",
        params![child_id, parent_id, r#"{"ops":[{"kind":"seed_step","value":1}]}"#],
    ).expect("insert edge 1");

    conn.execute(
        "INSERT INTO lineage_edges (child_id, parent_id, ops_json, source) VALUES (?1, ?2, ?3, 'forge_requeue')",
        params![parent_id, gp_id, r#"{"ops":[{"kind":"seed_step","value":1}]}"#],
    ).expect("insert edge 2");

    // 3. Cull Parent with Trash mode (soft tombstone)
    db.cull_images(&[parent_id], CullMode::Trash)
        .expect("cull parent");

    // 4. Trace back from child
    let trace = db.get_lineage_trace(child_id).expect("trace");
    assert_eq!(trace.target_id, child_id);
    assert_eq!(trace.nodes.len(), 3);

    // Node 0: Child (live)
    assert_eq!(trace.nodes[0].id, child_id);
    assert_eq!(trace.nodes[0].depth, 0);
    assert!(!trace.nodes[0].is_ghost);
    assert_eq!(trace.nodes[0].parent_id, Some(parent_id));
    assert_eq!(trace.nodes[0].source, "forge_requeue");

    // Node 1: Parent (ghost)
    assert_eq!(trace.nodes[1].id, parent_id);
    assert_eq!(trace.nodes[1].depth, 1);
    assert!(trace.nodes[1].is_ghost);
    assert_eq!(trace.nodes[1].parent_id, Some(gp_id));

    // Node 2: Grandparent (live root)
    assert_eq!(trace.nodes[2].id, gp_id);
    assert_eq!(trace.nodes[2].depth, 2);
    assert!(!trace.nodes[2].is_ghost);
    assert_eq!(trace.nodes[2].parent_id, None);
}

#[test]
fn test_p5_trace_permanent_ghost_recipe_and_no_prompt() {
    let db = test_db();

    let root_p = make_params("secret private prompt", "424242");
    let child_p = make_params("derived prompt", "424243");

    let root_id = db
        .upsert_image("/dir/root.png", "root.png", "/dir", &root_p, Some(1000))
        .expect("upsert root");
    let child_id = db
        .upsert_image("/dir/child.png", "child.png", "/dir", &child_p, Some(1001))
        .expect("upsert child");

    let conn = db.pool_get_for_test().expect("pool conn");
    conn.execute(
        "INSERT INTO lineage_edges (child_id, parent_id, ops_json, source) VALUES (?1, ?2, ?3, 'forge_requeue')",
        params![child_id, root_id, r#"{"ops":[{"kind":"seed_step","value":1}]}"#],
    ).expect("insert edge");

    // Cull root permanently (prompt wiped, ghost_recipe saved, path changed to ghost://<id>)
    db.cull_images(&[root_id], CullMode::Permanent)
        .expect("cull permanent");

    let trace = db.get_lineage_trace(child_id).expect("trace");
    assert_eq!(trace.nodes.len(), 2);

    let ghost_node = &trace.nodes[1];
    assert_eq!(ghost_node.id, root_id);
    assert!(ghost_node.is_ghost);
    assert_eq!(ghost_node.filepath, format!("ghost://{}", root_id));
    assert!(ghost_node.prompt.is_none());
    assert_eq!(ghost_node.seed.as_deref(), Some("424242"));
    assert_eq!(ghost_node.cfg_scale.as_deref(), Some("7.0"));
    assert_eq!(ghost_node.steps.as_deref(), Some("30"));
    assert!(ghost_node.ghost_recipe.is_some());
}

#[test]
fn test_p5_trace_cycle_detection_does_not_hang() {
    let db = test_db();

    let p_a = make_params("prompt a", "111");
    let p_b = make_params("prompt b", "222");

    let id_a = db
        .upsert_image("/dir/a.png", "a.png", "/dir", &p_a, Some(1000))
        .expect("upsert a");
    let id_b = db
        .upsert_image("/dir/b.png", "b.png", "/dir", &p_b, Some(1001))
        .expect("upsert b");

    let conn = db.pool_get_for_test().expect("pool conn");
    // Artificial cycle A -> B -> A
    conn.execute(
        "INSERT INTO lineage_edges (child_id, parent_id, ops_json, source) VALUES (?1, ?2, NULL, 'forge_requeue')",
        params![id_a, id_b],
    ).expect("edge a->b");
    conn.execute(
        "INSERT INTO lineage_edges (child_id, parent_id, ops_json, source) VALUES (?1, ?2, NULL, 'forge_requeue')",
        params![id_b, id_a],
    ).expect("edge b->a");

    let trace = db.get_lineage_trace(id_a).expect("trace");
    // Traversal detects cycle when visiting A again and terminates immediately
    assert_eq!(trace.nodes.len(), 2);
    assert_eq!(trace.nodes[0].id, id_a);
    assert_eq!(trace.nodes[1].id, id_b);
}

#[test]
fn test_p5_trace_fallback_to_heuristic_lineage() {
    let db = test_db();

    let p_parent = make_params("photo of a cat", "555");
    let p_child = make_params("photo of a cat sitting", "556");

    let p_id = db
        .upsert_image("/dir/h_parent.png", "h_parent.png", "/dir", &p_parent, Some(1000))
        .expect("upsert p");
    let c_id = db
        .upsert_image("/dir/h_child.png", "h_child.png", "/dir", &p_child, Some(1001))
        .expect("upsert c");

    // Insert legacy lineage table edge (no lineage_edges row)
    let conn = db.pool_get_for_test().expect("pool conn");
    conn.execute(
        "INSERT INTO lineage (child_filepath, parent_filepath, relation, confidence, created_at)
         VALUES ('/dir/h_child.png', '/dir/h_parent.png', 'seed_walk', 0.85, 1700000000)",
        [],
    ).expect("insert legacy edge");

    let trace = db.get_lineage_trace(c_id).expect("trace");
    assert_eq!(trace.nodes.len(), 2);
    assert_eq!(trace.nodes[0].id, c_id);
    assert_eq!(trace.nodes[0].parent_id, Some(p_id));
    assert_eq!(trace.nodes[0].source, "inferred");
    assert_eq!(trace.nodes[1].id, p_id);
}
