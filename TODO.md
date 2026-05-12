# GeoFlow — Rust → TypeScript Migration TODO

Tracks execution of [spec/007_typescript_migration_plan.md](spec/007_typescript_migration_plan.md).
Tick boxes as work lands. One PR-sized chunk per top-level heading.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## M0 — Baseline capture

- [x] `scripts/capture-rust-baselines.ts` (or `.sh`) that runs the current Rust CLI against every fixture and snapshots `stdout` / `stderr` / `exit` / emitted artifacts into `tests/parity/baselines/<cmd>/<fixture>.{out,err,exit,artifacts/}`
- [x] Capture for `info`, `validate`, `fix`, `convert ags→diggs`, `convert diggs→ags`, `diff`, `explore` (one-shot HTML), `rules list`, `rules show <id>`, `db ingest`, `db query`
- [x] Capture rule-pack diagnostics for every `(pack, fixture)` pair into `tests/parity/rules/baselines.json` (gating set for §6.6 conformance bank)
- [x] Inventory of CEL constructs actually used across `rules/specs/` + `examples/rules/` (to size the `cel-to-jexl` shim)
- [x] `tests/parity/whitelist.ts` skeleton with the cosmetic-diff allowlist (timestamps, absolute paths, version strings)

## M1 — Workspace skeleton [DONE]

