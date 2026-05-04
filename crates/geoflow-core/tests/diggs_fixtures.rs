use std::path::PathBuf;

use geoflow_core::diggs::read;

fn diggs_fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("diggs")
}

#[test]
fn minimal_subset_fixture_reads_expected_groups() {
    let path = diggs_fixtures_dir().join("minimal_subset.diggs");
    let bytes = std::fs::read(&path).expect("read DIGGS fixture");
    let file = read(&bytes).expect("parse DIGGS fixture");

    assert_eq!(
        file.group("PROJ")
            .unwrap()
            .rows
            .first()
            .and_then(|r| r.get("PROJ_ID"))
            .and_then(|v| v.as_text()),
        Some("P1")
    );
    assert!(file.group("LOCA").is_some());
    assert!(file.group("GEOL").is_some());
    assert!(file.group("SAMP").is_some());
    assert!(file.group("ISPT").is_some());
    assert!(file.group("WSTK").is_some());
}
