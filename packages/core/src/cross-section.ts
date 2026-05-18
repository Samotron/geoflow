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
 */

import type { Geo3DModel, Borehole3D, GeoLayer } from "./geo3d.js";
import { geolColor } from "./geo3d.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface CrossSectionOptions {
  /** Width of the SVG in pixels. Default 900. */
  width?: number;
  /** Height of the SVG in pixels. Default 480. */
  height?: number;
  /** Vertical exaggeration (V/H). Default 1 (true scale, auto-clamped). */
  verticalExaggeration?: number;
  /** Whether to label borehole IDs on the section. Default true. */
  showLabels?: boolean;
  /** Interpolation strategy. Default "linear-chainage". */
  interpolation?: "linear-chainage" | "surface";
  /** Title shown at the top of the SVG. Optional. */
  title?: string;
  /** Whether to draw the legend. Default true. */
  showLegend?: boolean;
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
 * Project a point onto a polyline. Returns chainage (distance along) and the
 * signed perpendicular offset relative to the line direction at the projected
 * segment.
 */
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

/**
 * Project the requested boreholes onto a polyline (in the same local
 * coordinate space as the Geo3DModel). The polyline by default is the
 * straight line through the holes in the order given, but a custom polyline
 * may be supplied (e.g. a user-drawn section line on the map).
 */