- [x] `pnpm-workspace.yaml`
- [x] Root `package.json` with shared scripts (`build`, `test`, `lint`, `format`, `typecheck`, `dep:age`)
- [x] `tsconfig.base.json` (strict, ES2022, NodeNext, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- [x] `vite.config.ts` shared preset
- [x] `vitest.workspace.ts` (node + browser + e2e projects)
- [x] Empty packages: `@geoflow/core`, `@geoflow/rules-engine`, `@geoflow/db`, `@geoflow/cli`, `@geoflow/rules`, `apps/web`
- [x] Root `.eslintrc`, `.prettierrc`, `.editorconfig`
- [x] `scripts/check-dep-age.ts` (≥14-day rule, CI-runnable, allowlist file)
- [x] Update `mise.toml` to pin `node@20`, `pnpm@9` (Rust toolchain entries kept until M10 cut-over)
- [x] CI workflow `.github/workflows/ci-ts.yml` (parallel to existing `ci.yml`) running typecheck + lint + dep:age + test + build
- [x] `pnpm install && pnpm test && pnpm -r build` all green on a CI smoke run

## M2 — Model + AGS lexer/parser/serializer (`@geoflow/core`)

- [x] Port `model.rs` → `packages/core/src/model.ts` (`AgsFile`, `AgsGroup`, `AgsHeading`, `AgsValue`, `AgsType` enum)
- [x] `effect/Schema` definitions for the public types; round-trip JSON snapshot test
- [x] Port `ags/lexer.rs` (CRLF/BOM tolerance, quoted fields, embedded commas/quotes)
- [x] Port `ags/parser.rs` (typed file model + parser-level diagnostics)
- [x] Port `ags/serializer.rs` (round-trip)
- [x] Port `ags3.ts` (v3 reader / migration helper)
- [x] Port `dict.rs` + bundled AGS data dictionaries (`rules/specs/ags/dict/ags4.yml`)
- [x] Port `diagnostics.rs` (`Severity`, `Diagnostic`)
- [x] Property tests with `fast-check` (lexer round-trip, serializer round-trip)
- [~] Golden tests: fixture-driven parse + semantic round-trip coverage is in place; remaining lexical mismatches are tracked (`browser_explorer.ags`, `short_row.ags`, `sample_v3.ags`)

## M3 — Rules engine (JEXL) (`@geoflow/rules-engine`)

- [ ] Pack schema (`effect/Schema`): `RulePack`, `Rule`, `Scope`, `FixStep`, `FixOp`
- [ ] YAML loader (uses `yaml` package + Effect `FileSystem`)
- [ ] Codelist loader (`inline`, `csv`, `yaml`); port `dsl/codelist.rs`
- [ ] JEXL evaluator wrapper: compile rule once, evaluate per row/group/file, produce diagnostics
- [ ] Host functions (1-to-1 with Rust `dsl/eval.rs`): `has_group`, `group_size`, `has_trailing_whitespace`, `is_valid_ags_type`, `is_numeric_ags_type`, `codelist`, `exists_in`, `lookup`, `is_null`, `not_null`, `regex`, `between`, `is_monotonic`, `point`, `distance_m`, `bbox`, polygon `within`, EPSG conversion, `count`, `unique`, `sum`, `min`, `max`, `mean`/`avg`
- [ ] Custom JEXL transforms: `pluck`, `where`, `unique`, `sum`, `mean`, `min`, `max`
- [ ] Scope semantics: `row` / `file` / `group:<HEADING>`
- [ ] Message-template substitution (`{row.HEADING}` → string)
- [ ] Fix steps (`set` with JEXL value expression, `delete_row`)
- [ ] `scripts/cel-to-jexl.ts` migration script + per-construct unit tests
- [ ] `--legacy-cel` runtime path that runs the migration shim on the fly for `version: 1` packs
- [ ] Migrate shipped packs (`rules/specs/ags/standard/4.x/pack.yml`, `rules/specs/ice/mini/0.1/pack.yml`, `examples/rules/ice_mini.yml`) to `version: 2`
- [ ] Conformance bank from M0: every `(pack, fixture)` reproduces the Rust diagnostics

## M4 — Built-in validate + fix

- [~] Port `validate.rs` (orchestrator)
- [~] Port `validate/rules.rs` (partial built-in registry landed: dict required/depth/non-empty, ABBR/UNIT codelists, LOCA xref, ID/composite key checks, heading format/order, empty-group, non-standard heading warnings)
- [ ] Port `typecheck.rs`
- [ ] Port `fix.rs` (whitespace, encoding/BOM, UNIT/TYPE row ordering, trailing commas)
- [ ] Renderers: text, JSON, JUnit (`render.rs`)
- [ ] Parity tests against M0 baselines for every fixture under `tests/fixtures/ags/`

## M5 — Domain modules

- [ ] `diggs.rs` → `packages/core/src/diggs/` (read + write, supported subset PROJ/LOCA/GEOL/SAMP/ISPT/WSTK)
- [ ] `diff.rs` (group + row level)
- [ ] `dedupe.rs`
- [ ] `merge.rs`
- [ ] `score.rs`
- [ ] `semantic.rs`
- [ ] `describe.rs`
- [ ] `spatial.rs` (turf.js wrappers)
- [ ] `datum.rs`
- [ ] `crossfile.rs`
- [ ] `export.rs`
- [ ] `explorer.rs` + `explorer_data.rs` (SVG strip-log renderer returning string SVG/HTML)
- [ ] DIGGS golden round-trips byte-equal (post canonical-XML normalisation) to M0 baselines

## M6 — CLI (`@geoflow/cli`)

- [ ] `@effect/cli` command tree: `info`, `validate`, `fix`, `convert`, `diff`, `explore`, `rules list|show`, `db ingest|query`, `upgrade` (no-op stub)
- [ ] Exact flag/option parity with `crates/geoflow-cli/src/main.rs` (long+short names, defaults, help text)
- [ ] Exit codes: 0 / 1 / 2
- [ ] Output artifact paths preserved (`*.fixed.ags`, `*.diggs`, `*.html`)
- [ ] `bin/geoflow.mjs` shebang entry
- [ ] Vite SSR build → `dist/bin/geoflow.mjs`
- [ ] `tests/e2e-cli/` snapshot suite via `execa`, asserting equality with M0 baselines

## M7 — Web app (`apps/web`)

- [ ] Vite SPA scaffold, `base: '/geoflow/'`
- [ ] Web Worker hosting `@geoflow/core`
- [ ] Port single-file `web/index.html` UI into `apps/web/src/ui/` (vanilla TS components)
- [ ] Tabs: validator / fixer / converter / explorer / diff / rules / about
- [ ] Drag-drop, file input, URL hash routing
- [ ] Explorer SVG render uses `@geoflow/core` explorer module
- [ ] Port Playwright suite `tests/browser/explorer.spec.js` → `tests/e2e-browser/`
- [ ] `vite preview` target used by Playwright instead of static server
- [ ] Bundle ≤ 600 KB gzip (CI assert)

## M8 — DB / GeoPackage (`@geoflow/db`)

- [ ] Port `db/schema.rs` → TS schema definitions
- [ ] Port `db/ingest.rs` using `better-sqlite3`
- [ ] Port `db/query.rs`
- [ ] Port `db/geometry.rs`
- [ ] Conditional exports so the package is omitted from the browser bundle
- [ ] CLI subcommands `db ingest` / `db query` parity tests against M0 baselines

## M9 — Release plumbing

- [ ] Changesets config + custom CalVer bumper (`YYYY.MMDD.N`)
- [ ] `.github/workflows/release.yml` rewritten for npm publish + cross-platform single-file binaries (`bun build --compile`, fallback `pkg`)
- [ ] `.github/workflows/gh-pages.yml` rewritten to upload `apps/web/dist`
- [ ] `.github/workflows/ci.yml` replaced with the TS pipeline (drop the existing Rust matrix)
- [ ] First TS release tag publishes `@geoflow/{core,cli,rules-engine,db,rules}` to npm
- [ ] Pages site live at the project URL with the new SPA

## M10 — Cut-over & cleanup

- [ ] Delete `crates/`, `target/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`
- [ ] Delete legacy `web/` directory (replaced by `apps/web/`)
- [ ] Remove `geoflow-py`, `geoflow-desktop`, `geoflow-wasm` references everywhere
- [ ] Remove Rust entries from `mise.toml`
- [ ] Rewrite `README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `spec/003_locked_plan.md` for the TS stack
- [ ] `git grep -i 'cargo\|rustc\|wasm-pack'` returns no matches in source
- [ ] Final release workflow flips publish target to npm only; old Rust release workflow removed
- [ ] DoD checklist (§13 of the spec) all green
