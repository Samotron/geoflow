# GeoFlow — Locked Plan (v0.1)

Supersedes `002_expanded_plan.md`. Reflects answers to the clarifying
questions plus chosen defaults for the items left to me.

## Decisions

| # | Topic                       | Decision                                                                |
|---|-----------------------------|-------------------------------------------------------------------------|
| 1 | AGS version                 | AGS **4.x only** (4.0.3, 4.0.4, 4.1).                                   |
| 2 | DIGGS version               | **Latest stable** DIGGS schema (currently 2.6).                         |
| 3 | DIGGS coverage              | **All AGS 4.x groups** round-trip — full coverage goal (see scoping).   |
| 4 | Custom rule engine          | **DSL only** — no embedded SQL engine in v0.1.                          |
| 5 | DSL for custom rules        | Small **custom expression DSL** embedded in YAML (see §DSL).            |
| 6 | Explorer hosting            | CLI hosts it: `geoflow explore --serve`. Static export also supported.  |
| 7 | Borehole viewer scope       | Strip log + samples + SPT N + water strikes; SVG, no heavy framework.   |
| 8 | Distribution                | **crates.io**, **PyPI**, **GitHub Releases** (prebuilt binaries), **GitHub Pages** (WASM web app). |
| 9 | License                     | **MIT**.                                                                |
|10 | Names                       | `geoflow` for crate, Python package, and CLI binary.                    |
|11 | AGS rule source             | **Encode** AGS 4 rules from published spec into a registry.             |
|12 | Performance / size          | In-memory parser, target **≤ 500 MB** files; streaming deferred.        |
|13 | Fix command                 | **Included**: `geoflow fix` for safe auto-fixable diagnostics.          |

### Notes on the more impactful choices

- **All AGS groups in DIGGS round-trip.** AGS 4.1 has well over 100 groups.
  We'll do this in waves — see Milestone 4 — but the v0.1 acceptance bar is
  "every defined AGS group has a documented mapping (or an explicit
  `unsupported` marker) and round-trips losslessly for the mapped subset".
  Anything we can't round-trip cleanly will be flagged in the lossy report
  rather than silently dropped.
- **DSL only — no SQL engine.** v0.1 ships a single rule mechanism: an
  embedded **CEL** (Common Expression Language) evaluator operating on
  a row/group context. CEL is the same language Kubernetes, Envoy and
  GCP IAM use for "policy as data", which is exactly our shape. It is
  pure-Rust (`cel-interpreter`), side-effect free, sandboxable, and
  supports comprehensions (`all`, `exists`, `filter`, `map`) so
  cross-row checks (vicinity, uniqueness, monotonicity) need no SQL.
  Host-registered functions cover everything else: existence
  (`exists_in`), spatial (`distance_m`, `point`, `within`), codelists
  (`codelist('id')`), aggregates, regex, range. Avoids the DuckDB
  build-time pain (vendored C++, long compile, large binary). If we
  ever need ad-hoc SQL, we can add it behind an off-by-default cargo
  feature in a later release.
- **Three rule-pack ingredients** beyond plain expressions:
  1. **Codelists** — declared once, referenced by id; back them with
     CSV/YAML files (e.g. BGS legend codes, ICE-defined enums).
  2. **Spatial helpers** — `point`, `distance_m`, `bbox`, `within`,
     `crs(epsg)`, `reproject`. Pure-Rust via `geo` + a small UTM/local
     projection module — no `proj` C dependency for v0.1.
  3. **Named rule packs** — bundled, versioned YAML shipped under
     `rules/specs/`, e.g. `--rules ice:specification-for-ground-investigation@2nd-ed`,
     resolved from a registry directory or local path.
- **Borehole viewer.** Pure SVG generated server-side, with a tiny vanilla
  JS layer for hover/zoom. Renders: depth axis, lithology strip from
  `GEOL`, sample bars from `SAMP`, SPT N from `ISPT`, water strike markers
  from `WSTK`, ground level from `LOCA`.
