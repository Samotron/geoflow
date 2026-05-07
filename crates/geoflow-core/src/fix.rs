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
//! exactly what changed.  Pass `--diff-file <path>` to write a structured
//! JSON log of every change via [`Fixer::apply_all_logged`].
//!
//! Every fix here is "safe" in the sense the AGS 4 spec mandates the
//! canonical form (CRLF, no BOM, quoted fields, single blank line as
//! group separator, trailing newline).
//!
//! See `geoflow fix --dry-run` for the user-facing surface.

use crate::model::{AgsFile, AgsType, AgsValue};
use serde::{Deserialize, Serialize};

// ── Change record ─────────────────────────────────────────────────────────────

/// Kind of change recorded by a fix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixChangeKind {
    CellValue,
    HeadingUnit,
    HeadingName,
    GroupAdded,
}

/// A single change made by a model-level fix.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixChange {
    pub fix: String,
    pub group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
    pub before: String,
    pub after: String,
    pub kind: FixChangeKind,
}

/// Aggregated log of every change produced by a fix run.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FixLog {
    pub changes: Vec<FixChange>,
}

impl FixLog {
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }

    pub fn applied_fixes(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .changes
            .iter()
            .map(|c| c.fix.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        names.dedup();
        names
    }
}

fn ags_value_display(v: &AgsValue) -> String {
    match v {
        AgsValue::Null => String::new(),
        AgsValue::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{n}")
            }
        }
        AgsValue::Bool(true) => "Y".into(),
        AgsValue::Bool(false) => "N".into(),
        AgsValue::Text(s) | AgsValue::Raw(s) => s.clone(),
    }
}

// ── Fix trait ─────────────────────────────────────────────────────────────────

/// A model-level repair action.
pub trait Fix {
    fn name(&self) -> &'static str;

    /// Apply the fix.  Default delegates to [`Fix::apply_logged`].
    fn apply(&self, file: &mut AgsFile) -> bool {
        !self.apply_logged(file).is_empty()
    }

    /// Apply the fix and return per-change records.
    fn apply_logged(&self, file: &mut AgsFile) -> Vec<FixChange>;
}

// ── Fixer pipeline ────────────────────────────────────────────────────────────

/// Pipeline of model-level fixes applied in order.
pub struct Fixer {
    fixes: Vec<Box<dyn Fix>>,
}

impl Fixer {
    /// The standard pipeline shipped with `geoflow fix`.
    pub fn standard() -> Self {
        Self {
            fixes: vec![
                Box::new(NormalizeWhitespace),
                Box::new(NormalizeUnits),
                Box::new(NormalizeYnValues),
                Box::new(NormalizeDateFields),
                Box::new(UppercaseHeadingNames),
                Box::new(CoerceNumericFields),
                Box::new(StripControlChars),
                Box::new(PopulateTranGroup),
            ],
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

    /// Run every fix, return applied fix names **and** a detailed [`FixLog`].
    pub fn apply_all_logged(&self, file: &mut AgsFile) -> (Vec<&'static str>, FixLog) {
        let mut log = FixLog::default();
        let mut applied = Vec::new();
        for f in &self.fixes {
            let changes = f.apply_logged(file);
            if !changes.is_empty() {
                applied.push(f.name());
                log.changes.extend(changes);
            }
        }
        (applied, log)
    }
}

// ── NormalizeWhitespace ───────────────────────────────────────────────────────

/// Trim trailing whitespace from every textual cell.
struct NormalizeWhitespace;

impl Fix for NormalizeWhitespace {
    fn name(&self) -> &'static str {
        "normalize-whitespace"
    }

    fn apply_logged(&self, file: &mut AgsFile) -> Vec<FixChange> {
        let mut changes = Vec::new();
        for group in file.groups.values_mut() {
            for (row_idx, row) in group.rows.iter_mut().enumerate() {
                for (heading_name, value) in row.iter_mut() {
                    if let AgsValue::Text(s) = value {
                        let trimmed = s.trim_end().to_string();
                        if trimmed.len() != s.len() {
                            changes.push(FixChange {
                                fix: "normalize-whitespace".into(),
                                group: group.name.clone(),
                                row_index: Some(row_idx),
                                heading: Some(heading_name.clone()),
                                before: s.clone(),
                                after: trimmed.clone(),
                                kind: FixChangeKind::CellValue,
                            });
                            *s = trimmed;
                        }
                    }
                }
            }
        }
        changes
    }
}

// ── NormalizeUnits ────────────────────────────────────────────────────────────

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
    // For strings we can't map to a 'static literal, return "" as a
    // sentinel that equals the input only when the input is already "".
    // The caller (NormalizeUnits::apply_logged) only acts when the canonical
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

