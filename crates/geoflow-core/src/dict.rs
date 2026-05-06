//! AGS 4.x standard heading dictionary and dictionary-based validation rules.

use crate::diagnostics::{Diagnostic, Severity};
use crate::model::AgsFile;
use crate::validate::Rule;
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

// ── Dictionary data ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DictFile {
    groups: HashMap<String, GroupDef>,
}

#[derive(Deserialize, Clone)]
pub struct GroupDef {
    pub required_headings: Vec<String>,
    pub depth_headings: Vec<String>,
    /// Composite key columns for uniqueness checks (Rule 10a).
    #[serde(default)]
    pub key_headings: Vec<String>,
    /// Immediate parent group name for referential integrity (Rule 10c).
    #[serde(default)]
    pub parent_group: Option<String>,
    /// Reference order of required headings per the AGS standard (Rule 7.2).
    #[serde(default)]
    pub heading_order: Vec<String>,
}

static DICT_ARC: LazyLock<Arc<HashMap<String, GroupDef>>> = LazyLock::new(|| {
    let raw = include_str!("../../../rules/specs/ags/dict/ags4.yml");
    let df: DictFile = serde_yaml::from_str(raw).expect("ags4 dict must be valid YAML");
    Arc::new(df.groups)
});

/// Return the standard AGS 4.x dictionary as a static reference.
pub fn ags4_dict() -> &'static HashMap<String, GroupDef> {
    &DICT_ARC
}

// ── Thread-local dict override for custom dictionary support ─────────────────

thread_local! {
    static THREAD_DICT: RefCell<Option<Arc<HashMap<String, GroupDef>>>> = const { RefCell::new(None) };
}

/// Return the currently active dictionary. If a custom dict has been activated
/// via [`activate_custom_dict`], that is returned; otherwise the standard dict.
pub fn current_dict() -> Arc<HashMap<String, GroupDef>> {
    THREAD_DICT.with(|d| {
        d.borrow()
            .as_ref()
            .cloned()
            .unwrap_or_else(|| Arc::clone(&DICT_ARC))
    })
}

/// Load a custom dict YAML, merge it with the standard dict (custom entries
/// win), and install it as the active dict for this thread. Call
/// [`deactivate_custom_dict`] when done to restore the standard dict.
pub fn activate_custom_dict(path: &std::path::Path) -> anyhow::Result<()> {
    let raw = std::fs::read_to_string(path)?;
    let df: DictFile = serde_yaml::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("invalid dict YAML at {}: {e}", path.display()))?;
    let mut merged = (*ags4_dict()).clone();
    merged.extend(df.groups);
    let arc = Arc::new(merged);
    THREAD_DICT.with(|d| *d.borrow_mut() = Some(arc));
    Ok(())
}

/// Clear any custom dict override and restore the standard dict.
pub fn deactivate_custom_dict() {
    THREAD_DICT.with(|d| *d.borrow_mut() = None);
}

// ── Rule: required headings ──────────────────────────────────────────────────

pub struct DictRequiredHeadingsRule;

impl Rule for DictRequiredHeadingsRule {
    fn id(&self) -> &str {
        "AGS-DICT-001"
    }
    fn description(&self) -> &str {
        "Required standard heading missing from group"
    }
    fn default_severity(&self) -> Severity {
        Severity::Error
    }
    fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
        let dict = current_dict();
        for (group_name, group_def) in dict.iter() {
            if group_def.required_headings.is_empty() {
                continue;
            }
            let Some(group) = file.group(group_name) else {
                continue;
            };
            let present: HashSet<&str> = group.headings.iter().map(|h| h.name.as_str()).collect();
            for req in &group_def.required_headings {
                if !present.contains(req.as_str()) {
                    diagnostics.push(
                        Diagnostic::new(
                            "AGS-DICT-001",
                            Severity::Error,
                            format!("{group_name} is missing required heading {req}"),
                        )
                        .at_group(group_name),
                    );
                }
            }
        }
    }
}

// ── Rule: depth heading units ────────────────────────────────────────────────

pub struct DictDepthUnitsRule;

impl Rule for DictDepthUnitsRule {
    fn id(&self) -> &str {
        "AGS-DICT-002"
    }
    fn description(&self) -> &str {
        "Depth heading should carry unit \"m\""
    }
    fn default_severity(&self) -> Severity {
        Severity::Warning
    }
    fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>) {
        let dict = current_dict();
        for (group_name, group_def) in dict.iter() {
            if group_def.depth_headings.is_empty() {
                continue;
            }
            let Some(group) = file.group(group_name) else {
                continue;
            };
            let depth_set: HashSet<&str> = group_def
                .depth_headings
                .iter()
                .map(|s| s.as_str())
                .collect();
            for heading in &group.headings {
                if !depth_set.contains(heading.name.as_str()) {
                    continue;
                }
                let unit = heading.unit.trim();
                if !unit.is_empty() && unit != "m" {
                    diagnostics.push(
                        Diagnostic::new(
                            "AGS-DICT-002",
                            Severity::Warning,
                            format!(
                                "{group_name}.{} has unit {:?}; depth headings should use \"m\"",
                                heading.name, unit
                            ),
                        )
                        .at_group(group_name),
                    );
                }
            }
        }
    }
}
