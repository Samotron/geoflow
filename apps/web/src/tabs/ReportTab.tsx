import { useState, useMemo, useRef, useEffect } from 'react';
import * as Plot from '@observablehq/plot';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile, AgsRow } from '../core.js';

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props { fileBytes: Uint8Array | null; fileName?: string; }

// ── Numeric / string helpers ──────────────────────────────────────────────────

function num(row: AgsRow, k: string): number | null {
  const v = row[k];
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
}
function str(row: AgsRow, k: string): string { return String(row[k] ?? '').trim(); }

// ── Statistics ────────────────────────────────────────────────────────────────

interface Stats { n: number; min: number; max: number; mean: number; std: number; }

function computeStats(values: number[]): Stats | null {
  const vs = values.filter(isFinite);
  if (vs.length === 0) return null;
  const n = vs.length;
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const mean = vs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? vs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { n, min, max, mean, std: Math.sqrt(variance) };
}

function fmt(v: number | null | undefined, dp = 1): string {
  if (v == null || !isFinite(v)) return '—';
  return v.toFixed(dp);
}

// ── Project / TRAN info ───────────────────────────────────────────────────────

interface ProjectInfo {
  projId: string; projName: string; projLoc: string;
  projClnt: string; projCont: string; projEng: string;
  agsVersion: string; tranDate: string; tranIssu: string;
}

function extractProjectInfo(file: AgsFile): ProjectInfo {
  const p = (file.groups['PROJ']?.rows?.[0] ?? {}) as AgsRow;
  const t = (file.groups['TRAN']?.rows?.[0] ?? {}) as AgsRow;
  return {
    projId:     str(p, 'PROJ_ID'),
    projName:   str(p, 'PROJ_NAME'),
    projLoc:    str(p, 'PROJ_LOC'),
    projClnt:   str(p, 'PROJ_CLNT'),
    projCont:   str(p, 'PROJ_CONT'),
    projEng:    str(p, 'PROJ_ENG'),
    agsVersion: str(t, 'TRAN_AGS') || str(t, 'TRAN_RELE') || file.ags_version || '',
    tranDate:   str(t, 'TRAN_DATE'),
    tranIssu:   str(t, 'TRAN_ISSU'),
  };
}

// ── LOCA schedule ─────────────────────────────────────────────────────────────

interface LocaRow {
  id: string; type: string;
  easting: string; northing: string; lat: string; lon: string;
  gl: string; fdep: string; startDate: string; endDate: string; term: string;
}

function extractLoca(file: AgsFile): LocaRow[] {
  return (file.groups['LOCA']?.rows ?? [])
    .map(r => ({
      id:        str(r, 'LOCA_ID'),
      type:      str(r, 'LOCA_TYPE'),
      easting:   str(r, 'LOCA_NATE'),
      northing:  str(r, 'LOCA_NATN'),
      lat:       str(r, 'LOCA_LAT'),
      lon:       str(r, 'LOCA_LON'),
      gl:        str(r, 'LOCA_GL'),
      fdep:      str(r, 'LOCA_FDEP'),
      startDate: str(r, 'LOCA_STAR'),
      endDate:   str(r, 'LOCA_ENDD'),
      term:      str(r, 'LOCA_TERM'),
    }))
    .filter(r => r.id);
}

// ── GEOL summary ──────────────────────────────────────────────────────────────

interface GeolUnit {
  code: string; desc: string; count: number;
  minTop: number; maxBase: number; totalThickness: number;
}

function extractGeolSummary(file: AgsFile): GeolUnit[] {
  const map = new Map<string, GeolUnit>();
  for (const r of file.groups['GEOL']?.rows ?? []) {
    const code = str(r, 'GEOL_LEG') || str(r, 'GEOL_GEOL') || str(r, 'GEOL_DESC').slice(0, 30);
    const desc = str(r, 'GEOL_DESC');
    const top = num(r, 'GEOL_TOP'), base = num(r, 'GEOL_BASE');
    if (!code) continue;
    const existing = map.get(code);
    if (existing) {
      existing.count++;
      if (top != null) existing.minTop = Math.min(existing.minTop, top);
      if (base != null) existing.maxBase = Math.max(existing.maxBase, base);
      if (top != null && base != null) existing.totalThickness += base - top;
    } else {
      map.set(code, {
        code, desc,
        count: 1,
        minTop: top ?? Infinity,
        maxBase: base ?? -Infinity,
        totalThickness: (top != null && base != null) ? base - top : 0,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.minTop - b.minTop);
}

// ── SAMP summary ──────────────────────────────────────────────────────────────

interface SampTypeSummary { type: string; count: number; label: string; }

const SAMP_LABELS: Record<string, string> = {
  B: 'Bulk', D: 'Disturbed', U: 'Undisturbed', C: 'Core',
  W: 'Water', G: 'Gas', T: 'Thin-walled', P: 'Piston',
};

function extractSampSummary(file: AgsFile): SampTypeSummary[] {
  const map = new Map<string, number>();
  for (const r of file.groups['SAMP']?.rows ?? []) {
    const t = str(r, 'SAMP_TYPE') || '?';
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, count]) => ({ type: t, count, label: SAMP_LABELS[t] ?? t }));
}

// ── Plot data extractors ──────────────────────────────────────────────────────

const PALETTE = [
  '#1a4080','#dc2626','#16a34a','#d97706','#7c3aed',
  '#0891b2','#db2777','#65a30d','#c2410c','#0284c7',
  '#9333ea','#ca8a04','#0d9488','#be123c','#15803d',
];
function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
  return PALETTE[h % PALETTE.length]!;
}
function colorScale(data: { colorKey: string }[]) {
  const keys = [...new Set(data.map(d => d.colorKey))].sort();
  return { domain: keys, range: keys.map(hashColor) };
}

