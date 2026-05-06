//! Conversion from our AGS model into CEL values, plus message
//! template substitution.

use std::collections::HashMap;
use std::sync::Arc;

use cel_interpreter::objects::{Key, Map, Value};

use crate::model::{AgsFile, AgsGroup, AgsRow, AgsType, AgsValue};

/// Convert an [`AgsValue`] into a CEL [`Value`].
pub fn ags_value_to_cel(v: &AgsValue) -> Value {
    match v {
        AgsValue::Null => Value::Null,
        AgsValue::Text(s) | AgsValue::Raw(s) => Value::String(Arc::new(s.clone())),
        AgsValue::Number(n) => Value::Float(*n),
        AgsValue::Bool(b) => Value::Bool(*b),
    }
}

/// Convert an AGS row to a CEL Map keyed by heading name.
pub fn row_to_cel(row: &AgsRow) -> Value {
    let mut map: HashMap<Key, Value> = HashMap::with_capacity(row.len());
    for (k, v) in row {
        map.insert(Key::String(Arc::new(k.clone())), ags_value_to_cel(v));
    }
    Value::Map(Map { map: Arc::new(map) })
}

/// Convert an AGS group to a CEL list of row maps.
pub fn group_to_cel(g: &AgsGroup) -> Value {
    let rows: Vec<Value> = g.rows.iter().map(row_to_cel).collect();
    Value::List(Arc::new(rows))
}

fn ags_type_to_str(t: &AgsType) -> String {
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

/// Build a CEL `groups_meta` list — one map per group with keys
/// `name` (String), `row_count` (Int), and `headings` (List of
/// `{name, unit, type}` maps).  Used by file-scope structural rules.
pub fn groups_meta_cel(f: &AgsFile) -> Value {
    let groups: Vec<Value> = f
        .groups
        .values()
        .map(|g| {
            let headings: Vec<Value> = g
                .headings
                .iter()
                .map(|h| {
                    let mut m: HashMap<Key, Value> = HashMap::new();
                    m.insert(
                        Key::String(Arc::new("name".into())),
                        Value::String(Arc::new(h.name.clone())),
                    );
                    m.insert(
                        Key::String(Arc::new("unit".into())),
                        Value::String(Arc::new(h.unit.clone())),
                    );
                    m.insert(
                        Key::String(Arc::new("type".into())),
                        Value::String(Arc::new(ags_type_to_str(&h.data_type))),
                    );
                    Value::Map(Map { map: Arc::new(m) })
                })
                .collect();

            let mut m: HashMap<Key, Value> = HashMap::new();
            m.insert(
                Key::String(Arc::new("name".into())),
                Value::String(Arc::new(g.name.clone())),
            );
            m.insert(
                Key::String(Arc::new("row_count".into())),
                Value::Int(g.rows.len() as i64),
            );
            m.insert(
                Key::String(Arc::new("headings".into())),
                Value::List(Arc::new(headings)),
            );
            Value::Map(Map { map: Arc::new(m) })
        })
        .collect();
    Value::List(Arc::new(groups))
}

/// Build a CEL `file` map containing summary metadata about the file.
pub fn file_to_cel(f: &AgsFile) -> Value {
    let mut m: HashMap<Key, Value> = HashMap::new();
    m.insert(
        Key::String(Arc::new("path".into())),
        match &f.source_path {
            Some(p) => Value::String(Arc::new(p.clone())),
            None => Value::Null,
        },
    );
    m.insert(
        Key::String(Arc::new("ags_version".into())),
        match &f.ags_version {
            Some(v) => Value::String(Arc::new(v.clone())),
            None => Value::Null,
        },
    );
    Value::Map(Map { map: Arc::new(m) })
}

/// Substitute `{row.HEADING}`, `{group}`, `{key.HEADING}` style
/// placeholders in a message template using the provided row.
pub fn render_message(
    template: &str,
    row: Option<&AgsRow>,
    group: Option<&str>,
    key: Option<&HashMap<String, String>>,
) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' {
            let mut name = String::new();
            let mut closed = false;
            for nc in chars.by_ref() {
                if nc == '}' {
                    closed = true;
                    break;
                }
                name.push(nc);
            }
            if !closed {
                out.push('{');
                out.push_str(&name);
                continue;
            }
            out.push_str(&resolve_placeholder(name.trim(), row, group, key));
        } else {
            out.push(c);
        }
    }
    out
}

fn resolve_placeholder(
    spec: &str,
    row: Option<&AgsRow>,
    group: Option<&str>,
    key: Option<&HashMap<String, String>>,
) -> String {
    if spec == "group" {
        return group.unwrap_or("").to_string();
    }
    if let Some(rest) = spec.strip_prefix("row.") {
        if let Some(value) = row.and_then(|r| r.get(rest)) {
            return display_value(value);
        }
        return String::new();
    }
    if let Some(rest) = spec.strip_prefix("key.") {
        if let Some(value) = key.and_then(|k| k.get(rest)) {
            return value.clone();
        }
        return String::new();
    }
    // Unknown placeholder — return verbatim so users notice.
    format!("{{{spec}}}")
}

fn display_value(v: &AgsValue) -> String {
    match v {
        AgsValue::Null => String::new(),
        AgsValue::Text(s) | AgsValue::Raw(s) => s.clone(),
        AgsValue::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 1e16 {
                format!("{}", *n as i64)
            } else {
                format!("{n}")
            }
        }
        AgsValue::Bool(true) => "Y".into(),
        AgsValue::Bool(false) => "N".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    fn row() -> AgsRow {
        let mut r: AgsRow = IndexMap::new();
        r.insert("LOCA_ID".into(), AgsValue::Text("BH01".into()));
        r.insert("LOCA_NATE".into(), AgsValue::Number(123.45));
        r
    }

    #[test]
    fn substitutes_row_fields() {
        let s = render_message(
            "LOCA {row.LOCA_ID}: easting {row.LOCA_NATE}",
            Some(&row()),
            Some("LOCA"),
            None,
        );
        assert_eq!(s, "LOCA BH01: easting 123.45");
    }

    #[test]
    fn substitutes_group() {
        let s = render_message("group is {group}", None, Some("LOCA"), None);
        assert_eq!(s, "group is LOCA");
    }

    #[test]
    fn substitutes_key() {
        let mut k = HashMap::new();
        k.insert("LOCA_ID".into(), "BH01".into());
        let s = render_message("key is {key.LOCA_ID}", None, None, Some(&k));
        assert_eq!(s, "key is BH01");
    }

    #[test]
    fn unknown_placeholder_passes_through() {
        let s = render_message("{nope}", None, None, None);
        assert_eq!(s, "{nope}");
    }
}
