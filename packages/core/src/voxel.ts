/**
 * voxel.ts — geostatistical voxel grid interpolation from borehole data.
 *
 * Discovers interpolatable properties from any depth-referenced AGS group
 * (GEOL, ISPT, LNMC, TRIG, SAMP, etc.) and fills a 3-D voxel grid using
 * either IDW (inverse-distance weighting) or true 3-D RBF interpolation.
 *
 * Numeric fields use RBF by default — a single r³ polyharmonic solve over all
 * (x, y, elevation, value) observation points with auto-scaled anisotropy.
 * Categorical fields always use IDW (nearest borehole at matching depth).
 */

import type { AgsFile, AgsType } from './model.js';
import type { Geo3DModel } from './geo3d.js';
import { RbfVolume } from './rbf.js';
import type { Pt4 } from './rbf.js';
import { sampleTopoAt } from './topo.js';
import type { TopoGrid } from './topo.js';

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
  confidence: number;                  // 0–1 proximity-to-data score
  geolUnit: string | null;            // inferred geological unit (from GEOL layers)
}

export interface VoxelStats {
  count: number;
  mean: number;
  std: number;
  p10: number;
  p50: number;
  p90: number;
  histogram: { edges: number[]; counts: number[] };
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
  stats: VoxelStats | null;       // raw-observation statistics (numeric only)
  method: 'idw' | 'rbf';
}

/** A single borehole's contribution to a cell's interpolated value. */
export interface VoxelObsContribution {
  boreholeId: string;
  distH: number;        // horizontal distance (m) to cell centre
  weight: number;       // normalised IDW weight (0–1)
  value: number | null;
  category: string | null;
  depthTop: number;     // depth below ground (m) of observation top
  depthBase: number;    // depth below ground (m) of observation base
}

