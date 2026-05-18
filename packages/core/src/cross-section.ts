/**
 * cross-section.ts — 2D fence diagram / cross-section renderer.
 *
 * Given a Geo3DModel and an ordered list of borehole IDs, project each
 * borehole onto the polyline through them ("chainage") and render an SVG
 * showing stratigraphy with interpolated contacts between holes.
 *
 * Two interpolation modes are supported:
 *   - "linear-chainage" (default) — direct linear interpolation of contact
 *     elevations along the section line. Robust, requires no surface fits.
 *   - "surface" — project the existing per-unit contactSurface from the
 *     Geo3DModel onto evenly-spaced points along the section line. Smoother
 *     and uses contact data from off-section holes too, but only available
 *     when ≥3 holes contain the unit.
 *
 * The renderer aims for a clean, production-grade look comparable to
 * Leapfrog/gINT/Strater output:
 *   - monotone-cubic interpolation of contacts (smooth, monotonic)
 *   - hatch patterns layered with colour fills
 *   - major + minor grid
 *   - A–A′ direction labels
 *   - borehole strips with depth ticks
 *   - scale bar + V.E. indicator
 *   - unit-code labels placed inside polygons
 *   - off-section indicator with offset distance
 *   - tidy title block and legend with hatch swatches
 */

import type { Geo3DModel, Borehole3D, GeoLayer } from "./geo3d.js";
import { geolColor, geolHatch } from "./geo3d.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface CrossSectionOptions {
  /** Width of the SVG in pixels. Default 1100. */
  width?: number;
  /** Height of the SVG in pixels. Default 560. */
  height?: number;
  /** Vertical exaggeration (V/H). Default 1 (true scale, auto-clamped). */
  verticalExaggeration?: number;
  /** Whether to label borehole IDs on the section. Default true. */
  showLabels?: boolean;
  /** Interpolation strategy. Default "smooth". */
  interpolation?: "linear-chainage" | "smooth" | "surface";
  /** Title shown in the title block. Optional. */
  title?: string;
  /** Whether to draw the legend. Default true. */
  showLegend?: boolean;
  /** Whether to draw hatch patterns on unit polygons. Default true. */
  showHatch?: boolean;
  /** Whether to draw the grid inside the plot. Default true. */
  showGrid?: boolean;
  /** Whether to draw A–A′ direction labels at the section ends. Default true. */
  showDirectionLabels?: boolean;
  /** Start label (left end of section). Default "A". */
  startLabel?: string;
  /** End label (right end of section). Default "A′". */
  endLabel?: string;
  /** Whether to draw unit-code labels inside the polygons. Default true. */
  showUnitLabels?: boolean;
  /** Whether to draw a scale bar in the plot. Default true. */
  showScaleBar?: boolean;
  /** Optional subtitle (e.g. project / date). */
  subtitle?: string;
  /**
   * How the section line through the selected boreholes is constructed:
   *  - `"fence"` (default): a polyline visiting each hole in the supplied order
   *    — produces a zig-zag fence diagram with no off-section offsets.
   *  - `"best-fit"`: a straight line fit to the hole positions; off-section
   *    holes show projection offsets.
   *  - explicit polyline waypoints.
   */
  sectionLine?: "fence" | "best-fit" | Array<{ x: number; y: number }>;
}

export interface SectionBorehole {
  id: string;
  /** Distance along the section polyline (m). */
  chainage: number;
  /** Perpendicular offset from the section line (m, signed). */
  offset: number;
  /** Source borehole. */
  borehole: Borehole3D;
}

export interface CrossSectionData {
  /** Boreholes used, sorted by chainage. */
  boreholes: SectionBorehole[];
  /** Section length (m). */
  totalLength: number;
  /** Elevation extents on the section (m OD). */
  elevMin: number;
  elevMax: number;
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

interface Vec2 { x: number; y: number }

function sub(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y }; }
function len(v: Vec2): number { return Math.hypot(v.x, v.y); }
function dot(a: Vec2, b: Vec2): number { return a.x * b.x + a.y * b.y; }

/**
 * Best-fit line through a set of 2D points. Returns a two-point polyline
 * representing the principal-axis line, extended to enclose the projections
 * of all input points. Falls back to the convex hull endpoints if the
 * principal-axis covariance is degenerate.
 */
function bestFitLine(points: Vec2[]): Vec2[] {
  if (points.length < 2) return points;
  const n = points.length;
  let mx = 0, my = 0;
  for (const p of points) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  // Principal eigenvector of the 2×2 covariance matrix.
  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, trace * trace / 4 - det);
  const lambda = trace / 2 + Math.sqrt(disc);
  let dirX: number, dirY: number;
  if (Math.abs(sxy) > 1e-12) {
    dirX = lambda - syy;
    dirY = sxy;
  } else if (sxx >= syy) {
    dirX = 1; dirY = 0;
  } else {
    dirX = 0; dirY = 1;
  }
  const dlen = Math.hypot(dirX, dirY) || 1;
  dirX /= dlen; dirY /= dlen;
  let tMin = Infinity, tMax = -Infinity;
  for (const p of points) {
    const t = (p.x - mx) * dirX + (p.y - my) * dirY;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  return [
    { x: mx + tMin * dirX, y: my + tMin * dirY },
    { x: mx + tMax * dirX, y: my + tMax * dirY },
  ];
}

