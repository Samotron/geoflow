/**
 * samples.ts — pull per-layer samples from an AGS file, keyed by RL.
 *
 * The ground-model UI needs to ask: "for these N LOCA_IDs and this top/base
 * RL range, what {SPT, MC, LL, PL, PI, density, cu, k} samples do I have?"
 * Every returned sample carries a SampleRef so the user can drill back to
 * the source row.
 *
 * RL is computed as `LOCA_GL - depth`. Rows from holes that have no
 * LOCA_GL are skipped — there's no way to put them on the model axis.
 */

import type { AgsFile, AgsRow } from '@geoflow/core';
import type { SampleRef } from './model.js';

export interface Sample {
  /** Numeric value as supplied by the source row. */
  value: number;
  /** Reduced level (mAOD). */
  rl: number;
  /** Depth below ground (m). */
  depth: number;
  /** Where the sample came from. */
  ref: SampleRef;
}

/** Sample channel identifier — mirrors the AGS groups/fields we care about. */
export type ChannelKey =
  | 'spt_n'
  | 'mc'
  | 'll'
  | 'pl'
  | 'pi'
  | 'bulk_density'
  | 'dry_density'
  | 'cu'
  | 'k';

export interface ChannelMeta {
  key: ChannelKey;
  label: string;
  units: string;
  /** Which parameter this channel most informs (used to hint at the UI). */
  parameterHint: 'gamma' | 'phi' | 'c' | 'cu' | 'E' | 'k' | null;
}

export const CHANNELS: ReadonlyArray<ChannelMeta> = [
  { key: 'spt_n',        label: 'SPT N',          units: 'blows/300mm', parameterHint: 'phi' },
  { key: 'cu',           label: 'cu',             units: 'kPa',         parameterHint: 'cu' },
  { key: 'mc',           label: 'Moisture',       units: '%',           parameterHint: null },
  { key: 'll',           label: 'Liquid Limit',   units: '%',           parameterHint: null },
  { key: 'pl',           label: 'Plastic Limit',  units: '%',           parameterHint: null },
  { key: 'pi',           label: 'Plasticity Idx', units: '%',           parameterHint: null },
  { key: 'bulk_density', label: 'Bulk density',   units: 'Mg/m³',       parameterHint: 'gamma' },
  { key: 'dry_density',  label: 'Dry density',    units: 'Mg/m³',       parameterHint: 'gamma' },
  { key: 'k',            label: 'Permeability',   units: 'm/s',         parameterHint: 'k' },
];

const CHANNEL_BY_KEY = new Map<ChannelKey, ChannelMeta>(CHANNELS.map((c) => [c.key, c]));

export function channelMeta(key: ChannelKey): ChannelMeta {
  return CHANNEL_BY_KEY.get(key)!;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse ISPT_NVAL, tolerating refusal annotations commonly seen in field
 * data. Mirrors the helper in `apps/web/src/plots/shared.tsx`.
 */
function sptNValue(row: AgsRow): number | null {
  const direct = num(row['ISPT_NVAL']);
  if (direct != null) return direct;
  const raw = String(row['ISPT_NVAL'] ?? '').trim();
  if (!raw) return null;
  const slash = raw.match(/^(\d+)\s*\//);
  if (slash) return parseInt(slash[1]!, 10);
  if (/^R(EF(USAL)?)?$/i.test(raw)) return 50;
  return null;
}

/** Build a LOCA_ID → LOCA_GL lookup. */
export function locaGroundLevels(file: AgsFile): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of file.groups['LOCA']?.rows ?? []) {
    const id = String(r['LOCA_ID'] ?? '').trim();
    const gl = num(r['LOCA_GL']);
    if (id && gl != null) m.set(id, gl);
  }
  return m;
}

interface ChannelExtractor {
  /** AGS groups to read from (first hit wins for that key). */
  groups: string[];
  /** Per-group: { value field, depth field, value transform? }. */
  perGroup: Record<string, {
    valueField: string;
    depthField?: string;
    transform?: (row: AgsRow, value: number) => number;
  }>;
}

const SPT_EXTRACTOR: ChannelExtractor = {
  groups: ['ISPT'],
  perGroup: {
    ISPT: { valueField: 'ISPT_NVAL', depthField: 'ISPT_TOP' },
  },
};

const MC_EXTRACTOR: ChannelExtractor = {
  groups: ['MCV', 'TRIT', 'SAMP'],
  perGroup: {
    MCV: { valueField: 'MCV_MC',  depthField: 'SAMP_TOP' },
    TRIT: { valueField: 'TRIT_MC', depthField: 'SAMP_TOP' },
    SAMP: { valueField: 'SAMP_MC', depthField: 'SAMP_TOP' },
  },
};

const LL_EXTRACTOR: ChannelExtractor = {
  groups: ['LLPL'],
  perGroup: { LLPL: { valueField: 'LLPL_LL', depthField: 'SAMP_TOP' } },
};

