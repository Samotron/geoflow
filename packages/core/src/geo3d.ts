/**
 * geo3d.ts — builds a 3-D geological model from an AgsFile.
 *
 * Data flow:
 *   AgsFile  →  extract LOCA + GEOL rows
 *            →  project to local (x, y, elev) coordinates
 *            →  fit a ThinPlateSurface for each unit's top and base
 *            →  return Geo3DModel ready for Three.js rendering
 */

import { Option } from 'effect';
import type { AgsFile, AgsRow } from './model.js';
import { ThinPlateSurface } from './rbf.js';
import type { Pt3 } from './rbf.js';

// ── Colour palette (mirrors explorer.ts) ─────────────────────────────────────

export function geolColor(desc: string): string {
  const u = (desc ?? '').toUpperCase();
  if (u.includes('MADE GROUND') || u.includes('FILL') || u.includes('HARDCORE')) return '#A0785A';
  if (u.includes('TOPSOIL') || u.includes('TOP SOIL')) return '#5C7A3E';
  if (u.includes('PEAT') || u.includes('ORGANIC')) return '#3D2B1F';
  if (u.includes('CHALK')) return '#F5F0C8';
  if (u.includes('CLAY')) return '#7B9EC5';
  if (u.includes('SILT')) return '#C4A87C';
  if (u.includes('SANDY GRAVEL') || u.includes('GRAVELLY SAND')) return '#D99055';
  if (u.includes('SILTY SAND') || u.includes('SANDY SILT')) return '#D8C080';
  if (u.includes('GRAVEL')) return '#C87A45';
  if (u.includes('SANDSTONE')) return '#D4B483';
  if (u.includes('SAND')) return '#F0D870';
  if (u.includes('MUDSTONE') || u.includes('SHALE')) return '#7A7A90';
  if (u.includes('LIMESTONE')) return '#C8CEB8';
  if (u.includes('GRANITE') || u.includes('DIORITE') || u.includes('IGNEOUS')) return '#808090';
  if (u.includes('BASALT')) return '#505060';
  if (u.includes('ROCK') || u.includes('BEDROCK')) return '#9090A0';
  return '#d1d5db';
}

/** Return a hatching key for a geological description (used in cross-section SVG). */
export function geolHatch(desc: string): string {
  const u = (desc ?? '').toUpperCase();
  if (u.includes('MADE GROUND') || u.includes('FILL')) return 'fill';
  if (u.includes('TOPSOIL'))  return 'topsoil';
  if (u.includes('PEAT'))     return 'peat';
  if (u.includes('CHALK'))    return 'chalk';
  if (u.includes('CLAY'))     return 'clay';
  if (u.includes('SILT'))     return 'silt';
  if (u.includes('GRAVEL'))   return 'gravel';
  if (u.includes('SAND'))     return 'sand';
  if (u.includes('SANDSTONE')) return 'sandstone';
  if (u.includes('MUDSTONE') || u.includes('SHALE')) return 'mudstone';
  if (u.includes('LIMESTONE')) return 'limestone';
  if (u.includes('ROCK') || u.includes('BEDROCK') || u.includes('GRANITE')) return 'rock';
  return 'none';
}

// ── Data types ────────────────────────────────────────────────────────────────

export interface GeoLayer {
  unitKey: string;   // canonical name (GEOL_GEOL if present, else normalised desc)
  desc: string;
  topDepth: number;  // m below ground
  baseDepth: number;
  topElev: number;   // m OD
  baseElev: number;
  color: string;
  hatch: string;
}

export interface Borehole3D {
  id: string;
  x: number;        // local easting (m, centroid-relative)
  y: number;        // local northing (m, centroid-relative)
  elev: number;     // ground elevation (m OD)
  finDepth: number; // final depth (m below ground)
  layers: GeoLayer[];
}

export interface GeoUnit {
  key: string;
  color: string;
  hatch: string;
  /** Null when fewer than 3 boreholes contain this unit (not enough to fit). */
  topSurface: ThinPlateSurface | null;
  baseSurface: ThinPlateSurface | null;
}

