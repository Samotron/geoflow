/**
 * Shared plot infrastructure used by both PlotsTab and ReportTab.
 * Exports: types, colour helpers, AGS data extractors, Observable Plot specs,
 * the OPlot React component, PlotCard, and the ALL_PLOTS registry.
 */

import { useEffect, useRef } from 'react';
import * as Plot from '@observablehq/plot';
import type { AgsFile, AgsRow } from '../core.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ColorField = 'LOCA_ID' | 'GEOL_GEOL' | 'GEOL_DESC' | 'GEOL_LEG';

export interface GeolLayer {
  locaId: string;
  top: number; base: number;
  desc: string; geolGeol: string; geolLeg: string;
}

export interface DepthDatum { locaId: string; depth: number; value: number; colorKey: string; }
export interface ElevDatum  { locaId: string; elev: number;  value: number; colorKey: string; }
export interface XYDatum    { locaId: string; x: number;     y: number;     colorKey: string; }
export interface PsdPoint   { size: number;  passing: number; curveId: string; colorKey: string; }
export interface CmpnPoint  { mc: number;    dden: number;    curveId: string; colorKey: string; }
export interface LlplDepthDatum { locaId: string; depth: number; pl: number; ll: number; colorKey: string; }
export interface DensityDatum extends DepthDatum { type: 'Bulk' | 'Dry'; }

// ── Colours ───────────────────────────────────────────────────────────────────

const PALETTE = [
  '#1a4080','#dc2626','#16a34a','#d97706','#7c3aed',
  '#0891b2','#db2777','#65a30d','#c2410c','#0284c7',
  '#9333ea','#ca8a04','#0d9488','#be123c','#15803d',
  '#92400e','#1d4ed8','#7f1d1d','#064e3b','#312e81',
];

function hashPalette(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
  return PALETTE[h % PALETTE.length]!;
}

export function geolColor(key: string): string {
  const u = key.toUpperCase();
  if (u.includes('MADE GROUND') || u.includes('FILL') || u.includes('HARDCORE')) return '#A0785A';
  if (u.includes('TOPSOIL') || u.includes('TOP SOIL')) return '#5C7A3E';
  if (u.includes('PEAT') || u.includes('ORGANIC')) return '#3D2B1F';
  if (u.includes('CHALK')) return '#E8E4A0';
  if (u.includes('CLAY'))  return '#7B9EC5';
  if (u.includes('SILT'))  return '#C4A87C';
  if (u.includes('SANDY GRAVEL') || u.includes('GRAVELLY SAND')) return '#D99055';
  if (u.includes('SILTY SAND')   || u.includes('SANDY SILT'))    return '#D8C080';
  if (u.includes('GRAVEL'))    return '#C87A45';
  if (u.includes('SANDSTONE')) return '#D4B483';
  if (u.includes('SAND'))      return '#E8C840';
  if (u.includes('MUDSTONE') || u.includes('SHALE')) return '#7A7A90';
  if (u.includes('LIMESTONE')) return '#C8CEB8';
  if (u.includes('GRANITE') || u.includes('IGNEOUS')) return '#808090';
  if (u.includes('ROCK') || u.includes('BEDROCK'))    return '#9090A0';
  return hashPalette(key);
}

export function colorScaleFor(data: { colorKey: string }[]) {
  const keys = [...new Set(data.map(d => d.colorKey))].sort();
  return { domain: keys, range: keys.map(geolColor) };
}

// ── AGS row helpers ───────────────────────────────────────────────────────────

export function num(row: AgsRow, k: string): number | null {
  const v = row[k];
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
}

export function str(row: AgsRow, k: string): string { return String(row[k] ?? '').trim(); }

// ── Geology layer helpers ─────────────────────────────────────────────────────

export function getGeolLayers(file: AgsFile): GeolLayer[] {
  return (file.groups['GEOL']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    const top = num(r, 'GEOL_TOP'), base = num(r, 'GEOL_BASE');
    if (!locaId || top == null || base == null) return [];
    return [{ locaId, top, base, desc: str(r, 'GEOL_DESC'), geolGeol: str(r, 'GEOL_GEOL'), geolLeg: str(r, 'GEOL_LEG') }];
  });
}

