# GeoFlow Project Ontology Draft

Status: draft  
Date: 2026-05-07

## Purpose

Define a query-first ontology for GeoFlow that sits above raw AGS groups and
supports:

- whole-project knowledge graph views
- cross-group semantic search
- question-driven drill-down in the explorer
- future RDF / graph export without forcing RDF internals now

This document is intentionally not an OWL file. It is the canonical domain
design that GeoFlow code can implement in Rust, JSON, SQLite, or RDF later.

## Why This Exists

AGS is a transfer format. It preserves field structure and key integrity, but
it does not by itself provide a good semantic model for whole-project queries.

Examples:

- "Which boreholes contain `GEOL_LEG = CL`?"
- "Which locations contain chalk below 5 m?"
- "Which samples came from made ground?"
- "Which lab tests relate to samples from sandy gravel?"
- "Which boreholes within 100 m of this point contain peat?"

Those questions span multiple AGS groups and require a model richer than
`GROUP -> ROW -> HEADING`.

## Research Basis

This draft aligns with:

- AGS 4.1.1 guidance on KEY headings, REQUIRED headings, location identity,
  and sample linking:
  https://www.ags.org.uk/content/uploads/2022/02/AGS4-v-4.1.1-2022.pdf
- AGS 4 notes on `LOCA`, `SAMP_ID`, and `SAMP_LINK`:
  https://www.ags.org.uk/content/uploads/2020/11/Electronic-Transfer-of-Geotechnical-Data-4th-Edition-Addendum-3.pdf
- DIGGS object structure around project, sampling feature, sample,
  observation, measurement, and construction activity:
  https://diggsml.org/docs/3.0/Common_xsd_Element_diggs_Diggs.html
- DIGGS lithology semantics around classification, legend code, matrix type,
  and colour:
  https://diggsml.org/docs/latest/Kernel_xsd_Complex_Type_diggs_LithologyType.html
- W3C / OGC standards suitable for later semantic export:
  SSN/SOSA: https://www.w3.org/TR/vocab-ssn/
  GeoSPARQL: https://portal.ogc.org/files/102882
  PROV-O: https://www.w3.org/TR/prov-o/

## Design Principles

1. Preserve raw AGS fidelity.
2. Build a canonical domain model above AGS, not instead of AGS.
3. Design for questions first, not tables first.
4. Treat `LOCA` as a general investigation location, not a borehole-only type.
5. Separate explicit source facts from inferred or parsed facts.
6. Keep provenance for every derived semantic node.
7. Prefer a small number of high-value core entity types.

## Layered Model

GeoFlow should operate in three layers.

### Layer 1: Raw Transfer Layer

Exact AGS groups, rows, headings, units, and types.

Examples:

- `LOCA`
- `GEOL`
- `SAMP`
- `ISPT`
- `WSTK`
- `LLPL`
- `LDEN`

This layer is authoritative for round-tripping.

### Layer 2: Canonical Domain Layer

Normalized project concepts extracted from AGS.

Examples:

- `Project`
- `InvestigationPoint`
- `DepthInterval`
- `LithologyObservation`
- `Sample`
- `FieldTest`
- `LabTest`
- `Measurement`

This layer is authoritative for app queries.

### Layer 3: Semantic Facet Layer

Derived classifications, parsed descriptions, spatial relations, provenance,
and graph edges.

Examples:

- `MaterialFacet`
- `Classification`
- `SpatialCluster`
- `DerivedObservation`
- `ProvenanceEvent`

This layer is authoritative for search, graph UI, and reasoning.

## Core Classes

### Project

The top-level investigation or commission represented by one or more AGS
files.

Core properties:

- `project_id`
- `name`
- `client`
- `source_files[]`

### FileSubmission

A single AGS file or imported package.

Core properties:

- `file_id`
- `file_name`
- `ags_version`
- `ingested_at`
- `checksum`

### InvestigationPoint

The canonical representation of a `LOCA` row.

This is the root physical asset in the ontology. `Borehole`, `TrialPit`, and
`CPTPoint` are subtypes of `InvestigationPoint`.

Core properties:

- `point_id`
- `loca_id`
- `point_type`
- `easting`
- `northing`
- `elevation`
- `final_depth`
- `geometry`

Subtypes:

- `Borehole`
- `TrialPit`
- `CPTPoint`
- `MonitoringPoint`
- `OtherLocation`

### DepthInterval

A measurable interval associated with an investigation point.

Core properties:

- `interval_id`
- `point_id`
- `top_depth`
- `base_depth`
- `thickness`

Notes:

