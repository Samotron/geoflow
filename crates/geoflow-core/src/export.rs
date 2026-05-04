//! Export AGS data to CSV (one string per group).

use crate::model::{AgsFile, AgsValue};
use indexmap::IndexMap;

/// Serialise every group in `file` to a map of `group_name → CSV text`.
///
/// Each CSV starts with a header row of heading names, then one data row per
/// AGS DATA row. Values are quoted when they contain commas, double-quotes,
/// or newlines.
pub fn to_csv(file: &AgsFile) -> IndexMap<String, String> {
    let mut result = IndexMap::new();
    for (group_name, group) in &file.groups {
        let mut out = String::new();
        let names: Vec<&str> = group.headings.iter().map(|h| h.name.as_str()).collect();

        // header
        for (i, n) in names.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&csv_field(n));
        }
        out.push('\n');

        // data rows
        for row in &group.rows {
            for (i, n) in names.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let cell = match row.get(*n) {
                    None | Some(AgsValue::Null) => String::new(),
                    Some(AgsValue::Number(f)) => format_number(*f),
                    Some(AgsValue::Bool(true)) => "Y".into(),
                    Some(AgsValue::Bool(false)) => "N".into(),
                    Some(AgsValue::Text(s) | AgsValue::Raw(s)) => s.clone(),
                };
                out.push_str(&csv_field(&cell));
            }
            out.push('\n');
        }

        result.insert(group_name.clone(), out);
    }
    result
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;

    #[test]
    fn exports_simple_group() {
        let input = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","Test, Project"
"#;
        let file = parse_str(input).file;
        let csvs = to_csv(&file);
        let proj = csvs.get("PROJ").expect("PROJ group");
        assert!(proj.starts_with("PROJ_ID,PROJ_NAME\n"));
        assert!(proj.contains("P1,\"Test, Project\""));
    }

    #[test]
    fn empty_group_produces_header_only() {
        let input = r#""GROUP","WSTK"
"HEADING","LOCA_ID","WSTK_DPTH"
"UNIT","","m"
"TYPE","ID","2DP"
"#;
        let file = parse_str(input).file;
        let csvs = to_csv(&file);
        let wstk = csvs.get("WSTK").expect("WSTK group");
        assert_eq!(wstk.trim(), "LOCA_ID,WSTK_DPTH");
    }
}