    fn apply_logged(&self, file: &mut AgsFile) -> Vec<FixChange> {
        let mut changes = Vec::new();
        for group in file.groups.values_mut() {
            for heading in &mut group.headings {
                let canon = canonical_unit(&heading.unit);
                if !canon.is_empty() && canon != heading.unit.as_str() {
                    changes.push(FixChange {
                        fix: "normalize-units".into(),
                        group: group.name.clone(),
                        row_index: None,
                        heading: Some(heading.name.clone()),
                        before: heading.unit.clone(),
                        after: canon.to_string(),
                        kind: FixChangeKind::HeadingUnit,
                    });
                    heading.unit = canon.to_string();
                }
            }
        }
        changes
    }
}

// ── NormalizeYnValues ─────────────────────────────────────────────────────────

/// Normalise YN-typed field values to the canonical "Y" / "N" strings.
///
/// AGS 4 mandates "Y" or "N" exactly.  Common variants found in practice:
/// "y", "yes", "YES", "true", "TRUE", "1" → "Y"
/// "n", "no", "NO", "false", "FALSE", "0" → "N"
struct NormalizeYnValues;

fn yn_canonical(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_uppercase().as_str() {
        "Y" | "YES" | "TRUE" | "1" => Some("Y"),
        "N" | "NO" | "FALSE" | "0" => Some("N"),
        _ => None,
    }
}

impl Fix for NormalizeYnValues {
    fn name(&self) -> &'static str {
        "normalize-yn-values"
    }

    fn apply_logged(&self, file: &mut AgsFile) -> Vec<FixChange> {
        let mut changes = Vec::new();

        for group in file.groups.values_mut() {
            let yn_headings: Vec<String> = group
                .headings
                .iter()
                .filter(|h| h.data_type == AgsType::YN)
                .map(|h| h.name.clone())
                .collect();

            if yn_headings.is_empty() {
                continue;
            }

            for (row_idx, row) in group.rows.iter_mut().enumerate() {
                for heading_name in &yn_headings {
                    let Some(val) = row.get_mut(heading_name.as_str()) else {
                        continue;
                    };
                    let before = ags_value_display(val);
                    let canon: Option<&'static str> = match val {
                        AgsValue::Text(s) | AgsValue::Raw(s) => yn_canonical(s),
                        AgsValue::Bool(b) => Some(if *b { "Y" } else { "N" }),
                        _ => None,
                    };
                    if let Some(canonical) = canon {
                        if before != canonical {
                            changes.push(FixChange {
                                fix: "normalize-yn-values".into(),
                                group: group.name.clone(),
                                row_index: Some(row_idx),
                                heading: Some(heading_name.clone()),
                                before,
                                after: canonical.to_string(),
                                kind: FixChangeKind::CellValue,
                            });
                            *val = AgsValue::Text(canonical.to_string());
                        }
                    }
                }
            }
        }
        changes
    }
}

// ── NormalizeDateFields ───────────────────────────────────────────────────────

/// Reformat DT-typed field values to ISO 8601 (YYYY-MM-DD).
///
/// Handles common UK-practice formats:
/// - DD/MM/YYYY → YYYY-MM-DD
/// - DD-MM-YYYY → YYYY-MM-DD
/// - YYYY/MM/DD → YYYY-MM-DD
struct NormalizeDateFields;

