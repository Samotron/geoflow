# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **CEL-based DSL Validation Engine**: Custom rule packs in YAML using Google's Common Expression Language.
- **AGS Standard Rule Pack**: Built-in AGS 4.x validation rules migrated from Rust to DSL.
- **Auto-fix Engine**: Safe repairs for structural and formatting issues (trailing whitespace, BOM, line endings).
- **Interactive Explorer**: `geoflow explore` command to host a web-based borehole viewer with SVG strip logs.
- **DIGGS Conversion**: Wave A and B mappings between AGS and DIGGS XML.
- **Python Bindings**: `geoflow` Python package via PyO3 for reading, validating, fixing, and converting AGS/DIGGS.
- **CLI Improvements**: `validate`, `fix`, `convert`, `explore`, and `rules` subcommands.
- Cargo workspace skeleton (`geoflow-core`, `geoflow-cli`, `geoflow-py`).
- AGS 4.x lexer (quoted fields, embedded commas/quotes, CRLF/BOM tolerance).
- AGS 4.x parser building a typed `AgsFile` model with parser-level diagnostics.
- AGS 4.x serializer with round-trip tests.
- Initial `geoflow info` CLI command.
