//! Built-in AGS 4.x validation rules.
//!
//! Most rules are now expressed in the DSL pack embedded below.
//! Legacy Rust rules are being phased out.

use crate::dsl::LoadedPack;
use crate::validate::Rule;

/// Return all built-in Rust-based validation rules.
pub fn standard_rules() -> Vec<Box<dyn Rule>> {
    vec![
        Box::new(crate::dict::DictRequiredHeadingsRule),
        Box::new(crate::dict::DictDepthUnitsRule),
        Box::new(crate::typecheck::TypeValueRule),
        Box::new(abbr::AbbrCodelistRule),
        Box::new(unit::UnitCodelistRule),
    ]
}

/// Return all built-in DSL rule packs.
pub fn standard_packs() -> Vec<LoadedPack> {
    let pack = crate::dsl::RulePack::parse(STANDARD_PACK_YAML)
        .expect("built-in standard pack must be valid YAML")
        .into_loaded()
        .expect("built-in standard pack must not have external dependencies");
    vec![pack]
}

const STANDARD_PACK_YAML: &str = include_str!("../../../../rules/specs/ags/standard/4.x/pack.yml");

// ── AGS-ABBR-001: PA field values must be defined in ABBR group ──────────────

mod abbr {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::{AgsFile, AgsType};
    use crate::validate::Rule;
    use std::collections::{HashMap, HashSet};

    pub struct AbbrCodelistRule;

    impl Rule for AbbrCodelistRule {
        fn id(&self) -> &str {
            "AGS-ABBR-001"
        }

        fn description(&self) -> &str {
            "PA-type field values must be defined in the ABBR group"
        }

