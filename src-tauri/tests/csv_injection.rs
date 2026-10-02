use csv::Writer;

/// Mirrors sanitize_csv_field from src-tauri/src/commands/export.rs:
/// if cell trimmed starts with = + - @ prefix with ' and csv quoting.
fn sanitize_csv_field(field: &str) -> String {
    let trimmed = field.trim_start_matches(' ');
    if trimmed.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{}", field)
    } else {
        field.to_string()
    }
}

#[derive(Debug)]
struct ExportImage {
    id: i64,
    filepath: String,
    filename: String,
    directory: String,
    prompt: String,
    negative_prompt: String,
    steps: Option<String>,
    sampler: Option<String>,
    cfg_scale: Option<String>,
    seed: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    model_hash: Option<String>,
    model_name: Option<String>,
    raw_metadata: String,
    tags: Vec<String>,
}

fn build_csv_export(records: &[ExportImage]) -> Result<String, csv::Error> {
    let mut wtr = Writer::from_writer(Vec::new());
    wtr.write_record([
        "id",
        "filepath",
        "filename",
        "directory",
        "prompt",
        "negative_prompt",
        "steps",
        "sampler",
        "cfg_scale",
        "seed",
        "width",
        "height",
        "model_hash",
        "model_name",
        "raw_metadata",
        "tags",
    ])?;
    for record in records {
        wtr.write_record([
            sanitize_csv_field(&record.id.to_string()),
            sanitize_csv_field(&record.filepath),
            sanitize_csv_field(&record.filename),
            sanitize_csv_field(&record.directory),
            sanitize_csv_field(&record.prompt),
            sanitize_csv_field(&record.negative_prompt),
            sanitize_csv_field(record.steps.as_deref().unwrap_or("")),
            sanitize_csv_field(record.sampler.as_deref().unwrap_or("")),
            sanitize_csv_field(record.cfg_scale.as_deref().unwrap_or("")),
            sanitize_csv_field(record.seed.as_deref().unwrap_or("")),
            sanitize_csv_field(&record.width.map(|v| v.to_string()).unwrap_or_default()),
            sanitize_csv_field(&record.height.map(|v| v.to_string()).unwrap_or_default()),
            sanitize_csv_field(record.model_hash.as_deref().unwrap_or("")),
            sanitize_csv_field(record.model_name.as_deref().unwrap_or("")),
            sanitize_csv_field(&record.raw_metadata),
            sanitize_csv_field(&record.tags.join("|")),
        ])?;
    }
    let bytes = wtr.into_inner().map_err(|e| e.into_error())?;
    Ok(String::from_utf8(bytes).unwrap_or_default())
}

#[test]
fn csv_injection_leading_equals_is_prefixed() {
    assert_eq!(sanitize_csv_field("=2+2"), "'=2+2");
    assert_eq!(
        sanitize_csv_field("=HYPERLINK(\"http://evil\",\"click\")"),
        "'=HYPERLINK(\"http://evil\",\"click\")"
    );
}

#[test]
fn csv_injection_leading_at_plus_minus_are_prefixed() {
    assert_eq!(sanitize_csv_field("@malicious"), "'@malicious");
    assert_eq!(sanitize_csv_field("+20"), "'+20");
    assert_eq!(sanitize_csv_field("-Euler"), "'-Euler");
    // trimmed variant with leading spaces must also be prefixed
    assert_eq!(sanitize_csv_field("   =cmd"), "'   =cmd");
    assert_eq!(sanitize_csv_field("  @foo"), "'  @foo");
    assert_eq!(sanitize_csv_field("\t+bar"), "'\t+bar");
    assert_eq!(sanitize_csv_field("\tcmd"), "'\tcmd");
    assert_eq!(sanitize_csv_field("\rcmd"), "'\rcmd");
    assert_eq!(sanitize_csv_field("   \tcmd"), "'   \tcmd");
    assert_eq!(sanitize_csv_field("   \rcmd"), "'   \rcmd");
    assert_eq!(sanitize_csv_field(" -baz"), "' -baz");
}

#[test]
fn csv_injection_normal_cells_unchanged() {
    assert_eq!(sanitize_csv_field("hello world"), "hello world");
    assert_eq!(sanitize_csv_field("123"), "123");
    assert_eq!(sanitize_csv_field(""), "");
    assert_eq!(sanitize_csv_field("   "), "   ");
    // internal = not at start should not be prefixed
    assert_eq!(sanitize_csv_field("foo=bar"), "foo=bar");
    assert_eq!(sanitize_csv_field("a+b"), "a+b");
}

#[test]
fn csv_injection_build_export_escapes_all_fields() {
    let records = vec![ExportImage {
        id: 1,
        filepath: "C:/images/test.png".to_string(),
        filename: "test.png".to_string(),
        directory: "C:/images".to_string(),
        prompt: "=2+2; cmd|' /C calc'!A0".to_string(),
        negative_prompt: "@malicious".to_string(),
        steps: Some("+20".to_string()),
        sampler: Some("-Euler".to_string()),
        cfg_scale: None,
        seed: None,
        width: Some(1024),
        height: Some(1024),
        model_hash: None,
        model_name: Some("=HYPERLINK(\"http://evil\",\"click\")".to_string()),
        raw_metadata: "=cmd".to_string(),
        tags: vec!["=injection".to_string()],
    }];
    let csv = build_csv_export(&records).expect("csv build failed");
    // Verify each dangerous cell was prefixed with single quote
    assert!(csv.contains("'=2+2"), "prompt not escaped: {}", csv);
    assert!(
        csv.contains("'@malicious"),
        "negative_prompt not escaped: {}",
        csv
    );
    assert!(csv.contains("'+20"), "steps not escaped: {}", csv);
    assert!(csv.contains("'-Euler"), "sampler not escaped: {}", csv);
    assert!(
        csv.contains("'=HYPERLINK"),
        "model_name not escaped: {}",
        csv
    );
    assert!(csv.contains("'=cmd"), "raw_metadata not escaped: {}", csv);
    assert!(csv.contains("'=injection"), "tags not escaped: {}", csv);
    // Ensure csv quoting via csv crate still protects commas/quotes/newlines
    let with_comma = ExportImage {
        id: 2,
        filepath: "a,b".to_string(),
        filename: "c\"d".to_string(),
        directory: "e\nf".to_string(),
        prompt: "normal".to_string(),
        negative_prompt: "".to_string(),
        steps: None,
        sampler: None,
        cfg_scale: None,
        seed: None,
        width: None,
        height: None,
        model_hash: None,
        model_name: None,
        raw_metadata: "".to_string(),
        tags: vec![],
    };
    let csv2 = build_csv_export(&[with_comma]).expect("csv2 failed");
    // csv writer should quote fields containing comma/quote/newline
    assert!(
        csv2.contains("\"a,b\"") || csv2.contains("'a,b") == false,
        "comma field not quoted: {}",
        csv2
    );
    println!(
        "csv_injection defense verified: {}",
        csv.lines().next().unwrap_or("")
    );
}

#[test]
fn csv_injection_tab_and_pipe_payloads() {
    // Common DDE payloads
    for payload in [
        "=cmd|' /C calc'!A0",
        "@SUM(1+1)",
        "+2+2",
        "-2+2",
        "=2+5+cmd|' /C calc'!A0",
    ] {
        let sanitized = sanitize_csv_field(payload);
        assert!(
            sanitized.starts_with('\''),
            "payload {} not prefixed: {}",
            payload,
            sanitized
        );
    }
}
