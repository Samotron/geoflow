# AGS test fixtures

Each `.ags` file here is paired with a one-paragraph note describing what
it exercises. Files marked **synthetic** are hand-written for tests; we
also intend to add real, publicly-available AGS files (e.g. from BGS,
AGS Ltd.) once we've cleared the licensing.

| File | Status | Intent |
|---|---|---|
| `minimal_valid.ags` | synthetic | Smallest file that exercises `PROJ`, `TRAN`, `LOCA`, `GEOL`. AGS version 4.1. Used for golden parser/serializer round-trip tests. |
| `ice_mini_valid.ags` | synthetic | Positive fixture for `examples/rules/ice_mini.yml`; should produce no pack diagnostics. |
| `ice_mini_invalid.ags` | synthetic | Negative fixture for `examples/rules/ice_mini.yml`; expected pack diagnostics are recorded in `ice_mini_invalid.diagnostics.json`. |

## Adding a fixture

1. Drop the file in this directory.
2. Add a row above describing its intent.
3. If it has expected diagnostics, add a sibling
   `<name>.diagnostics.json` file.