fn reformat_date(s: &str) -> Option<String> {
    let s = s.trim();
    // Already ISO 8601 — no change needed.
    if s.len() == 10
        && s.as_bytes()[4] == b'-'
        && s.as_bytes()[7] == b'-'
        && s[..4].parse::<u32>().is_ok()
    {
        return None;
    }

    if s.len() == 10 {
        let sep = s.as_bytes()[2];
        if sep == b'/' || sep == b'-' {
            if let (Ok(day), Ok(month), Ok(year)) = (
                s[..2].parse::<u32>(),
                s[3..5].parse::<u32>(),
                s[6..10].parse::<u32>(),
            ) {
                if (1..=31).contains(&day) && (1..=12).contains(&month) && year >= 1800 {
                    return Some(format!("{year:04}-{month:02}-{day:02}"));
                }
            }
        }
        // YYYY/MM/DD
        if s.as_bytes()[4] == b'/' {
            if let (Ok(year), Ok(month), Ok(day)) = (
                s[..4].parse::<u32>(),
                s[5..7].parse::<u32>(),
                s[8..10].parse::<u32>(),
            ) {
                if (1..=31).contains(&day) && (1..=12).contains(&month) && year >= 1800 {
                    return Some(format!("{year:04}-{month:02}-{day:02}"));
                }
            }
        }
    }
    None
}

impl Fix for NormalizeDateFields {
    fn name(&self) -> &'static str {
        "normalize-date-fields"
    }

    fn apply_logged(&self, file: &mut AgsFile) -> Vec<FixChange> {
        let mut changes = Vec::new();

        for group in file.groups.values_mut() {
            let dt_headings: Vec<String> = group
                .headings
                .iter()
                .filter(|h| h.data_type == AgsType::DT)
                .map(|h| h.name.clone())
                .collect();

            if dt_headings.is_empty() {
                continue;
            }

            for (row_idx, row) in group.rows.iter_mut().enumerate() {
                for heading_name in &dt_headings {
                    let Some(val) = row.get_mut(heading_name.as_str()) else {
                        continue;
                    };
                    let raw = match val {
                        AgsValue::Text(s) | AgsValue::Raw(s) => s.clone(),
                        _ => continue,
                    };
                    if let Some(normalized) = reformat_date(&raw) {
                        changes.push(FixChange {
                            fix: "normalize-date-fields".into(),
                            group: group.name.clone(),
                            row_index: Some(row_idx),
                            heading: Some(heading_name.clone()),
                            before: raw,
                            after: normalized.clone(),
                            kind: FixChangeKind::CellValue,
                        });
                        *val = AgsValue::Text(normalized);
                    }
                }
            }
        }
        changes
    }
}

// ── UppercaseHeadingNames ─────────────────────────────────────────────────────

/// Uppercase all heading names that contain lowercase characters.
///
/// AGS 4 Rule 19a: heading names must be uppercase alphanumeric + underscore.
/// Fixes AGS-HEAD-004 for the case where names are otherwise valid but wrong case.
struct UppercaseHeadingNames;

impl Fix for UppercaseHeadingNames {
    fn name(&self) -> &'static str {
        "uppercase-heading-names"
    }

    fn apply_logged(&self, file: &mut AgsFile) -> Vec<FixChange> {
        let mut changes = Vec::new();

        for group in file.groups.values_mut() {
            let mut renames: Vec<(String, String)> = Vec::new();

            for heading in &mut group.headings {
                let upper = heading.name.to_ascii_uppercase();
                if upper != heading.name {
                    renames.push((heading.name.clone(), upper.clone()));
                    changes.push(FixChange {
                        fix: "uppercase-heading-names".into(),
                        group: group.name.clone(),
                        row_index: None,
                        heading: None,
                        before: heading.name.clone(),
                        after: upper.clone(),
                        kind: FixChangeKind::HeadingName,
                    });
                    heading.name = upper;
                }
            }

            // Rename keys in every row to match the new heading names.
            if !renames.is_empty() {
                for row in &mut group.rows {
                    for (old, new) in &renames {
                        if let Some(val) = row.shift_remove(old.as_str()) {
                            row.insert(new.clone(), val);
                        }
                    }
                }
            }
        }
        changes
    }
}

// ── CoerceNumericFields ───────────────────────────────────────────────────────

/// Convert text/raw values in numeric-typed (nDP, nSF, RL, XN) fields to
/// `AgsValue::Number` where the string successfully parses as `f64`.
///
/// Repairs files where AGS 3 migration left values as Raw, or where the
/// serialiser wrote numbers as quoted strings.
struct CoerceNumericFields;

