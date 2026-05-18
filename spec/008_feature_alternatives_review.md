# GeoFlow — Feature Alternatives Review

Status: draft
Date: 2026-05-18
Branch: `claude/review-feature-alternatives-ndVib`

## Purpose

Survey the landscape of features that could be added to GeoFlow, organised by
"what gap does this close" rather than "what would be fun to build". Each entry
is scored on **leverage** (how many users benefit), **fit** (does it sit on top
of what we already have, or require new infra), and **effort**. Recommendations
at the bottom.

This is a planning document, not a backlog. Items already in `TODO.md` or
`spec/005_ags_gap_analysis.md` are referenced but not re-litigated.

## Where GeoFlow Stands Today

| Capability | Status |
|---|---|
| AGS 4.x parse/serialize, AGS 3 → 4 migrate | ✓ |
| Built-in validation + JEXL rule packs | ✓ |
| Quality grading A–F | ✓ |
| Auto-fixer | ✓ |
| AGS ↔ DIGGS 2.6 round-trip | ✓ (lossy report) |
| HTML explorer + 2D cross-sections | ✓ |
| 3D model (TPS surfaces, voxel, Three.js) | ✓ |
| CPT analysis | ✓ (new) |
| Soil/rock description parser | ✓ |
| Web app + local project storage (commit chain) | ✓ |
| SQLite / GeoPackage ingest+query | ✓ |
| GI factual report (text) | ✓ |

The runtime is TypeScript-only, runs in browser and Node, has no server
component, and the web app is the primary surface for end users.

## Alternatives, By Category

Scoring scale: **L** = low, **M** = medium, **H** = high.

### 1. Input/Output Formats

What other formats sit next to AGS that real users have to deal with?

| Alternative | What it is | Leverage | Fit | Effort | Notes |
|---|---|---|---|---|---|
| **AGSi (interpretive)** | AGS schema for *interpreted* ground models (layers, parameters, design lines) — adopted by AGS WG, separate from AGS 4 transfer | H | H | M | Natural pair to AGS 4 factual. Maps to the canonical Layer-2 model in spec/006. Would let GeoFlow output ground models, not just import factual data |
| **GEF / CPT-GEF** | Dutch standard for CPT (`.gef`) files, very widely used outside UK | H | M | M | We already have a CPT analyser; reading GEF lets non-AGS users in |
| **CPT XML (CPTBE, CPT-1.4)** | International CPT exchange XML | M | M | M | Same surface as GEF; share a CPT IR |
| **LAS (Log ASCII Standard)** | De facto borehole geophysics format | M | L | M | Adjacent industry; would lift us out of "AGS tools" niche |
| **LandXML** | Civil/survey exchange — surfaces, alignments | M | M | M | Our TPS surfaces + topo already produce TINs internally; LandXML export is cheap |
| **GeoJSON / KML location export** | One-line wins for GIS users | H | H | L | LOCA → GeoJSON FeatureCollection; trivial; deserves to be a button |
| **CSV / TSV column-wise** | Most-asked Excel workflow that isn't xlsx | H | H | L | One sheet per group; we already have xlsx export |
| **Excel import** (we only export) | Round-trip with the AGS Toolkit for Excel community | M | H | M | Mirror of existing exporter |
| **PDF report** | Currently HTML-only explorer | H | M | M | Either headless-Chrome render of the HTML, or jsPDF/pdfmake direct |
| **DOCX report** | Engineering deliverable format | M | L | H | `docx` library + templating; meaningful only with a template engine |
| **AGS 4.1.1 / 4.2 dict + version strings** | Already in `005_ags_gap_analysis.md` | H | H | M | Listed here only for completeness — should ship before exotic formats |
| **Australian / NZ AGS variants** | Regional dictionaries | L | H | L | Pure rule-pack work; community-driven |

### 2. Validation & Rule Packs

