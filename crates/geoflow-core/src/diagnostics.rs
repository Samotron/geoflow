//! Diagnostic types reported by the parser, validators, and converters.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Severity of a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Severity::Info => f.write_str("info"),
            Severity::Warning => f.write_str("warning"),
            Severity::Error => f.write_str("error"),
        }
    }
}

/// Source location for a diagnostic.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Location {
    pub file: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub group: Option<String>,
    pub row_index: Option<u32>,
}

/// A diagnostic produced by parsing or validation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    /// Stable rule identifier (e.g. `AGS-RULE-1`, `PROJ-001`).
    pub rule_id: String,
    pub severity: Severity,
    pub message: String,
    #[serde(default)]
    pub location: Location,
    /// Name of a `geoflow fix` fix that resolves this diagnostic, if one exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_id: Option<String>,
}

impl Diagnostic {
    pub fn new(rule_id: impl Into<String>, severity: Severity, message: impl Into<String>) -> Self {
        Self {
            rule_id: rule_id.into(),
            severity,
            message: message.into(),
            location: Location::default(),
            fix_id: None,
        }
    }

    pub fn with_fix(mut self, fix_id: &'static str) -> Self {
        self.fix_id = Some(fix_id.to_string());
        self
    }

    pub fn at_line(mut self, line: u32) -> Self {
        self.location.line = Some(line);
        self
    }

    pub fn at_group(mut self, group: impl Into<String>) -> Self {
        self.location.group = Some(group.into());
        self
    }

    pub fn at_file(mut self, file: impl Into<String>) -> Self {
        self.location.file = Some(file.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_display() {
        assert_eq!(Severity::Error.to_string(), "error");
        assert_eq!(Severity::Warning.to_string(), "warning");
        assert_eq!(Severity::Info.to_string(), "info");
    }

    #[test]
    fn diagnostic_builder() {
        let d = Diagnostic::new("X-1", Severity::Error, "boom")
            .at_line(42)
            .at_group("LOCA")
            .at_file("test.ags");
        assert_eq!(d.rule_id, "X-1");
        assert_eq!(d.location.line, Some(42));
        assert_eq!(d.location.group.as_deref(), Some("LOCA"));
        assert_eq!(d.location.file.as_deref(), Some("test.ags"));
    }
}
