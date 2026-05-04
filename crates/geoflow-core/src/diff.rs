//! AGS file diff: compare two [`AgsFile`]s and report group/row differences.

use crate::model::{AgsFile, AgsRow, AgsValue};
use indexmap::IndexMap;
use std::collections::HashSet;
use std::fmt;

// ── Key heading lookup ────────────────────────────────────────────────────────

fn group_key_headings(group_name: &str) -> &'static [&'static str] {
    match group_name {
        "PROJ" => &["PROJ_ID"],
        "LOCA" => &["LOCA_ID"],
        "GEOL" => &["LOCA_ID", "GEOL_TOP"],
        "SAMP" => &["LOCA_ID", "SAMP_TOP", "SAMP_REF"],
        "ISPT" => &["LOCA_ID", "ISPT_TOP", "ISPT_TESN"],
        "WSTK" => &["LOCA_ID", "WSTK_DPTH"],
        "HOLE" => &["LOCA_ID", "HOLE_DPTH"],
        "CDIA" => &["LOCA_ID", "CDIA_DPTH"],
        "CHLG" => &["LOCA_ID", "CHLG_DPTH"],
        "LLPL" | "LDEN" | "LPDN" | "LPEN" | "LTRT" => {
            &["LOCA_ID", "SAMP_TOP", "SAMP_REF", "SPEC_DPTH"]
        }
        _ => &[],
    }
}

/// Derive a string key for a row. Falls back to ID-type heading detection if
/// no static key headings are defined for this group.
fn row_key(row: &AgsRow, key_headings: &[&str]) -> Option<String> {
    let parts: Vec<String> = key_headings
        .iter()
        .filter_map(|h| row.get(*h).map(value_str))
        .collect();
    if parts.len() == key_headings.len() && !parts.is_empty() {
        Some(parts.join("\x00"))
    } else {
        None
    }
}

fn value_str(v: &AgsValue) -> String {
    match v {
        AgsValue::Text(s) | AgsValue::Raw(s) => s.clone(),
        AgsValue::Number(n) => format!("{n}"),
        AgsValue::Bool(b) => b.to_string(),
        AgsValue::Null => String::new(),
    }
}

fn value_display(v: &AgsValue) -> String {
    match v {
        AgsValue::Text(s) | AgsValue::Raw(s) => format!("{s:?}"),
        AgsValue::Number(n) => format!("{n}"),
        AgsValue::Bool(b) => b.to_string(),
        AgsValue::Null => "null".to_string(),
    }
}

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct FieldChange {
    pub heading: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug)]
pub struct RowChange {
    /// Human-readable key identifying the row (e.g. `"BH-01 / 2.50"`).
    pub key: String,
    pub changes: Vec<FieldChange>,
}

#[derive(Debug)]
pub struct GroupDiff {
    pub group: String,
    pub rows_added: Vec<AgsRow>,
    pub rows_removed: Vec<AgsRow>,
    pub rows_changed: Vec<RowChange>,
    pub rows_unchanged: usize,
}

impl GroupDiff {
    pub fn is_identical(&self) -> bool {
        self.rows_added.is_empty() && self.rows_removed.is_empty() && self.rows_changed.is_empty()
    }
}

#[derive(Debug)]
pub struct DiffResult {
    pub only_in_a: Vec<String>,
    pub only_in_b: Vec<String>,
    pub group_diffs: Vec<GroupDiff>,
}

impl DiffResult {
    pub fn is_identical(&self) -> bool {
        self.only_in_a.is_empty()
            && self.only_in_b.is_empty()
            && self.group_diffs.iter().all(|g| g.is_identical())
    }
}

// ── Diff algorithm ────────────────────────────────────────────────────────────

pub fn diff(a: &AgsFile, b: &AgsFile) -> DiffResult {
    let keys_a: HashSet<&str> = a.groups.keys().map(|s| s.as_str()).collect();
    let keys_b: HashSet<&str> = b.groups.keys().map(|s| s.as_str()).collect();

    let mut only_in_a: Vec<String> = keys_a.difference(&keys_b).map(|s| s.to_string()).collect();
    let mut only_in_b: Vec<String> = keys_b.difference(&keys_a).map(|s| s.to_string()).collect();
    only_in_a.sort();
    only_in_b.sort();

    let mut common: Vec<&str> = keys_a.intersection(&keys_b).copied().collect();
    common.sort();

    let group_diffs = common
        .into_iter()
        .map(|name| diff_group(name, &a.groups[name].rows, &b.groups[name].rows))
        .collect();

    DiffResult {
        only_in_a,
        only_in_b,
        group_diffs,
    }
}

fn diff_group(group_name: &str, rows_a: &[AgsRow], rows_b: &[AgsRow]) -> GroupDiff {
    let key_headings = group_key_headings(group_name);

    // Build key maps
    let map_a: IndexMap<String, &AgsRow> = keyed_map(rows_a, key_headings);
    let map_b: IndexMap<String, &AgsRow> = keyed_map(rows_b, key_headings);

    if map_a.is_empty() && map_b.is_empty() {
        return diff_positional(group_name, rows_a, rows_b);
    }

    let keys_a: HashSet<&str> = map_a.keys().map(|s| s.as_str()).collect();
    let keys_b: HashSet<&str> = map_b.keys().map(|s| s.as_str()).collect();

    let rows_removed: Vec<AgsRow> = keys_a
        .difference(&keys_b)
        .filter_map(|k| map_a.get(*k).map(|r| (*r).clone()))
        .collect();

    let rows_added: Vec<AgsRow> = keys_b
        .difference(&keys_a)
        .filter_map(|k| map_b.get(*k).map(|r| (*r).clone()))
        .collect();

    let mut rows_changed = Vec::new();
    let mut rows_unchanged = 0usize;

    for key in keys_a.intersection(&keys_b) {
        let ra = map_a[*key];
        let rb = map_b[*key];
        let changes = row_field_diff(ra, rb);
        if changes.is_empty() {
            rows_unchanged += 1;
        } else {
            rows_changed.push(RowChange {
                key: key.replace('\x00', " / "),
                changes,
            });
        }
    }

    GroupDiff {
        group: group_name.to_string(),
        rows_added,
        rows_removed,
        rows_changed,
        rows_unchanged,
    }
}