| Alternative | What it is | Leverage | Fit | Effort | Notes |
|---|---|---|---|---|---|
| **BGS pyagsapi rule pack** | UK National Geotechnical DB submission rules (BGS-1..10) | H | H | M | Already scoped in spec/005; `rules/specs/bgs/` |
| **NH_GDMS pack** | National Highways supply chain QA | M | H | M | `rules/specs/nh/` — large UK infra users |
| **Custom dictionary `--dict`** | User-supplied AGS dict for regional variants / extensions | M | H | M | Already flagged; unlocks all regional packs |
| **Cross-file validation pack** | Project = many .ags files; check ID uniqueness across files | M | H | M | We have the merge engine; this is a thin wrapper |
| **Schematron-style "explain" mode** | For each failed rule, show the offending row and the dict reference | M | H | L | Mostly UX — already most of the data is in the diagnostic |
| **Rule-pack authoring UI** | Visual builder (we have a "kind-aware visual builder" already) — extend to BGS/NH packs | M | H | L | Existing infra, just more content |

### 3. Geotechnical Analysis

The current analytical surface is CPT analysis, TPS surfaces, voxel inference,
strip logs, and quality grading. Plenty of room here, and it differentiates
GeoFlow from "just a validator".

| Alternative | What it is | Leverage | Fit | Effort | Notes |
|---|---|---|---|---|---|
| **Soil parameter correlations** | SPT N → φ′, su, E; CPT qc → Dr, su, OCR (Robertson, Lunne) | H | H | M | Lives on existing CPT/ISPT data; one panel per correlation |
| **Liquefaction triggering** | Boulanger & Idriss 2014, Robertson 2009 (CPT) | M | H | M | Highly visible; needs Vs30 input or correlation |
| **USCS / BS5930 / EN-ISO 14688 classification** | Auto-classify from PSD + Atterberg | H | H | M | We already parse descriptions; close the loop |
| **Atterberg / plasticity chart** | Plot LLPL on Casagrande chart | H | H | L | Pure plotting on existing LLPL data |
| **PSD curve / sieve plot** | Particle size distribution plot per sample | H | H | L | Same — existing data, missing visual |
| **Bearing capacity / settlement calculators** | Quick estimates from strata + parameters | M | M | M | Risky territory (design tool) — keep as estimates with disclaimer |
| **Slope stability (Bishop / Janbu)** | Limit-equilibrium on layered profile | L | L | H | Heavy, separate from interchange focus |
| **Mohr-Coulomb fits / triaxial interp** | Lab test interpretation | M | M | M | Real, niche; depends on which lab groups we cover natively |
| **Groundwater time-series analyser** | WSTK/MOND analysis: trends, seasonality | M | H | M | Underused AGS data; nice with existing voxel/3D context |

### 4. Visualisation

| Alternative | What it is | Leverage | Fit | Effort | Notes |
|---|---|---|---|---|---|
| **Fence diagrams** | Connected multi-borehole sections along a polyline | H | H | M | We already render single sections; fence is a polyline of them |
| **Stereonets** | Joint set / discontinuity orientation plots | L | M | M | Niche (rock mech); good if we add a DISC/FRAC parser |
| **Contour overlays** | Groundwater surface, rockhead contours on map tab | M | H | M | We have surfaces — render contours on Leaflet |
| **Time-series monitoring** | Animated MOND/PREM/PRTM data over time | M | H | M | Different from current static rendering |
| **3D globe view (Cesium)** | Geographic context with real terrain | L | L | H | Big bundle; current Leaflet is fine for most |
| **BGS Onshore Geology tile overlay** | Authoritative geology underlay on map | M | H | L | Just a tile layer; UK-only |
| **Print/share permalinks** | URL state for a configured view | M | H | L | Hash-routing pattern; the web app partly has this |

### 5. Integrations & APIs

| Alternative | What it is | Leverage | Fit | Effort | Notes |
|---|---|---|---|---|---|
| **MCP server** | Expose GeoFlow as an MCP tool for Claude / AI agents | M | H | M | "Validate this AGS", "what's in this borehole" — natural fit |
| **REST/HTTP wrapper** | Containerised validator endpoint | M | M | M | The CLI does this offline; some users want a service |
| **HoleBASE SI / gINT export** | Industry-standard geotechnical DB exports | H | M | H | Closed formats; reverse-engineering risk; high payoff if done |
| **Plaxis / FLAC profile export** | Strata + parameters to FE software | M | M | M | We have the strata; needs material-property mapping |
| **BGS Geology Lexicon API** | Validate GEOL_LEG against authoritative codes | M | H | L | Public API; cache locally; aligns with rule packs |
| **OGC SensorThings API** | Pull live monitoring data | L | L | H | Speculative |
| **National Geotechnical Database pull** | Fetch publicly-available AGS files | M | H | M | Demoability + content for the explorer |

