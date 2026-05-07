//! AGS file diff: compare two [`AgsFile`]s and report group/row differences.

use crate::ags;
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct LineDiffLine {
    pub kind: String,
    pub text: String,
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
    pub key_headings: Vec<String>,
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
        key_headings: key_headings.iter().map(|s| (*s).to_string()).collect(),
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
        key_headings: Vec::new(),
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

#[derive(serde::Serialize)]
pub struct FieldChangeDetail {
    pub heading: String,
    pub before: String,
    pub after: String,
}

#[derive(serde::Serialize)]
pub struct RowPreview {
    pub key: String,
    pub fields: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct RowChangeDetail {
    pub key: String,
    pub changes: Vec<FieldChangeDetail>,
}

#[derive(serde::Serialize)]
pub struct GroupDetail {
    pub group: String,
    pub key_headings: Vec<String>,
    pub rows_added: usize,
    pub rows_removed: usize,
    pub rows_modified: usize,
    pub rows_unchanged: usize,
    pub added_rows: Vec<RowPreview>,
    pub removed_rows: Vec<RowPreview>,
    pub changed_rows: Vec<RowChangeDetail>,
    pub unified_diff: String,
    pub unified_lines: Vec<LineDiffLine>,
}

#[derive(serde::Serialize)]
pub struct DetailedDiffSummary {
    pub identical: bool,
    pub only_in_a: Vec<String>,
    pub only_in_b: Vec<String>,
    pub groups: Vec<GroupDetail>,
    pub full_unified_diff: String,
    pub full_unified_lines: Vec<LineDiffLine>,
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

    pub fn to_detailed_summary(&self, file_a: &AgsFile, file_b: &AgsFile) -> DetailedDiffSummary {
        DetailedDiffSummary {
            identical: self.is_identical(),
            only_in_a: self.only_in_a.clone(),
            only_in_b: self.only_in_b.clone(),
            groups: self
                .group_diffs
                .iter()
                .filter(|g| !g.is_identical())
                .map(|g| {
                    let before = render_group(file_a, &g.group);
                    let after = render_group(file_b, &g.group);
                    let unified_diff = render_unified_diff(
                        &format!("{}.ags", g.group.to_lowercase()),
                        &before,
                        &after,
                    );
                    GroupDetail {
                        group: g.group.clone(),
                        key_headings: g.key_headings.clone(),
                        rows_added: g.rows_added.len(),
                        rows_removed: g.rows_removed.len(),
                        rows_modified: g.rows_changed.len(),
                        rows_unchanged: g.rows_unchanged,
                        added_rows: g
                            .rows_added
                            .iter()
                            .map(|row| RowPreview {
                                key: row_identity(row, &g.key_headings),
                                fields: row_preview_fields(row, 6),
                            })
                            .collect(),
                        removed_rows: g
                            .rows_removed
                            .iter()
                            .map(|row| RowPreview {
                                key: row_identity(row, &g.key_headings),
                                fields: row_preview_fields(row, 6),
                            })
                            .collect(),
                        changed_rows: g
                            .rows_changed
                            .iter()
                            .map(|change| RowChangeDetail {
                                key: change.key.clone(),
                                changes: change
                                    .changes
                                    .iter()
                                    .map(|fc| FieldChangeDetail {
                                        heading: fc.heading.clone(),
                                        before: fc.before.clone(),
                                        after: fc.after.clone(),
                                    })
                                    .collect(),
                            })
                            .collect(),
                        unified_lines: parse_unified_lines(&unified_diff),
                        unified_diff,
                    }
                })
                .collect(),
            full_unified_diff: {
                let before = ags::serialize(file_a);
                let after = ags::serialize(file_b);
                render_unified_diff("full-file.ags", &before, &after)
            },
            full_unified_lines: {
                let before = ags::serialize(file_a);
                let after = ags::serialize(file_b);
                parse_unified_lines(&render_unified_diff("full-file.ags", &before, &after))
            },
        }
    }
}

fn row_identity(row: &AgsRow, key_headings: &[String]) -> String {
    if !key_headings.is_empty() {
        let parts: Vec<String> = key_headings
            .iter()
            .filter_map(|heading| row.get(heading).map(value_display))
            .collect();
        if parts.len() == key_headings.len() && !parts.is_empty() {
            return parts.join(" / ");
        }
    }
    row_preview(row, 80)
}

fn row_preview_fields(row: &AgsRow, max_fields: usize) -> Vec<String> {
    row.iter()
        .take(max_fields)
        .map(|(k, v)| format!("{k}={}", value_display(v)))
        .collect()
}

fn render_group(file: &AgsFile, group_name: &str) -> String {
    let mut out = String::new();
    if let Some(group) = file.group(group_name) {
        let mut subfile = AgsFile {
            ags_version: file.ags_version.clone(),
            ..AgsFile::default()
        };
        subfile.groups.insert(group_name.to_string(), group.clone());
        out = ags::serialize(&subfile);
    }
    out
}

fn parse_unified_lines(diff: &str) -> Vec<LineDiffLine> {
    diff.lines()
        .map(|line| {
            let kind = if line.starts_with("---") || line.starts_with("+++") {
                "file"
            } else if line.starts_with("@@") {
                "hunk"
            } else if line.starts_with('+') {
                "add"
            } else if line.starts_with('-') {
                "remove"
            } else {
                "context"
            };
            LineDiffLine {
                kind: kind.to_string(),
                text: line.to_string(),
            }
        })
        .collect()
}

fn render_unified_diff(path: &str, before: &str, after: &str) -> String {
    let before_lines: Vec<&str> = before.lines().collect();
    let after_lines: Vec<&str> = after.lines().collect();
    let ops = diff_ops(&before_lines, &after_lines);

    let mut out = String::new();
    out.push_str(&format!("--- a/{path}\n"));
    out.push_str(&format!("+++ b/{path}\n"));

    if ops.is_empty() {
        out.push_str("@@ -0,0 +0,0 @@\n");
        return out;
    }

    let mut idx = 0usize;
    let mut old_line = 1usize;
    let mut new_line = 1usize;

    while idx < ops.len() {
        let chunk_start = idx;
        let mut old_count = 0usize;
        let mut new_count = 0usize;
        while idx < ops.len() {
            match ops[idx].0 {
                ' ' => {
                    old_count += 1;
                    new_count += 1;
                }
                '-' => old_count += 1,
                '+' => new_count += 1,
                _ => {}
            }
            idx += 1;
        }
        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            old_line, old_count, new_line, new_count
        ));
        for (kind, line) in &ops[chunk_start..idx] {
            out.push(*kind);
            out.push_str(line);
            out.push('\n');
        }
        old_line += old_count;
        new_line += new_count;
    }

    out
}

