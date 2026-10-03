//! Live Forge Neo ship gate (PRD G9): requeue must round-trip every field bit-exact.
//!
//! Opt-in: set `FORGE_LIVE_URL` (e.g. http://127.0.0.1:7860) and optionally `FORGE_API_KEY`.
//! Without it every test here returns immediately, so plain `cargo test` stays offline.
//!
//!   FORGE_LIVE_URL=http://127.0.0.1:7860 cargo test --test forge_live_gate -- --nocapture --test-threads=1
//!
//! Unlike the old JS harness (a hand-copied payload builder), this drives the app's real code:
//! real PNG metadata extraction + parser, the real DB record, and the real payload builders.
//! If `FORGE_GATE_JSON` names a directory, each test writes `<test>.json` (its result list) there
//! so scripts/verify-forge-roundtrip.mjs can fold the results into the report.

use forge_meta_link_lib::{
    database::{Database, ImageRecord},
    forge_api::{self, ForgePayload, ForgePayloadBuildInput},
    parser::{self, GenerationParams},
    scanner, StorageProfile,
};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;

/// 64-bit seed above 2^32 (and below 2^53) to catch u32 truncation.
const SOURCE_SEED: &str = "4294967299";

#[derive(Debug, Serialize, Clone)]
struct CheckResult {
    scenario: String,
    field: String,
    expected: String,
    actual: String,
    ok: bool,
}

fn live_url() -> Option<String> {
    std::env::var("FORGE_LIVE_URL")
        .ok()
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
}

fn api_key() -> Option<String> {
    std::env::var("FORGE_API_KEY").ok().filter(|k| !k.trim().is_empty())
}

fn run<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("forge_gate_{tag}_{}_{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn decode_png(b64: &str) -> Vec<u8> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let raw = b64.split_once(";base64,").map(|(_, d)| d).unwrap_or(b64);
    STANDARD.decode(raw.trim()).expect("forge returned invalid base64")
}

async fn get_json(url: &str) -> Value {
    let mut req = reqwest::Client::new().get(url);
    if let Some(k) = api_key() {
        req = req.bearer_auth(k);
    }
    req.send().await.expect("GET failed").json().await.expect("bad json")
}

/// Sends a payload through the production sender and returns the first PNG plus the infotext.
async fn generate(payload: &ForgePayload, url: &str) -> (Vec<u8>, String) {
    let result = forge_api::send_to_forge(payload, url, api_key().as_deref())
        .await
        .expect("send_to_forge errored");
    assert!(result.ok, "Forge rejected the payload: {}", result.message);
    let png = decode_png(result.images.first().expect("no image returned"));
    let info: Value = serde_json::from_str(result.info.as_deref().unwrap_or("{}")).unwrap_or(Value::Null);
    let infotext = info["infotexts"][0].as_str().unwrap_or("").to_string();
    (png, infotext)
}

/// Fields that must survive a requeue unchanged. Scheduler/sampler compare case-insensitively
/// because Forge reports display labels ("Karras") for API names ("karras").
fn compare(scenario: &str, source: &GenerationParams, got: &GenerationParams) -> Vec<CheckResult> {
    let norm = |v: &Option<String>| v.as_deref().unwrap_or("").trim().to_lowercase();
    let mut out = Vec::new();
    let mut check = |field: &str, expected: String, actual: String, ci: bool| {
        let ok = if ci { expected.to_lowercase() == actual.to_lowercase() } else { expected == actual };
        out.push(CheckResult { scenario: scenario.into(), field: field.into(), expected, actual, ok });
    };
    check("steps", norm(&source.steps), norm(&got.steps), false);
    check("sampler", norm(&source.sampler), norm(&got.sampler), true);
    check("scheduler", norm(&source.schedule_type), norm(&got.schedule_type), true);
    check("cfg_scale", norm(&source.cfg_scale), norm(&got.cfg_scale), false);
    check("seed", norm(&source.seed), norm(&got.seed), false);
    check(
        "size",
        format!("{}x{}", source.width.unwrap_or(0), source.height.unwrap_or(0)),
        format!("{}x{}", got.width.unwrap_or(0), got.height.unwrap_or(0)),
        false,
    );
    check("model_hash", norm(&source.model_hash), norm(&got.model_hash), true);
    for key in ["Lora hashes", "Clip skip"] {
        let s = source.extra_params.get(key).cloned().unwrap_or_default();
        let g = got.extra_params.get(key).cloned().unwrap_or_default();
        check(key, s, g, false);
    }
    out
}

