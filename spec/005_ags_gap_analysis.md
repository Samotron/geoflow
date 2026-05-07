# GeoFlow — AGS Gap Analysis

Compares GeoFlow against major community AGS 4.x implementations to identify
validation rule gaps and drive test parity.

## Libraries Compared

| Library | Language | Maintainer | Notes |
|---------|----------|------------|-------|
| **python-ags4** | Python | AGS Data Format WG (GitLab) | Canonical library; v1.2.0 Mar 2026 (AGS 4.2 support); used by BGS, groundup, geotechnicaldata |
| **ags4-validator-desktop-app** | Python/Qt | AGS Data Format WG (GitLab) | Official desktop validator; wraps python-ags4; v3.1 Apr 2026; adds NH_GDMS data quality checks |
| **pyagsapi (BGS checker)** | Python/FastAPI | British Geological Survey | Wraps python-ags4; adds 10 BGS/NGDC-specific submission rules |
| **ags-validator (groundup-dev)** | TypeScript/npm | groundup-dev | Browser-native three-stage pipeline; own rule numbering; covers AGS 4.0.3–4.1.1 |
| **AGS Data Toolkit for Excel** | VBA/Python | geotechnicaldata.com | Wraps python-ags4 for validation; Excel UI for batch check, export, group management; free |
| **ags-toolkit / ogt-ags-py** | Python | open-geotechnical | Conversion-focused (JSON/YAML/XLSX); validation listed "WIP" — not a meaningful target |

python-ags4 is the primary comparison baseline (most complete, most tested).

---

## python-ags4 Rule Coverage Matrix

python-ags4 (v1.2.0) implements a complete numbered rule set drawn from the AGS4
Data Format specification. The desktop app and AGS Data Toolkit for Excel both
wrap this library and inherit its coverage.

| Rule | Description | GeoFlow status | GeoFlow rule id |
|---|---|---|---|
| **1** | ASCII-only / encoding (UTF-8 or cp1252); BOM detection | ✓ Parser | parse_bytes / decode_bytes |
| **2** | Each GROUP must contain at least one DATA row | ✗ Missing | — |
| **2a** | CRLF line endings | ✓ Fix | `normalize-line-endings` |
| **2b** | UNIT row at index 0, TYPE row at index 1 after HEADING | ✓ Parser + Fix | AGS-UNIT-NOHEAD, AGS-TYPE-NOHEAD, `reorder-unit-type` |
| **3** | Valid data descriptor on every line | ✓ Parser | AGS-ROW-KIND |
| **4.1** | GROUP row: exactly one field (the group name) | ✓ Parser | AGS-GROUP-EMPTY |
| **4.2** | UNIT/TYPE/DATA field count matches HEADING | ✓ Parser | AGS-DATA-EXTRA (too many); AGS-DATA-SHORT (too few) |
| **5** | All fields double-quoted | ✓ Lexer | AGS-LEX (UnquotedField) |
| **6** | Fields comma-separated (implied by 2a/4.2/5) | ✓ implied | — |
| **7.1** | No duplicate heading names in a group | ✓ Parser | AGS-HEADING-DUP |
| **7.2** | Heading order must match dictionary reference order | ✗ Missing | — |
| **8** | Data values match declared TYPE | ✓ Rust | AGS-TYPE-002 |
| **9** | GROUP/HEADING names defined in standard dict or DICT group | ⚠ Partial | AGS-DICT-001 (required headings present); non-standard heading check missing |
| **10a** | KEY field combinations unique within group | ⚠ Partial | AGS-ID-001 ({GROUP}_ID primary keys); generic KEY field combo check missing |
| **10b** | REQUIRED fields must be present and non-empty | ✓ Rust | AGS-DICT-001 (presence) + AGS-DICT-003 (non-empty) |
| **10c** | Child group rows must have matching parent (DICT_PGRP) | ⚠ Partial | AGS-XREF-LOCA (all LOCA_ID refs); generic DICT_PGRP traversal missing |
| **11** | TRAN_DLIM/TRAN_RCON present if RL or concat-PA fields exist | ✗ Missing | — |
| **11c** | RL-type references must resolve unambiguously | ✗ Missing | — |
| **12** | Null values permitted in non-REQUIRED fields | ✓ implied | — |
| **13** | PROJ group required, exactly one row | ✓ DSL | AGS-STRUCT-001 |
| **14** | TRAN group required, exactly one row | ✓ DSL | AGS-STRUCT-002 |
| **15** | PU-type field DATA values must be in UNIT group | ✓ Rust | AGS-UNIT-001 |
| **16** | PA-type field values must be in ABBR group (handles TRAN_RCON concat) | ⚠ Partial | AGS-ABBR-001 (exact match); concat `+` split not yet implemented |
| **17** | TYPE group must contain entries for every data type used | ✗ Missing | — |
| **18** | If non-standard headings exist, DICT group must be present | ✗ Missing | — |
| **19** | GROUP name ≤ 4 uppercase letters | ✓ Parser | AGS-GROUP-FMT |
| **19a** | HEADING name ≤ 9 chars, uppercase alphanumeric + underscore | ✓ Rust | AGS-HEAD-004 |
| **19b.1** | HEADING name follows `GROUP_XXXX` prefix convention | ✗ Missing | — |
| **19b.2** | Cross-group heading references use correct group name | ✗ Missing | — |
| **19b.3** | Headings reference own group or defined external group | ✗ Missing | — |
| **20** | FILE group — referenced file paths exist on disk | ✗ Out of scope | filesystem-dependent |
| TRAN_AGS ver | TRAN_AGS must be a recognised AGS 4.x version | ⚠ Partial | AGS-STRUCT-004 (accepts 4.0.3/4.0.4/4.1; missing 4.1.1 and 4.2) |

