import type { Pipeline, PipelineEdge, PipelineNode } from '@geoflow/transform';

export interface PipelineExample {
  id: string;
  name: string;
  description: string;
  requiresFile: boolean;
  build: () => Pipeline;
}

function pos(x: number, y: number): { x: number; y: number } {
  return { x, y };
}

function makePipeline(name: string, nodes: PipelineNode[], edges: PipelineEdge[]): Pipeline {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    projectId: null,
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
  };
}

// ── 1. Borehole depth summary ───────────────────────────────────────────────

function boreholeDepthSummary(): Pipeline {
  const loca: PipelineNode = {
    id: 'src_loca', kind: 'source', name: 'loca_src', table: 'loca', position: pos(80, 80),
  };
  const geol: PipelineNode = {
    id: 'src_geol', kind: 'source', name: 'geol_src', table: 'geol', position: pos(80, 240),
  };
  const summary: PipelineNode = {
    id: 'sql_summary', kind: 'sql', name: 'borehole_summary',
    materialization: 'view', position: pos(380, 160),
    sql: `-- One row per borehole with depth + formation stats.
SELECT
  l.LOCA_ID                             AS borehole,
  l.LOCA_GL::DOUBLE                     AS ground_level_m,
  l.LOCA_FDEP::DOUBLE                   AS final_depth_m,
  COUNT(g.LOCA_ID)                      AS strata_count,
  COUNT(DISTINCT g.GEOL_GEOL)           AS formation_count,
  MAX(g.GEOL_BASE::DOUBLE)              AS deepest_logged_m
FROM {{ ref('loca_src') }} l
LEFT JOIN {{ ref('geol_src') }} g USING (LOCA_ID)
GROUP BY l.LOCA_ID, l.LOCA_GL, l.LOCA_FDEP
ORDER BY final_depth_m DESC NULLS LAST`,
  };
  const out: PipelineNode = {
    id: 'out_summary', kind: 'output', name: 'summary_out',
    format: 'csv', rowLimit: 1000, position: pos(720, 160),
  };
  return makePipeline('Borehole depth summary', [loca, geol, summary, out], [
    { id: 'e1', source: 'src_loca', target: 'sql_summary' },
    { id: 'e2', source: 'src_geol', target: 'sql_summary' },
    { id: 'e3', source: 'sql_summary', target: 'out_summary' },
  ]);
}

// ── 2. Sample catalog with formation context ────────────────────────────────

function sampleCatalog(): Pipeline {
  const loca: PipelineNode = {
    id: 'src_loca', kind: 'source', name: 'loca_src', table: 'loca', position: pos(80, 60),
  };
  const samp: PipelineNode = {
    id: 'src_samp', kind: 'source', name: 'samp_src', table: 'samp', position: pos(80, 200),
  };
  const geol: PipelineNode = {
    id: 'src_geol', kind: 'source', name: 'geol_src', table: 'geol', position: pos(80, 340),
  };
  const samples: PipelineNode = {
    id: 'sql_samples', kind: 'sql', name: 'samples_with_formation',
    materialization: 'view', position: pos(420, 200),
    sql: `-- Each sample annotated with the formation it sits inside.
SELECT
  s.LOCA_ID,
  s.SAMP_REF,
  s.SAMP_TYPE,
  s.SAMP_TOP::DOUBLE  AS sample_top_m,
  s.SAMP_BASE::DOUBLE AS sample_base_m,
  g.GEOL_GEOL         AS formation,
  g.GEOL_DESC         AS description
FROM {{ ref('samp_src') }} s
LEFT JOIN {{ ref('geol_src') }} g
  ON g.LOCA_ID = s.LOCA_ID
 AND s.SAMP_TOP::DOUBLE BETWEEN g.GEOL_TOP::DOUBLE AND g.GEOL_BASE::DOUBLE
ORDER BY s.LOCA_ID, sample_top_m`,
  };
  const flagged: PipelineNode = {
    id: 'sql_unmatched', kind: 'sql', name: 'samples_without_formation',
    materialization: 'view', position: pos(420, 360),
    sql: `-- QA: which samples couldn't be placed in a formation?
SELECT *
FROM {{ ref('samples_with_formation') }}
WHERE formation IS NULL`,
  };
  const out: PipelineNode = {
    id: 'out_cat', kind: 'output', name: 'catalog_out',
    format: 'csv', rowLimit: 5000, position: pos(740, 200),
  };
  const outQa: PipelineNode = {
    id: 'out_qa', kind: 'output', name: 'qa_unmatched',
    format: 'preview', rowLimit: 500, position: pos(740, 360),
  };
  return makePipeline('Sample catalog with formation', [loca, samp, geol, samples, flagged, out, outQa], [
    { id: 'e1', source: 'src_loca', target: 'sql_samples' },
    { id: 'e2', source: 'src_samp', target: 'sql_samples' },
    { id: 'e3', source: 'src_geol', target: 'sql_samples' },
    { id: 'e4', source: 'sql_samples', target: 'sql_unmatched' },
    { id: 'e5', source: 'sql_samples', target: 'out_cat' },
    { id: 'e6', source: 'sql_unmatched', target: 'out_qa' },
  ]);
}