interface DepthDatum { locaId: string; depth: number; value: number; colorKey: string; }
interface XYDatum    { locaId: string; x: number; y: number; colorKey: string; }
interface PsdPoint   { size: number; passing: number; curveId: string; colorKey: string; }
interface LlplDatum  { locaId: string; depth: number; pl: number; ll: number; colorKey: string; }

function sptDepthData(file: AgsFile): DepthDatum[] {
  return (file.groups['ISPT']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    const depth = num(r, 'ISPT_DPTH'), n = num(r, 'ISPT_NVAL');
    if (!locaId || depth == null || n == null) return [];
    return [{ locaId, depth, value: n, colorKey: locaId }];
  });
}

function atterbergData(file: AgsFile): XYDatum[] {
  return (file.groups['LLPL']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    const ll = num(r, 'LLPL_LL'), pl = num(r, 'LLPL_PL');
    let pi = num(r, 'LLPL_PI');
    if (!locaId || ll == null) return [];
    if (pi == null && pl != null) pi = ll - pl;
    if (pi == null) return [];
    return [{ locaId, x: ll, y: pi, colorKey: locaId }];
  });
}

function psdData(file: AgsFile): PsdPoint[] {
  const pts: PsdPoint[] = [];
  for (const [grp, szF, pcF] of [['GRAG','GRAG_SIZO','GRAG_PCPG'],['SIEV','SIEV_SIZE','SIEV_PCPG']] as const) {
    for (const r of file.groups[grp]?.rows ?? []) {
      const locaId = str(r, 'LOCA_ID');
      let size = num(r, szF), passing = num(r, pcF);
      if (!locaId || size == null || passing == null || size <= 0) continue;
      if (grp === 'SIEV' && size >= 1 && size <= 200) size /= 1000;
      const depth = num(r, 'SAMP_TOP');
      const sref = str(r, 'SAMP_REF') || str(r, 'SAMP_ID') || String(depth ?? '?');
      pts.push({ size, passing, curveId: `${locaId}/${sref}`, colorKey: locaId });
    }
  }
  return pts;
}

function llplDepthData(file: AgsFile): LlplDatum[] {
  return (file.groups['LLPL']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    const depth = num(r, 'SAMP_TOP'), ll = num(r, 'LLPL_LL'), pl = num(r, 'LLPL_PL');
    if (!locaId || depth == null || ll == null || pl == null) return [];
    return [{ locaId, depth, pl, ll, colorKey: locaId }];
  });
}

function mcDepthData(file: AgsFile): DepthDatum[] {
  return (file.groups['LNMC']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    const depth = num(r, 'SAMP_TOP'), mc = num(r, 'LNMC_MC');
    if (!locaId || depth == null || mc == null) return [];
    return [{ locaId, depth, value: mc, colorKey: locaId }];
  });
}

function cuDepthData(file: AgsFile): DepthDatum[] {
  const results: DepthDatum[] = [];
  for (const r of file.groups['TCON']?.rows ?? []) {
    const locaId = str(r, 'LOCA_ID');
    const depth = num(r, 'SAMP_TOP'), cu = num(r, 'TCON_SHST');
    if (locaId && depth != null && cu != null) results.push({ locaId, depth, value: cu, colorKey: locaId });
  }
  for (const r of file.groups['VANE']?.rows ?? []) {
    const locaId = str(r, 'LOCA_ID');
    const depth = num(r, 'VANE_DPTH'), cu = num(r, 'VANE_SHCU');
    if (locaId && depth != null && cu != null) results.push({ locaId, depth, value: cu, colorKey: locaId });
  }
  for (const r of file.groups['TNPC']?.rows ?? []) {
    const locaId = str(r, 'LOCA_ID');
    const depth = num(r, 'SAMP_TOP'), uco = num(r, 'TNPC_UNCO');
    if (locaId && depth != null && uco != null) results.push({ locaId, depth, value: uco / 2, colorKey: locaId });
  }
  return results;
}

// ── Statistics extractors ─────────────────────────────────────────────────────

function sptStats(file: AgsFile) {
  const vals = (file.groups['ISPT']?.rows ?? []).flatMap(r => {
    const v = num(r, 'ISPT_NVAL'); return v != null ? [v] : [];
  });
  return computeStats(vals);
}

interface AtterbergStats {
  ll: Stats | null; pl: Stats | null; pi: Stats | null;
}
function atterbergStats(file: AgsFile): AtterbergStats {
  const ll: number[] = [], pl: number[] = [], pi: number[] = [];
  for (const r of file.groups['LLPL']?.rows ?? []) {
    const lv = num(r, 'LLPL_LL'), pv = num(r, 'LLPL_PL'), piv = num(r, 'LLPL_PI');
    if (lv != null) ll.push(lv);
    if (pv != null) pl.push(pv);
    if (piv != null) pi.push(piv);
    else if (lv != null && pv != null) pi.push(lv - pv);
  }
  return { ll: computeStats(ll), pl: computeStats(pl), pi: computeStats(pi) };
}

function mcStats(file: AgsFile) {
  const vals = (file.groups['LNMC']?.rows ?? []).flatMap(r => {
    const v = num(r, 'LNMC_MC'); return v != null ? [v] : [];
  });
  return computeStats(vals);
}

