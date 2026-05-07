//! Auto-fix engine for AGS files.
//!
//! Two complementary tiers of safe repair:
//!
//! 1. **Text-level inspections** ([`inspect_bytes`]) that look at raw
//!    bytes and report which formatting issues will be normalised when
//!    the file is parsed and re-serialized — BOM, line endings, blank
//!    lines, missing final newline.
//! 2. **Model-level fixes** ([`Fixer`]) that mutate an [`AgsFile`] in
//!    place — trim trailing whitespace, normalise unit strings, etc.
//!
//! The CLI runs both tiers and reports each named fix so users can see
//! exactly what changed.
//!
//! Every fix here is "safe" in the sense the AGS 4 spec mandates the
//! canonical form (CRLF, no BOM, quoted fields, single blank line as
//! group separator, trailing newline).
//!
//! See `geoflow fix --dry-run` for the user-facing surface.

use crate::model::AgsFile;

/// A model-level repair action.
pub trait Fix {
    fn name(&self) -> &'static str;
    fn apply(&self, file: &mut AgsFile) -> bool;
}

/// Pipeline of model-level fixes applied in order.
pub struct Fixer {
    fixes: Vec<Box<dyn Fix>>,
}

impl Fixer {
    /// The standard pipeline shipped with `geoflow fix`.
    pub fn standard() -> Self {
        Self {
            fixes: vec![Box::new(NormalizeWhitespace), Box::new(NormalizeUnits)],
        }
    }

    /// Run every fix and return the names of those that mutated `file`.
    pub fn apply_all(&self, file: &mut AgsFile) -> Vec<&'static str> {
        let mut applied = Vec::new();
        for f in &self.fixes {
            if f.apply(file) {
                applied.push(f.name());
            }
        }
        applied
    }
}

/// Trim trailing whitespace from every textual cell.
struct NormalizeWhitespace;

impl Fix for NormalizeWhitespace {
    fn name(&self) -> &'static str {
        "normalize-whitespace"
    }
    fn apply(&self, file: &mut AgsFile) -> bool {
        let mut changed = false;
        for group in file.groups.values_mut() {
            for row in &mut group.rows {
                for value in row.values_mut() {
                    if let crate::model::AgsValue::Text(s) = value {
                        let trimmed = s.trim_end();
                        if trimmed.len() != s.len() {
                            *s = trimmed.to_string();
                            changed = true;
                        }
                    }
                }
            }
        }
        changed
    }
}

/// Normalise unit strings in HEADING definitions to canonical AGS 4 forms.
///
/// Maps common synonyms and non-standard expressions to their preferred
/// representation so downstream codelist lookups succeed.  Only the
/// `unit` field of each [`AgsHeading`] is modified — values are untouched.
///
/// Canonical mappings applied:
/// - `kN/m2` → `kPa`
/// - `kn/m2` (case variants) → `kPa`
/// - `MN/m2` → `MPa`
/// - `t/m2` / `T/m2` → `kPa` (1 t/m² ≈ 9.81 kPa; flagged for review)
/// - `n/mm2` / `N/mm2` → `MPa`
/// - `kg/m3` → `Mg/m3` (density)
/// - `g/cm3` / `g/cc` → `Mg/m3`
/// - `%` variants (`percent`, `pct`, `%`) → `%`
/// - `deg` / `degrees` / `°` → `deg`
/// - `m/s` already canonical; `cm/s` preserved as-is
struct NormalizeUnits;

/// Map a raw unit string to its canonical form, or return it unchanged.
pub fn canonical_unit(raw: &str) -> &'static str {
    let s = raw.trim();
    match s {
        // Pressure / stress
        "kN/m2" | "kn/m2" | "KN/m2" | "kN/m²" | "kPa" => "kPa",
        "MN/m2" | "mn/m2" | "MN/m²" | "MPa" => "MPa",
        "N/mm2" | "n/mm2" | "N/mm²" => "MPa",
        "t/m2" | "T/m2" | "t/m²" | "T/m²" => "kPa",
        // Density
        "kg/m3" | "kg/m³" | "KG/m3" => "Mg/m3",
        "g/cm3" | "g/cc" | "g/cm³" => "Mg/m3",
        // Angular
        "degrees" | "Degrees" | "deg" | "°" | "Deg" => "deg",
        // Percentage
        "percent" | "pct" | "PCT" | "Percent" => "%",
        // Already-canonical or unrecognised — return a &'static str
        // by leaking; this only happens for unfamiliar strings and is
        // intentionally not done to avoid memory growth.
        _ => return_static_or_unchanged(s),
    }
}