// ── 3. Spatial: locations to GeoJSON ────────────────────────────────────────

function locationsToGeoJSON(): Pipeline {
  const loca: PipelineNode = {
    id: 'src_loca', kind: 'source', name: 'loca_src', table: 'loca', position: pos(80, 120),
  };
  const geom: PipelineNode = {
    id: 'sql_geom', kind: 'sql', name: 'locations_geom',
    materialization: 'view', position: pos(380, 120),
    sql: `-- Build geometries and a metric bounding box from LOCA easting/northing.
-- Requires the spatial extension (autoloaded on engine init).
SELECT
  LOCA_ID,
  LOCA_NATE::DOUBLE                                AS easting,
  LOCA_NATN::DOUBLE                                AS northing,
  LOCA_GL::DOUBLE                                  AS ground_level_m,
  ST_Point(LOCA_NATE::DOUBLE, LOCA_NATN::DOUBLE)   AS geom,
  ST_AsGeoJSON(
    ST_Point(LOCA_NATE::DOUBLE, LOCA_NATN::DOUBLE)
  )                                                AS geom_geojson
FROM {{ ref('loca_src') }}
WHERE LOCA_NATE IS NOT NULL AND LOCA_NATN IS NOT NULL`,
  };
  const stats: PipelineNode = {
    id: 'sql_stats', kind: 'sql', name: 'site_extent',
    materialization: 'view', position: pos(680, 260),
    sql: `-- Site-wide extent for map framing.
SELECT
  COUNT(*)                AS n_locations,
  MIN(easting)            AS x_min,
  MAX(easting)            AS x_max,
  MIN(northing)           AS y_min,
  MAX(northing)           AS y_max,
  AVG(easting)            AS x_centroid,
  AVG(northing)           AS y_centroid
FROM {{ ref('locations_geom') }}`,
  };
  const outFeatures: PipelineNode = {
    id: 'out_geojson', kind: 'output', name: 'locations_geojson',
    format: 'geojson', rowLimit: 5000, position: pos(680, 120),
  };
  const outStats: PipelineNode = {
    id: 'out_stats', kind: 'output', name: 'extent_preview',
    format: 'preview', rowLimit: 1, position: pos(980, 260),
  };
  return makePipeline('Locations → GeoJSON + extent', [loca, geom, stats, outFeatures, outStats], [
    { id: 'e1', source: 'src_loca', target: 'sql_geom' },
    { id: 'e2', source: 'sql_geom', target: 'sql_stats' },
    { id: 'e3', source: 'sql_geom', target: 'out_geojson' },
    { id: 'e4', source: 'sql_stats', target: 'out_stats' },
  ]);
}

// ── 4. Seed-driven enrichment ───────────────────────────────────────────────