function projectOntoPolyline(
  pt: Vec2,
  polyline: Vec2[],
): { chainage: number; offset: number } {
  let best = { chainage: 0, offset: Infinity };
  let cum = 0;
  let bestAbs = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]!;
    const b = polyline[i + 1]!;
    const ab = sub(b, a);
    const ap = sub(pt, a);
    const L = len(ab);
    if (L < 1e-9) continue;
    const t = Math.max(0, Math.min(1, dot(ap, ab) / (L * L)));
    const proj: Vec2 = { x: a.x + t * ab.x, y: a.y + t * ab.y };
    const d = len(sub(pt, proj));
    const cross = ap.x * ab.y - ap.y * ab.x; // signed
    const signedOffset = (cross / L);
    if (d < bestAbs) {
      bestAbs = d;
      best = { chainage: cum + t * L, offset: signedOffset };
    }
    cum += L;
  }
  return best;
}

// ── Build section data ────────────────────────────────────────────────────────

export function buildSectionData(
  model: Geo3DModel,
  boreholeIds: string[],
  polylineOrMode?: Array<{ x: number; y: number }> | "fence" | "best-fit",
): CrossSectionData | null {
  if (boreholeIds.length < 2) return null;

  const idMap = new Map<string, Borehole3D>();
  for (const bh of model.boreholes) idMap.set(bh.id, bh);

  const selected: Borehole3D[] = [];
  for (const id of boreholeIds) {
    const bh = idMap.get(id);
    if (bh) selected.push(bh);
  }
  if (selected.length < 2) return null;

  let line: Vec2[];
  if (Array.isArray(polylineOrMode)) {
    line = polylineOrMode.map(p => ({ x: p.x, y: p.y }));
  } else if (polylineOrMode === "best-fit") {
    line = bestFitLine(selected.map(bh => ({ x: bh.x, y: bh.y })));
  } else {
    // "fence" (default) — polyline visits every hole in the supplied order.
    line = selected.map(bh => ({ x: bh.x, y: bh.y }));
  }

  const projected: SectionBorehole[] = selected.map(bh => {
    const { chainage, offset } = projectOntoPolyline({ x: bh.x, y: bh.y }, line);
    return { id: bh.id, chainage, offset, borehole: bh };
  });
  projected.sort((a, b) => a.chainage - b.chainage);

  let elevMin = Infinity;
  let elevMax = -Infinity;
  for (const sb of projected) {
    const top = sb.borehole.elev;
    const base = sb.borehole.elev - sb.borehole.finDepth;
    elevMax = Math.max(elevMax, top);
    elevMin = Math.min(elevMin, base);
    for (const l of sb.borehole.layers) {
      elevMax = Math.max(elevMax, l.topElev);
      elevMin = Math.min(elevMin, l.baseElev);
    }
  }
  if (!isFinite(elevMin) || !isFinite(elevMax) || elevMin === elevMax) {
    elevMin = (selected[0]?.elev ?? 0) - 10;
    elevMax = (selected[0]?.elev ?? 0) + 1;
  }

  let totalLength = 0;
  for (let i = 0; i < line.length - 1; i++) {
    totalLength += len(sub(line[i + 1]!, line[i]!));
  }
  if (totalLength < (projected.at(-1)?.chainage ?? 0)) {
    totalLength = projected.at(-1)!.chainage;
  }

  return { boreholes: projected, totalLength, elevMin, elevMax };
}

// ── Layer-contact extraction across the section ───────────────────────────────

interface UnitObservation {
  chainage: number;
  topElev: number;
  baseElev: number;
}

interface UnitEntry {
  obs: UnitObservation[];
  color: string;
  hatch: string;
  desc: string;
  /** Average top depth — used to sort the legend top→bottom. */
  avgTopDepth: number;
  /** First-seen order, used as a tiebreak. */
  order: number;
}

function collectUnitObservations(boreholes: SectionBorehole[]): Map<string, UnitEntry> {
  const out = new Map<string, UnitEntry>();
  let order = 0;
  for (const sb of boreholes) {
    const sorted = [...sb.borehole.layers].sort((a, b) => a.topDepth - b.topDepth);
    for (const layer of sorted) {
      let entry = out.get(layer.unitKey);
      if (!entry) {
        entry = {
          obs: [],
          color: layer.color || geolColor(layer.desc),
          hatch: layer.hatch || geolHatch(layer.desc),
          desc: layer.desc,
          avgTopDepth: 0,
          order: order++,
        };
        out.set(layer.unitKey, entry);
      }
      entry.obs.push({
        chainage: sb.chainage,
        topElev: layer.topElev,
        baseElev: layer.baseElev,
      });
    }
  }
  // Compute the average top depth (relative to ground) for stratigraphic
  // ordering. We use elevation deltas vs. the highest borehole top to keep
  // this monotonic when boreholes have very different ground elevations.
  for (const entry of out.values()) {
    if (entry.obs.length === 0) continue;
    const avgTop = entry.obs.reduce((s, o) => s + o.topElev, 0) / entry.obs.length;
    // Lower elevation = deeper unit. We store negated avgTopElev so smaller
    // values sort first (i.e. shallowest unit first).
    entry.avgTopDepth = -avgTop;
  }
  return out;
}

// ── Smooth monotone-cubic interpolation ───────────────────────────────────────

/**
 * Fritsch–Carlson monotone cubic interpolation. Given sorted (x_i, y_i)
 * observations, return a function that evaluates the interpolant at any x
 * inside [x_0, x_n]. Outside the range the function clamps to the nearest
 * endpoint. The interpolant preserves monotonicity, so contacts never
 * "overshoot" between borehole observations, which is the right default for
 * stratigraphic surfaces sampled at sparse holes.
 */
