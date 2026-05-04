# GeoFlow — Expanded Plan (v0.1)

## Overview

GeoFlow is a toolkit for working with geotechnical data file formats (initially
**AGS** and **DIGGS**). It ships as:

- A **Rust core library** (`geoflow-core`) implementing parsing, validation,
  and conversion logic.
- A **Python package** (`geoflow`) built with **maturin/PyO3** exposing the
  Rust core to Python users.
- A **Rust CLI** (`geoflow`) for command-line workflows: validation,
  conversion, and publishing a static HTML "explorer" site.

The goal of v0.1 is a usable, well-tested baseline covering AGS validation,
extensible custom-rule validation, AGS↔DIGGS conversion with a viewer, and a
self-contained HTML explorer.

## Target Users

- Geotechnical engineers who receive AGS files and need to validate /
  inspect them.
- Data engineers integrating AGS/DIGGS into pipelines (Python users).
- QA reviewers who want a shareable HTML report of a dataset.

## Architecture

```diagram
╭─────────────────────────────────────────╮
│            geoflow-core (Rust)          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ AGS      │  │ DIGGS    │  │ Rules  │ │
│  │ parser   │  │ parser   │  │ engine │ │
│  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │             │            │      │
│  ┌────▼─────────────▼────────────▼────┐ │
│  │          Conversion / Model        │ │
│  └────┬────────────────────────────┬──┘ │
╰───────┼────────────────────────────┼────╯
        │                            │
   ╭────▼─────╮                ╭─────▼────╮
   │ Rust CLI │                │ PyO3 API │
   │ geoflow  │                │ geoflow  │
   ╰────┬─────╯                ╰──────────╯
        │
   ╭────▼─────────────╮
   │ Static HTML site │
   │ (explorer)       │
   ╰──────────────────╯
```

## v0.1 Features (Detailed)

### 1. AGS Validation Against Standard Rules
- Parse AGS 4.x format files (group/heading/unit/type/data row structure).
- Validate against the published AGS rules (structural, syntactic,
  cross-reference / referential integrity, data type checks).
- Produce machine-readable diagnostics (file, group, row, column, rule id,
  severity, message).
- Output formats: human-readable, JSON, JUnit XML (for CI use).

### 2. Custom Validation (YAML DSL + SQL)
- A YAML configuration file lets users add project-specific rules without
  writing code.
- Two complementary mechanisms:
  - **DSL rules** — declarative checks (required groups/headings, value
    ranges, regex matches, cross-group references, conditional requirements).
  - **SQL rules** — load AGS into an in-process SQL engine (DuckDB) where
    each AGS group becomes a table; the rule passes if the query returns
    zero rows (or matches a configured expectation).
- Rules carry id, description, severity, and a message template.

### 3. AGS ↔ DIGGS Conversion + Viewer
- Bidirectional conversion between AGS and DIGGS (DIGGS XML schema).
- Lossy conversions are explicitly reported (which fields couldn't be
  mapped).
- A simple **viewer**: as part of the explorer site, render a side-by-side
  or tabbed view of the same data in AGS and DIGGS form, with a basic
  borehole log visualisation.

### 4. AGS Explorer (Static HTML Site)
- `geoflow explore <input>` produces a directory of static HTML/JS/CSS that
  can be opened locally or hosted.
- Pages: overview / file metadata, per-group tables (sortable, filterable),
  per-borehole log views (lithology strip log from `GEOL`, sample/test
  markers), validation report, optional DIGGS view.
- All assets bundled — no external CDN required.

## Non-Goals (v0.1)
- AGS 3.x support.
- Editing/writing tools beyond format conversion.
- A hosted web service or backend.
- Real-time collaboration.
- Full DIGGS schema coverage — only the subset needed to round-trip
  the AGS groups we support.

## Tech Choices (proposed)
- Rust 2021, workspace with `geoflow-core`, `geoflow-cli`, `geoflow-py`.
- Parsing: hand-rolled or `csv` crate for AGS; `quick-xml` for DIGGS.
- SQL engine: **DuckDB** (via `duckdb` crate) for SQL rules.
- Python bindings: `pyo3` + `maturin`.
- HTML site: pre-rendered via a small Rust template engine (`minijinja` or
  `askama`) plus a single bundled JS file (vanilla or a small framework like
  Preact/Alpine).
