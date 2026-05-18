/**
 * skeleton.ts — derive a GEOL-primary layer skeleton in RL for a group of
 * boreholes.
 *
 * Reuses `representativeGroundModel` from @geoflow/core which produces
 * majority-voted layers in depth space, then converts to RL using the
 * mean LOCA_GL across contributing holes (so a single column spans all
 * holes regardless of their individual ground levels).
 *
 * Also exposes per-source boundary suggestions:
 *   - GEOL: every distinct top RL in the input boreholes
 *   - ISPT: simple change-point detection on N-value vs depth
 * The user picks which to accept in the LayersStep UI.
 */

import type { AgsFile } from '@geoflow/core';
import { representativeGroundModel } from '@geoflow/core';
import type { BoundarySuggestion, Layer } from './model.js';
import { defaultParameterValues } from './model.js';
import { locaGroundLevels } from './samples.js';

/** Hash-based pastel colour seeded by the unit key — stable across reloads. */
function colorForUnit(unitKey: string): string {
  let h = 0;
  for (let i = 0; i < unitKey.length; i++) {
    h = (h * 31 + unitKey.charCodeAt(i)) & 0xffff;
  }
  // Recognised lithology cues — mirror the @geoflow/web geolColor palette.
  const u = unitKey.toUpperCase();
  if (u.includes('MADE') || u.includes('FILL') || u.includes('TS')) return '#A0785A';
  if (u.includes('PEAT')) return '#3D2B1F';
  if (u.includes('CHALK') || u === 'CK') return '#E8E4A0';
  if (u.includes('CLAY') || u === 'CL' || u === 'LC') return '#7B9EC5';
  if (u.includes('SILT') || u === 'ML' || u === 'MH') return '#C4A87C';
  if (u.includes('GRAVEL') || u === 'GR' || u === 'GP' || u === 'GW') return '#C87A45';
  if (u.includes('SAND') || u === 'SA' || u === 'SP' || u === 'SW') return '#E8C840';
  if (u.includes('ROCK') || u === 'RX' || u.includes('STONE')) return '#9090A0';
  // Fallback: pick from a small pastel ring.
  const ring = ['#A8C5A1', '#C5A8B5', '#A1B5C5', '#C5C0A1', '#B5A1C5', '#A1C5C0'];
  return ring[h % ring.length]!;
}

export interface BuildSkeletonOptions {
  sampleStep?: number;
  minSupport?: number;
}

export interface SkeletonResult {
  /** Mean ground level used to convert depth → RL (mAOD). */
  meanGL: number;
  /** Layer stack in RL, top→base. May be empty for sparse data. */
  layers: Layer[];
  /** Boundary candidates from every signal source. */
  boundaries: BoundarySuggestion[];
}

/**
 * Build the initial layer skeleton from GEOL + emit boundary suggestions
 * from other signals.
 */
export function buildSkeleton(
  file: AgsFile,
  locaIds: ReadonlyArray<string>,
  opts: BuildSkeletonOptions = {},
): SkeletonResult {
  const sampleStep = opts.sampleStep ?? 0.25;
  const gls = locaGroundLevels(file);
  const usable = locaIds.filter((id) => gls.has(id));
  const meanGL = usable.length === 0
    ? 0
    : usable.reduce((a, id) => a + (gls.get(id) ?? 0), 0) / usable.length;

  const rep = representativeGroundModel(file, [...locaIds], {
    sampleStep,
    minSupport: opts.minSupport ?? 0,
  });

  const layers: Layer[] = rep.layers.map((l, i) => ({
    id: `layer-${i + 1}`,
    topRL: round(meanGL - l.top, 2),
    baseRL: round(meanGL - l.base, 2),
    unitKey: l.unitKey,
    name: l.unitKey || `Layer ${i + 1}`,
    description: l.desc,
    color: colorForUnit(l.unitKey),
    parameters: defaultParameterValues(),
  }));

  const boundaries: BoundarySuggestion[] = [];

  // GEOL boundaries: every distinct top from each borehole.
  const seenGeolRL = new Set<number>();
  for (const row of file.groups['GEOL']?.rows ?? []) {
    const id = String(row['LOCA_ID'] ?? '').trim();
    if (!id || !locaIds.includes(id)) continue;
    const gl = gls.get(id);
    if (gl == null) continue;
    const top = Number(row['GEOL_TOP']);
    if (!Number.isFinite(top)) continue;
    const rl = round(gl - top, 2);
    if (seenGeolRL.has(rl)) continue;
    seenGeolRL.add(rl);
    boundaries.push({ rl, source: 'GEOL', confidence: 0.8, note: 'GEOL contact' });
  }

  // ISPT change-points: simple sliding-window mean-shift detector.
  const isptByLoca = new Map<string, Array<{ rl: number; n: number }>>();
  for (const row of file.groups['ISPT']?.rows ?? []) {
    const id = String(row['LOCA_ID'] ?? '').trim();
    if (!id || !locaIds.includes(id)) continue;
    const gl = gls.get(id);
    if (gl == null) continue;
    const depth = Number(row['ISPT_TOP'] ?? row['ISPT_DPTH'] ?? row['SAMP_TOP']);
    if (!Number.isFinite(depth)) continue;
    const direct = Number(row['ISPT_NVAL']);
    const n = Number.isFinite(direct) ? direct : parseSptN(String(row['ISPT_NVAL'] ?? ''));
    if (n == null) continue;
    const arr = isptByLoca.get(id) ?? [];
    arr.push({ rl: gl - depth, n });
    isptByLoca.set(id, arr);
  }
  for (const [, series] of isptByLoca) {
    series.sort((a, b) => b.rl - a.rl); // top→bottom
    if (series.length < 4) continue;
    for (let i = 2; i < series.length - 1; i++) {
      const before = mean(series.slice(Math.max(0, i - 3), i).map((s) => s.n));
      const after = mean(series.slice(i, Math.min(series.length, i + 3)).map((s) => s.n));
      const ratio = after === 0 ? Infinity : Math.abs(after - before) / Math.max(before, after, 1);
      if (ratio > 0.7) {
        boundaries.push({
          rl: round((series[i]!.rl + series[i - 1]!.rl) / 2, 2),
          source: 'ISPT',
          confidence: Math.min(1, ratio),
          note: `SPT N step ${before.toFixed(0)} → ${after.toFixed(0)}`,
        });
      }
    }
  }

  return { meanGL: round(meanGL, 2), layers, boundaries };
}

function parseSptN(raw: string): number | null {
  if (!raw) return null;
  const slash = raw.match(/^(\d+)\s*\//);
  if (slash) return parseInt(slash[1]!, 10);
  if (/^R(EF(USAL)?)?$/i.test(raw)) return 50;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, x) => a + x, 0) / xs.length;
}

function round(v: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}
