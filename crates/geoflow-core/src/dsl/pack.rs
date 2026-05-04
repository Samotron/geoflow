//! YAML rule-pack schema and loader.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::codelist::{Codelist, CodelistError, CodelistSpec, Codelists};
use crate::diagnostics::Severity;

/// Top-level rule-pack file.
///
/// Loaded from YAML via [`RulePack::load`] / [`RulePack::parse`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RulePack {
    /// Schema version. Currently only `1` is supported.
    pub version: u32,
    /// Optional pack identifier (e.g. `ice-spec`).
    #[serde(default)]
    pub name: Option<String>,
    /// Optional pack version (e.g. `2nd-ed`).
    #[serde(default)]
    pub pack_version: Option<String>,
    /// Codelists declared by id, before being resolved to value lists.
    #[serde(default)]
    pub codelists: BTreeMap<String, CodelistSpec>,
    /// Rules in declaration order.
    #[serde(default)]
    pub rules: Vec<Rule>,
}

/// A single rule declared in a pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    #[serde(default)]
    pub description: String,
    pub severity: Severity,
    /// Optional CEL expression used as a filter; when omitted the rule
    /// runs for every row of every group.
    #[serde(default)]
    pub when: Option<String>,
    /// Scope of evaluation. Defaults to per-row.
    #[serde(default)]
    pub scope: Scope,
    /// CEL expression that must evaluate to `true`. If `false`, the
    /// rule fires.
    pub expr: String,
    /// Message template; `{row.HEADING}` style placeholders are
    /// substituted before being attached to the diagnostic.
    pub message: String,
    /// Optional automated fix instructions.
    #[serde(default)]
    pub fix: Vec<FixStep>,
}

/// A single step in an automated fix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FixStep {
    /// Heading to modify for field-level operations.
    #[serde(default)]
    pub heading: Option<String>,
    /// Operation to perform.
    #[serde(flatten)]
    pub op: FixOp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "op")]
pub enum FixOp {
    /// Set the field to a literal or CEL-derived value.
    Set { value: String },
    /// Delete the current row.
    DeleteRow,
}

/// Where a rule runs.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Scope {
    /// Run once per `DATA` row of the group named by `when` / `expr`.
    #[default]
    Row,
    /// Run once per AGS file, with every group bound by name.
    File,
    /// Run once per unique value of a heading (partitioned).
    /// Bound as `rows` and `key`.
    Group(String),
}

impl<'de> serde::Deserialize<'de> for Scope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        match s.as_str() {
            "row" => Ok(Scope::Row),
            "file" | "all" => Ok(Scope::File),
            s if s.starts_with("group:") => Ok(Scope::Group(s["group:".len()..].to_string())),
            _ => Err(serde::de::Error::custom(format!(
                "invalid scope: {s}. Expected 'row', 'file', 'all', or 'group:<HEADING>'"
            ))),
        }
    }
}

impl serde::Serialize for Scope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Scope::Row => serializer.serialize_str("row"),
            Scope::File => serializer.serialize_str("file"),
            Scope::Group(h) => serializer.serialize_str(&format!("group:{h}")),
        }
    }
}

/// Errors that can occur while loading a rule pack.
#[derive(Debug, thiserror::Error)]
pub enum RulePackError {
    #[error("reading pack {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("parsing pack {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_yaml::Error,
    },
    #[error("unsupported pack schema version {0}")]
    UnsupportedVersion(u32),
    #[error("invalid built-in pack reference {0:?}; expected <registry>:<pack>@<version>")]
    InvalidReference(String),
    #[error("built-in rule pack {reference:?} not found at {path}")]
    MissingReference { reference: String, path: PathBuf },
    #[error(transparent)]
    Codelist(#[from] CodelistError),
}

impl RulePack {
    /// Load + validate + resolve codelists for a pack on disk.
    pub fn load(path: impl AsRef<Path>) -> Result<LoadedPack, RulePackError> {
        let path = path.as_ref().to_path_buf();
        let text = std::fs::read_to_string(&path).map_err(|e| RulePackError::Io {
            path: path.clone(),
            source: e,
        })?;
        let pack: RulePack = serde_yaml::from_str(&text).map_err(|e| RulePackError::Parse {
            path: path.clone(),
            source: e,
        })?;
        if pack.version != 1 {
            return Err(RulePackError::UnsupportedVersion(pack.version));
        }
        let pack_dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
        let mut codelists = Codelists::default();
        for (id, spec) in pack.codelists.clone() {
            let cl = spec.load(id, &pack_dir)?;
            codelists.insert(cl);
        }
        Ok(LoadedPack {
            source_path: Some(path),
            pack,
            codelists,
        })
    }

    /// Load a pack from either a filesystem path or a built-in registry
    /// reference like `ice:mini@0.1`.
    pub fn load_spec(spec: &str) -> Result<LoadedPack, RulePackError> {
        if let Some(reference) = PackReference::parse(spec) {
            return reference.load();
        }
        Self::load(spec)
    }