struct Source {
    record: ImageRecord,
    params: GenerationParams,
    lora: Option<String>,
}

/// Generates a source image with a full parameter set, then ingests it through the real
/// extractor + parser + database, exactly like a folder scan would.
fn make_source(url: &str) -> Source {
    run(async {
        let loras = get_json(&format!("{url}/sdapi/v1/loras")).await;
        let lora = loras
            .as_array()
            .and_then(|a| a.first())
            .and_then(|l| l["name"].as_str())
            .map(String::from);
        let prompt = match &lora {
            Some(name) => format!("a lighthouse at dusk, <lora:{name}:0.6>"),
            None => "a lighthouse at dusk".to_string(),
        };
        let params = GenerationParams {
            prompt,
            negative_prompt: "blurry, lowres".into(),
            steps: Some("4".into()),
            sampler: Some("Euler a".into()),
            schedule_type: Some("karras".into()),
            cfg_scale: Some("5.5".into()),
            seed: Some(SOURCE_SEED.into()),
            width: Some(64),
            height: Some(64),
            ..Default::default()
        };
        let payload = forge_api::build_payload_from_generation_params(&params, true, false, None);
        let (png, _) = generate(&payload, url).await;

        let dir = temp_dir("src");
        let path = dir.join("source.png");
        std::fs::write(&path, &png).unwrap();
        let raw = scanner::extract_metadata(&path)
            .expect("extract_metadata failed")
            .expect("Forge image carried no metadata; enable 'save text information' in Forge");
        let parsed = parser::parse_generation_metadata(&raw);

        let db = Database::new(&dir.join("gate.db"), StorageProfile::Hdd).unwrap();
        let id = db
            .upsert_image(path.to_str().unwrap(), "source.png", dir.to_str().unwrap(), &parsed, Some(1))
            .unwrap();
        let record = db.get_image_by_id(id).unwrap().expect("record missing");
        Source { record, params: parsed, lora }
    })
}

/// Mirrors `build_payload_for_image` in commands/forge.rs (the Send-to / batch path):
/// scheduler resolves through `forge_api::resolve_scheduler`, everything else straight from the record.
fn send_to_payload(
    rec: &ImageRecord,
    include_seed: bool,
    adetailer: bool,
    seed_override: Option<&str>,
    cfg_override: Option<&str>,
) -> ForgePayload {
    let scheduler = forge_api::resolve_scheduler(None, &rec.raw_metadata);
    forge_api::build_payload_from_image_record(ForgePayloadBuildInput {
        prompt: &rec.prompt,
        negative_prompt: &rec.negative_prompt,
        steps: rec.steps.as_deref(),
        sampler: rec.sampler.as_deref(),
        scheduler: scheduler.as_deref(),
        cfg_scale: cfg_override.or(rec.cfg_scale.as_deref()),
        seed: seed_override.or(rec.seed.as_deref()),
        width: rec.width,
        height: rec.height,
        model_name: rec.model_name.as_deref(),
        include_seed,
        adetailer_face_enabled: adetailer,
        adetailer_face_model: Some("face_yolov8n.pt"),
    })
}

/// Mirrors `forge_requeue_image` in commands/forge.rs.
fn requeue_params(rec: &ImageRecord) -> GenerationParams {
    let stored = parser::parse_generation_metadata(&rec.raw_metadata);
    GenerationParams {
        prompt: rec.prompt.clone(),
        negative_prompt: rec.negative_prompt.clone(),
        steps: rec.steps.clone(),
        sampler: rec.sampler.clone(),
        schedule_type: forge_api::resolve_scheduler(None, &rec.raw_metadata),
        cfg_scale: rec.cfg_scale.clone(),
        seed: rec.seed.clone(),
        width: rec.width,
        height: rec.height,
        model_hash: rec.model_hash.clone(),
        model_name: rec.model_name.clone(),
        generation_type: None,
        extra_params: stored.extra_params,
        raw_metadata: rec.raw_metadata.clone(),
    }
}

fn parse_infotext(infotext: &str) -> GenerationParams {
    parser::parse_generation_metadata(infotext)
}

