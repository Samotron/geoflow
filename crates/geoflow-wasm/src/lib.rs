use geoflow_core::{ags, describe, diff, diggs, dsl, fix, validate, Registry};
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

/// Validate an AGS file with a custom YAML rule pack on top of built-in rules.
/// Returns a JSON array of diagnostics on success, or `{"error":"..."}` if the
/// pack is malformed or evaluation fails.
#[wasm_bindgen]
pub fn validate_ags_with_rules(bytes: &[u8], rules_yaml: &str) -> String {
    let pack = match dsl::RulePack::parse(rules_yaml).and_then(|p| p.into_loaded()) {
        Ok(loaded) => loaded,
        Err(e) => return serde_json::json!({"error": e.to_string()}).to_string(),
    };
    let parsed = ags::parse_bytes(bytes);
    let registry = Registry::standard();
    let mut diagnostics = parsed.diagnostics;
    diagnostics.extend(validate::validate(&parsed.file, &registry));
    match dsl::evaluate(&parsed.file, &pack) {
        Ok(diags) => {
            diagnostics.extend(diags);
            serde_json::to_string(&diagnostics).unwrap_or_else(|e| format!("[{{\"error\":\"{e}\"}}]"))
        }
        Err(e) => serde_json::json!({"error": format!("Evaluation error: {e}")}).to_string(),
    }
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
    serde_json::to_string(&result.to_summary()).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
}

/// Return all group row data as a single JSON object `{ "GROUP": [rows], … }`.
/// Useful for loading the entire file into the browser in one call so that
/// cross-group ontology searches can be done without repeated round-trips.
#[wasm_bindgen]
pub fn get_all_groups_data(bytes: &[u8]) -> String {
    let file = ags::parse_bytes(bytes).file;
    let mut obj = serde_json::Map::new();
    for (name, group) in &file.groups {
        obj.insert(
            name.clone(),
            serde_json::to_value(&group.rows).unwrap_or(serde_json::Value::Array(vec![])),
        );
    }
    serde_json::to_string(&obj).unwrap_or_default()
}

/// Return heading definitions for all groups as `{ "GROUP": [{name, unit, is_id}] }`.
/// `is_id` is true when the AGS data type is ID, identifying key/foreign-key columns.
#[wasm_bindgen]
pub fn get_all_groups_meta(bytes: &[u8]) -> String {
    use geoflow_core::model::AgsType;
    let file = ags::parse_bytes(bytes).file;
    let mut obj = serde_json::Map::new();
    for (name, group) in &file.groups {
        let headings: Vec<serde_json::Value> = group
            .headings
            .iter()
            .map(|h| {
                serde_json::json!({
                    "name": h.name,
                    "unit": h.unit,
                    "is_id": matches!(h.data_type, AgsType::ID),
                })
            })
            .collect();
        obj.insert(name.clone(), serde_json::Value::Array(headings));
    }
    serde_json::to_string(&obj).unwrap_or_default()
}

/// Get all rows of a named AGS group as a JSON array of objects.
/// Each row is `{ "HEADING": value }` where values are numbers, strings,
/// booleans, or nulls as determined by the AGS type.  Returns `[]` if the
/// group does not exist.
#[wasm_bindgen]
pub fn get_group_rows(bytes: &[u8], group: &str) -> String {
    let file = ags::parse_bytes(bytes).file;
    match file.group(group) {
        Some(g) => serde_json::to_string(&g.rows).unwrap_or_default(),
        None => "[]".to_string(),
    }
}

/// Export all groups to CSV. Returns a JSON object {group: csv_text}.
#[wasm_bindgen]
pub fn export_csv(bytes: &[u8]) -> String {
    let file = ags::parse_bytes(bytes).file;
    let csvs = geoflow_core::export::to_csv(&file);
    serde_json::to_string(&csvs).unwrap_or_default()
}

/// Parse a single free-text soil description. Returns a JSON object with
/// structured fields (material_type, consistency, density, colours, etc.).
#[wasm_bindgen]
pub fn parse_description(text: &str) -> String {
    let d = describe::parse_description(text);
    serde_json::to_string(&d).unwrap_or_default()
}

/// Parse GEOL_DESC for every GEOL row in an AGS file.
/// Returns a JSON array of enriched row objects.
#[wasm_bindgen]
pub fn enhance_ags(bytes: &[u8]) -> String {
    let file = ags::parse_bytes(bytes).file;
    let rows = describe::enhance_geol(&file);
    serde_json::to_string(&rows).unwrap_or_default()
}