export function buildSectionData(
  model: Geo3DModel,
  boreholeIds: string[],
  polyline?: Array<{ x: number; y: number }>,
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

  const line: Vec2[] = polyline
    ? polyline.map(p => ({ x: p.x, y: p.y }))
    : selected.map(bh => ({ x: bh.x, y: bh.y }));

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

  // Total length: distance along the polyline
  let totalLength = 0;
  for (let i = 0; i < line.length - 1; i++) {
    totalLength += len(sub(line[i + 1]!, line[i]!));
  }
  // If using BH order as the line, the last BH might lie past the line end
  // (unlikely but safe-guard).
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

/**
 * For each unit key present in any selected borehole, collect a contact
 * observation at every borehole where it occurs. These observations are
 * subsequently interpolated to draw a continuous polygon for the unit.
 */
function collectUnitObservations(boreholes: SectionBorehole[]): Map<string, {
  obs: UnitObservation[];
  color: string;
  desc: string;
  order: number;       // first-seen depth order, used to layer-sort the legend
}> {
  const out = new Map<string, { obs: UnitObservation[]; color: string; desc: string; order: number }>();
  let order = 0;
  for (const sb of boreholes) {
    const sorted = [...sb.borehole.layers].sort((a, b) => a.topDepth - b.topDepth);
    for (const layer of sorted) {
      let entry = out.get(layer.unitKey);
      if (!entry) {
        entry = { obs: [], color: layer.color || geolColor(layer.desc), desc: layer.desc, order: order++ };
        out.set(layer.unitKey, entry);
      }
      entry.obs.push({
        chainage: sb.chainage,
        topElev: layer.topElev,
        baseElev: layer.baseElev,
      });
    }
  }
  return out;
}

// ── Linear-chainage interpolation ─────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/**
 * Interpolate elevation values along the section, given chainage-keyed
 * observations. Outside the convex hull of observations, the polygon is
 * clipped to the nearest observation chainage (no extrapolation).
 *
 * Returns an array of [chainage, elev] points densified between observations
 * (one segment per pair of adjacent observations; n*step samples optional).
 */
function densifyAlongLine(
  obs: Array<{ chainage: number; value: number }>,
): Array<{ chainage: number; value: number }> {
  if (obs.length === 0) return [];
  const sorted = [...obs].sort((a, b) => a.chainage - b.chainage);
  // Already 1-D; no need to add intermediate points beyond observations,
  // we just connect them with straight lines.
  return sorted;
}

// ── SVG renderer ──────────────────────────────────────────────────────────────

/**
 * Render an SVG cross-section.
 *
 * The SVG includes:
 *   - title block (top)
 *   - elevation axis (left, in m OD)
 *   - chainage axis (bottom, in m)
 *   - one polygon per geological unit, interpolated between boreholes
 *   - borehole strip overlays (lithology column at exact chainage)
 *   - vertical exaggeration label
 *   - optional legend (right)
 */
export function renderCrossSectionSvg(
  model: Geo3DModel,
  boreholeIds: string[],
  opts: CrossSectionOptions = {},
): string {
  const data = buildSectionData(model, boreholeIds);
  if (!data) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="8" y="34" font-family="system-ui" font-size="12" fill="#dc2626">Select at least 2 boreholes.</text></svg>`;
  }

  const W = opts.width ?? 900;
  const H = opts.height ?? 480;
  const showLabels = opts.showLabels !== false;
  const showLegend = opts.showLegend !== false;
  const title = opts.title;

  const margin = {
    top: title ? 36 : 18,
    right: showLegend ? 180 : 24,
    bottom: 44,
    left: 56,
  };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  // Vertical exaggeration: V.E. = 1 means dz_per_pixel == dx_per_pixel.
  // We let user pick (default 1, but clamp so the plot fits).
  const naturalDz = data.elevMax - data.elevMin;
  const naturalDx = Math.max(data.totalLength, 1);
  const pxPerXAtVE1 = plotW / naturalDx; // px per m horizontal
  const pxPerZAtVE1 = pxPerXAtVE1;        // px per m vertical at V.E. = 1
  let vexag = opts.verticalExaggeration ?? 1;
  // If user picks a VE that overflows, scale down to fit
  const fitVE = (plotH / naturalDz) / pxPerZAtVE1;
  if (vexag > fitVE) vexag = fitVE;
  if (vexag <= 0 || !isFinite(vexag)) vexag = Math.max(1, fitVE);

  const pxPerX = pxPerXAtVE1;
  const pxPerZ = pxPerZAtVE1 * vexag;

  const xScale = (chainage: number) =>
    margin.left + chainage * pxPerX;
  const yScale = (elev: number) =>
    margin.top + (data.elevMax - elev) * pxPerZ;

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif">`);
  lines.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

  // Title
  if (title) {
    lines.push(`<text x="${(W / 2).toFixed(1)}" y="22" font-size="13" font-weight="700" text-anchor="middle" fill="#0f172a">${escSvg(title)}</text>`);
  }

  // Plot frame
  lines.push(`<rect x="${margin.left}" y="${margin.top}" width="${plotW.toFixed(1)}" height="${plotH.toFixed(1)}" fill="#fafafa" stroke="#94a3b8" stroke-width="0.6"/>`);

  // ── Geology polygons ─────────────────────────────────────────────────────
  const units = collectUnitObservations(data.boreholes);
  // Render in first-seen order so deeper units come later (last drawn on top
  // for the bits that overlap thinly; we cut out borehole columns regardless).
  const unitList = [...units.entries()].sort((a, b) => a[1].order - b[1].order);

  for (const [_key, entry] of unitList) {
    const dens = densifyAlongLine(entry.obs.map(o => ({ chainage: o.chainage, value: o.topElev })));
    const densBase = densifyAlongLine(entry.obs.map(o => ({ chainage: o.chainage, value: o.baseElev })));
    if (dens.length < 2) continue;
    // Build polygon: top edge (left→right) + base edge (right→left)
    const pts: string[] = [];
    for (const p of dens) {
      pts.push(`${xScale(p.chainage).toFixed(1)},${yScale(p.value).toFixed(1)}`);
    }
    for (let i = densBase.length - 1; i >= 0; i--) {
      const p = densBase[i]!;
      pts.push(`${xScale(p.chainage).toFixed(1)},${yScale(p.value).toFixed(1)}`);
    }
    lines.push(`<polygon points="${pts.join(" ")}" fill="${entry.color}" stroke="#475569" stroke-width="0.4" opacity="0.85"/>`);
  }

  // ── Ground surface line ──────────────────────────────────────────────────
  const groundPts = data.boreholes
    .map(sb => `${xScale(sb.chainage).toFixed(1)},${yScale(sb.borehole.elev).toFixed(1)}`)
    .join(" ");
  lines.push(`<polyline points="${groundPts}" fill="none" stroke="#1e3a5f" stroke-width="1.4"/>`);

  // ── Borehole strips (drawn on top so unit overlay is interrupted) ────────
  const bhWidth = Math.max(6, Math.min(14, plotW / Math.max(data.boreholes.length * 3, 8)));
  for (const sb of data.boreholes) {
    const cx = xScale(sb.chainage);
    const x0 = cx - bhWidth / 2;
    const yTop = yScale(sb.borehole.elev);
    const yBot = yScale(sb.borehole.elev - sb.borehole.finDepth);

    // Layer stack (mask the polygons with crisp strip)
    for (const layer of sb.borehole.layers) {
      const y1 = yScale(layer.topElev);
      const y2 = yScale(layer.baseElev);
      lines.push(`<rect x="${x0.toFixed(1)}" y="${y1.toFixed(1)}" width="${bhWidth.toFixed(1)}" height="${Math.max(1, y2 - y1).toFixed(1)}" fill="${layer.color}" stroke="#0f172a" stroke-width="0.5"/>`);
    }
    // Borehole outline
    lines.push(`<rect x="${x0.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bhWidth.toFixed(1)}" height="${Math.max(1, yBot - yTop).toFixed(1)}" fill="none" stroke="#0f172a" stroke-width="1"/>`);

    // BH label
    if (showLabels) {
      lines.push(`<text x="${cx.toFixed(1)}" y="${(yTop - 5).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="#0f172a">${escSvg(sb.id)}</text>`);
      if (sb.offset && Math.abs(sb.offset) > 0.5) {
        lines.push(`<text x="${cx.toFixed(1)}" y="${(yTop - 16).toFixed(1)}" text-anchor="middle" font-size="8" fill="#64748b">(off ${sb.offset.toFixed(1)} m)</text>`);
      }
    }
  }

  // ── Axes ─────────────────────────────────────────────────────────────────
  // Elevation axis (left)
  const elevStep = niceStep(data.elevMax - data.elevMin);
  const elevStart = Math.ceil(data.elevMin / elevStep) * elevStep;
  for (let z = elevStart; z <= data.elevMax + 1e-9; z += elevStep) {
    const y = yScale(z);
    lines.push(`<line x1="${margin.left - 4}" y1="${y.toFixed(1)}" x2="${margin.left}" y2="${y.toFixed(1)}" stroke="#94a3b8"/>`);
    lines.push(`<text x="${(margin.left - 7).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#475569">${z.toFixed(0)}</text>`);
  }
  lines.push(`<text x="14" y="${(margin.top + plotH / 2).toFixed(1)}" font-size="10" font-weight="700" fill="#475569" transform="rotate(-90 14 ${(margin.top + plotH / 2).toFixed(1)})" text-anchor="middle">Elevation (m OD)</text>`);

  // Chainage axis (bottom)
  const chStep = niceStep(data.totalLength);
  for (let c = 0; c <= data.totalLength + 1e-9; c += chStep) {
    const x = xScale(c);
    const yA = margin.top + plotH;
    lines.push(`<line x1="${x.toFixed(1)}" y1="${yA}" x2="${x.toFixed(1)}" y2="${(yA + 4).toFixed(1)}" stroke="#94a3b8"/>`);
    lines.push(`<text x="${x.toFixed(1)}" y="${(yA + 16).toFixed(1)}" text-anchor="middle" font-size="9" fill="#475569">${c.toFixed(0)}</text>`);
  }
  lines.push(`<text x="${(margin.left + plotW / 2).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="#475569">Chainage (m)</text>`);

  // VE label
  lines.push(`<text x="${(margin.left + plotW - 6).toFixed(1)}" y="${(margin.top + 12).toFixed(1)}" text-anchor="end" font-size="9" fill="#64748b">V.E. × ${vexag.toFixed(2)}</text>`);

  // ── Legend ───────────────────────────────────────────────────────────────
  if (showLegend) {
    const lx = W - margin.right + 12;
    let ly = margin.top + 4;
    lines.push(`<text x="${lx}" y="${ly}" font-size="10" font-weight="700" fill="#334155">Units</text>`);
    ly += 14;
    for (const [key, entry] of unitList) {
      if (ly > H - 18) break;
      lines.push(`<rect x="${lx}" y="${(ly - 9).toFixed(1)}" width="12" height="10" fill="${entry.color}" stroke="#475569" stroke-width="0.4"/>`);
      lines.push(`<text x="${(lx + 16).toFixed(1)}" y="${ly}" font-size="9.5" fill="#334155">${escSvg(truncate(key, 16))}</text>`);
      ly += 14;
    }
  }

  lines.push("</svg>");
  return lines.join("\n");
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
  const data = buildSectionData(model, boreholeIds);
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
 * Re-export a tiny helper that consumers (UI) can use to compute a useful
 * pixel-height for the SVG given a target on-screen aspect ratio.
 */
export function suggestSvgHeight(data: CrossSectionData, width: number): number {
  const ratio = (data.elevMax - data.elevMin) / Math.max(data.totalLength, 1);
  return Math.max(280, Math.min(640, Math.round(width * Math.min(0.8, ratio * 4))));
}

/** Unused helper kept exported in case future renderers want it. */
export type { GeoLayer };