const PL_EXTRACTOR: ChannelExtractor = {
  groups: ['LLPL'],
  perGroup: { LLPL: { valueField: 'LLPL_PL', depthField: 'SAMP_TOP' } },
};

const PI_EXTRACTOR: ChannelExtractor = {
  groups: ['LLPL'],
  perGroup: {
    LLPL: {
      valueField: 'LLPL_PI',
      depthField: 'SAMP_TOP',
      // Fall back to LL - PL if PI not stored directly.
      transform: (row, _v) => {
        const direct = num(row['LLPL_PI']);
        if (direct != null) return direct;
        const ll = num(row['LLPL_LL']);
        const pl = num(row['LLPL_PL']);
        return ll != null && pl != null ? ll - pl : NaN;
      },
    },
  },
};

const BULK_DENSITY_EXTRACTOR: ChannelExtractor = {
  groups: ['RDEN'],
  perGroup: { RDEN: { valueField: 'RDEN_BDEN', depthField: 'SAMP_TOP' } },
};

const DRY_DENSITY_EXTRACTOR: ChannelExtractor = {
  groups: ['RDEN'],
  perGroup: { RDEN: { valueField: 'RDEN_DDEN', depthField: 'SAMP_TOP' } },
};

const CU_EXTRACTOR: ChannelExtractor = {
  groups: ['TCON', 'VANE', 'TNPC'],
  perGroup: {
    TCON: { valueField: 'TCON_SHST', depthField: 'SAMP_TOP' },
    VANE: { valueField: 'VANE_SHCU', depthField: 'VANE_DPTH' },
    TNPC: {
      valueField: 'TNPC_UNCO',
      depthField: 'SAMP_TOP',
      transform: (_r, v) => v / 2,
    },
  },
};

const K_EXTRACTOR: ChannelExtractor = {
  groups: ['PERM', 'IRDX', 'IPRM'],
  perGroup: {
    PERM: { valueField: 'PERM_PERM', depthField: 'SAMP_TOP' },
    IRDX: { valueField: 'IRDX_PERM', depthField: 'IRDX_DPTH' },
    IPRM: { valueField: 'IPRM_PERM', depthField: 'IPRM_DPTH' },
  },
};

const EXTRACTORS: Record<ChannelKey, ChannelExtractor> = {
  spt_n: SPT_EXTRACTOR,
  mc: MC_EXTRACTOR,
  ll: LL_EXTRACTOR,
  pl: PL_EXTRACTOR,
  pi: PI_EXTRACTOR,
  bulk_density: BULK_DENSITY_EXTRACTOR,
  dry_density: DRY_DENSITY_EXTRACTOR,
  cu: CU_EXTRACTOR,
  k: K_EXTRACTOR,
};

/**
 * Pull every sample for a given channel from the file, restricted to the
 * supplied LOCA_IDs. Holes without LOCA_GL are skipped (no way to convert
 * depth → RL).
 */
export function extractChannel(
  file: AgsFile,
  channel: ChannelKey,
  locaIds: Iterable<string>,
): Sample[] {
  const idSet = new Set(locaIds);
  const gls = locaGroundLevels(file);
  const ex = EXTRACTORS[channel];
  const out: Sample[] = [];
  for (const grp of ex.groups) {
    const group = file.groups[grp];
    if (!group) continue;
    const cfg = ex.perGroup[grp];
    if (!cfg) continue;
    group.rows.forEach((row, rowIndex) => {
      const id = String(row['LOCA_ID'] ?? '').trim();
      if (!id || !idSet.has(id)) return;
      const gl = gls.get(id);
      if (gl == null) return;
      let value: number | null;
      if (channel === 'spt_n') {
        value = sptNValue(row);
      } else if (cfg.transform) {
        const raw = num(row[cfg.valueField]);
        const transformed = cfg.transform(row, raw ?? NaN);
        value = Number.isFinite(transformed) ? transformed : null;
      } else {
        value = num(row[cfg.valueField]);
      }
      if (value == null) return;
      const depth = num(row[cfg.depthField ?? 'SAMP_TOP']);
      if (depth == null) return;
      out.push({
        value,
        rl: gl - depth,
        depth,
        ref: { locaId: id, group: grp, rowIndex, depth, rl: gl - depth },
      });
    });
  }
  return out;
}

/**
 * Filter a sample stream to those falling within an RL range
 * [baseRL, topRL]. `topRL` is the higher value (closer to surface).
 */
export function samplesInRange(
  samples: ReadonlyArray<Sample>,
  topRL: number,
  baseRL: number,
): Sample[] {
  const top = Math.max(topRL, baseRL);
  const base = Math.min(topRL, baseRL);
  return samples.filter((s) => s.rl <= top && s.rl >= base);
}
