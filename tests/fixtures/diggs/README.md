# DIGGS test fixtures

This directory holds DIGGS XML fixtures used by parser, writer, and
round-trip conversion tests.

Public reference samples and XSD-backed fixtures are still to be added as
the DIGGS implementation expands. Until then, keep fixture names stable so
future golden tests can target them predictably.

| File | Status | Intent |
|---|---|---|
| `minimal_subset.diggs` | synthetic | Minimal DIGGS subset fixture covering the currently reversible `PROJ`, `LOCA`, `GEOL`, `SAMP`, `ISPT`, and `WSTK` mappings. |
