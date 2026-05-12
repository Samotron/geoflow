# 007 — Migration to 100% TypeScript

> **Status:** Draft plan
> **Goal:** Replace the Rust workspace with a TypeScript monorepo while preserving
> 1-to-1 functionality of the `geoflow` CLI and the GitHub Pages browser app.
> **Stack:** TypeScript (strict) · [Effect 4](https://effect.website) · Vite · Vitest ·
> pnpm workspaces · Node ≥ 20 (CLI) · ES2022 (browser).
> **Dependency freshness policy:** every third-party package version pinned in
> this repo MUST be **≥ 14 days old** at the time it is added or bumped, to give
> the ecosystem (and us) time to detect supply-chain compromises. Enforced by
> `scripts/check-dep-age.ts` in CI (see §8).

---

## 1. Why & Constraints

| Goal | Constraint |
|---|---|
| Single language across library, CLI, web, tests | TypeScript only — no Rust, no WASM in the runtime path |
| Preserve every public surface (CLI flags, exit codes, file outputs) | Golden-file & snapshot parity with current Rust output |
| Stay deployable to GitHub Pages | Pure static build, no server runtime |
| Make effects, errors and resources explicit | Use Effect-TS for the core, CLI, and DSL evaluator |
| Fast iteration & first-class tests | Vite + Vitest (with browser mode for parity tests) |

Out of scope (deferred / dropped):
- `geoflow-py` (Python via PyO3) → replaced by `npm`/`pnpm` distribution; if Python is still required later, expose via [`pythonia`](https://www.npmjs.com/package/pythonia) or rebuild as a thin Python shell that calls the Node CLI.
- `geoflow-desktop` (native Tauri shell) → optional re-introduction as an Electron/Tauri wrapper around the same TS app (Milestone 8).
- `rusqlite` GeoPackage ingest → re-implemented with [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3) (CLI only) and disabled in the browser bundle via conditional exports.

---

## 2. Target Repository Layout

```
geoflow/
├── package.json                 # pnpm workspace root, shared scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json           # strict, ES2022, NodeNext
├── vite.config.ts               # shared Vite/Vitest preset (re-exported by each pkg)
├── vitest.workspace.ts          # multi-project: node + browser + e2e
│
├── packages/
│   ├── core/                    # @geoflow/core   — pure logic, runs in node + browser
│   │   ├── src/
│   │   │   ├── ags/             # lexer, parser, serializer
│   │   │   ├── ags3/            # AGS v3 reader
│   │   │   ├── model/           # AgsFile / AgsGroup / AgsValue / AgsType
│   │   │   ├── dict/            # Built-in AGS data dictionaries
│   │   │   ├── validate/        # Built-in rule engine
│   │   │   ├── dsl/             # Pack loader + evaluator (delegates to rules-engine)
│   │   │   ├── fix/             # Auto-fix engine
│   │   │   ├── diggs/           # AGS ⇄ DIGGS XML
│   │   │   ├── diff/, dedupe/, merge/, semantic/, score/, describe/
│   │   │   ├── spatial/         # turf.js wrappers (replaces `geo`)
│   │   │   ├── datum/, typecheck/, crossfile/, render/, export/
│   │   │   ├── explorer/        # SVG strip-log renderer (returns string SVG/HTML)
│   │   │   ├── diagnostics/     # tagged Effect errors
│   │   │   └── index.ts         # public re-exports
│   │   ├── tests/               # vitest unit tests, fixture parity
│   │   └── package.json
│   │
│   ├── rules-engine/            # @geoflow/rules-engine — JEXL-backed pack
│   │   └── src/                 # loader + evaluator + host functions (see §6)
│   │
│   ├── db/                      # @geoflow/db     — SQLite ingest/query (node-only)
│   │   └── src/                 # uses better-sqlite3, conditional export
│   │
│   ├── cli/                     # @geoflow/cli    — `geoflow` binary
│   │   ├── src/
│   │   │   ├── main.ts          # @effect/cli command tree
│   │   │   └── commands/        # info, validate, fix, convert, diff, explore, rules, db, upgrade
│   │   ├── bin/geoflow.mjs      # shebang entry
│   │   └── package.json         # "bin": { "geoflow": "./bin/geoflow.mjs" }
│   │
│   └── rules/                   # @geoflow/rules  — built-in YAML packs (data only)
│       ├── ags/                 # standard pack
│       └── ice/                 # ICE mini pack
│
├── apps/
│   └── web/                     # GitHub Pages SPA (Vite)
│       ├── index.html
│       ├── src/
│       │   ├── main.ts          # boots app, registers tabs
│       │   ├── ui/              # vanilla TS components (port of current single-file app)
│       │   └── workers/         # Web Worker that hosts @geoflow/core
│       ├── public/
│       └── vite.config.ts       # base = "/geoflow/"
│
├── tests/
│   ├── fixtures/                # unchanged AGS + DIGGS goldens (carried over)
│   ├── parity/                  # Rust-vs-TS golden comparison harness (transitional)
│   ├── e2e-cli/                 # CLI snapshot tests using execa + tmp dirs
│   └── e2e-browser/             # Playwright tests (kept, retargeted at Vite preview)
│
├── scripts/
│   ├── capture-rust-baselines.ts # one-shot: runs old Rust CLI, snapshots stdout/stderr/files
│   └── release.ts                # CalVer bump + npm publish
│
└── spec/                         # docs (this file lives here)
```

`crates/` and `target/` are removed in the final cut-over commit; everything in `tests/fixtures/`, `rules/specs/` and `examples/rules/` is moved into the TS workspace verbatim.

---

## 3. Tech Choices

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.5+ strict | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Runtime composition | **Effect 4.x** | `Effect`, `Layer`, `Schema`, `Stream`, tagged errors. Uses the new flat `effect` package surface (Schema is built-in, no separate `@effect/schema` dep). |
| Validation / DTOs | Built-in `Schema` from `effect` | Replaces `serde` derive — single source for types & decoders |
| CLI | **`@effect/cli` (v4-compatible release)** | Subcommands, help, exit codes, structured errors. If the v4-compatible `@effect/cli` release is < 14 days old at adoption time, fall back to the latest qualifying version and pin per §8 freshness rule. |
| Build / bundler | **Vite 5** | Library mode for `core`, `cli`; SPA for `apps/web` |
| Test runner | **Vitest 1.6+** | `vitest.workspace.ts`, browser mode for parity, coverage via v8 |
| E2E browser | Playwright (kept) | Points at `vite preview` instead of a `python -m http.server` |
| Package manager | pnpm 9 workspaces | Uses workspace protocol (`workspace:*`) |
| XML | `fast-xml-parser` (read), `xmlbuilder2` (write) | Replaces `quick-xml` |
| YAML | `yaml` | Replaces `serde_yaml` |
| CSV | `papaparse` | For non-AGS CSV interop only |
| Encoding | `iconv-lite` | Replaces `encoding_rs` (CP1252, BOM) |
| Spatial | `@turf/turf` + custom helpers | Replaces `geo` |
| Dates | `date-fns` (tree-shakable) | Replaces `chrono` |
| HTTP / upgrade | `undici` (node) | Replaces `ureq`; web app does not self-upgrade |
| Hashing | `node:crypto` / `@noble/hashes` | Replaces `sha2` |
| Logging / tracing | `effect/Logger` + `pino` sink | Replaces `tracing` |
| SQLite | `better-sqlite3` (cli) | Browser bundle excludes the `db` package via conditional exports |
| Templates | none — Effect/TS template literals | Replaces `minijinja`; SVG built directly |

The Rust DSL was CEL-based. After reviewing the actual rule shapes (§6.1),
we **drop CEL entirely** and adopt **JEXL** as the expression layer, behind
`@geoflow/rules-engine`. Rationale and pack-migration plan in §6.

---

## 4. Public-Surface Parity Contract

These are the *only* observable behaviours; the migration succeeds when every entry below matches the current Rust build byte-for-byte (or semantically, where noted).

1. **CLI commands & flags** — `info`, `validate`, `fix`, `convert`, `diff`, `explore`, `rules list|show`, `db ingest|query`, `upgrade` (no-op in TS build, prints message).
   - Same long/short flag names, defaults, and `--help` text.
   - Same exit codes: `0` success, `1` validation failure, `2` usage/runtime error.
   - Same emitted artifact paths (`*.fixed.ags`, `*.diggs`, `*.html`).
2. **Output formats** — `text`, `json`, `junit` renderers; JSON schema is frozen and snapshotted.
3. **Validation rule IDs and severity** — every built-in rule keeps its current ID, message template and severity.
4. **Rule-pack semantics** — for every existing pack (after the mechanical CEL→JEXL migration in §6.5), the diagnostics produced are identical (rule ID, severity, rendered message). Host-function names and signatures (`codelist(...)`, `exists_in(...)`, `spatial.within(...)`, `is_monotonic(...)`, …) are unchanged; only the surrounding expression dialect changes.
5. **DIGGS round-trip** — identical XML element/attribute names and ordering for the supported subset (PROJ, LOCA, GEOL, SAMP, ISPT, WSTK …).
6. **Web app** — visible tab structure, drag-drop behaviour, validator/fixer/converter/explorer panes; URL hash routing preserved.

Parity is enforced by §7 (testing strategy) — no rule ID, JSON shape, or HTML class name changes without an explicit RFC entry in this doc.

---

## 5. Effect-TS Architecture

### 5.1 Core service shape

```ts
// packages/core/src/index.ts
export class AgsParser extends Effect.Tag("@geoflow/AgsParser")<
  AgsParser,
  { readonly parse: (bytes: Uint8Array, opts?: ParseOptions)
      => Effect.Effect<AgsFile, AgsParseError>; }
>() {}

export class Validator extends Effect.Tag("@geoflow/Validator")<
  Validator,
  { readonly run: (file: AgsFile, packs: ReadonlyArray<RulePack>)
      => Effect.Effect<Diagnostic[], never, FileSystem>; }
>() {}

export class DiggsCodec extends Effect.Tag("@geoflow/DiggsCodec")<
  DiggsCodec,
  { readonly toDiggs: (file: AgsFile)
      => Effect.Effect<{ xml: string; report: ConversionReport }, DiggsError>;
    readonly fromDiggs: (xml: string)
      => Effect.Effect<AgsFile, DiggsError>; }
>() {}

// Default Layer wires concrete impls
export const CoreLive = Layer.mergeAll(
  AgsParserLive,
  ValidatorLive,
  DiggsCodecLive,
  FixEngineLive,
  ExplorerLive,
  DslEngineLive,
);
```

### 5.2 Errors

Every failure mode is a tagged `Data.TaggedError` so the CLI renderer can map them
to exit codes and colors:

```ts
export class AgsParseError extends Data.TaggedError("AgsParseError")<{
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}> {}
```

### 5.3 Schemas

`AgsValue`, `AgsHeading`, `AgsType`, `Diagnostic`, `RulePack`, etc. are defined
once with `effect/Schema` — used for runtime decoding (YAML packs, JSON I/O)
*and* compile-time types (no duplicate `interface`).

### 5.4 Effect-CLI

```ts
const validate = Command.make("validate", {
  files:    Args.fileText({ name: "files" }).pipe(Args.repeated, Args.atLeast(1)),
  format:   Options.choice("format", ["text", "json", "junit"]).pipe(Options.withDefault("text")),
  failOn:   Options.choice("fail-on", ["error", "warning", "info"]).pipe(Options.withDefault("error")),
  rules:    Options.fileText("rules").pipe(Options.optional),
}, ({ files, format, failOn, rules }) =>
  Effect.gen(function*() { /* … */ })
);

const cli = Command.run(Command.make("geoflow").pipe(Command.withSubcommands([
  info, validate, fix, convert, diff, explore, rules, db, upgrade,
])), { name: "geoflow", version: PACKAGE_VERSION });

cli(process.argv).pipe(Effect.provide(CoreLive), NodeRuntime.runMain);
```

### 5.5 Browser composition

`apps/web` builds a worker that constructs the same `CoreLive` layer minus
node-only services (`@geoflow/db`, `node:fs`). Schema/codec packages have
`exports` maps with `"browser"`, `"node"`, and `"worker"` conditions so the
bundler swaps implementations automatically.

---

## 6. Rule DSL — drop CEL, adopt JEXL (`@geoflow/rules-engine`)

### 6.1 What the current DSL actually does

A review of [`crates/geoflow-core/src/dsl/eval.rs`](../crates/geoflow-core/src/dsl/eval.rs)
and the published packs (`rules/specs/`, `examples/rules/ice_mini.yml`) shows
the DSL surface is much smaller than "CEL":

- **Pack shape:** YAML with `version`, `name`, `pack_version`, `codelists`,
  and a list of `rules` (`id`, `severity`, `when`, `expr`, `message`, `scope`,
  optional `fix` steps).
- **Bindings:** `row`, `group`, `rows`, `key`, `file`, `groups_meta`.
- **Built-in operators used:** `==`, `!=`, `&&`, `||`, `!`, `in`, `>`, `<`,
  property access, list/map literals, `null` checks, and CEL macros
  `map`/`filter`/`exists`/`all` (used in only a handful of rules).
- **Host functions doing the real work** (~25): `has_group`, `group_size`,
  `has_trailing_whitespace`, `is_valid_ags_type`, `is_numeric_ags_type`,
  `codelist`, `exists_in`, `lookup`, `is_null`, `not_null`, `regex`,
  `between`, `is_monotonic`, `point`, `distance_m`, `bbox`, polygon
  containment, EPSG conversion, `count`, `unique`, `sum`, `min`, `max`,
  `mean`/`avg`.

So 95 % of every rule body is `host_function(row.HEADING, …)`. The CEL grammar
is overhead — there is no template specialisation, no cross-message inference,
no protobuf interop, none of the use cases CEL was built for.

### 6.2 Options considered

| Option | What it is | Verdict |
|---|---|---|
| **A. Adopt an existing CEL library** (`@bufbuild/cel`, `cel-js`) | Closest 1-to-1 mapping; no language change in user packs | Heavy dependency, ongoing parity risk vs. the Rust `cel-interpreter`, and most packs barely use the grammar |
| **B. JSONata** | JSON-native query/transform language; many built-ins (`$count`, `$min`, `$avg`, `$exists`, regex) replace half our host fns | Very capable; but unusual syntax for users coming from CEL/JS, and asynchronous evaluation model is heavier than we need |
| **C. JEXL** ([`jexl`](https://www.npmjs.com/package/jexl), MIT, ESM, mature — used in Mozilla and Twilio Studio Flows) | JavaScript Expression Language: safe, expression-only, custom functions and `\|` transforms, identifier syntax matches our existing `row.LOCA_ID` style, ~30 KB | **Recommended.** Minimal grammar, ergonomic for JSON shapes, trivially adds host functions, no parser maintenance |
| **D. Plain TypeScript rule modules** | Each rule is an exported function `(ctx) => Diagnostic[]` plus a YAML manifest for metadata | Best DX for *our* packs (typed, autocompleted), but pushes pack authors to a build step and abandons the data-only YAML promise |

### 6.3 Recommendation

Adopt **JEXL** as the expression layer, packaged as `@geoflow/rules-engine`.

Why it is strictly better than CEL for this project:

1. **No language re-implementation.** `jexl` is a single, maintained npm
   package with a stable API; we just `addFunction` / `addTransform` for our
   25 helpers. No grammar parsing or conformance suite for us to own.
2. **Same expression style as the current packs.** `row.LOCA_NATE != null
   && row.LOCA_NATN != null` is valid JEXL verbatim. The rare CEL macros
   (`r in rows`, `rows.map(r, r.GEOL_TOP)`) translate to JEXL transforms
   (`rows|map('GEOL_TOP')`) — handled by the migration shim in §6.5.
3. **Safer than embedding JS.** JEXL is expression-only, no statements, no
   loops, no I/O — same safety posture as CEL.
4. **Fewer host functions needed.** JEXL ships `length`, `filter`, `map`,
   built-in comparison + `in`, so we drop `count`, the trivial filtering
   helpers, and several null checks.
5. **Browser-first.** Pure ESM, no WASM, no native deps; plays cleanly with
   our Vite worker bundle.

### 6.4 `@geoflow/rules-engine` responsibilities

A small package (~400 LoC) that:

- Wraps `jexl` behind an Effect-friendly API
  (`compileRule(rule) -> CompiledRule` returning `Effect<Diagnostic[], EvalError, …>`).
- Decodes the YAML pack with `effect/Schema` (replaces `serde_yaml` types).
- Registers the host-function set 1-to-1 with the current Rust DSL, exposed
  as both **functions** (`exists_in('LOCA','LOCA_ID', row.LOCA_ID)`) and,
  where ergonomic, **transforms** (`row.LOCA_ID|exists_in('LOCA','LOCA_ID')`).
- Implements the `scope` semantics (`row` / `file` / `group:<HEADING>`) and
  message-template substitution (`{row.HEADING}`) — these never touched CEL
  in the Rust code anyway.
- Implements YAML/CSV codelist loading via Effect `FileSystem`.
- Implements `fix` steps (`set` / `delete_row`) using the same JEXL evaluator
  for the `value` field.

### 6.5 Migration of the existing YAML packs

The rule packs under `rules/specs/` and `examples/rules/` are migrated
mechanically by `scripts/cel-to-jexl.ts`:

| CEL idiom | JEXL replacement |
|---|---|
| `row.LOCA_ID != null` | unchanged |
| `x in codelist('foo')` | `x in codelist('foo')` (unchanged) |
| `rows.map(r, r.GEOL_TOP)` | `rows\|map('GEOL_TOP')` (custom transform) |
| `rows.filter(r, r.X > 0)` | `rows\|filter('X > 0')` |
| `rows.exists(r, r.X > 0)` | `(rows\|filter('X > 0')\|length) > 0` |
| `rows.all(r, r.X > 0)` | `(rows\|filter('X <= 0')\|length) == 0` |
| `is_monotonic(rows.map(r, r.GEOL_TOP))` | `is_monotonic(rows\|pluck('GEOL_TOP'))` |

A `pack.version` bump (`1` → `2`) signals the new dialect; the engine
refuses `version: 1` packs unless `--legacy-cel` is passed, which routes them
through a tiny CEL-to-JEXL transpiler (~200 LoC, covers only the operators
listed above — no full CEL support). The shipped packs are migrated in the
same PR as the engine swap; the legacy path exists only to soften the change
for external authors during one minor release.

### 6.6 Conformance bank

`tests/parity/rules/` holds a YAML-driven bank generated in Milestone 0 by
running every existing pack against the Rust binary and recording
`(pack, fixture) -> diagnostics[]`. The JEXL implementation must reproduce
the same diagnostic IDs, severities, and rendered messages for every entry.
This is the gating test for Milestone 3.

---

## 7. Testing Strategy (1-to-1 Parity)

Three layers, all run in CI.

### 7.1 Unit (Vitest, node)

- Co-located with each source file (`foo.ts` ↔ `foo.test.ts`).
- Cover lexer, parser, serializer, fix engine, DSL evaluator, DIGGS codec,
  diff/dedupe/merge/score/spatial helpers individually.
- Effect tests use `@effect/vitest` (`it.effect(...)`).

### 7.2 Golden / Parity (Vitest, node)

- All files in `tests/fixtures/ags/` and `tests/fixtures/diggs/` are reused
  unchanged.
- A `scripts/capture-rust-baselines.ts` harness, run **once** against the
  current Rust binary, produces `tests/parity/baselines/{cmd}/{fixture}.{stdout,stderr,exit,artifacts}`.
- Vitest `describe.each(fixtures)` re-runs the same commands through the TS
  CLI and asserts byte-equality (with whitelisted cosmetic diffs declared in
  `tests/parity/whitelist.ts`).
- Existing `crates/geoflow-core/tests/{round_trip,validation_parity,diggs_fixtures,rule_packs,explorer}.rs` are ported case-for-case into
  `packages/core/tests/`.

### 7.3 E2E

- **CLI:** `tests/e2e-cli/` uses `execa` to drive the built `dist/bin/geoflow.mjs`
  inside `tmp` dirs; snapshots stdout & emitted files.
- **Browser:** existing Playwright suite in `tests/browser/explorer.spec.js` is
  ported to `tests/e2e-browser/` and pointed at `vite preview` of `apps/web`.
  Vitest's browser mode (`@vitest/browser` + Playwright provider) is used for
  fast component-level tests against the same DOM.

### 7.4 Coverage gate

- Coverage via `@vitest/coverage-v8`; CI fails below the current Rust-test
  per-file averages (captured in baseline step). No file may regress.

### 7.5 Property tests

- `fast-check` integrations for the lexer, serializer round-trip, diff
  symmetry, and spatial predicates — replaces existing `proptest` usage.

---

## 8. Build, Lint, Format, Release

| Task | Tool | Command |
|---|---|---|
| Build all packages | Vite (lib mode) + tsup-style bundling via Vite | `pnpm -r build` |
| Type check | `tsc --noEmit` per package | `pnpm -r typecheck` |
| Lint | `eslint` (typescript-eslint, effect plugin) | `pnpm lint` |
| Format | `prettier` | `pnpm format` |
| Test | Vitest | `pnpm test` (delegates to `vitest --workspace`) |
| Bundle CLI | Vite SSR build → `dist/bin/geoflow.mjs` (esm shebang) | `pnpm --filter @geoflow/cli build` |
| Build web | `vite build` | `pnpm --filter @geoflow/web build` |
| Pages deploy | New `gh-pages.yml` uploads `apps/web/dist` | see §9 |
| CLI release | Changesets → npm + GitHub release with single-file binaries via `pkg`/`bun build --compile` for `linux-x64`, `macos-arm64`, `win-x64` | `pnpm release` |
| Versioning | CalVer kept (`YYYY.MMDD.N`) via custom changeset bumper | preserved |
| Dep freshness | `scripts/check-dep-age.ts` | Walks every `package.json`, queries the npm registry for the publish time of each pinned version (and resolved transitive deps in `pnpm-lock.yaml`), and fails if **any version was published less than 14 days ago**. Run in CI on every PR; can be locally bypassed only with `GEOFLOW_ALLOW_FRESH_DEPS=1` for dev experiments. The check additionally surfaces packages newer than 14 days that are present transitively but not direct deps as a warning, prompting a manual override file (`.dep-age-allowlist.json`) with justification. |
| Supply-chain extras | `pnpm audit --prod`, `npm-audit-resolver`, lockfile review on every bump | Run alongside the freshness check; both must pass for CI to go green. |

`mise.toml` is updated to pin `node@20`, `pnpm@9` (Rust toolchain entries removed).

---

## 9. CI / GitHub Pages

Two workflows are rewritten:

### `.github/workflows/ci.yml` (replace)
```yaml
matrix: { os: [ubuntu, macos, windows], node: [20] }
steps:
  - uses: actions/checkout@v4
  - uses: pnpm/action-setup@v4
  - uses: actions/setup-node@v4 with: { node-version: 20, cache: pnpm }
  - run: pnpm install --frozen-lockfile
  - run: pnpm dep:age              # fails if any pinned dep < 14 days old
  - run: pnpm audit --prod
  - run: pnpm -r typecheck
  - run: pnpm lint
  - run: pnpm test --coverage
  - run: pnpm -r build
```

### `.github/workflows/gh-pages.yml` (replace)
```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm --filter @geoflow/web build
- uses: actions/upload-pages-artifact@v3
  with: { path: apps/web/dist }
- uses: actions/deploy-pages@v4
```

Vite `base: '/geoflow/'` ensures asset paths resolve under the project Pages
URL.

### `.github/workflows/release.yml`
- Builds standalone CLI binaries (single-file via `bun build --compile`
  cross-target, fallback `pkg`) and publishes them as release assets so
  non-Node users keep a one-binary install.
- Publishes `@geoflow/cli`, `@geoflow/core`, `@geoflow/rules-engine`, `@geoflow/db`,
  `@geoflow/rules` to npm.

---

## 10. Milestones

Each milestone is a PR-sized chunk; "Done" means parity tests for that scope
are green. Total estimate: **~10 weeks** for one engineer, fewer if work
fans out across §11.

| # | Milestone | Output | Done when… |
|---|---|---|---|
| 0 | **Baseline capture** | Rust CLI snapshots, fixture inventory, public-surface checklist (§4) materialised as JSON in `tests/parity/baselines/` | All current `cargo test` cases produce baseline files; CI step `parity:capture` is reproducible |
| 1 | **Workspace skeleton** | pnpm + Vite + Vitest + Effect, empty packages, CI green on `tsc --noEmit` | `pnpm test` runs, `pnpm -r build` produces empty bundles |
| 2 | **Model + AGS lexer/parser/serializer** | `@geoflow/core` ports `model.rs`, `ags/{lexer,parser,serializer}.rs`, `ags3.rs`, `dict.rs` | Round-trip tests for every fixture pass; property tests green |
| 3 | **Rules engine (JEXL)** | `@geoflow/rules-engine` evaluates every existing pack via JEXL + host fns (see §6); legacy CEL packs migrated by `scripts/cel-to-jexl.ts` | YAML pack conformance bank passes; benchmarks within 3× Rust |
| 4 | **Built-in validate + fix** | `validate.rs`, `validate/rules.rs`, `fix.rs`, `typecheck.rs`, `diagnostics.rs` ported | All `validation_parity` cases match; `fix` produces byte-identical output for `fixable.ags` etc. |
| 5 | **DIGGS codec + diff/dedupe/merge/score/semantic/describe/spatial/datum/crossfile/export** | Remaining domain modules ported | DIGGS golden round-trips match; diff JSON matches |
| 6 | **CLI** | `@effect/cli` command tree, renderers, exit codes, file outputs | `tests/e2e-cli` snapshot suite green against §0 baselines |
| 7 | **Web app** | `apps/web` SPA (vanilla TS) running on Vite, worker hosting `core`, all current tabs, drag-drop, explorer SVG | Playwright suite (`tests/browser/explorer.spec.js` ported) green; Lighthouse ≥ current build |
| 8 | **DB / GeoPackage** | `@geoflow/db` with `better-sqlite3` (CLI-only) | `db ingest`/`db query` parity tests green |
| 9 | **Release plumbing** | npm publish, single-file binaries, Pages deploy, mise pin updated | First TS release tag `2026.MMDD.0` published; Pages site live; old Rust CI workflows removed |
| 10 | **Cut-over & cleanup** | Delete `crates/`, `target/`, `Cargo.toml`, `rust-toolchain.toml`, `geoflow-py`, `geoflow-desktop`, `geoflow-wasm`; update README, AGENTS.md, CLAUDE.md, CONTRIBUTING.md, spec docs | `git grep -i 'cargo\|rustc\|wasm-pack'` returns nothing in source; release workflow flips publish target to npm only |

Each milestone gates on:
1. Parity tests for that scope green.
2. Coverage ≥ baseline for ported files.
3. PR includes a checklist row matching §4.

---

## 11. Parallelisation (sub-agent fan-out)

Once Milestone 1 lands, three workstreams can proceed concurrently:

- **A. Core domain port** — milestones 2 → 5
- **B. Rules engine + pack migration** — milestone 3 (JEXL host functions, `cel-to-jexl` shim, conformance bank), then merges into A
- **C. Web app + Vite tooling** — milestone 7 (uses stub `@geoflow/core`
  exports until A lands)

The CLI (M6) and DB (M8) are sequential after A.

---

## 12. Risk Register

| Risk | Mitigation |
|---|---|
| CEL→JEXL pack-migration gap (uncovered macro, transform mismatch) | Build the conformance bank in M0; treat any missing op as a blocker before M4. `--legacy-cel` shim covers one transitional release |
| AGS lexer encoding edge cases (CP1252 + BOM + CRLF) | `iconv-lite` chosen for parity; property-test against Rust `encoding_rs` outputs captured in M0 |
| DIGGS XML attribute ordering | `xmlbuilder2` configured with stable attribute insertion order; baselines normalise via canonical XML before compare |
| Performance regression vs. Rust | Benchmark suite (`tinybench`) added in M2; allowed budget is 5× slower for parse, 3× for validate; revisit hotspots with Vite ESM build + worker pools |
| Browser bundle size grows beyond current WASM blob | Tree-shake check in CI: `apps/web/dist` gzip ≤ 600 KB target (current WASM ≈ 1.2 MB, so headroom exists); use code-splitting per tab |
| `better-sqlite3` native module on Pages | Excluded by conditional exports + Vite `optimizeDeps.exclude`; web build asserts no `node:` import via `vite-plugin-no-node-imports` |
| Loss of Python users | Document `npx @geoflow/cli` invocation; provide a thin Python wheel that subprocesses the Node CLI in a follow-up |
| Rule-pack authors rely on undocumented Rust behaviour | Freeze §4 contract; the `cel-to-jexl` migration script emits a warning + manual-review marker for any CEL construct outside the supported subset |

---

## 13. Definition of Done

- `pnpm install && pnpm test && pnpm -r build` succeed on Linux, macOS, Windows.
- `npx @geoflow/cli validate tests/fixtures/ags/ice_mini_invalid.ags --format json` produces output equal (mod whitelist) to the current Rust CLI.
- GitHub Pages deploy of `apps/web` validates, fixes, converts, and explores
  every fixture in-browser without network calls.
- `crates/`, `Cargo.toml`, `rust-toolchain.toml`, and all Rust workflows
  are removed.
- README, AGENTS.md, CLAUDE.md, CONTRIBUTING.md, and `spec/003_locked_plan.md`
  are rewritten to reflect the TS stack.
- A tagged CalVer release publishes `@geoflow/{core,cli,rules-engine,db,rules}` to
  npm and uploads cross-platform single-file binaries.
- `pnpm dep:age` and `pnpm audit --prod` are green; no pinned dependency
  (direct or transitive in `pnpm-lock.yaml`) was published less than 14 days
  before the release tag.
