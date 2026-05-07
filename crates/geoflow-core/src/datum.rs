//! Depth datum conversion utilities.
//!
//! AGS files store depths as depth-below-ground-level (bgl) measured from
//! the collar of the borehole.  Many engineering workflows instead want
//! depths expressed as Reduced Level (RL), i.e. elevation above an agreed
//! datum such as Ordnance Datum (OD) or mean sea level.
//!
//! The conversion is:
//!
//!   RL = LOCA_GL − depth_bgl
//!
//! where `LOCA_GL` is the ground-level elevation stored in the LOCA group.
//! Groups that reference LOCA_ID via depth columns are transformed in-place.
//!
//! This module provides:
//! - [`DatumMode`] — which direction to convert.
//! - [`apply_datum`] — mutates an [`AgsFile`] in place, adding RL columns
//!   where they don't exist or adjusting existing depth columns.

use std::collections::HashMap;

use crate::model::{AgsFile, AgsHeading, AgsType, AgsValue};

/// Direction of depth-datum conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatumMode {
    /// Convert depth-below-ground-level columns to Reduced Level (RL).
    DepthToRl,
    /// Convert Reduced Level columns back to depth-below-ground-level.
    RlToDepth,
}

/// Columns considered depth-below-ground-level that will be converted.
///
/// Keyed by group name; value is the list of heading names within that group
/// that hold depths in metres below ground level.
const DEPTH_COLUMNS: &[(&str, &[&str])] = &[
    ("GEOL", &["GEOL_TOP", "GEOL_BASE"]),
    ("SAMP", &["SAMP_TOP", "SAMP_BASE"]),
    ("ISPT", &["ISPT_TOP"]),
    ("WSTK", &["WSTK_DPTH"]),
    ("LLPL", &["LPEN_DEPTH"]),
    ("LPEN", &["LPEN_DEPTH"]),
    ("IDEN", &["IDEN_DPTH"]),
    ("IVAN", &["IVAN_DPTH"]),
    ("IPRM", &["IPRM_TOP", "IPRM_BOT"]),
    ("IPRT", &["IPRT_DPTH"]),
    ("IRDX", &["IRDX_DPTH"]),
    ("ICBR", &["ICBR_DPTH"]),
    ("CDIA", &["CDIA_DPTH"]),
    ("CMET", &["CMET_TOP", "CMET_BASE"]),
    ("STCN", &["STCN_DPTH"]),
    ("MOND", &["MOND_DPTH"]),
    ("PREM", &["PREM_DPTH"]),
];

/// Apply depth-datum conversion to `file` in place.
///
/// Returns the number of depth values that were converted.
///
/// # Behaviour
/// - Reads ground-level elevations from `LOCA.LOCA_GL` for each `LOCA_ID`.
/// - For each group listed in [`DEPTH_COLUMNS`], adjusts the named columns
///   using the ground level of the matching `LOCA_ID`.
/// - Rows with no matching `LOCA_ID` in LOCA, or where `LOCA_GL` is absent,
///   are left unchanged.
pub fn apply_datum(file: &mut AgsFile, mode: DatumMode) -> usize {
    // Build map: LOCA_ID → ground level (LOCA_GL).
    let gl_map: HashMap<String, f64> = file
        .group("LOCA")
        .map(|g| {
            g.rows
                .iter()
                .filter_map(|r| {
                    let id = r.get("LOCA_ID").and_then(|v| v.as_text())?.to_string();
                    let gl = r.get("LOCA_GL").and_then(|v| v.as_number())?;
                    Some((id, gl))
                })
                .collect()
        })
        .unwrap_or_default();

    if gl_map.is_empty() {
        return 0;
    }

    let mut converted = 0usize;

    for (group_name, depth_cols) in DEPTH_COLUMNS {
        let Some(group) = file.groups.get_mut(*group_name) else {
            continue;
        };

        // Ensure RL columns exist in the headings when converting to RL.
        let depth_col_set: std::collections::HashSet<&str> = depth_cols.iter().copied().collect();

        if mode == DatumMode::DepthToRl {
            let existing_names: Vec<String> =
                group.headings.iter().map(|h| h.name.clone()).collect();
            for &col in *depth_cols {
                let rl_name = rl_column_name(col);
                if !existing_names.contains(&rl_name) {
                    // Insert the RL column immediately after its depth column.
                    let pos = group
                        .headings
                        .iter()
                        .position(|h| h.name == col)
                        .map(|i| i + 1)
                        .unwrap_or(group.headings.len());
                    group.headings.insert(
                        pos,
                        AgsHeading {
                            name: rl_name.clone(),
                            unit: "m".into(),
                            data_type: AgsType::Dp(3),
                        },
                    );
                }
            }
        }

        for row in &mut group.rows {
            let Some(gl) = row
                .get("LOCA_ID")
                .and_then(|v| v.as_text())
                .and_then(|id| gl_map.get(id))
                .copied()
            else {
                continue;
            };

            // Collect depth headings that exist in this group.
            let col_names: Vec<String> = group
                .headings
                .iter()
                .filter(|h| depth_col_set.contains(h.name.as_str()))
                .map(|h| h.name.clone())
                .collect();

            for col in col_names {
                match mode {
                    DatumMode::DepthToRl => {
                        if let Some(depth) = row.get(&col).and_then(|v| v.as_number()) {
                            let rl = gl - depth;
                            let rl_name = rl_column_name(&col);
                            row.insert(rl_name, AgsValue::Number(rl));
                            converted += 1;
                        }
                    }
                    DatumMode::RlToDepth => {
                        let rl_name = rl_column_name(&col);
                        if let Some(rl) = row.get(&rl_name).and_then(|v| v.as_number()) {
                            let depth = gl - rl;
                            row.insert(col, AgsValue::Number(depth));
                            converted += 1;
                        }
                    }
                }
            }
        }
    }

    converted
}

