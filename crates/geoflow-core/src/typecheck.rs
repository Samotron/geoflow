//! Value-level type compliance checking (AGS-TYPE-002).
//!
//! The AGS parser already coerces values: numeric types that fail to parse
//! are stored as `AgsValue::Raw`, and YN values with unrecognised text are
//! also stored as `Raw`. This rule surfaces those coercion failures and also
//! validates that DT and T fields contain properly-formatted dates/times.

use crate::diagnostics::{Diagnostic, Severity};
use crate::model::{AgsFile, AgsType, AgsValue};
use crate::validate::Rule;
use std::sync::LazyLock;

static DATE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$").unwrap()
});
static TIME_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\d{2}:\d{2}(:\d{2})?$").unwrap());

pub struct TypeValueRule;

impl Rule for TypeValueRule {
    fn id(&self) -> &str {
        "AGS-TYPE-002"
    }

    fn description(&self) -> &str {
        "Data values must conform to their declared AGS type"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
        for (group_name, group) in &file.groups {
            for row in &group.rows {
                for heading in &group.headings {
                    let Some(value) = row.get(&heading.name) else {
                        continue;
                    };
                    if let Some(msg) = type_violation(group_name, &heading.name, value, &heading.data_type) {
                        diagnostics.push(
                            Diagnostic::new("AGS-TYPE-002", Severity::Error, msg)
                                .at_group(group_name),
                        );
                    }
                }
            }
        }
    }
}

fn type_violation(
    group: &str,
    heading: &str,
    value: &AgsValue,
    ty: &AgsType,
) -> Option<String> {
    match (value, ty) {
        // Raw = coercion failed (numeric or YN)
        (AgsValue::Raw(s), AgsType::YN) => Some(format!(
            "{group}.{heading}: {s:?} is not a valid Y/N value (expected Y, N, YES, NO)"
        )),
        (AgsValue::Raw(s), t) if t.is_numeric() => Some(format!(
            "{group}.{heading}: {s:?} cannot be parsed as a number (declared type {})",
            type_code(t)
        )),
        // DT: must match YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS]
        (AgsValue::Text(s), AgsType::DT) if !s.is_empty() && !DATE_RE.is_match(s) => {
            Some(format!(
                "{group}.{heading}: {s:?} does not match date format YYYY-MM-DD"
            ))
        }
        // T: must match HH:MM[:SS]
        (AgsValue::Text(s), AgsType::T) if !s.is_empty() && !TIME_RE.is_match(s) => {
            Some(format!(
                "{group}.{heading}: {s:?} does not match time format HH:MM or HH:MM:SS"
            ))
        }
        _ => None,
    }
}

fn type_code(t: &AgsType) -> String {
    match t {
        AgsType::XN => "XN".into(),
        AgsType::RL => "RL".into(),
        AgsType::Dp(n) => format!("{n}DP"),
        AgsType::Sf(n) => format!("{n}SF"),
        AgsType::Sci(n) => format!("{n}SCI"),
        _ => "numeric".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;
    use crate::validate::{validate, Registry};

    fn check(input: &str) -> Vec<Diagnostic> {
        let parsed = parse_str(input);
        let r = Registry::standard();
        validate(&parsed.file, &r)
    }

    #[test]
    fn flags_bad_yn_value() {
        let input = r#""GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL","ISPT_REJ"
"UNIT","","m","","YN"
"TYPE","ID","2DP","0DP","YN"
"DATA","BH01","1.00","10","MAYBE"
"#;
        let d = check(input);
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-TYPE-002"),
            "expected AGS-TYPE-002 for bad YN, got: {d:?}"
        );
    }

    #[test]
    fn accepts_valid_yn_values() {
        let input = r#""GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL","ISPT_REJ"
"UNIT","","m","","YN"
"TYPE","ID","2DP","0DP","YN"
"DATA","BH01","1.00","10","Y"
"DATA","BH02","2.00","20","N"
"#;
        let d = check(input);
        assert!(
            !d.iter().any(|x| x.rule_id == "AGS-TYPE-002"),
            "unexpected AGS-TYPE-002 for valid YN, got: {d:?}"
        );
    }

    #[test]
    fn flags_non_numeric_in_numeric_column() {
        let input = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","BH01","not_a_number"
"#;
        let d = check(input);
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-TYPE-002"),
            "expected AGS-TYPE-002 for non-numeric, got: {d:?}"
        );
    }

    #[test]
    fn flags_bad_date_format() {
        let input = r#""GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_TOP","SAMP_REF","SAMP_DATE"
"UNIT","","m","","yyyy-mm-dd"
"TYPE","ID","2DP","ID","DT"
"DATA","BH01","1.00","S1","01/01/2024"
"#;
        let d = check(input);
        assert!(
            d.iter().any(|x| x.rule_id == "AGS-TYPE-002"),
            "expected AGS-TYPE-002 for bad date, got: {d:?}"
        );
    }

    #[test]
    fn accepts_valid_iso_date() {
        let input = r#""GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_TOP","SAMP_REF","SAMP_DATE"
"UNIT","","m","","yyyy-mm-dd"
"TYPE","ID","2DP","ID","DT"
"DATA","BH01","1.00","S1","2024-01-15"
"#;
        let d = check(input);
        assert!(
            !d.iter().any(|x| x.rule_id == "AGS-TYPE-002"),
            "unexpected AGS-TYPE-002 for valid ISO date, got: {d:?}"
        );
    }
}
