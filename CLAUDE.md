# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GeoFlow is a TypeScript monorepo for geotechnical data interchange, focused on AGS 4.x parsing, validation, DIGGS conversion, borehole exploration, and a GitHub Pages web app. It uses pnpm workspaces.

## Commands

```bash
# Install dependencies
pnpm install

# Test all (unit + parity)
pnpm test

# Type-check individual packages
npx tsc -p packages/core/tsconfig.json --noEmit
npx tsc -p packages/cli/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit

# Build web app
pnpm --filter @geoflow/web build

# Run the CLI locally (tsx for on-the-fly TS compilation)
npx tsx packages/cli/src/main.ts <subcommand> [args]
```

## Before Every Commit

Run these commands and fix any issues before committing:

```bash
pnpm test
npx tsc -p packages/cli/tsconfig.json --noEmit
```

## Workspace Layout

```
packages/
  core/          # @geoflow/core   — AGS parser, validator, DIGGS, explorer, etc.
  cli/           # @geoflow/cli    — CLI wrapper, all subcommands
  rules-engine/  # @geoflow/rules-engine — JEXL-based rule pack evaluator
  db/            # @geoflow/db     — SQLite/GeoPackage ingest + query (node-only)
  rules/         # @geoflow/rules  — built-in YAML rule packs (data only)
  transform/     # @geoflow/transform — pipeline DAG model, ref resolution, SQL compilation

apps/
  web/           # @geoflow/web    — GitHub Pages SPA (Vite + React)

rules/specs/     # Rule packs: ags/standard/4.x, ice/mini/0.1
tests/
  fixtures/      # AGS and DIGGS test files
  parity/        # Golden comparison baselines
```

## Architecture

All significant logic lives in `@geoflow/core`. The CLI (`packages/cli/src/main.ts`) parses arguments and delegates to core functions; it contains no business logic.

### @geoflow/core modules

- **AGS parser** (`ags/lexer.ts`, `ags/parser.ts`, `ags/serializer.ts`)
- **Data model** (`model.ts`) — `AgsFile`, `AgsGroup`, `AgsHeading`, `AgsValue`, `AgsType`
- **Built-in validation** (`validate.ts`, `validate.rules.ts`)
- **DIGGS conversion** (`diggs.ts`) — AGS ↔ DIGGS 2.6 XML
- **Auto-fix engine** (`fix.ts`)
- **Explorer** (`explorer.ts`) — self-contained HTML report with SVG borehole strip logs
- **Renderer** (`render.ts`) — text, JSON, JUnit output

### CLI subcommands

| Subcommand | Description |
|---|---|
| `info <file>` | Print AGS file summary |
| `validate <file> [--rules <pack.yml>]` | Run built-in + optional rule-pack checks |
| `fix <file>` | Apply safe auto-fixes; `--write` |
| `convert <in> <out>` | AGS ↔ DIGGS round-trip |
| `explore <file> [--out <path>]` | Generate HTML explorer with SVG strip logs |
| `diff <a> <b>` | Diff two AGS files |
| `rules list\|show <id>` | Inspect built-in and pack rules |
| `db ingest\|query\|list` | SQLite/GeoPackage database operations |

Exit codes: 0 = success, 1 = validation failure, 2 = usage/runtime error.

## Key Design Decisions

- **TypeScript only** — no Rust, no WASM in the runtime path.
- **JEXL for user rules** — `@geoflow/rules-engine` evaluates YAML rule packs.
- **pnpm workspaces** — workspace protocol (`workspace:*`) for internal deps.
- **Effect-TS** — `Option` types used in the core data model.
- **better-sqlite3** — optional dependency in `@geoflow/db`; excluded from browser bundles via conditional exports.

## Transformation engine (web)

`@geoflow/transform` is a pure-TS package that models dbt-style pipelines: nodes
(source, file, seed, sql, output), edges, ref resolution via
`{{ ref('node_name') }}`, topological sort, and compilation into ordered DuckDB
statements.

Node kinds:
- **source** — references an already-registered DuckDB table (e.g. the AGS
  group tables that `registerAgsFile` creates).
- **file** — holds an entire uploaded AGS file. Each group is registered as a
  DuckDB table named `{nodeName}_{group}` (lowercased) and exposed via
  `{{ ref('name_group') }}`. Enables cross-file joins.
- **seed** — inline CSV/JSON content registered as a DuckDB table.
- **sql** — `SELECT` materialised as a VIEW or TABLE; supports
  `{{ ref('...') }}` substitution.
- **notebook** — ordered list of SQL + Markdown cells. Each SQL cell
  materialises as its own relation (referenceable by name); the last
  SQL cell is exposed under the notebook's own name as a passthrough,
  so downstream nodes treat the notebook as a single ref target.
- **output** — terminal node; previews / downloads as CSV/JSON/GeoJSON.

The Transform tab in `apps/web` renders the DAG with React Flow (`@xyflow/react`),
uses Monaco for SQL editing with autocomplete for refs / table columns / spatial
functions, and runs pipelines against the browser DuckDB-wasm instance shared
with the Query tab. Pipelines auto-save to IndexedDB per project and can be
exported/imported as JSON. Built-in examples live in
`apps/web/src/transform/examples.ts` and load via the toolbar's Examples menu.

DuckDB-wasm autoloads `spatial` and `httpfs` extensions on engine startup; load
failures are non-fatal and surfaced in the Transform tab sidebar.

### Cell-level lineage

Every SQL node (and every SQL cell in a notebook) materialises a parallel
`_lin_<name>` view that carries a `__src` provenance column. Lineage is
plumbed via SQL AST rewriting (`packages/transform/src/lineage.ts`, using
`sql-parser-cst`):

- Each base relation (source/seed/file group) gets a `_lin_<rel>` view that
  adds `__rowid` and `__src = ['<rel>|<rowid>']`.
- For SQL nodes, the user query is parsed; every FROM/JOIN table reference is
  rewritten to its `_lin_` view, and a `__src` column is injected into each
  SELECT — `list_concat(...)` across joined tables, `flatten(list(...))`
  across aggregations.
- Unsupported constructs (window functions, parse failures) make the rewriter
  return `null`; that node simply shows "no lineage" in the UI rather than
  emit incorrect provenance.
- The preview query for each node pulls `__src` from its `_lin_` view; clicking
  any cell opens the lineage panel, which fetches the contributing source
  rows from the relevant `_lin_<rel>` views by `__rowid`.

Column lineage (`packages/transform/src/column-lineage.ts`) is computed in
parallel: for each output column, the AST walker collects the contributing
`(relation, column)` pairs, distinguishing direct references, expressions,
aggregations, literals, and star expansions. The executor resolves these
transitively through upstream SQL nodes, so the panel surfaces base-relation
columns regardless of how many intermediate models the data flows through.
The lineage panel highlights the contributing columns inside each source row
and shows a derivation tag (`← direct` / `← expression` / `← aggregated` /
`← star` / `← literal`).