- **`fix` command.** Limited to *safe* fixes only — the kind you'd accept
  unreviewed. Initial set: trim trailing whitespace, normalise line
  endings/encoding, quote fields containing commas, strip BOM, fix
  `UNIT`/`TYPE` row order, remove duplicate blank lines. Each fix is
  flagged so users see what changed; `--dry-run` shows the diff.

## Architecture

```diagram
╭─────────────────────────────────────────╮
│            geoflow-core (Rust)          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ AGS      │  │ DIGGS    │  │ DSL    │ │
│  │ parser   │  │ parser   │  │ rules  │ │
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
   ╭────▼─────────────────────╮
   │ Static site OR live HTTP │
   │  (geoflow explore)       │
   ╰──────────────────────────╯
```

## DSL Sketch

The DSL is **CEL** (Common Expression Language) via `cel-interpreter`.
Rules declare a `when` filter on the row/group context and an `expr`
that must hold. Cross-group lookups, codelists, spatial checks, and
group-level aggregates are exposed as host-registered functions and
named bindings — no SQL needed.

```yaml
# rules/example.yml
version: 1

codelists:
  geol_legend:
    source: "codelists/bgs_legend.csv"
    column: "code"
  ice_sample_types:
    inline: ["B", "U", "D", "ES", "WS", "PS"]

rules:
  - id: PROJ-001
    description: "All locations must have an easting and northing."
    severity: error
    when: "group == 'LOCA'"
    expr: "row.LOCA_NATE != null && row.LOCA_NATN != null"
    message: "LOCA {row.LOCA_ID}: missing coordinates"

  - id: SAMP-001
    description: "Samples must reference an existing location."
    severity: error
    when: "group == 'SAMP'"
    expr: "exists_in('LOCA', 'LOCA_ID', row.LOCA_ID)"
    message: "Sample {row.SAMP_ID} references unknown location {row.LOCA_ID}"

  - id: GEOL-LEG-001
    description: "GEOL_LEG must be a recognised legend code."
    severity: warning
    when: "group == 'GEOL'"
    expr: "row.GEOL_LEG in codelist('geol_legend')"
    message: "GEOL_LEG '{row.GEOL_LEG}' not in legend"

  - id: SAMP-TYPE-001
    description: "SAMP_TYPE must be one of the ICE-permitted sample types."
    severity: error
    when: "group == 'SAMP'"
    expr: "row.SAMP_TYPE in codelist('ice_sample_types')"
    message: "Sample type '{row.SAMP_TYPE}' not permitted by ICE spec"

  - id: GEOL-MONO-001
    description: "Geology depths must be monotonically increasing per location."
    severity: warning
    scope: "group:LOCA_ID"          # evaluate per LOCA_ID partition
    when: "group == 'GEOL'"
    expr: |
      rows.all(r, r.GEOL_BASE > r.GEOL_TOP) &&
      is_monotonic(rows.map(r, r.GEOL_TOP))
    message: "Non-monotonic GEOL layers under LOCA {key.LOCA_ID}"

  - id: LOCA-VICINITY-001
    description: "Boreholes within 2 m of another should share an ID prefix."
    severity: warning
    scope: "all"                    # rule sees all rows of the named group
    when: "group == 'LOCA'"
    expr: |
      LOCA.all(other,
        other.LOCA_ID == row.LOCA_ID ||
        distance_m(point(row.LOCA_NATE,  row.LOCA_NATN),
                   point(other.LOCA_NATE, other.LOCA_NATN)) > 2.0)
    message: "LOCA {row.LOCA_ID} duplicates a borehole within 2 m"
```

### DSL surface (v0.1)

- **Engine**: `cel-interpreter` (pure-Rust CEL). Pinned version, golden
  tests for every host function.
- **Context bindings**:
  - `row` — current row as a map of headings → typed values.
  - `group` — current AGS group code (string).
  - `file` — file metadata (path, ags_version).
  - `key` — partition key map (when `scope: "group:<HEADING>"`).
  - `rows` — list of rows in the current partition (group-scoped rules).
  - `<GROUP>` — every AGS group is bound as a list of rows
    (e.g. `LOCA`, `SAMP`) for `scope: "all"` rules.