/** Provenance record for a single voxel cell — shows how its value was calculated. */
export interface VoxelCellLineage {
  ix: number; iy: number; iz: number;
  cx: number; cy: number; cz: number;
  method: 'rbf' | 'idw';
  value: number | null;
  category: string | null;
  geolUnit: string | null;
  confidence: number;
  /** Horizontal distance to the nearest contributing observation (m). */
  nearestObsDistH: number | null;
  /** Estimated depth below inferred ground surface (m, positive downwards). */
  depthBelowGround: number | null;
  /** Observations that influenced this cell, sorted nearest-first. */
  contributors: VoxelObsContribution[];
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

const DEPTH_SUFFIXES = ['_TOP', '_DPTH', '_DEPT', '_DEP', '_RDEP', '_DEPTH'];

const SKIP_SUFFIXES = [
  '_TOP', '_BASE', '_DPTH', '_DEPT', '_DEP', '_RDEP', '_DEPTH',
  '_TESN', '_REF', '_REM', '_EN', '_RTYP', '_METH', '_CRED',
  '_CONT', '_SAMP', '_ID', '_NCHK', '_CANC',
];

// ── Stats helper ──────────────────────────────────────────────────────────────

const N_HIST_BINS = 12;

function computeStats(values: number[]): VoxelStats {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const std  = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const p = (q: number) => sorted[Math.min(Math.floor(n * q), n - 1)] ?? mean;

  const lo  = sorted[0]!;
  const hi  = sorted[n - 1]!;
  const bw  = (hi - lo) || 1;
  const edges  = Array.from({ length: N_HIST_BINS + 1 }, (_, i) => lo + (i / N_HIST_BINS) * bw);
  const counts = new Array<number>(N_HIST_BINS).fill(0);
  for (const v of values) {
    const bin = Math.min(Math.floor(((v - lo) / bw) * N_HIST_BINS), N_HIST_BINS - 1);
    counts[bin]!++;
  }

  return { count: n, mean, std, p10: p(0.1), p50: p(0.5), p90: p(0.9), histogram: { edges, counts } };
}

// ── Geological unit inference ─────────────────────────────────────────────────

/**
 * Real-world topsoil is rarely thicker than 150–250 mm. Voxel cells deeper
 * than this should never be labelled as topsoil, even when the nearest GEOL
 * record reports an unrealistically deep topsoil layer (often a logging
 * shorthand for the first sample interval). Below this depth the next
 * non-topsoil unit is preferred.
 */
const TOPSOIL_MAX_DEPTH_M = 0.25;

function isTopsoilUnit(key: string | null | undefined): boolean {
  if (!key) return false;
  const u = key.toUpperCase();
  return u === 'TOPS' || u === 'TS' || u.includes('TOPSOIL') || u.includes('TOP SOIL');
}

/**
 * Infer the geological unit at a point (cx, cy, cz) in local coordinates.
 *
 * Priority:
 *   1. Unit surfaces (contactSurface > topSurface / baseSurface) from the
 *      fitted 3-D model — interpolates geology between boreholes.
 *   2. Nearest borehole GEOL layer at matching depth — exact at borehole
 *      locations, degrades to nearest-neighbour elsewhere.
 *
 * Topsoil is only ever assigned to cells within `TOPSOIL_MAX_DEPTH_M` of the
 * ground surface; deeper cells fall through to the next candidate unit.
 */
function inferGeolUnit(
  cx: number, cy: number, cz: number,
  model: Geo3DModel,
): string | null {
  // Estimate depth below ground from nearest borehole collar (cheap proxy)
  let bestBh: { x: number; y: number; elev: number } | null = null;
  let bestD2 = Infinity;
  for (const bh of model.boreholes) {
    const d2 = (bh.x - cx) ** 2 + (bh.y - cy) ** 2;
    if (d2 < bestD2) { bestD2 = d2; bestBh = bh; }
  }
  const depthBelowGround = bestBh ? bestBh.elev - cz : Infinity;
  const allowTopsoil = depthBelowGround <= TOPSOIL_MAX_DEPTH_M;

  // 1. Try fitted unit surfaces
  let topsoilFallback: string | null = null;
  for (const unit of model.units) {
    const topSurf = unit.contactSurface ?? unit.topSurface;
    if (!topSurf) continue;
    const topZ = topSurf.evaluate(cx, cy);
    if (!isFinite(topZ)) continue;
    const baseZ = unit.baseSurface ? unit.baseSurface.evaluate(cx, cy) : -Infinity;
    if (cz <= topZ + 0.25 && cz >= baseZ - 0.25) {
      if (isTopsoilUnit(unit.key) && !allowTopsoil) {
        topsoilFallback ??= unit.key;
        continue; // skip; prefer a deeper, non-topsoil unit
      }
      return unit.key;
    }
  }

  // 2. Nearest borehole depth match
  let bestKey: string | null = null;
  let bestDist2 = Infinity;
  let topsoilNeighbour: string | null = null;
  for (const bh of model.boreholes) {
    if (bh.layers.length === 0) continue;
    const d2 = (bh.x - cx) ** 2 + (bh.y - cy) ** 2;
    if (d2 >= bestDist2) continue;
    const depthInBh = bh.elev - cz;
    for (const layer of bh.layers) {
      if (depthInBh >= layer.topDepth - 0.25 && depthInBh <= layer.baseDepth + 0.25) {
        if (isTopsoilUnit(layer.unitKey) && !allowTopsoil) {
          topsoilNeighbour ??= layer.unitKey;
          continue;
        }
        bestDist2 = d2;
        bestKey = layer.unitKey;
        break;
      }
    }
  }
  return bestKey ?? topsoilFallback ?? topsoilNeighbour;
}

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

    const topField = DEPTH_SUFFIXES
      .map(sfx => groupName + sfx)
      .find(f => headingNames.includes(f));
    if (!topField) continue;

    const baseField = headingNames.includes(`${groupName}_BASE`)
      ? `${groupName}_BASE`
      : null;

    for (const heading of group.headings) {
      const name = heading.name;
      if (name === 'LOCA_ID') continue;
      if (SKIP_SUFFIXES.some(sfx => name.endsWith(sfx))) continue;

      const dt   = heading.data_type;
      const unit = heading.unit ?? '';

      if (isNumericDt(dt)) {
        const hasData = group.rows.some(r => {
          const v = r[name];
          return v != null && v !== '' && !isNaN(parseFloat(String(v)));
        });
        if (!hasData) continue;

        props.push({
          id: name, label: name.replace(/_/g, ' '), type: 'numeric',
          group: groupName, valueField: name,
          depthTopField: topField, depthBaseField: baseField, unit,
        });
      } else if (isCatDt(dt)) {
        const vals = new Set(
          group.rows.map(r => String(r[name] ?? '').trim()).filter(v => v !== ''),
        );
        if (vals.size < 2) continue;

        props.push({
          id: name, label: name.replace(/_/g, ' '), type: 'categorical',
          group: groupName, valueField: name,
          depthTopField: topField, depthBaseField: baseField, unit: '',
        });
      }
    }
  }

  return props;
}

// ── Voxel grid builder ────────────────────────────────────────────────────────

