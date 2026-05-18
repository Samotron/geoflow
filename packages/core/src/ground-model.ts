/**
 * ground-model.ts — derive a single representative stratigraphy for a set of
 * boreholes.
 *
 * Used by the web UI when a user defines a "location group" — given the GEOL
 * records of N boreholes, what's the typical ground profile across that
 * group?  This is useful for screening-level design, reporting, and as a
 * starting point for hand-edited ground models.
 *
 * The approach is intentionally simple and explainable:
 *
 *   1. Sample each borehole's GEOL stack at a uniform vertical resolution
 *      (0.25 m by default) producing a `(depth, unit-key)` series per
 *      borehole.
 *   2. At every depth, find the unit-key that the *majority* of boreholes
 *      report. This is the "mode" stratigraphy.
 *   3. Coalesce adjacent depth bins that share the same unit-key into
 *      contiguous representative layers.
 *
 * Two additional metrics support QA:
 *   - `support` (per layer): fraction of contributing boreholes that report
 *     the same unit-key at that depth — a 0–1 confidence score.
 *   - `boreholesAtDepth` (per layer): how many boreholes still have data at
 *     that depth (some are shallower than others).
 *
 * Boreholes that have no GEOL rows are silently excluded. If fewer than 2
 * boreholes are supplied, returns an empty model.
 */

import type { AgsFile, AgsRow } from './model.js';

export interface RepresentativeLayer {
  /** Top depth below ground (m). */
  top: number;
  /** Base depth below ground (m). */
  base: number;
  /** Layer thickness (m). */
  thickness: number;
  /** Most common GEOL_GEOL / GEOL_LEG / description at this depth. */
  unitKey: string;
  /** Sample description text from the borehole that most agrees with this unit. */
  desc: string;
  /** Fraction of contributing boreholes that agree on `unitKey` here (0–1). */
  support: number;
  /** Number of boreholes that still have GEOL data at this depth. */
  boreholesAtDepth: number;
}

export interface RepresentativeGroundModel {
  /** Identifiers of the boreholes that contributed (after filtering out empty ones). */
  contributingLocaIds: string[];
  /** Deepest depth covered by at least one borehole (m). */
  maxDepth: number;
  /** Vertical step used during sampling (m). */
  sampleStep: number;
  /** Representative layer stack, top → base. Empty if input is insufficient. */
  layers: RepresentativeLayer[];
}

export interface RepresentativeGroundModelOptions {
  /** Vertical sample step (m). Default 0.25. Smaller = more detail, more memory. */
  sampleStep?: number;
  /** Minimum support fraction (0–1) for a layer to be emitted. Default 0 (always emit). */
  minSupport?: number;
}

interface BoreholeStack {
  locaId: string;
  layers: Array<{ top: number; base: number; key: string; desc: string }>;
}

/**
 * Build a representative ground model from the GEOL rows of a subset of
 * boreholes.  Pass only the `locaIds` belonging to a location group.
 */