export function getGeolFields(file: AgsFile): ColorField[] {
  const fields: ColorField[] = ['LOCA_ID'];
  const geol = file.groups['GEOL'];
  if (!geol) return fields;
  const keys = new Set(geol.headings.map(h => h.name));
  if (keys.has('GEOL_GEOL')) fields.push('GEOL_GEOL');
  if (keys.has('GEOL_DESC')) fields.push('GEOL_DESC');
  if (keys.has('GEOL_LEG'))  fields.push('GEOL_LEG');
  return fields;
}

export function ckAtDepth(locaId: string, depth: number | null, layers: GeolLayer[], field: ColorField): string {
  if (field === 'LOCA_ID' || depth == null) return locaId;
  const layer = layers.find(l => l.locaId === locaId && depth >= l.top && depth <= l.base);
  if (!layer) return locaId;
  const v = field === 'GEOL_DESC' ? layer.desc
    : field === 'GEOL_GEOL'       ? layer.geolGeol
    : layer.geolLeg;
  return v || layer.desc || locaId;
}

// ── Data extractors ───────────────────────────────────────────────────────────

export function extractLocaMap(file: AgsFile): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const r of file.groups['LOCA']?.rows ?? []) {
    const id = str(r, 'LOCA_ID');
    if (id) m.set(id, num(r, 'LOCA_GL'));
  }
  return m;
}

export function extractAllLocaIds(file: AgsFile): string[] {
  return (file.groups['LOCA']?.rows ?? []).map(r => str(r, 'LOCA_ID')).filter(Boolean);
}

export function extractSptDepth(file: AgsFile, layers: GeolLayer[], cf: ColorField, bh: Set<string>): DepthDatum[] {
  return (file.groups['ISPT']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) return [];
    const depth = num(r, 'ISPT_DPTH'), n = num(r, 'ISPT_NVAL');
    if (depth == null || n == null) return [];
    return [{ locaId, depth, value: n, colorKey: ckAtDepth(locaId, depth, layers, cf) }];
  });
}

export function extractSptElev(file: AgsFile, locaMap: Map<string, number | null>, layers: GeolLayer[], cf: ColorField, bh: Set<string>): ElevDatum[] {
  return (file.groups['ISPT']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) return [];
    const depth = num(r, 'ISPT_DPTH'), n = num(r, 'ISPT_NVAL');
    if (depth == null || n == null) return [];
    const gl = locaMap.get(locaId) ?? null;
    if (gl == null) return [];
    return [{ locaId, elev: gl - depth, value: n, colorKey: ckAtDepth(locaId, depth, layers, cf) }];
  });
}

export function extractAtterberg(file: AgsFile, layers: GeolLayer[], cf: ColorField, bh: Set<string>): XYDatum[] {
  return (file.groups['LLPL']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) return [];
    const ll = num(r, 'LLPL_LL'), pl = num(r, 'LLPL_PL');
    let pi = num(r, 'LLPL_PI');
    if (ll == null) return [];
    if (pi == null && pl != null) pi = ll - pl;
    if (pi == null) return [];
    const depth = num(r, 'SAMP_TOP');
    return [{ locaId, x: ll, y: pi, colorKey: ckAtDepth(locaId, depth, layers, cf) }];
  });
}

export function extractPsd(file: AgsFile, layers: GeolLayer[], cf: ColorField, bh: Set<string>): PsdPoint[] {
  const pts: PsdPoint[] = [];
  for (const [grp, szF, pcF] of [['GRAG','GRAG_SIZO','GRAG_PCPG'],['SIEV','SIEV_SIZE','SIEV_PCPG']] as const) {
    for (const r of file.groups[grp]?.rows ?? []) {
      const locaId = str(r, 'LOCA_ID');
      if (!locaId || (bh.size > 0 && !bh.has(locaId))) continue;
      let size = num(r, szF), passing = num(r, pcF);
      if (size == null || passing == null || size <= 0) continue;
      if (grp === 'SIEV' && size >= 1 && size <= 200) size /= 1000;
      const depth = num(r, 'SAMP_TOP');
      const sref = str(r, 'SAMP_REF') || str(r, 'SAMP_ID') || String(depth ?? '?');
      pts.push({ size, passing, curveId: `${locaId}/${sref}`, colorKey: ckAtDepth(locaId, depth, layers, cf) });
    }
  }
  return pts;
}