export interface Geo3DModel {
  boreholes: Borehole3D[];
  units: GeoUnit[];
  /** Axis-aligned bounding box in local (centroid-relative) coordinates. */
  bounds: {
    xMin: number; xMax: number;
    yMin: number; yMax: number;
    zMin: number; zMax: number; // elevation
  };
  centroid: { x: number; y: number }; // absolute easting/northing centroid
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function numVal(row: AgsRow, key: string): number | null {
  const v = row[key];
  if (v == null) return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

function strVal(row: AgsRow, key: string): string {
  return String(row[key] ?? '').trim();
}

// British National Grid proj4 string
const BNG = '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs';

/** Try to get a proj4-compatible coordinate pair from a LOCA row. */
function locaXY(row: AgsRow): { x: number; y: number } | null {
  const e = numVal(row, 'LOCA_NATE');
  const n = numVal(row, 'LOCA_NATN');
  if (e !== null && n !== null && e > 0 && n > 0) return { x: e, y: n };

  const lat = numVal(row, 'LOCA_LAT');
  const lon = numVal(row, 'LOCA_LON');
  if (lat !== null && lon !== null) {
    // Re-project to BNG so everything is in metres
    try {
      // Dynamic import guard: proj4 is a browser dep; use it if available
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proj4fn = (globalThis as any).__proj4 ?? null;
      if (proj4fn) {
        const [east, north] = proj4fn('WGS84', BNG, [lon, lat]);
        return { x: east, y: north };
      }
      // Fallback: rough equirectangular in metres (good enough for small sites)
      const latRad = lat * Math.PI / 180;
      return { x: lon * 111320 * Math.cos(latRad), y: lat * 110540 };
    } catch {
      return null;
    }
  }
  return null;
}

/** Normalise a geological description to a short canonical unit key. */
function unitKey(geolCode: string, desc: string): string {
  if (geolCode) return geolCode.toUpperCase().trim();
  // Derive from first word of description
  const first = desc.trim().split(/\s+/)[0]?.toUpperCase() ?? 'UNK';
  return first.slice(0, 12);
}

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildGeo3DModel(file: AgsFile): Geo3DModel | null {
  const loca = file.groups['LOCA'];
  const geol = file.groups['GEOL'];
  if (!loca || loca.rows.length === 0) return null;

  // ── 1. Extract borehole positions ─────────────────────────────────────────

  interface LocaEntry {
    id: string;
    ax: number; ay: number;    // absolute x/y in metres
    elev: number;
    finDepth: number;
  }

  const locaMap = new Map<string, LocaEntry>();
  for (const row of loca.rows) {
    const id = strVal(row, 'LOCA_ID');
    if (!id) continue;
    const xy = locaXY(row);
    if (!xy) continue;
    const elev = numVal(row, 'LOCA_ELEV') ?? 0;
    const finDepth = numVal(row, 'LOCA_FDEP') ?? 0;
    locaMap.set(id, { id, ax: xy.x, ay: xy.y, elev, finDepth });
  }

  if (locaMap.size === 0) return null;

  // ── 2. Centroid and local coordinates ─────────────────────────────────────

  let cx = 0; let cy = 0;
  for (const e of locaMap.values()) { cx += e.ax; cy += e.ay; }
  cx /= locaMap.size;
  cy /= locaMap.size;

  // ── 3. Parse GEOL layers ──────────────────────────────────────────────────

  interface LayerRaw {
    unitKey: string;
    desc: string;
    top: number;
    base: number;
    color: string;
    hatch: string;
  }

  const layersByLoca = new Map<string, LayerRaw[]>();
  if (geol) {
    for (const row of geol.rows) {
      const id = strVal(row, 'LOCA_ID');
      if (!id || !locaMap.has(id)) continue;
      const top  = numVal(row, 'GEOL_TOP')  ?? 0;
      const base = numVal(row, 'GEOL_BASE') ?? top;
      const desc = strVal(row, 'GEOL_DESC');
      const code = strVal(row, 'GEOL_GEOL');
      const key  = unitKey(code, desc);
      const color = geolColor(desc || code);
      const hatch = geolHatch(desc || code);
      if (!layersByLoca.has(id)) layersByLoca.set(id, []);
      layersByLoca.get(id)!.push({ unitKey: key, desc, top, base, color, hatch });
    }
  }

  // ── 4. Build Borehole3D list ──────────────────────────────────────────────

  const boreholes: Borehole3D[] = [];
  for (const entry of locaMap.values()) {
    const lx = entry.ax - cx;
    const ly = entry.ay - cy;
    const rawLayers = layersByLoca.get(entry.id) ?? [];
    const layers: GeoLayer[] = rawLayers.map(l => ({
      unitKey: l.unitKey,
      desc: l.desc,
      topDepth: l.top,
      baseDepth: l.base,
      topElev: entry.elev - l.top,
      baseElev: entry.elev - l.base,
      color: l.color,
      hatch: l.hatch,
    }));
    boreholes.push({ id: entry.id, x: lx, y: ly, elev: entry.elev, finDepth: entry.finDepth, layers });
  }

  // ── 5. Collect TPS control points per unit ────────────────────────────────

  const unitTopPts  = new Map<string, Pt3[]>();
  const unitBasePts = new Map<string, Pt3[]>();
  const unitMeta    = new Map<string, { color: string; hatch: string }>();

  for (const bh of boreholes) {
    for (const layer of bh.layers) {
      const k = layer.unitKey;
      if (!unitMeta.has(k)) unitMeta.set(k, { color: layer.color, hatch: layer.hatch });

      if (!unitTopPts.has(k))  unitTopPts.set(k, []);
      if (!unitBasePts.has(k)) unitBasePts.set(k, []);
      unitTopPts.get(k)!.push({ x: bh.x, y: bh.y, z: layer.topElev });
      unitBasePts.get(k)!.push({ x: bh.x, y: bh.y, z: layer.baseElev });
    }
  }

  // ── 6. Fit surfaces ───────────────────────────────────────────────────────

  const units: GeoUnit[] = [];
  for (const [key, meta] of unitMeta) {
    const topPts  = unitTopPts.get(key)!;
    const basePts = unitBasePts.get(key)!;
    let topSurface: ThinPlateSurface | null = null;
    let baseSurface: ThinPlateSurface | null = null;
    try {
      if (topPts.length >= 3)  topSurface  = new ThinPlateSurface(topPts);
      if (basePts.length >= 3) baseSurface = new ThinPlateSurface(basePts);
    } catch {
      // Singular matrix (all points collinear, etc.) — leave surfaces null
    }
    units.push({ key, color: meta.color, hatch: meta.hatch, topSurface, baseSurface });
  }

  // ── 7. Bounds ─────────────────────────────────────────────────────────────

  let xMin = Infinity; let xMax = -Infinity;
  let yMin = Infinity; let yMax = -Infinity;
  let zMin = Infinity; let zMax = -Infinity;
  for (const bh of boreholes) {
    xMin = Math.min(xMin, bh.x); xMax = Math.max(xMax, bh.x);
    yMin = Math.min(yMin, bh.y); yMax = Math.max(yMax, bh.y);
    zMax = Math.max(zMax, bh.elev);
    zMin = Math.min(zMin, bh.elev - bh.finDepth);
    for (const l of bh.layers) {
      zMin = Math.min(zMin, l.baseElev);
      zMax = Math.max(zMax, l.topElev);
    }
  }
  // Ensure non-degenerate horizontal extent (single borehole edge case)
  if (xMin === xMax) { xMin -= 10; xMax += 10; }
  if (yMin === yMax) { yMin -= 10; yMax += 10; }

  return {
    boreholes,
    units,
    bounds: { xMin, xMax, yMin, yMax, zMin, zMax },
    centroid: { x: cx, y: cy },
  };
}

// ── Borehole strip log SVG ────────────────────────────────────────────────────

/** Generate a compact SVG strip log for a single Borehole3D (for side-panel display). */
export function renderBoreholeStripSvg(bh: Borehole3D): string {
  const PX_PER_M = 14;
  const maxDepth = Math.max(10, ...bh.layers.map(l => l.baseDepth)) + 1;
  const bodyH = Math.ceil(maxDepth) * PX_PER_M;
  const totalH = bodyH + 36;
  const W = 300;

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" font-family="system-ui,sans-serif">`);

  // Header
  lines.push(`<rect x="0" y="0" width="${W}" height="30" fill="#1e3a5f"/>`);
  lines.push(`<text x="12" y="20" font-size="12" font-weight="700" fill="#fff">${bh.id}</text>`);
  lines.push(`<text x="${W - 8}" y="20" font-size="10" fill="#94a3b8" text-anchor="end">GL: ${bh.elev.toFixed(1)} m OD</text>`);

  // Column headers
  lines.push(`<rect x="0" y="30" width="${W}" height="${totalH - 30}" fill="#f8fafc"/>`);
  lines.push(`<text x="26" y="44" font-size="8" fill="#64748b" text-anchor="middle">m</text>`);
  lines.push(`<text x="88" y="44" font-size="8" fill="#64748b" text-anchor="middle">Lithology</text>`);
  lines.push(`<text x="200" y="44" font-size="8" fill="#64748b" text-anchor="middle">Description</text>`);

  const Y0 = 48;

  // Depth ticks
  for (let d = 0; d <= Math.ceil(maxDepth); d += 5) {
    const y = Y0 + d * PX_PER_M;
    lines.push(`<line x1="10" y1="${y}" x2="44" y2="${y}" stroke="#94a3b8" stroke-width="0.6"/>`);
    lines.push(`<text x="26" y="${y + 3}" font-size="8" fill="#64748b" text-anchor="middle">${d}</text>`);
  }

  // Geological layers
  for (const layer of bh.layers) {
    const y1 = Y0 + layer.topDepth  * PX_PER_M;
    const h  = Math.max(2, (layer.baseDepth - layer.topDepth) * PX_PER_M);
    lines.push(`<rect x="50" y="${y1.toFixed(1)}" width="70" height="${h.toFixed(1)}" fill="${layer.color}" stroke="#475569" stroke-width="0.5"/>`);
    if (h > 8) {
      const midY = y1 + h / 2 + 3;
      const label = layer.desc.length > 22 ? layer.desc.slice(0, 20) + '…' : layer.desc;
      lines.push(`<text x="128" y="${midY.toFixed(1)}" font-size="7.5" fill="#0f172a">${label}</text>`);
    }
  }

  // Borehole outline
  lines.push(`<line x1="85" y1="${Y0}" x2="85" y2="${(Y0 + maxDepth * PX_PER_M).toFixed(1)}" stroke="#334155" stroke-width="1.5"/>`);

  lines.push('</svg>');
  return lines.join('\n');
}
