//! Core AGS data model.
//!
//! AGS 4.x organises a file into named *groups*. Each group has a
//! `HEADING` row, a `UNIT` row, a `TYPE` row, and zero or more `DATA`
//! rows. We mirror that structure here.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// AGS 4.x data type codes (subset of those defined in the standard).
///
/// The free-text `Other` variant carries unrecognised codes verbatim so
/// validators can still report them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgsType {
    /// Free text.
    X,
    /// Numeric text (no implied precision).
    XN,
    /// MIME content / encoded text.
    MC,
    /// Identifier.
    ID,
    /// Picklist (abbreviation).
    PA,
    /// Picklist (text).
    PT,
    /// Picklist (unit).
    PU,
    /// Time (HH:MM:SS).
    T,
    /// Date / datetime.
    DT,
    /// Yes/No.
    YN,
    /// Real number, free format.
    RL,
    /// Decimal places: `nDP` where `n` is the count.
    Dp(u8),
    /// Significant figures: `nSF`.
    Sf(u8),
    /// Scientific notation: `nSCI`.
    Sci(u8),
    /// Unit string (associated with another data column).
    U,
    /// Record link to another row in another group.
    RecordLink,
    /// Degrees-minutes-seconds (D:MM:SS or D:MM:SS.ss, colon-delimited).
    DMS,
    /// Anything we did not recognise.
    Other(String),
}

impl AgsType {
    /// Parse a raw AGS type code (e.g. `2DP`, `XN`, `RECORD_LINK`).
    pub fn parse(raw: &str) -> Self {
        let s = raw.trim();
        let upper = s.to_ascii_uppercase();
        match upper.as_str() {
            "X" => AgsType::X,
            "XN" => AgsType::XN,
            "MC" => AgsType::MC,
            "ID" => AgsType::ID,
            "PA" => AgsType::PA,
            "PT" => AgsType::PT,
            "PU" => AgsType::PU,
            "T" => AgsType::T,
            "DT" => AgsType::DT,
            "YN" => AgsType::YN,
            "RL" => AgsType::RL,
            "U" => AgsType::U,
            "RECORD_LINK" => AgsType::RecordLink,
            "DMS" => AgsType::DMS,
            other => {
                if let Some(stripped) = other.strip_suffix("DP") {
                    if let Ok(n) = stripped.parse::<u8>() {
                        return AgsType::Dp(n);
                    }
                }
                if let Some(stripped) = other.strip_suffix("SF") {
                    if let Ok(n) = stripped.parse::<u8>() {
                        return AgsType::Sf(n);
                    }
                }
                if let Some(stripped) = other.strip_suffix("SCI") {
                    if let Ok(n) = stripped.parse::<u8>() {
                        return AgsType::Sci(n);
                    }
                }
                AgsType::Other(other.to_string())
            }
        }
    }

    /// Whether this type is numeric.
    pub fn is_numeric(&self) -> bool {
        matches!(
            self,
            AgsType::XN | AgsType::RL | AgsType::Dp(_) | AgsType::Sf(_) | AgsType::Sci(_)
        )
    }
}

/// A typed AGS value as stored in our in-memory model.
///
/// Original textual representation is preserved so `serialize` is
/// lossless.
///
/// Serialized as untagged (JSON/minijinja see native `null`, `"string"`, `1.5`,
/// `true` rather than `{"Text": "..."}` maps), which makes templates and JSON
/// output natural.  `Raw` and `Text` both serialize as plain strings; the `Raw`
/// variant only appears as parser output and is never deserialized from JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgsValue {
    Null,
    Number(f64),
    Bool(bool),
    Text(String),
    /// A value that came in textually but failed to coerce; kept verbatim
    /// so we can still emit it back out.
    Raw(String),
}

impl AgsValue {
    pub fn as_text(&self) -> Option<&str> {
        match self {
            AgsValue::Text(s) | AgsValue::Raw(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            AgsValue::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, AgsValue::Null)
    }
}

/// A column definition in an AGS group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgsHeading {
    pub name: String,
    pub unit: String,
    pub data_type: AgsType,
}

/// A row of typed values, indexed by heading name (preserving order).
pub type AgsRow = IndexMap<String, AgsValue>;

/// A single AGS group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgsGroup {
    pub name: String,
    pub headings: Vec<AgsHeading>,
    pub rows: Vec<AgsRow>,
    /// 1-based source line where the GROUP row appeared.
    pub source_line: Option<u32>,
}

impl AgsGroup {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            headings: Vec::new(),
            rows: Vec::new(),
            source_line: None,
        }
    }

    pub fn heading_names(&self) -> impl Iterator<Item = &str> {
        self.headings.iter().map(|h| h.name.as_str())
    }
}

/// A parsed AGS file: an ordered map of groups by name.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgsFile {
    pub groups: IndexMap<String, AgsGroup>,
    pub source_path: Option<String>,
    /// Detected AGS version (if discoverable from the file).
    pub ags_version: Option<String>,
}

impl AgsFile {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn group(&self, name: &str) -> Option<&AgsGroup> {
        self.groups.get(name)
    }

    pub fn group_mut(&mut self, name: &str) -> Option<&mut AgsGroup> {
        self.groups.get_mut(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_types() {
        assert_eq!(AgsType::parse("X"), AgsType::X);
        assert_eq!(AgsType::parse("XN"), AgsType::XN);
        assert_eq!(AgsType::parse("2DP"), AgsType::Dp(2));
        assert_eq!(AgsType::parse("3SF"), AgsType::Sf(3));
        assert_eq!(AgsType::parse("4SCI"), AgsType::Sci(4));
        assert_eq!(AgsType::parse("RECORD_LINK"), AgsType::RecordLink);
        assert_eq!(AgsType::parse("WAT"), AgsType::Other("WAT".into()));
    }

    #[test]
    fn numeric_classification() {
        assert!(AgsType::XN.is_numeric());
        assert!(AgsType::Dp(2).is_numeric());
        assert!(!AgsType::X.is_numeric());
        assert!(!AgsType::ID.is_numeric());
    }

    #[test]
    fn ags_value_helpers() {
        assert_eq!(AgsValue::Text("hi".into()).as_text(), Some("hi"));
        assert_eq!(AgsValue::Number(2.5).as_number(), Some(2.5));
        assert!(AgsValue::Null.is_null());
    }
}
