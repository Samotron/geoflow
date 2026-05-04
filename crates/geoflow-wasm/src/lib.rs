use geoflow_core::{ags, diff, diggs, fix, validate, Registry};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Validate an AGS file. Returns a JSON array of diagnostic objects.
#[wasm_bindgen]
pub fn validate_ags(bytes: &[u8]) -> String {
    let parsed = ags::parse_bytes(bytes);
    let registry = Registry::standard();
    let mut diagnostics = parsed.diagnostics;
    diagnostics.extend(validate::validate(&parsed.file, &registry));
    serde_json::to_string(&diagnostics).unwrap_or_else(|e| format!("[{{\"error\":\"{e}\"}}]"))
}

/// Apply safe auto-fixes to an AGS file. Returns the fixed AGS bytes.
#[wasm_bindgen]
pub fn fix_ags(bytes: &[u8]) -> Vec<u8> {
    let parsed = ags::parse_bytes(bytes);
    let mut file = parsed.file;
    let fixer = fix::Fixer::standard();
    fixer.apply_all(&mut file);
    ags::serialize(&file).into_bytes()
}

/// Convert an AGS file to DIGGS XML. Returns the XML string.
#[wasm_bindgen]
pub fn convert_to_diggs(bytes: &[u8]) -> String {
    let file = ags::parse_bytes(bytes).file;
    diggs::write(&file).map(|(xml, _)| xml).unwrap_or_default()
}

/// List all location IDs. Returns a JSON array of `{id, depth, easting, northing}`.
#[wasm_bindgen]
pub fn list_locations(bytes: &[u8]) -> String {
    let file = ags::parse_bytes(bytes).file;
    let locs: Vec<_> = file
        .group("LOCA")
        .map(|g| {
            g.rows
                .iter()
                .filter_map(|r| {
                    let id = r.get("LOCA_ID")?.as_text()?.to_string();
                    let depth = r.get("LOCA_FDEP").and_then(|v| v.as_number());
                    let easting = r.get("LOCA_NATE").and_then(|v| v.as_number());
                    let northing = r.get("LOCA_NATN").and_then(|v| v.as_number());
                    Some(serde_json::json!({
                        "id": id,
                        "depth": depth,
                        "easting": easting,
                        "northing": northing,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    serde_json::to_string(&locs).unwrap_or_default()
}

/// Render the SVG strip log for one borehole. Returns an SVG string.
#[wasm_bindgen]
pub fn render_borehole_svg(bytes: &[u8], loca_id: &str) -> String {
    let file = ags::parse_bytes(bytes).file;
    let explorer = geoflow_core::explorer::Explorer::new();
    explorer
        .render_borehole_svg(&file, loca_id)
        .unwrap_or_default()
}

/// Parse an AGS file and return a JSON summary (groups, rows, locations, version).
#[wasm_bindgen]
pub fn ags_info(bytes: &[u8]) -> String {
    let parsed = ags::parse_bytes(bytes);
    let f = &parsed.file;
    let total_rows: usize = f.groups.values().map(|g| g.rows.len()).sum();
    let groups: Vec<&str> = f.groups.keys().map(|s| s.as_str()).collect();
    let locations = f.group("LOCA").map(|g| g.rows.len()).unwrap_or(0);
    let project = f
        .group("PROJ")
        .and_then(|g| g.rows.first())
        .and_then(|r| r.get("PROJ_NAME"))
        .and_then(|v| v.as_text())
        .unwrap_or("")
        .to_string();

    serde_json::json!({
        "ags_version": f.ags_version,
        "groups": groups,
        "group_count": groups.len(),
        "total_rows": total_rows,
        "locations": locations,
        "project": project,
    })
    .to_string()
}

/// Compare two AGS files. Returns a JSON diff summary.
#[wasm_bindgen]
pub fn diff_ags(bytes_a: &[u8], bytes_b: &[u8]) -> String {
    let file_a = ags::parse_bytes(bytes_a).file;
    let file_b = ags::parse_bytes(bytes_b).file;
    let result = diff::diff(&file_a, &file_b);
    serde_json::to_string(&result.to_summary())
        .unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
}

/// Export all groups to CSV. Returns a JSON object {group: csv_text}.
#[wasm_bindgen]
pub fn export_csv(bytes: &[u8]) -> String {
    let file = ags::parse_bytes(bytes).file;
    let csvs = geoflow_core::export::to_csv(&file);
    serde_json::to_string(&csvs).unwrap_or_default()
}