function cuStats(file: AgsFile) {
  const vals = cuDepthData(file).map(d => d.value);
  return computeStats(vals);
}

interface DensityStats { bulk: Stats | null; dry: Stats | null; }
function densityStats(file: AgsFile): DensityStats {
  const bulk: number[] = [], dry: number[] = [];
  for (const r of file.groups['RDEN']?.rows ?? []) {
    const b = num(r, 'RDEN_BDEN'), d = num(r, 'RDEN_DDEN');
    if (b != null) bulk.push(b);
    if (d != null) dry.push(d);
  }
  return { bulk: computeStats(bulk), dry: computeStats(dry) };
}

interface PsdStats { coarse: number; medium: number; fine: number; clay: number; }
function psdStats(file: AgsFile): PsdStats | null {
  const rows = [...(file.groups['GRAG']?.rows ?? []), ...(file.groups['SIEV']?.rows ?? [])];
  if (rows.length === 0) return null;
  // Average % passing key sieves across all samples
  const byKey = new Map<string, number[]>();
  function addPassing(sizeVal: number, pc: number, isLegacy: boolean) {
    const sz = isLegacy && sizeVal >= 1 && sizeVal <= 200 ? sizeVal / 1000 : sizeVal;
    const key =
      sz <= 0.002  ? 'clay'   :
      sz <= 0.063  ? 'fine'   :
      sz <= 2      ? 'medium' : 'coarse';
    const arr = byKey.get(key) ?? [];
    arr.push(pc);
    byKey.set(key, arr);
  }
  for (const r of file.groups['GRAG']?.rows ?? []) {
    const sz = num(r, 'GRAG_SIZO'), pc = num(r, 'GRAG_PCPG');
    if (sz != null && pc != null) addPassing(sz, pc, false);
  }
  for (const r of file.groups['SIEV']?.rows ?? []) {
    const sz = num(r, 'SIEV_SIZE'), pc = num(r, 'SIEV_PCPG');
    if (sz != null && pc != null) addPassing(sz, pc, true);
  }
  const avg = (key: string) => {
    const arr = byKey.get(key);
    if (!arr?.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  };
  return { coarse: avg('coarse'), medium: avg('medium'), fine: avg('fine'), clay: avg('clay') };
}

// ── Observable Plot specs ─────────────────────────────────────────────────────

type PlotSpec = Parameters<typeof Plot.plot>[0];
const DEPTH_STYLE = { y: { label: 'Depth (m bgl)', reverse: true, grid: true }, height: 380, marginLeft: 55 };

function mkSptSpec(data: DepthDatum[]): PlotSpec {
  const cs = colorScale(data);
  const maxN = Math.max(60, ...data.map(d => d.value));
  return {
    ...DEPTH_STYLE,
    x: { label: 'SPT N-value (blows/300mm)', domain: [0, Math.ceil(maxN / 10) * 10 + 2] },
    color: { ...cs, legend: true },
    marks: [
      Plot.ruleX([10, 30, 50], { stroke: '#e2e8f0', strokeDasharray: '5,4', strokeWidth: 1 }),
      Plot.ruleX([0], { stroke: '#cbd5e1' }),
      Plot.ruleY([0], { stroke: '#0f172a', strokeWidth: 1 }),
      Plot.ruleY(data, { x1: 0, x2: d => d.value, y: d => d.depth, stroke: d => d.colorKey, strokeWidth: 3, strokeOpacity: 0.5 }),
      Plot.dot(data, { x: d => d.value, y: d => d.depth, fill: d => d.colorKey, r: 4, stroke: 'white', strokeWidth: 0.8, tip: true, title: d => `${d.locaId}\nN = ${d.value}\nDepth = ${d.depth} m` }),
      Plot.text([{x:10,y:0.4,t:'10'},{x:30,y:0.4,t:'30'},{x:50,y:0.4,t:'50'}], { x:'x', y:'y', text:'t', fontSize:9, fill:'#94a3b8', textAnchor:'middle' }),
    ],
  };
}

function mkPlasticitySpec(data: XYDatum[]): PlotSpec {
  const cs = colorScale(data);
  const maxLL = Math.max(110, ...data.map(d => d.x));
  const aLine = Array.from({ length: 50 }, (_, i) => { const ll = 20 + i * (maxLL - 20) / 49; return { ll, pi: 0.73 * (ll - 20) }; });
  const uLine = Array.from({ length: 50 }, (_, i) => { const ll = 8 + i * (maxLL - 8) / 49; return { ll, pi: 0.9 * (ll - 8) }; });
  return {
    height: 360, marginLeft: 50,
    x: { label: 'Liquid Limit, LL (%)', domain: [0, maxLL], grid: true },
    y: { label: 'Plasticity Index, PI (%)', domain: [0, Math.max(70, ...data.map(d => d.y)) + 5], grid: true },
    color: { ...cs, legend: true },
    marks: [
      Plot.ruleX([35, 50, 70, 90], { stroke: '#e2e8f0', strokeDasharray: '4,4' }),
      Plot.line(aLine, { x: 'll', y: 'pi', stroke: '#dc2626', strokeWidth: 1.5, strokeDasharray: '6,3' }),
      Plot.line(uLine, { x: 'll', y: 'pi', stroke: '#2563eb', strokeWidth: 1, strokeDasharray: '6,3' }),
      Plot.text([{ ll: maxLL * 0.85, pi: 0.73 * (maxLL * 0.85 - 20) + 3, t: 'A-line' }], { x: 'll', y: 'pi', text: 't', fill: '#dc2626', fontSize: 9, textAnchor: 'end' }),
      Plot.text([{ ll: maxLL * 0.85, pi: 0.9 * (maxLL * 0.85 - 8) + 3, t: 'U-line' }], { x: 'll', y: 'pi', text: 't', fill: '#2563eb', fontSize: 9, textAnchor: 'end' }),
      Plot.dot(data, { x: d => d.x, y: d => d.y, fill: d => d.colorKey, r: 5, stroke: 'white', strokeWidth: 0.8, tip: true, title: d => `${d.locaId}\nLL = ${d.x}%\nPI = ${d.y}%` }),
    ],
  };
}

function mkPsdSpec(data: PsdPoint[]): PlotSpec {
  const cs = colorScale(data);
  const boundaries = [
    { x: 0.002, t: 'Clay' }, { x: 0.063, t: 'Silt/Fine' },
    { x: 2, t: 'Sand' }, { x: 63, t: 'Gravel' },
  ];
  return {
    height: 360, marginLeft: 50,
    x: { type: 'log' as const, label: 'Particle size (mm)', domain: [0.0006, 100], grid: true, ticks: [0.001,0.002,0.006,0.02,0.063,0.2,0.6,2,6.3,20,63] },
    y: { label: '% passing', domain: [0, 100], grid: true },
    color: { ...cs, legend: true },
    marks: [
      ...boundaries.map(b => Plot.ruleX([b.x], { stroke: '#e2e8f0', strokeDasharray: '4,4' })),
      Plot.text(boundaries, { x: 'x', y: 98, text: 't', fill: '#94a3b8', fontSize: 9, dx: 3, textAnchor: 'start' }),
      Plot.line([...data].sort((a, b) => a.size - b.size), { x: 'size', y: 'passing', z: 'curveId', stroke: d => d.colorKey, strokeWidth: 1.5, strokeOpacity: 0.8 }),
      Plot.dot(data, { x: 'size', y: 'passing', fill: d => d.colorKey, r: 2.5, tip: true, title: d => `${d.curveId}\n${d.size.toPrecision(3)} mm — ${d.passing}%` }),
    ],
  };
}

function mkLimitsDepthSpec(llpl: LlplDatum[], mc: DepthDatum[]): PlotSpec {
  const cs = colorScale([...llpl, ...mc]);
  const maxX = Math.max(100, ...llpl.map(d => d.ll), ...mc.map(d => d.value));
  return {
    ...DEPTH_STYLE,
    x: { label: 'Water content / limit (%)', domain: [0, maxX + 5], grid: true },
    color: { ...cs, legend: true },
    marks: [
      Plot.ruleY([0], { stroke: '#0f172a', strokeWidth: 1 }),
      Plot.ruleY(llpl, { x1: d => d.pl, x2: d => d.ll, y: d => d.depth, stroke: d => d.colorKey, strokeWidth: 3, strokeOpacity: 0.4 }),
      Plot.dot(llpl, { x: d => d.pl, y: d => d.depth, fill: 'white', stroke: d => d.colorKey, strokeWidth: 2, symbol: 'square', r: 4, tip: true, title: d => `${d.locaId} — PL\nPL = ${d.pl}%\nDepth = ${d.depth} m` }),
      Plot.dot(llpl, { x: d => d.ll, y: d => d.depth, fill: d => d.colorKey, stroke: 'white', strokeWidth: 0.8, symbol: 'square', r: 4, tip: true, title: d => `${d.locaId} — LL\nLL = ${d.ll}%\nDepth = ${d.depth} m` }),
      Plot.dot(mc, { x: d => d.value, y: d => d.depth, fill: d => d.colorKey, stroke: 'white', strokeWidth: 0.8, r: 4.5, tip: true, title: d => `${d.locaId} — MC\nMC = ${d.value}%\nDepth = ${d.depth} m` }),
      Plot.text([{ x: maxX + 4, y: 0.5, t: '□ PL' }, { x: maxX + 4, y: 1.5, t: '■ LL' }, { x: maxX + 4, y: 2.5, t: '● MC' }], { x: 'x', y: 'y', text: 't', textAnchor: 'end', fontSize: 9, fill: '#64748b' }),
    ],
  };
}

function mkCuSpec(data: DepthDatum[]): PlotSpec {
  const cs = colorScale(data);
  return {
    ...DEPTH_STYLE,
    x: { label: 'Undrained shear strength Cu (kPa)', grid: true },
    color: { ...cs, legend: true },
    marks: [
      Plot.ruleY([0], { stroke: '#0f172a', strokeWidth: 1 }),
      Plot.dot(data, { x: d => d.value, y: d => d.depth, fill: d => d.colorKey, r: 4.5, stroke: 'white', strokeWidth: 0.8, tip: true, title: d => `${d.locaId}\nCu = ${d.value} kPa\nDepth = ${d.depth} m` }),
    ],
  };
}

// ── OPlot component ───────────────────────────────────────────────────────────

function OPlot({ spec }: { spec: PlotSpec }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = Plot.plot({ ...spec, width: Math.max(300, el.clientWidth - 16) });
    if (chart instanceof SVGElement) {
      const w = chart.getAttribute('width'), h = chart.getAttribute('height');
      if (w && h) chart.setAttribute('viewBox', `0 0 ${w} ${h}`);
      chart.removeAttribute('width');
      chart.style.width = '100%'; chart.style.height = 'auto';
    } else {
      const svg = chart.querySelector('svg');
      if (svg) {
        const w = svg.getAttribute('width'), h = svg.getAttribute('height');
        if (w && h) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.removeAttribute('width');
        svg.style.width = '100%'; svg.style.height = 'auto';
      }
      (chart as HTMLElement).style.overflow = 'visible';
    }
    el.replaceChildren(chart);
    return () => { if (el) el.replaceChildren(); };
  }, [spec]);
  return <div ref={ref} style={{ padding: 8, minHeight: 120 }} />;
}