- not every interval comes from `GEOL`; tests and samples may create their own
  interval semantics
- some intervals are point-depth observations where `top_depth == base_depth`

### LithologyObservation

A geology or stratigraphy observation attached to a depth interval.

Core properties:

- `observation_id`
- `interval_id`
- `point_id`
- `raw_description`
- `legend_code`
- `confidence`
- `source_kind`

### Sample

A physical or logical sample tied to an investigation point and optionally a
depth or interval.

Core properties:

- `sample_id`
- `point_id`
- `loca_id`
- `samp_id`
- `samp_ref`
- `samp_type`
- `top_depth`
- `base_depth`

### FieldTest

An in-situ or field observation/test under an investigation point.

Examples:

- SPT
- water strike
- cone penetration
- permeability tests in the ground

Core properties:

- `test_id`
- `point_id`
- `test_type`
- `depth_ref`
- `top_depth`
- `base_depth`

### LabTest

A laboratory test performed on a sample.

Core properties:

- `lab_test_id`
- `sample_id`
- `point_id`
- `test_type`
- `procedure`

### Measurement

A numeric or coded result belonging to a field test, lab test, or observation.

Core properties:

- `measurement_id`
- `owner_id`
- `measure_name`
- `value`
- `unit`
- `qualifier`

### Classification

A normalized classification assertion for a geology interval or sample.

Core properties:

- `classification_id`
- `subject_id`
- `scheme`
- `code`
- `label`
- `explicitness`

Examples:

- `GEOL_LEG = CL`
- parsed soil type = `clay`
- matrix type = `soil`

### MaterialFacet

An extracted material trait that is useful in search but not necessarily a
formal code system.

Examples:

- `primary_soil_type = clay`
- `secondary_soil_type = sandy`
- `rock_type = chalk`
- `made_ground = true`
- `colour = brown`
- `consistency = firm`

### ProvenanceEvent

Records how a semantic node was created.

Core properties:

- `provenance_id`
- `entity_id`
- `derived_from`
- `method`
- `software_version`
- `timestamp`

## Core Relationships

These edges define the project graph.

- `Project hasSubmission FileSubmission`
- `Project hasInvestigationPoint InvestigationPoint`
- `FileSubmission containsRawGroup AgsGroup`
- `InvestigationPoint hasInterval DepthInterval`
- `DepthInterval hasObservation LithologyObservation`
- `InvestigationPoint produced Sample`
- `Sample hasLabTest LabTest`
- `InvestigationPoint hasFieldTest FieldTest`
- `FieldTest hasMeasurement Measurement`
- `LabTest hasMeasurement Measurement`
- `LithologyObservation hasClassification Classification`
- `LithologyObservation hasFacet MaterialFacet`
- `Sample derivedFrom IntervalOrObservation`
- `Entity hasProvenance ProvenanceEvent`
- `InvestigationPoint spatiallyNear InvestigationPoint`
- `DepthInterval nextBelow DepthInterval`

Optional future relationships:

- `Sample linkedTo ObservationOrTest` from `SAMP_LINK`
- `InvestigationPoint partOf Cluster`
- `Observation contradicts Observation`

## Canonical Identifiers

Canonical IDs should be deterministic and stable across reloads.

### Project

`project:{project_id}`

### FileSubmission

`file:{sha256}`

### InvestigationPoint

Preferred:

`point:{project_id}:{loca_id}`

Fallback when project identity is absent:

`point:{file_hash}:{loca_id}`

### DepthInterval

`interval:{point_id}:{top_depth}:{base_depth}:{kind}`

Examples:

- `interval:point:foo:BH01:0.00:1.50:geol`
- `interval:point:foo:BH01:5.00:5.00:ispt`

### LithologyObservation

`lith:{interval_id}:{ordinal}`

### Sample

Preferred:

`sample:{point_id}:{samp_id}`

Fallback:

`sample:{point_id}:{samp_top}:{samp_ref}:{samp_type}`

### Tests

Examples:

- `fieldtest:{point_id}:ispt:{depth}:{tesn}`
- `fieldtest:{point_id}:wstk:{depth}:{ordinal}`
- `labtest:{sample_id}:llpl`

### Measurements

`measure:{owner_id}:{measure_name}`

## Mapping from AGS to Canonical Ontology

### LOCA

Maps to:

- `InvestigationPoint`

Important headings:

- `LOCA_ID`
- `LOCA_TYPE`
- `LOCA_NATE`
- `LOCA_NATN`
- `LOCA_GL`
- `LOCA_FDEP`

### GEOL

Maps to:

