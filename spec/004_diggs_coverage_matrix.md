# DIGGS Coverage Matrix

Current state of the implemented AGS↔DIGGS subset in `geoflow-core`.

## Natively Mapped Groups

Groups with dedicated DIGGS XML elements — round-trip losslessly via named elements.

### Wave A

| AGS Group | DIGGS Element | Mapped Fields |
|---|---|---|
| `PROJ` | `<Project>` | `PROJ_ID`, `PROJ_NAME` |
| `LOCA` | `<SamplingLocation>` | `LOCA_ID`, `LOCA_NATE`, `LOCA_NATN` |
| `GEOL` | `<Lithology>` | `LOCA_ID`, `GEOL_TOP`, `GEOL_BASE`, `GEOL_DESC`, `GEOL_LEG` |
| `SAMP` | `<Sample>` | `LOCA_ID`, `SAMP_ID`, `SAMP_TYPE` |
| `ISPT` | `<SPTTest>` | `LOCA_ID`, `ISPT_TOP`, `ISPT_NVAL` |
| `WSTK` | `<WaterStrike>` | `LOCA_ID`, `WSTK_DPTH` |

### Wave B (Lab Tests)

| AGS Group | DIGGS Element | Mapped Fields |
|---|---|---|
| `LLPL` | `<AttenbergLimits>` | `LOCA_ID`, `SAMP_ID`, `SAMP_REF`, `LLPL_LL`, `LLPL_PL`, `LLPL_PI`, `LLPL_425` |
| `LDEN` | `<BulkDensityTest>` | `LOCA_ID`, `SAMP_ID`, `SAMP_REF`, `LDEN_BULK`, `LDEN_BDEN`, `LDEN_MC` |
| `LPDN` | `<ParticleDensityTest>` | `LOCA_ID`, `SAMP_ID`, `SAMP_REF`, `LPDN_PD`, `LPDN_MCMC` |
| `LPEN` | `<PenetratorTest>` | `LOCA_ID`, `SAMP_ID`, `SAMP_REF`, `LPEN_DEPTH`, `LPEN_STRE` |
| `LCON` | `<OedometerTest>` | `LOCA_ID`, `SAMP_ID`, `SAMP_REF`, `LCON_VERT`, `LCON_VOID`, `LCON_RHVC` |
| `LCBR` | `<CBRTest>` | `LOCA_ID`, `SAMP_ID`, `SAMP_REF`, `LCBR_COND`, `LCBR_CBR` |

## Reference Groups (MetadataGroup Wrapper)

AGS lookup/reference groups that have no DIGGS native equivalent. Preserved
losslessly via a generic `<MetadataGroup name="...">` XML wrapper.

| AGS Group | Notes |
|---|---|
| `ABBR` | Abbreviation definitions |
| `UNIT` | Unit definitions |
| `TYPE` | Type definitions |
| `DICT` | Data dictionary extensions |
| `HOLE` | AGS 3 carry-over group |

## Generic DataGroup Wrapper

All AGS groups not in the native or reference lists above are preserved
losslessly via a `<DataGroup name="...">` generic XML wrapper (same structure
as MetadataGroup). This covers the remaining wave C and D groups (in-situ
tests, monitoring, instrumentation) and any custom groups.

Groups wrapped via DataGroup appear in `ConversionReport.generic_groups`.

### Wave C (In-Situ Tests) — generically wrapped

`ICBR`, `IDEN`, `IPRM`, `IPRT`, `IRDX`, `IVAN`, `CDIA`, `CMET`, and all other
in-situ test groups.

### Wave D (Monitoring & Instrumentation) — generically wrapped

`MOND`, `PREM`, `PRTM`, `STCN`, `RELD`, and all other monitoring groups.

### Lab Tests Not Yet Natively Mapped — generically wrapped

`LBST`, `LSPT`, `LCPT`, `LRES`, `LTRT`, `LDOC`, and other lab test groups
not yet in wave B.

## ConversionReport Fields

| Field | Description |
|---|---|
| `generic_groups` | Groups wrapped via DataGroup (losslessly preserved but not natively mapped to DIGGS vocabulary) |
| `unmapped_fields` | Fields within natively-mapped groups that are not carried to DIGGS (informational) |

## Tests Backing This Matrix

### Wave A
- `diggs::tests::reads_minimal_project_and_locations`
- `diggs::tests::ags_to_diggs_to_ags_round_trips_mapped_subset`
- `cli_convert_round_trips_basic_diggs_subset`

### Wave B
- `diggs::tests::wave_b_lab_tests_round_trip`

### Generic DataGroup
- `diggs::tests::generic_data_group_round_trips_losslessly`
- `diggs::tests::conversion_report_lists_generic_groups_and_unmapped_fields`

### Metadata Groups
- `diggs::tests::metadata_groups_round_trip_losslessly`
- `diggs_fixtures::tests::minimal_subset_fixture_reads_expected_groups`

### Lossy Report
- `cli_convert_writes_lossy_report_for_unmapped_content`