- Testing: `cargo test`, `pytest`, sample AGS/DIGGS fixtures.

---

# Task List

## Milestone 0 — Project Skeleton
- [ ] T0.1 Create Cargo workspace: `geoflow-core`, `geoflow-cli`, `geoflow-py`.
- [ ] T0.2 Configure `maturin` / `pyproject.toml` for `geoflow-py`.
- [ ] T0.3 CI: GitHub Actions for `cargo test`, `cargo clippy`, `cargo fmt`,
       `maturin build`, `pytest`.
- [ ] T0.4 Repository hygiene: README, LICENSE, CONTRIBUTING, MSRV pin.
- [ ] T0.5 Sample fixtures: collect a handful of public AGS and DIGGS files
       and store under `tests/fixtures/`.

## Milestone 1 — AGS Parser & Model
- [ ] T1.1 Define core data model (`AgsFile`, `AgsGroup`, `AgsHeading`,
       `AgsRow`, type system for AGS data types).
- [ ] T1.2 Implement AGS 4.x lexer / row parser handling quoted fields,
       embedded commas/quotes, line endings.
- [ ] T1.3 Build group assembly: HEADING/UNIT/TYPE/DATA rows → typed group.
- [ ] T1.4 Type coercion: `X`, `XN`, `MC`, `DT`, `T`, `DMS`, `2DP`, `3SF`, etc.
- [ ] T1.5 Parser error reporting with file/line/column.
- [ ] T1.6 Unit tests covering each AGS data type and malformed inputs.

## Milestone 2 — Standard AGS Validation
- [ ] T2.1 Encode AGS 4 standard rules (Rule 1..N) as a rule registry.
- [ ] T2.2 Structural rules (file format, group ordering, required headings).
- [ ] T2.3 Cross-reference rules (e.g. `SAMP.LOCA_ID` must exist in `LOCA`).
- [ ] T2.4 Data type / unit / range checks per heading definition.
- [ ] T2.5 Diagnostics struct + severity levels (Error/Warning/Info).
- [ ] T2.6 Output renderers: text, JSON, JUnit XML.
- [ ] T2.7 Golden-file tests against fixtures with known issues.

## Milestone 3 — Custom Validation (DSL + SQL)
- [ ] T3.1 Define YAML schema for rule files (rule id, description,
       severity, kind=`dsl`|`sql`, expression, message).
- [ ] T3.2 DSL grammar: required headings, regex, numeric range, set
       membership, conditional (`when … require …`), cross-group refs.
- [ ] T3.3 DSL evaluator over the AGS model.
- [ ] T3.4 DuckDB integration: load each group as a table; expose pragmas
       for heading metadata.
- [ ] T3.5 SQL rule runner: zero-row pass / expectation modes.
- [ ] T3.6 CLI flag `--rules <file.yml>` to run alongside standard rules.
- [ ] T3.7 Tests: example custom rule pack with positive/negative fixtures.

## Milestone 4 — DIGGS Support & Conversion
- [ ] T4.1 Choose DIGGS schema version; vendor or fetch XSDs.
- [ ] T4.2 DIGGS reader (subset) using `quick-xml` into intermediate model.
- [ ] T4.3 DIGGS writer (subset) from intermediate model.
- [ ] T4.4 AGS → DIGGS mapping for supported groups (LOCA, GEOL, SAMP,
       basic in-situ tests).
- [ ] T4.5 DIGGS → AGS mapping (reverse of above).
- [ ] T4.6 Lossy-conversion report (list of unmapped fields/elements).
- [ ] T4.7 Round-trip conversion tests.

## Milestone 5 — CLI
- [ ] T5.1 Argument parser (`clap`) and subcommand layout:
      `validate`, `convert`, `explore`, `info`.
- [ ] T5.2 `geoflow validate <file> [--rules …] [--format text|json|junit]`.
- [ ] T5.3 `geoflow convert <in> <out> --to ags|diggs`.
- [ ] T5.4 `geoflow info <file>` — quick summary (groups, row counts, locs).
- [ ] T5.5 Exit codes that work in CI (non-zero on errors, configurable on
       warnings).