export function representativeGroundModel(
  file: AgsFile,
  locaIds: string[],
  opts: RepresentativeGroundModelOptions = {},
): RepresentativeGroundModel {
  const sampleStep = Math.max(0.05, opts.sampleStep ?? 0.25);
  const minSupport = Math.max(0, Math.min(1, opts.minSupport ?? 0));

  const idSet = new Set(locaIds);
  const stacks: BoreholeStack[] = [];

  for (const row of file.groups.GEOL?.rows ?? []) {
    const id = String(row['LOCA_ID'] ?? '').trim();
    if (!id || !idSet.has(id)) continue;
    const top = numericValue(row['GEOL_TOP']);
    const base = numericValue(row['GEOL_BASE']);
    if (top === null || base === null || base <= top) continue;
    const key = canonicalUnitKey(row);
    if (!key) continue;
    const desc = stringValue(row['GEOL_DESC']) ?? '';

    let stack = stacks.find((s) => s.locaId === id);
    if (!stack) {
      stack = { locaId: id, layers: [] };
      stacks.push(stack);
    }
    stack.layers.push({ top, base, key, desc });
  }

  if (stacks.length < 2) {
    return {
      contributingLocaIds: stacks.map((s) => s.locaId),
      maxDepth: 0,
      sampleStep,
      layers: [],
    };
  }

  // Sort each borehole's layers top-down for consistent sampling
  for (const s of stacks) s.layers.sort((a, b) => a.top - b.top);

  const maxDepth = Math.max(...stacks.map((s) => {
    const last = s.layers[s.layers.length - 1];
    return last ? last.base : 0;
  }));
  if (maxDepth <= 0) {
    return { contributingLocaIds: stacks.map((s) => s.locaId), maxDepth: 0, sampleStep, layers: [] };
  }

  // Slice at sampleStep intervals; at each slice tally unit votes
  const nSlices = Math.ceil(maxDepth / sampleStep);
  interface SliceResult {
    midDepth: number;
    unitKey: string;
    desc: string;
    support: number;
    available: number;
  }
  const slices: SliceResult[] = [];

  for (let i = 0; i < nSlices; i++) {
    const mid = (i + 0.5) * sampleStep;
    const votes = new Map<string, { count: number; desc: string }>();
    let available = 0;
    for (const s of stacks) {
      const hit = s.layers.find((l) => mid >= l.top && mid < l.base);
      if (!hit) continue;
      available++;
      const v = votes.get(hit.key);
      if (v) v.count++;
      else votes.set(hit.key, { count: 1, desc: hit.desc });
    }
    if (available === 0) continue;
    // Pick the winner — break ties by lexicographic key for determinism
    let bestKey = '';
    let bestCount = 0;
    let bestDesc = '';
    for (const [key, v] of votes) {
      if (v.count > bestCount || (v.count === bestCount && key < bestKey)) {
        bestCount = v.count;
        bestKey = key;
        bestDesc = v.desc;
      }
    }
    slices.push({ midDepth: mid, unitKey: bestKey, desc: bestDesc, support: bestCount / available, available });
  }

  // Coalesce consecutive slices that share unitKey into layers
  const layers: RepresentativeLayer[] = [];
  let cur: { top: number; base: number; key: string; desc: string; supportSum: number; n: number; available: number } | null = null;
  for (const sl of slices) {
    const top = sl.midDepth - sampleStep / 2;
    const base = sl.midDepth + sampleStep / 2;
    if (cur && cur.key === sl.unitKey && Math.abs(top - cur.base) < 1e-6) {
      cur.base = base;
      cur.supportSum += sl.support;
      cur.n++;
      cur.available = Math.max(cur.available, sl.available);
    } else {
      if (cur && (cur.supportSum / cur.n) >= minSupport) {
        layers.push(finalizeLayer(cur));
      }
      cur = { top, base, key: sl.unitKey, desc: sl.desc, supportSum: sl.support, n: 1, available: sl.available };
    }
  }
  if (cur && (cur.supportSum / cur.n) >= minSupport) {
    layers.push(finalizeLayer(cur));
  }

  return {
    contributingLocaIds: stacks.map((s) => s.locaId),
    maxDepth,
    sampleStep,
    layers,
  };
}

function finalizeLayer(c: { top: number; base: number; key: string; desc: string; supportSum: number; n: number; available: number }): RepresentativeLayer {
  return {
    top: round(c.top, 2),
    base: round(c.base, 2),
    thickness: round(c.base - c.top, 2),
    unitKey: c.key,
    desc: c.desc,
    support: round(c.supportSum / c.n, 3),
    boreholesAtDepth: c.available,
  };
}

function canonicalUnitKey(row: AgsRow): string {
  const candidates = [row['GEOL_GEOL'], row['GEOL_LEG'], row['GEOL_DESC']];
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const s = String(c).trim();
    if (s) return s.toUpperCase().slice(0, 32);
  }
  return '';
}

function numericValue(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function stringValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function round(v: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}
