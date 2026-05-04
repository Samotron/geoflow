//! AGS 4.x file parser.
//!
//! Builds an [`AgsFile`] from raw text or bytes, producing parser-level
//! diagnostics for malformed structure.

use encoding_rs::{UTF_8, WINDOWS_1252};
use indexmap::IndexMap;

use super::lexer::{tokenize_line, AgsRowKind};
use crate::diagnostics::{Diagnostic, Severity};
use crate::model::{AgsFile, AgsGroup, AgsHeading, AgsRow, AgsType, AgsValue};

/// Parser output: the parsed file plus any diagnostics generated while
/// parsing.
#[derive(Debug, Clone, Default)]
pub struct ParseOutcome {
    pub file: AgsFile,
    pub diagnostics: Vec<Diagnostic>,
}

/// Parse AGS text.
pub fn parse_str(text: &str) -> ParseOutcome {
    let mut state = ParserState::default();
    for (idx, line) in text.lines().enumerate() {
        state.consume_line(line, (idx as u32) + 1);
    }
    state.finish()
}

/// Parse AGS bytes, handling BOM and falling back to Windows-1252 if the
/// payload is not valid UTF-8.
pub fn parse_bytes(bytes: &[u8]) -> ParseOutcome {
    let text = decode_bytes(bytes);
    parse_str(&text)
}

/// Decode AGS file bytes to text, stripping a UTF-8 BOM and falling back
/// to Windows-1252 when UTF-8 decoding fails.
pub fn decode_bytes(bytes: &[u8]) -> String {
    // Strip UTF-8 BOM if present.
    let stripped = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);

    let (cow, _, had_errors) = UTF_8.decode(stripped);
    if had_errors {
        let (cow, _, _) = WINDOWS_1252.decode(stripped);
        cow.into_owned()
    } else {
        cow.into_owned()
    }
}

#[derive(Default)]
struct ParserState {
    file: AgsFile,
    diagnostics: Vec<Diagnostic>,
    current_group: Option<String>,
}

impl ParserState {
    fn consume_line(&mut self, line: &str, line_no: u32) {
        let toks = match tokenize_line(line) {
            Ok(Some(t)) => t,
            Ok(None) => return,
            Err(e) => {
                self.diagnostics.push(
                    Diagnostic::new("AGS-LEX", Severity::Error, format!("lex error: {e}"))
                        .at_line(line_no),
                );
                return;
            }
        };

        let mut iter = toks.into_iter();
        let Some(tag) = iter.next() else { return };
        let kind = AgsRowKind::parse(&tag);
        let payload: Vec<String> = iter.collect();

        match kind {
            AgsRowKind::Group => self.handle_group(payload, line_no),
            AgsRowKind::Heading => self.handle_heading(payload, line_no),
            AgsRowKind::Unit => self.handle_unit(payload, line_no),
            AgsRowKind::Type => self.handle_type(payload, line_no),
            AgsRowKind::Data => self.handle_data(payload, line_no),
            AgsRowKind::Unknown => {
                self.diagnostics.push(
                    Diagnostic::new(
                        "AGS-ROW-KIND",
                        Severity::Warning,
                        format!("unknown row tag {tag:?}"),
                    )
                    .at_line(line_no),
                );
            }
        }
    }

    fn handle_group(&mut self, payload: Vec<String>, line_no: u32) {
        let name = payload.into_iter().next().unwrap_or_default();
        if name.is_empty() {
            self.diagnostics.push(
                Diagnostic::new("AGS-GROUP-EMPTY", Severity::Error, "GROUP row missing name")
                    .at_line(line_no),
            );
            return;
        }
        let mut grp = AgsGroup::new(&name);
        grp.source_line = Some(line_no);
        self.file.groups.insert(name.clone(), grp);
        self.current_group = Some(name);
    }

    fn handle_heading(&mut self, payload: Vec<String>, line_no: u32) {
        let Some(group_name) = self.current_group.clone() else {
            self.diagnostics.push(
                Diagnostic::new(
                    "AGS-HEADING-ORPHAN",
                    Severity::Error,
                    "HEADING row before any GROUP",
                )
                .at_line(line_no),
            );
            return;
        };
        let group = self
            .file
            .groups
            .get_mut(&group_name)
            .expect("current group must exist");
        if !group.headings.is_empty() {
            self.diagnostics.push(
                Diagnostic::new(
                    "AGS-HEADING-DUP",
                    Severity::Error,
                    format!("duplicate HEADING row in group {group_name}"),
                )
                .at_group(&group_name)
                .at_line(line_no),
            );
        }
        group.headings = payload
            .into_iter()
            .map(|name| AgsHeading {
                name,
                unit: String::new(),
                data_type: AgsType::Other(String::new()),
            })
            .collect();
    }

    fn handle_unit(&mut self, payload: Vec<String>, line_no: u32) {
        let Some(group_name) = self.current_group.clone() else {
            return;
        };
        let group = self.file.groups.get_mut(&group_name).unwrap();
        if group.headings.is_empty() {
            self.diagnostics.push(
                Diagnostic::new(
                    "AGS-UNIT-NOHEAD",
                    Severity::Error,
                    "UNIT row before HEADING",
                )
                .at_group(&group_name)
                .at_line(line_no),
            );
            return;
        }
        for (i, value) in payload.into_iter().enumerate() {
            if let Some(h) = group.headings.get_mut(i) {
                h.unit = value;
            }
        }
    }

