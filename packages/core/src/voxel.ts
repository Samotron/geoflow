/**
 * voxel.ts — geostatistical voxel grid interpolation from borehole data.
 *
 * Discovers interpolatable properties from any depth-referenced AGS group
 * (GEOL, ISPT, LNMC, TRIG, SAMP, etc.) and fills a 3-D voxel grid using
 * inverse-distance weighting (IDW) from borehole observations.
 */

import type { AgsFile, AgsType } from './model.js';
import type { Geo3DModel } from './geo3d.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface VoxelProperty {
  id: string;               // field name — e.g. 'ISPT_NVAL', 'GEOL_LEG'
  label: string;            // display label
  type: 'numeric' | 'categorical';
  group: string;            // AGS group name
  valueField: string;       // the heading whose values are interpolated
  depthTopField: string;    // depth at top of interval / point depth
  depthBaseField: string | null;  // null = point data
  unit: string;
}

export interface VoxelCell {
  ix: number; iy: number; iz: number;  // grid indices
  cx: number; cy: number; cz: number;  // cell centre (local coords; cz = elevation m OD)
  value: number | null;                // numeric fields
  category: string | null;            // categorical fields
  confidence: number;                  // 0–1: fraction of site boreholes contributing
}

export interface VoxelGrid {
  property: VoxelProperty;
  nx: number; ny: number; nz: number;
  cellSize: { dx: number; dy: number; dz: number };
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number };
  cells: VoxelCell[];             // only populated (non-null) cells
  numericRange: [number, number]; // [min, max] of populated numeric cells
  categories: string[];           // sorted unique category values
  centroid: { x: number; y: number }; // absolute centroid for export
}

// ── Type helpers ──────────────────────────────────────────────────────────────

function isNumericDt(dt: AgsType): boolean {
  if (typeof dt === 'object') return dt._tag === 'DP' || dt._tag === 'SF' || dt._tag === 'SCI';
  return dt === 'MC';
}

function isCatDt(dt: AgsType): boolean {
  return dt === 'PA';
}

// ── Depth field discovery ─────────────────────────────────────────────────────

// Suffixes that indicate a depth field in an AGS group
const DEPTH_SUFFIXES = ['_TOP', '_DPTH', '_DEPT', '_DEP', '_RDEP', '_DEPTH'];

// Suffixes to skip when looking for value fields (metadata / depth / keys)
const SKIP_SUFFIXES  = [
  '_TOP', '_BASE', '_DPTH', '_DEPT', '_DEP', '_RDEP', '_DEPTH',
  '_TESN', '_REF', '_REM', '_EN', '_RTYP', '_METH', '_CRED',
  '_CONT', '_SAMP', '_ID', '_NCHK', '_CANC',
];

// ── Property discovery ────────────────────────────────────────────────────────

/**
 * Scan every AGS group and return a list of properties that can be
 * interpolated onto a voxel grid.  A group qualifies if it has:
 *   - a LOCA_ID field (borehole-linked)
 *   - a depth field ({GROUP}_TOP, {GROUP}_DPTH, etc.)
 *   - at least one numeric (DP/SF/SCI/MC) or categorical (PA) value field
 */
