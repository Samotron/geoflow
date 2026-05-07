//! Round-trip tests: parse → serialize → parse must yield an equal model.
//!
//! Driven both by hand-written property strategies and by every `.ags`
//! file under `tests/fixtures/ags/` at the workspace root.

use std::path::PathBuf;

use geoflow_core::ags::{parse_bytes, parse_str, serialize};
use geoflow_core::Severity;
use proptest::prelude::*;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ags")
}

#[test]
fn fixtures_round_trip() {
    let dir = fixtures_dir();
    let mut count = 0;
    for entry in std::fs::read_dir(&dir).expect("read fixtures dir") {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("ags") {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap();
        let parsed = parse_bytes(&bytes);
        // AGS 3 fixtures are rejected with a dedicated diagnostic; skip them here.
        if parsed
            .diagnostics
            .iter()
            .any(|d| d.rule_id == "AGS-V3-UNSUPPORTED")
        {
            continue;
        }
        // Fixtures may contain intentional warnings (e.g. AGS-DATA-SHORT for
        // the short_row fixture); only hard errors abort the round-trip check.
        let errors: Vec<_> = parsed
            .diagnostics
            .iter()
            .filter(|d| d.severity == geoflow_core::Severity::Error)
            .collect();
        assert!(
            errors.is_empty(),
            "unexpected errors in {path:?}: {:?}",
            errors
        );
        let serialized = serialize(&parsed.file);
        let reparsed = parse_str(&serialized);
        assert!(
            reparsed.diagnostics.is_empty(),
            "diagnostics on reparse of {path:?}: {:?}",
            reparsed.diagnostics
        );
        assert_eq!(
            parsed.file, reparsed.file,
            "round-trip mismatch in {path:?}"
        );
        count += 1;
    }
    assert!(count > 0, "no fixtures found in {:?}", dir);
}

/// M6.5 — applying the standard fixer to a fixture with known fixable issues
/// then running the validator must produce no errors; AGS-FMT-001 must fire
/// before the fix and be absent after.
#[test]
fn fix_then_validate_is_clean() {
    let path = fixtures_dir().join("fixable.ags");
    let bytes = std::fs::read(&path).unwrap();
    let parsed = parse_bytes(&bytes);
    let mut file = parsed.file;

    let registry = geoflow_core::validate::Registry::standard();

    // AGS-FMT-001 must fire on the unfixed file.
    let before = geoflow_core::validate::validate(&file, &registry);
    assert!(
        before.iter().any(|d| d.rule_id == "AGS-FMT-001"),
        "expected AGS-FMT-001 before fix, got: {before:?}"
    );

    let fixer = geoflow_core::fix::Fixer::standard();
    let applied = fixer.apply_all(&mut file);
    assert!(!applied.is_empty(), "expected at least one fix to apply");

    let after = geoflow_core::validate::validate(&file, &registry);
    assert!(
        !after.iter().any(|d| d.rule_id == "AGS-FMT-001"),
        "AGS-FMT-001 should be absent after fix"
    );
    let errors: Vec<_> = after
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    assert!(errors.is_empty(), "errors after fix: {errors:?}");
}

// Property strategies for tiny synthetic AGS files.

fn heading_name() -> impl Strategy<Value = String> {
    "[A-Z]{3,4}_[A-Z]{2,4}".prop_map(|s| s)
}

fn safe_value() -> impl Strategy<Value = String> {
    // Values without commas/quotes/CR/LF — those are exercised by the
    // hand-written tokenizer tests instead. The point of this strategy
    // is to exercise structural round-trip across many heading/row
    // combinations.
    "[A-Za-z0-9 .-]{0,12}"
}

fn group_strategy() -> impl Strategy<Value = (String, Vec<String>, Vec<Vec<String>>)> {
    ("[A-Z]{3,4}", prop::collection::vec(heading_name(), 1..6)).prop_flat_map(|(name, headings)| {
        let n = headings.len();
        let rows = prop::collection::vec(prop::collection::vec(safe_value(), n..=n), 0..6);
        (Just(name), Just(headings), rows)
    })
}

fn render(group: &(String, Vec<String>, Vec<Vec<String>>)) -> String {
    let (name, headings, rows) = group;
    let mut s = String::new();
    s.push_str(&format!("\"GROUP\",\"{name}\"\r\n"));
    s.push_str("\"HEADING\"");
    for h in headings {
        s.push_str(&format!(",\"{h}\""));
    }
    s.push_str("\r\n\"UNIT\"");
    for _ in headings {
        s.push_str(",\"\"");
    }
    s.push_str("\r\n\"TYPE\"");
    for _ in headings {
        s.push_str(",\"X\"");
    }
    s.push_str("\r\n");
    for row in rows {
        s.push_str("\"DATA\"");
        for v in row {
            s.push_str(&format!(",\"{v}\""));
        }
        s.push_str("\r\n");
    }
    s
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn random_groups_round_trip(groups in prop::collection::vec(group_strategy(), 1..4)) {
        // Force unique group names so the IndexMap insert order is stable.
        let mut seen = std::collections::HashSet::new();
        let groups: Vec<_> = groups
            .into_iter()
            .filter(|(n, _, _)| seen.insert(n.clone()))
            .collect();
        prop_assume!(!groups.is_empty());

        let text = groups.iter().map(render).collect::<Vec<_>>().join("\r\n");
        let parsed = parse_str(&text);
        prop_assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let serialized = serialize(&parsed.file);
        let reparsed = parse_str(&serialized);
        prop_assert!(reparsed.diagnostics.is_empty(), "{:?}", reparsed.diagnostics);
        prop_assert_eq!(parsed.file, reparsed.file);
    }
}
