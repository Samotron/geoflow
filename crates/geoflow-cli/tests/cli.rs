use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tempfile::tempdir;

#[test]
fn cli_info_works() {
    let mut cmd = Command::cargo_bin("geoflow").unwrap();
    let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","Demo"

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"

"GROUP","GEOL"
"HEADING","GEOL_TOP","GEOL_BASE"
"UNIT","m","m"
"TYPE","2DP","2DP"
"DATA","0.00","3.50"
"DATA","3.50","7.00"
"#;
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test.ags");
    fs::write(&file_path, ags).unwrap();

    cmd.arg("info").arg(&file_path);
    cmd.assert()
        .success()
        .stdout(predicate::str::contains("ags version: 4.1"))
        .stdout(predicate::str::contains("groups: 3"))
        .stdout(predicate::str::contains("rows: 4"))
        .stdout(predicate::str::contains("project: Demo"))
        .stdout(predicate::str::contains("depth range: 0..7 m"));
}

#[test]
fn cli_validate_flags_errors() {
    let mut cmd = Command::cargo_bin("geoflow").unwrap();
    // Missing required groups
    let ags = r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH1"
"#;
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test.ags");
    fs::write(&file_path, ags).unwrap();

    cmd.arg("validate").arg(&file_path);
    cmd.assert()
        .failure() // Should exit non-zero due to errors
        .stdout(predicate::str::contains("AGS-STRUCT-001")); // Missing PROJ
}

