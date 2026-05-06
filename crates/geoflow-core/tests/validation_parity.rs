//! Validation parity tests.
//!
//! These tests mirror the coverage of the python-ags4 library's test suite,
//! ensuring GeoFlow produces equivalent diagnostics for the same inputs.
//! Each test is annotated with the python-ags4 rule number it corresponds to.

use std::path::PathBuf;

use geoflow_core::ags::{parse_bytes, parse_str};
use geoflow_core::validate::{validate, Registry};
use geoflow_core::Severity;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ags")
}

fn check(input: &str) -> Vec<geoflow_core::Diagnostic> {
    let parsed = parse_str(input);
    let r = Registry::standard();
    validate(&parsed.file, &r)
}

// ── py-ags4 Rule 1: file encoding ─────────────────────────────────────────────

#[test]
fn rule1_utf8_bom_is_parsed_cleanly() {
    let path = fixtures_dir().join("encoding_win1252.ags");
    let bytes = std::fs::read(&path).unwrap();
    let out = parse_bytes(&bytes);
    assert!(
        !out.diagnostics
            .iter()
            .any(|d| d.severity == Severity::Error),
        "Windows-1252 file should parse without errors: {:?}",
        out.diagnostics
    );
    // Project name with Windows-1252 specific chars survives round-trip.
    let proj = out.file.group("PROJ").unwrap();
    let name = proj.rows[0].get("PROJ_NAME").and_then(|v| v.as_text());
    assert!(name.is_some(), "PROJ_NAME should be present");
}

#[test]
fn rule1_utf8_with_bom_is_stripped() {
    let content = b"\xEF\xBB\xBF\"GROUP\",\"PROJ\"\r\n\"HEADING\",\"PROJ_ID\"\r\n\"UNIT\",\"\"\r\n\"TYPE\",\"ID\"\r\n\"DATA\",\"P1\"\r\n";
    let out = parse_bytes(content);
    assert!(
        !out.diagnostics
            .iter()
            .any(|d| d.severity == Severity::Error),
        "BOM should be silently stripped: {:?}",
        out.diagnostics
    );
    assert!(out.file.group("PROJ").is_some());
}

// ── py-ags4 Rule 2a: CRLF line endings ───────────────────────────────────────

#[test]
fn rule2a_lf_only_detected_by_fix_inspection() {
    let lf_content = b"\"GROUP\",\"PROJ\"\n\"HEADING\",\"PROJ_ID\"\n\"UNIT\",\"\"\n\"TYPE\",\"ID\"\n\"DATA\",\"P1\"\n";
    let findings = geoflow_core::fix::inspect_bytes(lf_content);
    assert!(
        findings.findings.contains(&"normalize-line-endings"),
        "LF-only file should trigger normalize-line-endings fix"
    );
}

#[test]
fn rule2a_crlf_no_fix_needed() {
    let crlf = b"\"GROUP\",\"PROJ\"\r\n\"HEADING\",\"PROJ_ID\"\r\n\"UNIT\",\"\"\r\n\"TYPE\",\"ID\"\r\n\"DATA\",\"P1\"\r\n";
    let findings = geoflow_core::fix::inspect_bytes(crlf);
    assert!(
        !findings.findings.contains(&"normalize-line-endings"),
        "CRLF file should not trigger line-ending fix"
    );
}

// ── py-ags4 Rule 3: blank lines ───────────────────────────────────────────────

#[test]
fn rule3_double_blank_detected() {
    let content = b"\"GROUP\",\"PROJ\"\r\n\r\n\r\n\"HEADING\",\"PROJ_ID\"\r\n";
    let findings = geoflow_core::fix::inspect_bytes(content);
    assert!(findings.findings.contains(&"dedupe-blank-lines"));
}

#[test]
fn rule3_missing_final_newline_detected() {
    let content = b"\"GROUP\",\"PROJ\"";
    let findings = geoflow_core::fix::inspect_bytes(content);
    assert!(findings.findings.contains(&"enforce-final-newline"));
}