### 6. AI / ML

We already use the `describe` parser for soil/rock descriptions; LLMs could
either replace or augment specific steps.

| Alternative | What it is | Leverage | Fit | Effort | Notes |
|---|---|---|---|---|---|
| **LLM-assisted description parser** | Fallback when the deterministic parser can't extract structured info | M | H | M | Keep deterministic primary, LLM secondary, always show source |
| **Auto-suggest GEOL_LEG** | From description → lexicon code | M | H | M | Pairs with BGS lexicon integration |
| **Anomaly detection on lab data** | Flag suspicious values per group/sample | M | M | M | Statistical, not LLM; useful in the quality grader |
| **Stratigraphic correlation hints** | Suggest layer correlations across boreholes | M | M | H | High-judgement; do not auto-apply |
| **Natural-language project query** | "Show me all peat layers within 100 m of the river" — over the ontology | H | H | M | Leverages the Layer-2 model in spec/006 and an MCP/JEXL bridge |

### 7. Project & Workflow

| Alternative | What it is | Leverage | Fit | Effort | Notes |
|---|---|---|---|---|---|
| **Project share/export bundle** | Zip of .ags + rules + report + 3D model | H | H | L | Currently storage is local-only; export = portable deliverable |
| **Multi-user sync (CRDT/Yjs)** | Real-time collab over the existing commit chain | L | L | H | Big undertaking, niche; skip unless asked |
| **PWA / offline install** | The web app is already self-contained | M | H | L | Add manifest + service worker |
| **Field entry mode** | Mobile-first form to add LOCA/SAMP rows | L | M | H | Different app shape; defer |

## Recommended Roadmap

Ordered by leverage-per-unit-effort, not by category.

**Tier 1 — finish the AGS story (close known gaps first)**
1. AGS 4.1.1 / 4.2 dict + version strings (already scoped in spec/005).
2. BGS rule pack (`rules/specs/bgs/`) — biggest UK user base.
3. Custom `--dict` flag.
4. GeoJSON + CSV export buttons.

**Tier 2 — earn the "geotech" in GeoFlow**
5. Atterberg/Casagrande chart and PSD curve plots — pure wins on existing data.
6. USCS / BS5930 classification tied back to the description parser.
7. SPT / CPT parameter correlations panel.
8. Fence diagrams (chain of cross-sections along a polyline).

**Tier 3 — unlock new audiences**
9. **AGSi support** — interpretive ground model in *and* out. Biggest strategic
   add; pairs directly with the Layer-2 canonical model.
10. GEF/CPT-GEF reader (and CPT XML if the parser shape allows).
11. PDF report (headless-Chrome render of the existing HTML explorer is the
    cheap path).
12. MCP server exposing `validate` / `info` / `query` over the project model.

**Tier 4 — investigate before committing**
- LLM-assisted description parser (need a privacy story for in-browser use).
- HoleBASE SI / gINT export (need a real user pulling for it).
- Liquefaction / bearing-capacity calculators (need disclaimer + a domain
  reviewer; high blast-radius if wrong).

## Out of Scope (For Now)

- Slope stability solver — outside interchange/QA focus, large surface area.
- Real-time multi-user collaboration — disproportionate effort.
- Native mobile apps — PWA covers 80%.
- Cesium / 3D globe — current Leaflet + Three.js is sufficient.

## Open Questions

1. Is AGSi a strategic priority? If yes, it should jump to Tier 1.
2. Do we want a hosted endpoint (REST/MCP) or stay fully client-side?
3. Which regional packs do we commit to maintaining (UK BGS, NH_GDMS, AU, NZ)?
4. Is there appetite for a closed-format integration (HoleBASE SI / gINT)?
   That's the largest single-feature investment on this list.