        fn default_severity(&self) -> Severity {
            Severity::Error
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            let Some(abbr_group) = file.group("ABBR") else {
                return;
            };

            // Build map: heading_name → permitted codes
            let mut permitted: HashMap<String, HashSet<String>> = HashMap::new();
            for row in &abbr_group.rows {
                let hdng = row.get("ABBR_HDNG").and_then(|v| v.as_text());
                let code = row.get("ABBR_CODE").and_then(|v| v.as_text());
                if let (Some(h), Some(c)) = (hdng, code) {
                    if !h.is_empty() && !c.is_empty() {
                        permitted
                            .entry(h.to_string())
                            .or_default()
                            .insert(c.to_string());
                    }
                }
            }

            if permitted.is_empty() {
                return;
            }

            for (group_name, group) in &file.groups {
                for heading in &group.headings {
                    if heading.data_type != AgsType::PA {
                        continue;
                    }
                    let Some(codes) = permitted.get(&heading.name) else {
                        continue;
                    };
                    for row in &group.rows {
                        let Some(val) = row.get(&heading.name) else {
                            continue;
                        };
                        if let Some(s) = val.as_text() {
                            if !s.is_empty() && !codes.contains(s) {
                                diagnostics.push(
                                    Diagnostic::new(
                                        "AGS-ABBR-001",
                                        Severity::Error,
                                        format!(
                                            "{group_name}.{}: {s:?} is not defined in ABBR group",
                                            heading.name
                                        ),
                                    )
                                    .at_group(group_name),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use crate::ags::parse_str;
        use crate::validate::{validate, Registry};

        fn check(input: &str) -> Vec<crate::diagnostics::Diagnostic> {
            let parsed = parse_str(input);
            let r = Registry::standard();
            validate(&parsed.file, &r)
        }

        #[test]
        fn valid_abbr_code_passes() {
            let input = r#""GROUP","ABBR"
"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"
"UNIT","","",""
"TYPE","X","X","X"
"DATA","GEOL_LEG","CL","Clay"
"DATA","GEOL_LEG","SA","Sand"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_LEG"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","PA"
"DATA","BH1","0.00","1.00","CL"
"#;
            let d = check(input);
            assert!(
                !d.iter().any(|x| x.rule_id == "AGS-ABBR-001"),
                "unexpected AGS-ABBR-001: {d:?}"
            );
        }

        #[test]
        fn invalid_abbr_code_fires() {
            let input = r#""GROUP","ABBR"
"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"
"UNIT","","",""
"TYPE","X","X","X"
"DATA","GEOL_LEG","CL","Clay"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_LEG"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","PA"
"DATA","BH1","0.00","1.00","UNKNOWN_CODE"
"#;
            let d = check(input);
            assert!(
                d.iter().any(|x| x.rule_id == "AGS-ABBR-001"),
                "expected AGS-ABBR-001, got: {d:?}"
            );
        }

        #[test]
        fn no_abbr_group_skips_check() {
            let input = r#""GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_LEG"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","PA"
"DATA","BH1","0.00","1.00","CL"
"#;
            let d = check(input);
            assert!(
                !d.iter().any(|x| x.rule_id == "AGS-ABBR-001"),
                "should not fire without ABBR group: {d:?}"
            );
        }

        #[test]
        fn empty_pa_value_skipped() {
            let input = r#""GROUP","ABBR"
"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"
"UNIT","","",""
"TYPE","X","X","X"
"DATA","GEOL_LEG","CL","Clay"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_LEG"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","PA"
"DATA","BH1","0.00","1.00",""
"#;
            let d = check(input);
            assert!(
                !d.iter().any(|x| x.rule_id == "AGS-ABBR-001"),
                "empty PA value should not fire: {d:?}"
            );
        }
    }
}

// ── AGS-UNIT-001: PU field values must be defined in UNIT group ──────────────

mod unit {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::{AgsFile, AgsType};
    use crate::validate::Rule;
    use std::collections::HashSet;

    pub struct UnitCodelistRule;

    impl Rule for UnitCodelistRule {
        fn id(&self) -> &str {
            "AGS-UNIT-001"
        }

        fn description(&self) -> &str {
            "PU-type field values must be defined in the UNIT group"
        }

        fn default_severity(&self) -> Severity {
            Severity::Warning
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            let Some(unit_group) = file.group("UNIT") else {
                return;
            };

            // Collect permitted unit abbreviations
            let permitted: HashSet<String> = unit_group
                .rows
                .iter()
                .filter_map(|row| row.get("UNIT_ABBR").and_then(|v| v.as_text()))
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();

            if permitted.is_empty() {
                return;
            }

            for (group_name, group) in &file.groups {
                if group_name == "UNIT" {
                    continue;
                }
                for heading in &group.headings {
                    if heading.data_type != AgsType::PU {
                        continue;
                    }
                    for row in &group.rows {
                        let Some(val) = row.get(&heading.name) else {
                            continue;
                        };
                        if let Some(s) = val.as_text() {
                            if !s.is_empty() && !permitted.contains(s) {
                                diagnostics.push(
                                    Diagnostic::new(
                                        "AGS-UNIT-001",
                                        Severity::Warning,
                                        format!(
                                            "{group_name}.{}: unit {s:?} is not defined in UNIT group",
                                            heading.name
                                        ),
                                    )
                                    .at_group(group_name),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use crate::ags::parse_str;
        use crate::validate::{validate, Registry};

        fn check(input: &str) -> Vec<crate::diagnostics::Diagnostic> {
            let parsed = parse_str(input);
            let r = Registry::standard();
            validate(&parsed.file, &r)
        }

        #[test]
        fn valid_unit_code_passes() {
            let input = r#""GROUP","UNIT"
"HEADING","UNIT_ABBR","UNIT_DESC"
"UNIT","",""
"TYPE","X","X"
"DATA","m","metres"
"DATA","kN/m2","kilonewtons per square metre"

"GROUP","LLPL"
"HEADING","LOCA_ID","LLPL_LL","LLPL_UNIT"
"UNIT","","%","kN/m2"
"TYPE","ID","2DP","PU"
"DATA","BH1","45.0","kN/m2"
"#;
            let d = check(input);
            assert!(
                !d.iter().any(|x| x.rule_id == "AGS-UNIT-001"),
                "unexpected AGS-UNIT-001: {d:?}"
            );
        }

        #[test]
        fn invalid_unit_code_fires() {
            let input = r#""GROUP","UNIT"
"HEADING","UNIT_ABBR","UNIT_DESC"
"UNIT","",""
"TYPE","X","X"
"DATA","m","metres"

"GROUP","LLPL"
"HEADING","LOCA_ID","LLPL_LL","LLPL_UNIT"
"UNIT","","%","kN/m2"
"TYPE","ID","2DP","PU"
"DATA","BH1","45.0","psi"
"#;
            let d = check(input);
            assert!(
                d.iter().any(|x| x.rule_id == "AGS-UNIT-001"),
                "expected AGS-UNIT-001, got: {d:?}"
            );
        }

        #[test]
        fn no_unit_group_skips_check() {
            let input = r#""GROUP","LLPL"
"HEADING","LOCA_ID","LLPL_LL","LLPL_UNIT"
"UNIT","","%","kN/m2"
"TYPE","ID","2DP","PU"
"DATA","BH1","45.0","psi"
"#;
            let d = check(input);
            assert!(
                !d.iter().any(|x| x.rule_id == "AGS-UNIT-001"),
                "should not fire without UNIT group: {d:?}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::ags::parse_str;
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::validate::{validate, Registry};

    fn check(input: &str) -> Vec<Diagnostic> {
        let parsed = parse_str(input);
        let r = Registry::standard();
        validate(&parsed.file, &r)
    }

    #[test]
    fn flags_missing_proj() {
        let d = check(
            r#""GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"
"#,
        );
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-STRUCT-001"),
            "got diagnostics: {d:?}"
        );
    }

    #[test]
    fn flags_missing_tran() {
        let d = check(
            r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"
"#,
        );
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-STRUCT-002"),
            "got diagnostics: {d:?}"
        );
    }

    #[test]
    fn flags_xref_mismatch() {
        let input = r#""GROUP","PROJ"
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
"DATA","BH01"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BHX","0.00","1.00"
"#;
        let d = check(input);
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-XREF-001"),
            "expected AGS-XREF-001, got: {d:?}"
        );
    }

    #[test]
    fn flags_geol_depth_inversion() {
        let input = r#""GROUP","PROJ"
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
"DATA","BH01"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","2.00","1.00"
"#;
        let d = check(input);
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-VAL-001"),
            "got diagnostics: {d:?}"
        );
    }

    #[test]
    fn trailing_whitespace_rule_fires_and_carries_fix_id() {
        let input = "\"GROUP\",\"PROJ\"\r\n\"HEADING\",\"PROJ_ID\"\r\n\"UNIT\",\"\"\r\n\"TYPE\",\"ID\"\r\n\"DATA\",\"P1  \"\r\n";
        let parsed = crate::ags::parse_str(input);
        let r = Registry::standard();
        let d = validate(&parsed.file, &r);
        let fmt = d.iter().find(|x| x.rule_id == "AGS-FMT-001");
        assert!(
            fmt.is_some(),
            "AGS-FMT-001 should fire on trailing whitespace"
        );
        assert_eq!(
            fmt.unwrap().fix_id.as_deref(),
            Some("normalize-whitespace"),
            "fix_id should be set"
        );
    }

    #[test]
    fn trailing_whitespace_rule_silent_on_clean_values() {
        let input = "\"GROUP\",\"PROJ\"\r\n\"HEADING\",\"PROJ_ID\"\r\n\"UNIT\",\"\"\r\n\"TYPE\",\"ID\"\r\n\"DATA\",\"P1\"\r\n";
        let parsed = crate::ags::parse_str(input);
        let r = Registry::standard();
        let d = validate(&parsed.file, &r);
        assert!(!d.iter().any(|x| x.rule_id == "AGS-FMT-001"));
    }

    #[test]
    fn minimal_fixture_is_clean() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("ags")
            .join("minimal_valid.ags");
        let bytes = std::fs::read(path).unwrap();
        let parsed = crate::ags::parse_bytes(&bytes);
        assert!(parsed.diagnostics.is_empty());
        let r = Registry::standard();
        let d = validate(&parsed.file, &r);
        // Only allow non-error diagnostics on the clean fixture.
        let errors: Vec<_> = d.iter().filter(|x| x.severity == Severity::Error).collect();
        assert!(errors.is_empty(), "errors on clean fixture: {errors:?}");
    }

    #[test]
    fn flags_unknown_tran_ags_version() {
        let input = r#""GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.99"
"#;
        let d = check(input);
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-STRUCT-004"),
            "expected AGS-STRUCT-004, got: {d:?}"
        );
    }

    #[test]
    fn accepted_tran_ags_versions() {
        for ver in ["4.0.3", "4.0.4", "4.1"] {
            let input = format!(
                r#""GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","{ver}"
"#
            );
            let d = check(&input);
            assert!(
                !d.iter().any(|x| x.rule_id == "AGS-STRUCT-004"),
                "version {ver} should not fire AGS-STRUCT-004, got: {d:?}"
            );
        }
    }

    #[test]
    fn flags_duplicate_loca_id() {
        let input = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","X"
"DATA","BH01","CP"
"DATA","BH01","CP"
"#;
        let d = check(input);
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-KEY-001"),
            "expected AGS-KEY-001, got: {d:?}"
        );
    }

    #[test]
    fn unique_loca_ids_pass() {
        let input = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","X"
"DATA","BH01","CP"
"DATA","BH02","CP"
"#;
        let d = check(input);
        assert!(
            !d.iter().any(|x| x.rule_id == "AGS-KEY-001"),
            "unique LOCA_IDs should not fire AGS-KEY-001: {d:?}"
        );
    }

    #[test]
    fn flags_ispt_orphan_loca() {
        let input = r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL"
"UNIT","","m",""
"TYPE","ID","2DP","XN"
"DATA","GHOST","1.00","10"
"#;
        let d = check(input);
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-XREF-003"),
            "expected AGS-XREF-003, got: {d:?}"
        );
    }

    #[test]
    fn flags_wstk_orphan_loca() {
        let input = r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","WSTK"
"HEADING","LOCA_ID","WSTK_DPTH"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","GHOST","3.50"
"#;
        let d = check(input);
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-XREF-004"),
            "expected AGS-XREF-004, got: {d:?}"
        );
    }

    #[test]
    fn flags_hole_orphan_loca() {
        let input = r#""GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","HOLE"
"HEADING","LOCA_ID","HOLE_DPTH"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","GHOST","5.00"
"#;
        let d = check(input);
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-XREF-005"),
            "expected AGS-XREF-005, got: {d:?}"
        );
    }
}