// ── py-ags4 Rule 4: GROUP/HEADING/UNIT/TYPE/DATA order ───────────────────────

#[test]
fn rule4_data_before_heading_flagged() {
    let bad = "\"GROUP\",\"LOCA\"\n\"DATA\",\"BH01\"\n";
    let out = parse_str(bad);
    assert!(
        out.diagnostics
            .iter()
            .any(|d| d.rule_id == "AGS-DATA-NOHEAD"),
        "DATA before HEADING should produce AGS-DATA-NOHEAD: {:?}",
        out.diagnostics
    );
}

#[test]
fn rule4_heading_before_group_flagged() {
    let bad = "\"HEADING\",\"LOCA_ID\"\n";
    let out = parse_str(bad);
    assert!(
        out.diagnostics
            .iter()
            .any(|d| d.rule_id == "AGS-HEADING-ORPHAN"),
        "HEADING before GROUP: {:?}",
        out.diagnostics
    );
}

#[test]
fn rule4_unit_before_heading_flagged() {
    let bad = "\"GROUP\",\"LOCA\"\n\"UNIT\",\"\"\n";
    let out = parse_str(bad);
    assert!(
        out.diagnostics
            .iter()
            .any(|d| d.rule_id == "AGS-UNIT-NOHEAD"),
        "UNIT before HEADING: {:?}",
        out.diagnostics
    );
}

#[test]
fn rule4_type_before_unit_detected() {
    let content =
        b"\"GROUP\",\"X\"\r\n\"HEADING\",\"X_ID\"\r\n\"TYPE\",\"ID\"\r\n\"UNIT\",\"\"\r\n";
    let findings = geoflow_core::fix::inspect_bytes(content);
    assert!(
        findings.findings.contains(&"reorder-unit-type"),
        "TYPE before UNIT should be detected: {:?}",
        findings.findings
    );
}

// ── py-ags4 Rule 5: all fields quoted ─────────────────────────────────────────

#[test]
fn rule5_unquoted_field_flagged() {
    let bad = "\"GROUP\",UNQUOTED\n";
    let out = parse_str(bad);
    assert!(
        out.diagnostics.iter().any(|d| d.rule_id == "AGS-LEX"),
        "unquoted field should produce AGS-LEX: {:?}",
        out.diagnostics
    );
}

// ── py-ags4 Rule 6: column count matches HEADING ──────────────────────────────

#[test]
fn rule6_extra_columns_warned() {
    let bad = r#""GROUP","X"
"HEADING","X_A","X_B"
"UNIT","",""
"TYPE","X","X"
"DATA","one","two","three_extra"
"#;
    let out = parse_str(bad);
    assert!(
        out.diagnostics
            .iter()
            .any(|d| d.rule_id == "AGS-DATA-EXTRA"),
        "extra column should produce AGS-DATA-EXTRA: {:?}",
        out.diagnostics
    );
}

#[test]
fn rule6_short_row_warned() {
    let bad = r#""GROUP","X"
"HEADING","X_A","X_B","X_C"
"UNIT","","",""
"TYPE","X","X","X"
"DATA","one","two"
"#;
    let out = parse_str(bad);
    assert!(
        out.diagnostics
            .iter()
            .any(|d| d.rule_id == "AGS-DATA-SHORT"),
        "short row should produce AGS-DATA-SHORT: {:?}",
        out.diagnostics
    );
}

// ── py-ags4 Rule 9: heading uniqueness ────────────────────────────────────────

#[test]
fn rule9_duplicate_heading_flagged() {
    let bad = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"HEADING","LOCA_ID","LOCA_NATE"
"#;
    let out = parse_str(bad);
    assert!(
        out.diagnostics
            .iter()
            .any(|d| d.rule_id == "AGS-HEADING-DUP"),
        "duplicate HEADING row: {:?}",
        out.diagnostics
    );
}

// ── py-ags4 Rule 10: PROJ group ───────────────────────────────────────────────

