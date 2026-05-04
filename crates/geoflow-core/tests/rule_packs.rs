use std::path::{Path, PathBuf};

use geoflow_core::ags::parse_bytes;
use geoflow_core::dsl::{evaluate, RulePack};
use geoflow_core::Severity;
use serde::Deserialize;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn ags_fixtures_dir() -> PathBuf {
    workspace_root().join("tests").join("fixtures").join("ags")
}

fn example_rules_dir() -> PathBuf {
    workspace_root().join("examples").join("rules")
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct ExpectedDiagnostic {
    rule_id: String,
    severity: Severity,
}

fn load_fixture(path: &Path) -> geoflow_core::model::AgsFile {
    let bytes = std::fs::read(path).expect("read fixture");
    let parsed = parse_bytes(&bytes);
    assert!(
        parsed.diagnostics.is_empty(),
        "unexpected parser diagnostics in {:?}: {:?}",
        path,
        parsed.diagnostics
    );
    parsed.file
}

#[test]
fn ice_mini_example_pack_accepts_valid_fixture() {
    let fixture = ags_fixtures_dir().join("ice_mini_valid.ags");
    let rules = example_rules_dir().join("ice_mini.yml");
    let file = load_fixture(&fixture);
    let pack = RulePack::load(&rules).expect("load example pack");
    let diagnostics = evaluate(&file, &pack).expect("evaluate example pack");
    assert!(
        diagnostics.is_empty(),
        "unexpected diagnostics for {:?}: {:?}",
        fixture,
        diagnostics
    );
}

#[test]
fn ice_mini_example_pack_matches_negative_fixture_golden() {
    let fixture = ags_fixtures_dir().join("ice_mini_invalid.ags");
    let expected_path = ags_fixtures_dir().join("ice_mini_invalid.diagnostics.json");
    let rules = example_rules_dir().join("ice_mini.yml");
    let file = load_fixture(&fixture);
    let pack = RulePack::load(&rules).expect("load example pack");
    let diagnostics = evaluate(&file, &pack).expect("evaluate example pack");

    let mut actual: Vec<ExpectedDiagnostic> = diagnostics
        .into_iter()
        .map(|d| ExpectedDiagnostic {
            rule_id: d.rule_id,
            severity: d.severity,
        })
        .collect();
    actual.sort_by(|a, b| {
        a.rule_id
            .cmp(&b.rule_id)
            .then(a.severity.to_string().cmp(&b.severity.to_string()))
    });

    let mut expected: Vec<ExpectedDiagnostic> =
        serde_json::from_str(&std::fs::read_to_string(&expected_path).expect("read golden file"))
            .expect("parse golden diagnostics");
    expected.sort_by(|a, b| {
        a.rule_id
            .cmp(&b.rule_id)
            .then(a.severity.to_string().cmp(&b.severity.to_string()))
    });

    assert_eq!(actual, expected, "golden mismatch for {:?}", fixture);
}

#[test]
fn built_in_ice_pack_reference_matches_example_pack() {
    let fixture = ags_fixtures_dir().join("ice_mini_invalid.ags");
    let file = load_fixture(&fixture);
    let by_path = RulePack::load(example_rules_dir().join("ice_mini.yml")).expect("load path pack");
    let by_ref = RulePack::load_spec("ice:mini@0.1").expect("load built-in pack");

    let mut path_ids: Vec<_> = evaluate(&file, &by_path)
        .expect("evaluate path pack")
        .into_iter()
        .map(|d| (d.rule_id, d.severity))
        .collect();
    let mut ref_ids: Vec<_> = evaluate(&file, &by_ref)
        .expect("evaluate built-in pack")
        .into_iter()
        .map(|d| (d.rule_id, d.severity))
        .collect();
    path_ids.sort_by(|a, b| a.0.cmp(&b.0));
    ref_ids.sort_by(|a, b| a.0.cmp(&b.0));

    assert_eq!(path_ids, ref_ids);
}
