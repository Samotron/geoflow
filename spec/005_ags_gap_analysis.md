# GeoFlow — AGS Gap Analysis

Compares GeoFlow against major community AGS 4.x implementations to identify
validation rule gaps and drive test parity.

## Libraries Compared

| Library | Language | Maintainer | Notes |
|---------|----------|------------|-------|
| **python-ags4** | Python | AGS Data Format WG (GitLab) | Canonical community library; v1.0.0 Sep 2024; used by BGS, groundup, others |
| **pyagsapi (BGS checker)** | Python/FastAPI | British Geological Survey | Wraps python-ags4; adds 10 BGS/NGDC-specific submission rules |
| **ags-validator (groundup-dev)** | TypeScript/npm | groundup-dev | Browser-native three-stage pipeline; own rule numbering; covers AGS 4.0.3–4.1.1 |
| **ags-toolkit / ogt-ags-py** | Python | open-geotechnical | Conversion-focused (JSON/YAML/XLSX); validation listed "WIP" — not a meaningful target |

python-ags4 is the primary comparison baseline (most complete, most tested).

---

## python-ags4 Rule Coverage Matrix

python-ags4 (≥ 1.0.0) and groundup ags-validator implement a common numbered
rule set drawn from the AGS4 Data Format specification.

| Rule | Description | GeoFlow status | GeoFlow rule id |
|---|---|---|---|
| **1** | ASCII-only / encoding (UTF-8 or cp1252); BOM detection | ✓ Parser | parse_bytes / decode_bytes |
| **2a** | CRLF line endings | ✓ Fix | `normalize-line-endings` |
| **2b** | UNIT row at index 0, TYPE row at index 1 after HEADING | ✓ Parser + Fix | AGS-UNIT-NOHEAD, AGS-TYPE-NOHEAD, `reorder-unit-type` |
| **3** | Valid data descriptor on every line | ✓ Parser | AGS-ROW-KIND |
| **4.1** | GROUP row: exactly one field (the group name) | ✓ Parser | AGS-GROUP-EMPTY |
| **4.2** | UNIT/TYPE/DATA field count matches HEADING | ⚠ Partial | AGS-DATA-EXTRA (too many); AGS-DATA-SHORT (too few) added in this analysis |
| **5** | All fields double-quoted | ✓ Lexer | AGS-LEX (UnquotedField) |
| **7.1** | No duplicate heading names in a group | ✓ Parser | AGS-HEADING-DUP |
| **7.2** | Heading order must match dictionary reference order | ✗ Missing | — |
| **8** | Data values match declared TYPE | ✓ Rust | AGS-TYPE-002 |
| **9** | GROUP/HEADING names defined in standard dict or DICT group | ⚠ Partial | AGS-DICT-001 (required headings); non-standard heading check missing |
| **10a** | KEY field combinations unique within group | ⚠ Partial | AGS-KEY-001 (LOCA_ID in LOCA); generic composite key check missing |
| **10b** | REQUIRED fields must be present and non-empty | ✓ Rust | AGS-DICT-001 (presence); value emptiness check missing |
| **10c** | Child group rows must have matching parent (DICT_PGRP) | ⚠ Partial | AGS-XREF-001/002/003/004/005 (hardcoded); generic DICT_PGRP check missing |
| **11** | TRAN_DLIM/TRAN_RCON present if RL or concat-PA fields exist | ✗ Missing | — |
| **11c** | RL-type references must resolve unambiguously | ✗ Missing | — |
| **13** | PROJ group required, exactly one row | ✓ DSL | AGS-STRUCT-001 |
| **14** | TRAN group required, exactly one row | ✓ DSL | AGS-STRUCT-002 |
| **15** | PU-type field DATA values must be in UNIT group | ✓ Rust | AGS-UNIT-001 (added in this analysis) |
| **16** | PA-type field values must be in ABBR group (handles TRAN_RCON concat) | ✓ Rust | AGS-ABBR-001 (added; concat split not yet implemented) |
| **17** | TYPE group must contain entries for every data type used | ✗ Missing | — |
| **18** | If non-standard headings exist, DICT group must be present | ✗ Missing | — |
| **19** | GROUP name ≤ 4 uppercase letters | ✗ Missing | — |
| **19a** | HEADING name ≤ 9 chars, uppercase alphanumeric + underscore | ✗ Missing | — |
| **19b** | HEADING name follows `GROUP_XXXX` prefix convention | ✗ Missing | — |
| **20** | FILE group — referenced file paths exist on disk | ✗ Missing | out of scope (filesystem-dependent) |
| TRAN_AGS ver | TRAN_AGS value must be a known AGS 4.x version | ✓ DSL | AGS-STRUCT-004 (added in this analysis) |

### python-ags4 Rule 8 Type Validation Details

