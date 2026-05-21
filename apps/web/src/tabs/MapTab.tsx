import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  MapContainer, TileLayer, CircleMarker, Popup,
  WMSTileLayer, Polyline, GeoJSON as GeoJSONLayer,
  useMapEvents,
} from 'react-leaflet';
import * as L from 'leaflet';
import proj4 from 'proj4';
import 'leaflet/dist/leaflet.css';
import { decodeBytes, parseStr, buildGeo3DModel, renderBoreholeStripSvg, representativeGroundModel, geolColor } from '../core.js';
import type { AgsFile, AgsValue, RepresentativeGroundModel } from '../core.js';
import type { useLocationGroups } from '../location-groups.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const BNG = '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs';

const BASE_MAPS = [
  { id: 'osm', label: 'OpenStreetMap', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  { id: 'satellite', label: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: '&copy; Esri' },
  { id: 'topo', label: 'Topo', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenTopoMap' },
] as const;

const PREDEFINED_WMS: WmsLayerConfig[] = [
  {
    id: 'bgs-50k',
    name: 'BGS 1:50k Geology (GB)',
    url: 'https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer',
    layers: 'BGS.50k.Geology',
    format: 'image/png',
    transparent: true,
    enabled: false,
    opacity: 0.7,
    attribution: '&copy; BGS/UKRI',
  },
  {
    id: 'bgs-625k',
    name: 'BGS 1:625k Geology (GB)',
    url: 'https://map.bgs.ac.uk/arcgis/services/BGS_625k_Geology/MapServer/WMSServer',
    layers: 'BGS.625k.Geology',
    format: 'image/png',
    transparent: true,
    enabled: false,
    opacity: 0.7,
    attribution: '&copy; BGS/UKRI',
  },
  {
    id: 'bgs-superficial',
    name: 'BGS Superficial Deposits (GB)',
    url: 'https://map.bgs.ac.uk/arcgis/services/BGS_Superficial_Geology/MapServer/WMSServer',
    layers: 'BGS.SG.SuperficialDeposits',
    format: 'image/png',
    transparent: true,
    enabled: false,
    opacity: 0.7,
    attribution: '&copy; BGS/UKRI',
  },
  {
    id: 'bgs-bedrock',
    name: 'BGS Bedrock Geology (GB)',
    url: 'https://map.bgs.ac.uk/arcgis/services/BGS_Bedrock_Geology/MapServer/WMSServer',
    layers: 'BGS.50k.Bedrock',
    format: 'image/png',
    transparent: true,
    enabled: false,
    opacity: 0.7,
    attribution: '&copy; BGS/UKRI',
  },
  {
    id: 'onegeology',
    name: 'OneGeology World Geology',
    url: 'https://onegeology-europe.brgm.fr/geoserver/wms',
    layers: 'OneGeology:GE.GeologicUnit.Age',
    format: 'image/png',
    transparent: true,
    enabled: false,
    opacity: 0.6,
    attribution: '&copy; OneGeology',
  },
];

const LAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#00bcd4'];

const LOCA_TYPE_STYLES: Record<string, { fill: string; stroke: string; label: string }> = {
  BH:  { fill: '#1a4080', stroke: '#0f2644', label: 'Borehole' },
  TP:  { fill: '#d97706', stroke: '#92400e', label: 'Trial Pit' },
  WS:  { fill: '#10b981', stroke: '#065f46', label: 'Window Sample' },
  DP:  { fill: '#7c3aed', stroke: '#4c1d95', label: 'Dynamic Probe' },
  CP:  { fill: '#dc2626', stroke: '#7f1d1d', label: 'CPT' },
  CPT: { fill: '#dc2626', stroke: '#7f1d1d', label: 'CPT' },
  RC:  { fill: '#2563eb', stroke: '#1e3a5f', label: 'Rotary Core' },
  TW:  { fill: '#0d9488', stroke: '#134e4a', label: 'Trial Well' },
  PZ:  { fill: '#f59e0b', stroke: '#713f12', label: 'Piezometer' },
  SW:  { fill: '#ec4899', stroke: '#831843', label: 'Standpipe Well' },
};

function getLocaTypeStyle(type: string | null): { fill: string; stroke: string } {
  if (!type) return { fill: '#1a4080', stroke: '#0f2644' };
  const key = type.toUpperCase().trim();
  return LOCA_TYPE_STYLES[key] ?? { fill: '#6366f1', stroke: '#3730a3' };
}

function getLocaRadius(depth: string | null): number {
  if (!depth) return 7;
  const d = parseFloat(depth);
  if (isNaN(d) || d <= 0) return 7;
  return Math.min(14, Math.max(5, 5 + Math.sqrt(d / 50) * 9));
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface WmsLayerConfig {
  id: string;
  name: string;
  url: string;
  layers: string;
  format: string;
  transparent: boolean;
  enabled: boolean;
  opacity: number;
  attribution: string;
}

interface ImportedLayer {
  id: string;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any; // GeoJSON FeatureCollection
  color: string;
  visible: boolean;
}

interface BoreholePt {
  id: string;
  lat: number;
  lng: number;
  type: string | null;
  depth: string | null;
}

interface GeolInterval {
  top: number;
  base: number;
  value: string;
}

interface SectionBorehole {
  pt: BoreholePt;
  distAlongM: number;
  intervals: GeolInterval[];
  maxDepth: number;
  offsetM: number;
}

type LatLng = [number, number];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toNum(v: AgsValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseFloat(v);
    if (!isNaN(n)) return n;
  }
  return NaN;
}

function toStr(v: AgsValue): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
}

function latLngToMetres(lat: number, lng: number, refLat: number, refLng: number): [number, number] {
  const R = 6371000;
  const x = (lng - refLng) * (Math.PI / 180) * R * Math.cos(refLat * Math.PI / 180);
  const y = (lat - refLat) * (Math.PI / 180) * R;
  return [x, y];
}

function projectOntoSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { t: number; dist: number } {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { t: 0, dist: Math.hypot(px - ax, py - ay) };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return { t, dist: Math.hypot(px - ax - t * dx, py - ay - t * dy) };
}

function hashColor(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) & 0xffffffff;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue},60%,48%)`;
}

function buildColorMap(values: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of [...new Set(values)]) map.set(v, hashColor(v));
  return map;
}

function nextLayerColor(idx: number): string {
  return LAYER_COLORS[idx % LAYER_COLORS.length]!;
}

// ─── AGS extraction ───────────────────────────────────────────────────────────

function extractPoints(agsFile: AgsFile): BoreholePt[] {
  const loca = agsFile.groups['LOCA'];
  if (!loca) return [];
  const pts: BoreholePt[] = [];
  for (const row of loca.rows) {
    const id = toStr(row['LOCA_ID'] ?? null);
    if (!id) continue;
    const type = toStr(row['LOCA_TYPE'] ?? null);
    const depth = toStr(row['LOCA_FDEP'] ?? null);
    const latVal = toNum(row['LOCA_LAT'] ?? null);
    const lonVal = toNum(row['LOCA_LON'] ?? row['LOCA_LONG'] ?? null);
    if (!isNaN(latVal) && !isNaN(lonVal) && latVal !== 0 && lonVal !== 0) {
      pts.push({ id, lat: latVal, lng: lonVal, type, depth });
      continue;
    }
    const easting = toNum(row['LOCA_NATE'] ?? null);
    const northing = toNum(row['LOCA_NATN'] ?? null);
    if (!isNaN(easting) && !isNaN(northing) && easting > 0 && northing > 0) {
      try {
        const [lng, lat] = proj4(BNG, 'EPSG:4326', [easting, northing]) as [number, number];
        pts.push({ id, lat, lng, type, depth });
      } catch { /* skip */ }
    }
  }
  return pts;
}

function getGeolColumns(agsFile: AgsFile): string[] {
  const geol = agsFile.groups['GEOL'];
  if (!geol || geol.rows.length === 0) return [];
  return Object.keys(geol.rows[0]!).filter((k) => k !== 'LOCA_ID' && k !== 'GEOL_TOP' && k !== 'GEOL_BASE');
}

function extractGeolIntervals(agsFile: AgsFile, locaId: string, colorCol: string): GeolInterval[] {
  const geol = agsFile.groups['GEOL'];
  if (!geol) return [];
  return geol.rows
    .filter((row) => toStr(row['LOCA_ID'] ?? null) === locaId)
    .map((row) => ({
      top: toNum(row['GEOL_TOP'] ?? null),
      base: toNum(row['GEOL_BASE'] ?? null),
      value: toStr(row[colorCol] ?? null) ?? '',
    }))
    .filter((i) => !isNaN(i.top) && !isNaN(i.base) && i.base > i.top);
}

// ─── Section computation ──────────────────────────────────────────────────────

function computeSectionBoreholes(
  points: BoreholePt[],
  agsFile: AgsFile,
  sectionLine: LatLng[],
  bufferM: number,
  colorCol: string,
): SectionBorehole[] {
  if (sectionLine.length < 2) return [];
  const refPt = sectionLine[0]!;
  const refLat = refPt[0], refLng = refPt[1];
  const lineM = sectionLine.map(([lat, lng]) => latLngToMetres(lat, lng, refLat, refLng));
  const cumDist: number[] = [0];
  for (let i = 1; i < lineM.length; i++) {
    const cur = lineM[i]!, prev = lineM[i - 1]!;
    cumDist.push(cumDist[i - 1]! + Math.hypot(cur[0] - prev[0], cur[1] - prev[1]));
  }
  const result: SectionBorehole[] = [];
  for (const pt of points) {
    const [px, py] = latLngToMetres(pt.lat, pt.lng, refLat, refLng);
    let bestDist = Infinity, bestDistAlong = 0;
    for (let i = 0; i < lineM.length - 1; i++) {
      const [ax, ay] = lineM[i]!, [bx, by] = lineM[i + 1]!;
      const { t, dist } = projectOntoSegment(px, py, ax, ay, bx, by);
      if (dist < bestDist) {
        bestDist = dist;
        bestDistAlong = cumDist[i]! + t * (cumDist[i + 1]! - cumDist[i]!);
      }
    }
    if (bestDist > bufferM) continue;
    const intervals = extractGeolIntervals(agsFile, pt.id, colorCol);
    const fdep = pt.depth ? parseFloat(pt.depth) : NaN;
    const maxDepth = !isNaN(fdep) ? fdep
      : intervals.length ? Math.max(...intervals.map((i) => i.base))
      : 10;
    result.push({ pt, distAlongM: bestDistAlong, intervals, maxDepth, offsetM: bestDist });
  }
  return result.sort((a, b) => a.distAlongM - b.distAlongM);
}

function sectionTotalLength(line: LatLng[]): number {
  if (line.length < 2) return 0;
  const ref = line[0]!;
  const refLat = ref[0], refLng = ref[1];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const prev = line[i - 1]!, cur = line[i]!;
    const [x1, y1] = latLngToMetres(prev[0], prev[1], refLat, refLng);
    const [x2, y2] = latLngToMetres(cur[0], cur[1], refLat, refLng);
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  return total;
}

// ─── RBF helpers ─────────────────────────────────────────────────────────────

function gaussElim(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[maxRow]![col]!)) maxRow = r;
    }
    [M[col], M[maxRow]] = [M[maxRow]!, M[col]!];
    const pivot = M[col]![col]!;
    if (Math.abs(pivot) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / pivot;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i]![n]!;
    for (let j = i + 1; j < n; j++) x[i] = x[i]! - M[i]![j]! * x[j]!;
    x[i] = x[i]! / M[i]![i]!;
  }
  return x;
}

function solveRbf1D(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => ys[0]!;
  let maxDist = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      maxDist = Math.max(maxDist, Math.abs(xs[i]! - xs[j]!));
  const sigma = maxDist / 2 || 1;
  const phi = (r: number) => Math.exp(-(r * r) / (2 * sigma * sigma));
  const A = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => phi(Math.abs(xs[i]! - xs[j]!)))
  );
  for (let i = 0; i < n; i++) A[i]![i]! += 1e-6;
  const w = gaussElim(A, [...ys]);
  return (x: number) => w.reduce((sum, wi, i) => sum + wi * phi(Math.abs(x - xs[i]!)), 0);
}

// ─── CrossSectionView ────────────────────────────────────────────────────────

const SVG_M = { top: 44, right: 16, bottom: 52, left: 58 };
const BH_W = 38;

const SECTION_BTN: React.CSSProperties = {
  padding: '3px 10px', fontSize: 11, borderRadius: 4,
  border: '1px solid var(--border)', background: '#f1f5f9',
  color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit',
};

function CrossSectionView({
  boreholes,
  colorCol,
  totalLengthM,
  showSurface,
}: {
  boreholes: SectionBorehole[];
  colorCol: string;
  totalLengthM: number;
  showSurface: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const svgW = 840, svgH = 420;
  const [vb, setVb] = useState({ x: 0, y: 0, w: svgW, h: svgH });
  const dragRef = useRef<{ startX: number; startY: number; startVb: { x: number; y: number; w: number; h: number } } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      setVb(prev => {
        const mx = ((e.clientX - rect.left) / rect.width) * prev.w + prev.x;
        const my = ((e.clientY - rect.top) / rect.height) * prev.h + prev.y;
        const scale = e.deltaY > 0 ? 1.15 : 1 / 1.15;
        const nw = Math.min(svgW * 4, Math.max(svgW * 0.2, prev.w * scale));
        const nh = Math.min(svgH * 4, Math.max(svgH * 0.2, prev.h * scale));
        return {
          x: mx - (mx - prev.x) * (nw / prev.w),
          y: my - (my - prev.y) * (nh / prev.h),
          w: nw, h: nh,
        };
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, startVb: { ...vb } };
    e.preventDefault();
  }, [vb]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = ((e.clientX - dragRef.current.startX) / rect.width) * dragRef.current.startVb.w;
    const dy = ((e.clientY - dragRef.current.startY) / rect.height) * dragRef.current.startVb.h;
    setVb({ ...dragRef.current.startVb, x: dragRef.current.startVb.x - dx, y: dragRef.current.startVb.y - dy });
  }, []);

  const handleMouseUp = useCallback(() => { dragRef.current = null; }, []);

  const zoomIn = useCallback(() => setVb(p => ({ x: p.x + p.w * 0.1, y: p.y + p.h * 0.1, w: p.w * 0.8, h: p.h * 0.8 })), []);
  const zoomOut = useCallback(() => setVb(p => ({ x: p.x - p.w * 0.125, y: p.y - p.h * 0.125, w: p.w * 1.25, h: p.h * 1.25 })), []);
  const resetZoom = useCallback(() => setVb({ x: 0, y: 0, w: svgW, h: svgH }), []);

  const handleExport = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
    const str = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([str], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'cross-section.svg'; a.click();
    URL.revokeObjectURL(url);
  }, []);

  if (boreholes.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 32, color: 'var(--muted)', fontSize: 13 }}>
        No boreholes within buffer distance. Try increasing the buffer or redrawing the section line.
      </div>
    );
  }

  const allValues = boreholes.flatMap((b) => b.intervals.map((i) => i.value)).filter(Boolean);
  const colorMap = buildColorMap(allValues);
  const maxDepth = Math.max(...boreholes.map((b) => b.maxDepth), 5);
  const plotW = svgW - SVG_M.left - SVG_M.right;
  const plotH = svgH - SVG_M.top - SVG_M.bottom;
  const xS = (d: number) => totalLengthM > 0 ? (d / totalLengthM) * plotW : plotW / 2;
  const yS = (d: number) => (d / maxDepth) * plotH;

  // RBF surface paths
  const surfacePaths: Array<{ value: string; color: string; path: string }> = [];
  if (showSurface && boreholes.length >= 2) {
    const uniqueVals = [...new Set(boreholes.flatMap(b => b.intervals.map(i => i.value)).filter(Boolean))];
    for (const val of uniqueVals) {
      const pts = boreholes
        .filter(b => b.intervals.some(i => i.value === val))
        .map(b => {
          const segs = b.intervals.filter(i => i.value === val);
          return { x: b.distAlongM, top: Math.min(...segs.map(i => i.top)), base: Math.max(...segs.map(i => i.base)) };
        });
      if (pts.length < 2) continue;
      const topRbf = solveRbf1D(pts.map(p => p.x), pts.map(p => p.top));
      const baseRbf = solveRbf1D(pts.map(p => p.x), pts.map(p => p.base));
      const minX = pts[0]!.x, maxX = pts[pts.length - 1]!.x;
      const steps = 60;
      const topPts: [number, number][] = [];
      const basePts: [number, number][] = [];
      for (let s = 0; s <= steps; s++) {
        const x = minX + (maxX - minX) * (s / steps);
        const td = Math.max(0, topRbf(x));
        const bd = Math.max(td + 0.01, baseRbf(x));
        topPts.push([xS(x), yS(td)]);
        basePts.push([xS(x), yS(bd)]);
      }
      const path = [
        `M ${topPts[0]![0].toFixed(1)} ${topPts[0]![1].toFixed(1)}`,
        ...topPts.slice(1).map(p => `L ${p[0].toFixed(1)} ${p[1].toFixed(1)}`),
        ...[...basePts].reverse().map(p => `L ${p[0].toFixed(1)} ${p[1].toFixed(1)}`),
        'Z',
      ].join(' ');
      surfacePaths.push({ value: val, color: colorMap.get(val) ?? '#cbd5e1', path });
    }
  }

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ depth: f * maxDepth, y: yS(f * maxDepth) }));
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ dist: f * totalLengthM, x: xS(f * totalLengthM) }));
  const legendEntries = [...colorMap.entries()];

  return (
    <div>
      {/* Zoom / export toolbar */}
      <div style={{ display: 'flex', gap: 6, padding: '6px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center', background: '#fafafa', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)' }}>Zoom</span>
        <button onClick={zoomIn} style={SECTION_BTN}>＋</button>
        <button onClick={zoomOut} style={SECTION_BTN}>－</button>
        <button onClick={resetZoom} style={SECTION_BTN}>Reset</button>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>· Scroll to zoom · Drag to pan</span>
        <button
          onClick={handleExport}
          style={{ ...SECTION_BTN, marginLeft: 'auto', background: 'var(--navy)', color: '#fff', borderColor: 'transparent' }}
        >
          ↓ Export SVG
        </button>
      </div>

      {/* SVG container */}
      <div ref={containerRef} style={{ overflowX: 'auto', cursor: 'grab' }}>
        <svg
          ref={svgRef}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          style={{ width: '100%', minWidth: 520, height: svgH, display: 'block', userSelect: 'none' }}
          fontFamily="system-ui, sans-serif"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <g transform={`translate(${SVG_M.left},${SVG_M.top})`}>
            {/* Grid lines */}
            {yTicks.map(({ depth, y }) => (
              <line key={depth} x1={0} y1={y} x2={plotW} y2={y} stroke="#e2e8f0" strokeWidth={1} />
            ))}

            {/* RBF surface interpretation (rendered behind borehole logs) */}
            {surfacePaths.map(({ value, color, path }) => (
              <path key={value} d={path} fill={color} fillOpacity={0.3} stroke={color} strokeWidth={1.2} strokeOpacity={0.7} />
            ))}

            {/* Y axis */}
            <line x1={0} y1={0} x2={0} y2={plotH} stroke="#94a3b8" strokeWidth={1} />
            {yTicks.map(({ depth, y }) => (
              <g key={depth}>
                <line x1={-5} y1={y} x2={0} y2={y} stroke="#94a3b8" strokeWidth={1} />
                <text x={-9} y={y} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="#64748b">
                  {depth.toFixed(depth < 10 ? 1 : 0)}m
                </text>
              </g>
            ))}
            <text
              x={-SVG_M.left + 10}
              y={plotH / 2}
              transform={`rotate(-90,${-SVG_M.left + 10},${plotH / 2})`}
              textAnchor="middle"
              fontSize={11}
              fill="#475569"
            >
              Depth (m)
            </text>

            {/* X axis */}
            <line x1={0} y1={plotH} x2={plotW} y2={plotH} stroke="#94a3b8" strokeWidth={1} />
            {xTicks.map(({ dist, x }) => (
              <g key={dist}>
                <line x1={x} y1={plotH} x2={x} y2={plotH + 5} stroke="#94a3b8" strokeWidth={1} />
                <text x={x} y={plotH + 16} textAnchor="middle" fontSize={10} fill="#64748b">
                  {dist >= 1000 ? `${(dist / 1000).toFixed(1)}km` : `${Math.round(dist)}m`}
                </text>
              </g>
            ))}
            <text x={plotW / 2} y={plotH + 40} textAnchor="middle" fontSize={11} fill="#475569">
              Distance along section
            </text>

            {/* Ground surface line */}
            <line x1={0} y1={0} x2={plotW} y2={0} stroke="#0f2644" strokeWidth={1.5} strokeDasharray="5 3" />

            {/* Boreholes */}
            {boreholes.map((bh) => {
              const cx = xS(bh.distAlongM);
              const bx = cx - BH_W / 2;
              const bhH = yS(bh.maxDepth);

              return (
                <g key={bh.pt.id}>
                  <rect x={bx} y={0} width={BH_W} height={bhH} fill="#f1f5f9" stroke="#cbd5e1" strokeWidth={0.5} />
                  {bh.intervals.map((interval, idx) => {
                    const yt = yS(interval.top);
                    const h = Math.max(yS(interval.base) - yt, 1);
                    return (
                      <rect
                        key={idx}
                        x={bx} y={yt} width={BH_W} height={h}
                        fill={colorMap.get(interval.value) ?? '#cbd5e1'}
                        stroke="rgba(255,255,255,0.4)" strokeWidth={0.5}
                      >
                        <title>{`${bh.pt.id}\n${interval.top}–${interval.base} m\n${colorCol}: ${interval.value || '(blank)'}`}</title>
                      </rect>
                    );
                  })}
                  <rect x={bx} y={0} width={BH_W} height={bhH} fill="none" stroke="#475569" strokeWidth={1} />
                  <line x1={bx - 5} y1={0} x2={bx + BH_W + 5} y2={0} stroke="#0f2644" strokeWidth={2} />
                  <line x1={cx} y1={-12} x2={cx} y2={0} stroke="#0f2644" strokeWidth={1} strokeDasharray="2 2" />
                  {/* Borehole ID */}
                  <text x={cx} y={-30} textAnchor="middle" fontSize={9} fontWeight={600} fill="#0f2644" style={{ userSelect: 'none' }}>
                    {bh.pt.id.length > 10 ? bh.pt.id.slice(0, 9) + '…' : bh.pt.id}
                  </text>
                  {/* Offset annotation */}
                  <text x={cx} y={-18} textAnchor="middle" fontSize={8} fill="#64748b" style={{ userSelect: 'none' }}>
                    Δ{Math.round(bh.offsetM)}m
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* Legend */}
      {legendEntries.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 14px', padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 11 }}>
          {legendEntries.slice(0, 24).map(([val, color]) => (
            <div key={val} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 12, height: 12, borderRadius: 2, background: color, border: '1px solid rgba(0,0,0,0.12)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text)' }}>{val || '(blank)'}</span>
            </div>
          ))}
          {legendEntries.length > 24 && <span style={{ color: 'var(--muted)' }}>+{legendEntries.length - 24} more</span>}
        </div>
      )}
      {boreholes.some((b) => b.intervals.length === 0) && (
        <div style={{ padding: '6px 16px 10px', fontSize: 11, color: 'var(--muted)', borderTop: legendEntries.length > 0 ? 'none' : '1px solid var(--border)' }}>
          Some boreholes have no GEOL data — shown as grey outlines.
        </div>
      )}
    </div>
  );
}

// ─── DrawHandler ──────────────────────────────────────────────────────────────

function DrawHandler({ active, onAddPoint }: { active: boolean; onAddPoint: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      if (!active) return;
      onAddPoint(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// ─── LayerPanel ───────────────────────────────────────────────────────────────

interface LayerPanelProps {
  baseMapId: string;
  onBaseMap: (id: string) => void;
  wmsLayers: WmsLayerConfig[];
  importedLayers: ImportedLayer[];
  onWmsToggle: (id: string) => void;
  onWmsOpacity: (id: string, opacity: number) => void;
  onAddWms: (cfg: WmsLayerConfig) => void;
  onImportedToggle: (id: string) => void;
  onImportedRemove: (id: string) => void;
  onImportLayer: (name: string, data: unknown) => void;
}

function LayerPanel({
  baseMapId, onBaseMap,
  wmsLayers, importedLayers,
  onWmsToggle, onWmsOpacity, onAddWms,
  onImportedToggle, onImportedRemove, onImportLayer,
}: LayerPanelProps) {
  const [showAddWms, setShowAddWms] = useState(false);
  const [wmsUrl, setWmsUrl] = useState('');
  const [wmsLayerName, setWmsLayerName] = useState('');
  const [wmsLabel, setWmsLabel] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sec: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.5px', color: 'var(--muted)',
    padding: '10px 14px 5px',
  };
  const inputStyle: React.CSSProperties = {
    padding: '5px 8px', fontSize: 12,
    border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--card)', color: 'var(--text)', width: '100%',
  };

  const handleImportFile = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        onImportLayer(file.name, JSON.parse(e.target?.result as string));
      } catch {
        alert('Could not parse file as GeoJSON.');
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div style={{
      position: 'absolute', top: 8, right: 8, zIndex: 1001,
      width: 268, maxHeight: 504, overflowY: 'auto',
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', boxShadow: '0 4px 20px rgba(0,0,0,0.14)',
    }}>
      {/* Base map */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 13 }}>
        Layers
      </div>
      <div style={sec}>Base Map</div>
      <div style={{ display: 'flex', gap: 6, padding: '4px 14px 10px' }}>
        {BASE_MAPS.map((bm) => (
          <button
            key={bm.id}
            onClick={() => onBaseMap(bm.id)}
            style={{
              flex: 1, padding: '5px 0', fontSize: 11, borderRadius: 4,
              background: baseMapId === bm.id ? 'var(--navy)' : '#f1f5f9',
              color: baseMapId === bm.id ? '#fff' : 'var(--text)',
              border: '1px solid var(--border)',
            }}
          >
            {bm.label}
          </button>
        ))}
      </div>

      {/* WMS geology */}
      <div style={{ borderTop: '1px solid var(--border)' }}>
        <div style={sec}>Geology WMS</div>
        {wmsLayers.map((layer) => (
          <div key={layer.id} style={{ padding: '4px 14px 6px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
              <input
                type="checkbox"
                checked={layer.enabled}
                onChange={() => onWmsToggle(layer.id)}
                style={{ accentColor: 'var(--blue)', flexShrink: 0 }}
              />
              <span style={{ lineHeight: 1.3 }}>{layer.name}</span>
            </label>
            {layer.enabled && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 22, marginTop: 5 }}>
                <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>Opacity</span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={layer.opacity}
                  onChange={(e) => onWmsOpacity(layer.id, parseFloat(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 10, color: 'var(--muted)', width: 30, textAlign: 'right', flexShrink: 0 }}>
                  {Math.round(layer.opacity * 100)}%
                </span>
              </div>
            )}
          </div>
        ))}

        <div style={{ padding: '4px 14px 12px' }}>
          {!showAddWms ? (
            <button
              onClick={() => setShowAddWms(true)}
              style={{ padding: '5px 12px', fontSize: 11, background: '#f1f5f9', color: 'var(--text)', borderRadius: 4, border: '1px solid var(--border)' }}
            >
              + Custom WMS
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input placeholder="Display name" value={wmsLabel} onChange={(e) => setWmsLabel(e.target.value)} style={inputStyle} />
              <input placeholder="WMS URL" value={wmsUrl} onChange={(e) => setWmsUrl(e.target.value)} style={inputStyle} />
              <input placeholder="Layer name(s)" value={wmsLayerName} onChange={(e) => setWmsLayerName(e.target.value)} style={inputStyle} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => {
                    if (!wmsUrl.trim() || !wmsLayerName.trim()) return;
                    onAddWms({
                      id: `custom-${Date.now()}`,
                      name: wmsLabel.trim() || wmsUrl.trim(),
                      url: wmsUrl.trim(),
                      layers: wmsLayerName.trim(),
                      format: 'image/png',
                      transparent: true,
                      enabled: true,
                      opacity: 0.7,
                      attribution: 'Custom WMS',
                    });
                    setWmsUrl(''); setWmsLayerName(''); setWmsLabel('');
                    setShowAddWms(false);
                  }}
                  style={{ padding: '5px 12px', fontSize: 11, background: 'var(--blue)', color: '#fff', borderRadius: 4 }}
                >
                  Add
                </button>
                <button
                  onClick={() => setShowAddWms(false)}
                  style={{ padding: '5px 12px', fontSize: 11, background: '#f1f5f9', color: 'var(--text)', borderRadius: 4, border: '1px solid var(--border)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Imported layers */}
      <div style={{ borderTop: '1px solid var(--border)' }}>
        <div style={sec}>Imported Layers</div>
        {importedLayers.length === 0 && (
          <div style={{ padding: '2px 14px 8px', fontSize: 11, color: 'var(--muted)' }}>No layers imported yet.</div>
        )}
        {importedLayers.map((layer) => (
          <div key={layer.id} style={{ padding: '4px 14px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={layer.visible}
              onChange={() => onImportedToggle(layer.id)}
              style={{ accentColor: layer.color, flexShrink: 0 }}
            />
            <div style={{ width: 10, height: 10, borderRadius: 2, background: layer.color, flexShrink: 0 }} />
            <span style={{ fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={layer.name}>
              {layer.name}
            </span>
            <button
              onClick={() => onImportedRemove(layer.id)}
              style={{ padding: '1px 6px', fontSize: 13, background: 'none', color: '#94a3b8', borderRadius: 3, lineHeight: 1, flexShrink: 0 }}
              title="Remove layer"
            >
              ×
            </button>
          </div>
        ))}
        <div style={{ padding: '8px 14px 12px' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".geojson,.json"
            style={{ display: 'none' }}
            onChange={(e) => handleImportFile(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{ padding: '5px 12px', fontSize: 11, background: '#f1f5f9', color: 'var(--text)', borderRadius: 4, border: '1px solid var(--border)' }}
          >
            + Import GeoJSON
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── MapLegend ────────────────────────────────────────────────────────────────

function MapLegend({ points }: { points: BoreholePt[] }) {
  const presentTypes = [...new Set(points.map(p => (p.type ?? '').toUpperCase().trim() || 'BH'))];
  const depths = points.map(p => parseFloat(p.depth ?? '')).filter(d => !isNaN(d) && d > 0);
  const minDepth = depths.length ? Math.min(...depths) : null;
  const maxDepth = depths.length ? Math.max(...depths) : null;

  return (
    <div style={{
      position: 'absolute', bottom: 24, left: 8, zIndex: 1001,
      background: 'rgba(255,255,255,0.95)', border: '1px solid var(--border)',
      borderRadius: 6, padding: '8px 12px', fontSize: 11, minWidth: 130,
      boxShadow: '0 2px 8px rgba(0,0,0,0.14)', pointerEvents: 'none',
    }}>
      <div style={{ fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)', marginBottom: 6 }}>
        Symbol Key
      </div>
      {presentTypes.map(type => {
        const s = getLocaTypeStyle(type);
        const label = (LOCA_TYPE_STYLES[type]?.label ?? type) || 'Unknown';
        return (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <svg width={16} height={16} style={{ flexShrink: 0 }}>
              <circle cx={8} cy={8} r={5.5} fill={s.fill} stroke={s.stroke} strokeWidth={1.5} />
            </svg>
            <span>{label}</span>
          </div>
        );
      })}
      {minDepth !== null && maxDepth !== null && minDepth !== maxDepth && (
        <>
          <div style={{ marginTop: 8, marginBottom: 4, fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)' }}>
            Depth (size)
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width={32} height={20} style={{ flexShrink: 0 }}>
              <circle cx={8} cy={10} r={getLocaRadius(String(minDepth))} fill="#94a3b8" stroke="#64748b" strokeWidth={1} />
              <circle cx={24} cy={10} r={getLocaRadius(String(maxDepth))} fill="#94a3b8" stroke="#64748b" strokeWidth={1} />
            </svg>
            <span style={{ color: 'var(--muted)', fontSize: 10 }}>{minDepth.toFixed(0)}→{maxDepth.toFixed(0)}m</span>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Representative strip log for a location group ───────────────────────────

function RepresentativeStripLog({ model }: { model: RepresentativeGroundModel }) {
  if (model.layers.length === 0) return null;
  const totalDepth = model.maxDepth || 1;
  const W = 280;
  const H = Math.max(140, Math.min(360, totalDepth * 12));
  const colWidth = 80;
  return (
    <div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 4 }}>
        {/* Depth axis */}
        <line x1={colWidth + 4} y1={0} x2={colWidth + 4} y2={H} stroke="#94a3b8" strokeWidth={0.5} />
        {Array.from({ length: Math.ceil(totalDepth) + 1 }).map((_, i) => {
          const y = (i / totalDepth) * H;
          return (
            <g key={i}>
              <line x1={colWidth + 2} y1={y} x2={colWidth + 6} y2={y} stroke="#94a3b8" />
              <text x={colWidth + 10} y={y + 3} fontSize={9} fill="#64748b" fontFamily="ui-monospace, monospace">{i}m</text>
            </g>
          );
        })}
        {model.layers.map((l, i) => {
          const y = (l.top / totalDepth) * H;
          const h = ((l.base - l.top) / totalDepth) * H;
          const color = geolColor(l.unitKey);
          return (
            <g key={i}>
              <rect x={0} y={y} width={colWidth} height={h} fill={color} stroke="#1e293b" strokeWidth={0.4} />
              {h > 18 && (
                <text x={colWidth / 2} y={y + h / 2 + 3} fontSize={10} fill="#fff" textAnchor="middle" fontFamily="ui-monospace, monospace" style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.5)', strokeWidth: 2 }}>
                  {l.unitKey.slice(0, 8)}
                </text>
              )}
              {/* Support indicator: tiny bar on the right */}
              <rect x={W - 60} y={y + h / 2 - 2} width={Math.round(50 * l.support)} height={4} fill={l.support >= 0.7 ? '#16a34a' : l.support >= 0.4 ? '#f59e0b' : '#dc2626'} />
              {h > 16 && (
                <text x={W - 8} y={y + h / 2 + 3} fontSize={9} fill="#64748b" textAnchor="end" fontFamily="ui-monospace, monospace">
                  {(l.support * 100).toFixed(0)}%
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
        Mode unit per 0.25 m slice across the group; bars show borehole agreement (support).
      </div>
    </div>
  );
}

// ─── Location-groups side panel ───────────────────────────────────────────────

interface LocationGroupsPanelProps {
  groups: ReturnType<typeof useLocationGroups>['groups'];
  activeGroupId: string | null;
  editingGroupId: string | null;
  allLocaIds: string[];
  focusedGroupId: string | null;
  representativeModel: RepresentativeGroundModel | null;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onRecolor: (id: string, color: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onActivate: (id: string) => void;
  onClose: () => void;
}

function LocationGroupsPanel({
  groups, activeGroupId, editingGroupId, allLocaIds,
  focusedGroupId, representativeModel,
  onCreate, onRename, onRecolor, onDelete, onEdit, onActivate, onClose,
}: LocationGroupsPanelProps) {
  const [newName, setNewName] = useState('');
  const handleCreate = () => {
    const name = newName.trim() || `Group ${groups.length + 1}`;
    onCreate(name);
    setNewName('');
  };

  return (
    <div style={{
      width: 320, height: 520, flexShrink: 0,
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--card)', overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid var(--border)',
        background: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', flex: 1 }}>
          Location Groups
        </span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 16, padding: '0 2px', lineHeight: 1 }}
          title="Close"
        >×</button>
      </div>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
          placeholder="New group name…"
          style={{ flex: 1, padding: '5px 8px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 4, background: '#fff' }}
        />
        <button
          onClick={handleCreate}
          style={{ padding: '5px 10px', fontSize: 12, background: 'var(--navy)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
        >
          + Add
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {representativeModel && representativeModel.layers.length > 0 && (
          <div style={{ padding: '6px 12px 10px', borderBottom: '1px solid var(--surface-muted)', background: '#fffdf6' }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)', marginBottom: 4 }}>
              Representative stratigraphy
              <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: 6 }}>
                ({representativeModel.contributingLocaIds.length} BH, {representativeModel.maxDepth.toFixed(1)} m)
              </span>
            </div>
            <RepresentativeStripLog model={representativeModel} />
          </div>
        )}
        {focusedGroupId && (!representativeModel || representativeModel.layers.length === 0) && (
          <div style={{ padding: '8px 12px 10px', borderBottom: '1px solid var(--surface-muted)', fontSize: 11, color: 'var(--muted)' }}>
            Need at least 2 boreholes with GEOL data in this group to compute a representative stratigraphy.
          </div>
        )}
        {groups.length === 0 && (
          <div style={{ padding: '20px 14px', color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
            No groups yet. Create one above, then click <strong>✎ Edit</strong> on the group and tap boreholes on the map to assign them. Groups filter Plots, the Map and the Report.
          </div>
        )}
        {groups.map((g) => {
          const isActive = activeGroupId === g.id;
          const isEditing = editingGroupId === g.id;
          const known = g.locaIds.filter((id) => allLocaIds.includes(id)).length;
          const missing = g.locaIds.length - known;
          return (
            <div key={g.id} style={{
              padding: '8px 12px', borderBottom: '1px solid var(--surface-muted)',
              background: isEditing ? '#fef9c3' : isActive ? '#eff6ff' : undefined,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <input
                  type="color"
                  value={g.color}
                  onChange={(e) => onRecolor(g.id, e.target.value)}
                  style={{ width: 22, height: 22, padding: 0, border: '1px solid var(--border)', borderRadius: 4, background: 'none', cursor: 'pointer' }}
                  title="Change colour"
                />
                <input
                  type="text"
                  defaultValue={g.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== g.name) onRename(g.id, v);
                  }}
                  style={{ flex: 1, padding: '4px 6px', fontSize: 12, fontWeight: 600, border: '1px solid transparent', borderRadius: 3, background: 'transparent', color: 'var(--text)' }}
                />
                <button
                  onClick={() => onDelete(g.id)}
                  style={{ padding: '2px 6px', fontSize: 11, background: 'transparent', color: 'var(--muted)', border: 'none', cursor: 'pointer' }}
                  title="Delete group"
                >🗑</button>
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 6 }}>
                {known} borehole{known === 1 ? '' : 's'}{missing > 0 && ` · ${missing} not in current file`}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onClick={() => onEdit(g.id)}
                  style={{
                    flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 4,
                    background: isEditing ? '#f59e0b' : '#f1f5f9',
                    color: isEditing ? '#fff' : 'var(--text)',
                    border: '1px solid var(--border)', cursor: 'pointer',
                  }}
                  title="Click boreholes on the map to add/remove"
                >
                  {isEditing ? '✓ Done' : '✎ Edit members'}
                </button>
                <button
                  onClick={() => onActivate(g.id)}
                  style={{
                    flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 4,
                    background: isActive ? 'var(--navy)' : '#f1f5f9',
                    color: isActive ? '#fff' : 'var(--text)',
                    border: '1px solid var(--border)', cursor: 'pointer',
                  }}
                  title="Apply this group as the active filter for plots and reports"
                >
                  {isActive ? '● Filtering' : '○ Apply filter'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── MapTab ───────────────────────────────────────────────────────────────────

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
  onLocaClick?: (locaId: string) => void;
  locationGroups?: ReturnType<typeof useLocationGroups>;
}

export function MapTab({ fileBytes, fileName, onLocaClick, locationGroups }: Props) {
  const [baseMapId, setBaseMapId] = useState('osm');
  const [wmsLayers, setWmsLayers] = useState<WmsLayerConfig[]>(PREDEFINED_WMS);
  const [importedLayers, setImportedLayers] = useState<ImportedLayer[]>([]);
  const importedCountRef = useRef(0);
  const [showLayerPanel, setShowLayerPanel] = useState(false);

  const [selectedBhId, setSelectedBhId] = useState<string | null>(null);

  const [drawMode, setDrawMode] = useState(false);
  const [sectionLine, setSectionLine] = useState<LatLng[]>([]);
  const [sectionComplete, setSectionComplete] = useState(false);

  const [showGroupPanel, setShowGroupPanel] = useState(false);
  /** When non-null, clicking a borehole marker toggles its membership in this group. */
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

  const [colorCol, setColorCol] = useState('GEOL_GEOL');
  const [bufferM, setBufferM] = useState(500);
  const [showSurface, setShowSurface] = useState(false);

  const agsFile = useMemo<AgsFile | null>(() => {
    if (!fileBytes) return null;
    try { return parseStr(decodeBytes(fileBytes)).file; }
    catch { return null; }
  }, [fileBytes, fileName]);

  const points = useMemo(() => (agsFile ? extractPoints(agsFile) : []), [agsFile]);
  const geolColumns = useMemo(() => (agsFile ? getGeolColumns(agsFile) : []), [agsFile]);

  const geo3DModel = useMemo(() => {
    if (!agsFile) return null;
    try { return buildGeo3DModel(agsFile); } catch { return null; }
  }, [agsFile]);

  const stripLogSvg = useMemo(() => {
    if (!geo3DModel || !selectedBhId) return null;
    const bh = geo3DModel.boreholes.find((b: { id: string }) => b.id === selectedBhId);
    return bh ? renderBoreholeStripSvg(bh) : null;
  }, [geo3DModel, selectedBhId]);

  const sectionBoreholes = useMemo(() => {
    if (!agsFile || !sectionComplete || sectionLine.length < 2) return [];
    return computeSectionBoreholes(points, agsFile, sectionLine, bufferM, colorCol);
  }, [agsFile, points, sectionLine, sectionComplete, bufferM, colorCol]);

  const totalLengthM = useMemo(() => sectionTotalLength(sectionLine), [sectionLine]);

  const handleAddPoint = useCallback((lat: number, lng: number) => {
    setSectionLine((prev) => [...prev, [lat, lng]]);
  }, []);

  const startDraw = useCallback(() => {
    setSectionLine([]);
    setSectionComplete(false);
    setDrawMode(true);
  }, []);

  const finishSection = useCallback(() => {
    setSectionComplete(true);
    setDrawMode(false);
  }, []);

  const clearSection = useCallback(() => {
    setSectionLine([]);
    setSectionComplete(false);
    setDrawMode(false);
  }, []);

  const wmsToggle = useCallback((id: string) =>
    setWmsLayers((prev) => prev.map((l) => l.id === id ? { ...l, enabled: !l.enabled } : l)), []);

  const wmsOpacity = useCallback((id: string, opacity: number) =>
    setWmsLayers((prev) => prev.map((l) => l.id === id ? { ...l, opacity } : l)), []);

  const addWms = useCallback((cfg: WmsLayerConfig) =>
    setWmsLayers((prev) => [...prev, cfg]), []);

  const importedToggle = useCallback((id: string) =>
    setImportedLayers((prev) => prev.map((l) => l.id === id ? { ...l, visible: !l.visible } : l)), []);

  const importedRemove = useCallback((id: string) =>
    setImportedLayers((prev) => prev.filter((l) => l.id !== id)), []);

  const importLayer = useCallback((name: string, data: unknown) => {
    const idx = importedCountRef.current++;
    setImportedLayers((prev) => [
      ...prev,
      { id: `imported-${Date.now()}`, name, data, color: nextLayerColor(idx), visible: true },
    ]);
  }, []);

  const baseMap = BASE_MAPS.find((b) => b.id === baseMapId) ?? BASE_MAPS[0];

  // Pre-compute the group membership map for fast lookups when rendering markers.
  const groupColorByLoca = useMemo<Map<string, string[]>>(() => {
    const m = new Map<string, string[]>();
    if (!locationGroups) return m;
    for (const g of locationGroups.groups) {
      for (const id of g.locaIds) {
        const arr = m.get(id) ?? [];
        arr.push(g.color);
        m.set(id, arr);
      }
    }
    return m;
  }, [locationGroups]);

  const editingGroup = locationGroups?.groups.find((g) => g.id === editingGroupId) ?? null;

  // Representative ground model for whichever group the user has currently focused
  // (edit-mode wins so the user gets live feedback while editing membership).
  const focusedGroup = editingGroup ?? locationGroups?.activeGroup ?? null;
  const representativeModel = useMemo<RepresentativeGroundModel | null>(() => {
    if (!agsFile || !focusedGroup || focusedGroup.locaIds.length < 2) return null;
    try {
      return representativeGroundModel(agsFile, focusedGroup.locaIds);
    } catch {
      return null;
    }
  }, [agsFile, focusedGroup]);

  const toggleMemberInEditingGroup = useCallback((locaId: string) => {
    if (!locationGroups || !editingGroup) return;
    const has = editingGroup.locaIds.includes(locaId);
    const next = has
      ? editingGroup.locaIds.filter((id) => id !== locaId)
      : [...editingGroup.locaIds, locaId];
    locationGroups.update(editingGroup.id, { locaIds: next });
  }, [locationGroups, editingGroup]);

  const createGroupFromSection = useCallback(() => {
    if (!locationGroups || sectionBoreholes.length === 0) return;
    const ids = sectionBoreholes.map((b) => b.pt.id);
    const g = locationGroups.create(`Section group ${locationGroups.groups.length + 1}`, ids);
    setEditingGroupId(g.id);
    setShowGroupPanel(true);
  }, [locationGroups, sectionBoreholes]);

  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
        <p>Drop an AGS file above to view borehole locations.</p>
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
        <p>No mappable coordinates found.</p>
        <p style={{ fontSize: 12, marginTop: 8 }}>
          Map view requires <code>LOCA_LAT</code>/<code>LOCA_LON</code> or BNG{' '}
          <code>LOCA_NATE</code>/<code>LOCA_NATN</code> fields in the LOCA group.
        </p>
      </div>
    );
  }

  const centerLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const centerLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  const inSection = new Set(sectionBoreholes.map((b) => b.pt.id));
  const editingGroupSet = new Set(editingGroup?.locaIds ?? []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {points.length} borehole{points.length !== 1 ? 's' : ''}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={() => setShowLayerPanel((v) => !v)}
            style={{
              padding: '6px 14px', fontSize: 12,
              background: showLayerPanel ? 'var(--navy)' : '#f1f5f9',
              color: showLayerPanel ? '#fff' : 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 6,
            }}
          >
            ☰ Layers
          </button>

          {locationGroups && (
            <button
              onClick={() => setShowGroupPanel((v) => !v)}
              style={{
                padding: '6px 14px', fontSize: 12,
                background: showGroupPanel ? 'var(--navy)' : '#f1f5f9',
                color: showGroupPanel ? '#fff' : 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 6,
              }}
              title="Define groups of boreholes to filter plots and reports"
            >
              👥 Groups{locationGroups.groups.length > 0 ? ` (${locationGroups.groups.length})` : ''}
            </button>
          )}

          {sectionComplete && sectionBoreholes.length > 0 && locationGroups && (
            <button
              onClick={createGroupFromSection}
              style={{ padding: '6px 14px', fontSize: 12, background: '#dcfce7', color: '#15803d', border: '1px solid #86efac', borderRadius: 6 }}
              title="Make a group containing every borehole in the current section"
            >
              + Group from section
            </button>
          )}

          {!drawMode && !sectionComplete && (
            <button
              onClick={startDraw}
              style={{ padding: '6px 14px', fontSize: 12, background: '#f1f5f9', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }}
            >
              ✏ Draw Section
            </button>
          )}
          {drawMode && (
            <>
              <button
                onClick={finishSection}
                disabled={sectionLine.length < 2}
                style={{
                  padding: '6px 14px', fontSize: 12,
                  background: sectionLine.length >= 2 ? '#16a34a' : undefined,
                  color: sectionLine.length >= 2 ? '#fff' : undefined,
                  borderRadius: 6,
                }}
              >
                ✓ Finish Section
              </button>
              <button
                onClick={clearSection}
                style={{ padding: '6px 14px', fontSize: 12, background: '#fee2e2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 6 }}
              >
                Cancel
              </button>
            </>
          )}
          {sectionComplete && (
            <button
              onClick={clearSection}
              style={{ padding: '6px 14px', fontSize: 12, background: '#fee2e2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 6 }}
            >
              × Clear Section
            </button>
          )}
        </div>
      </div>

      {/* Draw hint */}
      {drawMode && (
        <div style={{ padding: '8px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 12, color: '#1d4ed8' }}>
          {sectionLine.length === 0
            ? 'Click on the map to place section line vertices.'
            : `${sectionLine.length} point${sectionLine.length !== 1 ? 's' : ''} placed — click to continue, then press "Finish Section".`}
        </div>
      )}

      {/* Group-edit hint */}
      {editingGroup && (
        <div style={{ padding: '8px 14px', background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 6, fontSize: 12, color: '#854d0e' }}>
          Editing <strong>{editingGroup.name}</strong> — click boreholes on the map to add or remove them ({editingGroup.locaIds.length} selected).
        </div>
      )}

      {/* Map + optional strip log panel */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, position: 'relative', borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)', height: 520, minWidth: 0 }}>
        <MapContainer
          center={[centerLat, centerLng]}
          zoom={13}
          style={{ height: '100%', width: '100%', cursor: drawMode ? 'crosshair' : undefined }}
          scrollWheelZoom
        >
          <TileLayer url={baseMap.url} attribution={baseMap.attribution} />

          {wmsLayers.filter((l) => l.enabled).map((layer) => (
            <WMSTileLayer
              key={layer.id}
              url={layer.url}
              layers={layer.layers}
              format={layer.format}
              transparent={layer.transparent}
              opacity={layer.opacity}
              attribution={layer.attribution}
            />
          ))}

          {importedLayers.filter((l) => l.visible).map((layer) => (
            <GeoJSONLayer
              key={layer.id}
              data={layer.data}
              style={{ color: layer.color, weight: 2, fillOpacity: 0.3, fillColor: layer.color }}
              pointToLayer={(_feat, latlng) =>
                L.circleMarker(latlng, { radius: 5, color: layer.color, fillColor: layer.color, fillOpacity: 0.8, weight: 1.5 })
              }
            />
          ))}

          {points.map((pt) => {
            const typeStyle = getLocaTypeStyle(pt.type);
            const radius = getLocaRadius(pt.depth);
            const isSelected = pt.id === selectedBhId;
            const groupColors = groupColorByLoca.get(pt.id) ?? [];
            const inEditingGroup = editingGroupSet.has(pt.id);
            const activeGroupColor = locationGroups?.activeGroup?.color ?? null;
            const inActiveGroup = locationGroups?.activeLocaSet.has(pt.id) ?? false;
            // Outline priority: edit-mode > section > selected > active-group > group membership > type
            const stroke = inEditingGroup
              ? (editingGroup?.color ?? '#16a34a')
              : isSelected
                ? '#7c3aed'
                : inSection.has(pt.id)
                  ? '#16a34a'
                  : inActiveGroup && activeGroupColor
                    ? activeGroupColor
                    : groupColors[0] ?? typeStyle.stroke;
            const fill = isSelected ? '#7c3aed'
              : inSection.has(pt.id) ? '#16a34a'
              : typeStyle.fill;
            return (
            <CircleMarker
              key={pt.id}
              center={[pt.lat, pt.lng]}
              radius={radius + (groupColors.length > 0 ? 1 : 0)}
              pathOptions={{
                color: stroke,
                fillColor: fill,
                fillOpacity: editingGroupId && !inEditingGroup ? 0.45 : 0.9,
                weight: (isSelected || inSection.has(pt.id) || inEditingGroup || groupColors.length > 0) ? 3 : 2,
              }}
              eventHandlers={{
                click: () => {
                  if (editingGroupId) {
                    toggleMemberInEditingGroup(pt.id);
                  } else {
                    setSelectedBhId(prev => prev === pt.id ? null : pt.id);
                  }
                },
              }}
            >
              <Popup>
                <div style={{ minWidth: 140 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{pt.id}</div>
                  {pt.type && <div style={{ fontSize: 12, color: '#64748b', marginBottom: 2 }}>Type: {pt.type}</div>}
                  {pt.depth && <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>Depth: {pt.depth} m</div>}
                  {inSection.has(pt.id) && (
                    <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 600, marginBottom: 4 }}>✓ In cross-section</div>
                  )}
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    {geo3DModel && (
                      <button
                        onClick={() => setSelectedBhId(prev => prev === pt.id ? null : pt.id)}
                        style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                      >
                        {selectedBhId === pt.id ? 'Hide Log' : 'Strip Log'}
                      </button>
                    )}
                    {onLocaClick && (
                      <button
                        onClick={() => onLocaClick(pt.id)}
                        style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, background: '#0f2644', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                      >
                        View Data
                      </button>
                    )}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          )})}

          {/* Section line vertices */}
          {sectionLine.map((pt, i) => (
            <CircleMarker
              key={`sp-${i}`}
              center={pt}
              radius={4}
              pathOptions={{ color: '#dc2626', fillColor: '#dc2626', fillOpacity: 1, weight: 1 }}
            />
          ))}

          {/* Section polyline */}
          {sectionLine.length >= 2 && (
            <Polyline
              positions={sectionLine}
              pathOptions={{
                color: '#dc2626',
                weight: 2.5,
                dashArray: sectionComplete ? undefined : '7 5',
              }}
            />
          )}

          <DrawHandler active={drawMode} onAddPoint={handleAddPoint} />
        </MapContainer>

        <MapLegend points={points} />

        {/* Layer panel overlay */}
        {showLayerPanel && (
          <LayerPanel
            baseMapId={baseMapId}
            onBaseMap={setBaseMapId}
            wmsLayers={wmsLayers}
            importedLayers={importedLayers}
            onWmsToggle={wmsToggle}
            onWmsOpacity={wmsOpacity}
            onAddWms={addWms}
            onImportedToggle={importedToggle}
            onImportedRemove={importedRemove}
            onImportLayer={importLayer}
          />
        )}
      </div>

      {/* Location-groups side panel */}
      {showGroupPanel && locationGroups && (
        <LocationGroupsPanel
          groups={locationGroups.groups}
          activeGroupId={locationGroups.activeGroupId}
          editingGroupId={editingGroupId}
          allLocaIds={points.map(p => p.id)}
          focusedGroupId={focusedGroup?.id ?? null}
          representativeModel={representativeModel}
          onCreate={(name) => {
            const g = locationGroups.create(name, []);
            setEditingGroupId(g.id);
          }}
          onRename={(id, name) => locationGroups.update(id, { name })}
          onRecolor={(id, color) => locationGroups.update(id, { color })}
          onDelete={(id) => {
            locationGroups.remove(id);
            if (editingGroupId === id) setEditingGroupId(null);
          }}
          onEdit={(id) => setEditingGroupId(editingGroupId === id ? null : id)}
          onActivate={(id) => locationGroups.setActiveGroupId(locationGroups.activeGroupId === id ? null : id)}
          onClose={() => { setShowGroupPanel(false); setEditingGroupId(null); }}
        />
      )}

      {/* Strip log side panel */}
      {selectedBhId && (
        <div style={{
          width: 320, height: 520, flexShrink: 0,
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          background: 'var(--card)', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            padding: '8px 12px', borderBottom: '1px solid var(--border)',
            background: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', flex: 1 }}>
              Strip Log: <span style={{ fontFamily: 'monospace', color: '#7c3aed' }}>{selectedBhId}</span>
            </span>
            <button
              onClick={() => setSelectedBhId(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 16, padding: '0 2px', lineHeight: 1 }}
              title="Close"
            >×</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
            {stripLogSvg
              ? <div dangerouslySetInnerHTML={{ __html: stripLogSvg }} />
              : <div style={{ textAlign: 'center', padding: 24, color: 'var(--muted)', fontSize: 12 }}>
                  No lithology data for this location
                </div>
            }
          </div>
        </div>
      )}
      </div>{/* end map+striplog flex row */}

      {/* Cross-section panel */}
      {sectionComplete && sectionLine.length >= 2 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--card)', overflow: 'hidden' }}>
          <div style={{
            padding: '10px 16px', borderBottom: '1px solid var(--border)',
            background: '#f8fafc', display: 'flex', alignItems: 'center',
            gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Cross Section</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {sectionBoreholes.length} borehole{sectionBoreholes.length !== 1 ? 's' : ''}
              {' · '}
              {totalLengthM >= 1000 ? `${(totalLengthM / 1000).toFixed(2)} km` : `${Math.round(totalLengthM)} m`}
            </span>

            <button
              onClick={() => setShowSurface(v => !v)}
              style={{
                padding: '4px 12px', fontSize: 12, borderRadius: 4,
                background: showSurface ? 'var(--blue)' : '#f1f5f9',
                color: showSurface ? '#fff' : 'var(--text)',
                border: '1px solid var(--border)', cursor: 'pointer',
              }}
            >
              {showSurface ? '◈ Surface On' : '◇ Surface Off'}
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>Colour by</label>
              <select
                value={colorCol}
                onChange={(e) => setColorCol(e.target.value)}
                style={{ padding: '4px 8px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card)', color: 'var(--text)' }}
              >
                {geolColumns.length > 0
                  ? geolColumns.map((c) => <option key={c} value={c}>{c}</option>)
                  : <option value="GEOL_GEOL">GEOL_GEOL</option>}
              </select>

              <label style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>Buffer</label>
              <input
                type="number"
                value={bufferM}
                onChange={(e) => setBufferM(Math.max(1, Number(e.target.value)))}
                style={{ padding: '4px 8px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 4, width: 72, background: 'var(--card)', color: 'var(--text)' }}
                min={1}
                max={50000}
              />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>m</span>
            </div>
          </div>

          <CrossSectionView
            boreholes={sectionBoreholes}
            colorCol={colorCol}
            totalLengthM={totalLengthM}
            showSurface={showSurface}
          />
        </div>
      )}
    </div>
  );
}