#[test]
fn rule10_proj_missing_flagged() {
    let d = check(
        r#""GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-STRUCT-001"),
        "missing PROJ: {d:?}"
    );
}

#[test]
fn rule10_proj_multiple_rows_flagged() {
    let d = check(
        r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"
"DATA","P2"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-STRUCT-001"),
        "multiple PROJ rows should fire AGS-STRUCT-001: {d:?}"
    );
}

// ── py-ags4 Rule 11: TRAN group ───────────────────────────────────────────────

#[test]
fn rule11_tran_missing_flagged() {
    let d = check(
        r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-STRUCT-002"),
        "missing TRAN: {d:?}"
    );
}

// ── py-ags4 Rule 12: TRAN_AGS version ─────────────────────────────────────────

#[test]
fn rule12_unknown_version_warned() {
    let d = check(
        r#""GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","3.0"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-STRUCT-004"),
        "AGS 3.0 version should fire AGS-STRUCT-004: {d:?}"
    );
}

#[test]
fn rule12_known_versions_accepted() {
    for ver in ["4.0.3", "4.0.4", "4.1"] {
        let d = check(&format!(
            r#""GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","{ver}"
"#
        ));
        assert!(
            !d.iter().any(|x| x.rule_id == "AGS-STRUCT-004"),
            "version {ver} should not fire AGS-STRUCT-004: {d:?}"
        );
    }
}

#[test]
fn rule12_tran_version_warn_fixture() {
    let path = fixtures_dir().join("tran_version_warn.ags");
    let bytes = std::fs::read(&path).unwrap();
    let out = parse_bytes(&bytes);
    let r = Registry::standard();
    let d = validate(&out.file, &r);
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-STRUCT-004"),
        "tran_version_warn.ags should fire AGS-STRUCT-004: {d:?}"
    );
}

// ── py-ags4 Rule 13a: ABBR codelist (PA fields) ───────────────────────────────

#[test]
fn rule13a_abbr_valid_fixture_passes() {
    let path = fixtures_dir().join("abbr_codelist_valid.ags");
    let bytes = std::fs::read(&path).unwrap();
    let out = parse_bytes(&bytes);
    let r = Registry::standard();
    let d = validate(&out.file, &r);
    let abbr_errors: Vec<_> = d.iter().filter(|x| x.rule_id == "AGS-ABBR-001").collect();
    assert!(
        abbr_errors.is_empty(),
        "valid ABBR fixture should not fire AGS-ABBR-001: {abbr_errors:?}"
    );
}

#[test]
fn rule13a_abbr_invalid_fixture_fires() {
    let path = fixtures_dir().join("abbr_codelist_invalid.ags");
    let bytes = std::fs::read(&path).unwrap();
    let out = parse_bytes(&bytes);
    let r = Registry::standard();
    let d = validate(&out.file, &r);
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-ABBR-001"),
        "invalid ABBR fixture should fire AGS-ABBR-001: {d:?}"
    );
}

#[test]
fn rule13a_abbr_no_group_silently_skipped() {
    // Without an ABBR group, PA values are not checked.
    let input = r#""GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_LEG"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH1","ANY_CODE"
"#;
    let d = check(input);
    assert!(
        !d.iter().any(|x| x.rule_id == "AGS-ABBR-001"),
        "no ABBR group — should not check: {d:?}"
    );
}

// ── py-ags4 Rule 16: key uniqueness ───────────────────────────────────────────

#[test]
fn rule16_duplicate_loca_id_flagged() {
    let path = fixtures_dir().join("key_dup_loca.ags");
    let bytes = std::fs::read(&path).unwrap();
    let out = parse_bytes(&bytes);
    let r = Registry::standard();
    let d = validate(&out.file, &r);
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-KEY-001"),
        "key_dup_loca.ags should fire AGS-KEY-001: {d:?}"
    );
}

#[test]
fn rule16_unique_loca_ids_pass() {
    let input = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","X"
"DATA","BH01","CP"
"DATA","BH02","TP"
"DATA","BH03","TP"
"#;
    let d = check(input);
    assert!(
        !d.iter().any(|x| x.rule_id == "AGS-KEY-001"),
        "unique LOCA_IDs should not fire: {d:?}"
    );
}

