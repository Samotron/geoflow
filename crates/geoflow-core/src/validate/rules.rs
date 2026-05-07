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
        Box::new(heading_order::HeadingOrderRule),
        Box::new(composite_key::CompositeKeyRule),
        Box::new(parent_xref::ParentGroupXrefRule),
        Box::new(tran_dlim::TranDlimRule),
        Box::new(rl_xref::RlXrefRule),
        Box::new(type_group_coverage::TypeGroupCoverageRule),
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

            // Determine TRAN_RCON separator (default "+"). PA values may be
            // concatenated with this separator, e.g. "CP+RC" = two codes.
            let separator: String = file
                .group("TRAN")
                .and_then(|t| t.rows.first())
                .and_then(|r| r.get("TRAN_RCON"))
                .and_then(|v| v.as_text())
                .unwrap_or("+")
                .to_string();

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
                            if s.is_empty() {
                                continue;
                            }
                            // Split on TRAN_RCON separator; each part must be in ABBR.
                            for part in s.split(separator.as_str()) {
                                let part = part.trim();
                                if !part.is_empty() && !codes.contains(part) {
                                    diagnostics.push(
                                        Diagnostic::new(
                                            "AGS-ABBR-001",
                                            Severity::Error,
                                            format!(
                                                "{group_name}.{}: {part:?} is not defined in ABBR group",
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
            // Only check the single-column primary key for the group ({GROUP}_ID).
            // Cross-reference ID columns (e.g. LOCA_ID in GEOL) may repeat legitimately.
            // Composite key uniqueness for multi-heading keys is handled by AGS-KEY-010.
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
            let dict = crate::dict::current_dict();
            for (group_name, group_def) in dict.iter() {
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
                        let fix =
                            if heading.name.to_ascii_uppercase().len() <= 9
                                && heading.name.to_ascii_uppercase().chars().all(|c| {
                                    c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'
                                })
                            {
                                Some("uppercase-heading-names")
                            } else {
                                None
                            };
                        let mut d = Diagnostic::new(
                            "AGS-HEAD-004",
                            Severity::Warning,
                            format!(
                                "{group_name}: heading {:?} does not follow AGS naming convention (≤9 uppercase alphanumeric/underscore chars)",
                                heading.name
                            ),
                        )
                        .at_group(group_name);
                        if let Some(f) = fix {
                            d = d.with_fix(f);
                        }
                        diagnostics.push(d);
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

// ── AGS-HEAD-007: heading order must match dictionary reference order ─────────

mod heading_order {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::AgsFile;
    use crate::validate::Rule;

    pub struct HeadingOrderRule;

    impl Rule for HeadingOrderRule {
        fn id(&self) -> &str {
            "AGS-HEAD-007"
        }

        fn description(&self) -> &str {
            "Required headings should appear in the standard dictionary reference order"
        }

        fn default_severity(&self) -> Severity {
            Severity::Warning
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            let dict = crate::dict::current_dict();
            for (group_name, group_def) in dict.iter() {
                if group_def.heading_order.len() < 2 {
                    continue;
                }
                let Some(group) = file.group(group_name) else {
                    continue;
                };

                // Build a map: heading_name -> position in actual file
                let actual_pos: std::collections::HashMap<&str, usize> = group
                    .headings
                    .iter()
                    .enumerate()
                    .map(|(i, h)| (h.name.as_str(), i))
                    .collect();

                // Walk the heading_order list; collect positions of headings
                // that actually appear in the file. They must be monotonically
                // increasing (relative order preserved).
                let positions: Vec<usize> = group_def
                    .heading_order
                    .iter()
                    .filter_map(|h| actual_pos.get(h.as_str()).copied())
                    .collect();

                if positions.len() < 2 {
                    continue;
                }

                let is_ordered = positions.windows(2).all(|w| w[0] < w[1]);
                if !is_ordered {
                    diagnostics.push(
                        Diagnostic::new(
                            "AGS-HEAD-007",
                            Severity::Warning,
                            format!(
                                "{group_name}: headings are not in the standard reference order \
                                 (expected: {})",
                                group_def.heading_order.join(", ")
                            ),
                        )
                        .at_group(group_name),
                    );
                }
            }
        }
    }
}

// ── AGS-KEY-010: generic composite key uniqueness per dictionary ──────────────

mod composite_key {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::{AgsFile, AgsValue};
    use crate::validate::Rule;
    use std::collections::HashSet;

    pub struct CompositeKeyRule;

    impl Rule for CompositeKeyRule {
        fn id(&self) -> &str {
            "AGS-KEY-010"
        }

        fn description(&self) -> &str {
            "Composite key fields must be unique within their group"
        }

        fn default_severity(&self) -> Severity {
            Severity::Error
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            let dict = crate::dict::current_dict();
            for (group_name, group_def) in dict.iter() {
                if group_def.key_headings.len() < 2 {
                    // Single-heading keys are handled by AGS-ID-001.
                    continue;
                }
                // SAMP is already covered by AGS-KEY-002; skip to avoid double.
                if group_name == "SAMP" {
                    continue;
                }
                let Some(group) = file.group(group_name) else {
                    continue;
                };

                // Only run if all key headings exist in the file.
                let all_present = group_def
                    .key_headings
                    .iter()
                    .all(|k| group.headings.iter().any(|h| &h.name == k));
                if !all_present {
                    continue;
                }

                let mut seen: HashSet<String> = HashSet::new();
                let mut reported: HashSet<String> = HashSet::new();

                for row in &group.rows {
                    let composite: String = group_def
                        .key_headings
                        .iter()
                        .map(|k| match row.get(k.as_str()) {
                            Some(AgsValue::Number(n)) => format!("{n}"),
                            Some(AgsValue::Text(s) | AgsValue::Raw(s)) => s.clone(),
                            Some(AgsValue::Bool(b)) => b.to_string(),
                            _ => String::new(),
                        })
                        .collect::<Vec<_>>()
                        .join("\x00");

                    if !seen.insert(composite.clone()) && reported.insert(composite) {
                        diagnostics.push(
                            Diagnostic::new(
                                "AGS-KEY-010",
                                Severity::Error,
                                format!(
                                    "{group_name}: duplicate composite key ({}) — key fields: {}",
                                    group_def
                                        .key_headings
                                        .iter()
                                        .map(|k| {
                                            let v = match row.get(k.as_str()) {
                                                Some(AgsValue::Number(n)) => format!("{n}"),
                                                Some(AgsValue::Text(s) | AgsValue::Raw(s)) => {
                                                    s.clone()
                                                }
                                                _ => String::new(),
                                            };
                                            format!("{k}={v:?}")
                                        })
                                        .collect::<Vec<_>>()
                                        .join(", "),
                                    group_def.key_headings.join(", ")
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

// ── AGS-XREF-PGRP: generic parent group referential integrity (Rule 10c) ──────

mod parent_xref {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::{AgsFile, AgsValue};
    use crate::validate::Rule;
    use std::collections::HashSet;

    pub struct ParentGroupXrefRule;

    impl Rule for ParentGroupXrefRule {
        fn id(&self) -> &str {
            "AGS-XREF-PGRP"
        }

        fn description(&self) -> &str {
            "Child group rows must reference an existing parent group composite key"
        }

        fn default_severity(&self) -> Severity {
            Severity::Error
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            let dict = crate::dict::current_dict();

            for (group_name, group_def) in dict.iter() {
                let Some(parent_name) = &group_def.parent_group else {
                    continue;
                };
                // XrefLocaRule already handles LOCA-parent cases.
                if parent_name == "LOCA" {
                    continue;
                }

                let Some(child_group) = file.group(group_name) else {
                    continue;
                };
                let Some(parent_group_def) = dict.get(parent_name.as_str()) else {
                    continue;
                };
                let Some(parent_group) = file.group(parent_name) else {
                    continue;
                };

                // Shared key headings between child and parent.
                let shared_keys: Vec<&String> = group_def
                    .key_headings
                    .iter()
                    .filter(|k| parent_group_def.key_headings.contains(k))
                    .collect();

                if shared_keys.is_empty() {
                    continue;
                }

                // Build set of parent composite keys.
                let parent_keys: HashSet<String> = parent_group
                    .rows
                    .iter()
                    .map(|row| {
                        shared_keys
                            .iter()
                            .map(|k| match row.get(k.as_str()) {
                                Some(AgsValue::Number(n)) => format!("{n}"),
                                Some(AgsValue::Text(s) | AgsValue::Raw(s)) => s.clone(),
                                _ => String::new(),
                            })
                            .collect::<Vec<_>>()
                            .join("\x00")
                    })
                    .collect();

                // Check each child row.
                for row in &child_group.rows {
                    let child_key: String = shared_keys
                        .iter()
                        .map(|k| match row.get(k.as_str()) {
                            Some(AgsValue::Number(n)) => format!("{n}"),
                            Some(AgsValue::Text(s) | AgsValue::Raw(s)) => s.clone(),
                            _ => String::new(),
                        })
                        .collect::<Vec<_>>()
                        .join("\x00");

                    // Skip rows where all shared key fields are empty.
                    if child_key.replace('\x00', "").is_empty() {
                        continue;
                    }

                    if !parent_keys.contains(&child_key) {
                        let key_desc = shared_keys
                            .iter()
                            .map(|k| {
                                let v = match row.get(k.as_str()) {
                                    Some(AgsValue::Number(n)) => format!("{n}"),
                                    Some(AgsValue::Text(s) | AgsValue::Raw(s)) => s.clone(),
                                    _ => String::new(),
                                };
                                format!("{k}={v:?}")
                            })
                            .collect::<Vec<_>>()
                            .join(", ");
                        diagnostics.push(
                            Diagnostic::new(
                                "AGS-XREF-PGRP",
                                Severity::Error,
                                format!(
                                    "{group_name}: row ({key_desc}) has no matching parent in {parent_name}"
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

// ── AGS-TRAN-001: TRAN_DLIM required when RL-type fields exist (Rule 11) ──────

mod tran_dlim {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::{AgsFile, AgsType};
    use crate::validate::Rule;

    pub struct TranDlimRule;

    impl Rule for TranDlimRule {
        fn id(&self) -> &str {
            "AGS-TRAN-001"
        }

        fn description(&self) -> &str {
            "TRAN_DLIM must be declared in TRAN when any RL-type field is used"
        }

        fn default_severity(&self) -> Severity {
            Severity::Warning
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            let has_rl = file
                .groups
                .values()
                .any(|g| g.headings.iter().any(|h| h.data_type == AgsType::RL));
            if !has_rl {
                return;
            }

            let tran_has_dlim = file
                .group("TRAN")
                .map(|t| t.headings.iter().any(|h| h.name == "TRAN_DLIM"))
                .unwrap_or(false);

            if !tran_has_dlim {
                diagnostics.push(Diagnostic::new(
                    "AGS-TRAN-001",
                    Severity::Warning,
                    "file contains RL-type headings but TRAN does not declare TRAN_DLIM"
                        .to_string(),
                ));
            }
        }
    }
}

// ── AGS-RL-001: RL field values must resolve to existing rows (Rule 11c) ──────

mod rl_xref {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::{AgsFile, AgsType, AgsValue};
    use crate::validate::Rule;
    use std::collections::HashSet;

    pub struct RlXrefRule;

    impl Rule for RlXrefRule {
        fn id(&self) -> &str {
            "AGS-RL-001"
        }

        fn description(&self) -> &str {
            "RL-type field values (GROUP:ID) must reference an existing group and ID"
        }

        fn default_severity(&self) -> Severity {
            Severity::Error
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            // Determine delimiter from TRAN_DLIM (default ":").
            let delimiter: String = file
                .group("TRAN")
                .and_then(|t| t.rows.first())
                .and_then(|r| r.get("TRAN_DLIM"))
                .and_then(|v| v.as_text())
                .filter(|s| !s.is_empty())
                .unwrap_or(":")
                .to_string();

            // Build a cross-index: group_name → set of all ID-column values.
            let mut id_index: std::collections::HashMap<&str, HashSet<String>> =
                std::collections::HashMap::new();
            for (group_name, group) in &file.groups {
                for heading in &group.headings {
                    if heading.data_type != AgsType::ID {
                        continue;
                    }
                    let entry = id_index.entry(group_name.as_str()).or_default();
                    for row in &group.rows {
                        if let Some(v) = row.get(&heading.name).and_then(|v| v.as_text()) {
                            if !v.is_empty() {
                                entry.insert(v.to_string());
                            }
                        }
                    }
                }
            }

            for (group_name, group) in &file.groups {
                for heading in &group.headings {
                    if heading.data_type != AgsType::RL {
                        continue;
                    }
                    for row in &group.rows {
                        let Some(AgsValue::Text(s) | AgsValue::Raw(s)) = row.get(&heading.name)
                        else {
                            continue;
                        };
                        if s.is_empty() {
                            continue;
                        }
                        // Parse "TARGET_GROUP:ID_VALUE" using the delimiter.
                        let Some((target_group, target_id)) = s.split_once(delimiter.as_str())
                        else {
                            diagnostics.push(
                                Diagnostic::new(
                                    "AGS-RL-001",
                                    Severity::Error,
                                    format!(
                                        "{group_name}.{}: RL value {s:?} does not contain delimiter {:?}",
                                        heading.name, delimiter
                                    ),
                                )
                                .at_group(group_name),
                            );
                            continue;
                        };
                        let target_group = target_group.trim();
                        let target_id = target_id.trim();
                        match id_index.get(target_group) {
                            None => {
                                diagnostics.push(
                                    Diagnostic::new(
                                        "AGS-RL-001",
                                        Severity::Error,
                                        format!(
                                            "{group_name}.{}: RL references group {target_group:?} which does not exist",
                                            heading.name
                                        ),
                                    )
                                    .at_group(group_name),
                                );
                            }
                            Some(ids) if !ids.contains(target_id) => {
                                diagnostics.push(
                                    Diagnostic::new(
                                        "AGS-RL-001",
                                        Severity::Error,
                                        format!(
                                            "{group_name}.{}: RL value {target_id:?} not found in {target_group}",
                                            heading.name
                                        ),
                                    )
                                    .at_group(group_name),
                                );
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
}

// ── AGS-TYPE-003: TYPE group must cover all data types used (Rule 17) ─────────

mod type_group_coverage {
    use crate::diagnostics::{Diagnostic, Severity};
    use crate::model::AgsFile;
    use crate::validate::Rule;
    use std::collections::HashSet;

    pub struct TypeGroupCoverageRule;

    impl Rule for TypeGroupCoverageRule {
        fn id(&self) -> &str {
            "AGS-TYPE-003"
        }

        fn description(&self) -> &str {
            "All AGS type codes used in the file must be listed in the TYPE group"
        }

        fn default_severity(&self) -> Severity {
            Severity::Warning
        }

        fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
            let Some(type_group) = file.group("TYPE") else {
                return;
            };

            // Collect TYPE_STAT values from TYPE group.
            let type_stats: HashSet<String> = type_group
                .rows
                .iter()
                .filter_map(|r| r.get("TYPE_STAT").and_then(|v| v.as_text()))
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();

            if type_stats.is_empty() {
                return;
            }

            // Collect all unique type codes used across all group headings.
            for (group_name, group) in &file.groups {
                if group_name == "TYPE" {
                    continue;
                }
                for heading in &group.headings {
                    let code = type_code_str(&heading.data_type);
                    if !type_stats.contains(&code) {
                        diagnostics.push(
                            Diagnostic::new(
                                "AGS-TYPE-003",
                                Severity::Warning,
                                format!(
                                    "{group_name}.{}: type code {code:?} is not listed in TYPE group",
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

    fn type_code_str(t: &crate::model::AgsType) -> String {
        use crate::model::AgsType;
        match t {
            AgsType::X => "X".into(),
            AgsType::XN => "XN".into(),
            AgsType::MC => "MC".into(),
            AgsType::ID => "ID".into(),
            AgsType::PA => "PA".into(),
            AgsType::PT => "PT".into(),
            AgsType::PU => "PU".into(),
            AgsType::T => "T".into(),
            AgsType::DT => "DT".into(),
            AgsType::YN => "YN".into(),
            AgsType::RL => "RL".into(),
            AgsType::U => "U".into(),
            AgsType::RecordLink => "RECORD_LINK".into(),
            AgsType::DMS => "DMS".into(),
            AgsType::Dp(n) => format!("{n}DP"),
            AgsType::Sf(n) => format!("{n}SF"),
            AgsType::Sci(n) => format!("{n}SCI"),
            AgsType::Other(s) => s.clone(),
        }
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
            let dict_arc = crate::dict::current_dict();
            let dict = &*dict_arc;

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
