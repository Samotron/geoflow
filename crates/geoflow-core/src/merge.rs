//! Merge multiple AGS files into one.

use std::collections::HashSet;

use indexmap::IndexMap;

use crate::model::{AgsFile, AgsGroup, AgsHeading, AgsRow, AgsType, AgsValue};

/// Merge `files` into a single [`AgsFile`].
///
/// Strategy:
/// - **Singleton groups** (`PROJ`, `TRAN`): first file wins.
/// - **Lookup/reference groups** (`ABBR`, `UNIT`, `TYPE`, `DICT`, `HOLE`):
///   union keyed on the first heading; duplicates from later files are
///   dropped.
/// - **All other groups**: rows are concatenated in file order.
///
/// Heading layout comes from whichever file first defines the group.
/// Rows from later files are remapped to that layout; fields not present
/// in the target headings are silently dropped, and missing fields are
/// padded with `Null`.
pub fn merge(files: &[&AgsFile]) -> AgsFile {
    let mut out = AgsFile::new();

    // AGS version: first file that declares one.
    for f in files {
        if f.ags_version.is_some() {
            out.ags_version = f.ags_version.clone();
            break;
        }
    }

    const SINGLETONS: &[&str] = &["PROJ", "TRAN"];
    const LOOKUP: &[&str] = &["ABBR", "UNIT", "TYPE", "DICT", "HOLE"];

    // Singleton groups: first non-empty occurrence wins.
    for &name in SINGLETONS {
        for f in files {
            if let Some(g) = f.group(name) {
                if !g.rows.is_empty() {
                    out.groups.insert(name.to_string(), g.clone());
                    break;
                }
            }
        }
    }

    // Lookup groups: deduplicate by first heading value.
    for &name in LOOKUP {
        if let Some(merged) = merge_lookup(files, name) {
            out.groups.insert(name.to_string(), merged);
        }
    }

    // Collect remaining group names in first-seen order.
    let skip: HashSet<&str> = SINGLETONS.iter().chain(LOOKUP.iter()).copied().collect();
    let mut data_groups: Vec<String> = Vec::new();
    for f in files {
        for name in f.groups.keys() {
            if !skip.contains(name.as_str()) && !data_groups.contains(name) {
                data_groups.push(name.clone());
            }
        }
    }

    for name in data_groups {
        if let Some(merged) = merge_data_group(files, &name) {
            out.groups.insert(name, merged);
        }
    }

    out
}

// Merge a lookup/reference group by deduplicating on the first heading.
fn merge_lookup(files: &[&AgsFile], name: &str) -> Option<AgsGroup> {
    let template = files.iter().find_map(|f| f.group(name))?;
    let key = template
        .headings
        .first()
        .map(|h| h.name.as_str())
        .unwrap_or("");

    let mut merged = AgsGroup {
        name: name.to_string(),
        headings: template.headings.clone(),
        rows: Vec::new(),
        source_line: template.source_line,
    };
    let mut seen: HashSet<String> = HashSet::new();

    for f in files {
        let Some(g) = f.group(name) else { continue };
        for row in &g.rows {
            let k = row
                .get(key)
                .and_then(|v| v.as_text())
                .unwrap_or("")
                .to_string();
            if seen.insert(k) {
                merged.rows.push(remap_row(row, &merged.headings));
            }
        }
    }

    if merged.headings.is_empty() {
        None
    } else {
        Some(merged)
    }
}

// Concatenate data rows from all files for a single group.
fn merge_data_group(files: &[&AgsFile], name: &str) -> Option<AgsGroup> {
    let template = files.iter().find_map(|f| f.group(name))?;

    let mut merged = AgsGroup {
        name: name.to_string(),
        headings: template.headings.clone(),
        rows: Vec::new(),
        source_line: template.source_line,
    };

    for f in files {
        let Some(g) = f.group(name) else { continue };
        for row in &g.rows {
            merged.rows.push(remap_row(row, &merged.headings));
        }
    }

    if merged.headings.is_empty() {
        None
    } else {
        Some(merged)
    }
}

// Re-key a row to the given heading layout, padding with Null as needed.
fn remap_row(row: &AgsRow, headings: &[AgsHeading]) -> AgsRow {
    let mut out: AgsRow = IndexMap::new();
    for h in headings {
        let val = row.get(&h.name).cloned().unwrap_or(AgsValue::Null);
        out.insert(h.name.clone(), val);
    }
    out
}

/// Build a minimal PROJ group for a merged file given a project name and ID.
pub fn make_proj_group(proj_id: &str, proj_name: &str) -> AgsGroup {
    let mut g = AgsGroup::new("PROJ");
    g.headings = vec![
        AgsHeading {
            name: "PROJ_ID".into(),
            unit: String::new(),
            data_type: AgsType::ID,
        },
        AgsHeading {
            name: "PROJ_NAME".into(),
            unit: String::new(),
            data_type: AgsType::X,
        },
    ];
    let mut row: AgsRow = IndexMap::new();
    row.insert("PROJ_ID".into(), AgsValue::Text(proj_id.into()));
    row.insert("PROJ_NAME".into(), AgsValue::Text(proj_name.into()));
    g.rows.push(row);
    g
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;

    fn make_file(ags: &str) -> AgsFile {
        parse_str(ags).file
    }

    const FILE_A: &str = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","Project A"

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH01","BH"
"DATA","BH02","BH"
"#;

    const FILE_B: &str = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P2","Project B"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH03","BH"
"DATA","BH04","TP"
"#;

    #[test]
    fn merge_concatenates_data_groups() {
        let a = make_file(FILE_A);
        let b = make_file(FILE_B);
        let out = merge(&[&a, &b]);
        let loca = out.group("LOCA").unwrap();
        assert_eq!(loca.rows.len(), 4);
    }

    #[test]
    fn merge_singleton_first_wins() {
        let a = make_file(FILE_A);
        let b = make_file(FILE_B);
        let out = merge(&[&a, &b]);
        let proj = out.group("PROJ").unwrap();
        assert_eq!(proj.rows.len(), 1);
        assert_eq!(
            proj.rows[0].get("PROJ_ID").and_then(|v| v.as_text()),
            Some("P1")
        );
    }

    #[test]
    fn merge_lookup_deduplicates() {
        let abbr_ags = r#""GROUP","ABBR"
"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"
"UNIT","","",""
"TYPE","X","PA","X"
"DATA","LOCA_TYPE","BH","Borehole"
"DATA","LOCA_TYPE","TP","Trial Pit"
"#;
        let abbr2_ags = r#""GROUP","ABBR"
"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"
"UNIT","","",""
"TYPE","X","PA","X"
"DATA","LOCA_TYPE","BH","Borehole (duplicate)"
"DATA","LOCA_TYPE","WS","Window Sample"
"#;
        let a = make_file(abbr_ags);
        let b = make_file(abbr2_ags);
        let out = merge(&[&a, &b]);
        let abbr = out.group("ABBR").unwrap();
        // BH from file A kept, duplicate BH from file B dropped, WS added.
        assert_eq!(abbr.rows.len(), 3);
        let codes: Vec<&str> = abbr
            .rows
            .iter()
            .filter_map(|r| r.get("ABBR_CODE").and_then(|v| v.as_text()))
            .collect();
        assert!(codes.contains(&"WS"));
        assert_eq!(codes.iter().filter(|&&c| c == "BH").count(), 1);
    }
}