export function extractDepth(file: AgsFile, grp: string, vF: string, dF: string, layers: GeolLayer[], cf: ColorField, bh: Set<string>): DepthDatum[] {
  return (file.groups[grp]?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) return [];
    const depth = num(r, dF), val = num(r, vF);
    if (depth == null || val == null) return [];
    return [{ locaId, depth, value: val, colorKey: ckAtDepth(locaId, depth, layers, cf) }];
  });
}

export function extractUu(file: AgsFile, layers: GeolLayer[], cf: ColorField, bh: Set<string>): DepthDatum[] {
  const results: DepthDatum[] = [];
  for (const r of file.groups['TCON']?.rows ?? []) {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) continue;
    const depth = num(r, 'SAMP_TOP'), cu = num(r, 'TCON_SHST');
    if (depth != null && cu != null) results.push({ locaId, depth, value: cu, colorKey: ckAtDepth(locaId, depth, layers, cf) });
  }
  for (const r of file.groups['VANE']?.rows ?? []) {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) continue;
    const depth = num(r, 'VANE_DPTH'), cu = num(r, 'VANE_SHCU');
    if (depth != null && cu != null) results.push({ locaId, depth, value: cu, colorKey: ckAtDepth(locaId, depth, layers, cf) });
  }
  for (const r of file.groups['TNPC']?.rows ?? []) {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) continue;
    const depth = num(r, 'SAMP_TOP'), cu = num(r, 'TNPC_UNCO');
    if (depth != null && cu != null) results.push({ locaId, depth, value: cu / 2, colorKey: ckAtDepth(locaId, depth, layers, cf) });
  }
  return results;
}

export function extractDensity(file: AgsFile, layers: GeolLayer[], cf: ColorField, bh: Set<string>): { bulk: DepthDatum[]; dry: DepthDatum[] } {
  const bulk: DepthDatum[] = [], dry: DepthDatum[] = [];
  for (const r of file.groups['RDEN']?.rows ?? []) {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) continue;
    const depth = num(r, 'SAMP_TOP');
    if (depth == null) continue;
    const ck = ckAtDepth(locaId, depth, layers, cf);
    const bd = num(r, 'RDEN_BDEN'), dd = num(r, 'RDEN_DDEN');
    if (bd != null) bulk.push({ locaId, depth, value: bd, colorKey: ck });
    if (dd != null) dry.push({ locaId, depth, value: dd, colorKey: ck });
  }
  return { bulk, dry };
}

export function extractShear(file: AgsFile, layers: GeolLayer[], cf: ColorField, bh: Set<string>): XYDatum[] {
  return (file.groups['SHBX']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) return [];
    const normal = num(r, 'SHBX_NORM'), shear = num(r, 'SHBX_SHST');
    if (normal == null || shear == null) return [];
    const depth = num(r, 'SAMP_TOP');
    return [{ locaId, x: normal, y: shear, colorKey: ckAtDepth(locaId, depth, layers, cf) }];
  });
}

export function extractCompaction(file: AgsFile, layers: GeolLayer[], cf: ColorField, bh: Set<string>): CmpnPoint[] {
  return (file.groups['CMPN']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) return [];
    const mc = num(r, 'CMPN_MC'), dden = num(r, 'CMPN_DDEN');
    if (mc == null || dden == null) return [];
    const sref = str(r, 'SAMP_REF') || str(r, 'CMPN_SREF');
    const depth = num(r, 'SAMP_TOP');
    return [{ mc, dden, curveId: `${locaId}/${sref || depth}`, colorKey: ckAtDepth(locaId, depth, layers, cf) }];
  });
}

export function extractLlplDepth(file: AgsFile, layers: GeolLayer[], cf: ColorField, bh: Set<string>): LlplDepthDatum[] {
  return (file.groups['LLPL']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) return [];
    const depth = num(r, 'SAMP_TOP');
    const ll = num(r, 'LLPL_LL'), pl = num(r, 'LLPL_PL');
    if (depth == null || ll == null || pl == null) return [];
    return [{ locaId, depth, pl, ll, colorKey: ckAtDepth(locaId, depth, layers, cf) }];
  });
}