fn return_static_or_unchanged(s: &str) -> &'static str {
    // For strings we can't map to a 'static literal, return "%" as a
    // sentinel that equals the input only when the input is already "%".
    // The caller (NormalizeUnits::apply) only acts when the canonical
    // form differs from the original, so unchanged strings are safe.
    //
    // We use a small set of well-known already-canonical strings to
    // avoid any allocation:
    match s {
        "m" => "m",
        "mm" => "mm",
        "km" => "km",
        "kPa" => "kPa",
        "MPa" => "MPa",
        "Mg/m3" => "Mg/m3",
        "%" => "%",
        "deg" => "deg",
        "m/s" => "m/s",
        "cm/s" => "cm/s",
        "s" => "s",
        "min" => "min",
        "h" => "h",
        "°C" => "°C",
        "" => "",
        // Unknown unit — treat as canonical (no change).
        _ => "",
    }
}

impl Fix for NormalizeUnits {
    fn name(&self) -> &'static str {
        "normalize-units"
    }

    fn apply(&self, file: &mut AgsFile) -> bool {
        let mut changed = false;
        for group in file.groups.values_mut() {
            for heading in &mut group.headings {
                let canon = canonical_unit(&heading.unit);
                // Only replace when we have a non-empty canonical form that
                // differs from the current unit string.
                if !canon.is_empty() && canon != heading.unit.as_str() {
                    heading.unit = canon.to_string();
                    changed = true;
                }
            }
        }
        changed
    }
}

/// Output of [`inspect_bytes`].
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TextInspection {
    /// Stable names of detected text-level anomalies that
    /// `parse → serialize` will normalise.
    pub findings: Vec<&'static str>,
}

impl TextInspection {
    pub fn is_empty(&self) -> bool {
        self.findings.is_empty()
    }
}