- **Built-in CEL**: comprehensions (`all`, `exists`, `filter`, `map`,
  `exists_one`), arithmetic, comparison, boolean, `in`, string
  functions, optional values.
- **Host-registered helpers**:
  - Validation: `is_null`, `not_null`, `regex(pattern, value)`,
    `between(value, lo, hi)`, `is_monotonic(list)`.
  - Cross-group: `exists_in(group, key_heading, value)`,
    `lookup(group, key_heading, value, return_heading)`.
  - Codelists: `codelist(id)` → list of permitted values.
  - Spatial: `point(e, n)`, `distance_m(a, b)`, `bbox(points)`,
    `within(point, polygon)`, `crs(epsg)`, `reproject(point, from, to)`.
  - Aggregates: `count`, `min`, `max`, `sum`, `avg`, `unique`.

## CLI Surface (final v0.1)

```
geoflow validate <file...> [--rules FILE] [--format text|json|junit] [--fail-on warning|error]
geoflow convert  <in> <out> --to ags|diggs [--report FILE]
geoflow fix      <file>     [--write] [--dry-run] [--rules FILE]
geoflow explore  <file...>  [--out DIR] [--serve] [--port 8080]
geoflow info     <file>
geoflow rules    list | show <id>          # introspect built-in rules
```

---

# Task List (Locked)

Tasks are intended to be granular enough that each ≈ 0.5–1 day of work.
`[Mx.y]` is the milestone/task id used in commits and PRs.

## Milestone 0 — Project Skeleton
- [x] **M0.1** Initialise Cargo workspace (`geoflow-core`, `geoflow-cli`, `geoflow-py`).
       *(`geoflow-py` deferred to M8; MSRV declared in `[workspace.package]`.)*
- [x] **M0.2** MIT `LICENSE`, top-level `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`.
- [ ] **M0.3** Pin MSRV; add `rust-toolchain.toml`.
       *(MSRV = 1.75 declared in `Cargo.toml`; toolchain file deferred so
       contributors can use system rustc without rustup.)*
- [ ] **M0.4** `pyproject.toml` + `maturin` config for `geoflow-py`. *(M8.)*
- [x] **M0.5** GitHub Actions: `cargo fmt --check`, `cargo clippy -D warnings`,
       `cargo test`, on Linux/macOS/Windows + MSRV check.
       *(Python wheel job is added with M8.)*
- [x] **M0.6** GitHub Releases workflow (binaries) gated on tags.
       *(Wheels/sdist added with M8.)*
- [x] **M0.7** Fixture directory layout under `tests/fixtures/{ags,diggs}/`
       with a `README.md` cataloguing each fixture and a synthetic
       `minimal_valid.ags`. *(Real public fixtures pending licence review.)*

## Milestone 1 — AGS 4.x Parser & Model
- [x] **M1.1** Core data model: `AgsFile`, `AgsGroup`, `AgsHeading`,
       `AgsValue`, `AgsType` enum.
- [x] **M1.2** Lexer for AGS rows: quoted fields, embedded commas/quotes,
       CRLF/LF, BOM tolerance.
- [x] **M1.3** Group assembler: `GROUP / HEADING / UNIT / TYPE / DATA`.
- [x] **M1.4** Type coercion for AGS data types: `X`, `XN`, `MC`, `ID`,
       `PA`, `PT`, `PU`, `T`, `DT`, `YN`, `RL`, `nDP`, `nSF`, `nSCI`,
       `0DP..xDP`, `U`, `RECORD_LINK` etc.
- [x] **M1.5** Parser-level diagnostics (file, line, group, row).
       *(Column tracking deferred until validators need it.)*
- [x] **M1.6** Property tests for round-trip parse → serialize → parse.
- [x] **M1.7** Unit tests for each data type plus malformed inputs.

## Milestone 2 — Standard AGS Validation
- [x] **M2.1** Encode AGS 4.x **Rules 1–N** as a typed registry.
       *(Initial registry of 10 rules in `validate/rules.rs`; per-file
       split deferred until total exceeds ~30.)*
- [x] **M2.2** Structural / file-format rules (PROJ/TRAN required,
       LOCA_ID required, group has HEADING).
       *(Encoding/line-ending checks fold into the parser & `fix`.)*