### python-ags4 Rule 8 Type Validation Details

| Type | python-ags4 checks | GeoFlow (AGS-TYPE-002) |
|---|---|---|
| `nDP` | Exact decimal places via regex `^-?\d+\.\d{n}$` | ✓ via coerce (Raw on fail) |
| `nSCI` | Exact mantissa digit count via regex | ✓ via coerce |
| `nSF` | Significant figures via `toPrecision` comparison | ✓ via coerce |
| `DT` | Format derived from UNIT string; timezone Z suffix stripped | ✓ (ISO 8601 only; unit-derived format missing) |
| `T` | Elapsed time `hh:mm[:ss]` | ✓ |
| `DMS` | Degrees:minutes:seconds with **colon** separator only | ✓ AGS-TYPE-002 (added) |
| `YN` | Accepts `Y`/`N` (case-insensitive); rejects `yes`/`no`/numeric | ✓ (tightened; Y/N only) |
| `ID` | Value must be unique within its column | ⚠ Partial | AGS-ID-001 ({GROUP}_ID only; generic ID-type cols missing) |
| `U` | Numeric value required | ✗ Missing | — |

---

## AGS4 Validator Desktop App (ags4-validator-desktop-app) — Additional Notes

The official desktop app wraps python-ags4 and inherits all its rules. It adds:

| Feature | Description | GeoFlow status |
|---------|-------------|----------------|
| AGS 4.2 support | Dict v4.2 loaded; new groups validated (MONS, CPDx/CPTx, PMMx, DMDx/DMTx, ISTx) | ✗ Missing — geoflow dict is ≤4.1.1 |
| AGS 4.1.1 support | Version string "4.1.1" accepted in TRAN_AGS | ✗ Missing — AGS-STRUCT-004 rejects 4.1.1 |
| NH_GDMS data quality | "National Highways supply chain" automated quality checks (NH_GDMS_1..N) | ✗ Out of scope for standard pack; candidate for `rules/specs/nh/` |
| File hash verification | SHA-256 hash reported alongside validation result | ✗ Not planned |
| AGS ↔ Excel conversion | AGS to/from xlsx with one group per sheet | ✓ Partial (geoflow has xlsx export via CLI; no import yet) |
| AGS to GeoPackage/SQLite | Geospatial export formats (UK OSGB grids) | ✗ Out of scope |
| AGS to JSON/CSV | Row-wise and column-wise JSON; zipped CSV | ✗ Not planned |
| Custom dictionary | Non-UK users can supply their own AGS dictionary | ✗ Missing — geoflow hardcodes `ags4.yml` |

---

## AGS Data Toolkit for Excel (geotechnicaldata.com) — Additional Notes