#[test]
fn cli_fix_works() {
    let mut cmd = Command::cargo_bin("geoflow").unwrap();
    let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1  "
"#; // Trailing whitespace
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test.ags");
    fs::write(&file_path, ags).unwrap();

    cmd.arg("fix").arg(&file_path).arg("--write");
    cmd.assert()
        .success()
        .stdout(predicate::str::contains("applied fixes"));

    let fixed = fs::read_to_string(&file_path).unwrap();
    assert!(fixed.contains(r#""P1""#));
    assert!(!fixed.contains(r#""P1  ""#));
}

#[test]
fn cli_fix_dry_run_prints_diff_without_writing() {
    let mut cmd = Command::cargo_bin("geoflow").unwrap();
    let ags = "\"GROUP\",\"PROJ\"\n\"HEADING\",\"PROJ_ID\"\n\"UNIT\",\"\"\n\"TYPE\",\"ID\"\n\"DATA\",\"P1  \"";
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test.ags");
    fs::write(&file_path, ags).unwrap();

    cmd.arg("fix").arg(&file_path).arg("--dry-run");
    cmd.assert()
        .success()
        .stdout(predicate::str::contains("--- "))
        .stdout(predicate::str::contains("+++ "))
        .stdout(predicate::str::contains("dry-run: no changes written"));

    let unchanged = fs::read_to_string(&file_path).unwrap();
    assert_eq!(unchanged, ags);
}

#[test]
fn cli_fix_rejects_write_and_dry_run_together() {
    let mut cmd = Command::cargo_bin("geoflow").unwrap();
    let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"
"#;
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test.ags");
    fs::write(&file_path, ags).unwrap();

    cmd.arg("fix")
        .arg(&file_path)
        .arg("--write")
        .arg("--dry-run");
    cmd.assert()
        .failure()
        .stderr(predicate::str::contains("--dry-run"));
}

#[test]
fn cli_fix_can_apply_rule_pack_delete_row() {
    let mut cmd = Command::cargo_bin("geoflow").unwrap();
    let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"

"GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH1"

"GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_ID"
"UNIT","",""
"TYPE","ID","ID"
"DATA","BH1","S1"
"DATA","BHX","S2"
"#;
    let rules = r#"
version: 1
rules:
  - id: DROP-ORPHANS
    severity: warning
    when: "group == 'SAMP'"
    expr: "exists_in('LOCA', 'LOCA_ID', row.LOCA_ID)"
    message: "drop orphan sample"
    fix:
      - op: deleterow
"#;
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test.ags");
    let rules_path = dir.path().join("rules.yml");
    fs::write(&file_path, ags).unwrap();
    fs::write(&rules_path, rules).unwrap();

    cmd.arg("fix")
        .arg(&file_path)
        .arg("--write")
        .arg("--rules")
        .arg(&rules_path);
    cmd.assert()
        .success()
        .stdout(predicate::str::contains("DROP-ORPHANS"));

    let fixed = fs::read_to_string(&file_path).unwrap();
    assert!(fixed.contains("\"BH1\",\"S1\""));
    assert!(!fixed.contains("\"BHX\",\"S2\""));
}

#[test]
fn cli_rules_list() {
    let mut cmd = Command::cargo_bin("geoflow").unwrap();
    cmd.arg("rules").arg("list");
    cmd.assert()
        .success()
        .stdout(predicate::str::contains("AGS-STRUCT-001"))
        .stdout(predicate::str::contains("PACK ice:mini@0.1"));
}

#[test]
fn cli_validate_accepts_builtin_rule_pack_reference() {
    let mut cmd = Command::cargo_bin("geoflow").unwrap();
    let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH1","100","200"

"GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_ID","SAMP_TYPE"
"UNIT","","",""
"TYPE","ID","ID","PA"
"DATA","BH1","S1","ZZ"
"DATA","BHX","S2","B"
"#;
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test.ags");
    fs::write(&file_path, ags).unwrap();

    cmd.arg("validate")
        .arg(&file_path)
        .arg("--rules")
        .arg("ice:mini@0.1");
    cmd.assert()
        .failure()
        .stdout(predicate::str::contains("SAMP-001"))
        .stdout(predicate::str::contains("SAMP-002"));
}

#[test]
fn cli_explore_export() {
    let mut cmd = Command::cargo_bin("geoflow").unwrap();
    let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"
"#;
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test.ags");
    fs::write(&file_path, ags).unwrap();
    let out_dir = dir.path().join("site");

    cmd.arg("explore")
        .arg(&file_path)
        .arg("--out")
        .arg(&out_dir);
    cmd.assert()
        .success()
        .stdout(predicate::str::contains("exported static site"));

    assert!(out_dir.join("index.html").exists());
    assert!(out_dir.join("validation.html").exists());
    assert!(out_dir.join("group/PROJ.html").exists());
    let exported = fs::read_to_string(out_dir.join("group/PROJ.html")).unwrap();
    assert!(exported.contains("Filter rows"));
    assert!(exported.contains("sortTable"));
}

#[test]
fn cli_validate_example_rule_pack_matches_negative_fixture() {
    let mut cmd = Command::cargo_bin("geoflow").unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let fixture = root.join("tests/fixtures/ags/ice_mini_invalid.ags");
    let rules = root.join("examples/rules/ice_mini.yml");

    cmd.arg("validate")
        .arg(&fixture)
        .arg("--rules")
        .arg(&rules)
        .arg("--format")
        .arg("json");

    cmd.assert()
        .failure()
        .stdout(predicate::str::contains("\"rule_id\": \"SAMP-001\""))
        .stdout(predicate::str::contains("\"rule_id\": \"SAMP-002\""))
        .stdout(predicate::str::contains("\"rule_id\": \"GEOL-001\""));
}

#[test]
fn cli_convert_round_trips_basic_diggs_subset() {
    let mut to_diggs = Command::cargo_bin("geoflow").unwrap();
    let mut to_ags = Command::cargo_bin("geoflow").unwrap();
    let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"
"DATA","BH02"

"GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_ID","SAMP_TYPE"
"UNIT","","",""
"TYPE","ID","ID","PA"
"DATA","BH01","S1","B"

"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL"
"UNIT","","m",""
"TYPE","ID","2DP","XN"
"DATA","BH01","2.00","12"

"GROUP","WSTK"
"HEADING","LOCA_ID","WSTK_DPTH"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","BH01","3.50"
"#;
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.ags");
    let diggs = dir.path().join("out.diggs");
    let roundtrip = dir.path().join("roundtrip.ags");
    fs::write(&input, ags).unwrap();

    to_diggs
        .arg("convert")
        .arg(&input)
        .arg(&diggs)
        .arg("--to")
        .arg("diggs");
    to_diggs.assert().success();

    let xml = fs::read_to_string(&diggs).unwrap();
    assert!(xml.contains("<Project>"));
    assert!(xml.contains("<SamplingLocation>"));

    to_ags
        .arg("convert")
        .arg(&diggs)
        .arg(&roundtrip)
        .arg("--to")
        .arg("ags");
    to_ags.assert().success();

    let reparsed = fs::read_to_string(&roundtrip).unwrap();
    assert!(reparsed.contains("\"GROUP\",\"PROJ\""));
    assert!(reparsed.contains("\"DATA\",\"P1\""));
    assert!(reparsed.contains("\"GROUP\",\"LOCA\""));
    assert!(reparsed.contains("\"DATA\",\"BH01\""));
    assert!(reparsed.contains("\"DATA\",\"BH02\""));
    assert!(reparsed.contains("\"GROUP\",\"SAMP\""));
    assert!(reparsed.contains("\"DATA\",\"BH01\",\"S1\",\"B\""));
    assert!(reparsed.contains("\"GROUP\",\"ISPT\""));
    assert!(reparsed.contains("\"DATA\",\"BH01\",\"2\",\"12\""));
    assert!(reparsed.contains("\"GROUP\",\"WSTK\""));
    assert!(reparsed.contains("\"DATA\",\"BH01\",\"3.5\""));
}

#[test]
fn cli_convert_writes_lossy_report_for_unmapped_content() {
    let mut cmd = Command::cargo_bin("geoflow").unwrap();
    let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME","PROJ_LOC"
"UNIT","","",""
"TYPE","ID","X","X"
"DATA","P1","Demo","Somewhere"

"GROUP","CBRG"
"HEADING","CBRG_ID","CBRG_VAL"
"UNIT","",""
"TYPE","ID","XN"
"DATA","C1","100"
"#;
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.ags");
    let output = dir.path().join("out.diggs");
    let report = dir.path().join("report.json");
    fs::write(&input, ags).unwrap();

    cmd.arg("convert")
        .arg(&input)
        .arg(&output)
        .arg("--to")
        .arg("diggs")
        .arg("--report")
        .arg(&report);
    cmd.assert().success();

    let json: Value = serde_json::from_str(&fs::read_to_string(&report).unwrap()).unwrap();
    // CBRG has no native DIGGS mapping — it round-trips via DataGroup.
    let generic_groups = json
        .get("generic_groups")
        .and_then(Value::as_array)
        .unwrap();
    assert!(generic_groups.iter().any(|v| v.as_str() == Some("CBRG")));

    let proj_fields = json
        .get("unmapped_fields")
        .and_then(|v| v.get("PROJ"))
        .and_then(Value::as_array)
        .unwrap();
    assert!(proj_fields.iter().any(|v| v.as_str() == Some("PROJ_LOC")));
}
