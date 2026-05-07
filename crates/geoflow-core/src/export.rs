//! Export AGS data to CSV, JSON, GeoJSON, and KML.

use crate::model::{AgsFile, AgsValue};
use indexmap::IndexMap;

/// Serialise every group in `file` to a map of `group_name → CSV text`.
///
/// Each CSV starts with a header row of heading names, then one data row per
/// AGS DATA row. Values are quoted when they contain commas, double-quotes,
/// or newlines.
pub fn to_csv(file: &AgsFile) -> IndexMap<String, String> {
    let mut result = IndexMap::new();
    for (group_name, group) in &file.groups {
        let mut out = String::new();
        let names: Vec<&str> = group.headings.iter().map(|h| h.name.as_str()).collect();

        // header
        for (i, n) in names.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&csv_field(n));
        }
        out.push('\n');

        // data rows
        for row in &group.rows {
            for (i, n) in names.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let cell = match row.get(*n) {
                    None | Some(AgsValue::Null) => String::new(),
                    Some(AgsValue::Number(f)) => format_number(*f),
                    Some(AgsValue::Bool(true)) => "Y".into(),
                    Some(AgsValue::Bool(false)) => "N".into(),
                    Some(AgsValue::Text(s) | AgsValue::Raw(s)) => s.clone(),
                };
                out.push_str(&csv_field(&cell));
            }
            out.push('\n');
        }

        result.insert(group_name.clone(), out);
    }
    result
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Serialise the file to a JSON value with structure:
/// `{"GROUP_NAME": [{"HEADING": value, ...}, ...], ...}`
pub fn to_json(file: &AgsFile) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    for (group_name, group) in &file.groups {
        let rows: Vec<serde_json::Value> = group
            .rows
            .iter()
            .map(|row| {
                let mut map = serde_json::Map::new();
                for heading in &group.headings {
                    let val = match row.get(&heading.name) {
                        None | Some(AgsValue::Null) => serde_json::Value::Null,
                        Some(AgsValue::Number(f)) => serde_json::Value::Number(
                            serde_json::Number::from_f64(*f).unwrap_or(serde_json::Number::from(0)),
                        ),
                        Some(AgsValue::Bool(b)) => serde_json::Value::Bool(*b),
                        Some(AgsValue::Text(s) | AgsValue::Raw(s)) => {
                            serde_json::Value::String(s.clone())
                        }
                    };
                    map.insert(heading.name.clone(), val);
                }
                serde_json::Value::Object(map)
            })
            .collect();
        obj.insert(group_name.clone(), serde_json::Value::Array(rows));
    }
    serde_json::Value::Object(obj)
}

fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Serialise borehole locations from the LOCA group as a GeoJSON FeatureCollection.
///
/// Each LOCA row becomes a `Feature` with a `Point` geometry (easting, northing
/// in whatever CRS the file uses) and all LOCA fields as properties.  If the
/// file contains a GEOL group, each feature also gets a `geol_count` property
/// with the number of lithology rows for that location.  Similarly `ispt_count`
/// from ISPT and `samp_count` from SAMP.
///
/// Returns `None` if the file has no LOCA group or if no LOCA row has
/// coordinate data (LOCA_NATE / LOCA_NATN).
pub fn to_geojson(file: &AgsFile) -> Option<serde_json::Value> {
    let loca = file.group("LOCA")?;

    // Pre-build per-LOCA_ID counts for related groups.
    let geol_counts = count_by_loca(file, "GEOL");
    let ispt_counts = count_by_loca(file, "ISPT");
    let samp_counts = count_by_loca(file, "SAMP");

    let mut features: Vec<serde_json::Value> = Vec::new();

    for row in &loca.rows {
        let easting = row.get("LOCA_NATE").and_then(|v| v.as_number());
        let northing = row.get("LOCA_NATN").and_then(|v| v.as_number());
        let (e, n) = match (easting, northing) {
            (Some(e), Some(n)) => (e, n),
            _ => continue,
        };

        // All LOCA fields as properties.
        let mut props = serde_json::Map::new();
        for heading in &loca.headings {
            let val = match row.get(&heading.name) {
                None | Some(AgsValue::Null) => serde_json::Value::Null,
                Some(AgsValue::Number(f)) => serde_json::Number::from_f64(*f)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null),
                Some(AgsValue::Bool(b)) => serde_json::Value::Bool(*b),
                Some(AgsValue::Text(s) | AgsValue::Raw(s)) => serde_json::Value::String(s.clone()),
            };
            props.insert(heading.name.clone(), val);
        }

        // Aggregate counts from related groups.
        if let Some(loca_id) = row.get("LOCA_ID").and_then(|v| v.as_text()) {
            let id = loca_id.to_string();
            props.insert(
                "geol_count".into(),
                serde_json::Value::Number((*geol_counts.get(&id).unwrap_or(&0)).into()),
            );
            props.insert(
                "ispt_count".into(),
                serde_json::Value::Number((*ispt_counts.get(&id).unwrap_or(&0)).into()),
            );
            props.insert(
                "samp_count".into(),
                serde_json::Value::Number((*samp_counts.get(&id).unwrap_or(&0)).into()),
            );
        }

        features.push(serde_json::json!({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [e, n]
            },
            "properties": props
        }));
    }

    if features.is_empty() {
        return None;
    }

    Some(serde_json::json!({
        "type": "FeatureCollection",
        "features": features
    }))
}