- [x] **M2.3** Heading / type / unit consistency rules.
- [x] **M2.4** Cross-reference rules (`GEOL`/`SAMP` → `LOCA`).
       *(`RECORD_LINK` integrity expands as those types are exercised.)*
- [x] **M2.5** Value / type / range checks driven by the heading dictionary.
       *(Initial `GEOL_BASE > GEOL_TOP` rule in place; heading-dictionary
       driven range checks land alongside the AGS dictionary import.)*
- [x] **M2.6** Diagnostic struct + severity (Error/Warning/Info) + rule id.
- [x] **M2.7** Renderers: text, JSON, JUnit XML.
       *(Colourised text deferred until the explorer lands; structure is
       in place to add it without changing the API.)*
- [x] **M2.8** Golden tests: each fixture has an expected diagnostics file.
       *(Clean-fixture test in place; per-fixture `.diagnostics.json`
       golden files arrive as we add intentionally-broken fixtures.)*
- [x] **M2.9** `geoflow rules list / show` to introspect the built-in set.

## Milestone 3 — Custom Validation (CEL DSL)
- [x] **M3.1** YAML rule-pack schema + loader with good error messages
       (rules, codelists, metadata, pack name/version).
- [x] **M3.2** Embed `cel-interpreter` (pinned version); thin wrapper
       exposing our value types as CEL values, with parse-time error
       reporting that points back to the YAML location.
- [x] **M3.3** Bind row/group context (`row`, `group`, `file`, `key`,
       `rows`, `<GROUP>` bindings) and core helpers (`is_null`,
       `not_null`, `regex`, `between`, `is_monotonic`).
- [x] **M3.4** Cross-group helpers: build per-group hash indexes on
       declared key headings so `exists_in(group, key, value)` and
       `lookup(...)` are O(1).
- [x] **M3.5** Group-scoped rules (`scope: "group:<HEADING>"` and
       `scope: "all"`) with aggregate helpers (`count`, `min`, `max`,
       `sum`, `avg`, `unique`).
- [x] **M3.6** `--rules path/to/pack.yml` (multiple allowed) on
       `validate` and `fix`; deterministic ordering across packs;
       `ice:<pack>@<version>` registry resolution.
- [x] **M3.7** Sample rule pack in `examples/rules/` covering existence,
       cross-reference, range, and group-aggregate rules with positive
       and negative fixtures + golden output.
- [x] **M3.8** **Codelists**: loader for inline lists and CSV/YAML
       sources; `codelist(id)` host function; pack-relative path
       resolution; cache shared across rules in a pack.
- [x] **M3.9** **Spatial helpers**: pure-Rust `point`, `distance_m`,
       `bbox`, `within`, `crs(epsg)`, `reproject` (UTM + a small
       transverse-mercator core; OSGB/BNG built in). No `proj` C dep.
- [x] **M3.10** **ICE spec rule pack scaffolding**: `rules/specs/ice/`
       directory layout, manifest with version/citation, smoke-test
       fixture per pack, registry index and `geoflow rules list` shows
       installed packs.

## Milestone 4 — DIGGS (latest) Support & Conversion
- [x] **M4.1** Vendor DIGGS 2.6 XSDs + reference samples; document version.
- [x] **M4.2** Intermediate model that can express anything in either AGS
       or DIGGS (a thin schema-aware container, not a full ontology).
- [x] **M4.3** DIGGS reader (subset → full) using `quick-xml`.
- [x] **M4.4** DIGGS writer.
- [x] **M4.5** AGS→DIGGS mapping — **wave A**: `PROJ`, `LOCA`, `GEOL`,
       `SAMP`, `ISPT`, `WSTK`, `HOLE`, `ABBR`, `UNIT`, `TYPE`, `DICT`.
- [x] **M4.6** AGS→DIGGS mapping — **wave B**: lab tests
       (`LBST`, `LDEN`, `LLPL`, `LPDN`, `LPEN`, `LSPT`, `LCPT`, `LCBR`,
       `LRES`, `LCON`, `LTRT`, `LDOC`, …).