export function extractCong(file: AgsFile, layers: GeolLayer[], cf: ColorField, bh: Set<string>): XYDatum[] {
  return (file.groups['CONG']?.rows ?? []).flatMap(r => {
    const locaId = str(r, 'LOCA_ID');
    if (!locaId || (bh.size > 0 && !bh.has(locaId))) return [];
    const stress = num(r, 'CONG_COND'), voidR = num(r, 'CONG_VOID');
    if (stress == null || voidR == null || stress <= 0) return [];
    const depth = num(r, 'SAMP_TOP');
    return [{ locaId, x: stress, y: voidR, colorKey: ckAtDepth(locaId, depth, layers, cf) }];
  });
}

// ── Plot specs ────────────────────────────────────────────────────────────────

export type PlotSpec = Parameters<typeof Plot.plot>[0];

const DEPTH_GRID_STYLE = { y: { label: 'Depth (m bgl)', reverse: true, grid: true }, height: 420, marginLeft: 55 };
const ELEV_GRID_STYLE  = { y: { label: 'Elevation (m OD)', grid: true }, height: 420, marginLeft: 55 };

export function sptDepthSpec(data: DepthDatum[]): PlotSpec {
  const cs = colorScaleFor(data);
  const maxN = Math.max(60, ...data.map(d => d.value));
  return {
    ...DEPTH_GRID_STYLE,
    x: { label: 'SPT N-value (blows/300mm)', domain: [0, Math.ceil(maxN / 10) * 10 + 2] },
    color: { ...cs, legend: true },
    marks: [
      Plot.ruleX([10, 30, 50], { stroke: '#e2e8f0', strokeDasharray: '5,4', strokeWidth: 1 }),
      Plot.ruleX([0], { stroke: '#cbd5e1' }),
      Plot.ruleY([0], { stroke: '#0f172a', strokeWidth: 1 }),
      Plot.ruleY(data, { x1: 0, x2: d => d.value, y: d => d.depth, stroke: d => d.colorKey, strokeWidth: 3, strokeOpacity: 0.6 }),
      Plot.dot(data, { x: d => d.value, y: d => d.depth, fill: d => d.colorKey, r: 4.5, stroke: 'white', strokeWidth: 0.8, tip: true, title: d => `${d.locaId}\nN = ${d.value}\nDepth = ${d.depth} m` }),
      Plot.text([{x:10,y:0.5,t:'10'},{x:30,y:0.5,t:'30'},{x:50,y:0.5,t:'50'}], { x:'x', y:'y', text:'t', fontSize: 9, fill: '#94a3b8', textAnchor: 'middle' }),
    ],
  };
}

export function sptElevSpec(data: ElevDatum[]): PlotSpec {
  const cs = colorScaleFor(data);
  const maxN = Math.max(60, ...data.map(d => d.value));
  return {
    ...ELEV_GRID_STYLE,
    x: { label: 'SPT N-value (blows/300mm)', domain: [0, Math.ceil(maxN / 10) * 10 + 2] },
    color: { ...cs, legend: true },
    marks: [
      Plot.ruleX([10, 30, 50], { stroke: '#e2e8f0', strokeDasharray: '5,4', strokeWidth: 1 }),
      Plot.ruleX([0], { stroke: '#cbd5e1' }),
      Plot.ruleY(data, { x1: 0, x2: d => d.value, y: d => d.elev, stroke: d => d.colorKey, strokeWidth: 3, strokeOpacity: 0.6 }),
      Plot.dot(data, { x: d => d.value, y: d => d.elev, fill: d => d.colorKey, r: 4.5, stroke: 'white', strokeWidth: 0.8, tip: true, title: d => `${d.locaId}\nN = ${d.value}\nLevel = ${d.elev.toFixed(2)} m OD` }),
    ],
  };
}