// ── UI building blocks ────────────────────────────────────────────────────────

const S = {
  section: { marginBottom: 36 } as React.CSSProperties,
  h2: { fontSize: 15, fontWeight: 700, color: 'var(--navy)', borderBottom: '2px solid var(--navy)', paddingBottom: 6, marginBottom: 14 } as React.CSSProperties,
  h3: { fontSize: 13, fontWeight: 700, color: 'var(--blue)', marginBottom: 8, marginTop: 16 } as React.CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 },
  th: { background: 'var(--navy)', color: '#fff', padding: '6px 10px', textAlign: 'left' as const, fontWeight: 600, fontSize: 11 },
  td: { padding: '5px 10px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' as const } as React.CSSProperties,
  tdAlt: { padding: '5px 10px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' as const, background: '#f8fafc' } as React.CSSProperties,
  card: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 16 } as React.CSSProperties,
  cardHdr: { padding: '8px 14px', borderBottom: '1px solid var(--border)', background: '#f8fafc', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.4px', color: 'var(--muted)' } as React.CSSProperties,
  kvGrid: { display: 'grid', gridTemplateColumns: '180px 1fr', rowGap: 4, fontSize: 13 } as React.CSSProperties,
  kvLabel: { color: 'var(--muted)', fontWeight: 600 } as React.CSSProperties,
  kvValue: { color: 'var(--text)' } as React.CSSProperties,
  noData: { padding: '24px 16px', textAlign: 'center' as const, color: 'var(--muted)', fontSize: 13 },
  pill: (color: string) => ({
    display: 'inline-block', padding: '2px 8px', borderRadius: 99,
    background: color + '22', color, fontWeight: 700, fontSize: 11,
  }),
} as const;