function monotoneCubic(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => ys[0]!;

  // Slopes between consecutive points
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = []; // secant slopes
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1]! - xs[i]!;
    const d = ys[i + 1]! - ys[i]!;
    dx.push(h);
    dy.push(d);
    m.push(h === 0 ? 0 : d / h);
  }

  // Tangents at each point (Fritsch–Carlson)
  const t: number[] = new Array(n);
  t[0] = m[0]!;
  t[n - 1] = m[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1]! * m[i]! <= 0) {
      t[i] = 0;
    } else {
      t[i] = (m[i - 1]! + m[i]!) / 2;
    }
  }
  // Adjust to ensure monotonicity
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * m[i]!;
      t[i + 1] = tau * b * m[i]!;
    }
  }

  return (x: number): number => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    // Binary search for the segment
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! <= x) lo = mid; else hi = mid;
    }
    const h = dx[lo]!;
    if (h === 0) return ys[lo]!;
    const tt = (x - xs[lo]!) / h;
    const t2 = tt * tt;
    const t3 = t2 * tt;
    const h00 =  2 * t3 - 3 * t2 + 1;
    const h10 =      t3 - 2 * t2 + tt;
    const h01 = -2 * t3 + 3 * t2;
    const h11 =      t3 -     t2;
    return h00 * ys[lo]! + h10 * h * t[lo]! + h01 * ys[lo + 1]! + h11 * h * t[lo + 1]!;
  };
}

/**
 * Build a densified array of (chainage, elev) samples along the unit's
 * observation range, using monotone-cubic interpolation when `smooth` is
 * true and `obs.length >= 2`. Falls back to the raw observation points
 * otherwise.
 */
function buildEdge(
  obs: Array<{ chainage: number; value: number }>,
  smooth: boolean,
  samples = 80,
): Array<{ chainage: number; value: number }> {
  if (obs.length === 0) return [];
  const sorted = [...obs].sort((a, b) => a.chainage - b.chainage);
  if (!smooth || sorted.length < 2) return sorted;

  const xs = sorted.map(o => o.chainage);
  const ys = sorted.map(o => o.value);
  const f = monotoneCubic(xs, ys);
  const out: Array<{ chainage: number; value: number }> = [];
  const x0 = xs[0]!;
  const x1 = xs[xs.length - 1]!;
  const n = Math.max(samples, sorted.length);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t;
    out.push({ chainage: x, value: f(x) });
  }
  return out;
}

// ── SVG renderer ──────────────────────────────────────────────────────────────

const HATCH_DEFS = `<defs>
<pattern id="gfx-clay" patternUnits="userSpaceOnUse" width="12" height="5">
  <line x1="0" y1="2.5" x2="12" y2="2.5" stroke="#3b4a5c" stroke-width="0.7" opacity="0.55"/>
</pattern>
<pattern id="gfx-silt" patternUnits="userSpaceOnUse" width="10" height="6">
  <line x1="0" y1="3" x2="10" y2="3" stroke="#5a4a2a" stroke-width="0.5" opacity="0.45"/>
  <circle cx="5" cy="4.5" r="0.5" fill="#5a4a2a" opacity="0.6"/>
</pattern>
<pattern id="gfx-sand" patternUnits="userSpaceOnUse" width="8" height="8">
  <circle cx="2" cy="2" r="0.75" fill="#6b5414" opacity="0.55"/>
  <circle cx="6" cy="6" r="0.75" fill="#6b5414" opacity="0.55"/>
</pattern>
<pattern id="gfx-gravel" patternUnits="userSpaceOnUse" width="14" height="10">
  <ellipse cx="3" cy="3" rx="2" ry="1.3" fill="none" stroke="#5a3920" stroke-width="0.7" opacity="0.7"/>
  <ellipse cx="10" cy="7" rx="2" ry="1.3" fill="none" stroke="#5a3920" stroke-width="0.7" opacity="0.7"/>
</pattern>
<pattern id="gfx-chalk" patternUnits="userSpaceOnUse" width="10" height="10">
  <line x1="0" y1="10" x2="10" y2="0" stroke="#8a7a3b" stroke-width="0.6" opacity="0.5"/>
  <line x1="-2" y1="4" x2="4" y2="-2" stroke="#8a7a3b" stroke-width="0.6" opacity="0.5"/>
</pattern>
<pattern id="gfx-rock" patternUnits="userSpaceOnUse" width="14" height="8">
  <path d="M0 0 L14 0 M0 8 L14 8 M0 0 L0 8 M7 0 L7 8" stroke="#4a4a60" stroke-width="0.6" opacity="0.55" fill="none"/>
</pattern>
<pattern id="gfx-sandstone" patternUnits="userSpaceOnUse" width="10" height="10">
  <line x1="0" y1="10" x2="10" y2="0" stroke="#6a5530" stroke-width="0.6" opacity="0.5"/>
  <circle cx="5" cy="5" r="0.6" fill="#6a5530" opacity="0.6"/>
</pattern>
<pattern id="gfx-mudstone" patternUnits="userSpaceOnUse" width="10" height="8">
  <line x1="0" y1="4" x2="10" y2="4" stroke="#403c50" stroke-width="0.6" opacity="0.55"/>
  <line x1="0" y1="0" x2="10" y2="8" stroke="#403c50" stroke-width="0.4" stroke-dasharray="2,3" opacity="0.4"/>
</pattern>
<pattern id="gfx-limestone" patternUnits="userSpaceOnUse" width="12" height="8">
  <path d="M0 0 L12 0 M0 4 L12 4 M6 0 L6 4" stroke="#5a6048" stroke-width="0.55" opacity="0.55" fill="none"/>
</pattern>
<pattern id="gfx-fill" patternUnits="userSpaceOnUse" width="10" height="10">
  <line x1="0" y1="0" x2="10" y2="10" stroke="#5a3a20" stroke-width="0.6" opacity="0.6"/>
  <line x1="0" y1="5" x2="5"  y2="0"  stroke="#5a3a20" stroke-width="0.4" opacity="0.5"/>
  <line x1="5" y1="10" x2="10" y2="5" stroke="#5a3a20" stroke-width="0.4" opacity="0.5"/>
</pattern>
<pattern id="gfx-topsoil" patternUnits="userSpaceOnUse" width="8" height="8">
  <line x1="0" y1="4" x2="8" y2="4" stroke="#2e4220" stroke-width="0.6" opacity="0.55"/>
  <circle cx="2" cy="2" r="0.6" fill="#2e4220" opacity="0.65"/>
  <circle cx="6" cy="6" r="0.6" fill="#2e4220" opacity="0.65"/>
</pattern>
<pattern id="gfx-peat" patternUnits="userSpaceOnUse" width="8" height="8">
  <circle cx="2" cy="2" r="0.9" fill="#1a0f08" opacity="0.7"/>
  <circle cx="6" cy="6" r="0.9" fill="#1a0f08" opacity="0.7"/>
</pattern>
<pattern id="gfx-none" patternUnits="userSpaceOnUse" width="8" height="8"></pattern>
<linearGradient id="gfx-sky" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0%" stop-color="#e8eef6"/>
  <stop offset="100%" stop-color="#f6f8fb"/>
</linearGradient>
</defs>`;