- `DepthInterval`
- `LithologyObservation`
- `Classification`
- `MaterialFacet`

Important headings:

- `LOCA_ID`
- `GEOL_TOP`
- `GEOL_BASE`
- `GEOL_DESC`
- `GEOL_LEG`

### SAMP

Maps to:

- `Sample`
- optional `DepthInterval`

Important headings:

- `LOCA_ID`
- `SAMP_ID`
- `SAMP_REF`
- `SAMP_TYPE`
- `SAMP_TOP`
- `SAMP_BASE`
- `SAMP_LINK`

### ISPT

Maps to:

- `FieldTest`
- `Measurement`

Important headings:

- `LOCA_ID`
- `ISPT_TOP`
- `ISPT_TESN`
- `ISPT_NVAL`

### WSTK

Maps to:

- `FieldTest`
- `Measurement`

Important headings:

- `LOCA_ID`
- `WSTK_DPTH`

### LLPL / LDEN / LPDN / LPEN / LCON / LCBR

Maps to:

- `LabTest`
- `Measurement`

Join path:

- `LOCA_ID`
- `SAMP_ID`
- `SAMP_REF`

This matches the coverage already implied in current code:
[spec/004_diggs_coverage_matrix.md](/home/samotron/dev/geoflow/spec/004_diggs_coverage_matrix.md:14),
[crates/geoflow-core/src/diggs.rs](/home/samotron/dev/geoflow/crates/geoflow-core/src/diggs.rs:1080)

## Explicit vs Derived Facts

This is important and should not be blurred.

### Explicit Facts

Directly present in AGS.

Examples:

- `GEOL_LEG = CL`
- `LOCA_NATE = 123456.7`
- `ISPT_NVAL = 24`

### Derived Facts

Computed or parsed by GeoFlow.

Examples:

- `primary_soil_type = clay`
- `rock_type = chalk`
- `made_ground = true`
- `matrix_type = soil`

Every derived fact must store:

- source headings used
- derivation method
- confidence score

The existing `GEOL_DESC` parsing in
[crates/geoflow-core/src/describe.rs](/home/samotron/dev/geoflow/crates/geoflow-core/src/describe.rs:200)
is the first implementation of this principle.

## Query Model

The ontology must be validated against real question patterns.

### Q1. Which boreholes contain this geology code?

Example:

- `GEOL_LEG = CL`

Canonical query:

1. find `Classification` where `scheme = "GEOL_LEG"` and `code = "CL"`
2. traverse to `LithologyObservation`
3. traverse to parent `InvestigationPoint`
4. filter subtype = `Borehole`

### Q2. Which locations contain chalk below 5 m?

Canonical query:

1. find `LithologyObservation`
2. where `rock_type = chalk` or classification matches chalk
3. where `base_depth > 5` and `top_depth < base_depth`
4. return parent `InvestigationPoint`

### Q3. Which samples came from made ground?

Canonical query:

1. find `Sample`
2. resolve overlapping `DepthInterval` / `LithologyObservation`
3. filter `MaterialFacet.made_ground = true`

### Q4. Which lab tests relate to sandy gravel?

Canonical query:

1. find `LithologyObservation` with `primary_soil_type = gravel`
2. and `secondary_soil_type = sand` or equivalent code
3. resolve linked samples by depth and location
4. return descendant `LabTest`

### Q5. Which boreholes within 100 m of a point contain peat?

Canonical query:

1. spatial filter on `InvestigationPoint.geometry`
2. join to `LithologyObservation`
3. filter `material` or `classification` = peat

### Q6. Which files disagree on geology for the same location?

Canonical query:

1. group by canonical `point_id`
2. compare explicit `GEOL_LEG` and normalized `GEOL_DESC` intervals across files
3. emit conflict edges or diagnostics

## Question Catalogue for v1

The first implementation should explicitly support these question families.

### Identity

- What locations exist in this project?
- What type is each location?
- Which files mention this location?

### Geology / Stratigraphy

- Which locations contain code X?
- Which locations contain material Y?
- What is the interval sequence under this borehole?
- Where are the top/base transitions for a material?

### Sampling

- Which samples came from this interval?
- Which intervals produced samples of type X?
- Which samples are linked via `SAMP_LINK`?

### Testing

- Which SPTs occur in this borehole?
- Which lab tests belong to this sample?
- Which locations have Atterberg data?

### Spatial

- Which boreholes are within distance X of location Y?
- Which locations lie inside a polygon?
- Which nearby locations share a geology code?

### Provenance / Quality

- Is this classification explicit or inferred?
- Which facts came from parsed text only?
- Which location references do not resolve?
- Which groups have unresolved parent-child joins?