function seedEnrichment(): Pipeline {
  const loca: PipelineNode = {
    id: 'src_loca', kind: 'source', name: 'loca_src', table: 'loca', position: pos(80, 60),
  };
  const seed: PipelineNode = {
    id: 'seed_categories', kind: 'seed', name: 'borehole_priority',
    format: 'csv', position: pos(80, 220),
    content: `LOCA_ID,priority,owner
BH01,high,Alice
BH02,medium,Bob
BH03,low,Alice
BH04,high,Carla
`,
  };
  const enriched: PipelineNode = {
    id: 'sql_enriched', kind: 'sql', name: 'loca_enriched',
    materialization: 'view', position: pos(420, 140),
    sql: `-- Join LOCA with an externally-supplied priority seed.
SELECT
  l.LOCA_ID,
  l.LOCA_GL::DOUBLE  AS ground_level_m,
  l.LOCA_FDEP::DOUBLE AS final_depth_m,
  s.priority,
  s.owner
FROM {{ ref('loca_src') }} l
LEFT JOIN {{ ref('borehole_priority') }} s USING (LOCA_ID)
ORDER BY l.LOCA_ID`,
  };
  const out: PipelineNode = {
    id: 'out_enriched', kind: 'output', name: 'enriched_csv',
    format: 'csv', rowLimit: 5000, position: pos(740, 140),
  };
  return makePipeline('Seed-driven enrichment', [loca, seed, enriched, out], [
    { id: 'e1', source: 'src_loca', target: 'sql_enriched' },
    { id: 'e2', source: 'seed_categories', target: 'sql_enriched' },
    { id: 'e3', source: 'sql_enriched', target: 'out_enriched' },
  ]);
}

// ── 5. Cross-file comparison via two whole-file nodes ───────────────────────

function crossFileComparison(): Pipeline {
  const fileA: PipelineNode = {
    id: 'file_a', kind: 'file', name: 'siteA', format: 'ags',
    fileName: '', content: '', groups: [], position: pos(80, 80),
  };
  const fileB: PipelineNode = {
    id: 'file_b', kind: 'file', name: 'siteB', format: 'ags',
    fileName: '', content: '', groups: [], position: pos(80, 260),
  };
  const compare: PipelineNode = {
    id: 'sql_compare', kind: 'sql', name: 'shared_holes',
    materialization: 'view', position: pos(420, 170),
    sql: `-- Compare ground level and final depth across two AGS files.
-- Load an AGS file into each File node first; relations are exposed
-- as siteA_loca, siteB_loca, etc.
SELECT
  a.LOCA_ID,
  a.LOCA_GL::DOUBLE   AS gl_A,
  b.LOCA_GL::DOUBLE   AS gl_B,
  a.LOCA_FDEP::DOUBLE AS depth_A,
  b.LOCA_FDEP::DOUBLE AS depth_B,
  (a.LOCA_GL::DOUBLE - b.LOCA_GL::DOUBLE)     AS gl_delta_m,
  (a.LOCA_FDEP::DOUBLE - b.LOCA_FDEP::DOUBLE) AS depth_delta_m
FROM {{ ref('siteA_loca') }} a
INNER JOIN {{ ref('siteB_loca') }} b USING (LOCA_ID)`,
  };
  const out: PipelineNode = {
    id: 'out_cmp', kind: 'output', name: 'comparison_csv',
    format: 'csv', rowLimit: 5000, position: pos(740, 170),
  };
  return makePipeline('Cross-file LOCA comparison', [fileA, fileB, compare, out], [
    { id: 'e1', source: 'file_a', target: 'sql_compare' },
    { id: 'e2', source: 'file_b', target: 'sql_compare' },
    { id: 'e3', source: 'sql_compare', target: 'out_cmp' },
  ]);
}

export const EXAMPLES: PipelineExample[] = [
  {
    id: 'borehole-depth-summary',
    name: 'Borehole depth summary',
    description: 'LOCA + GEOL → one row per borehole with depth and formation counts.',
    requiresFile: true,
    build: boreholeDepthSummary,
  },
  {
    id: 'sample-catalog',
    name: 'Sample catalog with formation',
    description: 'Place each SAMP entry inside the GEOL stratum it falls within; flag misses.',
    requiresFile: true,
    build: sampleCatalog,
  },
  {
    id: 'locations-geojson',
    name: 'Locations → GeoJSON + extent',
    description: 'Build ST_Point geometries from LOCA and emit GeoJSON + site extent.',
    requiresFile: true,
    build: locationsToGeoJSON,
  },
  {
    id: 'seed-enrichment',
    name: 'Seed-driven enrichment',
    description: 'Join LOCA against an inline CSV seed of priorities/owners.',
    requiresFile: true,
    build: seedEnrichment,
  },
  {
    id: 'cross-file-comparison',
    name: 'Cross-file LOCA comparison',
    description: 'Two whole-file nodes joined on LOCA_ID to surface depth/GL deltas.',
    requiresFile: false,
    build: crossFileComparison,
  },
];