export function discoverVoxelProperties(file: AgsFile): VoxelProperty[] {
  const props: VoxelProperty[] = [];

  for (const [groupName, group] of Object.entries(file.groups)) {
    const headingNames = group.headings.map(h => h.name);

    if (!headingNames.includes('LOCA_ID')) continue;
    if (group.rows.length === 0) continue;

    // Find the primary depth field for this group
    const topField = DEPTH_SUFFIXES
      .map(s => groupName + s)
      .find(f => headingNames.includes(f));
    if (!topField) continue;

    const baseField = headingNames.includes(`${groupName}_BASE`)
      ? `${groupName}_BASE`
      : null;

    for (const heading of group.headings) {
      const name = heading.name;
      if (name === 'LOCA_ID') continue;
      if (SKIP_SUFFIXES.some(s => name.endsWith(s))) continue;

      const dt = heading.data_type;
      const unit = heading.unit ?? '';

      if (isNumericDt(dt)) {
        // Require at least one parseable non-empty value
        const hasData = group.rows.some(r => {
          const v = r[name];
          return v != null && v !== '' && !isNaN(parseFloat(String(v)));
        });
        if (!hasData) continue;

        props.push({
          id: name,
          label: name.replace(/_/g, ' '),
          type: 'numeric',
          group: groupName,
          valueField: name,
          depthTopField: topField,
          depthBaseField: baseField,
          unit,
        });
      } else if (isCatDt(dt)) {
        const vals = new Set(
          group.rows.map(r => String(r[name] ?? '').trim()).filter(v => v !== ''),
        );
        if (vals.size < 2) continue;

        props.push({
          id: name,
          label: name.replace(/_/g, ' '),
          type: 'categorical',
          group: groupName,
          valueField: name,
          depthTopField: topField,
          depthBaseField: baseField,
          unit: '',
        });
      }
    }
  }

  return props;
}

// ── Voxel grid builder ────────────────────────────────────────────────────────

/**
 * Fill a 3-D voxel grid for a single property using IDW interpolation.
 *
 * For each voxel cell (cx, cy, cz):
 *   - cz is elevation (m OD); depth_in_borehole = bh.elev − cz
 *   - Any observation whose depth interval overlaps the cell depth is a
 *     candidate; weighted by 1/distance (IDW power = 1)
 *   - Numeric:      weighted average across contributing boreholes
 *   - Categorical:  value from nearest contributing borehole
 */