const KNOWN_HATCHES = new Set([
  'clay','silt','sand','gravel','chalk','rock','sandstone','mudstone','limestone','fill','topsoil','peat',
]);

function hatchUrl(h: string): string {
  return `url(#gfx-${KNOWN_HATCHES.has(h) ? h : 'none'})`;
}

export function renderCrossSectionSvg(
  model: Geo3DModel,
  boreholeIds: string[],
  opts: CrossSectionOptions = {},
): string {
  const data = buildSectionData(model, boreholeIds, opts.sectionLine);
  if (!data) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="60"><text x="10" y="34" font-family="system-ui" font-size="12" fill="#dc2626">Select at least 2 boreholes.</text></svg>`;
  }

  const W = opts.width ?? 1100;
  const H = opts.height ?? 560;
  const showLabels = opts.showLabels !== false;
  const showLegend = opts.showLegend !== false;
  const showHatch = opts.showHatch !== false;
  const showGrid = opts.showGrid !== false;
  const showDirectionLabels = opts.showDirectionLabels !== false;
  const showUnitLabels = opts.showUnitLabels !== false;
  const showScaleBar = opts.showScaleBar !== false;
  const interpolation = opts.interpolation ?? "smooth";
  const smooth = interpolation === "smooth" || interpolation === "surface";
  const title = opts.title;
  const subtitle = opts.subtitle;
  const startLabel = opts.startLabel ?? "A";
  const endLabel = opts.endLabel ?? "A′";

  // Title block height (drawn above the plot)
  const titleBlockH = title || subtitle ? 44 : 0;

  const margin = {
    top: titleBlockH + 22,
    right: showLegend ? 220 : 24,
    bottom: 56,
    left: 68,
  };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  // Vertical exaggeration — pixel scales
  const naturalDz = Math.max(data.elevMax - data.elevMin, 0.5);
  const naturalDx = Math.max(data.totalLength, 1);
  const pxPerXAtVE1 = plotW / naturalDx;
  let vexag = opts.verticalExaggeration ?? 1;
  const fitVE = (plotH / naturalDz) / pxPerXAtVE1;
  if (vexag > fitVE) vexag = fitVE;
  if (vexag <= 0 || !isFinite(vexag)) vexag = Math.max(1, fitVE);

  const pxPerX = pxPerXAtVE1;
  const pxPerZ = pxPerXAtVE1 * vexag;

  const xScale = (chainage: number) => margin.left + chainage * pxPerX;
  const yScale = (elev: number) => margin.top + (data.elevMax - elev) * pxPerZ;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" font-size="11">`);
  out.push(HATCH_DEFS);

  // Reusable styles — gives nicer hover feedback in browsers
  out.push(`<style>
    .gfx-unit { transition: opacity 120ms ease; }
    .gfx-unit:hover { opacity: 1 !important; stroke-width: 1.2; }
    .gfx-bh:hover .gfx-bh-bg { fill: rgba(15,23,42,0.04); }
    text { user-select: none; }
  </style>`);

  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

  // Title block
  if (titleBlockH > 0) {
    const tb = { x: margin.left, y: 8, w: plotW + (showLegend ? margin.right - 24 : 0), h: titleBlockH - 8 };
    out.push(`<rect x="${tb.x}" y="${tb.y}" width="${tb.w}" height="${tb.h}" fill="#f8fafc" stroke="#cbd5e1" stroke-width="0.8" rx="3"/>`);
    if (title) {
      out.push(`<text x="${tb.x + 12}" y="${tb.y + 18}" font-size="14" font-weight="700" fill="#0f172a">${escSvg(title)}</text>`);
    }
    if (subtitle) {
      out.push(`<text x="${tb.x + 12}" y="${tb.y + 33}" font-size="10.5" fill="#475569">${escSvg(subtitle)}</text>`);
    }
    // Stats on the right of the title block
    const stats = `${data.boreholes.length} holes  ·  ${data.totalLength.toFixed(0)} m  ·  V.E. ×${vexag.toFixed(2)}`;
    out.push(`<text x="${tb.x + tb.w - 12}" y="${tb.y + 18}" font-size="11" font-weight="600" fill="#475569" text-anchor="end">${escSvg(stats)}</text>`);
    const range = `${data.elevMin.toFixed(1)} → ${data.elevMax.toFixed(1)} m OD`;
    out.push(`<text x="${tb.x + tb.w - 12}" y="${tb.y + 33}" font-size="10" fill="#64748b" text-anchor="end">${escSvg(range)}</text>`);
  }

  // Sky band (above ground surface) — gives the section "earth" weight
  out.push(`<rect x="${margin.left}" y="${margin.top}" width="${plotW.toFixed(1)}" height="${plotH.toFixed(1)}" fill="url(#gfx-sky)"/>`);

  // Plot frame
  out.push(`<rect x="${margin.left}" y="${margin.top}" width="${plotW.toFixed(1)}" height="${plotH.toFixed(1)}" fill="none" stroke="#475569" stroke-width="1"/>`);

  // ── Grid (drawn before geology so it sits behind) ────────────────────────
  if (showGrid) {
    const eMajor = niceStep(data.elevMax - data.elevMin);
    const eMinor = eMajor / 5;
    const eStart = Math.ceil(data.elevMin / eMinor) * eMinor;
    for (let z = eStart; z <= data.elevMax + 1e-9; z += eMinor) {
      const y = yScale(z);
      const major = Math.abs(z / eMajor - Math.round(z / eMajor)) < 1e-6;
      out.push(`<line x1="${margin.left.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(margin.left + plotW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${major ? '#cbd5e1' : '#e2e8f0'}" stroke-width="${major ? 0.7 : 0.4}"/>`);
    }
    const cMajor = niceStep(data.totalLength);
    const cMinor = cMajor / 5;
    for (let c = 0; c <= data.totalLength + 1e-9; c += cMinor) {
      const x = xScale(c);
      const major = Math.abs(c / cMajor - Math.round(c / cMajor)) < 1e-6;
      out.push(`<line x1="${x.toFixed(1)}" y1="${margin.top.toFixed(1)}" x2="${x.toFixed(1)}" y2="${(margin.top + plotH).toFixed(1)}" stroke="${major ? '#cbd5e1' : '#e2e8f0'}" stroke-width="${major ? 0.7 : 0.4}"/>`);
    }
  }

  // Clip path so polygons / strips never bleed outside the plot
  out.push(`<clipPath id="gfx-plot-clip"><rect x="${margin.left}" y="${margin.top}" width="${plotW.toFixed(1)}" height="${plotH.toFixed(1)}"/></clipPath>`);
  out.push(`<g clip-path="url(#gfx-plot-clip)">`);

  // ── Geology polygons ─────────────────────────────────────────────────────
  const units = collectUnitObservations(data.boreholes);
  // Render shallowest unit first so deeper polygons overlay correctly on
  // the boundaries; matches Leapfrog/gINT convention.
  const unitList = [...units.entries()].sort((a, b) => {
    if (a[1].avgTopDepth !== b[1].avgTopDepth) return a[1].avgTopDepth - b[1].avgTopDepth;
    return a[1].order - b[1].order;
  });

  // Track polygon centroids so we can place unit labels later
  const unitLabels: Array<{ key: string; cx: number; cy: number; width: number; height: number; color: string }> = [];

  for (const [key, entry] of unitList) {
    const topEdge = buildEdge(entry.obs.map(o => ({ chainage: o.chainage, value: o.topElev })), smooth);
    const baseEdge = buildEdge(entry.obs.map(o => ({ chainage: o.chainage, value: o.baseElev })), smooth);
    if (topEdge.length < 2) continue;

    const pts: string[] = [];
    for (const p of topEdge) pts.push(`${xScale(p.chainage).toFixed(1)},${yScale(p.value).toFixed(1)}`);
    for (let i = baseEdge.length - 1; i >= 0; i--) {
      const p = baseEdge[i]!;
      pts.push(`${xScale(p.chainage).toFixed(1)},${yScale(p.value).toFixed(1)}`);
    }

    // Colour fill
    out.push(`<polygon class="gfx-unit" data-unit="${escSvg(key)}" points="${pts.join(" ")}" fill="${entry.color}" stroke="#334155" stroke-width="0.7" opacity="0.88"><title>${escSvg(key)} — ${escSvg(entry.desc)}</title></polygon>`);
    // Hatch overlay
    if (showHatch && entry.hatch && entry.hatch !== 'none') {
      out.push(`<polygon points="${pts.join(" ")}" fill="${hatchUrl(entry.hatch)}" stroke="none" pointer-events="none"/>`);
    }

    // Centroid for label
    if (showUnitLabels && entry.obs.length > 0) {
      const cMin = Math.min(...entry.obs.map(o => o.chainage));
      const cMax = Math.max(...entry.obs.map(o => o.chainage));
      const cMid = (cMin + cMax) / 2;
      const tMid = topEdge.length > 0
        ? topEdge.reduce((s, p) => s + p.value, 0) / topEdge.length
        : 0;
      const bMid = baseEdge.length > 0
        ? baseEdge.reduce((s, p) => s + p.value, 0) / baseEdge.length
        : tMid;
      const cx = xScale(cMid);
      const cy = (yScale(tMid) + yScale(bMid)) / 2;
      const wPx = (cMax - cMin) * pxPerX;
      const hPx = Math.abs(yScale(bMid) - yScale(tMid));
      unitLabels.push({ key, cx, cy, width: wPx, height: hPx, color: entry.color });
    }
  }

  // ── Ground surface line (use the top of the shallowest observation per BH) ──
  const groundPts: Array<{ chainage: number; value: number }> = data.boreholes.map(sb => ({
    chainage: sb.chainage,
    value: sb.borehole.elev,
  }));
  const groundEdge = buildEdge(groundPts, smooth);
  const groundPath = groundEdge.map(p => `${xScale(p.chainage).toFixed(1)},${yScale(p.value).toFixed(1)}`).join(" ");
  out.push(`<polyline points="${groundPath}" fill="none" stroke="#1f2937" stroke-width="1.6"/>`);

  out.push(`</g>`); // close clip

  // Unit labels (drawn outside clip so they don't get cut at edges, but
  // positioned to land inside polygons; small polygons skipped).
  if (showUnitLabels) {
    for (const lbl of unitLabels) {
      if (lbl.width < 36 || lbl.height < 14) continue;
      const txt = truncate(lbl.key, 14);
      out.push(`<text x="${lbl.cx.toFixed(1)}" y="${(lbl.cy + 3.5).toFixed(1)}" font-size="10" font-weight="700" fill="#0f172a" text-anchor="middle" paint-order="stroke" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round">${escSvg(txt)}</text>`);
    }
  }

  // ── Borehole strips (drawn outside clip so labels are not truncated) ────
  const bhWidth = Math.max(14, Math.min(24, plotW / Math.max(data.boreholes.length * 2.5, 8)));
  for (const sb of data.boreholes) {
    const cx = xScale(sb.chainage);
    const x0 = cx - bhWidth / 2;
    const yTop = yScale(sb.borehole.elev);
    const yBot = yScale(sb.borehole.elev - sb.borehole.finDepth);
    const offSection = Math.abs(sb.offset) > 0.5;

    out.push(`<g class="gfx-bh">`);

    // Background block — gives the strip a clear outline against the geology
    out.push(`<rect class="gfx-bh-bg" x="${(x0 - 1).toFixed(1)}" y="${yTop.toFixed(1)}" width="${(bhWidth + 2).toFixed(1)}" height="${Math.max(2, yBot - yTop).toFixed(1)}" fill="rgba(255,255,255,0.85)" stroke="none"/>`);

    // Lithology stack (colour + hatch overlay)
    for (const layer of sb.borehole.layers) {
      const y1 = yScale(layer.topElev);
      const y2 = yScale(layer.baseElev);
      const lh = Math.max(1, y2 - y1);
      out.push(`<rect x="${x0.toFixed(1)}" y="${y1.toFixed(1)}" width="${bhWidth.toFixed(1)}" height="${lh.toFixed(1)}" fill="${layer.color}" stroke="none"><title>${escSvg(layer.desc)} (${(layer.topDepth).toFixed(1)}–${(layer.baseDepth).toFixed(1)} m bgl)</title></rect>`);
      if (showHatch) {
        const h = layer.hatch || geolHatch(layer.desc);
        if (h && h !== 'none') {
          out.push(`<rect x="${x0.toFixed(1)}" y="${y1.toFixed(1)}" width="${bhWidth.toFixed(1)}" height="${lh.toFixed(1)}" fill="${hatchUrl(h)}" pointer-events="none"/>`);
        }
      }
      // Inter-layer contact line
      out.push(`<line x1="${x0.toFixed(1)}" y1="${y2.toFixed(1)}" x2="${(x0 + bhWidth).toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#0f172a" stroke-width="0.4"/>`);
    }

    // Borehole frame — heavier for off-section to flag projected holes
    if (offSection) {
      out.push(`<rect x="${x0.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bhWidth.toFixed(1)}" height="${Math.max(2, yBot - yTop).toFixed(1)}" fill="none" stroke="#0f172a" stroke-width="1" stroke-dasharray="3,2"/>`);
    } else {
      out.push(`<rect x="${x0.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bhWidth.toFixed(1)}" height="${Math.max(2, yBot - yTop).toFixed(1)}" fill="none" stroke="#0f172a" stroke-width="1"/>`);
    }

    // Depth ticks (every 2 m if pxPerZ tight, else every nice step)
    const depthStep = niceStep(sb.borehole.finDepth || 10) / 2;
    const tickX = x0 + bhWidth + 2;
    for (let d = 0; d <= sb.borehole.finDepth + 1e-9; d += depthStep) {
      const ty = yScale(sb.borehole.elev - d);
      out.push(`<line x1="${(x0 + bhWidth).toFixed(1)}" y1="${ty.toFixed(1)}" x2="${(tickX + 2).toFixed(1)}" y2="${ty.toFixed(1)}" stroke="#475569" stroke-width="0.5"/>`);
      // Only label major ticks (every 2nd) when they fit vertically
      const isMajor = Math.abs((d / (depthStep * 2)) - Math.round(d / (depthStep * 2))) < 1e-6;
      if (isMajor && (yBot - yTop) > 24) {
        out.push(`<text x="${(tickX + 4).toFixed(1)}" y="${(ty + 3).toFixed(1)}" font-size="8" fill="#64748b">${d.toFixed(0)}</text>`);
      }
    }

    // BH label + projection indicator
    if (showLabels) {
      out.push(`<text x="${cx.toFixed(1)}" y="${(yTop - 8).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#0f172a">${escSvg(sb.id)}</text>`);
      if (offSection) {
        out.push(`<text x="${cx.toFixed(1)}" y="${(yTop - 21).toFixed(1)}" text-anchor="middle" font-size="9" fill="#dc2626">⊥ ${sb.offset.toFixed(1)} m</text>`);
      }
      // Ground level at top
      out.push(`<text x="${cx.toFixed(1)}" y="${(yTop + 11).toFixed(1)}" text-anchor="middle" font-size="8.5" fill="#0f172a" paint-order="stroke" stroke="#ffffff" stroke-width="2" stroke-linejoin="round">${sb.borehole.elev.toFixed(1)}</text>`);
      // Total depth at base
      if (yBot - yTop > 30) {
        out.push(`<text x="${cx.toFixed(1)}" y="${(yBot + 11).toFixed(1)}" text-anchor="middle" font-size="8" fill="#475569">${sb.borehole.finDepth.toFixed(1)} m</text>`);
      }
    }

    out.push(`</g>`);
  }

  // ── Axes ─────────────────────────────────────────────────────────────────
  const elevStep = niceStep(data.elevMax - data.elevMin);
  const elevStart = Math.ceil(data.elevMin / elevStep) * elevStep;
  for (let z = elevStart; z <= data.elevMax + 1e-9; z += elevStep) {
    const y = yScale(z);
    out.push(`<line x1="${(margin.left - 5).toFixed(1)}" y1="${y.toFixed(1)}" x2="${margin.left.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#475569" stroke-width="0.8"/>`);
    out.push(`<text x="${(margin.left - 8).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="#334155">${z.toFixed(0)}</text>`);
  }
  out.push(`<text x="18" y="${(margin.top + plotH / 2).toFixed(1)}" font-size="11" font-weight="700" fill="#334155" transform="rotate(-90 18 ${(margin.top + plotH / 2).toFixed(1)})" text-anchor="middle">Elevation (m OD)</text>`);

  const chStep = niceStep(data.totalLength);
  for (let c = 0; c <= data.totalLength + 1e-9; c += chStep) {
    const x = xScale(c);
    const yA = margin.top + plotH;
    out.push(`<line x1="${x.toFixed(1)}" y1="${yA}" x2="${x.toFixed(1)}" y2="${(yA + 5).toFixed(1)}" stroke="#475569" stroke-width="0.8"/>`);
    out.push(`<text x="${x.toFixed(1)}" y="${(yA + 18).toFixed(1)}" text-anchor="middle" font-size="10" fill="#334155">${c.toFixed(0)}</text>`);
  }
  out.push(`<text x="${(margin.left + plotW / 2).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#334155">Chainage (m)</text>`);

  // ── A–A′ direction labels ────────────────────────────────────────────────
  if (showDirectionLabels) {
    const yLabel = margin.top - 6;
    // Left tag
    out.push(`<g>`);
    out.push(`<circle cx="${margin.left.toFixed(1)}" cy="${yLabel.toFixed(1)}" r="11" fill="#1f2937" stroke="#0f172a" stroke-width="0.8"/>`);
    out.push(`<text x="${margin.left.toFixed(1)}" y="${(yLabel + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#ffffff">${escSvg(startLabel)}</text>`);
    out.push(`</g>`);
    // Right tag
    out.push(`<g>`);
    out.push(`<circle cx="${(margin.left + plotW).toFixed(1)}" cy="${yLabel.toFixed(1)}" r="11" fill="#1f2937" stroke="#0f172a" stroke-width="0.8"/>`);
    out.push(`<text x="${(margin.left + plotW).toFixed(1)}" y="${(yLabel + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#ffffff">${escSvg(endLabel)}</text>`);
    out.push(`</g>`);
    // Subtle direction arrow line between them, behind the plot border
    out.push(`<line x1="${(margin.left + 12).toFixed(1)}" y1="${yLabel.toFixed(1)}" x2="${(margin.left + plotW - 12).toFixed(1)}" y2="${yLabel.toFixed(1)}" stroke="#94a3b8" stroke-width="0.8" stroke-dasharray="2,3"/>`);
  }

  // ── Scale bar (in the plot, lower-right corner) ──────────────────────────
  if (showScaleBar && plotW > 220) {
    const targetPx = Math.min(160, plotW * 0.22);
    const targetM = targetPx / pxPerX;
    const niceM = niceScaleBar(targetM);
    const barPx = niceM * pxPerX;
    const xR = margin.left + plotW - 16;
    const xL = xR - barPx;
    const yBar = margin.top + plotH - 22;
    // Background pill
    out.push(`<rect x="${(xL - 8).toFixed(1)}" y="${(yBar - 12).toFixed(1)}" width="${(barPx + 16).toFixed(1)}" height="28" fill="#ffffff" fill-opacity="0.85" stroke="#cbd5e1" stroke-width="0.7" rx="3"/>`);
    out.push(`<line x1="${xL.toFixed(1)}" y1="${yBar.toFixed(1)}" x2="${xR.toFixed(1)}" y2="${yBar.toFixed(1)}" stroke="#0f172a" stroke-width="1.8"/>`);
    out.push(`<line x1="${xL.toFixed(1)}" y1="${(yBar - 4).toFixed(1)}" x2="${xL.toFixed(1)}" y2="${(yBar + 4).toFixed(1)}" stroke="#0f172a" stroke-width="1.4"/>`);
    out.push(`<line x1="${xR.toFixed(1)}" y1="${(yBar - 4).toFixed(1)}" x2="${xR.toFixed(1)}" y2="${(yBar + 4).toFixed(1)}" stroke="#0f172a" stroke-width="1.4"/>`);
    out.push(`<line x1="${((xL + xR) / 2).toFixed(1)}" y1="${(yBar - 3).toFixed(1)}" x2="${((xL + xR) / 2).toFixed(1)}" y2="${(yBar + 3).toFixed(1)}" stroke="#0f172a" stroke-width="1"/>`);
    out.push(`<text x="${((xL + xR) / 2).toFixed(1)}" y="${(yBar - 6).toFixed(1)}" text-anchor="middle" font-size="9.5" font-weight="600" fill="#0f172a">${niceM.toFixed(0)} m  ·  V.E. ×${vexag.toFixed(2)}</text>`);
  }

  // ── Legend (right rail) ──────────────────────────────────────────────────
  if (showLegend) {
    const lx = W - margin.right + 12;
    const lw = margin.right - 24;
    let ly = margin.top;
    out.push(`<rect x="${(lx - 6).toFixed(1)}" y="${(ly - 4).toFixed(1)}" width="${(lw).toFixed(1)}" height="${(plotH).toFixed(1)}" fill="#f8fafc" stroke="#cbd5e1" stroke-width="0.7" rx="3"/>`);
    out.push(`<text x="${lx}" y="${(ly + 12).toFixed(1)}" font-size="11" font-weight="700" fill="#0f172a">Stratigraphy</text>`);
    out.push(`<line x1="${lx}" y1="${(ly + 18).toFixed(1)}" x2="${(lx + lw - 12).toFixed(1)}" y2="${(ly + 18).toFixed(1)}" stroke="#cbd5e1" stroke-width="0.6"/>`);
    ly += 26;
    for (const [key, entry] of unitList) {
      if (ly > margin.top + plotH - 18) {
        out.push(`<text x="${lx}" y="${ly.toFixed(1)}" font-size="9" fill="#64748b" font-style="italic">…and more</text>`);
        break;
      }
      // Swatch (colour + hatch)
      out.push(`<rect x="${lx}" y="${(ly - 10).toFixed(1)}" width="16" height="12" fill="${entry.color}" stroke="#334155" stroke-width="0.6"/>`);
      if (showHatch && entry.hatch && entry.hatch !== 'none') {
        out.push(`<rect x="${lx}" y="${(ly - 10).toFixed(1)}" width="16" height="12" fill="${hatchUrl(entry.hatch)}"/>`);
      }
      out.push(`<text x="${(lx + 22).toFixed(1)}" y="${(ly - 1).toFixed(1)}" font-size="10" font-weight="600" fill="#0f172a">${escSvg(truncate(key, 18))}</text>`);
      const descText = truncate(entry.desc || '', 26);
      if (descText && descText !== key) {
        out.push(`<text x="${(lx + 22).toFixed(1)}" y="${(ly + 9).toFixed(1)}" font-size="9" fill="#64748b">${escSvg(descText)}</text>`);
        ly += 22;
      } else {
        ly += 16;
      }
    }
  }

  out.push("</svg>");
  return out.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function niceStep(range: number): number {
  if (range <= 0) return 1;
  const target = range / 6;
  const exp = Math.pow(10, Math.floor(Math.log10(target)));
  const mant = target / exp;
  let nice = 10;
  if (mant <= 1) nice = 1;
  else if (mant <= 2) nice = 2;
  else if (mant <= 5) nice = 5;
  return nice * exp;
}