Wraps python-ags4 for format validation; adds Excel-native workflow features:

| Feature | Description | GeoFlow status |
|---------|-------------|----------------|
| Batch checking | Check multiple AGS files in one operation | ✓ geoflow CLI accepts multiple files |
| Export filtered AGS | Export subset of groups from an AGS file | ✗ Not implemented |
| Find line / Find ASCII | Locate specific rows or non-ASCII characters | ✗ Not implemented |
| Replace groups | Swap a group's content with data from another source | ✗ Not implemented |
| Delete groups | Remove a named group from a file | ✗ Not implemented |
| Clear SAMP_ID | Specific field-clearing operation | ✗ Out of scope |
| Australian AGS (4.1.1 AU 1.2) | Regional variant dictionary and rules | ✗ Out of scope for standard pack |
| New Zealand AGS variant | Regional variant support | ✗ Out of scope |
| Custom dictionary | Validation against user-supplied dict | ✗ Missing — see above |

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
| BGS-6 | LOCA_NATE/LOCA_NATN within UK EEA boundary; NI conditional LOCA_GREF | ✗ Missing (UK-specific; candidate for `rules/specs/bgs/`) |
| BGS-7 | LOCA_LOCX/LOCA_LOCY must not duplicate NATE/NATN or LON/LAT | ✗ Missing |
| BGS-8 | ALL groups with LOCA_ID column: IDs must be non-empty and exist in LOCA | ✓ AGS-XREF-LOCA (generic, all groups) |
| BGS-9 | SAMP + 18 child group referential integrity with composite keys | ⚠ Partial (AGS-KEY-002 covers SAMP; child groups not covered) |
| BGS-10 | Coordinate column TYPE must be numeric (DP/SF/SCI) | ✗ Missing |

---

## groundup ags-validator Notable Differences

groundup's TypeScript implementation adds or tightens:

- **Rule 1 stricter**: rejects ALL non-ASCII (> 127), including extended ASCII that python-ags4 tolerates
- **Rule 19**: GROUP name `[A-Z0-9]+` — allows digits; python-ags4 requires letters-only
- **Rule 8 / YN**: accepts lowercase `y`/`n`; rejects `yes`/`no` — now matches geoflow
- **Rule 16**: Warning-level only for missing ABBR (not Error), matching real-world tolerance

---

## Identified Gaps & Remediation Plan

### Implemented in first commit (initial analysis)

| Rule ID | Severity | Description |
|---------|----------|-------------|
| AGS-STRUCT-004 | Warning | TRAN_AGS must be 4.0.3 / 4.0.4 / 4.1 |
| AGS-XREF-003 | Error | ISPT.LOCA_ID must exist in LOCA |
| AGS-XREF-004 | Error | WSTK.LOCA_ID must exist in LOCA |
| AGS-XREF-005 | Error | HOLE.LOCA_ID must exist in LOCA |
| AGS-ABBR-001 | Error | PA field values must be in ABBR group |
| AGS-UNIT-001 | Warning | PU field data values must be in UNIT group |
| AGS-DATA-SHORT | Warning | DATA row has fewer values than HEADING count |

### Implemented in second commit (gap remediation)

| Rule ID | Severity | Description |
|---------|----------|-------------|
| AGS-XREF-LOCA | Error | All groups: LOCA_ID must exist in LOCA (replaces XREF-001..005) |
| AGS-ID-001 | Error | {GROUP}_ID primary key must be unique within its group |
| AGS-KEY-002 | Error | SAMP composite key (LOCA_ID + SAMP_TOP + SAMP_REF) must be unique |
| AGS-DICT-003 | Error | Required headings must have non-empty values in every DATA row |
| AGS-HEAD-004 | Warning | Heading names must be ≤9 chars, uppercase alphanumeric + underscore |
| AGS-GROUP-FMT | Warning | GROUP names must be 1–4 uppercase letters |
| AGS-VAL-002 | Error | GEOL GEOL_TOP values must be monotonically ascending per borehole |
| AgsType::DMS | — | DMS type added; colon-delimited D:MM:SS validated; comma rejected |
| YN strictness | — | YN coercion tightened to Y/N only; YES/NO/TRUE/FALSE now fire AGS-TYPE-002 |

