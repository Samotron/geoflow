//! Cross-file consistency validation.
//!
//! Checks that are only meaningful when multiple AGS files are considered
//! together: duplicate borehole IDs across submissions, conflicting
//! abbreviation definitions, and project-level mismatches.

use crate::diagnostics::{Diagnostic, Severity};
use crate::model::AgsFile;

/// A cross-file diagnostic also records which file the issue was detected in.
#[derive(Debug, Clone)]
pub struct CrossFileDiagnostic {
    pub diagnostic: Diagnostic,
    /// Index into the input slice of the file that triggered this diagnostic.
    pub file_index: usize,
}

/// Validate `files` for consistency with one another.
///
/// `labels` should have the same length as `files`; it provides human-readable
/// names (e.g. file paths) used in diagnostic messages.  If shorter, numeric
/// indices are used for the extra files.
pub fn validate_cross_file(files: &[&AgsFile], labels: &[&str]) -> Vec<CrossFileDiagnostic> {
    let mut out = Vec::new();

    check_duplicate_loca_ids(files, labels, &mut out);
    check_abbr_conflicts(files, labels, &mut out);
    check_proj_consistency(files, labels, &mut out);

    out
}

fn label(labels: &[&str], i: usize) -> String {
    labels.get(i).copied().unwrap_or("").to_string()
}

/// Report LOCA_IDs that appear in more than one file.
fn check_duplicate_loca_ids(
    files: &[&AgsFile],
    labels: &[&str],
    out: &mut Vec<CrossFileDiagnostic>,
) {
    // Map LOCA_ID → first file index that declared it.
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for (i, file) in files.iter().enumerate() {
        let Some(loca) = file.group("LOCA") else {
            continue;
        };
        for row in &loca.rows {
            let Some(id) = row.get("LOCA_ID").and_then(|v| v.as_text()) else {
                continue;
            };
            if let Some(&first_idx) = seen.get(id) {
                out.push(CrossFileDiagnostic {
                    diagnostic: Diagnostic::new(
                        "XFILE-LOCA-001",
                        Severity::Error,
                        format!(
                            "LOCA_ID {:?} appears in both {:?} (file {}) and {:?} (file {}); \
                             duplicate borehole IDs will cause reference integrity failures",
                            id,
                            label(labels, first_idx),
                            first_idx + 1,
                            label(labels, i),
                            i + 1,
                        ),
                    )
                    .at_file(label(labels, i))
                    .at_group("LOCA"),
                    file_index: i,
                });
            } else {
                seen.insert(id.to_string(), i);
            }
        }
    }
}

/// Report ABBR codes where two files define the same (heading, code) pair with
/// different descriptions — a sign of conflicting abbreviation tables.
fn check_abbr_conflicts(files: &[&AgsFile], labels: &[&str], out: &mut Vec<CrossFileDiagnostic>) {
    // (ABBR_HDNG, ABBR_CODE) → (description, file_index)
    let mut seen: std::collections::HashMap<(String, String), (String, usize)> =
        std::collections::HashMap::new();

    for (i, file) in files.iter().enumerate() {
        let Some(abbr) = file.group("ABBR") else {
            continue;
        };
        for row in &abbr.rows {
            let hdng = row
                .get("ABBR_HDNG")
                .and_then(|v| v.as_text())
                .unwrap_or("")
                .to_string();
            let code = row
                .get("ABBR_CODE")
                .and_then(|v| v.as_text())
                .unwrap_or("")
                .to_string();
            let desc = row
                .get("ABBR_DESC")
                .and_then(|v| v.as_text())
                .unwrap_or("")
                .to_string();

            let key = (hdng.clone(), code.clone());
            if let Some((prev_desc, first_idx)) = seen.get(&key) {
                if *prev_desc != desc {
                    out.push(CrossFileDiagnostic {
                        diagnostic: Diagnostic::new(
                            "XFILE-ABBR-001",
                            Severity::Warning,
                            format!(
                                "ABBR code {:?} for heading {:?} has conflicting descriptions: \
                                 {:?} in {:?} vs {:?} in {:?}",
                                code,
                                hdng,
                                prev_desc,
                                label(labels, *first_idx),
                                desc,
                                label(labels, i),
                            ),
                        )
                        .at_file(label(labels, i))
                        .at_group("ABBR"),
                        file_index: i,
                    });
                }
            } else {
                seen.insert(key, (desc, i));
            }
        }
    }
}

