import { useState, useMemo, useCallback, useRef } from 'react';
import {
  MapContainer, TileLayer, CircleMarker, Popup,
  WMSTileLayer, Polyline, GeoJSON as GeoJSONLayer,
  useMapEvents,
} from 'react-leaflet';
import * as L from 'leaflet';
import proj4 from 'proj4';
import 'leaflet/dist/leaflet.css';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile, AgsValue } from '../core.js';

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
    result.push({ pt, distAlongM: bestDistAlong, intervals, maxDepth });
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

// ─── CrossSectionView ────────────────────────────────────────────────────────

const SVG_M = { top: 44, right: 16, bottom: 52, left: 58 };
const BH_W = 38;

function CrossSectionView({
  boreholes,
  colorCol,
  totalLengthM,
}: {
  boreholes: SectionBorehole[];
  colorCol: string;
  totalLengthM: number;
}) {
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
  const svgW = 840, svgH = 420;
  const plotW = svgW - SVG_M.left - SVG_M.right;
  const plotH = svgH - SVG_M.top - SVG_M.bottom;
  const xS = (d: number) => totalLengthM > 0 ? (d / totalLengthM) * plotW : plotW / 2;
  const yS = (d: number) => (d / maxDepth) * plotH;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ depth: f * maxDepth, y: yS(f * maxDepth) }));
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ dist: f * totalLengthM, x: xS(f * totalLengthM) }));
  const legendEntries = [...colorMap.entries()];

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ width: '100%', minWidth: 520, height: svgH, display: 'block' }}
        fontFamily="system-ui, sans-serif"
      >
        <g transform={`translate(${SVG_M.left},${SVG_M.top})`}>
          {/* Grid lines */}
          {yTicks.map(({ depth, y }) => (
            <line key={depth} x1={0} y1={y} x2={plotW} y2={y} stroke="#e2e8f0" strokeWidth={1} />
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
                {/* Background (no data) */}
                <rect x={bx} y={0} width={BH_W} height={bhH} fill="#f1f5f9" stroke="#cbd5e1" strokeWidth={0.5} />

                {/* Geology intervals */}
                {bh.intervals.map((interval, idx) => {
                  const yt = yS(interval.top);
                  const h = Math.max(yS(interval.base) - yt, 1);
                  return (
                    <rect
                      key={idx}
                      x={bx}
                      y={yt}
                      width={BH_W}
                      height={h}
                      fill={colorMap.get(interval.value) ?? '#cbd5e1'}
                      stroke="rgba(255,255,255,0.4)"
                      strokeWidth={0.5}
                    >
                      <title>{`${bh.pt.id}\n${interval.top}–${interval.base} m\n${colorCol}: ${interval.value || '(blank)'}`}</title>
                    </rect>
                  );
                })}

                {/* Outline */}
                <rect x={bx} y={0} width={BH_W} height={bhH} fill="none" stroke="#475569" strokeWidth={1} />

                {/* Ground peg */}
                <line x1={bx - 5} y1={0} x2={bx + BH_W + 5} y2={0} stroke="#0f2644" strokeWidth={2} />
                <line x1={cx} y1={-20} x2={cx} y2={0} stroke="#0f2644" strokeWidth={1} strokeDasharray="2 2" />

                {/* Label */}
                <text
                  x={cx}
                  y={-24}
                  textAnchor="middle"
                  fontSize={9}
                  fontWeight={600}
                  fill="#0f2644"
                  style={{ userSelect: 'none' }}
                >
                  {bh.pt.id.length > 12 ? bh.pt.id.slice(0, 11) + '…' : bh.pt.id}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Legend */}
      {legendEntries.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '5px 14px',
          padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 11,
        }}>
          {legendEntries.slice(0, 24).map(([val, color]) => (
            <div key={val} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 12, height: 12, borderRadius: 2, background: color, border: '1px solid rgba(0,0,0,0.12)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text)' }}>{val || '(blank)'}</span>
            </div>
          ))}
          {legendEntries.length > 24 && (
            <span style={{ color: 'var(--muted)' }}>+{legendEntries.length - 24} more</span>
          )}
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

// ─── MapTab ───────────────────────────────────────────────────────────────────

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
  onLocaClick?: (locaId: string) => void;
}

export function MapTab({ fileBytes, fileName, onLocaClick }: Props) {
  const [baseMapId, setBaseMapId] = useState('osm');
  const [wmsLayers, setWmsLayers] = useState<WmsLayerConfig[]>(PREDEFINED_WMS);
  const [importedLayers, setImportedLayers] = useState<ImportedLayer[]>([]);
  const importedCountRef = useRef(0);
  const [showLayerPanel, setShowLayerPanel] = useState(false);

  const [drawMode, setDrawMode] = useState(false);
  const [sectionLine, setSectionLine] = useState<LatLng[]>([]);
  const [sectionComplete, setSectionComplete] = useState(false);

  const [colorCol, setColorCol] = useState('GEOL_GEOL');
  const [bufferM, setBufferM] = useState(500);

  const agsFile = useMemo<AgsFile | null>(() => {
    if (!fileBytes) return null;
    try { return parseStr(decodeBytes(fileBytes)).file; }
    catch { return null; }
  }, [fileBytes, fileName]);

  const points = useMemo(() => (agsFile ? extractPoints(agsFile) : []), [agsFile]);
  const geolColumns = useMemo(() => (agsFile ? getGeolColumns(agsFile) : []), [agsFile]);

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

      {/* Map */}
      <div style={{ position: 'relative', borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)', height: 520 }}>
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

          {points.map((pt) => (
            <CircleMarker
              key={pt.id}
              center={[pt.lat, pt.lng]}
              radius={7}
              pathOptions={{
                color: '#0f2644',
                fillColor: inSection.has(pt.id) ? '#16a34a' : '#1a4080',
                fillOpacity: 0.9,
                weight: 2,
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
                  {onLocaClick && (
                    <button
                      onClick={() => onLocaClick(pt.id)}
                      style={{ marginTop: 4, padding: '4px 10px', fontSize: 11, fontWeight: 600, background: '#0f2644', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                    >
                      View Data
                    </button>
                  )}
                </div>
              </Popup>
            </CircleMarker>
          ))}

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
          />
        </div>
      )}
    </div>
  );
}