function Kv({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return <>
    <span style={S.kvLabel}>{label}</span>
    <span style={S.kvValue}>{value}</span>
  </>;
}

function StatsRow({ label, s, unit, dp = 1 }: { label: string; s: Stats | null; unit: string; dp?: number }) {
  if (!s) return (
    <tr>
      <td style={S.td}>{label}</td>
      <td colSpan={5} style={{ ...S.td, color: 'var(--muted)', fontStyle: 'italic' }}>No data</td>
    </tr>
  );
  return (
    <tr>
      <td style={S.td}>{label} {unit && <span style={{ color: 'var(--muted)', fontSize: 11 }}>({unit})</span>}</td>
      <td style={{ ...S.td, fontVariantNumeric: 'tabular-nums', textAlign: 'center' }}>{s.n}</td>
      <td style={{ ...S.td, fontVariantNumeric: 'tabular-nums', textAlign: 'center' }}>{fmt(s.min, dp)}</td>
      <td style={{ ...S.td, fontVariantNumeric: 'tabular-nums', textAlign: 'center' }}>{fmt(s.max, dp)}</td>
      <td style={{ ...S.td, fontVariantNumeric: 'tabular-nums', textAlign: 'center' }}>{fmt(s.mean, dp)}</td>
      <td style={{ ...S.td, fontVariantNumeric: 'tabular-nums', textAlign: 'center' }}>{fmt(s.std, dp)}</td>
    </tr>
  );
}

function StatsTable({ children }: { children: React.ReactNode }) {
  return (
    <table style={S.table}>
      <thead>
        <tr>
          {['Parameter','n','Min','Max','Mean','Std Dev'].map(h => (
            <th key={h} style={{ ...S.th, textAlign: h === 'Parameter' ? 'left' : 'center' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function ChartCard({ title, n, children }: { title: string; n: number; children?: React.ReactNode }) {
  return (
    <div style={S.card}>
      <div style={S.cardHdr}>{title}{n > 0 && <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--muted)' }}>{n.toLocaleString()} pts</span>}</div>
      {n === 0
        ? <div style={S.noData}>No data available</div>
        : children}
    </div>
  );
}

const TYPE_LABELS: Record<string, string> = {
  BH: 'Borehole', TP: 'Trial Pit', WS: 'Window Sample', DP: 'Dynamic Probe',
  CP: 'CPT', RC: 'Rotary Core', TW: 'Tubewell', PZ: 'Piezometer',
  SW: 'Standpipe Well', HS: 'Hand Sample', PT: 'Pit',
};

// ── HTML export ───────────────────────────────────────────────────────────────

const PRINT_CSS = `
  @media print {
    body { background: white !important; }
    .report-actions { display: none !important; }
    .report-root { padding: 0 !important; }
    h1 { font-size: 20pt !important; }
    table { page-break-inside: avoid; }
    .report-section { page-break-inside: avoid; }
  }
`;

function exportHtml(el: HTMLElement, baseName: string) {
  const inlineStyles = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; font-size: 14px; color: #0f172a; background: #f1f5f9; }
    :root { --navy: #0f2644; --blue: #1a4080; --border: #cbd5e1; --card: #ffffff; --muted: #64748b; --text: #0f172a; --radius: 8px; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th { background: #0f2644; color: #fff; padding: 6px 10px; text-align: left; font-size: 11px; }
    td { padding: 5px 10px; border-bottom: 1px solid #cbd5e1; }
    .report-actions { display: none; }
    ${PRINT_CSS}
  `;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>GI Factual Report — ${baseName}</title>
<style>${inlineStyles}</style>
</head>
<body style="padding: 24px 40px; max-width: 1200px; margin: 0 auto;">
${el.innerHTML}
</body>
</html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${baseName}-gi-report.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ── Main component ────────────────────────────────────────────────────────────

export function ReportTab({ fileBytes, fileName }: Props) {
  const reportRef = useRef<HTMLDivElement>(null);

  const agsFile = useMemo<AgsFile | null>(() => {
    if (!fileBytes) return null;
    try { return parseStr(decodeBytes(fileBytes)).file; } catch { return null; }
  }, [fileBytes]);

  const proj     = useMemo(() => agsFile ? extractProjectInfo(agsFile) : null, [agsFile]);
  const loca     = useMemo(() => agsFile ? extractLoca(agsFile) : [], [agsFile]);
  const geolSum  = useMemo(() => agsFile ? extractGeolSummary(agsFile) : [], [agsFile]);
  const sampSum  = useMemo(() => agsFile ? extractSampSummary(agsFile) : [], [agsFile]);

  // Stats
  const spStat  = useMemo(() => agsFile ? sptStats(agsFile)       : null, [agsFile]);
  const atStats = useMemo(() => agsFile ? atterbergStats(agsFile) : { ll: null, pl: null, pi: null }, [agsFile]);
  const mcStat  = useMemo(() => agsFile ? mcStats(agsFile)        : null, [agsFile]);
  const cuStat  = useMemo(() => agsFile ? cuStats(agsFile)        : null, [agsFile]);
  const denStat = useMemo(() => agsFile ? densityStats(agsFile)   : { bulk: null, dry: null }, [agsFile]);
  const psdStat = useMemo(() => agsFile ? psdStats(agsFile)       : null, [agsFile]);

  // Plot data
  const sptD   = useMemo(() => agsFile ? sptDepthData(agsFile)   : [], [agsFile]);
  const attD   = useMemo(() => agsFile ? atterbergData(agsFile)  : [], [agsFile]);
  const psdD   = useMemo(() => agsFile ? psdData(agsFile)        : [], [agsFile]);
  const llplD  = useMemo(() => agsFile ? llplDepthData(agsFile)  : [], [agsFile]);
  const mcD    = useMemo(() => agsFile ? mcDepthData(agsFile)    : [], [agsFile]);
  const cuD    = useMemo(() => agsFile ? cuDepthData(agsFile)    : [], [agsFile]);

  // Plot specs
  const sptSpec   = useMemo(() => sptD.length  ? mkSptSpec(sptD)                         : null, [sptD]);
  const attSpec   = useMemo(() => attD.length  ? mkPlasticitySpec(attD)                  : null, [attD]);
  const psdSpec   = useMemo(() => psdD.length  ? mkPsdSpec(psdD)                         : null, [psdD]);
  const limSpec   = useMemo(() => llplD.length ? mkLimitsDepthSpec(llplD, mcD)           : null, [llplD, mcD]);
  const cuSpec    = useMemo(() => cuD.length   ? mkCuSpec(cuD)                           : null, [cuD]);

  // Hole type counts
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of loca) m.set(l.type || '?', (m.get(l.type || '?') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [loca]);

  const totalDepth = useMemo(() =>
    loca.reduce((s, l) => s + (parseFloat(l.fdep) || 0), 0), [loca]);

  const hasCoords = loca.some(l => l.easting || l.lat);
  const baseName = (fileName ?? 'report').replace(/\.[^.]+$/, '');
  const today = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });

  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
        Drop an AGS file above to generate a factual report.
      </div>
    );
  }
  if (!agsFile) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--red)' }}>
        Failed to parse the AGS file.
      </div>
    );
  }

  const hasAnyStats = spStat || atStats.ll || mcStat || cuStat || denStat.bulk || denStat.dry;
  const hasAnyPlot  = sptD.length || attD.length || psdD.length || llplD.length || cuD.length;

  return (
    <div>
      <style>{PRINT_CSS}</style>

      {/* ── Actions bar ── */}
      <div className="report-actions" style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: 'var(--muted)', marginRight: 'auto' }}>
          Factual Ground Investigation Report &mdash; {baseName}
        </span>
        <button
          onClick={() => window.print()}
          style={{ background: 'var(--navy)', color: '#fff', padding: '8px 16px' }}
        >
          Print / Save PDF
        </button>
        <button
          onClick={() => reportRef.current && exportHtml(reportRef.current, baseName)}
          style={{ background: '#e2e8f0', color: 'var(--text)', padding: '8px 16px' }}
        >
          Export HTML
        </button>
      </div>

      {/* ── Report body ── */}
      <div ref={reportRef} className="report-root" style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '32px 40px' }}>

        {/* ══ Cover ════════════════════════════════════════════════════════════ */}
        <div style={{ marginBottom: 40, borderBottom: '3px solid var(--navy)', paddingBottom: 24 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--muted)', marginBottom: 6 }}>
            Factual Ground Investigation Report
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--navy)', marginBottom: 4, letterSpacing: '-0.5px' }}>
            {proj?.projName || baseName}
          </h1>
          {proj?.projLoc && (
            <div style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 16 }}>{proj.projLoc}</div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '4px 24px', fontSize: 13, marginTop: 16 }}>
            {proj?.projId    && <><span style={S.kvLabel}>Project ref</span><span>{proj.projId}</span></>}
            {proj?.projClnt  && <><span style={S.kvLabel}>Client</span><span>{proj.projClnt}</span></>}
            {proj?.projCont  && <><span style={S.kvLabel}>Contractor</span><span>{proj.projCont}</span></>}
            {proj?.projEng   && <><span style={S.kvLabel}>Engineer</span><span>{proj.projEng}</span></>}
            {proj?.agsVersion && <><span style={S.kvLabel}>AGS version</span><span>{proj.agsVersion}</span></>}
            {proj?.tranDate  && <><span style={S.kvLabel}>Transfer date</span><span>{proj.tranDate}</span></>}
            <span style={S.kvLabel}>Report generated</span><span>{today}</span>
          </div>
        </div>

        {/* ══ 1. Investigation Summary ════════════════════════════════════════ */}
        <div style={S.section} className="report-section">
          <h2 style={S.h2}>1. Investigation Summary</h2>

          {loca.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>No LOCA data found.</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
              {[
                { label: 'Total exploratory holes', value: loca.length.toString() },
                { label: 'Total depth drilled', value: `${totalDepth.toFixed(1)} m` },
                ...typeCounts.map(([t, n]) => ({
                  label: TYPE_LABELS[t] ?? t,
                  value: `${n} ${t}`,
                })),
                ...(sampSum.length > 0 ? [{ label: 'Total samples', value: sampSum.reduce((s, x) => s + x.count, 0).toString() }] : []),
              ].map(({ label, value }) => (
                <div key={label} style={{ background: '#f8fafc', border: '1px solid var(--border)', borderRadius: 6, padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--navy)' }}>{value}</div>
                </div>
              ))}
            </div>
          )}

          {sampSum.length > 0 && (
            <>
              <h3 style={S.h3}>Sample inventory</h3>
              <table style={S.table}>
                <thead>
                  <tr>
                    {['Type', 'Description', 'Count'].map(h => <th key={h} style={S.th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {sampSum.map((s, i) => (
                    <tr key={s.type}>
                      <td style={i % 2 ? S.tdAlt : S.td}><code>{s.type}</code></td>
                      <td style={i % 2 ? S.tdAlt : S.td}>{s.label}</td>
                      <td style={i % 2 ? S.tdAlt : S.td}>{s.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        {/* ══ 2. Schedule of Exploratory Holes ═══════════════════════════════ */}
        <div style={S.section} className="report-section">
          <h2 style={S.h2}>2. Schedule of Exploratory Holes</h2>

          {loca.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>No LOCA data found.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Hole ID</th>
                    <th style={S.th}>Type</th>
                    {hasCoords && loca.some(l => l.easting) && <th style={S.th}>Easting (m)</th>}
                    {hasCoords && loca.some(l => l.northing) && <th style={S.th}>Northing (m)</th>}
                    {loca.some(l => l.lat) && <th style={S.th}>Latitude</th>}
                    {loca.some(l => l.lon) && <th style={S.th}>Longitude</th>}
                    {loca.some(l => l.gl) && <th style={S.th}>GL (mOD)</th>}
                    <th style={S.th}>Final Depth (m)</th>
                    {loca.some(l => l.startDate) && <th style={S.th}>Start Date</th>}
                    {loca.some(l => l.endDate) && <th style={S.th}>End Date</th>}
                    {loca.some(l => l.term) && <th style={S.th}>Termination</th>}
                  </tr>
                </thead>
                <tbody>
                  {loca.map((l, i) => (
                    <tr key={l.id}>
                      <td style={i % 2 ? S.tdAlt : S.td}><strong>{l.id}</strong></td>
                      <td style={i % 2 ? S.tdAlt : S.td}>
                        <span style={S.pill('var(--blue)')}>{l.type || '—'}</span>
                      </td>
                      {hasCoords && loca.some(r => r.easting) && <td style={i % 2 ? S.tdAlt : S.td}>{l.easting || '—'}</td>}
                      {hasCoords && loca.some(r => r.northing) && <td style={i % 2 ? S.tdAlt : S.td}>{l.northing || '—'}</td>}
                      {loca.some(r => r.lat) && <td style={i % 2 ? S.tdAlt : S.td}>{l.lat || '—'}</td>}
                      {loca.some(r => r.lon) && <td style={i % 2 ? S.tdAlt : S.td}>{l.lon || '—'}</td>}
                      {loca.some(r => r.gl) && <td style={i % 2 ? S.tdAlt : S.td}>{l.gl || '—'}</td>}
                      <td style={i % 2 ? S.tdAlt : S.td}>{l.fdep || '—'}</td>
                      {loca.some(r => r.startDate) && <td style={i % 2 ? S.tdAlt : S.td}>{l.startDate || '—'}</td>}
                      {loca.some(r => r.endDate) && <td style={i % 2 ? S.tdAlt : S.td}>{l.endDate || '—'}</td>}
                      {loca.some(r => r.term) && <td style={i % 2 ? S.tdAlt : S.td}>{l.term || '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ══ 3. Geological Units Encountered ════════════════════════════════ */}
        {geolSum.length > 0 && (
          <div style={S.section} className="report-section">
            <h2 style={S.h2}>3. Geological Units Encountered</h2>
            <table style={S.table}>
              <thead>
                <tr>
                  {['Legend / Code', 'Description', 'Occurrences', 'Min depth (m)', 'Max depth (m)', 'Avg thickness (m)'].map(h => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {geolSum.map((g, i) => (
                  <tr key={g.code + i}>
                    <td style={i % 2 ? S.tdAlt : S.td}><code>{g.code}</code></td>
                    <td style={i % 2 ? S.tdAlt : S.td}>{g.desc}</td>
                    <td style={i % 2 ? S.tdAlt : S.td}>{g.count}</td>
                    <td style={i % 2 ? S.tdAlt : S.td}>{isFinite(g.minTop) ? g.minTop.toFixed(2) : '—'}</td>
                    <td style={i % 2 ? S.tdAlt : S.td}>{isFinite(g.maxBase) && g.maxBase > -Infinity ? g.maxBase.toFixed(2) : '—'}</td>
                    <td style={i % 2 ? S.tdAlt : S.td}>{g.count > 0 ? (g.totalThickness / g.count).toFixed(2) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ══ 4. Statistical Summary of Test Results ══════════════════════════ */}
        {hasAnyStats && (
          <div style={S.section} className="report-section">
            <h2 style={S.h2}>4. Statistical Summary of Test Results</h2>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              Statistics computed on all valid numeric values in the dataset.
              n = number of test results; Std Dev = sample standard deviation.
            </p>

            {spStat && (
              <>
                <h3 style={S.h3}>Standard Penetration Test (SPT)</h3>
                <StatsTable>
                  <StatsRow label="SPT N-value" s={spStat} unit="blows/300mm" dp={1} />
                </StatsTable>
              </>
            )}

            {(atStats.ll || atStats.pl || atStats.pi) && (
              <>
                <h3 style={S.h3}>Atterberg Limits (LLPL)</h3>
                <StatsTable>
                  <StatsRow label="Liquid Limit (LL)"    s={atStats.ll} unit="%" />
                  <StatsRow label="Plastic Limit (PL)"   s={atStats.pl} unit="%" />
                  <StatsRow label="Plasticity Index (PI)" s={atStats.pi} unit="%" />
                </StatsTable>
              </>
            )}

            {mcStat && (
              <>
                <h3 style={S.h3}>Moisture Content (LNMC)</h3>
                <StatsTable>
                  <StatsRow label="Natural moisture content (w)" s={mcStat} unit="%" />
                </StatsTable>
              </>
            )}

            {cuStat && (
              <>
                <h3 style={S.h3}>Undrained Shear Strength (TCON / VANE / TNPC)</h3>
                <StatsTable>
                  <StatsRow label="Cu" s={cuStat} unit="kPa" />
                </StatsTable>
              </>
            )}

            {(denStat.bulk || denStat.dry) && (
              <>
                <h3 style={S.h3}>Density (RDEN)</h3>
                <StatsTable>
                  <StatsRow label="Bulk density (ρ)" s={denStat.bulk} unit="Mg/m³" dp={3} />
                  <StatsRow label="Dry density (ρd)"  s={denStat.dry}  unit="Mg/m³" dp={3} />
                </StatsTable>
              </>
            )}

            {psdStat && (
              <>
                <h3 style={S.h3}>Particle Size Distribution — indicative average % passing</h3>
                <table style={S.table}>
                  <thead>
                    <tr>
                      {['Fraction', 'Boundary', 'Average % passing'].map(h => <th key={h} style={S.th}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { frac: 'Clay', bnd: '< 0.002 mm',  val: psdStat.clay },
                      { frac: 'Silt/Fine', bnd: '0.002 – 0.063 mm', val: psdStat.fine },
                      { frac: 'Sand', bnd: '0.063 – 2 mm', val: psdStat.medium },
                      { frac: 'Gravel+', bnd: '> 2 mm',   val: psdStat.coarse },
                    ].map((row, i) => (
                      <tr key={row.frac}>
                        <td style={i % 2 ? S.tdAlt : S.td}>{row.frac}</td>
                        <td style={i % 2 ? S.tdAlt : S.td}>{row.bnd}</td>
                        <td style={i % 2 ? S.tdAlt : S.td}>{row.val > 0 ? `${row.val.toFixed(1)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}

        {/* ══ 5. Plots ════════════════════════════════════════════════════════ */}
        {hasAnyPlot && (
          <div style={S.section} className="report-section">
            <h2 style={S.h2}>5. Engineering Plots</h2>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(460px, 1fr))', gap: 18 }}>

              <ChartCard title="SPT N-value vs Depth" n={sptD.length}>
                {sptSpec && <OPlot spec={sptSpec} />}
              </ChartCard>

              <ChartCard title="Plasticity Chart — A-line &amp; U-line" n={attD.length}>
                {attSpec && <OPlot spec={attSpec} />}
              </ChartCard>

              <ChartCard title="PL / LL / MC vs Depth  (□ PL — ■ LL  ● MC)" n={llplD.length}>
                {limSpec
                  ? <OPlot spec={limSpec} />
                  : mcD.length > 0
                    ? <OPlot spec={mkLimitsDepthSpec([], mcD)} />
                    : null}
              </ChartCard>

              <ChartCard title="Grading / Particle Size Distribution" n={psdD.length}>
                {psdSpec && <OPlot spec={psdSpec} />}
              </ChartCard>

              <ChartCard title="Undrained Shear Strength (Cu) vs Depth" n={cuD.length}>
                {cuSpec && <OPlot spec={cuSpec} />}
              </ChartCard>

            </div>
          </div>
        )}

        {/* ══ Footer ══════════════════════════════════════════════════════════ */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 16, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)' }}>
          <span>Generated by GeoFlow &mdash; AGS {proj?.agsVersion || '4.x'}</span>
          <span>Report date: {today}</span>
        </div>

      </div>{/* /report-root */}
    </div>
  );
}
