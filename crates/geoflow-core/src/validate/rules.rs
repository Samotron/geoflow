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
        Box::new(xref_loca::XrefLocaRule),
        Box::new(id_unique::IdColumnUniquenessRule),
        Box::new(samp_key::SampCompositeKeyRule),
        Box::new(required_nonempty::RequiredNonEmptyRule),
        Box::new(heading_fmt::HeadingNameFormatRule),
        Box::new(empty_group::EmptyGroupRule),
        Box::new(nonstandard_heading::NonstandardHeadingRule),
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

// ── AGS-XREF-LOCA: generic LOCA_ID cross-reference check ────────────────────

mod xref_loca {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::AgsFile;
    use crate::validate::Rule;
    use std::collections::HashSet;

    pub struct XrefLocaRule;

    impl Rule for XrefLocaRule {
        fn id(&self) -> &str {
            "AGS-XREF-LOCA"
        }

        fn description(&self) -> &str {
            "All LOCA_ID references must resolve to an existing LOCA row"
        }

        fn default_severity(&self) -> Severity {
            Severity::Error
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            let Some(loca_group) = file.group("LOCA") else {
                return;
            };

            let loca_ids: HashSet<String> = loca_group
                .rows
                .iter()
                .filter_map(|r| r.get("LOCA_ID").and_then(|v| v.as_text()))
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();

            for (group_name, group) in &file.groups {
                if group_name == "LOCA" {
                    continue;
                }
                if !group.headings.iter().any(|h| h.name == "LOCA_ID") {
                    continue;
                }
                for row in &group.rows {
                    if let Some(id_val) = row.get("LOCA_ID").and_then(|v| v.as_text()) {
                        if !id_val.is_empty() && !loca_ids.contains(id_val) {
                            diagnostics.push(
                                Diagnostic::new(
                                    "AGS-XREF-LOCA",
                                    Severity::Error,
                                    format!(
                                        "{group_name}: LOCA_ID {id_val:?} does not exist in LOCA"
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

// ── AGS-ID-001: primary key ID column uniqueness ─────────────────────────────

mod id_unique {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::{AgsFile, AgsType};
    use crate::validate::Rule;
    use std::collections::HashSet;

    pub struct IdColumnUniquenessRule;

    impl Rule for IdColumnUniquenessRule {
        fn id(&self) -> &str {
            "AGS-ID-001"
        }

        fn description(&self) -> &str {
            "ID-type primary key columns must have unique values within their group"
        }

        fn default_severity(&self) -> Severity {
            Severity::Error
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            for (group_name, group) in &file.groups {
                let primary_key = format!("{group_name}_ID");
                for heading in &group.headings {
                    if heading.name != primary_key || heading.data_type != AgsType::ID {
                        continue;
                    }
                    let mut seen: HashSet<String> = HashSet::new();
                    let mut reported: HashSet<String> = HashSet::new();
                    for row in &group.rows {
                        if let Some(val) = row.get(&heading.name).and_then(|v| v.as_text()) {
                            if !val.is_empty()
                                && !seen.insert(val.to_string())
                                && reported.insert(val.to_string())
                            {
                                diagnostics.push(
                                    Diagnostic::new(
                                        "AGS-ID-001",
                                        Severity::Error,
                                        format!(
                                            "{group_name}.{}: duplicate value {val:?}",
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
}

// ── AGS-KEY-002: SAMP composite key uniqueness ────────────────────────────────

mod samp_key {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::AgsFile;
    use crate::validate::Rule;
    use std::collections::HashSet;

    pub struct SampCompositeKeyRule;

    impl Rule for SampCompositeKeyRule {
        fn id(&self) -> &str {
            "AGS-KEY-002"
        }

        fn description(&self) -> &str {
            "Within a borehole, LOCA_ID + SAMP_TOP + SAMP_REF must be unique in SAMP"
        }

        fn default_severity(&self) -> Severity {
            Severity::Error
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            let Some(samp) = file.group("SAMP") else {
                return;
            };

            let mut seen: HashSet<String> = HashSet::new();
            let mut reported: HashSet<String> = HashSet::new();

            for row in &samp.rows {
                let loca_id = row
                    .get("LOCA_ID")
                    .and_then(|v| v.as_text())
                    .unwrap_or("")
                    .to_string();
                let samp_top = match row.get("SAMP_TOP") {
                    Some(v) => match v {
                        crate::model::AgsValue::Number(n) => format!("{n}"),
                        crate::model::AgsValue::Text(s) | crate::model::AgsValue::Raw(s) => {
                            s.clone()
                        }
                        _ => String::new(),
                    },
                    None => String::new(),
                };
                let samp_ref = row
                    .get("SAMP_REF")
                    .and_then(|v| v.as_text())
                    .unwrap_or("")
                    .to_string();

                let composite = format!("{loca_id}\x00{samp_top}\x00{samp_ref}");
                if !seen.insert(composite.clone()) && reported.insert(composite) {
                    diagnostics.push(
                        Diagnostic::new(
                            "AGS-KEY-002",
                            Severity::Error,
                            format!(
                                "SAMP: duplicate composite key LOCA_ID={loca_id:?} SAMP_TOP={samp_top:?} SAMP_REF={samp_ref:?}"
                            ),
                        )
                        .at_group("SAMP"),
                    );
                }
            }
        }
    }
}

// ── AGS-DICT-003: required headings must not be empty ────────────────────────

mod required_nonempty {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::{AgsFile, AgsValue};
    use crate::validate::Rule;

    pub struct RequiredNonEmptyRule;

    impl Rule for RequiredNonEmptyRule {
        fn id(&self) -> &str {
            "AGS-DICT-003"
        }

        fn description(&self) -> &str {
            "Required headings must have non-empty values in every DATA row"
        }

        fn default_severity(&self) -> Severity {
            Severity::Error
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            let dict = crate::dict::ags4_dict();
            for (group_name, group_def) in dict {
                if group_def.required_headings.is_empty() {
                    continue;
                }
                let Some(group) = file.group(group_name) else {
                    continue;
                };
                for req in &group_def.required_headings {
                    // AGS-DICT-001 covers absence; here we only flag empty values.
                    if !group.headings.iter().any(|h| &h.name == req) {
                        continue;
                    }
                    for row in &group.rows {
                        let empty = match row.get(req.as_str()) {
                            None | Some(AgsValue::Null) => true,
                            Some(AgsValue::Text(s)) | Some(AgsValue::Raw(s)) => s.is_empty(),
                            _ => false,
                        };
                        if empty {
                            diagnostics.push(
                                Diagnostic::new(
                                    "AGS-DICT-003",
                                    Severity::Error,
                                    format!(
                                        "{group_name}.{req}: required heading has an empty value"
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

// ── AGS-HEAD-004: heading name format (Rule 19a) ─────────────────────────────

mod heading_fmt {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::AgsFile;
    use crate::validate::Rule;

    pub struct HeadingNameFormatRule;

    impl Rule for HeadingNameFormatRule {
        fn id(&self) -> &str {
            "AGS-HEAD-004"
        }

        fn description(&self) -> &str {
            "Heading names should be ≤9 characters, uppercase alphanumeric and underscore only"
        }

        fn default_severity(&self) -> Severity {
            Severity::Warning
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            for (group_name, group) in &file.groups {
                for heading in &group.headings {
                    if !is_valid_heading_name(&heading.name) {
                        diagnostics.push(
                            Diagnostic::new(
                                "AGS-HEAD-004",
                                Severity::Warning,
                                format!(
                                    "{group_name}: heading {:?} does not follow AGS naming convention (≤9 uppercase alphanumeric/underscore chars)",
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

    fn is_valid_heading_name(name: &str) -> bool {
        !name.is_empty()
            && name.len() <= 9
            && name
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    }
}

// ── AGS-STRUCT-005: groups must contain at least one DATA row (Rule 2) ────────

mod empty_group {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::AgsFile;
    use crate::validate::Rule;

    pub struct EmptyGroupRule;

    impl Rule for EmptyGroupRule {
        fn id(&self) -> &str {
            "AGS-STRUCT-005"
        }

        fn description(&self) -> &str {
            "Every group must contain at least one DATA row"
        }

        fn default_severity(&self) -> Severity {
            Severity::Warning
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            for (group_name, group) in &file.groups {
                if group.rows.is_empty() {
                    diagnostics.push(
                        Diagnostic::new(
                            "AGS-STRUCT-005",
                            Severity::Warning,
                            format!("{group_name}: group has no DATA rows"),
                        )
                        .at_group(group_name),
                    );
                }
            }
        }
    }
}

// ── AGS-DICT-004/005: non-standard heading detection ─────────────────────────

mod nonstandard_heading {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::AgsFile;
    use crate::validate::Rule;

    pub struct NonstandardHeadingRule;

    impl Rule for NonstandardHeadingRule {
        fn id(&self) -> &str {
            "AGS-DICT-004"
        }

        fn description(&self) -> &str {
            "Non-standard headings should be declared in the DICT group"
        }

        fn default_severity(&self) -> Severity {
            Severity::Warning
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            let dict = crate::dict::ags4_dict();

            // Collect headings defined in the file's DICT group (user-defined).
            let mut dict_defined: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            if let Some(dict_group) = file.group("DICT") {
                for row in &dict_group.rows {
                    if let Some(h) = row.get("DICT_HDNG").and_then(|v| v.as_text()) {
                        if !h.is_empty() {
                            dict_defined.insert(h.to_string());
                        }
                    }
                }
            }
            let has_dict_group = file.group("DICT").is_some();

            let mut any_nonstandard = false;

            for (group_name, group) in &file.groups {
                let known_headings: Option<&Vec<String>> =
                    dict.get(group_name.as_str()).map(|d| &d.required_headings);

                for heading in &group.headings {
                    // Skip standard reserved groups entirely.
                    if matches!(
                        group_name.as_str(),
                        "PROJ" | "TRAN" | "ABBR" | "TYPE" | "UNIT" | "DICT" | "DEFS"
                    ) {
                        continue;
                    }

                    let is_known_standard = match known_headings {
                        Some(req) => req.contains(&heading.name),
                        None => false,
                    };

                    // A heading is non-standard if it's not in the dict AND not
                    // user-declared in DICT, and not a LOCA_ID cross-reference.
                    if !is_known_standard
                        && heading.name != "LOCA_ID"
                        && !dict_defined.contains(&heading.name)
                    {
                        any_nonstandard = true;
                        diagnostics.push(
                            Diagnostic::new(
                                "AGS-DICT-004",
                                Severity::Warning,
                                format!(
                                    "{group_name}: heading {:?} is not in the standard AGS dictionary",
                                    heading.name
                                ),
                            )
                            .at_group(group_name),
                        );
                    }
                }
            }

            // AGS-DICT-005: non-standard headings present but no DICT group.
            if any_nonstandard && !has_dict_group {
                diagnostics.push(Diagnostic::new(
                    "AGS-DICT-005",
                    Severity::Warning,
                    "file contains non-standard headings but has no DICT group to define them"
                        .to_string(),
                ));
            }
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
            d.iter().any(|x| x.rule_id == "AGS-XREF-LOCA"),
            "expected AGS-XREF-LOCA, got: {d:?}"
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
            d.iter().any(|x| x.rule_id == "AGS-ID-001"),
            "expected AGS-ID-001, got: {d:?}"
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
            !d.iter().any(|x| x.rule_id == "AGS-ID-001"),
            "unique LOCA_IDs should not fire AGS-ID-001: {d:?}"
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
            d.iter().any(|x| x.rule_id == "AGS-XREF-LOCA"),
            "expected AGS-XREF-LOCA, got: {d:?}"
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
            d.iter().any(|x| x.rule_id == "AGS-XREF-LOCA"),
            "expected AGS-XREF-LOCA, got: {d:?}"
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
            d.iter().any(|x| x.rule_id == "AGS-XREF-LOCA"),
            "expected AGS-XREF-LOCA, got: {d:?}"
        );
    }
}
