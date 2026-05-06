# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GeoFlow is a pure-Rust toolkit for geotechnical data interchange, focused on AGS 4.x parsing, validation, DIGGS conversion, and borehole exploration. It is in early development (v0.1) and targets a Cargo workspace of three crates.

## Commands

```bash
# Build
cargo build --workspace

# Test all (unit + integration + doc tests)
cargo test --workspace
cargo test --workspace --doc

# Run a single test by name filter
cargo test -p geoflow-core <test_name>

# Lint (warnings are errors in CI)
cargo clippy --workspace --all-targets -- -D warnings

# Format
cargo fmt --all

# Run the CLI locally
cargo run -p geoflow-cli -- <subcommand> [args]
```

CI runs format, clippy, and tests on Linux/macOS/Windows, plus an MSRV check at Rust 1.85.

## Before Every Commit

Run these two commands and fix any issues before committing:

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
```

`cargo fmt` is checked by CI and will fail the build if the code is not formatted.
Never skip this step.

## Workspace Layout

```
crates/
  geoflow-core/   # Library: all parsing, validation, conversion, rendering logic
  geoflow-cli/    # Binary: thin CLI wrapper over geoflow-core
  geoflow-py/     # Python bindings via PyO3 (deferred to Milestone 8)
rules/specs/ice/  # Built-in ICE rule packs (YAML + codelists)
examples/rules/   # Sample rule packs for documentation
tests/fixtures/   # AGS and DIGGS test files
spec/             # Design docs and the locked development plan
```

## Architecture

All significant logic lives in `geoflow-core`. The CLI (`geoflow-cli/src/main.rs`) parses arguments with `clap` and delegates to core functions; it contains no business logic.

### geoflow-core layers (in dependency order)

1. **AGS parser** (`ags/lexer.rs`, `ags/parser.rs`, `ags/serializer.rs`) — tokenises raw AGS text and produces the canonical data model. Types include `AgsFile`, `AgsGroup`, `AgsHeading`, `AgsValue`, and the `AgsType` enum covering all AGS 4.x field types (X, XN, MC, ID, PA, PT, PU, T, DT, YN, RL, nDP, nSF, nSCI, RECORD_LINK).

2. **Data model** (`model.rs`) — the in-memory representation shared by all subsystems.

3. **Built-in validation** (`validate/rules.rs`) — structural, cross-reference, and type-checking rules expressed in Rust.

4. **CEL DSL validation** (`dsl/pack.rs`, `dsl/eval.rs`, `dsl/context.rs`, `dsl/codelist.rs`) — user-supplied YAML rule packs evaluated via `cel-interpreter`. Host functions expose spatial checks, codelist lookups, and cross-group aggregates. The DSL binding context provides `row`, `group`, `file`, `key`, `rows`, and named GROUP references.

5. **DIGGS conversion** (`diggs.rs`) — reads/writes DIGGS XML via `quick-xml`. Currently maps PROJ, LOCA, GEOL, SAMP, ISPT, WSTK; other groups are unmapped (tracked in `spec/004_diggs_coverage_matrix.md`).

6. **Auto-fix engine** (`fix.rs`) — applies safe, non-lossy corrections (whitespace, encoding/BOM, UNIT/TYPE row ordering, trailing commas).

7. **HTML explorer** (`explorer.rs` + `templates/`) — renders SVG borehole strip logs with sample bars, SPT N values, and water strikes. Served via `axum`/`tokio` or written to disk.

8. **Renderer** (`render.rs`) — formats validation output as human-readable text, JSON, or JUnit XML.

### CLI subcommands

| Subcommand | Description |
|---|---|
| `info <file>` | Print AGS file summary |
| `validate <file…>` | Run built-in + rule-pack checks; `--format`, `--fail-on`, `--rules` |
| `fix <file>` | Apply safe auto-fixes; `--write` / `--dry-run` |
| `convert <in> <out> --to ags\|diggs` | Round-trip conversion |
| `explore <file…>` | Generate HTML viewer; `--serve`, `--port`, `--out` |
| `rules list \| show <id>` | Inspect built-in and pack rules |

Exit codes: 0 = success, 1 = validation/expected failure, 2 = usage/runtime error.

## Key Design Decisions

- **No C dependencies** — spatial operations use the pure-Rust `geo` crate; no `proj` or `GDAL`.
- **CEL for user rules** — custom validation is expressed as Common Expression Language predicates in YAML packs, not Rust plugins.
- **Locked plan** — `spec/003_locked_plan.md` defines 8 milestones and tracks task status. Consult it before adding new features to understand scope and sequencing.
- **MSRV is 1.85 stable** — do not use features gated on nightly or later stable releases.