fn report(test: &str, all: &[CheckResult]) {
    for r in all {
        println!(
            "[{}] {:<10} {:<14} expected={:<28} actual={}",
            if r.ok { "OK " } else { "BAD" },
            r.scenario,
            r.field,
            r.expected,
            r.actual
        );
    }
    if let Ok(dir) = std::env::var("FORGE_GATE_JSON") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join(format!("{test}.json")),
            serde_json::to_string_pretty(all).unwrap(),
        )
        .unwrap();
    }
}

fn assert_all_ok(all: &[CheckResult]) {
    let bad: Vec<_> = all.iter().filter(|r| !r.ok).collect();
    assert!(
        bad.is_empty(),
        "round-trip mismatches against live Forge Neo:\n{}",
        bad.iter()
            .map(|r| format!("  {} / {}: expected {:?}, got {:?}", r.scenario, r.field, r.expected, r.actual))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn live_requeue_paths_roundtrip_every_field() {
    let Some(url) = live_url() else {
        eprintln!("FORGE_LIVE_URL not set; skipping live gate");
        return;
    };
    let src = make_source(&url);
    // Sanity: the ingested source itself must carry the params we asked for.
    assert_eq!(src.params.seed.as_deref(), Some(SOURCE_SEED), "source seed not preserved by Forge/parser");
    let mut all = Vec::new();

    run(async {
        // 1. Send-to / batch path (forge_send_to_image(s)).
        let (_, info) = generate(&send_to_payload(&src.record, true, false, None, None), &url).await;
        all.extend(compare("send_to", &src.params, &parse_infotext(&info)));

        // 2. Requeue path (forge_requeue_image).
        let payload = forge_api::build_requeue_payload(&requeue_params(&src.record), true);
        let (_, info) = generate(&payload, &url).await;
        all.extend(compare("requeue", &src.params, &parse_infotext(&info)));

        // 3. Per-variant params: each request keeps its own seed/cfg, no bleed between requests.
        for (i, (seed, cfg)) in [("4294967300", "6.0"), ("4294967301", "7.5"), ("4294967302", "9.0")]
            .iter()
            .enumerate()
        {
            let mut expect = src.params.clone();
            expect.seed = Some((*seed).into());
            expect.cfg_scale = Some((*cfg).into());
            let (_, info) =
                generate(&send_to_payload(&src.record, true, false, Some(seed), Some(cfg)), &url).await;
            all.extend(compare(&format!("variant{}", i + 1), &expect, &parse_infotext(&info)));
        }
    });

    report("roundtrip", &all);
    assert_all_ok(&all);
}

#[test]
fn live_adetailer_variant_keeps_params_and_is_actually_applied() {
    let Some(url) = live_url() else { return };
    run(async {
        let scripts = get_json(&format!("{url}/sdapi/v1/scripts")).await;
        let has_adetailer = scripts["txt2img"]
            .as_array()
            .map(|a| a.iter().any(|s| s.as_str().map(|n| n.eq_ignore_ascii_case("adetailer")).unwrap_or(false)))
            .unwrap_or(false);
        if !has_adetailer {
            eprintln!("ADetailer not installed on this Forge; skipping");
            return;
        }
    });
    let src = make_source(&url);
    let (_, info) = run(generate(&send_to_payload(&src.record, true, true, None, None), &url));
    let mut all = compare("adetailer", &src.params, &parse_infotext(&info));
    let applied = info.contains("ADetailer");
    all.push(CheckResult {
        scenario: "adetailer".into(),
        field: "extension_applied".into(),
        expected: "ADetailer in infotext".into(),
        actual: if applied { "present".into() } else { "absent".into() },
        ok: applied,
    });
    report("adetailer", &all);
    assert_all_ok(&all);
}

#[test]
fn live_lora_survives_requeue() {
    let Some(url) = live_url() else { return };
    let src = make_source(&url);
    let Some(name) = src.lora.clone() else {
        eprintln!("No LoRA installed on this Forge; skipping");
        return;
    };
    let (_, info) = run(generate(&send_to_payload(&src.record, true, false, None, None), &url));
    let got = parse_infotext(&info);
    let in_prompt = got.prompt.contains(&format!("<lora:{name}"));
    let hashes = got.extra_params.get("Lora hashes").cloned().unwrap_or_default();
    assert!(in_prompt, "LoRA tag missing from regenerated prompt: {}", got.prompt);
    assert!(
        hashes.contains(&name) || src.params.extra_params.get("Lora hashes").is_none(),
        "LoRA was not loaded by Forge on requeue (Lora hashes: {hashes:?})"
    );
}
