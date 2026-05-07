//! AGS 3.x → AGS 4.x migration.
//!
//! AGS 3 uses a different structural encoding:
//! - Group headers: lines starting with `**` (e.g. `**LOCA`)
//! - Heading lines: lines starting with `*` (e.g. `*LOCA_ID,LOCA_TYPE,...`)
//! - Unit lines: the first DATA line after headings (comma-separated, quoted)
//! - Type lines: the second DATA line after headings
//! - Data: remaining lines until the next `**` marker
//!
//! Fields are comma-separated; quoted fields may contain commas.
//!
//! This module parses AGS 3 text and produces an [`AgsFile`] model compatible
//! with AGS 4.x serialization.

use crate::model::{AgsFile, AgsGroup, AgsHeading, AgsRow, AgsType, AgsValue};
use indexmap::IndexMap;

/// Result of AGS 3 migration.
#[derive(Debug, Clone, Default)]
pub struct MigrateOutcome {
    pub file: AgsFile,
    /// Human-readable notes about decisions made during migration.
    pub notes: Vec<String>,
}

/// Parse an AGS 3 text file and return an [`AgsFile`] in AGS 4 model form.
///
/// Returns `None` if the text does not look like an AGS 3 file (no `**` group
/// lines found).
pub fn migrate_str(text: &str) -> Option<MigrateOutcome> {
    if !text.lines().any(|l| l.starts_with("**")) {
        return None;
    }

    let mut outcome = MigrateOutcome::default();
    let mut current_group: Option<GroupBuilder> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(group_name) = trimmed.strip_prefix("**") {
            // Flush previous group.
            if let Some(builder) = current_group.take() {
                if let Some(g) = builder.build(&mut outcome.notes) {
                    outcome.file.groups.insert(g.name.clone(), g);
                }
            }
            let name = group_name.trim().to_ascii_uppercase();
            current_group = Some(GroupBuilder::new(name));
        } else if let Some(builder) = current_group.as_mut() {
            if let Some(headings_raw) = trimmed.strip_prefix('*') {
                builder.set_headings(split_csv(headings_raw));
            } else {
                builder.push_data_line(split_csv(trimmed));
            }
        }
    }

    // Flush final group.
    if let Some(builder) = current_group.take() {
        if let Some(g) = builder.build(&mut outcome.notes) {
            outcome.file.groups.insert(g.name.clone(), g);
        }
    }

    if outcome.file.groups.is_empty() {
        outcome.notes.push("no groups found in AGS 3 input".into());
    }

    Some(outcome)
}

/// Parse AGS 3 bytes (handles UTF-8 BOM and Windows-1252 fallback).
pub fn migrate_bytes(bytes: &[u8]) -> Option<MigrateOutcome> {
    let text = crate::ags::decode_bytes(bytes);
    migrate_str(&text)
}

struct GroupBuilder {
    name: String,
    headings: Vec<String>,
    data_lines: Vec<Vec<String>>,
}

impl GroupBuilder {
    fn new(name: String) -> Self {
        Self {
            name,
            headings: Vec::new(),
            data_lines: Vec::new(),
        }
    }

    fn set_headings(&mut self, names: Vec<String>) {
        self.headings = names
            .into_iter()
            .map(|s| s.trim().to_ascii_uppercase())
            .collect();
    }

    fn push_data_line(&mut self, fields: Vec<String>) {
        self.data_lines.push(fields);
    }

    fn build(self, notes: &mut Vec<String>) -> Option<AgsGroup> {
        if self.headings.is_empty() {
            notes.push(format!("group {} skipped: no heading line", self.name));
            return None;
        }

        // AGS 3 convention: first data line = units, second = types.
        // If fewer than 2 data lines exist, units/types default to empty/"X".
        let units: Vec<String> = self.data_lines.first().cloned().unwrap_or_default();
        let types: Vec<String> = self.data_lines.get(1).cloned().unwrap_or_default();

        let headings: Vec<AgsHeading> = self
            .headings
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let unit = units
                    .get(i)
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default();
                let raw_type = types.get(i).map(|s| s.trim()).unwrap_or("X");
                let data_type = AgsType::parse(raw_type);
                AgsHeading {
                    name: name.clone(),
                    unit,
                    data_type,
                }
            })
            .collect();

        let mut rows: Vec<AgsRow> = Vec::new();
        for raw_row in self.data_lines.iter().skip(2) {
            let mut row: AgsRow = IndexMap::new();
            for (i, heading) in headings.iter().enumerate() {
                let raw = raw_row.get(i).map(|s| s.trim()).unwrap_or("");
                let val = if raw.is_empty() {
                    AgsValue::Null
                } else {
                    coerce(raw, &heading.data_type)
                };
                row.insert(heading.name.clone(), val);
            }
            rows.push(row);
        }

        Some(AgsGroup {
            name: self.name,
            headings,
            rows,
            source_line: None,
        })
    }
}

