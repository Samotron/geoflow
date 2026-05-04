//! AGS 4.x standard heading dictionary and dictionary-based validation rules.

use crate::diagnostics::{Diagnostic, Severity};
use crate::model::AgsFile;
use crate::validate::Rule;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

// ── Dictionary data ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DictFile {
    groups: HashMap<String, GroupDef>,
}

#[derive(Deserialize)]
pub struct GroupDef {
    pub required_headings: Vec<String>,
    pub depth_headings: Vec<String>,
}

static DICT: LazyLock<HashMap<String, GroupDef>> = LazyLock::new(|| {
    let raw = include_str!("../../../rules/specs/ags/dict/ags4.yml");
    let df: DictFile = serde_yaml::from_str(raw).expect("ags4 dict must be valid YAML");
    df.groups
});

pub fn ags4_dict() -> &'static HashMap<String, GroupDef> {
    &DICT
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
        let dict = ags4_dict();
        for (group_name, group_def) in dict {
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
        let dict = ags4_dict();
        for (group_name, group_def) in dict {
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