/// Serialise borehole locations from the LOCA group as a KML document string.
///
/// Each LOCA row with coordinates becomes a `<Placemark>`.  Extended data
/// carries all LOCA fields.  Returns `None` if there is no LOCA group or no
/// rows with coordinate data.
pub fn to_kml(file: &AgsFile) -> Option<String> {
    let loca = file.group("LOCA")?;

    let proj_name = file
        .group("PROJ")
        .and_then(|g| g.rows.first())
        .and_then(|r| r.get("PROJ_NAME"))
        .and_then(|v| v.as_text())
        .unwrap_or("GeoFlow Export");

    let mut placemarks = String::new();
    let mut count = 0usize;

    for row in &loca.rows {
        let easting = row.get("LOCA_NATE").and_then(|v| v.as_number());
        let northing = row.get("LOCA_NATN").and_then(|v| v.as_number());
        let (e, n) = match (easting, northing) {
            (Some(e), Some(n)) => (e, n),
            _ => continue,
        };

        let name = row
            .get("LOCA_ID")
            .and_then(|v| v.as_text())
            .unwrap_or("unknown");

        let mut ext_data = String::new();
        for heading in &loca.headings {
            if let Some(val) = row.get(&heading.name) {
                let s = match val {
                    AgsValue::Null => continue,
                    AgsValue::Number(f) => format!("{f}"),
                    AgsValue::Bool(true) => "Y".into(),
                    AgsValue::Bool(false) => "N".into(),
                    AgsValue::Text(s) | AgsValue::Raw(s) => xml_escape(s),
                };
                ext_data.push_str(&format!(
                    "      <Data name=\"{}\"><value>{}</value></Data>\n",
                    xml_escape(&heading.name),
                    s
                ));
            }
        }

        placemarks.push_str(&format!(
            "    <Placemark>\n      <name>{}</name>\n      <Point><coordinates>{},{},0</coordinates></Point>\n      <ExtendedData>\n{}      </ExtendedData>\n    </Placemark>\n",
            xml_escape(name), e, n, ext_data
        ));
        count += 1;
    }

    if count == 0 {
        return None;
    }

    Some(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <kml xmlns=\"http://www.opengis.net/kml/2.2\">\n  <Document>\n    <name>{}</name>\n{}\
         </Document>\n</kml>\n",
        xml_escape(proj_name),
        placemarks
    ))
}

fn count_by_loca(file: &AgsFile, group_name: &str) -> IndexMap<String, usize> {
    let mut counts: IndexMap<String, usize> = IndexMap::new();
    if let Some(g) = file.group(group_name) {
        for row in &g.rows {
            if let Some(id) = row.get("LOCA_ID").and_then(|v| v.as_text()) {
                *counts.entry(id.to_string()).or_insert(0) += 1;
            }
        }
    }
    counts
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;

    #[test]
    fn exports_simple_group() {
        let input = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","Test, Project"
"#;
        let file = parse_str(input).file;
        let csvs = to_csv(&file);
        let proj = csvs.get("PROJ").expect("PROJ group");
        assert!(proj.starts_with("PROJ_ID,PROJ_NAME\n"));
        assert!(proj.contains("P1,\"Test, Project\""));
    }

    #[test]
    fn empty_group_produces_header_only() {
        let input = r#""GROUP","WSTK"
"HEADING","LOCA_ID","WSTK_DPTH"
"UNIT","","m"
"TYPE","ID","2DP"
"#;
        let file = parse_str(input).file;
        let csvs = to_csv(&file);
        let wstk = csvs.get("WSTK").expect("WSTK group");
        assert_eq!(wstk.trim(), "LOCA_ID,WSTK_DPTH");
    }

    const LOCA_AGS: &str = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_TYPE"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","PA"
"DATA","BH01","500000","200000","BH"
"DATA","BH02","500100","200050","TP"
"#;

    #[test]
    fn geojson_produces_feature_collection() {
        let file = parse_str(LOCA_AGS).file;
        let gj = to_geojson(&file).expect("geojson output");
        assert_eq!(gj["type"], "FeatureCollection");
        let features = gj["features"].as_array().unwrap();
        assert_eq!(features.len(), 2);
        let first = &features[0];
        assert_eq!(first["geometry"]["type"], "Point");
        let coords = first["geometry"]["coordinates"].as_array().unwrap();
        assert_eq!(coords[0].as_f64().unwrap(), 500000.0);
        assert_eq!(first["properties"]["LOCA_ID"].as_str().unwrap(), "BH01");
    }

    #[test]
    fn geojson_returns_none_without_coords() {
        let input = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH01","BH"
"#;
        let file = parse_str(input).file;
        assert!(to_geojson(&file).is_none());
    }

    #[test]
    fn geojson_includes_aggregate_counts() {
        let ags = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","500000","200000"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","0.00","1.50"
"DATA","BH01","1.50","3.00"
"#;
        let file = parse_str(ags).file;
        let gj = to_geojson(&file).unwrap();
        let feat = &gj["features"][0];
        assert_eq!(feat["properties"]["geol_count"].as_u64().unwrap(), 2);
    }

    #[test]
    fn kml_produces_placemarks() {
        let file = parse_str(LOCA_AGS).file;
        let kml = to_kml(&file).expect("kml output");
        assert!(kml.contains("<kml"));
        assert!(kml.contains("<Placemark>"));
        assert!(kml.contains("BH01"));
        assert!(kml.contains("500000"));
    }

    #[test]
    fn kml_returns_none_without_coords() {
        let input = r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"
"#;
        let file = parse_str(input).file;
        assert!(to_kml(&file).is_none());
    }
}
