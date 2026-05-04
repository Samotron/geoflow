# GeoFlow

[![CI](https://github.com/samotron/geoflow/actions/workflows/ci.yml/badge.svg)](https://github.com/samotron/geoflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

GeoFlow is a pure-Rust toolkit for geotechnical data interchange, focusing on AGS 4.x and DIGGS.

- **High-performance AGS 4.x parser** (lexes directly from bytes, handles BOM, custom encodings).
- **Validation Engine**: Built-in AGS 4.x rules plus a CEL-based DSL for custom specifications.
- **Auto-fixer**: Automatically repair safe structural and formatting issues in AGS files.
- **DIGGS Support**: Round-trip conversion between AGS and DIGGS XML.
- **Diff**: Compare two AGS files and report group/row-level differences.
- **Web App**: Browser-based validator and converter compiled to WebAssembly — no server required.
- **Multi-platform**: Rust library, thin CLI, Python bindings, and WASM for the browser.

Status: **v0.1 (Early Development)**. See [spec/003_locked_plan.md](spec/003_locked_plan.md) for the development roadmap.

## Workspace Layout

```
crates/
  geoflow-core/   # Core library: parsing, validation, conversion, rendering
  geoflow-cli/    # `geoflow` CLI binary
  geoflow-py/     # Python bindings via PyO3
  geoflow-wasm/   # WebAssembly bindings (wasm-pack)
web/              # Static GitHub Pages app (index.html + compiled WASM)
rules/specs/      # Built-in rule packs (AGS standard, ICE mini)
tests/fixtures/   # AGS + DIGGS fixtures for golden tests
examples/rules/   # Sample rule packs for documentation
```

## Installation

### CLI (via Cargo)
```bash
cargo install --path crates/geoflow-cli
```

### Python (via pip)
*Note: v0.1 wheels pending. For development:*
```bash
pip install maturin
maturin develop -m crates/geoflow-py/Cargo.toml
```

## Quick Start

### CLI
```bash
# Validate an AGS file
geoflow validate data.ags

# Apply auto-fixes
geoflow fix data.ags --write

# Convert AGS to DIGGS
geoflow convert data.ags output.xml --to diggs

# Compare two AGS files
geoflow diff before.ags after.ags

# Explore interactively
geoflow explore data.ags --serve
```

### Python
```python
import geoflow

# Load and validate
ags = geoflow.read_ags("boreholes.ags")
print(f"AGS Version: {ags.ags_version}")

errors = ags.validate()
for err in errors:
    print(f"[{err['severity']}] {err['rule_id']}: {err['message']}")

# Convert to DIGGS
xml, report = ags.to_diggs()
with open("output.xml", "w") as f:
    f.write(xml)
```

## Build & Test

```bash
# Build all crates
cargo build --workspace

# Run Rust tests
cargo test --workspace

# Run Python tests (requires maturin develop)
pytest crates/geoflow-py/tests
```

## License

MIT — see [LICENSE](LICENSE).