fn diff_ops<'a>(before: &[&'a str], after: &[&'a str]) -> Vec<(char, &'a str)> {
    let n = before.len();
    let m = after.len();
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];

    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if before[i] == after[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut i = 0usize;
    let mut j = 0usize;
    let mut ops = Vec::new();
    while i < n && j < m {
        if before[i] == after[j] {
            ops.push((' ', before[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            ops.push(('-', before[i]));
            i += 1;
        } else {
            ops.push(('+', after[j]));
            j += 1;
        }
    }
    while i < n {
        ops.push(('-', before[i]));
        i += 1;
    }
    while j < m {
        ops.push(('+', after[j]));
        j += 1;
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;

    #[test]
    fn detailed_summary_includes_group_and_full_unified_diffs() {
        let a = parse_str(
            "\"GROUP\",\"LOCA\"\n\"HEADING\",\"LOCA_ID\",\"LOCA_TYPE\"\n\"UNIT\",\"\",\"\"\n\"TYPE\",\"ID\",\"X\"\n\"DATA\",\"BH1\",\"BH\"\n",
        )
        .file;
        let b = parse_str(
            "\"GROUP\",\"LOCA\"\n\"HEADING\",\"LOCA_ID\",\"LOCA_TYPE\"\n\"UNIT\",\"\",\"\"\n\"TYPE\",\"ID\",\"X\"\n\"DATA\",\"BH1\",\"TP\"\n",
        )
        .file;

        let summary = diff(&a, &b).to_detailed_summary(&a, &b);
        assert!(!summary.identical);
        assert_eq!(summary.groups.len(), 1);
        assert!(summary.groups[0].unified_diff.contains("@@"));
        assert!(summary.groups[0]
            .unified_diff
            .contains("-\"DATA\",\"BH1\",\"BH\""));
        assert!(summary.groups[0]
            .unified_diff
            .contains("+\"DATA\",\"BH1\",\"TP\""));
        assert!(summary.full_unified_diff.contains("--- a/full-file.ags"));
    }
}