/// Derive the RL column name for a given depth column, e.g. `GEOL_TOP` → `GEOL_TOPRL`.
fn rl_column_name(depth_col: &str) -> String {
    format!("{depth_col}RL")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;

    const AGS: &str = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_GL"
"UNIT","","m","m","m"
"TYPE","ID","2DP","2DP","3DP"
"DATA","BH01","500000","200000","50.000"
"DATA","BH02","500100","200000","35.000"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","0.00","1.50","Brown CLAY"
"DATA","BH01","1.50","3.00","Grey SILT"
"DATA","BH02","0.00","2.00","Sandy GRAVEL"
"#;

    #[test]
    fn depth_to_rl_adds_rl_columns() {
        let mut file = parse_str(AGS).file;
        let count = apply_datum(&mut file, DatumMode::DepthToRl);
        assert!(count > 0, "expected conversions");

        let geol = file.group("GEOL").unwrap();
        assert!(
            geol.headings.iter().any(|h| h.name == "GEOL_TOPRL"),
            "GEOL_TOPRL column not added"
        );
        assert!(
            geol.headings.iter().any(|h| h.name == "GEOL_BASERL"),
            "GEOL_BASERL column not added"
        );
    }

    #[test]
    fn rl_values_are_gl_minus_depth() {
        let mut file = parse_str(AGS).file;
        apply_datum(&mut file, DatumMode::DepthToRl);

        let geol = file.group("GEOL").unwrap();
        // BH01 GL = 50, GEOL_TOP row[0] = 0.00 → RL = 50.0
        let top_rl = geol.rows[0]
            .get("GEOL_TOPRL")
            .and_then(|v| v.as_number())
            .expect("GEOL_TOPRL value");
        assert!((top_rl - 50.0).abs() < 1e-6, "expected 50.0, got {top_rl}");

        // row[1]: GEOL_BASE = 3.00 → RL = 50 - 3 = 47.0
        let base_rl = geol.rows[1]
            .get("GEOL_BASERL")
            .and_then(|v| v.as_number())
            .expect("GEOL_BASERL value");
        assert!(
            (base_rl - 47.0).abs() < 1e-6,
            "expected 47.0, got {base_rl}"
        );
    }

    #[test]
    fn no_loca_gl_leaves_group_unchanged() {
        let ags_no_gl = r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","0.00","1.50"
"#;
        let mut file = parse_str(ags_no_gl).file;
        let count = apply_datum(&mut file, DatumMode::DepthToRl);
        assert_eq!(count, 0, "should not convert without LOCA_GL");
    }
}