/**
 * Fill a 3-D voxel grid for a single property.
 *
 * Numeric fields:
 *   method='rbf' (default) — build a single RbfVolume from all
 *   (x, y, elevation, value) observation points, evaluate at every cell
 *   centre.  Confidence is derived from distToNearest scaled by the
 *   characteristic lateral spacing between boreholes.
 *
 *   method='idw' — classic IDW (power=1) per cell in 2-D horizontal space
 *   with depth-window matching.
 *
 * Categorical fields always use IDW nearest-borehole at matching depth.
 * Raw-observation statistics (count, mean, std, P10/P50/P90, histogram)
 * are always computed for numeric properties and stored in grid.stats.
 *
 * Each cell receives a `geolUnit` inferred from the geo3d model's fitted
 * unit surfaces (falling back to nearest-borehole GEOL layer matching).
 */
export function buildVoxelGrid(
  file: AgsFile,
  model: Geo3DModel,
  prop: VoxelProperty,
  opts: {
    nx?: number;
    ny?: number;
    nz?: number;
    method?: 'idw' | 'rbf';
    lambda?: number;
    /** Optional topo grid: cells above the terrain surface are excluded. */
    topo?: TopoGrid;
    /**
     * Optional combined topo function (takes precedence over `topo`).
     * Receives local (centroid-relative) x, y coordinates and returns
     * the ground surface elevation (m OD).  Return NaN to skip clipping.
     */
    topoFn?: (lx: number, ly: number) => number;
  } = {},
): VoxelGrid {
  const nx     = Math.max(2, opts.nx ?? 20);
  const ny     = Math.max(2, opts.ny ?? 20);
  const nz     = Math.max(2, opts.nz ?? 20);
  const method = (prop.type === 'numeric' ? (opts.method ?? 'rbf') : 'idw') as 'idw' | 'rbf';
  const lambda = opts.lambda ?? 0;

  const { bounds, boreholes, centroid } = model;
  const { xMin, xMax, yMin, yMax, zMin, zMax } = bounds;
  const dx = (xMax - xMin) / nx;
  const dy = (yMax - yMin) / ny;
  const dz = (zMax - zMin) / nz;

  // Resolve topo clip function: topoFn > topo grid > none
  const topoClip: ((lx: number, ly: number) => number) | null =
    opts.topoFn ?? (opts.topo
      ? (lx, ly) => sampleTopoAt(opts.topo!, lx + centroid.x, ly + centroid.y)
      : null);

  const empty: VoxelGrid = {
    property: prop, nx, ny, nz,
    cellSize: { dx, dy, dz }, bounds, cells: [],
    numericRange: [0, 1], categories: [], centroid,
    stats: null, method,
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
        const sv = String(raw).trim();
        if (sv) catVal = sv;
      }
    }
    if (numVal === null && catVal === null) continue;

    if (!bhObs.has(locaId)) bhObs.set(locaId, []);
    bhObs.get(locaId)!.push({ depthTop: topRaw, depthBase, numVal, catVal });
  }

  if (bhObs.size === 0) return empty;

  const bhByLoca = new Map(boreholes.map(bh => [bh.id, bh]));

  // ── Compute stats from raw observations (numeric only) ─────────────────────

  let stats: VoxelStats | null = null;
  if (prop.type === 'numeric') {
    const allVals: number[] = [];
    for (const obs of bhObs.values()) {
      for (const o of obs) {
        if (o.numVal !== null) allVals.push(o.numVal);
      }
    }
    if (allVals.length > 0) stats = computeStats(allVals);
  }

  // ── RBF path (numeric only) ────────────────────────────────────────────────

  if (method === 'rbf' && prop.type === 'numeric') {
    const pt4s: Pt4[] = [];
    for (const [locaId, obs] of bhObs) {
      const bh = bhByLoca.get(locaId);
      if (!bh) continue;
      for (const o of obs) {
        if (o.numVal === null) continue;
        const midDepth = prop.depthBaseField
          ? (o.depthTop + o.depthBase) / 2
          : o.depthTop;
        pt4s.push({ x: bh.x, y: bh.y, z: bh.elev - midDepth, v: o.numVal });
      }
    }

    if (pt4s.length < 4) {
      // Too few observations for the 3-D polynomial tail — fall back to IDW
      return buildVoxelGrid(file, model, prop, { ...opts, method: 'idw' });
    }

    let rbf: RbfVolume;
    try {
      rbf = new RbfVolume(pt4s, lambda);
    } catch {
      return buildVoxelGrid(file, model, prop, { ...opts, method: 'idw' });
    }

    // Characteristic lateral spacing between contributing boreholes
    const bhList = [...bhByLoca.values()].filter(bh => bhObs.has(bh.id));
    let charDist = 1;
    if (bhList.length >= 2) {
      const dists: number[] = [];
      for (let i = 0; i < bhList.length; i++) {
        for (let j = i + 1; j < bhList.length; j++) {
          const ddx = bhList[i]!.x - bhList[j]!.x;
          const ddy = bhList[i]!.y - bhList[j]!.y;
          dists.push(Math.sqrt(ddx * ddx + ddy * ddy));
        }
      }
      dists.sort((a, b) => a - b);
      charDist = dists[Math.floor(dists.length / 2)] ?? 1;
    }
    const charDist3D = charDist * rbf.az;  // scale to anisotropic space

    // Per-borehole deepest observation depth (from surface). Cells above
    // every borehole's ground level or below every borehole's deepest
    // observation are excluded — RBF would otherwise extrapolate into
    // unsampled volumes above/below the actual data.
    const bhSampledRanges = [] as Array<{ elev: number; bot: number }>;
    for (const [locaId, obs] of bhObs) {
      const bh = bhByLoca.get(locaId);
      if (!bh) continue;
      let bot = -Infinity;
      for (const o of obs) {
        const base = prop.depthBaseField ? o.depthBase : o.depthTop;
        if (base > bot) bot = base;
      }
      if (isFinite(bot)) bhSampledRanges.push({ elev: bh.elev, bot });
    }

    const cells: VoxelCell[] = [];
    let numMin = Infinity;
    let numMax = -Infinity;

    for (let iz = 0; iz < nz; iz++) {
      const cz = zMin + (iz + 0.5) * dz;

      // Skip cells not covered by any borehole's sampled depth range.
      if (bhSampledRanges.length > 0) {
        let inRange = false;
        for (const r of bhSampledRanges) {
          const depth = r.elev - cz;
          if (depth >= 0 && depth <= r.bot + dz) { inRange = true; break; }
        }
        if (!inRange) continue;
      }

      for (let iy = 0; iy < ny; iy++) {
        const cy = yMin + (iy + 0.5) * dy;
        for (let ix = 0; ix < nx; ix++) {
          const cx = xMin + (ix + 0.5) * dx;

          // Topo clip
          if (topoClip) {
            const tz = topoClip(cx, cy);
            if (!isNaN(tz) && cz > tz + dz * 0.5) continue;
          }

          const val = rbf.evaluate(cx, cy, cz);
          const d   = rbf.distToNearest(cx, cy, cz);
          const confidence = Math.max(0, 1 - d / (charDist3D * 1.5));
          const geolUnit = inferGeolUnit(cx, cy, cz, model);

          if (val < numMin) numMin = val;
          if (val > numMax) numMax = val;
          cells.push({ ix, iy, iz, cx, cy, cz, value: val, category: null, confidence, geolUnit });
        }
      }
    }

    return {
      property: prop, nx, ny, nz,
      cellSize: { dx, dy, dz }, bounds, cells,
      numericRange: numMin <= numMax ? [numMin, numMax] : [0, 1],
      categories: [], centroid, stats, method: 'rbf',
    };
  }

  // ── IDW path (numeric fallback + all categorical) ──────────────────────────

  const nBh    = Math.max(1, boreholes.length);
  const halfDz = dz * 0.55;

  const cells: VoxelCell[] = [];
  let numMin = Infinity;
  let numMax = -Infinity;
  const catSet = new Set<string>();

  for (let iz = 0; iz < nz; iz++) {
    const cz = zMin + (iz + 0.5) * dz;
    for (let iy = 0; iy < ny; iy++) {
      const cy = yMin + (iy + 0.5) * dy;
      for (let ix = 0; ix < nx; ix++) {
        const cx = xMin + (ix + 0.5) * dx;

        // Topo clip
        if (topoClip) {
          const tz = topoClip(cx, cy);
          if (!isNaN(tz) && cz > tz + halfDz) continue;
        }

        let wSum = 0, vSum = 0;
        let nearestCat: string | null = null;
        let nearestD = Infinity;
        let nContrib = 0;

        for (const [locaId, obs] of bhObs) {
          const bh = bhByLoca.get(locaId);
          if (!bh) continue;

          const depthInBh = bh.elev - cz;
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
          const dh  = Math.sqrt(ddx * ddx + ddy * ddy);
          nContrib++;

          if (prop.type === 'numeric' && matched.numVal !== null) {
            const w = 1.0 / Math.max(dh, 1.0);
            wSum += w; vSum += w * matched.numVal;
          } else if (matched.catVal !== null) {
            if (dh < nearestD) { nearestD = dh; nearestCat = matched.catVal; }
            wSum = 1;
          }
        }

        if (wSum === 0) continue;

        const confidence = Math.min(1, nContrib / nBh);
        const geolUnit = inferGeolUnit(cx, cy, cz, model);

        if (prop.type === 'numeric') {
          const val = vSum / wSum;
          if (val < numMin) numMin = val;
          if (val > numMax) numMax = val;
          cells.push({ ix, iy, iz, cx, cy, cz, value: val, category: null, confidence, geolUnit });
        } else {
          if (nearestCat) catSet.add(nearestCat);
          cells.push({ ix, iy, iz, cx, cy, cz, value: null, category: nearestCat, confidence, geolUnit });
        }
      }
    }
  }

  return {
    property: prop, nx, ny, nz,
    cellSize: { dx, dy, dz }, bounds, cells,
    numericRange: numMin <= numMax ? [numMin, numMax] : [0, 1],
    categories: [...catSet].sort(), centroid,
    stats, method: 'idw',
  };
}

