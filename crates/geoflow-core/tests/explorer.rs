//! M7.9 — structural snapshot tests for Explorer HTML pages.
//!
//! These tests verify the rendered HTML contains expected structural
//! markers (headings, tables, SVG elements, navigation links) rather
//! than doing full string comparisons that would be brittle to cosmetic
//! template changes.

use std::path::PathBuf;

use geoflow_core::ags::parse_bytes;
use geoflow_core::explorer::Explorer;

fn minimal_valid_ags() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ags")
        .join("minimal_valid.ags")
}

fn load_fixture() -> geoflow_core::model::AgsFile {
    let bytes = std::fs::read(minimal_valid_ags()).expect("read minimal_valid.ags");
    parse_bytes(&bytes).file
}

#[test]
fn overview_page_contains_group_list_and_nav() {
    let file = load_fixture();
    let exp = Explorer::new();
    let html = exp.render_overview(&file).expect("render overview");

    assert!(html.contains("<table"), "expected table element");
    assert!(html.contains("PROJ"), "expected PROJ in overview");
    assert!(html.contains("LOCA"), "expected LOCA in overview");
    assert!(html.contains("GEOL"), "expected GEOL in overview");
    assert!(
        html.contains("/group/LOCA.html"),
        "expected LOCA group link"
    );
    assert!(
        html.contains("/validation.html"),
        "expected validation nav link"
    );
}

#[test]
fn group_page_renders_headings_and_data_rows() {
    let file = load_fixture();
    let exp = Explorer::new();
    let html = exp.render_group(&file, "LOCA").expect("render LOCA group");

    assert!(html.contains("LOCA_ID"), "expected LOCA_ID heading");
    assert!(html.contains("LOCA_NATE"), "expected LOCA_NATE heading");
    assert!(html.contains("BH01"), "expected BH01 data row");
    assert!(html.contains("BH02"), "expected BH02 data row");
    assert!(html.contains("sortTable"), "expected sort JS");
    // M7.6 toggle
    assert!(html.contains("view-diggs"), "expected DIGGS toggle button");
    assert!(html.contains("diggs-xml"), "expected DIGGS XML section");
    // DIGGS XML is embedded — root element is <Diggs or starts with <?xml
    assert!(
        html.contains("<Diggs") || html.contains("&lt;Diggs") || html.contains("<?xml"),
        "expected DIGGS XML content in page, got no DIGGS markers"
    );
}

#[test]
fn group_page_loca_links_to_boreholes() {
    let file = load_fixture();
    let exp = Explorer::new();
    let html = exp.render_group(&file, "LOCA").expect("render LOCA group");
    assert!(
        html.contains("/borehole/BH01.html"),
        "expected BH01 borehole link"
    );
}

#[test]
fn borehole_page_renders_svg_strip_log() {
    let file = load_fixture();
    let exp = Explorer::new();
    let html = exp.render_borehole(&file, "BH01").expect("render BH01");

    assert!(html.contains("<svg"), "expected SVG element");
    assert!(
        html.contains("Topsoil"),
        "expected Topsoil geology description"
    );
    assert!(
        html.contains("Sandy clay"),
        "expected Sandy clay geology description"
    );
    assert!(html.contains("BH01"), "expected LOCA_ID in borehole page");
}

#[test]
fn validation_page_renders_summary_table() {
    let file = load_fixture();
    let exp = Explorer::new();
    let html = exp
        .render_validation(&file, &[], &[], &[], None)
        .expect("render validation");

    assert!(html.contains("<table"), "expected table element");
    assert!(
        html.contains("Validation Report"),
        "expected Validation Report heading"
    );
    assert!(
        html.contains("severity-error") || html.contains("error"),
        "expected error severity class"
    );
}

#[test]
fn render_all_produces_expected_page_set() {
    let file = load_fixture();
    let exp = Explorer::new();
    let pages = exp.render_all(&file).expect("render all");

    let paths: Vec<&str> = pages.iter().map(|(p, _)| p.as_str()).collect();
    assert!(paths.contains(&"index.html"), "missing index.html");
    assert!(
        paths.contains(&"validation.html"),
        "missing validation.html"
    );
    assert!(
        paths.contains(&"group/PROJ.html"),
        "missing group/PROJ.html"
    );
    assert!(
        paths.contains(&"group/LOCA.html"),
        "missing group/LOCA.html"
    );
    assert!(
        paths.contains(&"borehole/BH01.html"),
        "missing borehole/BH01.html"
    );
    assert!(
        paths.contains(&"borehole/BH02.html"),
        "missing borehole/BH02.html"
    );
}

#[test]
fn geol_group_page_shows_depth_columns() {
    let file = load_fixture();
    let exp = Explorer::new();
    let html = exp.render_group(&file, "GEOL").expect("render GEOL group");
    assert!(html.contains("GEOL_TOP"), "expected GEOL_TOP heading");
    assert!(html.contains("GEOL_BASE"), "expected GEOL_BASE heading");
    assert!(html.contains("GEOL_DESC"), "expected GEOL_DESC heading");
    // Numbers render from f64 so "1.5" not "1.50"
    assert!(html.contains("1.5"), "expected depth value 1.5");
}