export function plasticitySpec(data: XYDatum[]): PlotSpec {
  const cs = colorScaleFor(data);
  const maxLL = Math.max(110, ...data.map(d => d.x));
  const aLine = Array.from({ length: 50 }, (_, i) => { const ll = 20 + i * (maxLL - 20) / 49; return { ll, pi: 0.73 * (ll - 20) }; });
  const uLine = Array.from({ length: 50 }, (_, i) => { const ll = 8  + i * (maxLL - 8)  / 49; return { ll, pi: 0.9  * (ll - 8) }; });
  const zones = [
    { x: 17, y: 2, t: 'ML/MH' }, { x: 17, y: 18, t: 'CL/CH' },
    { x: 60, y: 4, t: 'M' },      { x: 60, y: 32, t: 'C' },
  ];
  return {
    height: 360,
    marginLeft: 50,
    x: { label: 'Liquid Limit, LL (%)', domain: [0, maxLL], grid: true },
    y: { label: 'Plasticity Index, PI (%)', domain: [0, Math.max(70, ...data.map(d => d.y)) + 5], grid: true },
    color: { ...cs, legend: true },
    marks: [
      Plot.ruleX([35, 50, 70, 90], { stroke: '#e2e8f0', strokeDasharray: '4,4' }),
      Plot.line(aLine, { x: 'll', y: 'pi', stroke: '#dc2626', strokeWidth: 1.5, strokeDasharray: '6,3' }),
      Plot.line(uLine, { x: 'll', y: 'pi', stroke: '#2563eb', strokeWidth: 1, strokeDasharray: '6,3' }),
      Plot.text(zones, { x: 'x', y: 'y', text: 't', fill: '#94a3b8', fontSize: 9 }),
      Plot.text([{ ll: maxLL * 0.85, pi: 0.73 * (maxLL * 0.85 - 20) + 3, t: 'A-line' }], { x: 'll', y: 'pi', text: 't', fill: '#dc2626', fontSize: 9, textAnchor: 'end' }),
      Plot.text([{ ll: maxLL * 0.85, pi: 0.9  * (maxLL * 0.85 - 8)  + 3, t: 'U-line' }], { x: 'll', y: 'pi', text: 't', fill: '#2563eb', fontSize: 9, textAnchor: 'end' }),
      Plot.dot(data, { x: d => d.x, y: d => d.y, fill: d => d.colorKey, r: 5, stroke: 'white', strokeWidth: 0.8, tip: true, title: d => `${d.locaId}\nLL = ${d.x}%\nPI = ${d.y}%` }),
    ],
  };
}

export function psdSpec(data: PsdPoint[]): PlotSpec {
  const cs = colorScaleFor(data);
  const boundaries = [
    { x: 0.002, t: 'Clay' }, { x: 0.063, t: 'Silt' },
    { x: 2,     t: 'Sand' }, { x: 63, t: 'Gravel' },
  ];
  return {
    height: 380,
    marginLeft: 50,
    x: { type: 'log' as const, label: 'Particle size (mm)', domain: [0.0006, 100], grid: true, ticks: [0.001,0.002,0.006,0.02,0.063,0.2,0.6,2,6.3,20,63] },
    y: { label: '% passing', domain: [0, 100], grid: true },
    color: { ...cs, legend: true },
    marks: [
      ...boundaries.map(b => Plot.ruleX([b.x], { stroke: '#e2e8f0', strokeDasharray: '4,4' })),
      Plot.text(boundaries, { x: 'x', y: 98, text: 't', fill: '#94a3b8', fontSize: 9, dx: 3, textAnchor: 'start' }),
      Plot.line(
        [...data].sort((a, b) => a.size - b.size),
        { x: 'size', y: 'passing', z: 'curveId', stroke: d => d.colorKey, strokeWidth: 1.5, strokeOpacity: 0.8, curve: 'linear' }
      ),
      Plot.dot(data, { x: 'size', y: 'passing', fill: d => d.colorKey, r: 2.5, tip: true, title: d => `${d.curveId}\nSize: ${d.size.toPrecision(3)} mm\nPassing: ${d.passing}%` }),
    ],
  };
}

export function depthScatterSpec(data: DepthDatum[], xLabel: string, xDomain?: [number, number]): PlotSpec {
  const cs = colorScaleFor(data);
  return {
    ...DEPTH_GRID_STYLE,
    x: { label: xLabel, ...(xDomain ? { domain: xDomain } : {}), grid: true },
    color: { ...cs, legend: true },
    marks: [
      Plot.ruleY([0], { stroke: '#0f172a', strokeWidth: 1 }),
      Plot.dot(data, { x: d => d.value, y: d => d.depth, fill: d => d.colorKey, r: 4.5, stroke: 'white', strokeWidth: 0.8, tip: true, title: d => `${d.locaId}\nValue = ${d.value}\nDepth = ${d.depth} m` }),
    ],
  };
}