## Explorer Implications

The current graph is mostly keyed by `LOCA_ID`. That is a good first
navigation spine, but the ontology suggests a broader explorer structure.

### Recommended graph entry points

- by investigation point
- by geology code
- by sample
- by test type
- by file

### Recommended graph node palette

- `InvestigationPoint`
- `DepthInterval`
- `LithologyObservation`
- `Sample`
- `FieldTest`
- `LabTest`
- `Classification`

### Recommended graph interactions

- click a geology code to see all parent boreholes
- click a sample to see parent interval and descendant tests
- click a file to show only explicit facts from that file
- toggle explicit vs derived edges

## Storage Strategy

Do not force RDF storage in the application core yet.

Recommended approach:

1. keep raw AGS in existing model
2. build a canonical semantic projection in Rust structs
3. expose that projection as JSON for the web app
4. optionally persist to SQLite tables or graph tables
5. later add RDF / Turtle / JSON-LD export

This keeps the implementation practical while preserving future semantic
interoperability.

## Proposed Rust Types

Illustrative only:

```rust
struct InvestigationPoint {
    id: String,
    loca_id: String,
    point_type: PointType,
    easting: Option<f64>,
    northing: Option<f64>,
    elevation: Option<f64>,
    final_depth: Option<f64>,
}

struct DepthInterval {
    id: String,
    point_id: String,
    kind: IntervalKind,
    top_depth: Option<f64>,
    base_depth: Option<f64>,
}

struct LithologyObservation {
    id: String,
    interval_id: String,
    point_id: String,
    raw_description: Option<String>,
    legend_code: Option<String>,
    classifications: Vec<Classification>,
    facets: Vec<MaterialFacet>,
}

struct Sample {
    id: String,
    point_id: String,
    samp_id: Option<String>,
    samp_ref: Option<String>,
    samp_type: Option<String>,
    top_depth: Option<f64>,
    base_depth: Option<f64>,
}
```

## Implementation Plan

### Phase 1: Canonical Projection

Add a new semantic projection module in `geoflow-core`.

Deliverables:

- `InvestigationPoint`
- `DepthInterval`
- `LithologyObservation`
- `Sample`
- `FieldTest`
- `LabTest`

### Phase 2: Normalized Classifications

Promote `GEOL_LEG` and parsed `GEOL_DESC` output to formal facets.

Deliverables:

- explicit `Classification`
- derived `MaterialFacet`
- provenance for derived classifications

### Phase 3: Explorer Query API

Expose canonical graph JSON to the web app.

Deliverables:

- `get_semantic_graph(bytes)`
- query endpoints for borehole, geology code, sample, test

### Phase 4: Question Templates

Implement a library of reusable query patterns.

Deliverables:

- `locations_with_geol_code(code)`
- `samples_from_material(material)`
- `lab_tests_for_sample(sample_id)`
- `points_with_material_below_depth(material, depth)`

### Phase 5: Spatial + Provenance

Deliverables:

- distance joins
- polygon filters
- explicit vs derived graph overlays
- conflict / contradiction views

## Decisions

### Decision 1: Use `InvestigationPoint` as the root entity

Reason:

AGS `LOCA` is broader than boreholes. A borehole-only ontology would be too
narrow.

### Decision 2: Keep `DepthInterval` explicit

Reason:

Many important project questions are interval-based, not row-based.

### Decision 3: Distinguish `Classification` from `MaterialFacet`

Reason:

`GEOL_LEG = CL` is not the same kind of fact as `made_ground = true`.

### Decision 4: Track explicit vs derived semantics

Reason:

Users must be able to trust the graph and know what was inferred by GeoFlow.

## Open Questions

1. How should project identity be defined when multiple AGS files disagree on
   `PROJ_ID` or omit it?
2. Should overlapping geology intervals be represented as separate observations
   or normalized into a cleaned interval chain plus conflicts?
3. Should sample-to-interval joins be strict by exact depth or tolerant by
   overlap?
4. How should `SAMP_LINK` be generalized into typed graph edges?
5. Should canonical IDs be file-scoped by default until cross-file merge logic
   matures?

## Immediate Next Steps

1. Add a `semantic` module in `geoflow-core`.
2. Implement canonical projection for `LOCA`, `GEOL`, `SAMP`, `ISPT`, and
   `WSTK`.
3. Add a browser API that returns this graph as JSON.
4. Build the first real semantic query:
   `which investigation points contain geology code X?`
5. Extend the graph tab to switch from row-based links to semantic nodes.