- [ ] T5.6 Logging with `tracing`; `--quiet` / `--verbose` flags.

## Milestone 6 — HTML Explorer
- [ ] T6.1 Templating layer (`minijinja`/`askama`) and asset bundling.
- [ ] T6.2 Overview page: file metadata, group list, validation summary.
- [ ] T6.3 Group page: paginated/sortable/filterable table per group.
- [ ] T6.4 Borehole log page: lithology strip from `GEOL`, sample/test
       markers from `SAMP`/`ISPT`/etc., depth axis.
- [ ] T6.5 Validation report page (filterable by severity/rule).
- [ ] T6.6 DIGGS view: AGS↔DIGGS toggle for the same data.
- [ ] T6.7 Single command produces a self-contained directory.
- [ ] T6.8 Visual snapshot tests for key pages.

## Milestone 7 — Python Bindings
- [ ] T7.1 PyO3 wrapper types for `AgsFile`, diagnostics, conversion.
- [ ] T7.2 Pythonic API: `geoflow.read_ags(path)`, `.validate(rules=…)`,
       `.to_diggs()`, `.to_pandas()` (per-group DataFrames).
- [ ] T7.3 Type stubs (`.pyi`) and docstrings.
- [ ] T7.4 `pytest` suite mirroring Rust fixtures.
- [ ] T7.5 Wheels via `maturin` for Linux/macOS/Windows + sdist.

## Milestone 8 — Docs & Release
- [ ] T8.1 mdBook (Rust) + Sphinx or MkDocs (Python) site.
- [ ] T8.2 CLI usage examples and rule-pack cookbook.
- [ ] T8.3 Versioning policy and changelog (`CHANGELOG.md`, `cargo-release`).
- [ ] T8.4 First tagged release: `v0.1.0` to crates.io and PyPI.

---

# Open Questions / Clarifications Needed

1. **AGS version scope** — confine v0.1 to AGS 4.0.4 / 4.1, or do you also
   need AGS 4.x earlier minor versions? Any need for AGS 3.x at all (even
   read-only)?
2. **DIGGS version** — which DIGGS schema version are we targeting (2.5,
   2.6, or latest)? Do you have a preferred reference dataset?
3. **DIGGS subset** — for v0.1, is it OK to round-trip only the AGS groups
   listed (LOCA, GEOL, SAMP, plus a couple of in-situ tests), or is there a
   minimum set of in-situ/lab tests that must be supported?
4. **SQL engine choice** — DuckDB embedded is my default; any objection
   (e.g. licensing, target environments without a C toolchain)? Alternative
   would be SQLite via `rusqlite`.
5. **DSL syntax preference** — are you happy with a YAML-only declarative
   DSL, or would you prefer something more expression-like (e.g. CEL,
   Rhai, or a small custom grammar)? Examples I can share if useful.
6. **Explorer interactivity** — should the HTML site be fully static (no
   JS framework, just vanilla + small helpers), or are you OK with a
   small bundled framework (Preact/Alpine/Svelte) for nicer tables and
   the borehole viewer?
7. **Borehole visualisation** — strip log only for v0.1, or do you want
   sample positions, SPT N-values, water strikes, geology patterns, etc.?
8. **Distribution targets** — do you want `cargo install geoflow`, a
   prebuilt binary release on GitHub, a Homebrew tap, or all of these?
   For Python: PyPI only, or also conda-forge?
9. **License** — MIT / Apache-2.0 dual (Rust default), or something else?
10. **Naming** — is `geoflow` the final name for the crate / Python package
    / CLI binary? Anything to avoid namespace collisions on crates.io and
    PyPI?
11. **AGS rule source of truth** — do you want me to encode the AGS 4
    rules from the published PDF directly, or is there an existing
    machine-readable rules definition you'd like to reuse?
12. **Performance targets** — is there a typical/maximum file size we
    should design for (10 MB? 1 GB?), and do you need streaming parsing or
    is fully in-memory acceptable?
13. **Out-of-scope confirmation** — are AGS writing/editing features
    explicitly deferred beyond conversion, or do you want a basic "fix"
    command for trivial issues (e.g. trim whitespace, normalize line
    endings) in v0.1?