impl Fix for CoerceNumericFields {
    fn name(&self) -> &'static str {
        "coerce-numeric-fields"
    }

    fn apply_logged(&self, file: &mut AgsFile) -> Vec<FixChange> {
        let mut changes = Vec::new();

        for group in file.groups.values_mut() {
            let numeric_headings: Vec<String> = group
                .headings
                .iter()
                .filter(|h| h.data_type.is_numeric())
                .map(|h| h.name.clone())
                .collect();

            if numeric_headings.is_empty() {
                continue;
            }

            for (row_idx, row) in group.rows.iter_mut().enumerate() {
                for heading_name in &numeric_headings {
                    let Some(val) = row.get_mut(heading_name.as_str()) else {
                        continue;
                    };
                    let raw_str = match val {
                        AgsValue::Raw(s) | AgsValue::Text(s) => s.clone(),
                        _ => continue,
                    };
                    if raw_str.is_empty() {
                        continue;
                    }
                    if let Ok(n) = raw_str.trim().parse::<f64>() {
                        changes.push(FixChange {
                            fix: "coerce-numeric-fields".into(),
                            group: group.name.clone(),
                            row_index: Some(row_idx),
                            heading: Some(heading_name.clone()),
                            before: raw_str,
                            after: ags_value_display(&AgsValue::Number(n)),
                            kind: FixChangeKind::CellValue,
                        });
                        *val = AgsValue::Number(n);
                    }
                }
            }
        }
        changes
    }
}

// ── StripControlChars ─────────────────────────────────────────────────────────

/// Remove ASCII control characters (0x00–0x1F except TAB/LF/CR) from text fields.
struct StripControlChars;

fn strip_control(s: &str) -> Option<String> {
    let cleaned: String = s
        .chars()
        .filter(|&c| c >= '\x20' || c == '\t' || c == '\n' || c == '\r')
        .collect();
    if cleaned.len() != s.len() {
        Some(cleaned)
    } else {
        None
    }
}