    fn handle_type(&mut self, payload: Vec<String>, line_no: u32) {
        let Some(group_name) = self.current_group.clone() else {
            return;
        };
        let group = self.file.groups.get_mut(&group_name).unwrap();
        if group.headings.is_empty() {
            self.diagnostics.push(
                Diagnostic::new(
                    "AGS-TYPE-NOHEAD",
                    Severity::Error,
                    "TYPE row before HEADING",
                )
                .at_group(&group_name)
                .at_line(line_no),
            );
            return;
        }
        for (i, value) in payload.into_iter().enumerate() {
            if let Some(h) = group.headings.get_mut(i) {
                h.data_type = AgsType::parse(&value);
            }
        }
    }

    fn handle_data(&mut self, payload: Vec<String>, line_no: u32) {
        let Some(group_name) = self.current_group.clone() else {
            self.diagnostics.push(
                Diagnostic::new(
                    "AGS-DATA-ORPHAN",
                    Severity::Error,
                    "DATA row before any GROUP",
                )
                .at_line(line_no),
            );
            return;
        };
        let group = self.file.groups.get_mut(&group_name).unwrap();
        if group.headings.is_empty() {
            self.diagnostics.push(
                Diagnostic::new(
                    "AGS-DATA-NOHEAD",
                    Severity::Error,
                    "DATA row before HEADING",
                )
                .at_group(&group_name)
                .at_line(line_no),
            );
            return;
        }

        let mut row: AgsRow = IndexMap::new();
        for (i, raw) in payload.into_iter().enumerate() {
            let Some(h) = group.headings.get(i) else {
                self.diagnostics.push(
                    Diagnostic::new(
                        "AGS-DATA-EXTRA",
                        Severity::Warning,
                        format!("extra value at column {} in {group_name}", i + 1),
                    )
                    .at_group(&group_name)
                    .at_line(line_no),
                );
                continue;
            };
            let value = coerce(&raw, &h.data_type);
            row.insert(h.name.clone(), value);
        }
        // Pad short rows with explicit nulls so downstream code can rely
        // on every heading being present.
        for h in group.headings.iter().skip(row.len()) {
            row.insert(h.name.clone(), AgsValue::Null);
        }
        group.rows.push(row);

        // Capture AGS version from the first TRAN_AGS we see.
        if group_name == "TRAN" {
            if let Some(version) = group
                .rows
                .last()
                .and_then(|r| r.get("TRAN_AGS"))
                .and_then(|v| v.as_text())
            {
                self.file.ags_version = Some(version.to_string());
            }
        }
    }

    fn finish(mut self) -> ParseOutcome {
        // Drop empty groups produced by lone GROUP rows? Keep them — the
        // structural validators want to flag them.
        if self.file.groups.is_empty() && self.diagnostics.is_empty() {
            self.diagnostics.push(Diagnostic::new(
                "AGS-EMPTY",
                Severity::Warning,
                "no AGS groups found",
            ));
        }
        ParseOutcome {
            file: self.file,
            diagnostics: self.diagnostics,
        }
    }
}

/// Coerce a raw textual value into an [`AgsValue`] using the column's
/// declared AGS type.
fn coerce(raw: &str, ty: &AgsType) -> AgsValue {
    if raw.is_empty() {
        return AgsValue::Null;
    }
    match ty {
        AgsType::YN => match raw.trim().to_ascii_uppercase().as_str() {
            "Y" | "YES" | "TRUE" => AgsValue::Bool(true),
            "N" | "NO" | "FALSE" => AgsValue::Bool(false),
            _ => AgsValue::Raw(raw.to_string()),
        },
        t if t.is_numeric() => match raw.trim().parse::<f64>() {
            Ok(n) => AgsValue::Number(n),
            Err(_) => AgsValue::Raw(raw.to_string()),
        },
        _ => AgsValue::Text(raw.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME","PROJ_LOC"
"UNIT","","",""
"TYPE","ID","X","X"
"DATA","P1","Test project","Somewhere"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","123456.78","234567.89"
"DATA","BH02","123460.00","234570.00"
"#;

    #[test]
    fn parses_groups_and_rows() {
        let out = parse_str(SAMPLE);
        assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
        assert_eq!(out.file.groups.len(), 2);

        let proj = out.file.group("PROJ").unwrap();
        assert_eq!(proj.headings.len(), 3);
        assert_eq!(proj.rows.len(), 1);
        assert_eq!(
            proj.rows[0].get("PROJ_ID").and_then(|v| v.as_text()),
            Some("P1")
        );

        let loca = out.file.group("LOCA").unwrap();
        assert_eq!(loca.rows.len(), 2);
        let nate = loca.rows[0].get("LOCA_NATE").and_then(|v| v.as_number());
        assert_eq!(nate, Some(123456.78));
    }

    #[test]
    fn handles_bom_and_crlf() {
        let mut bytes = b"\xEF\xBB\xBF".to_vec();
        bytes.extend_from_slice(SAMPLE.replace('\n', "\r\n").as_bytes());
        let out = parse_bytes(&bytes);
        assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
        assert_eq!(out.file.groups.len(), 2);
    }

    #[test]
    fn flags_data_before_heading() {
        let bad = "\"GROUP\",\"X\"\n\"DATA\",\"a\"\n";
        let out = parse_str(bad);
        assert!(out
            .diagnostics
            .iter()
            .any(|d| d.rule_id == "AGS-DATA-NOHEAD"));
    }

    #[test]
    fn captures_ags_version() {
        let text = r#""GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"
"#;
        let out = parse_str(text);
        assert_eq!(out.file.ags_version.as_deref(), Some("4.1"));
    }

    #[test]
    fn empty_input_produces_warning() {
        let out = parse_str("");
        assert!(out.diagnostics.iter().any(|d| d.rule_id == "AGS-EMPTY"));
    }
}
