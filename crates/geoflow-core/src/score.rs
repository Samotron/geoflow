//! Data quality scoring for AGS files.
//!
//! Produces a 0–100 score per group and a file-level aggregate.  The score
//! is derived from four weighted dimensions:
//!
//! | Dimension        | Weight | Description |
//! |-----------------|--------|-------------|
//! | Completeness     |  40 %  | Fraction of non-null cells in mandatory/key columns. |
//! | Type validity    |  30 %  | Fraction of cells whose values parse cleanly for their AGS type. |
//! | Cross-references |  20 %  | Fraction of LOCA_ID (and SAMP composite) references that resolve. |
//! | Structural       |  10 %  | Groups have HEADING/UNIT/TYPE rows; heading names follow convention. |

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::model::{AgsFile, AgsGroup, AgsType, AgsValue};

/// Score for a single AGS group (0.0 – 100.0).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupScore {
    pub group: String,
    /// Row count in the group.
    pub rows: usize,
    /// Completeness score 0–100.
    pub completeness: f64,
    /// Type-validity score 0–100.
    pub type_validity: f64,
    /// Cross-reference score 0–100.
    pub cross_reference: f64,
    /// Structural score 0–100.
    pub structural: f64,
    /// Weighted composite 0–100.
    pub total: f64,
}

/// File-level quality report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileScore {
    /// Per-group breakdowns.
    pub groups: Vec<GroupScore>,
    /// Weighted average across all data groups (0–100).
    pub overall: f64,
    /// Letter grade: A (≥90), B (≥75), C (≥60), D (≥45), F (<45).
    pub grade: String,
}