/// Report when multiple files declare a PROJ group with different PROJ_IDs —
/// a warning that these may not belong to the same project.
fn check_proj_consistency(files: &[&AgsFile], labels: &[&str], out: &mut Vec<CrossFileDiagnostic>) {
    let proj_ids: Vec<Option<&str>> = files
        .iter()
        .map(|f| {
            f.group("PROJ")
                .and_then(|g| g.rows.first())
                .and_then(|r| r.get("PROJ_ID"))
                .and_then(|v| v.as_text())
        })
        .collect();

    // Find the first non-None project ID as the reference.
    let Some((ref_idx, ref_id)) = proj_ids
        .iter()
        .enumerate()
        .find_map(|(i, id)| id.map(|v| (i, v)))
    else {
        return;
    };

    for (i, id_opt) in proj_ids.iter().enumerate() {
        if i == ref_idx {
            continue;
        }
        match id_opt {
            None => {}
            Some(id) if *id == ref_id => {}
            Some(id) => {
                out.push(CrossFileDiagnostic {
                    diagnostic: Diagnostic::new(
                        "XFILE-PROJ-001",
                        Severity::Warning,
                        format!(
                            "PROJ_ID mismatch: {:?} in {:?} vs {:?} in {:?}; \
                             confirm these files belong to the same project",
                            ref_id,
                            label(labels, ref_idx),
                            id,
                            label(labels, i),
                        ),
                    )
                    .at_file(label(labels, i))
                    .at_group("PROJ"),
                    file_index: i,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;

    fn make(ags: &str) -> AgsFile {
        parse_str(ags).file
    }

    const FILE_A: &str = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P001","Site Alpha"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH01","BH"
"DATA","BH02","BH"

"GROUP","ABBR"
"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"
"UNIT","","",""
"TYPE","X","PA","X"
"DATA","LOCA_TYPE","BH","Borehole"
"#;

    const FILE_B: &str = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P001","Site Alpha"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH03","BH"
"DATA","BH04","TP"
"#;

    const FILE_C_DUP_LOCA: &str = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH01","BH"
"#;

    const FILE_D_PROJ_MISMATCH: &str = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P999","Different Project"
"#;

    const FILE_E_ABBR_CONFLICT: &str = r#""GROUP","ABBR"
"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"
"UNIT","","",""
"TYPE","X","PA","X"
"DATA","LOCA_TYPE","BH","Rotary Borehole"
"#;

    #[test]
    fn no_issues_for_consistent_files() {
        let a = make(FILE_A);
        let b = make(FILE_B);
        let diags = validate_cross_file(&[&a, &b], &["a.ags", "b.ags"]);
        assert!(diags.is_empty(), "unexpected: {diags:?}");
    }

    #[test]
    fn detects_duplicate_loca_ids() {
        let a = make(FILE_A);
        let c = make(FILE_C_DUP_LOCA);
        let diags = validate_cross_file(&[&a, &c], &["a.ags", "c.ags"]);
        let dup = diags
            .iter()
            .find(|d| d.diagnostic.rule_id == "XFILE-LOCA-001");
        assert!(dup.is_some(), "expected XFILE-LOCA-001");
        assert!(dup.unwrap().diagnostic.message.contains("BH01"));
    }

    #[test]
    fn detects_proj_mismatch() {
        let a = make(FILE_A);
        let d = make(FILE_D_PROJ_MISMATCH);
        let diags = validate_cross_file(&[&a, &d], &["a.ags", "d.ags"]);
        let mismatch = diags
            .iter()
            .find(|d| d.diagnostic.rule_id == "XFILE-PROJ-001");
        assert!(mismatch.is_some(), "expected XFILE-PROJ-001");
    }

    #[test]
    fn detects_abbr_conflict() {
        let a = make(FILE_A);
        let e = make(FILE_E_ABBR_CONFLICT);
        let diags = validate_cross_file(&[&a, &e], &["a.ags", "e.ags"]);
        let conflict = diags
            .iter()
            .find(|d| d.diagnostic.rule_id == "XFILE-ABBR-001");
        assert!(conflict.is_some(), "expected XFILE-ABBR-001");
        assert!(conflict.unwrap().diagnostic.message.contains("BH"));
    }

    #[test]
    fn no_false_positive_identical_abbr() {
        let a = make(FILE_A);
        // Same ABBR content in both files — no conflict.
        let same_abbr = r#""GROUP","ABBR"
"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"
"UNIT","","",""
"TYPE","X","PA","X"
"DATA","LOCA_TYPE","BH","Borehole"
"#;
        let b = make(same_abbr);
        let diags = validate_cross_file(&[&a, &b], &["a.ags", "same.ags"]);
        assert!(
            diags
                .iter()
                .all(|d| d.diagnostic.rule_id != "XFILE-ABBR-001"),
            "false positive ABBR conflict"
        );
    }
}