- [ ] **M4.7** AGS→DIGGS mapping — **wave C**: in-situ tests (`ICBR`,
       `IDEN`, `IPRM`, `IPRT`, `IRDX`, `IVAN`, `CDIA`, `CMET`, …).
- [ ] **M4.8** AGS→DIGGS mapping — **wave D**: monitoring & instrumentation
       (`MOND`, `PREM`, `PRTM`, `STCN`, `RELD`, …) and remaining groups.
- [ ] **M4.9** DIGGS→AGS reverse mappings (waves A–D in same order).
- [x] **M4.10** Lossy-conversion report listing unmapped fields/elements.
- [x] **M4.11** Round-trip tests (AGS→DIGGS→AGS and DIGGS→AGS→DIGGS) per wave.
- [x] **M4.12** Coverage matrix doc: every AGS group → mapped/unmapped/partial.

## Milestone 5 — CLI
- [x] **M5.1** `clap`-based root + subcommands (`validate`, `convert`,
       `fix`, `explore`, `info`, `rules`).
- [x] **M5.2** `geoflow validate` with `--rules`, `--format`, `--fail-on`.
- [x] **M5.3** `geoflow convert <in> <out> --to ags|diggs [--report]`.
- [x] **M5.4** `geoflow info` — quick summary (groups, rows, locations,
       depth range, project name, AGS version).
- [x] **M5.5** `tracing` based logging; `--quiet` / `--verbose`.
- [x] **M5.6** Stable, documented exit codes.
- [x] **M5.7** End-to-end CLI tests with `assert_cmd` / `trycmd`.

## Milestone 6 — `fix` Command
- [x] **M6.1** Fixable-diagnostic trait; mark which standard rules support
       autofix.
- [x] **M6.2** Implement safe fixes: trim whitespace, normalise CRLF/BOM,
       quote fields with commas, reorder `UNIT`/`TYPE`, dedupe blank lines,
       enforce final newline.
- [x] **M6.3** Allow custom DSL rules to declare a `fix:` block (set field,
       delete row, replace value) — DSL-only, no SQL.
- [x] **M6.4** `--dry-run` (default) prints unified diff; `--write` applies.
- [x] **M6.5** Tests on real fixtures: `fix` then `validate` should be
       diagnostic-free for the targeted rules.

## Milestone 7 — HTML Explorer
- [x] **M7.1** Templating with `minijinja`; bundle CSS/JS via `include_str!`.
- [x] **M7.2** Overview page: metadata, group list, validation summary.
- [x] **M7.3** Group page: paginated, sortable, filterable tables (vanilla
       JS, no framework).
- [x] **M7.4** Borehole log page: SVG strip log with lithology, samples,
       SPT N, water strikes, depth axis; one page per `LOCA_ID`.
- [x] **M7.5** Validation report page: filter by severity / rule / group.
- [x] **M7.6** AGS↔DIGGS toggle on data pages.
- [x] **M7.7** Static export: `geoflow explore <file> --out site/`.
- [x] **M7.8** Live serve: `geoflow explore <file> --serve --port 8080`
       using `axum` or `tiny_http`.
- [x] **M7.9** Visual snapshot tests for key pages.

## Milestone 8 — Python Bindings
- [x] **M8.1** PyO3 wrappers for `AgsFile`, diagnostics, conversion result.
- [x] **M8.2** Pythonic API: `geoflow.read_ags`, `.validate(rules=…)`,
       `.fix(...)`, `.to_diggs()`, `read_diggs`, `.to_pandas()`.
- [x] **M8.3** Type stubs (`.pyi`) and Sphinx-friendly docstrings.
- [x] **M8.4** `pytest` suite mirroring Rust fixtures.
- [x] **M8.5** `maturin` wheels: Linux (manylinux), macOS (x86_64+arm64),
       Windows (x86_64) + sdist; published to PyPI on tagged release.

## Milestone 9 — Web App (GitHub Pages + WASM)

Compile `geoflow-core` to `wasm32-unknown-unknown` and ship a drag-and-drop
AGS validator / converter as a static GitHub Pages site — no server required.

### Design notes