/**
 * Pick a "nice" scale-bar length close to the target metres value. Returns
 * values like 1, 2, 5, 10, 20, 50, 100, 200 — same family as niceStep but
 * rounded toward the nearest, not toward 6 ticks.
 */
function niceScaleBar(targetM: number): number {
  if (targetM <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(targetM)));
  const mant = targetM / exp;
  let nice = 10;
  if (mant < 1.5) nice = 1;
  else if (mant < 3.5) nice = 2;
  else if (mant < 7.5) nice = 5;
  return nice * exp;
}

function escSvg(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Lightweight helper exposed for callers that want to know the per-layer
 * polygon coordinates without rendering the SVG (e.g. an interactive React
 * cross-section that wants hover behaviour). Returns chainage/elev arrays
 * per unit.
 */
export function extractSectionPolygons(
  model: Geo3DModel,
  boreholeIds: string[],
): Array<{
  unitKey: string;
  desc: string;
  color: string;
  topEdge: Array<{ chainage: number; elev: number }>;
  baseEdge: Array<{ chainage: number; elev: number }>;
}> {
  const data = buildSectionData(model, boreholeIds, "fence");
  if (!data) return [];
  const units = collectUnitObservations(data.boreholes);
  const out: ReturnType<typeof extractSectionPolygons> = [];
  for (const [unitKey, entry] of units) {
    const topEdge = entry.obs.map(o => ({ chainage: o.chainage, elev: o.topElev })).sort((a, b) => a.chainage - b.chainage);
    const baseEdge = entry.obs.map(o => ({ chainage: o.chainage, elev: o.baseElev })).sort((a, b) => a.chainage - b.chainage);
    out.push({ unitKey, desc: entry.desc, color: entry.color, topEdge, baseEdge });
  }
  return out;
}

/**
 * Pixel-height suggestion given an SVG width and the section's natural
 * aspect ratio. Used by the UI when no explicit height is supplied.
 */
export function suggestSvgHeight(data: CrossSectionData, width: number): number {
  const ratio = (data.elevMax - data.elevMin) / Math.max(data.totalLength, 1);
  return Math.max(320, Math.min(680, Math.round(width * Math.min(0.7, ratio * 4))));
}

/** Unused helper kept exported in case future renderers want it. */
export type { GeoLayer };
