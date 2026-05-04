//! Codelists: named lists of permitted values, exposed to rules via the
//! `codelist(id)` host function.
//!
//! Codelists may be declared inline in the pack YAML, or sourced from a
//! CSV or YAML file referenced relative to the pack file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A loaded codelist (after path resolution and CSV parsing).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Codelist {
    pub id: String,
    pub values: Vec<String>,
}

/// On-disk codelist declaration (the `codelists:` map in YAML).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CodelistSpec {
    Inline {
        inline: Vec<String>,
    },
    Csv {
        source: PathBuf,
        #[serde(default = "default_csv_column")]
        column: String,
        #[serde(default)]
        has_header: Option<bool>,
    },
    Yaml {
        yaml: PathBuf,
        #[serde(default)]
        key: Option<String>,
    },
}

fn default_csv_column() -> String {
    "code".to_string()
}

impl CodelistSpec {
    /// Load a codelist into its concrete value list, resolving `source`
    /// relative to `pack_dir`.
    pub fn load(self, id: impl Into<String>, pack_dir: &Path) -> Result<Codelist, CodelistError> {
        let id = id.into();
        match self {
            CodelistSpec::Inline { inline } => Ok(Codelist { id, values: inline }),
            CodelistSpec::Csv {
                source,
                column,
                has_header,
            } => {
                let resolved = if source.is_absolute() {
                    source
                } else {
                    pack_dir.join(source)
                };
                let bytes = std::fs::read(&resolved).map_err(|e| CodelistError::Io {
                    path: resolved.clone(),
                    source: e,
                })?;
                let mut rdr = csv::ReaderBuilder::new()
                    .has_headers(has_header.unwrap_or(true))
                    .from_reader(bytes.as_slice());
                let headers: Vec<String> = rdr
                    .headers()
                    .map(|h| h.iter().map(str::to_string).collect())
                    .unwrap_or_default();
                let col_index = headers.iter().position(|h| h == &column).ok_or_else(|| {
                    CodelistError::MissingColumn {
                        path: resolved.clone(),
                        column: column.clone(),
                    }
                })?;
                let mut values = Vec::new();
                for record in rdr.records() {
                    let record = record.map_err(|e| CodelistError::Csv {
                        path: resolved.clone(),
                        source: e,
                    })?;
                    if let Some(field) = record.get(col_index) {
                        values.push(field.to_string());
                    }
                }
                Ok(Codelist { id, values })
            }
            CodelistSpec::Yaml { yaml, key } => {
                let resolved = if yaml.is_absolute() {
                    yaml
                } else {
                    pack_dir.join(yaml)
                };
                let text = std::fs::read_to_string(&resolved).map_err(|e| CodelistError::Io {
                    path: resolved.clone(),
                    source: e,
                })?;
                let doc: serde_yaml::Value =
                    serde_yaml::from_str(&text).map_err(|e| CodelistError::Yaml {
                        path: resolved.clone(),
                        source: e,
                    })?;
                let values = load_yaml_values(&resolved, doc, key.as_deref())?;
                Ok(Codelist { id, values })
            }
        }
    }
}

fn load_yaml_values(
    path: &Path,
    doc: serde_yaml::Value,
    key: Option<&str>,
) -> Result<Vec<String>, CodelistError> {
    let seq = match doc {
        serde_yaml::Value::Sequence(seq) => seq,
        other => {
            return Err(CodelistError::InvalidYamlShape {
                path: path.to_path_buf(),
                message: format!("expected top-level YAML sequence, got {other:?}"),
            });
        }
    };

    let mut values = Vec::with_capacity(seq.len());
    for item in seq {
        let value = match key {
            Some(field) => {
                let mapping = item
                    .as_mapping()
                    .ok_or_else(|| CodelistError::InvalidYamlShape {
                        path: path.to_path_buf(),
                        message: format!("expected mapping entries when key {field:?} is set"),
                    })?;
                let field_value = mapping
                    .get(serde_yaml::Value::String(field.to_string()))
                    .ok_or_else(|| CodelistError::MissingYamlKey {
                        path: path.to_path_buf(),
                        key: field.to_string(),
                    })?;
                yaml_scalar_to_string(path, field_value)?
            }
            None => yaml_scalar_to_string(path, &item)?,
        };
        values.push(value);
    }
    Ok(values)
}