// ── py-ags4 Rule 17: LOCA_ID cross-references ─────────────────────────────────

#[test]
fn rule17_geol_orphan_flagged() {
    let d = check(
        r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","GHOST","0.00","1.00"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-XREF-001"),
        "orphan GEOL: {d:?}"
    );
}

#[test]
fn rule17_samp_orphan_flagged() {
    let d = check(
        r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_ID","SAMP_TYPE"
"UNIT","","",""
"TYPE","ID","ID","PA"
"DATA","GHOST","S1","B"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-XREF-002"),
        "orphan SAMP: {d:?}"
    );
}

#[test]
fn rule17_ispt_orphan_flagged() {
    let d = check(
        r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL"
"UNIT","","m",""
"TYPE","ID","2DP","XN"
"DATA","GHOST","1.00","15"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-XREF-003"),
        "orphan ISPT: {d:?}"
    );
}

#[test]
fn rule17_wstk_orphan_flagged() {
    let d = check(
        r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","WSTK"
"HEADING","LOCA_ID","WSTK_DPTH"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","GHOST","3.50"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-XREF-004"),
        "orphan WSTK: {d:?}"
    );
}

#[test]
fn rule17_hole_orphan_flagged() {
    let d = check(
        r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","HOLE"
"HEADING","LOCA_ID","HOLE_DPTH"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","GHOST","5.00"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-XREF-005"),
        "orphan HOLE: {d:?}"
    );
}

#[test]
fn rule17_xref_multi_invalid_fixture_fires_all() {
    let path = fixtures_dir().join("xref_multi_invalid.ags");
    let bytes = std::fs::read(&path).unwrap();
    let out = parse_bytes(&bytes);
    let r = Registry::standard();
    let d = validate(&out.file, &r);
    let ids: Vec<_> = d.iter().map(|x| x.rule_id.as_str()).collect();
    assert!(ids.contains(&"AGS-XREF-003"), "ISPT xref: {d:?}");
    assert!(ids.contains(&"AGS-XREF-004"), "WSTK xref: {d:?}");
    assert!(ids.contains(&"AGS-XREF-005"), "HOLE xref: {d:?}");
}

// ── py-ags4 Rule 18: required headings ────────────────────────────────────────

#[test]
fn rule18_required_heading_missing_flagged() {
    let d = check(
        r#""GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","BH1","0.00"
"#,
    );
    // GEOL_BASE and GEOL_DESC are required per dict
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-DICT-001"),
        "missing required GEOL heading: {d:?}"
    );
}

// ── py-ags4 Rule 19: numeric field validation ─────────────────────────────────

#[test]
fn rule19_non_numeric_in_dp_column_flagged() {
    let d = check(
        r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","BH01","not_a_number"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-TYPE-002"),
        "non-numeric in 2DP: {d:?}"
    );
}

#[test]
fn rule19_bad_yn_flagged() {
    let d = check(
        r#""GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL","ISPT_REJ"
"UNIT","","m","","YN"
"TYPE","ID","2DP","0DP","YN"
"DATA","BH01","1.00","10","MAYBE"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-TYPE-002"),
        "bad YN: {d:?}"
    );
}

// ── py-ags4 Rule 20: date/time field validation ───────────────────────────────

#[test]
fn rule20_bad_date_flagged() {
    let d = check(
        r#""GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_TOP","SAMP_REF","SAMP_DATE"
"UNIT","","m","","yyyy-mm-dd"
"TYPE","ID","2DP","ID","DT"
"DATA","BH01","1.00","S1","01/01/2024"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-TYPE-002"),
        "bad date format: {d:?}"
    );
}