| Type | python-ags4 checks | GeoFlow (AGS-TYPE-002) |
|---|---|---|
| `nDP` | Exact decimal places via regex `^-?\d+\.\d{n}$` | ✓ via coerce (Raw on fail) |
| `nSCI` | Exact mantissa digit count via regex | ✓ via coerce |
| `nSF` | Significant figures via `toPrecision` comparison | ✓ via coerce |
| `DT` | Format derived from UNIT string; timezone Z suffix stripped | ✓ (ISO 8601 only; unit-derived format missing) |
| `T` | Elapsed time `hh:mm[:ss]` | ✓ |
| `DMS` | Degrees:minutes:seconds with **colon** separator only | ✗ Missing |
| `YN` | Accepts `Y`/`N` (case-insensitive); rejects `yes`/`no`/numeric | ⚠ Partial (accepts YES/NO/TRUE/FALSE; python-ags4 is stricter) |
| `ID` | **Value must be unique within its column** | ✗ Missing |
| `U` | Numeric value required | ✗ Missing |

---

## BGS (pyagsapi) Additional Rules

The BGS checker runs python-ags4 first, then applies these UK-submission rules:

| BGS Rule | Description | GeoFlow status |
|---|---|---|
| BGS-1 | Required groups present: PROJ, ABBR, TYPE, UNIT, (LOCA or HOLE) | ✗ Missing (ABBR/TYPE/UNIT not enforced) |
| BGS-2 | GEOL group required | ✗ Missing (submission-specific) |
| BGS-3 | LOCA has at least one of LOCA_GREF, LOCA_LREF, or LOCA_LLZ populated | ✗ Missing |
| BGS-4 | HDPH_TOP non-null; HDPH_BASE non-null and non-zero | ✗ Missing |
| BGS-5 | HDPH ↔ GEOL LOCA_ID cross-consistency | ✗ Missing |
| BGS-6 | LOCA_NATE/LOCA_NATN within UK EEA boundary; NI conditional LOCA_GREF | ✗ Missing (UK-specific; could be ICE rule pack) |
| BGS-7 | LOCA_LOCX/LOCA_LOCY must not duplicate NATE/NATN or LON/LAT | ✗ Missing |
| BGS-8 | ALL groups with LOCA_ID column: IDs must be non-empty and exist in LOCA | ⚠ Partial (5 groups covered; generic check missing) |
| BGS-9 | SAMP + 18 child group referential integrity with composite keys | ✗ Missing |
| BGS-10 | Coordinate column TYPE must be numeric (DP/SF/SCI) | ✗ Missing |

---

## groundup ags-validator Notable Differences

groundup's TypeScript implementation adds or tightens:

- **Rule 1 stricter**: rejects ALL non-ASCII (> 127), including extended ASCII that python-ags4 tolerates
- **Rule 19**: GROUP name `[A-Z0-9]+` — allows digits; python-ags4 requires letters-only
- **Rule 8 / YN**: accepts lowercase `y`/`n`; rejects `yes`/`no` (stricter than geoflow which accepts YES/NO)
- **Rule 16**: Warning-level only for missing ABBR (not Error), matching real-world tolerance

---

## Identified Gaps & Remediation Plan

### Implemented in this analysis (see implementation commits)

| Rule ID | Severity | Description |
|---------|----------|-------------|
| AGS-STRUCT-004 | Warning | TRAN_AGS must be 4.0.3 / 4.0.4 / 4.1 |
| AGS-KEY-001 | Error | LOCA_ID must be unique within LOCA |
| AGS-XREF-003 | Error | ISPT.LOCA_ID must exist in LOCA |
| AGS-XREF-004 | Error | WSTK.LOCA_ID must exist in LOCA |
| AGS-XREF-005 | Error | HOLE.LOCA_ID must exist in LOCA |
| AGS-ABBR-001 | Error | PA field values must be in ABBR group |
| AGS-UNIT-001 | Warning | PU field data values must be in UNIT group |
| AGS-DATA-SHORT | Warning | DATA row has fewer values than HEADING count |

### High Priority (spec-required, commonly exercised)

#### Generic LOCA_ID cross-reference (BGS Rule 8)
- **Rule**: ALL groups that carry a `LOCA_ID` heading should verify the value
  exists in LOCA, not just the five groups now covered.
- **Implementation**: A Rust rule that iterates all groups, detects `LOCA_ID`
  headings, and cross-checks — removing the need for group-specific DSL rules.

#### SAMP composite key uniqueness
- **Rule**: Within a borehole, `LOCA_ID + SAMP_TOP + SAMP_REF` must be unique.
- **Implementation**: DSL `scope: "group:LOCA_ID"` rule with a `unique` aggregate.

#### GROUP name format (py-ags4 Rule 19)
- **Rule**: GROUP names should be ≤ 4 uppercase alphabetic characters.
- **Implementation**: Parser diagnostic when name doesn't match `^[A-Z]{1,4}$`.

