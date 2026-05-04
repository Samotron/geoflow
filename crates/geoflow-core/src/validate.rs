//! Validation infrastructure: the [`Rule`] trait, the built-in
//! [`Registry`], and the [`validate`] entry point that runs rules over
//! an [`AgsFile`].

use crate::diagnostics::{Diagnostic, Severity};
use crate::model::AgsFile;

pub mod rules;

/// A built-in validation rule.
pub trait Rule: Send + Sync {
    /// Stable identifier (e.g. `AGS-RULE-1`).
    fn id(&self) -> &str;

    /// One-line human description.
    fn description(&self) -> &str;

    /// Default severity when this rule fires.
    fn default_severity(&self) -> Severity;

    /// Run the rule and append zero or more diagnostics.
    fn check(&self, file: &AgsFile, diagnostics: &mut Vec<Diagnostic>);

    /// The `geoflow fix` fix name that resolves diagnostics from this rule, if one exists.
    fn fixable_by(&self) -> Option<&str> {
        None
    }
}

/// Registry of built-in rules.
pub struct Registry {
    rules: Vec<Box<dyn Rule>>,
    packs: Vec<crate::dsl::LoadedPack>,
}

pub struct RuleInfo {
    pub id: String,
    pub description: String,
    pub severity: Severity,
}

impl Registry {
    /// Construct a registry pre-populated with every built-in rule.
    pub fn standard() -> Self {
        Self {
            rules: rules::standard_rules(),
            packs: rules::standard_packs(),
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &dyn Rule> {
        self.rules.iter().map(|b| b.as_ref())
    }

    /// Return info for all rules in the registry (built-in and packs).
    pub fn all_rules(&self) -> Vec<RuleInfo> {
        let mut out = Vec::new();
        for r in &self.rules {
            out.push(RuleInfo {
                id: r.id().to_string(),
                description: r.description().to_string(),
                severity: r.default_severity(),
            });
        }
        for p in &self.packs {
            for r in &p.pack.rules {
                out.push(RuleInfo {
                    id: r.id.clone(),
                    description: r.description.clone(),
                    severity: r.severity,
                });
            }
        }
        out
    }

    pub fn find(&self, id: &str) -> Option<RuleInfo> {
        if let Some(r) = self.rules.iter().find(|r| r.id() == id) {
            return Some(RuleInfo {
                id: r.id().to_string(),
                description: r.description().to_string(),
                severity: r.default_severity(),
            });
        }
        for p in &self.packs {
            if let Some(r) = p.pack.rules.iter().find(|r| r.id == id) {
                return Some(RuleInfo {
                    id: r.id.clone(),
                    description: r.description.clone(),
                    severity: r.severity,
                });
            }
        }
        None
    }

    pub fn len(&self) -> usize {
        self.rules.len() + self.packs.iter().map(|p| p.pack.rules.len()).sum::<usize>()
    }

    pub fn add_pack(&mut self, pack: crate::dsl::LoadedPack) {
        self.packs.push(pack);
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty() && self.packs.is_empty()
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::standard()
    }
}

/// Run every rule in the registry against `file`.
pub fn validate(file: &AgsFile, registry: &Registry) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    // Run legacy rules
    for rule in registry.iter() {
        let before = diagnostics.len();
        rule.check(file, &mut diagnostics);
        if let Some(fix_id) = rule.fixable_by() {
            for d in &mut diagnostics[before..] {
                d.fix_id = Some(fix_id.to_string());
            }
        }
    }

    // Run DSL packs
    for pack in &registry.packs {
        if let Ok(mut pd) = crate::dsl::evaluate(file, pack) {
            // Apply any hardcoded fix-id mapping for DSL rules that don't
            // define their own fix steps but map to a built-in fixer.
            for d in &mut pd {
                if d.rule_id == "AGS-FMT-001" {
                    d.fix_id = Some("normalize-whitespace".to_string());
                }
            }
            diagnostics.extend(pd);
        }
    }

    diagnostics
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_registry_is_non_empty() {
        let r = Registry::standard();
        assert!(!r.is_empty());
        // Every rule id must be unique.
        let mut ids: Vec<_> = r.all_rules().into_iter().map(|x| x.id).collect();
        ids.sort();
        let dedup_len = {
            let mut clone = ids.clone();
            clone.dedup();
            clone.len()
        };
        assert_eq!(ids.len(), dedup_len, "duplicate rule ids: {ids:?}");
    }
}