export function densitySpec(bulk: DepthDatum[], dry: DepthDatum[]): PlotSpec {
  const combined: DensityDatum[] = [
    ...bulk.map(d => ({ ...d, type: 'Bulk' as const })),
    ...dry.map(d =>  ({ ...d, type: 'Dry'  as const })),
  ];
  return {
    ...DEPTH_GRID_STYLE,
    x: { label: 'Density (Mg/m³)', domain: [1.2, 2.6], grid: true },
    color: { domain: ['Bulk', 'Dry'], range: ['#1a4080', '#dc2626'], legend: true },
    marks: [
      Plot.ruleY([0], { stroke: '#0f172a', strokeWidth: 1 }),
      Plot.dot(combined, { x: (d: DensityDatum) => d.value, y: (d: DensityDatum) => d.depth, fill: 'type', symbol: (d: DensityDatum) => (d.type === 'Bulk' ? 'circle' : 'diamond') as never, r: 4.5, stroke: 'white', strokeWidth: 0.8, tip: true, title: (d: DensityDatum) => `${d.locaId}\n${d.type} = ${d.value} Mg/m³\nDepth = ${d.depth} m` }),
    ],
  };
}

export function shearBoxSpec(data: XYDatum[]): PlotSpec {
  const cs = colorScaleFor(data);
  const maxX = Math.max(50, ...data.map(d => d.x));
  const maxY = Math.max(50, ...data.map(d => d.y));
  return {
    height: 360,
    marginLeft: 55,
    x: { label: 'Normal stress σn (kPa)', domain: [0, maxX * 1.1], grid: true },
    y: { label: 'Shear strength τ (kPa)', domain: [0, maxY * 1.1], grid: true },
    color: { ...cs, legend: true },
    marks: [
      Plot.ruleX([0], { stroke: '#cbd5e1' }),
      Plot.ruleY([0], { stroke: '#cbd5e1' }),
      Plot.linearRegressionY(data, { x: d => d.x, y: d => d.y, stroke: '#7c3aed', strokeWidth: 1.5, ci: 0.95, fillOpacity: 0.08, fill: '#7c3aed' }),
      Plot.dot(data, { x: d => d.x, y: d => d.y, fill: d => d.colorKey, r: 5, stroke: 'white', strokeWidth: 0.8, tip: true, title: d => `${d.locaId}\nσn = ${d.x} kPa\nτ = ${d.y} kPa` }),
    ],
  };
}

export function compactionSpec(data: CmpnPoint[]): PlotSpec {
  const cs = colorScaleFor(data);
  return {
    height: 360,
    marginLeft: 55,
    x: { label: 'Moisture content w (%)', grid: true },
    y: { label: 'Dry density ρd (Mg/m³)', grid: true },
    color: { ...cs, legend: true },
    marks: [
      Plot.line(
        [...data].sort((a, b) => a.mc - b.mc),
        { x: 'mc', y: 'dden', z: 'curveId', stroke: d => (d as CmpnPoint).colorKey, strokeWidth: 1.5, curve: 'catmull-rom' }
      ),
      Plot.dot(data, { x: 'mc', y: 'dden', fill: d => d.colorKey, r: 5, stroke: 'white', strokeWidth: 0.8, tip: true, title: d => `${d.curveId}\nw = ${d.mc}%\nρd = ${d.dden} Mg/m³` }),
    ],
  };
}

export function congSpec(data: XYDatum[]): PlotSpec {
  const cs = colorScaleFor(data);
  return {
    height: 360,
    marginLeft: 55,
    x: { type: 'log' as const, label: "Effective stress σ'v (kPa)", grid: true },
    y: { label: 'Void ratio e', grid: true },
    color: { ...cs, legend: true },
    marks: [
      Plot.dot(data, { x: d => d.x, y: d => d.y, fill: d => d.colorKey, r: 4.5, stroke: 'white', strokeWidth: 0.8, tip: true, title: d => `${d.locaId}\nσ = ${d.x} kPa\ne = ${d.y}` }),
      Plot.line(data, { x: d => d.x, y: d => d.y, z: d => d.locaId, stroke: d => d.colorKey, strokeWidth: 1, strokeOpacity: 0.5, curve: 'linear', sort: 'x' }),
    ],
  };
}