### High Priority (spec-required, newly identified)

#### AGS 4.1.1 and 4.2 version strings (AGS-STRUCT-004 update)
- **Issue**: `AGS-STRUCT-004` only accepts 4.0.3, 4.0.4, 4.1. python-ags4 v1.2.0 now
  validates 4.1.1 and 4.2. Both version strings must be accepted.
- **Implementation**: Add `"4.1.1"` and `"4.2"` to the accepted list in `pack.yml`.

#### AGS 4.2 dictionary
- **Issue**: geoflow's `ags4.yml` dict covers up to 4.1.1. AGS 4.2 adds new groups:
  MONS (monitoring), CPDx/CPTx series (replace SCPx/SCTx), PMMx (Ménard),
  PMTP/PMTZ, DMDx/DMTx (Flat Dilatometer), ISTx (In-situ Seismic).
  CTRx/RESx are deprecated.
- **Implementation**: Extend `ags4.yml` with 4.2 group definitions; add a `version`
  field to the dict so `AGS-DICT-001` can select the correct dict based on TRAN_AGS.

#### Rule 2: Groups must have at least one DATA row
- **Rule**: Every GROUP must contain at least one DATA row (python-ags4 Rule 2).
- **Implementation**: DSL file-scoped rule: `groups_meta.all(g, g.row_count > 0)`,
  or a parser-level warning emitted from `finish()` for empty groups.

#### Rule 9: Non-standard heading detection (Rule 18 companion)
- **Rule**: Headings not in the standard dict and not defined in a DICT group
  should generate a warning; if non-standard headings exist, DICT group is required
  (Rule 18).
- **Implementation**: Rust rule that cross-checks each heading name against
  `ags4_dict()` and the file's DICT group. Two separate diagnostics:
  `AGS-DICT-004` (non-standard heading, warning) and `AGS-DICT-005`
  (DICT group absent when non-standard headings present, error).

#### Rule 10a: Generic composite KEY field uniqueness
- **Rule**: python-ags4 uses the dictionary's `KEY` field list per group to check
  composite key uniqueness (not just {GROUP}_ID). For example GEOL's composite
  key is LOCA_ID + GEOL_TOP.
- **Implementation**: Extend `ags4.yml` with `key_headings` per group; add a Rust
  rule (`AGS-KEY-003`) that reads those key lists and checks uniqueness.

### Medium Priority

| Gap | Notes |
|-----|-------|
| TRAN_RCON concat split for ABBR | Split PA values on `+` before ABBR lookup; `CP+RC` should resolve to two valid codes |
| Rule 11 / TRAN_DLIM | If RL-type fields exist, TRAN_DLIM must be set in TRAN |
| Rule 11c / RL resolution | RL values (`GROUP:ID`) must reference existing rows |
| Rule 17 / TYPE group consistency | All type codes used in HEADING rows must appear in TYPE.TYPE_STAT |
| Rule 19b.1 / Heading prefix | Headings should follow `GROUP_XXXX` prefix convention |
| Generic ID-type uniqueness | AGS-ID-001 currently only checks {GROUP}_ID columns; all ID-type columns should be unique within their column (python-ags4 Rule 8 / ID type) |
| Custom dictionary support | Allow `--dict` flag to load non-standard dict YAML for regional variants |
| TRAN_AGS-version-aware dict | Load 4.0.3 vs 4.1 vs 4.2 dict based on TRAN_AGS value |

### Low Priority / Submission-specific

| Gap | Notes |
|-----|-------|
| NH_GDMS quality checks | National Highways supply chain rules; candidate for `rules/specs/nh/` rule pack |
| BGS UK coordinate boundary | LOCA_NATE/NATN within UK EEA; candidate for `rules/specs/bgs/` |
| BGS required groups | ABBR, TYPE, UNIT required; candidate for `rules/specs/bgs/` |
| Australian AGS 4.1.1 AU 1.2 | Regional variant dict; candidate for `rules/specs/au/` |
| RECORD_LINK format + resolution | `GROUP:ID` format; resolve against target group |
| FILE group disk-presence check | Filesystem-dependent; deferred |

---

## Test Fixture Inventory

### Added in initial analysis

