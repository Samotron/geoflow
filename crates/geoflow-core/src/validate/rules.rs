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
}
