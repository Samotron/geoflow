//! Custom validation DSL: CEL-based rule packs loaded from YAML.
//!
//! Rule packs declare:
//! - `version` (currently `1`)
//! - optional `name` and `pack_version` for identification
//! - optional `codelists` (inline or CSV-backed)
//! - `rules`, each with an `id`, `severity`, optional `when` filter,
//!   `expr` to evaluate, and a `message` template.
//!
//! See [`pack::RulePack`] for the data model and [`evaluate`] for the
//! evaluation entry point.

mod codelist;
mod context;
mod eval;
mod pack;

pub use codelist::Codelist;
pub use eval::{evaluate, fix, EvalError};
pub use pack::{installed_pack_refs, LoadedPack, Rule, RulePack, RulePackError, Scope};