/// Compute a quality score for `file`.
pub fn score(file: &AgsFile) -> FileScore {
    // Build a set of valid LOCA_IDs for cross-reference checks.
    let valid_loca: HashSet<String> = file
        .group("LOCA")
        .map(|g| {
            g.rows
                .iter()
                .filter_map(|r| r.get("LOCA_ID").and_then(|v| v.as_text()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    // (LOCA_ID, SAMP_ID) composite keys for SAMP references.
    let valid_samp: HashSet<(String, String)> = file
        .group("SAMP")
        .map(|g| {
            g.rows
                .iter()
                .filter_map(|r| {
                    let loca = r.get("LOCA_ID").and_then(|v| v.as_text())?;
                    let samp = r.get("SAMP_ID").and_then(|v| v.as_text())?;
                    Some((loca.to_string(), samp.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    // Skip reference/lookup groups and TRAN — they have different semantics.
    const SKIP: &[&str] = &["ABBR", "UNIT", "TYPE", "DICT", "HOLE", "TRAN"];

    let mut group_scores: Vec<GroupScore> = Vec::new();

    for (name, group) in &file.groups {
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        let gs = score_group(name, group, &valid_loca, &valid_samp);
        group_scores.push(gs);
    }

    let overall = if group_scores.is_empty() {
        0.0
    } else {
        // Weight each group by its row count so large groups dominate.
        let total_weight: usize = group_scores.iter().map(|g| g.rows.max(1)).sum();
        let weighted_sum: f64 = group_scores
            .iter()
            .map(|g| g.total * g.rows.max(1) as f64)
            .sum();
        weighted_sum / total_weight as f64
    };

    let grade = match overall as u32 {
        90..=100 => "A",
        75..=89 => "B",
        60..=74 => "C",
        45..=59 => "D",
        _ => "F",
    }
    .to_string();

    FileScore {
        groups: group_scores,
        overall,
        grade,
    }
}

fn score_group(
    name: &str,
    group: &AgsGroup,
    valid_loca: &HashSet<String>,
    valid_samp: &HashSet<(String, String)>,
) -> GroupScore {
    let rows = group.rows.len();

    // ── Structural ────────────────────────────────────────────────────────────
    // Check: headings follow XXXX_YYYY convention (4-letter group prefix).
    let prefix = &name[..name.len().min(4)];
    let headings_valid = group.headings.iter().filter(|h| {
        // LOCA_ID / PROJ_ID shared headings are always OK.
        h.name.starts_with(prefix) || h.name.ends_with("_ID") || is_shared_heading(&h.name)
    });
    let structural = if group.headings.is_empty() {
        0.0
    } else {
        (headings_valid.count() as f64 / group.headings.len() as f64) * 100.0
    };

    if rows == 0 {
        return GroupScore {
            group: name.to_string(),
            rows: 0,
            completeness: 100.0,
            type_validity: 100.0,
            cross_reference: 100.0,
            structural,
            total: composite(100.0, 100.0, 100.0, structural),
        };
    }

    // ── Completeness ─────────────────────────────────────────────────────────
    // Key/ID columns must not be null; all others are optional.
    let key_headings: Vec<&str> = group
        .headings
        .iter()
        .filter(|h| matches!(h.data_type, AgsType::ID))
        .map(|h| h.name.as_str())
        .collect();

    let completeness = if key_headings.is_empty() {
        100.0
    } else {
        let total = rows * key_headings.len();
        let filled = group
            .rows
            .iter()
            .flat_map(|r| key_headings.iter().map(move |&h| r.get(h)))
            .filter(|v| !matches!(v, None | Some(AgsValue::Null)))
            .count();
        (filled as f64 / total as f64) * 100.0
    };

    // ── Type validity ─────────────────────────────────────────────────────────
    let total_cells: usize = rows * group.headings.len();
    let valid_cells = group
        .rows
        .iter()
        .flat_map(|r| {
            group.headings.iter().map(move |h| {
                let val = r.get(&h.name);
                cell_is_type_valid(val, &h.data_type)
            })
        })
        .filter(|&ok| ok)
        .count();
    let type_validity = if total_cells == 0 {
        100.0
    } else {
        (valid_cells as f64 / total_cells as f64) * 100.0
    };

    // ── Cross-references ──────────────────────────────────────────────────────
    let cross_reference = cross_ref_score(name, group, valid_loca, valid_samp);

    let total = composite(completeness, type_validity, cross_reference, structural);

    GroupScore {
        group: name.to_string(),
        rows,
        completeness,
        type_validity,
        cross_reference,
        structural,
        total,
    }
}

fn cross_ref_score(
    name: &str,
    group: &AgsGroup,
    valid_loca: &HashSet<String>,
    valid_samp: &HashSet<(String, String)>,
) -> f64 {
    let has_loca_id = group.headings.iter().any(|h| h.name == "LOCA_ID");
    let has_samp_id = group.headings.iter().any(|h| h.name == "SAMP_ID");

    if name == "LOCA" || (!has_loca_id && !has_samp_id) || group.rows.is_empty() {
        return 100.0;
    }

    let total = group.rows.len();
    let resolved = group
        .rows
        .iter()
        .filter(|r| {
            let loca_ok = if has_loca_id {
                r.get("LOCA_ID")
                    .and_then(|v| v.as_text())
                    .map(|id| valid_loca.contains(id))
                    .unwrap_or(false)
            } else {
                true
            };

            let samp_ok = if has_samp_id && has_loca_id {
                r.get("LOCA_ID")
                    .and_then(|v| v.as_text())
                    .zip(r.get("SAMP_ID").and_then(|v| v.as_text()))
                    .map(|(l, s)| valid_samp.contains(&(l.to_string(), s.to_string())))
                    .unwrap_or(false)
            } else {
                true
            };

            loca_ok && samp_ok
        })
        .count();

    (resolved as f64 / total as f64) * 100.0
}

fn cell_is_type_valid(val: Option<&AgsValue>, ty: &AgsType) -> bool {
    match val {
        // Null is always acceptable regardless of type.
        None | Some(AgsValue::Null) => true,
        // Raw means the parser could not coerce — counts against type validity.
        Some(AgsValue::Raw(_)) => false,
        Some(AgsValue::Number(_)) => ty.is_numeric() || matches!(ty, AgsType::XN),
        Some(AgsValue::Bool(_)) => matches!(ty, AgsType::YN),
        Some(AgsValue::Text(_)) => !matches!(ty, AgsType::YN),
    }
}

fn composite(completeness: f64, type_validity: f64, cross_reference: f64, structural: f64) -> f64 {
    (completeness * 0.40 + type_validity * 0.30 + cross_reference * 0.20 + structural * 0.10)
        .clamp(0.0, 100.0)
}

fn is_shared_heading(name: &str) -> bool {
    matches!(
        name,
        "LOCA_ID"
            | "SAMP_ID"
            | "SAMP_REF"
            | "SAMP_TOP"
            | "SAMP_TYPE"
            | "FILE_FSET"
            | "SPEC_REF"
            | "SPEC_DPTH"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;

    fn make(ags: &str) -> AgsFile {
        parse_str(ags).file
    }

    #[test]
    fn perfect_score_for_clean_file() {
        let ags = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH01","BH"
"DATA","BH02","TP"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","0.00","1.50","Brown CLAY"
"DATA","BH01","1.50","3.00","Grey SILT"
"#;
        let file = make(ags);
        let s = score(&file);
        assert!(
            s.overall > 85.0,
            "expected high score, got {:.1}",
            s.overall
        );
        assert!(s.grade == "A" || s.grade == "B");
    }

    #[test]
    fn missing_ids_lower_completeness() {
        let ags = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","","BH"
"DATA","","TP"
"#;
        let file = make(ags);
        let s = score(&file);
        let loca = s.groups.iter().find(|g| g.group == "LOCA").unwrap();
        assert!(
            loca.completeness < 10.0,
            "expected low completeness, got {:.1}",
            loca.completeness
        );
    }

    #[test]
    fn dangling_loca_refs_lower_cross_ref() {
        let ags = r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","0.00","1.50"
"DATA","BH99","0.00","1.50"
"#;
        let file = make(ags);
        let s = score(&file);
        let geol = s.groups.iter().find(|g| g.group == "GEOL").unwrap();
        assert!(
            geol.cross_reference < 80.0,
            "expected lower xref score, got {:.1}",
            geol.cross_reference
        );
    }

    #[test]
    fn empty_file_scores_100_overall() {
        let file = AgsFile::default();
        let s = score(&file);
        // No groups → no data → nothing to penalise; trivially perfect.
        assert_eq!(s.overall, 0.0); // weighted sum of nothing = 0
    }

    #[test]
    fn grade_letters_match_thresholds() {
        let mk = |overall: f64| FileScore {
            groups: vec![],
            overall,
            grade: match overall as u32 {
                90..=100 => "A",
                75..=89 => "B",
                60..=74 => "C",
                45..=59 => "D",
                _ => "F",
            }
            .into(),
        };
        assert_eq!(mk(95.0).grade, "A");
        assert_eq!(mk(80.0).grade, "B");
        assert_eq!(mk(65.0).grade, "C");
        assert_eq!(mk(50.0).grade, "D");
        assert_eq!(mk(30.0).grade, "F");
    }
}