fn diff_positional(group_name: &str, rows_a: &[AgsRow], rows_b: &[AgsRow]) -> GroupDiff {
    let len = rows_a.len().max(rows_b.len());
    let mut rows_added = Vec::new();
    let mut rows_removed = Vec::new();
    let mut rows_changed = Vec::new();
    let mut rows_unchanged = 0usize;

    for i in 0..len {
        match (rows_a.get(i), rows_b.get(i)) {
            (Some(ra), Some(rb)) => {
                let changes = row_field_diff(ra, rb);
                if changes.is_empty() {
                    rows_unchanged += 1;
                } else {
                    rows_changed.push(RowChange {
                        key: format!("row {}", i + 1),
                        changes,
                    });
                }
            }
            (None, Some(rb)) => rows_added.push(rb.clone()),
            (Some(ra), None) => rows_removed.push(ra.clone()),
            (None, None) => {}
        }
    }

    GroupDiff {
        group: group_name.to_string(),
        rows_added,
        rows_removed,
        rows_changed,
        rows_unchanged,
    }
}

fn keyed_map<'a>(rows: &'a [AgsRow], keys: &[&str]) -> IndexMap<String, &'a AgsRow> {
    let mut map = IndexMap::new();
    for row in rows {
        if let Some(k) = row_key(row, keys) {
            map.insert(k, row);
        }
    }
    map
}

fn row_field_diff(a: &AgsRow, b: &AgsRow) -> Vec<FieldChange> {
    let all_headings: HashSet<&str> = a.keys().chain(b.keys()).map(|s| s.as_str()).collect();
    let mut changes = Vec::new();
    let mut headings: Vec<&str> = all_headings.into_iter().collect();
    headings.sort();
    for h in headings {
        let va = a.get(h).unwrap_or(&AgsValue::Null);
        let vb = b.get(h).unwrap_or(&AgsValue::Null);
        if va != vb {
            changes.push(FieldChange {
                heading: h.to_string(),
                before: value_display(va),
                after: value_display(vb),
            });
        }
    }
    changes
}

// ── Text renderer ─────────────────────────────────────────────────────────────

impl fmt::Display for DiffResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_identical() {
            return writeln!(f, "files are identical");
        }

        if !self.only_in_a.is_empty() {
            writeln!(f, "only in a: {}", self.only_in_a.join(", "))?;
        }
        if !self.only_in_b.is_empty() {
            writeln!(f, "only in b: {}", self.only_in_b.join(", "))?;
        }

        for gd in &self.group_diffs {
            if gd.is_identical() {
                continue;
            }
            writeln!(f)?;
            let mut parts = Vec::new();
            if gd.rows_unchanged > 0 {
                parts.push(format!("{} unchanged", gd.rows_unchanged));
            }
            if !gd.rows_added.is_empty() {
                parts.push(format!("{} added", gd.rows_added.len()));
            }
            if !gd.rows_removed.is_empty() {
                parts.push(format!("{} removed", gd.rows_removed.len()));
            }
            if !gd.rows_changed.is_empty() {
                parts.push(format!("{} modified", gd.rows_changed.len()));
            }
            writeln!(f, "{}: {}", gd.group, parts.join("  "))?;

            for row in &gd.rows_added {
                let preview = row_preview(row, 60);
                writeln!(f, "  + {preview}")?;
            }
            for row in &gd.rows_removed {
                let preview = row_preview(row, 60);
                writeln!(f, "  - {preview}")?;
            }
            for change in &gd.rows_changed {
                writeln!(f, "  ~ {}", change.key)?;
                for fc in &change.changes {
                    writeln!(f, "      {}: {} → {}", fc.heading, fc.before, fc.after)?;
                }
            }
        }
        Ok(())
    }
}

fn row_preview(row: &AgsRow, max_len: usize) -> String {
    let parts: Vec<String> = row
        .iter()
        .take(4)
        .map(|(k, v)| format!("{k}={}", value_display(v)))
        .collect();
    let s = parts.join(", ");
    if s.len() > max_len {
        format!("{}…", &s[..max_len.saturating_sub(1)])
    } else {
        s
    }
}

/// Serialisable summary of a diff result (for `--format json`).
#[derive(serde::Serialize)]
pub struct DiffSummary {
    pub identical: bool,
    pub only_in_a: Vec<String>,
    pub only_in_b: Vec<String>,
    pub groups: Vec<GroupSummary>,
}

#[derive(serde::Serialize)]
pub struct GroupSummary {
    pub group: String,
    pub rows_added: usize,
    pub rows_removed: usize,
    pub rows_modified: usize,
    pub rows_unchanged: usize,
}

impl DiffResult {
    pub fn to_summary(&self) -> DiffSummary {
        DiffSummary {
            identical: self.is_identical(),
            only_in_a: self.only_in_a.clone(),
            only_in_b: self.only_in_b.clone(),
            groups: self
                .group_diffs
                .iter()
                .filter(|g| !g.is_identical())
                .map(|g| GroupSummary {
                    group: g.group.clone(),
                    rows_added: g.rows_added.len(),
                    rows_removed: g.rows_removed.len(),
                    rows_modified: g.rows_changed.len(),
                    rows_unchanged: g.rows_unchanged,
                })
                .collect(),
        }
    }
}