#### HEADING name pattern (py-ags4 Rule 19b)
- **Rule**: Heading names should follow `GROUP_XXXX` prefix convention.
- **Implementation**: DSL or Rust warning rule; exemptions for cross-group keys.

#### YN strictness alignment
- **Current**: geoflow accepts `YES`, `NO`, `TRUE`, `FALSE`; python-ags4 and
  groundup accept only `Y`/`N` (case-insensitive).
- **Recommendation**: tighten to `Y`/`N` (accept case-insensitive) and add a
  test for rejected `yes`/`no` values.

#### ID column uniqueness (py-ags4 Rule 8 / ID type)
- **Rule**: Values in `ID`-type columns must be unique within their column.
- **Implementation**: Rust rule checking ID-typed headings for duplicates.

### Medium Priority

| Gap | Notes |
|-----|-------|
| GEOL layer monotonicity | DSL group-scoped rule; planned in spec sketch but absent from pack |
| TRAN_RCON-concatenated PA abbreviations | Split on `+` before ABBR lookup |
| DMS type validation | Degrees:minutes:seconds colon-delimited format |
| TYPE group consistency (Rule 17) | TYPE group must contain all used type codes |
| Heading order per dictionary (Rule 7.2) | Requires full dictionary heading-order metadata |
| Required-field emptiness check (Rule 10b extension) | Presence is checked (AGS-DICT-001); non-empty not yet |

### Low Priority / BGS-specific

| Gap | Notes |
|-----|-------|
| RECORD_LINK format + resolution | `GROUP:ID` format; resolve against target group |
| DICT group support for non-standard headings | Accept or warn about headings not in dict or DICT group |
| UK coordinate boundary check | BGS-specific; candidate for `rules/specs/bgs/` rule pack |
| FILE group disk-presence check | Filesystem-dependent; deferred |

---

## Test Fixture Inventory

### Added in this analysis

| Fixture | Tests rule(s) |
|---|---|
| `abbr_codelist_valid.ags` | AGS-ABBR-001 negative (no fire) |
| `abbr_codelist_invalid.ags` | AGS-ABBR-001 positive (fires) |
| `key_dup_loca.ags` | AGS-KEY-001 |
| `tran_version_warn.ags` | AGS-STRUCT-004 |
| `xref_multi_invalid.ags` | AGS-XREF-003/004/005 |
| `short_row.ags` | AGS-DATA-SHORT |
| `encoding_win1252.ags` | Windows-1252 encoding round-trip |

### Still needed

| Fixture | Tests rule(s) | Priority |
|---|---|---|
| `unit_codelist_valid.ags` | AGS-UNIT-001 negative | Medium |
| `unit_codelist_invalid.ags` | AGS-UNIT-001 positive | Medium |
| `samp_key_dup.ags` | SAMP composite key uniqueness | Medium |
| `geol_overlap.ags` | GEOL layer monotonicity | Medium |
| `geol_gap.ags` | GEOL layer continuity | Low |
| `record_link.ags` | RECORD_LINK format validation | Low |

---

## Notable Edge Cases from python-ags4 Test Suite

These are non-obvious behaviours confirmed in the Python library that should be
tested or documented in geoflow:

1. **Zero values exempt from SF check** — `0` is not validated for significant figures.
2. **Timezone suffix in DT** — content after `Z` is stripped before datetime parsing.
3. **Standalone SAMP without parent LOCA** — some configurations have no DICT_PGRP pointing from SAMP to LOCA; Rule 10c must not blindly orphan-flag such rows.
4. **Lowercase YN** — `y`/`n` are valid in python-ags4; `yes`/`no`/`YES`/`NO` are not.
5. **DMS comma separator** — explicitly rejected by python-ags4; colon only.
6. **TRAN_RCON concatenated abbreviations** — `CP+RC` is two valid codes, not one invalid code.
7. **Duplicate GROUP names** — treated as a fatal parser-level error, not a validation diagnostic.
8. **Whitespace-padded abbreviations** — `"CP "` is NOT found in ABBR; exact-match required.
9. **TRAN_AGS version dict selection** — the validator should adapt which standard dict version to load based on `TRAN_AGS` (4.0.3 vs 4.1 have different required-heading sets).
10. **ID uniqueness is column-scoped** — each `ID`-typed column must be unique within its own column, not across the entire group's key.

---

## Summary

GeoFlow now covers all high-priority format rules from the AGS4 specification
that are exercised in the python-ags4 and groundup test suites. The remaining
gaps are either medium-priority (generic cross-reference, key uniqueness
completeness, heading naming conventions) or BGS-specific submission rules that
belong in a separate `rules/specs/bgs/` rule pack rather than the standard pack.
