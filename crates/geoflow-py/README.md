# geoflow (Python Bindings)

Python bindings for the GeoFlow geotechnical data toolkit, powered by [PyO3](https://pyo3.rs).

## Installation

Until v0.1 is published to PyPI, install from source using [maturin](https://github.com/PyO3/maturin):

```bash
pip install maturin
maturin develop
```

## Usage

### Reading and Inspecting AGS 4 Files

```python
import geoflow

# Parse from a file path
ags = geoflow.read_ags("boreholes.ags")

# Basic metadata
print(f"Version: {ags.ags_version}")
print(f"Groups:  {ags.group_names()}")

# Get row data for a specific group
rows = ags.group_rows("LOCA")
for row in rows:
    print(f"Location ID: {row['LOCA_ID']} at ({row['LOCA_NATE']}, {row['LOCA_NATN']})")
```

### Validation

Validate against the built-in AGS 4.x standard rules and optional rule packs.

```python
# Standard validation
errors = ags.validate()

# Custom rule pack validation
errors = ags.validate(rules=["ice:mini@0.1"])

for err in errors:
    print(f"[{err['severity']}] {err['rule_id']} in {err['group']}: {err['message']}")
```

### Auto-fixing

Apply safe, non-lossy fixes (e.g., trimming trailing whitespace, normalizing line endings).

```python
applied_fixes = ags.fix()
print(f"Applied fixes: {applied_fixes}")

# Save the repaired file
with open("repaired.ags", "w") as f:
    f.write(ags.to_ags())
```

### DIGGS Conversion

```python
# Convert to DIGGS XML
xml, report_json = ags.to_diggs()

# The report_json contains information about generic groups
# and unmapped fields.
```

## API Reference

### Functions

- `read_ags(path: str) -> AgsFile`: Read an AGS file from disk.
- `parse_ags(text: str) -> AgsFile`: Parse AGS content from a string.
- `read_diggs(path: str) -> AgsFile`: Read a DIGGS XML file and map to the AGS model.
- `installed_pack_refs() -> List[str]`: List built-in rule packs available for validation.

### `AgsFile` Object

- `ags_version`: (Getter) The detected AGS version string.
- `group_names() -> List[str]`: List of groups in the file.
- `row_count(group: str) -> Optional[int]`: Number of data rows in a group.
- `group_rows(group: str) -> List[Dict]`: All rows for a group as dictionaries.
- `validate(rules: Optional[List[str]] = None) -> List[Dict]`: Run validation.
- `fix(rules: Optional[List[str]] = None) -> List[str]`: Apply safe auto-fixes in-place.
- `to_ags() -> str`: Serialize to AGS 4 text.
- `to_diggs() -> Tuple[str, str]`: Serialize to DIGGS XML and return a JSON report.
