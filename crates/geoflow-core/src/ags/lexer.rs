//! AGS 4.x row-level lexer.
//!
//! AGS 4 rows are comma-separated, double-quoted fields. Embedded quotes
//! are escaped by doubling them (`""`). The first field of every row is
//! a tag identifying the row kind (`GROUP`, `HEADING`, `UNIT`, `TYPE`,
//! `DATA`).

use std::fmt;

/// Kind of an AGS row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgsRowKind {
    Group,
    Heading,
    Unit,
    Type,
    Data,
    /// Anything else — captured so the parser can flag it.
    Unknown,
}

impl AgsRowKind {
    pub fn parse(tag: &str) -> Self {
        match tag {
            "GROUP" => AgsRowKind::Group,
            "HEADING" => AgsRowKind::Heading,
            "UNIT" => AgsRowKind::Unit,
            "TYPE" => AgsRowKind::Type,
            "DATA" => AgsRowKind::Data,
            _ => AgsRowKind::Unknown,
        }
    }
}

impl fmt::Display for AgsRowKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AgsRowKind::Group => f.write_str("GROUP"),
            AgsRowKind::Heading => f.write_str("HEADING"),
            AgsRowKind::Unit => f.write_str("UNIT"),
            AgsRowKind::Type => f.write_str("TYPE"),
            AgsRowKind::Data => f.write_str("DATA"),
            AgsRowKind::Unknown => f.write_str("?"),
        }
    }
}

/// Lex a single AGS line into its quoted fields.
///
/// Returns `Ok(None)` for empty / whitespace-only lines and `Ok(Some(_))`
/// for any line containing fields. Returns `Err` on malformed quoting.
pub fn tokenize_line(line: &str) -> Result<Option<Vec<String>>, LexError> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    if trimmed.trim().is_empty() {
        return Ok(None);
    }

    let mut fields = Vec::new();
    let mut chars = trimmed.chars().peekable();

    // Skip leading whitespace before the first quote.
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else {
            break;
        }
    }

    loop {
        match chars.next() {
            None => break,
            Some('"') => {
                let mut buf = String::new();
                loop {
                    match chars.next() {
                        Some('"') => {
                            // Escaped quote?
                            if chars.peek() == Some(&'"') {
                                chars.next();
                                buf.push('"');
                            } else {
                                break;
                            }
                        }
                        Some(c) => buf.push(c),
                        None => return Err(LexError::UnterminatedQuote),
                    }
                }
                fields.push(buf);
                // Expect comma or EOL after a closing quote.
                while let Some(&c) = chars.peek() {
                    match c {
                        ',' => {
                            chars.next();
                            break;
                        }
                        c if c.is_whitespace() => {
                            chars.next();
                        }
                        _ => return Err(LexError::UnexpectedAfterField(c)),
                    }
                }
            }
            Some(',') => {
                // Empty unquoted field — treat as empty.
                fields.push(String::new());
            }
            Some(c) if c.is_whitespace() => continue,
            Some(c) => return Err(LexError::UnquotedField(c)),
        }
    }

    Ok(Some(fields))
}

/// Errors that the lexer can produce for a single line.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LexError {
    #[error("unterminated quoted field")]
    UnterminatedQuote,
    #[error("unexpected character {0:?} after closing quote")]
    UnexpectedAfterField(char),
    #[error("unquoted field starting with {0:?}")]
    UnquotedField(char),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_row() {
        let toks = tokenize_line(r#""DATA","BH01","1.0""#).unwrap().unwrap();
        assert_eq!(toks, vec!["DATA", "BH01", "1.0"]);
    }

    #[test]
    fn handles_embedded_commas() {
        let toks = tokenize_line(r#""DATA","one, two","three""#)
            .unwrap()
            .unwrap();
        assert_eq!(toks, vec!["DATA", "one, two", "three"]);
    }

    #[test]
    fn handles_embedded_quotes() {
        let toks = tokenize_line(r#""DATA","he said ""hi""","x""#)
            .unwrap()
            .unwrap();
        assert_eq!(toks, vec!["DATA", r#"he said "hi""#, "x"]);
    }

    #[test]
    fn empty_line_is_none() {
        assert_eq!(tokenize_line("").unwrap(), None);
        assert_eq!(tokenize_line("   ").unwrap(), None);
        assert_eq!(tokenize_line("\r\n").unwrap(), None);
    }

    #[test]
    fn handles_crlf_endings() {
        let toks = tokenize_line("\"GROUP\",\"PROJ\"\r\n").unwrap().unwrap();
        assert_eq!(toks, vec!["GROUP", "PROJ"]);
    }

    #[test]
    fn empty_field_between_commas() {
        let toks = tokenize_line(r#""DATA","","x""#).unwrap().unwrap();
        assert_eq!(toks, vec!["DATA", "", "x"]);
    }

    #[test]
    fn unterminated_quote_errors() {
        assert_eq!(
            tokenize_line(r#""DATA","unterm"#).unwrap_err(),
            LexError::UnterminatedQuote
        );
    }

    #[test]
    fn row_kind_parse() {
        assert_eq!(AgsRowKind::parse("GROUP"), AgsRowKind::Group);
        assert_eq!(AgsRowKind::parse("HEADING"), AgsRowKind::Heading);
        assert_eq!(AgsRowKind::parse("UNIT"), AgsRowKind::Unit);
        assert_eq!(AgsRowKind::parse("TYPE"), AgsRowKind::Type);
        assert_eq!(AgsRowKind::parse("DATA"), AgsRowKind::Data);
        assert_eq!(AgsRowKind::parse("WAT"), AgsRowKind::Unknown);
    }
}