| Fixture | Tests rule(s) |
|---|---|
| `abbr_codelist_valid.ags` | AGS-ABBR-001 negative (no fire) |
| `abbr_codelist_invalid.ags` | AGS-ABBR-001 positive (fires) |
| `key_dup_loca.ags` | AGS-ID-001 (was AGS-KEY-001) |
| `tran_version_warn.ags` | AGS-STRUCT-004 |
| `xref_multi_invalid.ags` | AGS-XREF-LOCA |
| `short_row.ags` | AGS-DATA-SHORT |
| `encoding_win1252.ags` | Windows-1252 encoding round-trip |

### Added in gap remediation

| Fixture | Tests rule(s) |
|---|---|
| `geol_overlap.ags` | AGS-VAL-002 (non-monotonic GEOL layers) |
| `samp_key_dup.ags` | AGS-KEY-002 (duplicate SAMP composite key) |
| `unit_codelist_valid.ags` | AGS-UNIT-001 negative |
| `unit_codelist_invalid.ags` | AGS-UNIT-001 positive |

### Still needed

| Fixture | Tests rule(s) | Priority |
|---|---|---|
| `tran_ags_4_1_1.ags` | AGS-STRUCT-004 accepts 4.1.1 | High |
| `tran_ags_4_2.ags` | AGS-STRUCT-004 accepts 4.2 | High |
| `empty_group.ags` | Rule 2 (group with no DATA rows) | Medium |
| `nonstandard_heading.ags` | AGS-DICT-004 / AGS-DICT-005 | Medium |
| `geol_gap.ags` | GEOL layer continuity | Low |
| `record_link.ags` | RECORD_LINK format validation | Low |

---

## Notable Edge Cases from python-ags4 Test Suite

Non-obvious behaviours confirmed in the Python library:

1. **Zero values exempt from SF check** — `0` is not validated for significant figures.
2. **Timezone suffix in DT** — content after `Z` is stripped before datetime parsing.
3. **Standalone SAMP without parent LOCA** — some configurations have no DICT_PGRP pointing from SAMP to LOCA; Rule 10c must not blindly orphan-flag such rows.
4. **Lowercase YN** — `y`/`n` are valid; `yes`/`no`/`YES`/`NO` are not — now matches geoflow.
5. **DMS comma separator** — explicitly rejected; colon only — now matches geoflow.
6. **TRAN_RCON concatenated abbreviations** — `CP+RC` is two valid codes, not one invalid code.
7. **Duplicate GROUP names** — treated as a fatal parser-level error, not a validation diagnostic.
8. **Whitespace-padded abbreviations** — `"CP "` is NOT found in ABBR; exact-match required.
9. **TRAN_AGS version dict selection** — validator should adapt which standard dict version to load based on `TRAN_AGS` (4.0.3 vs 4.1 vs 4.2 have different group/heading sets).
10. **ID uniqueness is column-scoped** — each `ID`-typed column must be unique within its own column, not across the entire group key.
11. **AGS 4.2 version string** — `"4.1.1"` and `"4.2"` are valid TRAN_AGS values; geoflow currently rejects them.
12. **Escaped double quotes in CSV** — python-ags4 v1.2.0 fixed parsing of `""` inside quoted fields (Rules 4 & 5); geoflow should test this edge case.

---

## Summary

GeoFlow now covers all high-priority format rules from the AGS4 specification
as tested by python-ags4 and groundup (61 parity tests, all passing). The
remaining gaps fall into three tiers:

1. **Near-term standard pack** (high value, low risk): AGS 4.1.1 / 4.2 TRAN_AGS
   version strings, Rule 2 (empty group), Rule 9 / Rule 18 non-standard heading
   detection, AGS 4.2 dict extension, generic composite key uniqueness (Rule 10a).

2. **Medium-term standard pack**: Rule 11 / RL validation, Rule 17 TYPE group
   consistency, Rule 19b heading prefix convention, TRAN_RCON concat split,
   TRAN_AGS-version-aware dict selection.

3. **Separate rule packs** (submission-specific): National Highways NH_GDMS checks
   (`rules/specs/nh/`), BGS UK rules (`rules/specs/bgs/`), Australian AGS 4.1.1 AU
   1.2 (`rules/specs/au/`).
