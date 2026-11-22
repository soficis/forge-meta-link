use forge_meta_link_lib::{
    commands::{build_asset_report, extract_lora_names},
    database::Database,
    parser::GenerationParams,
    StorageProfile,
};
use std::collections::HashMap;

fn test_db() -> Database {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "forge_assets_{}_{}_{:?}.db",
        std::process::id(),
        nanos,
        std::thread::current().id()
    ));
    Database::new(&path, StorageProfile::Hdd).expect("test db")
}

fn temp_dir(prefix: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "forge_assets_{}_{}_{}_{:?}",
        prefix,
        std::process::id(),
        nanos,
        std::thread::current().id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn params_with(model: &str, prompt: &str) -> GenerationParams {
    GenerationParams {
        prompt: prompt.to_string(),
        raw_metadata: prompt.to_string(),
        model_name: Some(model.to_string()),
        extra_params: HashMap::new(),
        ..Default::default()
    }
}

#[test]
fn bracket_weight_lora_extracts_bare_name() {
    assert_eq!(
        extract_lora_names("<lora:a:[0.8@t1, 0.6@t2]>"),
        vec!["a".to_string()]
    );
    assert_eq!(
        extract_lora_names("x <lora:MyStyle:0.7> y"),
        vec!["MyStyle".to_string()]
    );
    assert_eq!(
        extract_lora_names("<LORA:Upper:1.0>"),
        vec!["Upper".to_string()]
    );
}

#[test]
fn detects_present_and_missing_models_and_loras() {
    let db = test_db();
    let img_dir = temp_dir("imgs");
    let dir_s = img_dir.to_string_lossy().to_string();

    let models_dir = temp_dir("models");
    let loras_dir = temp_dir("loras");
    std::fs::write(models_dir.join("goodModel.safetensors"), b"fake").unwrap();
    std::fs::write(loras_dir.join("goodLora.safetensors"), b"fake").unwrap();
    let nested = loras_dir.join("sub");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(nested.join("a.safetensors"), b"fake").unwrap();

    db.upsert_image(
        &format!("{}/one.png", dir_s),
        "one.png",
        &dir_s,
        &params_with("goodModel", "a photo <lora:goodLora:0.8>"),
        Some(1),
    )
    .unwrap();
    db.upsert_image(
        &format!("{}/two.png", dir_s),
        "two.png",
        &dir_s,
        &params_with(
            "missingModel",
            "another <lora:a:[0.8@t1, 0.6@t2]> and <lora:missingLora:1.0>",
        ),
        Some(2),
    )
    .unwrap();

    let report = build_asset_report(
        &db,
        &[dir_s.clone()],
        Some(&models_dir.to_string_lossy()),
        Some(&loras_dir.to_string_lossy()),
    )
    .unwrap();

    assert_eq!(report.total_referenced_models, 2);
    assert_eq!(report.total_referenced_loras, 3);
    assert_eq!(report.models.len(), 2);
    assert_eq!(report.loras.len(), 3);

    let good = report
        .models
        .iter()
        .find(|m| m.name == "goodModel")
        .unwrap();
    assert!(good.found);
    assert!(good
        .path_hint
        .as_deref()
        .unwrap()
        .ends_with("goodModel.safetensors"));
    assert_eq!(good.referencing_image_count, 1);

    let missing = report
        .models
        .iter()
        .find(|m| m.name == "missingModel")
        .unwrap();
    assert!(!missing.found);
    assert_eq!(missing.path_hint, None);
    assert_eq!(missing.referencing_image_count, 1);

    let lora_names: Vec<&str> = report.loras.iter().map(|l| l.name.as_str()).collect();
    assert!(lora_names.contains(&"a"));
    assert!(lora_names.contains(&"goodLora"));
    assert!(lora_names.contains(&"missingLora"));

    let a = report.loras.iter().find(|l| l.name == "a").unwrap();
    assert!(a.found, "nested a.safetensors must be found recursively");
    assert!(a.path_hint.as_deref().unwrap().ends_with("a.safetensors"));
    assert_eq!(a.referencing_image_count, 1);

    let gone = report
        .loras
        .iter()
        .find(|l| l.name == "missingLora")
        .unwrap();
    assert!(!gone.found);
    assert_eq!(gone.path_hint, None);
}

#[test]
fn empty_dir_list_uses_indexed_directories() {
    let db = test_db();
    let img_dir = temp_dir("imgs_empty");
    let dir_s = img_dir.to_string_lossy().to_string();

    let models_dir = temp_dir("models_empty");
    let loras_dir = temp_dir("loras_empty");
    std::fs::write(models_dir.join("emptyDirModel.safetensors"), b"fake").unwrap();
    std::fs::write(loras_dir.join("emptyLora.safetensors"), b"fake").unwrap();

    db.upsert_image(
        &format!("{}/e.png", dir_s),
        "e.png",
        &dir_s,
        &params_with("emptyDirModel", "pic <lora:emptyLora:1.0>"),
        Some(1),
    )
    .unwrap();

    let report = build_asset_report(
        &db,
        &[],
        Some(&models_dir.to_string_lossy()),
        Some(&loras_dir.to_string_lossy()),
    )
    .unwrap();
    assert!(
        report.models.iter().any(|m| m.name == "emptyDirModel"),
        "empty dirs must fall back to indexed directories"
    );
    assert!(
        report.loras.iter().any(|l| l.name == "emptyLora"),
        "empty dirs must fall back to indexed directories"
    );

    let scoped = build_asset_report(
        &db,
        &["/nonexistent-dir-xyz".to_string()],
        Some(&models_dir.to_string_lossy()),
        Some(&loras_dir.to_string_lossy()),
    )
    .unwrap();
    assert_eq!(scoped.total_referenced_models, 0);
    assert_eq!(scoped.total_referenced_loras, 0);
}
