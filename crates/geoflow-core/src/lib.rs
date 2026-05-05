//! GeoFlow core library.
//!
//! Pure-Rust toolkit for AGS 4.x parsing, validation (built-in rules and
//! a CEL-based DSL), and AGS↔DIGGS conversion.

pub mod ags;
pub mod describe;
pub mod diagnostics;
pub mod dict;
pub mod diff;
pub mod diggs;
pub mod dsl;
pub mod explorer;
pub mod export;
pub mod fix;
pub mod model;
pub mod render;
pub mod spatial;
pub mod typecheck;
pub mod validate;

pub use diagnostics::{Diagnostic, Severity};
pub use validate::{validate, Registry, Rule};