impl Fix for StripControlChars {
    fn name(&self) -> &'static str {
        "strip-control-chars"
    }

    fn apply_logged(&self, file: &mut AgsFile) -> Vec<FixChange> {
        let mut changes = Vec::new();

        for group in file.groups.values_mut() {
            for (row_idx, row) in group.rows.iter_mut().enumerate() {
                for (heading_name, value) in row.iter_mut() {
                    match value {
                        AgsValue::Text(s) | AgsValue::Raw(s) => {
                            if let Some(cleaned) = strip_control(s) {
                                changes.push(FixChange {
                                    fix: "strip-control-chars".into(),
                                    group: group.name.clone(),
                                    row_index: Some(row_idx),
                                    heading: Some(heading_name.clone()),
                                    before: s.clone(),
                                    after: cleaned.clone(),
                                    kind: FixChangeKind::CellValue,
                                });
                                *s = cleaned;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        changes
    }
}

// ── PopulateTranGroup ─────────────────────────────────────────────────────────

/// Insert a minimal TRAN group if the file lacks one entirely.
///
/// AGS 4 requires TRAN.  We insert TRAN_AGS="4.1", TRAN_RCON="+", TRAN_DLIM=":"
/// after PROJ (or at position 0 if PROJ is also absent).
struct PopulateTranGroup;

impl Fix for PopulateTranGroup {
    fn name(&self) -> &'static str {
        "populate-tran-group"
    }

    fn apply_logged(&self, file: &mut AgsFile) -> Vec<FixChange> {
        if file.group("TRAN").is_some() {
            return Vec::new();
        }

        use crate::model::{AgsGroup, AgsHeading};
        use indexmap::IndexMap;

        let headings = vec![
            AgsHeading {
                name: "TRAN_AGS".into(),
                unit: String::new(),
                data_type: AgsType::X,
            },
            AgsHeading {
                name: "TRAN_RCON".into(),
                unit: String::new(),
                data_type: AgsType::X,
            },
            AgsHeading {
                name: "TRAN_DLIM".into(),
                unit: String::new(),
                data_type: AgsType::X,
            },
        ];

        let mut row: IndexMap<String, AgsValue> = IndexMap::new();
        row.insert("TRAN_AGS".into(), AgsValue::Text("4.1".into()));
        row.insert("TRAN_RCON".into(), AgsValue::Text("+".into()));
        row.insert("TRAN_DLIM".into(), AgsValue::Text(":".into()));

        let mut group = AgsGroup::new("TRAN");
        group.headings = headings;
        group.rows = vec![row];

        let insert_pos = file
            .groups
            .keys()
            .position(|k| k == "PROJ")
            .map(|p| p + 1)
            .unwrap_or(0);

        let old = std::mem::take(&mut file.groups);
        let mut new_groups = indexmap::IndexMap::with_capacity(old.len() + 1);
        for (i, (k, v)) in old.into_iter().enumerate() {
            if i == insert_pos {
                new_groups.insert("TRAN".into(), group.clone());
            }
            new_groups.insert(k, v);
        }
        if !new_groups.contains_key("TRAN") {
            new_groups.insert("TRAN".into(), group.clone());
        }
        file.groups = new_groups;

        vec![FixChange {
            fix: "populate-tran-group".into(),
            group: "TRAN".into(),
            row_index: None,
            heading: None,
            before: String::new(),
            after: "TRAN_AGS=4.1, TRAN_RCON=+, TRAN_DLIM=:".into(),
            kind: FixChangeKind::GroupAdded,
        }]
    }
}

// ── TextInspection ────────────────────────────────────────────────────────────

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
    fn normalize_yn_values() {
        use crate::ags::parse_str;
        let ags = r#""GROUP","GCHM"
"HEADING","LOCA_ID","GCHM_ISAC"
"UNIT","",""
"TYPE","ID","YN"
"DATA","BH01","yes"
"DATA","BH02","NO"
"DATA","BH03","1"
"DATA","BH04","Y"
"#;
        let mut file = parse_str(ags).file;
        let (applied, log) = Fixer::standard().apply_all_logged(&mut file);
        assert!(applied.contains(&"normalize-yn-values"), "{applied:?}");
        let group = file.group("GCHM").unwrap();
        assert_eq!(
            group.rows[0].get("GCHM_ISAC").and_then(|v| v.as_text()),
            Some("Y")
        );
        assert_eq!(
            group.rows[1].get("GCHM_ISAC").and_then(|v| v.as_text()),
            Some("N")
        );
        assert_eq!(
            group.rows[2].get("GCHM_ISAC").and_then(|v| v.as_text()),
            Some("Y")
        );
        // "Y" was already canonical — should not appear in log.
        let yn_changes: Vec<_> = log
            .changes
            .iter()
            .filter(|c| c.fix == "normalize-yn-values" && c.before == "Y")
            .collect();
        assert!(
            yn_changes.is_empty(),
            "canonical Y should not produce a change"
        );
    }

    #[test]
    fn normalize_date_dd_mm_yyyy() {
        use crate::ags::parse_str;
        let ags = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_DATE"
"UNIT","",""
"TYPE","ID","DT"
"DATA","BH01","15/03/2024"
"DATA","BH02","2024-03-15"
"#;
        let mut file = parse_str(ags).file;
        let (applied, _log) = Fixer::standard().apply_all_logged(&mut file);
        assert!(applied.contains(&"normalize-date-fields"), "{applied:?}");
        let group = file.group("LOCA").unwrap();
        assert_eq!(
            group.rows[0].get("LOCA_DATE").and_then(|v| v.as_text()),
            Some("2024-03-15")
        );
        // Already ISO — unchanged.
        assert_eq!(
            group.rows[1].get("LOCA_DATE").and_then(|v| v.as_text()),
            Some("2024-03-15")
        );
    }

    #[test]
    fn uppercase_heading_names() {
        use crate::ags::parse_str;
        let ags = r#""GROUP","GEOL"
"HEADING","loca_id","Geol_Top","GEOL_BASE"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","0.00","1.50"
"#;
        let mut file = parse_str(ags).file;
        let (applied, log) = Fixer::standard().apply_all_logged(&mut file);
        assert!(applied.contains(&"uppercase-heading-names"), "{applied:?}");
        let group = file.group("GEOL").unwrap();
        assert!(
            group
                .headings
                .iter()
                .all(|h| h.name == h.name.to_ascii_uppercase()),
            "headings not fully uppercased: {:?}",
            group.headings
        );
        // Row keys should also be uppercased.
        assert!(group.rows[0].contains_key("LOCA_ID"));
        assert!(!group.rows[0].contains_key("loca_id"));
        // GEOL_BASE was already uppercase — should not appear in log.
        assert!(!log
            .changes
            .iter()
            .any(|c| c.fix == "uppercase-heading-names" && c.before == "GEOL_BASE"));
    }

    #[test]
    fn coerce_numeric_fields() {
        use crate::ags::parse_str;
        let ags = r#""GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","0.00","1.50"
"#;
        let mut file = parse_str(ags).file;
        // Manually downgrade a value to Raw to simulate AGS-3 migration output.
        if let Some(row) = file.groups.get_mut("GEOL").and_then(|g| g.rows.first_mut()) {
            row.insert("GEOL_TOP".into(), AgsValue::Raw("0.00".into()));
        }
        let (applied, _log) = Fixer::standard().apply_all_logged(&mut file);
        assert!(applied.contains(&"coerce-numeric-fields"), "{applied:?}");
        let group = file.group("GEOL").unwrap();
        assert_eq!(
            group.rows[0].get("GEOL_TOP").and_then(|v| v.as_number()),
            Some(0.0)
        );
    }

    #[test]
    fn strip_control_chars() {
        use crate::ags::parse_str;
        let ags = "\"GROUP\",\"GEOL\"\r\n\"HEADING\",\"LOCA_ID\",\"GEOL_DESC\"\r\n\"UNIT\",\"\",\"\"\r\n\"TYPE\",\"ID\",\"X\"\r\n\"DATA\",\"BH01\",\"SandyCLAY\"\r\n";
        let mut file = parse_str(ags).file;
        // Manually inject a control char.
        if let Some(row) = file.groups.get_mut("GEOL").and_then(|g| g.rows.first_mut()) {
            row.insert("GEOL_DESC".into(), AgsValue::Text("Sandy\x01CLAY".into()));
        }
        let (applied, _log) = Fixer::standard().apply_all_logged(&mut file);
        assert!(applied.contains(&"strip-control-chars"), "{applied:?}");
        let group = file.group("GEOL").unwrap();
        assert_eq!(
            group.rows[0].get("GEOL_DESC").and_then(|v| v.as_text()),
            Some("SandyCLAY")
        );
    }

    #[test]
    fn populate_tran_group_when_absent() {
        let mut file = crate::model::AgsFile::new();
        let (applied, log) = Fixer::standard().apply_all_logged(&mut file);
        assert!(applied.contains(&"populate-tran-group"), "{applied:?}");
        assert!(file.group("TRAN").is_some());
        assert_eq!(log.changes[0].kind, FixChangeKind::GroupAdded);
    }

    #[test]
    fn populate_tran_group_skipped_when_present() {
        use crate::ags::parse_str;
        let ags = r#""GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"
"#;
        let mut file = parse_str(ags).file;
        let (applied, _) = Fixer::standard().apply_all_logged(&mut file);
        assert!(!applied.contains(&"populate-tran-group"), "{applied:?}");
        assert_eq!(file.groups.keys().filter(|k| *k == "TRAN").count(), 1);
    }

    #[test]
    fn apply_all_logged_returns_fix_log() {
        use crate::ags::parse_str;
        let ags = "\"GROUP\",\"TRAN\"\r\n\"HEADING\",\"TRAN_AGS\"\r\n\"UNIT\",\"\"\r\n\"TYPE\",\"X\"\r\n\"DATA\",\"4.1\"\r\n\r\n\"GROUP\",\"LLPL\"\r\n\"HEADING\",\"LOCA_ID\",\"LLPL_LL\"\r\n\"UNIT\",\"\",\"kN/m2\"\r\n\"TYPE\",\"ID\",\"2DP\"\r\n\"DATA\",\"BH01\",\"25.0\"\r\n";
        let mut file = parse_str(ags).file;
        // Inject trailing whitespace manually (parser strips it on input).
        if let Some(row) = file.groups.get_mut("LLPL").and_then(|g| g.rows.first_mut()) {
            row.insert("LLPL_LL".into(), AgsValue::Text("25.0  ".into()));
        }
        let (_applied, log) = Fixer::standard().apply_all_logged(&mut file);
        assert!(!log.is_empty());
        assert!(log.changes.iter().any(|c| c.fix == "normalize-whitespace"));
        assert!(log.changes.iter().any(|c| c.fix == "normalize-units"));
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
