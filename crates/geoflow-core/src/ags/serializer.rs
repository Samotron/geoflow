//! Serialize an [`AgsFile`] back to AGS 4.x text.
//!
//! Output uses CRLF line endings and double-quoted fields — the format
//! AGS 4 mandates.

use crate::model::{AgsFile, AgsType, AgsValue};

/// Serialize an [`AgsFile`] to a `String`.
pub fn serialize(file: &AgsFile) -> String {
    let mut out = String::new();
    let mut first = true;
    for (name, group) in &file.groups {
        if !first {
            out.push_str("\r\n");
        }
        first = false;

        write_row(
            &mut out,
            std::iter::once("GROUP").chain(std::iter::once(name.as_str())),
        );

        let heads: Vec<&str> = std::iter::once("HEADING")
            .chain(group.headings.iter().map(|h| h.name.as_str()))
            .collect();
        write_row(&mut out, heads.iter().copied());

        let units: Vec<&str> = std::iter::once("UNIT")
            .chain(group.headings.iter().map(|h| h.unit.as_str()))
            .collect();
        write_row(&mut out, units.iter().copied());

        let type_strings: Vec<String> = group
            .headings
            .iter()
            .map(|h| ags_type_to_string(&h.data_type))
            .collect();
        let mut types: Vec<&str> = vec!["TYPE"];
        types.extend(type_strings.iter().map(|s| s.as_str()));
        write_row(&mut out, types.iter().copied());

        for row in &group.rows {
            let value_strings: Vec<String> = group
                .headings
                .iter()
                .map(|h| row.get(&h.name).map(value_to_string).unwrap_or_default())
                .collect();
            let mut data: Vec<&str> = vec!["DATA"];
            data.extend(value_strings.iter().map(|s| s.as_str()));
            write_row(&mut out, data.iter().copied());
        }
    }
    out
}

fn write_row<'a, I: Iterator<Item = &'a str>>(out: &mut String, fields: I) {
    let mut first = true;
    for f in fields {
        if !first {
            out.push(',');
        }
        first = false;
        write_quoted(out, f);
    }
    out.push_str("\r\n");
}

fn write_quoted(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        if ch == '"' {
            out.push('"');
            out.push('"');
        } else {
            out.push(ch);
        }
    }
    out.push('"');
}

fn value_to_string(v: &AgsValue) -> String {
    match v {
        AgsValue::Null => String::new(),
        AgsValue::Text(s) | AgsValue::Raw(s) => s.clone(),
        AgsValue::Number(n) => format_number(*n),
        AgsValue::Bool(true) => "Y".to_string(),
        AgsValue::Bool(false) => "N".to_string(),
    }
}

fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e16 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn ags_type_to_string(t: &AgsType) -> String {
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
        AgsType::Dp(n) => format!("{n}DP"),
        AgsType::Sf(n) => format!("{n}SF"),
        AgsType::Sci(n) => format!("{n}SCI"),
        AgsType::Other(s) => s.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parser::parse_str;

    const SAMPLE: &str = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","Test"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","BH01","123456.78"
"#;

    #[test]
    fn round_trip_preserves_structure() {
        let parsed = parse_str(SAMPLE);
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let serialized = serialize(&parsed.file);
        let reparsed = parse_str(&serialized);
        assert_eq!(parsed.file, reparsed.file);
    }

    #[test]
    fn quotes_embedded_quotes() {
        let mut s = String::new();
        write_quoted(&mut s, r#"he said "hi""#);
        assert_eq!(s, r#""he said ""hi""""#);
    }
}
