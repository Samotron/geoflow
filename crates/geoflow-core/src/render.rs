//! Diagnostic renderers: plain text, JSON, JUnit XML.

use crate::diagnostics::{Diagnostic, Severity};

/// Output format for diagnostic rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Text,
    Json,
    Junit,
}

impl Format {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "text" => Some(Format::Text),
            "json" => Some(Format::Json),
            "junit" => Some(Format::Junit),
            _ => None,
        }
    }
}

/// Render diagnostics in the requested format.
pub fn render(diagnostics: &[Diagnostic], format: Format) -> String {
    match format {
        Format::Text => render_text(diagnostics),
        Format::Json => render_json(diagnostics),
        Format::Junit => render_junit(diagnostics),
    }
}

fn render_text(d: &[Diagnostic]) -> String {
    let mut out = String::new();
    for diag in d {
        let loc = format_location(diag);
        let fix = diag
            .fix_id
            .as_deref()
            .map(|f| format!(" [auto-fixable: {f}]"))
            .unwrap_or_default();
        out.push_str(&format!(
            "{sev}: [{id}] {msg}{loc}{fix}\n",
            sev = diag.severity,
            id = diag.rule_id,
            msg = diag.message,
            loc = loc,
            fix = fix,
        ));
    }
    let (e, w, i) = counts(d);
    out.push_str(&format!("\nsummary: {e} error, {w} warning, {i} info\n"));
    out
}

fn format_location(d: &Diagnostic) -> String {
    let mut parts = Vec::new();
    if let Some(file) = &d.location.file {
        parts.push(format!("file={file}"));
    }
    if let Some(group) = &d.location.group {
        parts.push(format!("group={group}"));
    }
    if let Some(line) = d.location.line {
        parts.push(format!("line={line}"));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" ({})", parts.join(", "))
    }
}

fn render_json(d: &[Diagnostic]) -> String {
    serde_json::to_string_pretty(d).expect("Diagnostic always serializes")
}

fn render_junit(d: &[Diagnostic]) -> String {
    let (e, w, _i) = counts(d);
    let mut out = String::new();
    out.push_str(r#"<?xml version="1.0" encoding="UTF-8"?>"#);
    out.push('\n');
    out.push_str(&format!(
        r#"<testsuite name="geoflow" tests="{}" failures="{}" errors="0" skipped="{}">"#,
        d.len(),
        e,
        w,
    ));
    out.push('\n');
    for diag in d {
        let name = xml_escape(&diag.rule_id);
        let msg = xml_escape(&diag.message);
        let class = xml_escape(diag.location.group.as_deref().unwrap_or("file"));
        match diag.severity {
            Severity::Error => {
                out.push_str(&format!(
                    "  <testcase classname=\"{class}\" name=\"{name}\">\n    <failure message=\"{msg}\"/>\n  </testcase>\n"
                ));
            }
            Severity::Warning => {
                out.push_str(&format!(
                    "  <testcase classname=\"{class}\" name=\"{name}\">\n    <skipped message=\"{msg}\"/>\n  </testcase>\n"
                ));
            }
            Severity::Info => {
                out.push_str(&format!(
                    "  <testcase classname=\"{class}\" name=\"{name}\">\n    <system-out>{msg}</system-out>\n  </testcase>\n"
                ));
            }
        }
    }
    out.push_str("</testsuite>\n");
    out
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn counts(d: &[Diagnostic]) -> (usize, usize, usize) {
    let mut e = 0;
    let mut w = 0;
    let mut i = 0;
    for diag in d {
        match diag.severity {
            Severity::Error => e += 1,
            Severity::Warning => w += 1,
            Severity::Info => i += 1,
        }
    }
    (e, w, i)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<Diagnostic> {
        vec![
            Diagnostic::new("R1", Severity::Error, "boom").at_group("LOCA"),
            Diagnostic::new("R2", Severity::Warning, "watch out").at_line(3),
        ]
    }

    #[test]
    fn text_renders_summary() {
        let s = render(&sample(), Format::Text);
        assert!(s.contains("error: [R1] boom"));
        assert!(s.contains("warning: [R2] watch out"));
        assert!(s.contains("1 error, 1 warning"));
    }

    #[test]
    fn json_round_trips() {
        let s = render(&sample(), Format::Json);
        let back: Vec<Diagnostic> = serde_json::from_str(&s).unwrap();
        assert_eq!(back, sample());
    }

    #[test]
    fn junit_well_formed() {
        let s = render(&sample(), Format::Junit);
        assert!(s.contains("<?xml"));
        assert!(s.contains("<testsuite"));
        assert!(s.contains("<failure"));
        assert!(s.contains("<skipped"));
    }

    #[test]
    fn xml_escape_handles_special() {
        assert_eq!(xml_escape("a<b&c>\"'"), "a&lt;b&amp;c&gt;&quot;&apos;");
    }

    #[test]
    fn parse_format_strings() {
        assert_eq!(Format::parse("text"), Some(Format::Text));
        assert_eq!(Format::parse("json"), Some(Format::Json));
        assert_eq!(Format::parse("junit"), Some(Format::Junit));
        assert_eq!(Format::parse("yaml"), None);
    }
}