fn yaml_scalar_to_string(path: &Path, value: &serde_yaml::Value) -> Result<String, CodelistError> {
    match value {
        serde_yaml::Value::String(s) => Ok(s.clone()),
        serde_yaml::Value::Number(n) => Ok(n.to_string()),
        serde_yaml::Value::Bool(b) => Ok(b.to_string()),
        other => Err(CodelistError::InvalidYamlShape {
            path: path.to_path_buf(),
            message: format!("expected scalar YAML value, got {other:?}"),
        }),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CodelistError {
    #[error("reading codelist {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("parsing CSV codelist {path}: {source}")]
    Csv {
        path: PathBuf,
        #[source]
        source: csv::Error,
    },
    #[error("parsing YAML codelist {path}: {source}")]
    Yaml {
        path: PathBuf,
        #[source]
        source: serde_yaml::Error,
    },
    #[error("codelist {path}: column {column:?} not found")]
    MissingColumn { path: PathBuf, column: String },
    #[error("codelist {path}: YAML key {key:?} not found")]
    MissingYamlKey { path: PathBuf, key: String },
    #[error("codelist {path}: invalid YAML shape: {message}")]
    InvalidYamlShape { path: PathBuf, message: String },
}

/// Container holding every loaded codelist by id.
#[derive(Debug, Default, Clone)]
pub struct Codelists {
    by_id: HashMap<String, Codelist>,
}

impl Codelists {
    pub fn insert(&mut self, c: Codelist) {
        self.by_id.insert(c.id.clone(), c);
    }
    pub fn get(&self, id: &str) -> Option<&Codelist> {
        self.by_id.get(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn loads_inline_codelist() {
        let spec = CodelistSpec::Inline {
            inline: vec!["A".into(), "B".into()],
        };
        let cl = spec.load("kinds", Path::new(".")).unwrap();
        assert_eq!(cl.values, vec!["A", "B"]);
    }

    #[test]
    fn loads_csv_codelist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legend.csv");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "code,name").unwrap();
        writeln!(f, "TS,Topsoil").unwrap();
        writeln!(f, "CL,Clay").unwrap();
        let spec = CodelistSpec::Csv {
            source: PathBuf::from("legend.csv"),
            column: "code".into(),
            has_header: Some(true),
        };
        let cl = spec.load("legend", dir.path()).unwrap();
        assert_eq!(cl.values, vec!["TS", "CL"]);
    }

    #[test]
    fn missing_column_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.csv");
        std::fs::write(&path, "a,b\n1,2\n").unwrap();
        let spec = CodelistSpec::Csv {
            source: PathBuf::from("x.csv"),
            column: "missing".into(),
            has_header: Some(true),
        };
        let err = spec.load("x", dir.path()).unwrap_err();
        assert!(matches!(err, CodelistError::MissingColumn { .. }));
    }

    #[test]
    fn loads_yaml_scalar_codelist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legend.yml");
        std::fs::write(&path, "- TS\n- CL\n").unwrap();
        let spec = CodelistSpec::Yaml {
            yaml: PathBuf::from("legend.yml"),
            key: None,
        };
        let cl = spec.load("legend", dir.path()).unwrap();
        assert_eq!(cl.values, vec!["TS", "CL"]);
    }

    #[test]
    fn loads_yaml_mapping_codelist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legend.yml");
        std::fs::write(&path, "- code: TS\n- code: CL\n").unwrap();
        let spec = CodelistSpec::Yaml {
            yaml: PathBuf::from("legend.yml"),
            key: Some("code".into()),
        };
        let cl = spec.load("legend", dir.path()).unwrap();
        assert_eq!(cl.values, vec!["TS", "CL"]);
    }
}
