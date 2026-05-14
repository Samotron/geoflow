export interface PresetQuery {
  label: string;
  category: string;
  description: string;
  sql: string;
}

export const PRESET_QUERIES: PresetQuery[] = [
  {
    label: 'Borehole summary',
    category: 'Locations',
    description: 'All boreholes with coordinates and final depth',
    sql: `SELECT
  LOCA_ID,
  LOCA_TYPE,
  LOCA_NATE  AS easting,
  LOCA_NATN  AS northing,
  LOCA_LAT   AS latitude,
  LOCA_LON   AS longitude,
  LOCA_FDEP  AS final_depth_m
FROM loca
ORDER BY LOCA_ID;`,
  },
  {
    label: 'Deepest boreholes',
    category: 'Locations',
    description: 'Top 20 boreholes ranked by final depth',
    sql: `SELECT
  LOCA_ID,
  CAST(LOCA_FDEP AS DOUBLE) AS final_depth_m,
  LOCA_TYPE
FROM loca
WHERE LOCA_FDEP IS NOT NULL
ORDER BY final_depth_m DESC
LIMIT 20;`,
  },
  {
    label: 'Missing coordinates',
    category: 'Locations',
    description: 'Boreholes that have no usable coordinates',
    sql: `SELECT LOCA_ID, LOCA_TYPE, LOCA_FDEP
FROM loca
WHERE (LOCA_LAT  IS NULL OR LOCA_LAT  = '')
  AND (LOCA_LON  IS NULL OR LOCA_LON  = '')
  AND (LOCA_NATE IS NULL OR LOCA_NATE = '')
  AND (LOCA_NATN IS NULL OR LOCA_NATN = '')
ORDER BY LOCA_ID;`,
  },
  {
    label: 'Soil profile',
    category: 'Geology',
    description: 'GEOL stratigraphy intervals for all boreholes',
    sql: `SELECT
  g.LOCA_ID,
  CAST(g.GEOL_TOP  AS DOUBLE) AS top_m,
  CAST(g.GEOL_BASE AS DOUBLE) AS base_m,
  CAST(g.GEOL_BASE AS DOUBLE) - CAST(g.GEOL_TOP AS DOUBLE) AS thickness_m,
  g.GEOL_GEOL  AS geology_code,
  g.GEOL_DESC  AS description,
  g.GEOL_LEG   AS legend_code
FROM geol g
ORDER BY g.LOCA_ID, top_m;`,
  },
  {
    label: 'SPT results',
    category: 'In-situ tests',
    description: 'SPT N-values with depth for all boreholes',
    sql: `SELECT
  i.LOCA_ID,
  CAST(i.ISPT_TOP  AS DOUBLE) AS depth_m,
  CAST(i.ISPT_NVAL AS DOUBLE) AS N_value,
  i.ISPT_REP AS remarks
FROM ispt i
ORDER BY i.LOCA_ID, depth_m;`,
  },
  {
    label: 'SPT statistics by borehole',
    category: 'In-situ tests',
    description: 'Min / mean / max SPT N per borehole',
    sql: `SELECT
  LOCA_ID,
  COUNT(*)                           AS test_count,
  MIN(CAST(ISPT_NVAL AS DOUBLE))     AS n_min,
  ROUND(AVG(CAST(ISPT_NVAL AS DOUBLE)), 1) AS n_mean,
  MAX(CAST(ISPT_NVAL AS DOUBLE))     AS n_max,
  MIN(CAST(ISPT_TOP  AS DOUBLE))     AS shallowest_m,
  MAX(CAST(ISPT_TOP  AS DOUBLE))     AS deepest_m
FROM ispt
WHERE ISPT_NVAL IS NOT NULL
GROUP BY LOCA_ID
ORDER BY n_mean DESC;`,
  },
  {
    label: 'Sample inventory',
    category: 'Samples',
    description: 'Count of samples by type and borehole',
    sql: `SELECT
  LOCA_ID,
  SAMP_TYPE,
  COUNT(*) AS count,
  MIN(CAST(SAMP_TOP AS DOUBLE)) AS shallowest_m,
  MAX(CAST(SAMP_TOP AS DOUBLE)) AS deepest_m
FROM samp
GROUP BY LOCA_ID, SAMP_TYPE
ORDER BY LOCA_ID, count DESC;`,
  },
  {
    label: 'Atterberg limits',
    category: 'Lab tests',
    description: 'Liquid limit, plastic limit and plasticity index',
    sql: `SELECT
  l.LOCA_ID,
  l.SAMP_ID,
  CAST(l.LLPL_LL AS DOUBLE) AS liquid_limit,
  CAST(l.LLPL_PL AS DOUBLE) AS plastic_limit,
  CAST(l.LLPL_PI AS DOUBLE) AS plasticity_index,
  CAST(l.LLPL_425 AS DOUBLE) AS fines_pct
FROM llpl l
ORDER BY l.LOCA_ID, l.SAMP_ID;`,
  },
  {
    label: 'Lab test coverage',
    category: 'Lab tests',
    description: 'Which boreholes have which lab tests',
    sql: `SELECT
  l.LOCA_ID,
  COUNT(DISTINCT s.SAMP_ID)            AS samples,
  SUM(CASE WHEN ll.LOCA_ID IS NOT NULL THEN 1 ELSE 0 END) AS atterberg,
  SUM(CASE WHEN ld.LOCA_ID IS NOT NULL THEN 1 ELSE 0 END) AS bulk_density,
  SUM(CASE WHEN lp.LOCA_ID IS NOT NULL THEN 1 ELSE 0 END) AS particle_density,
  SUM(CASE WHEN lc.LOCA_ID IS NOT NULL THEN 1 ELSE 0 END) AS consolidation
FROM loca l
LEFT JOIN samp  s  ON s.LOCA_ID  = l.LOCA_ID
LEFT JOIN llpl  ll ON ll.LOCA_ID = l.LOCA_ID
LEFT JOIN lden  ld ON ld.LOCA_ID = l.LOCA_ID
LEFT JOIN lpdn  lp ON lp.LOCA_ID = l.LOCA_ID
LEFT JOIN lcon  lc ON lc.LOCA_ID = l.LOCA_ID
GROUP BY l.LOCA_ID
ORDER BY samples DESC;`,
  },
  {
    label: 'Geology gap check',
    category: 'QA',
    description: 'Flag gaps between consecutive GEOL intervals (>0.05 m)',
    sql: `WITH ordered AS (
  SELECT
    LOCA_ID,
    CAST(GEOL_TOP  AS DOUBLE) AS top_m,
    CAST(GEOL_BASE AS DOUBLE) AS base_m,
    GEOL_GEOL,
    LAG(CAST(GEOL_BASE AS DOUBLE)) OVER (
      PARTITION BY LOCA_ID ORDER BY CAST(GEOL_TOP AS DOUBLE)
    ) AS prev_base
  FROM geol
)
SELECT
  LOCA_ID,
  prev_base   AS gap_from_m,
  top_m       AS gap_to_m,
  top_m - prev_base AS gap_m,
  GEOL_GEOL   AS next_geology
FROM ordered
WHERE prev_base IS NOT NULL
  AND top_m - prev_base > 0.05
ORDER BY gap_m DESC;`,
  },
  {
    label: 'FDEP vs deepest data',
    category: 'QA',
    description: 'Boreholes where recorded data exceeds the stated final depth',
    sql: `WITH deepest AS (
  SELECT LOCA_ID, MAX(CAST(GEOL_BASE AS DOUBLE)) AS max_depth
  FROM geol
  WHERE GEOL_BASE IS NOT NULL
  GROUP BY LOCA_ID
)
SELECT
  l.LOCA_ID,
  CAST(l.LOCA_FDEP AS DOUBLE) AS final_depth_m,
  d.max_depth                 AS deepest_geol_m,
  d.max_depth - CAST(l.LOCA_FDEP AS DOUBLE) AS overshoot_m
FROM loca l
JOIN deepest d ON d.LOCA_ID = l.LOCA_ID
WHERE CAST(l.LOCA_FDEP AS DOUBLE) IS NOT NULL
  AND d.max_depth > CAST(l.LOCA_FDEP AS DOUBLE) + 0.1
ORDER BY overshoot_m DESC;`,
  },
  {
    label: 'All tables and row counts',
    category: 'Schema',
    description: 'Quick overview of every loaded table',
    sql: `SELECT table_name, estimated_size AS row_count
FROM duckdb_tables()
WHERE schema_name = 'main'
ORDER BY table_name;`,
  },
];