/// Coerce a raw string value to an [`AgsValue`] given its type.
fn coerce(raw: &str, ty: &AgsType) -> AgsValue {
    match ty {
        AgsType::YN => match raw.to_ascii_uppercase().as_str() {
            "Y" | "YES" | "TRUE" | "1" => AgsValue::Bool(true),
            _ => AgsValue::Bool(false),
        },
        t if t.is_numeric() => {
            if let Ok(f) = raw.parse::<f64>() {
                AgsValue::Number(f)
            } else {
                AgsValue::Raw(raw.to_string())
            }
        }
        _ => AgsValue::Text(raw.to_string()),
    }
}

/// Split a CSV line into fields, respecting double-quoted strings.
fn split_csv(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                if in_quotes {
                    // Peek for escaped double-quote `""`.
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        current.push('"');
                    } else {
                        in_quotes = false;
                    }
                } else {
                    in_quotes = true;
                }
            }
            ',' if !in_quotes => {
                fields.push(current.trim().to_string());
                current = String::new();
            }
            _ => current.push(ch),
        }
    }
    fields.push(current.trim().to_string());
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGS3_SIMPLE: &str = r#"**PROJ
*PROJ_ID,PROJ_NAME
"",""
"ID","X"
P001,Test Project

**LOCA
*LOCA_ID,LOCA_NATE,LOCA_NATN,LOCA_TYPE
"","m","m",""
"ID","2DP","2DP","PA"
BH01,500000,200000,BH
BH02,500100,200050,TP
"#;

    const AGS3_NO_GROUPS: &str = "no group headers here\njust plain text\n";

    #[test]
    fn returns_none_for_non_ags3() {
        assert!(migrate_str(AGS3_NO_GROUPS).is_none());
    }

    #[test]
    fn parses_groups_and_headings() {
        let out = migrate_str(AGS3_SIMPLE).expect("should parse");
        assert!(out.file.groups.contains_key("PROJ"));
        assert!(out.file.groups.contains_key("LOCA"));
    }

    #[test]
    fn parses_proj_row() {
        let out = migrate_str(AGS3_SIMPLE).unwrap();
        let proj = out.file.group("PROJ").unwrap();
        assert_eq!(proj.rows.len(), 1);
        assert_eq!(
            proj.rows[0].get("PROJ_ID").and_then(|v| v.as_text()),
            Some("P001")
        );
    }

    #[test]
    fn parses_loca_rows_with_numbers() {
        let out = migrate_str(AGS3_SIMPLE).unwrap();
        let loca = out.file.group("LOCA").unwrap();
        assert_eq!(loca.rows.len(), 2);
        assert_eq!(
            loca.rows[0].get("LOCA_NATE").and_then(|v| v.as_number()),
            Some(500000.0)
        );
    }

    #[test]
    fn parses_loca_id_type_as_text() {
        let out = migrate_str(AGS3_SIMPLE).unwrap();
        let loca = out.file.group("LOCA").unwrap();
        assert_eq!(
            loca.rows[0].get("LOCA_TYPE").and_then(|v| v.as_text()),
            Some("BH")
        );
    }

    #[test]
    fn units_and_types_propagated() {
        let out = migrate_str(AGS3_SIMPLE).unwrap();
        let loca = out.file.group("LOCA").unwrap();
        let nate = loca
            .headings
            .iter()
            .find(|h| h.name == "LOCA_NATE")
            .unwrap();
        assert_eq!(nate.unit, "m");
        assert_eq!(nate.data_type, AgsType::Dp(2));
    }

    #[test]
    fn csv_split_handles_quotes() {
        let fields = split_csv(r#""hello, world","foo""bar",plain"#);
        assert_eq!(fields, vec!["hello, world", r#"foo"bar"#, "plain"]);
    }

    #[test]
    fn output_round_trips_through_ags4_serializer() {
        let out = migrate_str(AGS3_SIMPLE).unwrap();
        let ags4 = crate::ags::serialize(&out.file);
        // The serialized AGS 4 should parse cleanly.
        let reparsed = crate::ags::parse_str(&ags4);
        assert!(
            reparsed
                .diagnostics
                .iter()
                .all(|d| d.severity != crate::diagnostics::Severity::Error),
            "round-trip produced errors: {:?}",
            reparsed.diagnostics
        );
        assert_eq!(reparsed.file.groups.len(), out.file.groups.len());
    }
}
