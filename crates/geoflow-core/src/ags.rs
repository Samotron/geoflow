//! AGS 4.x parser, lexer, and serializer.
//!
//! Entry points:
//! - [`parse_str`] — parse AGS text into an [`AgsFile`].
//! - [`parse_bytes`] — parse raw bytes (handles BOM + encoding).
//! - [`serialize`] — write an [`AgsFile`] back out as AGS text.

mod lexer;
mod parser;
mod serializer;

pub use lexer::{tokenize_line, AgsRowKind};
pub use parser::{decode_bytes, parse_bytes, parse_str, ParseOutcome};
pub use serializer::serialize;