export function atterbergDepthSpec(llpl: LlplDepthDatum[], mc: DepthDatum[]): PlotSpec {
  const cs = colorScaleFor([...llpl, ...mc]);
  const maxX = Math.max(100, ...llpl.map(d => d.ll), ...mc.map(d => d.value));
  return {
    ...DEPTH_GRID_STYLE,
    x: { label: 'Water content / limit (%)', domain: [0, maxX + 5], grid: true },
    color: { ...cs, legend: true },
    marks: [
      Plot.ruleY([0], { stroke: '#0f172a', strokeWidth: 1 }),
      Plot.ruleY(llpl, {
        x1: d => d.pl, x2: d => d.ll, y: d => d.depth,
        stroke: d => d.colorKey, strokeWidth: 3, strokeOpacity: 0.45,
      }),
      Plot.dot(llpl, {
        x: d => d.pl, y: d => d.depth,
        fill: 'white', stroke: d => d.colorKey, strokeWidth: 2,
        symbol: 'square', r: 4.5,
        tip: true, title: d => `${d.locaId} — PL\nPL = ${d.pl}%\nDepth = ${d.depth} m`,
      }),
      Plot.dot(llpl, {
        x: d => d.ll, y: d => d.depth,
        fill: d => d.colorKey, stroke: 'white', strokeWidth: 0.8,
        symbol: 'square', r: 4.5,
        tip: true, title: d => `${d.locaId} — LL\nLL = ${d.ll}%\nDepth = ${d.depth} m`,
      }),
      Plot.dot(mc, {
        x: d => d.value, y: d => d.depth,
        fill: d => d.colorKey, stroke: 'white', strokeWidth: 0.8,
        symbol: 'circle', r: 5,
        tip: true, title: d => `${d.locaId} — MC\nMC = ${d.value}%\nDepth = ${d.depth} m`,
      }),
      Plot.text([
        { x: maxX + 4, y: 0.5, t: '□ PL' },
        { x: maxX + 4, y: 1.5, t: '■ LL' },
        { x: maxX + 4, y: 2.5, t: '● MC' },
      ], { x: 'x', y: 'y', text: 't', textAnchor: 'end', fontSize: 9, fill: '#64748b' }),
    ],
  };
}

// ── Plot registry ─────────────────────────────────────────────────────────────

export const ALL_PLOTS = [
  { id: 'spt_depth',   label: 'SPT vs Depth' },
  { id: 'spt_elev',    label: 'SPT vs Elevation' },
  { id: 'plasticity',  label: 'Plasticity Chart (A-line)' },
  { id: 'psd',         label: 'Grading / PSD' },
  { id: 'limits_depth', label: 'PL / LL / MC vs Depth' },
  { id: 'moisture',    label: 'Moisture Content vs Depth' },
  { id: 'cu',          label: 'Undrained Strength vs Depth' },
  { id: 'density',     label: 'Density vs Depth' },
  { id: 'shear',       label: 'Shear Box Envelope' },
  { id: 'compaction',  label: 'Compaction Curves' },
  { id: 'cong',        label: 'e–log σ Consolidation' },
] as const;

export type PlotId = (typeof ALL_PLOTS)[number]['id'];

// ── OPlot React component ─────────────────────────────────────────────────────

export function OPlot({ spec }: { spec: PlotSpec }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = Plot.plot({ ...spec, width: Math.max(300, el.clientWidth - 16) });
    if (chart instanceof SVGElement) {
      const w = chart.getAttribute('width'), h = chart.getAttribute('height');
      if (w && h) chart.setAttribute('viewBox', `0 0 ${w} ${h}`);
      chart.removeAttribute('width');
      chart.style.width = '100%';
      chart.style.height = 'auto';
    } else {
      const svg = chart.querySelector('svg');
      if (svg) {
        const w = svg.getAttribute('width'), h = svg.getAttribute('height');
        if (w && h) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.removeAttribute('width');
        svg.style.width = '100%';
        svg.style.height = 'auto';
      }
      (chart as HTMLElement).style.overflow = 'visible';
    }
    el.replaceChildren(chart);
    return () => { if (el) el.replaceChildren(); };
  }, [spec]);

  return <div ref={ref} style={{ padding: 8, minHeight: 120 }} />;
}

// ── PlotCard ──────────────────────────────────────────────────────────────────

export function PlotCard({ title, n, children }: { title: string; n: number; children?: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <div style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', background: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', flex: 1 }}>{title}</span>
        {n > 0 && <span style={{ fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{n.toLocaleString()} pts</span>}
      </div>
      {n === 0 ? (
        <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No data available</div>
      ) : children}
    </div>
  );
}
