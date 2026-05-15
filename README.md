# GeoFlow

[![CI](https://github.com/samotron/geoflow/actions/workflows/ci.yml/badge.svg)](https://github.com/samotron/geoflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

GeoFlow is a TypeScript monorepo for geotechnical data interchange, focusing on AGS 4.x parsing, validation, DIGGS conversion, and borehole exploration.

- **AGS 4.x parser** — lexes and parses AGS files, handles BOM and custom encodings.
- **Validation engine** — built-in AGS 4.x rules plus a JEXL-based DSL for custom rule packs.
- **Auto-fixer** — automatically repairs safe structural and formatting issues in AGS files.
- **DIGGS support** — round-trip conversion between AGS and DIGGS 2.6 XML.
- **Diff** — compare two AGS files and report group/row-level differences.
- **Explorer** — self-contained HTML report with SVG borehole strip logs.
- **Web app** — browser-based validator and explorer; no server required.

Status: **Early Development**.

## Workspace Layout

```
packages/
  core/          # @geoflow/core        — AGS parser, validator, DIGGS, explorer, etc.
  cli/           # @geoflow/cli         — CLI wrapper around core
  rules-engine/  # @geoflow/rules-engine — JEXL-based rule pack evaluator
  db/            # @geoflow/db          — SQLite/GeoPackage ingest and query (Node only)
  rules/         # @geoflow/rules       — built-in YAML rule packs (data only)

apps/
  web/           # @geoflow/web         — GitHub Pages SPA (Vite + React)

rules/specs/     # Rule packs: ags/standard/4.x, ice/mini/0.1
tests/
  fixtures/      # AGS and DIGGS test files
  parity/        # Golden comparison baselines
```

## Requirements

- Node.js >= 20
- pnpm >= 10

## Installation

```bash
pnpm install
```

## CLI Quick Start

Run the CLI directly with `tsx` (no build step required):

```bash
npx tsx packages/cli/src/main.ts <subcommand> [args]
```

| Subcommand | Description |
|---|---|
| `info <file>` | Print AGS file summary |
| `validate <file> [--rules <pack.yml>]` | Run built-in + optional rule-pack checks |
| `fix <file> [--write]` | Apply safe auto-fixes |
| `convert <in> <out>` | AGS ↔ DIGGS round-trip |
| `explore <file> [--out <path>]` | Generate HTML explorer with SVG strip logs |
| `diff <a> <b>` | Diff two AGS files |
| `rules list\|show <id>` | Inspect built-in and pack rules |
| `db ingest\|query\|list` | SQLite/GeoPackage database operations |

Exit codes: `0` = success, `1` = validation failure, `2` = usage/runtime error.

### Examples

```bash
# Validate an AGS file
npx tsx packages/cli/src/main.ts validate data.ags

# Apply auto-fixes in place
npx tsx packages/cli/src/main.ts fix data.ags --write

# Convert AGS to DIGGS
npx tsx packages/cli/src/main.ts convert data.ags output.xml

# Compare two AGS files
npx tsx packages/cli/src/main.ts diff before.ags after.ags

# Generate an HTML borehole explorer
npx tsx packages/cli/src/main.ts explore data.ags --out report.html
```

## Build & Test

```bash
# Run all tests (unit + parity)
pnpm test

# Type-check all packages
pnpm typecheck

# Type-check a specific package
npx tsc -p packages/core/tsconfig.json --noEmit

# Build the web app
pnpm --filter @geoflow/web build
```

## Custom Rule Packs

Validation can be extended with YAML rule packs evaluated by `@geoflow/rules-engine` (JEXL expressions):

```bash
npx tsx packages/cli/src/main.ts validate data.ags --rules my-rules.yml
```

See `rules/specs/` for the built-in AGS standard and ICE mini packs as reference.

## License

MIT — see [LICENSE](LICENSE).