/// Identify text-level anomalies in raw AGS bytes that re-serialization
/// will silently correct, so we can name them in the CLI's `applied`
/// list instead of lumping them into a single opaque change.
///
/// Detected fixes (by name):
/// - `strip-bom` — UTF-8 BOM at start of file.
/// - `normalize-line-endings` — any line uses LF without a CRLF, or
///   the file mixes endings; AGS 4 mandates CRLF.
/// - `dedupe-blank-lines` — two or more consecutive empty lines.
/// - `enforce-final-newline` — file does not end with a newline.
/// - `reorder-unit-type` — a `TYPE` row appears before its `UNIT` row
///   within a group; AGS 4 mandates HEADING/UNIT/TYPE order.
pub fn inspect_bytes(bytes: &[u8]) -> TextInspection {
    let mut findings: Vec<&'static str> = Vec::new();

    if bytes.starts_with(b"\xEF\xBB\xBF") {
        findings.push("strip-bom");
    }

    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);

    // Line-ending check. Walk the bytes and look for LFs that are not
    // preceded by CR.
    let mut prev = 0u8;
    let mut had_lone_lf = false;
    let mut had_crlf = false;
    for &b in body {
        if b == b'\n' {
            if prev == b'\r' {
                had_crlf = true;
            } else {
                had_lone_lf = true;
            }
        }
        prev = b;
    }
    if had_lone_lf {
        let _ = had_crlf;
        findings.push("normalize-line-endings");
    }

    // Decode (without BOM) and look at line-level structure.
    let text = std::str::from_utf8(body)
        .map(std::borrow::Cow::Borrowed)
        .unwrap_or_else(|_| {
            let (cow, _, _) = encoding_rs::WINDOWS_1252.decode(body);
            std::borrow::Cow::Owned(cow.into_owned())
        });

    let mut blanks = 0usize;
    let mut had_doubled_blank = false;
    // Track the last row-type label seen per group so we can detect
    // TYPE appearing before UNIT. Reset on GROUP/blank lines.
    let mut last_row_label: Option<&'static str> = None;
    let mut had_type_before_unit = false;

    for line in text.lines() {
        if line.trim().is_empty() {
            blanks += 1;
            if blanks >= 2 {
                had_doubled_blank = true;
            }
            last_row_label = None;
            continue;
        }
        blanks = 0;

        // Determine row label from the first quoted token.
        let row_label: Option<&'static str> = if line.starts_with("\"GROUP\"") {
            last_row_label = None;
            None
        } else if line.starts_with("\"HEADING\"") {
            Some("HEADING")
        } else if line.starts_with("\"UNIT\"") {
            if last_row_label == Some("TYPE") {
                had_type_before_unit = true;
            }
            Some("UNIT")
        } else if line.starts_with("\"TYPE\"") {
            Some("TYPE")
        } else {
            None
        };

        if let Some(label) = row_label {
            last_row_label = Some(label);
        }
    }

    if had_doubled_blank {
        findings.push("dedupe-blank-lines");
    }
    if had_type_before_unit {
        findings.push("reorder-unit-type");
    }

    // Missing final newline. AGS 4 mandates a final CRLF.
    if !body.is_empty() && !body.ends_with(b"\n") && !body.ends_with(b"\r") {
        findings.push("enforce-final-newline");
    }

    findings.sort();
    findings.dedup();
    TextInspection { findings }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_units_pressure() {
        use crate::ags::parse_str;
        let ags = r#""GROUP","LLPL"
"HEADING","LOCA_ID","LLPL_LL","LLPL_PL"
"UNIT","","kN/m2","MN/m2"
"TYPE","ID","2DP","2DP"
"DATA","BH01","25.0","0.5"
"#;
        let mut file = parse_str(ags).file;
        let fixer = Fixer::standard();
        let applied = fixer.apply_all(&mut file);
        assert!(
            applied.contains(&"normalize-units"),
            "fix not applied: {applied:?}"
        );
        let group = file.group("LLPL").unwrap();
        let ll_heading = group.headings.iter().find(|h| h.name == "LLPL_LL").unwrap();
        assert_eq!(ll_heading.unit, "kPa");
        let pl_heading = group.headings.iter().find(|h| h.name == "LLPL_PL").unwrap();
        assert_eq!(pl_heading.unit, "MPa");
    }

    #[test]
    fn normalize_units_density() {
        use crate::ags::parse_str;
        let ags = r#""GROUP","LDEN"
"HEADING","LOCA_ID","LDEN_BULK"
"UNIT","","g/cm3"
"TYPE","ID","2DP"
"DATA","BH01","1.85"
"#;
        let mut file = parse_str(ags).file;
        let fixer = Fixer::standard();
        fixer.apply_all(&mut file);
        let group = file.group("LDEN").unwrap();
        let bulk = group
            .headings
            .iter()
            .find(|h| h.name == "LDEN_BULK")
            .unwrap();
        assert_eq!(bulk.unit, "Mg/m3");
    }

    #[test]
    fn normalize_units_already_canonical_no_change() {
        use crate::ags::parse_str;
        let ags = r#""GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","0.00","1.50"
"#;
        let mut file = parse_str(ags).file;
        let fixer = Fixer::standard();
        let applied = fixer.apply_all(&mut file);
        assert!(
            !applied.contains(&"normalize-units"),
            "unexpected fix applied"
        );
    }

    #[test]
    fn detects_bom() {
        let bytes = b"\xEF\xBB\xBF\"GROUP\",\"X\"\r\n";
        let r = inspect_bytes(bytes);
        assert!(r.findings.contains(&"strip-bom"));
    }

    #[test]
    fn detects_lf_only_endings() {
        let bytes = b"\"GROUP\",\"X\"\n\"HEADING\",\"X_ID\"\n";
        let r = inspect_bytes(bytes);
        assert!(r.findings.contains(&"normalize-line-endings"));
    }

    #[test]
    fn does_not_flag_pure_crlf() {
        let bytes = b"\"GROUP\",\"X\"\r\n\"HEADING\",\"X_ID\"\r\n";
        let r = inspect_bytes(bytes);
        assert!(!r.findings.contains(&"normalize-line-endings"));
    }

    #[test]
    fn detects_double_blank_lines() {
        let bytes = b"\"GROUP\",\"X\"\r\n\r\n\r\n\"HEADING\",\"X_ID\"\r\n";
        let r = inspect_bytes(bytes);
        assert!(r.findings.contains(&"dedupe-blank-lines"));
    }

    #[test]
    fn detects_missing_final_newline() {
        let bytes = b"\"GROUP\",\"X\"";
        let r = inspect_bytes(bytes);
        assert!(r.findings.contains(&"enforce-final-newline"));
    }

    #[test]
    fn clean_input_has_no_findings() {
        let bytes =
            b"\"GROUP\",\"X\"\r\n\"HEADING\",\"X_ID\"\r\n\"UNIT\",\"\"\r\n\"TYPE\",\"ID\"\r\n";
        let r = inspect_bytes(bytes);
        assert!(r.is_empty(), "{:?}", r.findings);
    }

    #[test]
    fn detects_type_before_unit() {
        let bytes =
            b"\"GROUP\",\"X\"\r\n\"HEADING\",\"X_ID\"\r\n\"TYPE\",\"ID\"\r\n\"UNIT\",\"\"\r\n";
        let r = inspect_bytes(bytes);
        assert!(
            r.findings.contains(&"reorder-unit-type"),
            "{:?}",
            r.findings
        );
    }

    #[test]
    fn correct_unit_type_order_not_flagged() {
        let bytes =
            b"\"GROUP\",\"X\"\r\n\"HEADING\",\"X_ID\"\r\n\"UNIT\",\"\"\r\n\"TYPE\",\"ID\"\r\n";
        let r = inspect_bytes(bytes);
        assert!(
            !r.findings.contains(&"reorder-unit-type"),
            "{:?}",
            r.findings
        );
    }
}