// ── Cell lineage ──────────────────────────────────────────────────────────────

/**
 * Compute the full provenance record for a voxel cell — shows which borehole
 * observations influenced its value and their relative weights.
 *
 * Works post-hoc from the built grid and the original AGS file; no changes
 * to the grid data structure are required.
 */
export function getVoxelCellLineage(
  grid: VoxelGrid,
  cellIndex: number,
  file: AgsFile,
  model: Geo3DModel,
): VoxelCellLineage | null {
  const cell = grid.cells[cellIndex];
  if (!cell) return null;

  const group = file.groups[grid.property.group];
  const contributors: VoxelObsContribution[] = [];
  const halfDz = grid.cellSize.dz * 0.55;

  if (group) {
    const bhByLoca = new Map(model.boreholes.map(bh => [bh.id, bh]));

    for (const row of group.rows) {
      const locaId = String(row['LOCA_ID'] ?? '').trim();
      const bh = locaId ? bhByLoca.get(locaId) : undefined;
      if (!bh) continue;

      const topRaw = parseFloat(String(row[grid.property.depthTopField] ?? ''));
      if (isNaN(topRaw)) continue;

      let depthBase = topRaw;
      if (grid.property.depthBaseField) {
        const b = parseFloat(String(row[grid.property.depthBaseField] ?? ''));
        if (!isNaN(b)) depthBase = b;
      }

      // Depth match: does this observation cover the cell's elevation?
      const depthInBh = bh.elev - cell.cz;
      const effBase = grid.property.depthBaseField ? depthBase : topRaw + halfDz;
      if (depthInBh < topRaw - halfDz || depthInBh > effBase + halfDz) continue;

      const raw = row[grid.property.valueField];
      let numVal: number | null = null;
      let catVal: string | null = null;
      if (raw != null && raw !== '') {
        if (grid.property.type === 'numeric') {
          const n = parseFloat(String(raw));
          if (!isNaN(n)) numVal = n;
        } else {
          const sv = String(raw).trim();
          if (sv) catVal = sv;
        }
      }
      if (numVal === null && catVal === null) continue;

      const dh = Math.sqrt((bh.x - cell.cx) ** 2 + (bh.y - cell.cy) ** 2);
      contributors.push({
        boreholeId: locaId,
        distH: dh,
        weight: 1 / Math.max(dh, 1),
        value: numVal,
        category: catVal,
        depthTop: topRaw,
        depthBase,
      });
    }

    // Normalise weights and sort nearest-first
    const wSum = contributors.reduce((s, c) => s + c.weight, 0);
    if (wSum > 0) {
      for (const c of contributors) c.weight /= wSum;
    }
    contributors.sort((a, b) => a.distH - b.distH);
  }

  // Estimate depth below ground: nearest borehole collar above this cell
  let groundElev: number | null = null;
  let minD2 = Infinity;
  for (const bh of model.boreholes) {
    const d2 = (bh.x - cell.cx) ** 2 + (bh.y - cell.cy) ** 2;
    if (d2 < minD2) { minD2 = d2; groundElev = bh.elev; }
  }

  return {
    ix: cell.ix, iy: cell.iy, iz: cell.iz,
    cx: cell.cx, cy: cell.cy, cz: cell.cz,
    method: grid.method,
    value: cell.value,
    category: cell.category,
    geolUnit: cell.geolUnit,
    confidence: cell.confidence,
    nearestObsDistH: contributors.length > 0 ? contributors[0]!.distH : null,
    depthBelowGround: groundElev !== null ? Math.max(0, groundElev - cell.cz) : null,
    contributors: contributors.slice(0, 12),
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
    valCol, 'confidence', 'geol_unit',
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
      c.geolUnit ?? '',
    ].join(',');
  });

  return [header, ...rows].join('\n');
}