    /// Parse from a YAML string (no codelist file IO).
    pub fn parse(yaml: &str) -> Result<RulePack, RulePackError> {
        let pack: RulePack = serde_yaml::from_str(yaml).map_err(|e| RulePackError::Parse {
            path: PathBuf::from("<inline>"),
            source: e,
        })?;
        if pack.version != 1 {
            return Err(RulePackError::UnsupportedVersion(pack.version));
        }
        Ok(pack)
    }

    /// Resolve all inline codelists and return a [`LoadedPack`].
    /// Errors if any CSV codelists are present (as they need a base path).
    pub fn into_loaded(self) -> Result<LoadedPack, RulePackError> {
        let mut codelists = Codelists::default();
        for (id, spec) in self.codelists.clone() {
            if matches!(spec, CodelistSpec::Csv { .. } | CodelistSpec::Yaml { .. }) {
                return Err(CodelistError::Io {
                    path: PathBuf::from("<inline>"),
                    source: std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "file-backed codelists cannot be resolved from an inline pack",
                    ),
                }
                .into());
            }
            let cl = spec.load(id, Path::new("."))?;
            codelists.insert(cl);
        }
        Ok(LoadedPack {
            source_path: None,
            pack: self,
            codelists,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PackReference {
    registry: String,
    pack: String,
    version: String,
}

impl PackReference {
    fn parse(spec: &str) -> Option<Self> {
        let (registry, rest) = spec.split_once(':')?;
        let (pack, version) = rest.split_once('@')?;
        if registry.is_empty() || pack.is_empty() || version.is_empty() {
            return None;
        }
        Some(Self {
            registry: registry.to_string(),
            pack: pack.to_string(),
            version: version.to_string(),
        })
    }

    fn as_spec(&self) -> String {
        format!("{}:{}@{}", self.registry, self.pack, self.version)
    }

    fn path(&self) -> Result<PathBuf, RulePackError> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("rules")
            .join("specs")
            .join(&self.registry)
            .join(&self.pack)
            .join(&self.version)
            .join("pack.yml");
        Ok(root)
    }

    fn load(&self) -> Result<LoadedPack, RulePackError> {
        let path = self.path()?;
        if !path.exists() {
            return Err(RulePackError::MissingReference {
                reference: self.as_spec(),
                path,
            });
        }
        RulePack::load(path)
    }
}

pub fn installed_pack_refs() -> Vec<String> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("rules")
        .join("specs");
    let mut refs = Vec::new();
    let Ok(registries) = std::fs::read_dir(base) else {
        return refs;
    };
    for registry in registries.flatten() {
        let registry_name = registry.file_name().to_string_lossy().to_string();
        let Ok(packs) = std::fs::read_dir(registry.path()) else {
            continue;
        };
        for pack in packs.flatten() {
            let pack_name = pack.file_name().to_string_lossy().to_string();
            let Ok(versions) = std::fs::read_dir(pack.path()) else {
                continue;
            };
            for version in versions.flatten() {
                let version_name = version.file_name().to_string_lossy().to_string();
                let pack_file = version.path().join("pack.yml");
                if pack_file.exists() {
                    refs.push(format!("{registry_name}:{pack_name}@{version_name}"));
                }
            }
        }
    }
    refs.sort();
    refs
}

/// A pack with codelists resolved, ready for evaluation.
#[derive(Debug, Clone)]
pub struct LoadedPack {
    pub pack: RulePack,
    pub codelists: Codelists,
    pub source_path: Option<PathBuf>,
}

impl LoadedPack {
    /// Construct a loaded pack purely from in-memory data (used by tests).
    pub fn from_inline(pack: RulePack, codelists: Vec<Codelist>) -> Self {
        let mut c = Codelists::default();
        for cl in codelists {
            c.insert(cl);
        }
        Self {
            pack,
            codelists: c,
            source_path: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
version: 1
name: example
pack_version: "0.1"
codelists:
  sample_types:
    inline: [B, U, D]
rules:
  - id: PROJ-001
    description: locations need coords
    severity: error
    when: "group == 'LOCA'"
    expr: "row.LOCA_NATE != null && row.LOCA_NATN != null"
    message: "missing coords for {row.LOCA_ID}"
"#;

    #[test]
    fn parses_sample() {
        let pack = RulePack::parse(SAMPLE).unwrap();
        assert_eq!(pack.version, 1);
        assert_eq!(pack.rules.len(), 1);
        assert_eq!(pack.rules[0].id, "PROJ-001");
        assert_eq!(pack.rules[0].severity, Severity::Error);
        assert!(pack.codelists.contains_key("sample_types"));
    }

    #[test]
    fn unsupported_version_errors() {
        let bad = "version: 2\nrules: []\n";
        assert!(matches!(
            RulePack::parse(bad).unwrap_err(),
            RulePackError::UnsupportedVersion(2)
        ));
    }

    #[test]
    fn parses_pack_reference() {
        let reference = PackReference::parse("ice:mini@0.1").unwrap();
        assert_eq!(reference.registry, "ice");
        assert_eq!(reference.pack, "mini");
        assert_eq!(reference.version, "0.1");
    }
}