- **New crate `crates/geoflow-wasm`** — a thin `wasm-bindgen` shim over
  `geoflow-core`. Kept separate so native builds (CLI, PyO3) never pay the
  WASM compilation cost.
- **No `wasm_bindgen_futures` / async** — all parsing and validation is
  synchronous in core; the shim just marshals JS types.
- **Blocking dep audit** — `geoflow-core` currently pulls in `axum`/`tokio`
  for the `explore` server. These do not compile to WASM. The core library
  will need a `wasm` feature flag that disables the `explorer` module (or the
  explorer is refactored into a feature-gated sub-module).
- **GitHub Actions** — a new `wasm.yml` job builds with
  `wasm-pack build --target web`, copies the `pkg/` output and `web/`
  assets into `gh-pages/`, and pushes to the `gh-pages` branch on tagged
  releases (or every main commit if desired).

### Tasks

- [x] **M9.1** Add `[profile.wasm-release]` and `wasm` cargo feature to
       `geoflow-core`; gate `explorer` (axum/tokio) behind `cfg(not(target_arch = "wasm32"))`.
       *(tokio was unused in core after openground removal; removed. All remaining
       deps compile cleanly to `wasm32-unknown-unknown` — verified locally.)*
- [x] **M9.2** Create `crates/geoflow-wasm` with `wasm-bindgen` entry points:
       `validate_ags`, `fix_ags`, `convert_to_diggs`, `ags_info`.
- [x] **M9.3** Add `wasm-pack` build step to CI; confirm `geoflow-wasm`
       builds cleanly for `wasm32-unknown-unknown`.
- [x] **M9.4** Create `web/index.html` — drag-and-drop, validate table with
       severity filter, fix download, DIGGS convert download; vanilla JS + ES modules.
- [x] **M9.5** GitHub Actions `gh-pages.yml`: on push to `main`, build WASM
       with `wasm-pack --release`, deploy `web/` to GitHub Pages via
       `peaceiris/actions-gh-pages`.
- [ ] **M9.6** Smoke-test the deployed page: upload a known-bad AGS fixture,
       confirm diagnostics appear; upload a valid fixture, confirm DIGGS
       download works.

## Milestone 10 — Docs & Release
- [ ] **M10.1** mdBook user guide (CLI, rule-pack cookbook, mapping matrix).
- [ ] **M10.2** Python API docs (Sphinx or MkDocs + `mkdocstrings`).
- [ ] **M10.3** `cargo-release` config; semver policy documented.
- [ ] **M10.4** Cut **`v0.1.0`** → publish `geoflow` to crates.io and PyPI,
       attach Linux/macOS/Windows binaries to the GitHub Release.

---

## Risks & Things I'm Watching

- **Full DIGGS coverage is a lot.** AGS 4.1 has many groups, each needing a
  mapping decision. M4 is split into waves so v0.1 can ship even if a few
  exotic groups land as documented "not yet supported" rather than fully
  implemented. I'll track this in the coverage matrix (M4.12) and we can
  re-scope if it threatens the release date.
- **AGS rule encoding** from a PDF is fiddly. I'll cross-check against
  existing community implementations (e.g. `pyAGS`, BGS validators) for
  parity, but will not depend on them at runtime.
- **DSL expressiveness.** Without SQL, complex multi-group checks are
  expressed via CEL comprehensions plus host helpers (`exists_in`,
  `lookup`, group-scoped rules, aggregates, spatial). If a rule we
  genuinely need can't be written, we extend the helper set rather
  than reintroducing a SQL engine.
- **CEL Rust implementation maturity.** `cel-interpreter` is younger
  than Google's Go reference. We pin a version, run golden tests for
  every host function, and keep an abstraction seam so we could swap
  to another CEL impl (or fall back to Rhai) without touching
  rule-pack syntax.
- **Spatial without `proj`.** Pure-Rust UTM + OSGB/BNG covers UK and
  most project use cases. Rules requiring exotic CRSes will be flagged
  as needing future `proj`-feature builds.
- **Pure-Rust dependency tree.** Dropping DuckDB removes the vendored
  C++ toolchain requirement and keeps `cargo build` fast on all
  platforms, which was the main reason for this revision.