export function buildVoxelGrid(
  file: AgsFile,
  model: Geo3DModel,
  prop: VoxelProperty,
  opts: { nx?: number; ny?: number; nz?: number } = {},
): VoxelGrid {
  const nx = Math.max(2, opts.nx ?? 20);
  const ny = Math.max(2, opts.ny ?? 20);
  const nz = Math.max(2, opts.nz ?? 20);

  const { bounds, boreholes, centroid } = model;
  const { xMin, xMax, yMin, yMax, zMin, zMax } = bounds;
  const dx = (xMax - xMin) / nx;
  const dy = (yMax - yMin) / ny;
  const dz = (zMax - zMin) / nz;

  const empty: VoxelGrid = {
    property: prop, nx, ny, nz,
    cellSize: { dx, dy, dz }, bounds, cells: [],
    numericRange: [0, 1], categories: [], centroid,
  };

  const group = file.groups[prop.group];
  if (!group || group.rows.length === 0) return empty;

  // ── Extract per-borehole observations ──────────────────────────────────────

  interface Obs { depthTop: number; depthBase: number; numVal: number | null; catVal: string | null; }
  const bhObs = new Map<string, Obs[]>();

  for (const row of group.rows) {
    const locaId = String(row['LOCA_ID'] ?? '').trim();
    if (!locaId) continue;

    const topRaw = parseFloat(String(row[prop.depthTopField] ?? ''));
    if (isNaN(topRaw)) continue;

    let depthBase = topRaw;
    if (prop.depthBaseField) {
      const b = parseFloat(String(row[prop.depthBaseField] ?? ''));
      if (!isNaN(b)) depthBase = b;
    }

    const raw = row[prop.valueField];
    let numVal: number | null = null;
    let catVal: string | null = null;
    if (raw != null && raw !== '') {
      if (prop.type === 'numeric') {
        const n = parseFloat(String(raw));
        if (!isNaN(n)) numVal = n;
      } else {
        const s = String(raw).trim();
        if (s) catVal = s;
      }
    }
    if (numVal === null && catVal === null) continue;

    if (!bhObs.has(locaId)) bhObs.set(locaId, []);
    bhObs.get(locaId)!.push({ depthTop: topRaw, depthBase, numVal, catVal });
  }

  if (bhObs.size === 0) return empty;

  const bhByLoca = new Map(boreholes.map(bh => [bh.id, bh]));
  const nBh = Math.max(1, boreholes.length);
  const halfDz = dz * 0.55; // slight overlap tolerance at cell boundaries

  const cells: VoxelCell[] = [];
  let numMin = Infinity;
  let numMax = -Infinity;
  const catSet = new Set<string>();

  // ── Fill grid ──────────────────────────────────────────────────────────────

  for (let iz = 0; iz < nz; iz++) {
    const cz = zMin + (iz + 0.5) * dz;
    for (let iy = 0; iy < ny; iy++) {
      const cy = yMin + (iy + 0.5) * dy;
      for (let ix = 0; ix < nx; ix++) {
        const cx = xMin + (ix + 0.5) * dx;

        let wSum = 0;
        let vSum = 0;
        let nearestCat: string | null = null;
        let nearestD = Infinity;
        let nContrib = 0;

        for (const [locaId, obs] of bhObs) {
          const bh = bhByLoca.get(locaId);
          if (!bh) continue;

          const depthInBh = bh.elev - cz;

          // Find first observation whose depth range covers this voxel
          let matched: Obs | null = null;
          for (const o of obs) {
            const effBase = prop.depthBaseField ? o.depthBase : o.depthTop + halfDz;
            if (depthInBh >= o.depthTop - halfDz && depthInBh <= effBase + halfDz) {
              matched = o; break;
            }
          }
          if (!matched) continue;

          const ddx = bh.x - cx;
          const ddy = bh.y - cy;
          const dh = Math.sqrt(ddx * ddx + ddy * ddy);
          nContrib++;

          if (prop.type === 'numeric' && matched.numVal !== null) {
            const w = 1.0 / Math.max(dh, 1.0); // IDW power 1
            wSum += w;
            vSum += w * matched.numVal;
          } else if (matched.catVal !== null) {
            if (dh < nearestD) { nearestD = dh; nearestCat = matched.catVal; }
            wSum = 1;
          }
        }

        if (wSum === 0) continue;

        const confidence = Math.min(1, nContrib / nBh);

        if (prop.type === 'numeric') {
          const val = vSum / wSum;
          if (val < numMin) numMin = val;
          if (val > numMax) numMax = val;
          cells.push({ ix, iy, iz, cx, cy, cz, value: val, category: null, confidence });
        } else {
          if (nearestCat) catSet.add(nearestCat);
          cells.push({ ix, iy, iz, cx, cy, cz, value: null, category: nearestCat, confidence });
        }
      }
    }
  }

  return {
    property: prop, nx, ny, nz,
    cellSize: { dx, dy, dz }, bounds, cells,
    numericRange: numMin <= numMax ? [numMin, numMax] : [0, 1],
    categories: [...catSet].sort(),
    centroid,
  };
}

// ── CSV export ────────────────────────────────────────────────────────────────

/**
 * Serialise the voxel grid as a CSV string.
 * Absolute easting/northing are reconstructed from the model centroid.
 */
export function voxelGridToCsv(grid: VoxelGrid): string {
  const { property, centroid, cells } = grid;
  const valCol = property.id + (property.unit ? `_${property.unit}` : '');

  const header = [
    'easting_m', 'northing_m', 'z_elev_m_od',
    'x_local_m', 'y_local_m',
    'ix', 'iy', 'iz',
    valCol, 'confidence',
  ].join(',');

  const rows = cells.map(c => {
    const val = property.type === 'numeric'
      ? (c.value?.toFixed(3) ?? '')
      : (c.category ?? '');
    return [
      (c.cx + centroid.x).toFixed(2),
      (c.cy + centroid.y).toFixed(2),
      c.cz.toFixed(2),
      c.cx.toFixed(2),
      c.cy.toFixed(2),
      c.ix, c.iy, c.iz,
      val,
      c.confidence.toFixed(3),
    ].join(',');
  });

  return [header, ...rows].join('\n');
}