#[test]
fn rule20_iso_date_accepted() {
    let d = check(
        r#""GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_TOP","SAMP_REF","SAMP_DATE"
"UNIT","","m","","yyyy-mm-dd"
"TYPE","ID","2DP","ID","DT"
"DATA","BH01","1.00","S1","2024-01-15"
"#,
    );
    assert!(
        !d.iter().any(|x| x.rule_id == "AGS-TYPE-002"),
        "ISO date should pass: {d:?}"
    );
}

// ── Additional: depth unit validation ─────────────────────────────────────────

#[test]
fn depth_heading_non_metric_warned() {
    let d = check(
        r#""GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","ft","ft",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH1","0.00","5.00","Sand"
"#,
    );
    assert!(
        d.iter().any(|x| x.rule_id == "AGS-DICT-002"),
        "non-metric depth heading: {d:?}"
    );
}

// ── Additional: AGS-FMT-001 trailing whitespace ───────────────────────────────

#[test]
fn trailing_whitespace_detected_and_fixable() {
    let input =
        "\"GROUP\",\"PROJ\"\r\n\"HEADING\",\"PROJ_ID\"\r\n\"UNIT\",\"\"\r\n\"TYPE\",\"ID\"\r\n\"DATA\",\"P1   \"\r\n";
    let parsed = parse_str(input);
    let r = Registry::standard();
    let d = validate(&parsed.file, &r);
    let fmt = d.iter().find(|x| x.rule_id == "AGS-FMT-001");
    assert!(fmt.is_some(), "should fire AGS-FMT-001");
    assert_eq!(fmt.unwrap().fix_id.as_deref(), Some("normalize-whitespace"));
}

// ── Short-row fixture round-trip ──────────────────────────────────────────────

#[test]
fn short_row_fixture_warns_and_pads() {
    let path = fixtures_dir().join("short_row.ags");
    let bytes = std::fs::read(&path).unwrap();
    let out = parse_bytes(&bytes);
    // Should warn about short row
    assert!(
        out.diagnostics
            .iter()
            .any(|d| d.rule_id == "AGS-DATA-SHORT"),
        "short_row.ags should produce AGS-DATA-SHORT: {:?}",
        out.diagnostics
    );
    // But the row should still be present with nulls for missing cols
    let loca = out.file.group("LOCA").unwrap();
    assert_eq!(loca.rows.len(), 1);
    assert!(
        loca.rows[0].get("LOCA_NATN").unwrap().is_null(),
        "missing columns should be null-padded"
    );
}

// ── ABBR group: valid file has no spurious errors ─────────────────────────────

#[test]
fn abbr_group_self_referential_not_flagged() {
    // ABBR group itself should not cause its own PA fields to be checked.
    let input = r#""GROUP","ABBR"
"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"
"UNIT","","",""
"TYPE","X","X","X"
"DATA","LOCA_TYPE","CP","Cable percussion"
"DATA","LOCA_TYPE","TP","Trial pit"
"#;
    let d = check(input);
    assert!(
        !d.iter().any(|x| x.rule_id == "AGS-ABBR-001"),
        "ABBR self-check should not fire: {d:?}"
    );
}

// ── Overall: clean fixtures produce no errors ─────────────────────────────────

#[test]
fn minimal_valid_fixture_has_no_errors() {
    let path = fixtures_dir().join("minimal_valid.ags");
    let bytes = std::fs::read(&path).unwrap();
    let out = parse_bytes(&bytes);
    let r = Registry::standard();
    let d = validate(&out.file, &r);
    let errors: Vec<_> = d.iter().filter(|x| x.severity == Severity::Error).collect();
    assert!(errors.is_empty(), "minimal_valid.ags errors: {errors:?}");
}

#[test]
fn abbr_valid_fixture_has_no_errors() {
    let path = fixtures_dir().join("abbr_codelist_valid.ags");
    let bytes = std::fs::read(&path).unwrap();
    let out = parse_bytes(&bytes);
    let r = Registry::standard();
    let d = validate(&out.file, &r);
    let errors: Vec<_> = d.iter().filter(|x| x.severity == Severity::Error).collect();
    assert!(
        errors.is_empty(),
        "abbr_codelist_valid.ags errors: {errors:?}"
    );
}
