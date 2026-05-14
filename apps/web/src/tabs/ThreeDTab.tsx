/**
 * ThreeDTab — ThatOpen-inspired geological 3-D viewer.
 *
 * Layout (two-panel, resizable):
 *   LEFT  — Three.js scene with floating toolbar
 *   RIGHT — collapsible panel stack:
 *             • Controls (opacity, V-exag, unit visibility)
 *             • Cross Sections (add / delete / shift-plane / hatched SVG)
 *             • Borehole Log (strip log for selected borehole)
 *             • Plan View (always-on mini-map, used for section picking)
 *
 * Three.js interactions:
 *   SELECT tool — click a borehole cylinder → shows strip log in right panel
 *   SECTION tool — click two points on plan view → live hatched cross-section
 *   Section plane — visible in 3-D, shift via slider in section card
 */

import {
  useEffect, useRef, useState, useCallback, useMemo, type CSSProperties,
} from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile } from '../core.js';
import {
  buildGeo3DModel, renderBoreholeStripSvg, geolColor as _geolColor,
} from '@geoflow/core';
import type { Geo3DModel, GeoUnit, Borehole3D } from '@geoflow/core';

// ── Constants ─────────────────────────────────────────────────────────────────

const GRID_N  = 36;
const SECT_N  = 100;
const RIGHT_W = 400; // initial right-panel width (px)

// ── Helpers ───────────────────────────────────────────────────────────────────

function hexToThree(hex: string): THREE.Color { return new THREE.Color(hex); }
function darken(hex: string, f = 0.7): string {
  const c = new THREE.Color(hex); c.multiplyScalar(f); return '#' + c.getHexString();
}
function niceStep(rough: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(rough)));
  const n = rough / p;
  return n < 1.5 ? p : n < 3.5 ? 2 * p : n < 7.5 ? 5 * p : 10 * p;
}

// ── SVG hatch patterns ────────────────────────────────────────────────────────

const HATCH_DEFS = `<defs>
<pattern id="h-clay"      patternUnits="userSpaceOnUse" width="12" height="5">
  <line x1="0" y1="2.5" x2="12" y2="2.5" stroke="#7B9EC5" stroke-width="1"/>
</pattern>
<pattern id="h-silt"      patternUnits="userSpaceOnUse" width="10" height="5">
  <line x1="0" y1="2.5" x2="10" y2="2.5" stroke="#C4A87C" stroke-width="0.7"/>
  <circle cx="5" cy="4" r="0.6" fill="#C4A87C"/>
</pattern>
<pattern id="h-sand"      patternUnits="userSpaceOnUse" width="8" height="8">
  <circle cx="2" cy="2" r="0.9" fill="#c8a600"/>
  <circle cx="6" cy="6" r="0.9" fill="#c8a600"/>
</pattern>
<pattern id="h-gravel"    patternUnits="userSpaceOnUse" width="12" height="10">
  <ellipse cx="3" cy="3" rx="2.2" ry="1.4" fill="none" stroke="#C87A45" stroke-width="0.9"/>
  <ellipse cx="9" cy="7" rx="2.2" ry="1.4" fill="none" stroke="#C87A45" stroke-width="0.9"/>
</pattern>
<pattern id="h-chalk"     patternUnits="userSpaceOnUse" width="10" height="10">
  <line x1="0" y1="10" x2="10" y2="0" stroke="#cfc080" stroke-width="0.8"/>
  <line x1="-2" y1="4" x2="4" y2="-2" stroke="#cfc080" stroke-width="0.8"/>
  <line x1="6" y1="12" x2="12" y2="6" stroke="#cfc080" stroke-width="0.8"/>
</pattern>
<pattern id="h-rock"      patternUnits="userSpaceOnUse" width="14" height="8">
  <line x1="0" y1="0" x2="14" y2="0" stroke="#8888a0" stroke-width="0.8"/>
  <line x1="0" y1="8" x2="14" y2="8" stroke="#8888a0" stroke-width="0.8"/>
  <line x1="0" y1="0" x2="0"  y2="8" stroke="#8888a0" stroke-width="0.8"/>
  <line x1="7" y1="0" x2="7"  y2="8" stroke="#8888a0" stroke-width="0.8"/>
</pattern>
<pattern id="h-sandstone" patternUnits="userSpaceOnUse" width="10" height="10">
  <line x1="0" y1="10" x2="10" y2="0" stroke="#D4B483" stroke-width="0.8"/>
  <circle cx="5" cy="5" r="0.7" fill="#D4B483"/>
</pattern>
<pattern id="h-mudstone"  patternUnits="userSpaceOnUse" width="10" height="8">
  <line x1="0" y1="4" x2="10" y2="4" stroke="#7A7A90" stroke-width="0.8"/>
  <line x1="0" y1="0" x2="10" y2="8" stroke="#7A7A90" stroke-width="0.5" stroke-dasharray="2,3"/>
</pattern>
<pattern id="h-limestone" patternUnits="userSpaceOnUse" width="12" height="8">
  <line x1="0" y1="0" x2="12" y2="0" stroke="#C8CEB8" stroke-width="0.7"/>
  <line x1="0" y1="4" x2="12" y2="4" stroke="#C8CEB8" stroke-width="0.7"/>
  <line x1="6" y1="0" x2="6"  y2="4" stroke="#C8CEB8" stroke-width="0.7"/>
</pattern>
<pattern id="h-fill"      patternUnits="userSpaceOnUse" width="10" height="10">
  <line x1="0" y1="0" x2="10" y2="10" stroke="#A0785A" stroke-width="0.8"/>
  <line x1="0" y1="5" x2="5"  y2="0"  stroke="#A0785A" stroke-width="0.5"/>
  <line x1="5" y1="10" x2="10" y2="5" stroke="#A0785A" stroke-width="0.5"/>
</pattern>
<pattern id="h-topsoil"   patternUnits="userSpaceOnUse" width="8" height="8">
  <line x1="0" y1="4" x2="8" y2="4" stroke="#5C7A3E" stroke-width="0.8"/>
  <circle cx="2" cy="2" r="0.7" fill="#5C7A3E"/>
  <circle cx="6" cy="6" r="0.7" fill="#5C7A3E"/>
</pattern>
<pattern id="h-peat"      patternUnits="userSpaceOnUse" width="8" height="8">
  <circle cx="2" cy="2" r="1" fill="#3D2B1F"/>
  <circle cx="6" cy="6" r="1" fill="#3D2B1F"/>
</pattern>
<pattern id="h-none"      patternUnits="userSpaceOnUse" width="8" height="8">
  <line x1="0" y1="8" x2="8" y2="0" stroke="#bbb" stroke-width="0.5"/>
</pattern>
</defs>`;

const KNOWN_HATCHES = ['clay','silt','sand','gravel','chalk','rock','sandstone','mudstone','limestone','fill','topsoil','peat'];
function hatchUrl(h: string) { return `url(#h-${KNOWN_HATCHES.includes(h) ? h : 'none'})`; }

// ── Cross-section SVG ─────────────────────────────────────────────────────────

interface SecPt { x: number; y: number; }

function buildSectionSvg(
  model: Geo3DModel,
  p0: SecPt,
  p1: SecPt,
  normalOffset = 0,
): string {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return '';

  // Shift p0/p1 along the plane normal by offset
  const nx = -dy / len; const ny = dx / len;
  const ap0 = { x: p0.x + nx * normalOffset, y: p0.y + ny * normalOffset };
  const ap1 = { x: p1.x + nx * normalOffset, y: p1.y + ny * normalOffset };

  const { zMin, zMax } = model.bounds;
  const W = 860; const H = 420;
  const PL = 64; const PR = 16; const PT = 24; const PB = 46;
  const plotW = W - PL - PR; const plotH = H - PT - PB;

  const xs = (d: number) => PL + (d / len) * plotW;
  const elevR = Math.max(zMax - zMin, 1);
  const ys = (z: number) => PT + (1 - (z - zMin) / elevR) * plotH;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif">`);
  out.push(HATCH_DEFS);
  out.push(`<rect x="${PL}" y="${PT}" width="${plotW}" height="${plotH}" fill="#f8fafc" stroke="#94a3b8" stroke-width="1"/>`);

  // Elevation grid
  const eStep = niceStep(elevR / 6);
  const eStart = Math.ceil(zMin / eStep) * eStep;
  for (let z = eStart; z <= zMax + 0.001; z += eStep) {
    const sy = ys(z);
    out.push(`<line x1="${PL}" y1="${sy.toFixed(1)}" x2="${PL + plotW}" y2="${sy.toFixed(1)}" stroke="#e2e8f0" stroke-width="0.8"/>`);
    out.push(`<text x="${PL - 5}" y="${(sy + 3.5).toFixed(1)}" font-size="9.5" fill="#64748b" text-anchor="end">${z.toFixed(0)}</text>`);
  }

  // Distance ticks
  const dStep = niceStep(len / 6);
  for (let d = 0; d <= len + 0.001; d += dStep) {
    const sx = xs(d);
    out.push(`<line x1="${sx.toFixed(1)}" y1="${PT + plotH}" x2="${sx.toFixed(1)}" y2="${PT + plotH + 5}" stroke="#64748b" stroke-width="1"/>`);
    out.push(`<text x="${sx.toFixed(1)}" y="${PT + plotH + 18}" font-size="9.5" fill="#64748b" text-anchor="middle">${d.toFixed(0)}</text>`);
  }
  out.push(`<text x="${PL + plotW / 2}" y="${H - 6}" font-size="10" fill="#475569" text-anchor="middle">Distance along section (m)</text>`);
  out.push(`<text x="12" y="${PT + plotH / 2}" font-size="10" fill="#475569" text-anchor="middle" transform="rotate(-90 12 ${PT + plotH / 2})">Elevation (m OD)</text>`);

  // Clip region
  out.push(`<clipPath id="plot-clip"><rect x="${PL}" y="${PT}" width="${plotW}" height="${plotH}"/></clipPath>`);
  out.push('<g clip-path="url(#plot-clip)">');

  // Unit surfaces
  for (const unit of model.units) {
    if (!unit.topSurface || !unit.baseSurface) continue;
    const top  = unit.topSurface.sampleLine(ap0.x, ap0.y, ap1.x, ap1.y, SECT_N);
    const base = unit.baseSurface.sampleLine(ap0.x, ap0.y, ap1.x, ap1.y, SECT_N);

    const fwd  = top.map(s  => `${xs(s.dist).toFixed(1)},${ys(s.z).toFixed(1)}`);
    const rev  = base.slice().reverse();
    const bpts = rev.map(s => `${xs(s.dist).toFixed(1)},${ys(s.z).toFixed(1)}`);
    const poly = [...fwd, ...bpts].join(' ');

    out.push(`<polygon points="${poly}" fill="${unit.color}" fill-opacity="0.5"/>`);
    out.push(`<polygon points="${poly}" fill="${hatchUrl(unit.hatch)}" fill-opacity="0.9"/>`);

    const topPts  = top.map(s  => `${xs(s.dist).toFixed(1)},${ys(s.z).toFixed(1)}`).join(' ');
    const basePts = base.map(s => `${xs(s.dist).toFixed(1)},${ys(s.z).toFixed(1)}`).join(' ');
    out.push(`<polyline points="${topPts}"  fill="none" stroke="${darken(unit.color)}" stroke-width="1.2"/>`);
    out.push(`<polyline points="${basePts}" fill="none" stroke="${darken(unit.color, 0.5)}" stroke-width="0.9" stroke-dasharray="4,2"/>`);
  }

  // Boreholes near section
  for (const bh of model.boreholes) {
    const t = ((bh.x - ap0.x) * dx + (bh.y - ap0.y) * dy) / (len * len);
    if (t < -0.02 || t > 1.02) continue;
    const px2 = ap0.x + t * dx - bh.x; const py2 = ap0.y + t * dy - bh.y;
    if (Math.sqrt(px2 * px2 + py2 * py2) > len * 0.2 + 8) continue;
    const sx = xs(t * len);
    for (const layer of bh.layers) {
      const y1 = ys(layer.topElev); const y2 = ys(layer.baseElev);
      const h = Math.abs(y2 - y1);
      out.push(`<rect x="${(sx - 5).toFixed(1)}" y="${Math.min(y1, y2).toFixed(1)}" width="10" height="${h.toFixed(1)}" fill="${layer.color}" stroke="#334155" stroke-width="0.4"/>`);
    }
    out.push(`<line x1="${sx.toFixed(1)}" y1="${ys(bh.elev).toFixed(1)}" x2="${sx.toFixed(1)}" y2="${ys(bh.elev - bh.finDepth).toFixed(1)}" stroke="#111" stroke-width="2"/>`);
    out.push(`<text x="${sx.toFixed(1)}" y="${(ys(bh.elev) - 5).toFixed(1)}" font-size="8.5" fill="#0f2644" text-anchor="middle" font-weight="700">${bh.id}</text>`);
  }

  out.push('</g>');

  // Border + labels
  out.push(`<rect x="${PL}" y="${PT}" width="${plotW}" height="${plotH}" fill="none" stroke="#64748b" stroke-width="1.5"/>`);
  out.push(`<text x="${PL + 4}" y="${PT + 14}" font-size="11" fill="#1a4080" font-weight="700">A</text>`);
  out.push(`<text x="${PL + plotW - 4}" y="${PT + 14}" font-size="11" fill="#1a4080" font-weight="700" text-anchor="end">B</text>`);

  out.push('</svg>');
  return out.join('\n');
}

// ── Three.js helpers ──────────────────────────────────────────────────────────

function makeSurfaceMesh(model: Geo3DModel, unit: GeoUnit, side: 'top' | 'base', opacity: number): THREE.Mesh | null {
  const surf = side === 'top' ? unit.topSurface : unit.baseSurface;
  if (!surf) return null;
  const { xMin, xMax, yMin, yMax } = model.bounds;
  const nx = GRID_N; const ny = GRID_N;
  const zg = surf.evaluateGrid(xMin, xMax, yMin, yMax, nx, ny);
  const pos = new Float32Array(nx * ny * 3);
  const idx: number[] = [];
  for (let iy = 0; iy < ny; iy++) {
    const y = yMin + (iy / (ny - 1)) * (yMax - yMin);
    for (let ix = 0; ix < nx; ix++) {
      const x = xMin + (ix / (nx - 1)) * (xMax - xMin);
      const i = iy * nx + ix;
      pos[i * 3]     = x;
      pos[i * 3 + 1] = zg[i] ?? 0;
      pos[i * 3 + 2] = -y;
    }
  }
  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iy * nx + ix; const b = a + 1; const c = a + nx; const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshPhongMaterial({
    color: hexToThree(side === 'top' ? unit.color : darken(unit.color, 0.55)),
    transparent: true, opacity, side: THREE.DoubleSide, shininess: 25,
  });
  return new THREE.Mesh(geo, mat);
}

function makeBhGroup(bh: Borehole3D, vExag: number): { group: THREE.Group; meshes: THREE.Mesh[] } {
  const group = new THREE.Group();
  group.position.set(bh.x, 0, -bh.y);
  const meshes: THREE.Mesh[] = [];

  // Stick
  const stickG = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, bh.elev * vExag, 0),
    new THREE.Vector3(0, (bh.elev - bh.finDepth) * vExag, 0),
  ]);
  group.add(new THREE.Line(stickG, new THREE.LineBasicMaterial({ color: 0x111111 })));

  // Layer cylinders
  for (const layer of bh.layers) {
    const h = Math.max(0.01, layer.baseDepth - layer.topDepth) * vExag;
    const geo = new THREE.CylinderGeometry(1.8, 1.8, h, 8);
    const mat = new THREE.MeshPhongMaterial({ color: hexToThree(layer.color), shininess: 30 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, (bh.elev - layer.topDepth - (layer.baseDepth - layer.topDepth) / 2) * vExag, 0);
    mesh.userData['bhId'] = bh.id;
    group.add(mesh);
    meshes.push(mesh);
  }

  // Label
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 22px system-ui,sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillText(bh.id, 6, 44);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }));
  sprite.position.set(5, bh.elev * vExag + 6, 0);
  sprite.scale.set(22, 5.5, 1);
  group.add(sprite);

  return { group, meshes };
}

// ── Section-plane mesh in 3D ──────────────────────────────────────────────────

function makeSectionPlaneMesh(
  p0: SecPt, p1: SecPt,
  zMin: number, zMax: number,
  vExag: number,
  normalOffset: number,
): THREE.Mesh {
  const dx = p1.x - p0.x; const dy = p1.y - p0.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const nx = -dy / len; const ny2 = dx / len;
  const cx = (p0.x + p1.x) / 2 + nx * normalOffset;
  const cy = (p0.y + p1.y) / 2 + ny2 * normalOffset;
  const cz = ((zMin + zMax) / 2) * vExag;
  const h = (zMax - zMin) * vExag + 10;

  const geo = new THREE.PlaneGeometry(len, h);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x2060cc, transparent: true, opacity: 0.12, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);

  // Align plane to section direction
  const angle = Math.atan2(dx, dy);
  mesh.rotation.set(0, angle, 0);
  mesh.position.set(cx, cz, -cy);

  // Dashed border
  const corners = [
    new THREE.Vector3(-len / 2, -h / 2, 0),
    new THREE.Vector3( len / 2, -h / 2, 0),
    new THREE.Vector3( len / 2,  h / 2, 0),
    new THREE.Vector3(-len / 2,  h / 2, 0),
    new THREE.Vector3(-len / 2, -h / 2, 0),
  ];
  const borderGeo = new THREE.BufferGeometry().setFromPoints(corners);
  const border = new THREE.Line(borderGeo, new THREE.LineBasicMaterial({ color: 0x2060cc }));
  mesh.add(border);

  return mesh;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Section {
  id: string;
  name: string;
  ptA: SecPt;
  ptB: SecPt;
  offset: number;   // shift along plane normal (m)
  expanded: boolean;
  svg: string;
}

type Tool = 'select' | 'section';
type PickStep = 'idle' | 'a' | 'b';

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
}

// ── Small UI components ───────────────────────────────────────────────────────

function ToolBtn({
  active, title, onClick, children,
}: { active: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 34, height: 34, border: 'none', borderRadius: 6,
        background: active ? '#1a4080' : 'rgba(255,255,255,0.88)',
        color: active ? '#fff' : '#334155',
        fontSize: 16, fontWeight: 700, cursor: 'pointer',
        boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {children}
    </button>
  );
}

function CollapsiblePanel({
  title, children, defaultOpen = true,
}: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: '1px solid #e2e8f0' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 14px', background: '#f8fafc', border: 'none', cursor: 'pointer',
          fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
          color: '#334155',
        }}
      >
        <span style={{ fontSize: 10, opacity: 0.6 }}>{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && <div style={{ padding: '10px 14px' }}>{children}</div>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ThreeDTab({ fileBytes, fileName }: Props) {
  // ── Refs (Three.js) ─────────────────────────────────────────────────────────
  const mountRef    = useRef<HTMLDivElement>(null);
  const rendRef     = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef    = useRef<THREE.Scene | null>(null);
  const camRef      = useRef<THREE.PerspectiveCamera | null>(null);
  const ctrlRef     = useRef<OrbitControls | null>(null);
  const rafRef      = useRef<number>(0);
  const bhMeshesRef = useRef<{ mesh: THREE.Mesh; id: string }[]>([]);
  const secPlaneRef = useRef<THREE.Mesh | null>(null);

  // ── Core state ──────────────────────────────────────────────────────────────
  const [model, setModel] = useState<Geo3DModel | null>(null);
  const [opacity, setOpacity]     = useState(0.52);
  const [vExag, setVExag]         = useState(1.0);
  const [hiddenUnits, setHiddenUnits] = useState<Set<string>>(new Set());

  // ── Tool state ──────────────────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState<Tool>('select');
  const [pickStep, setPickStep]     = useState<PickStep>('idle');
  const [draftA, setDraftA]         = useState<SecPt | null>(null);

  // ── Sections ────────────────────────────────────────────────────────────────
  const [sections, setSections]     = useState<Section[]>([]);
  const [activeSec, setActiveSec]   = useState<string | null>(null);

  // ── Borehole selection ──────────────────────────────────────────────────────
  const [selectedBh, setSelectedBh] = useState<Borehole3D | null>(null);
  const bhLogSvg = useMemo(() => selectedBh ? renderBoreholeStripSvg(selectedBh) : null, [selectedBh]);

  // ── Right-panel width (resizable) ───────────────────────────────────────────
  const [rightW, setRightW] = useState(RIGHT_W);
  const dividerDragRef = useRef(false);

  // ── Parse AGS file ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!fileBytes) { setModel(null); setSections([]); setSelectedBh(null); return; }
    try {
      const file: AgsFile = parseStr(decodeBytes(fileBytes)).file;
      setModel(buildGeo3DModel(file));
      setSections([]); setSelectedBh(null); setPickStep('idle'); setDraftA(null);
    } catch { setModel(null); }
  }, [fileBytes]);

  // ── Three.js scene init ─────────────────────────────────────────────────────
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const w = el.clientWidth || 600; const h = el.clientHeight || 540;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);
    rendRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xedf2f7);
    sceneRef.current = scene;

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 0.95);
    dir.position.set(100, 200, 80);
    scene.add(dir);

    const cam = new THREE.PerspectiveCamera(45, w / h, 0.1, 100000);
    cam.position.set(0, 200, 400);
    camRef.current = cam;

    const ctrl = new OrbitControls(cam, renderer.domElement);
    ctrl.enableDamping = true;
    ctrl.dampingFactor = 0.08;
    ctrlRef.current = ctrl;

    scene.add(new THREE.GridHelper(2000, 30, 0xaec6d0, 0xd4e0e8));

    const animate = () => { rafRef.current = requestAnimationFrame(animate); ctrl.update(); renderer.render(scene, cam); };
    animate();

    const onResize = () => {
      const nw = el.clientWidth; const nh = el.clientHeight || 540;
      cam.aspect = nw / nh; cam.updateProjectionMatrix(); renderer.setSize(nw, nh);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', onResize);
      ctrl.dispose(); renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, []);

  // ── Rebuild scene when model / params change ─────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !model) return;

    // Remove previous model objects
    const old: THREE.Object3D[] = [];
    scene.traverse(o => { if (o.userData['isModel']) old.push(o); });
    old.forEach(o => scene.remove(o));
    bhMeshesRef.current = [];
    secPlaneRef.current = null;

    const { bounds } = model;
    const gw = bounds.xMax - bounds.xMin + 80;
    const gd = bounds.yMax - bounds.yMin + 80;
    const groundGeo = new THREE.PlaneGeometry(gw, gd);
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshPhongMaterial({ color: 0xc8d8e0, transparent: true, opacity: 0.4 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((bounds.xMin + bounds.xMax) / 2, (bounds.zMin - 1) * vExag, -(bounds.yMin + bounds.yMax) / 2);
    ground.userData['isModel'] = true;
    scene.add(ground);

    // Boreholes
    for (const bh of model.boreholes) {
      const { group, meshes } = makeBhGroup(bh, vExag);
      group.userData['isModel'] = true;
      scene.add(group);
      for (const m of meshes) bhMeshesRef.current.push({ mesh: m, id: bh.id });
    }

    // Surfaces
    const surfGrp = new THREE.Group();
    surfGrp.userData['isModel'] = true;
    for (const unit of model.units) {
      if (hiddenUnits.has(unit.key)) continue;
      const top  = makeSurfaceMesh(model, unit, 'top',  opacity);
      const base = makeSurfaceMesh(model, unit, 'base', opacity * 0.65);
      if (top)  { top.scale.y  = vExag; surfGrp.add(top); }
      if (base) { base.scale.y = vExag; surfGrp.add(base); }
    }
    scene.add(surfGrp);

    // Fit camera
    const cx = (bounds.xMin + bounds.xMax) / 2;
    const cy = (bounds.yMin + bounds.yMax) / 2;
    const cz = ((bounds.zMin + bounds.zMax) / 2) * vExag;
    const r  = Math.max(bounds.xMax - bounds.xMin, bounds.yMax - bounds.yMin, (bounds.zMax - bounds.zMin) * vExag) * 0.9;
    camRef.current?.position.set(cx + r, cz + r * 0.7, -cy + r);
    ctrlRef.current?.target.set(cx, cz, -cy);
    ctrlRef.current?.update();
  }, [model, opacity, hiddenUnits, vExag]);

  // ── Update section plane in 3D when active section changes ─────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    // Remove old section plane
    if (secPlaneRef.current) { scene.remove(secPlaneRef.current); secPlaneRef.current = null; }
    if (!model || !activeSec) return;
    const sec = sections.find(s => s.id === activeSec);
    if (!sec) return;
    const planeMesh = makeSectionPlaneMesh(sec.ptA, sec.ptB, model.bounds.zMin, model.bounds.zMax, vExag, sec.offset);
    planeMesh.userData['isModel'] = true;
    scene.add(planeMesh);
    secPlaneRef.current = planeMesh;
  }, [model, sections, activeSec, vExag]);

  // ── Raycasting for borehole selection ───────────────────────────────────────
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool !== 'select') return;
    const renderer = rendRef.current;
    const cam = camRef.current;
    if (!renderer || !cam || !model) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, cam);
    const hits = ray.intersectObjects(bhMeshesRef.current.map(x => x.mesh));
    if (hits.length === 0) { setSelectedBh(null); return; }
    const hit = hits[0];
    if (!hit) return;
    const bhId = hit.object.userData['bhId'] as string | undefined;
    if (!bhId) return;
    const bh = model.boreholes.find(b => b.id === bhId) ?? null;
    setSelectedBh(bh);
  }, [activeTool, model]);

  // ── Plan view canvas ─────────────────────────────────────────────────────────
  const planRef = useRef<HTMLCanvasElement>(null);

  const drawPlan = useCallback(() => {
    const canvas = planRef.current;
    if (!canvas || !model) return;
    const ctx = canvas.getContext('2d')!;
    const { bounds } = model;
    const W = canvas.width; const H = canvas.height;
    const pad = 18;
    const xr = bounds.xMax - bounds.xMin || 1;
    const yr = bounds.yMax - bounds.yMin || 1;
    const sx = (x: number) => pad + ((x - bounds.xMin) / xr) * (W - pad * 2);
    const sy = (y: number) => pad + (1 - (y - bounds.yMin) / yr) * (H - pad * 2);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f0f4f8'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1; ctx.strokeRect(pad, pad, W - pad * 2, H - pad * 2);

    // Boreholes
    for (const bh of model.boreholes) {
      const isSelected = selectedBh?.id === bh.id;
      ctx.beginPath();
      ctx.arc(sx(bh.x), sy(bh.y), isSelected ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? '#dc2626' : '#1a4080';
      ctx.fill();
      ctx.font = '8px system-ui';
      ctx.fillStyle = '#0f172a';
      ctx.fillText(bh.id, sx(bh.x) + 8, sy(bh.y) + 3);
    }

    // All sections
    for (const sec of sections) {
      const isActive = sec.id === activeSec;
      ctx.beginPath();
      ctx.moveTo(sx(sec.ptA.x), sy(sec.ptA.y));
      ctx.lineTo(sx(sec.ptB.x), sy(sec.ptB.y));
      ctx.strokeStyle = isActive ? '#dc2626' : '#f59e0b';
      ctx.lineWidth = isActive ? 2 : 1.5;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);

      const mx = (sx(sec.ptA.x) + sx(sec.ptB.x)) / 2;
      const my = (sy(sec.ptA.y) + sy(sec.ptB.y)) / 2;
      ctx.font = 'bold 9px system-ui';
      ctx.fillStyle = isActive ? '#dc2626' : '#92400e';
      ctx.fillText(sec.name, mx + 4, my - 3);
    }

    // Draft section in progress
    if (pickStep !== 'idle' && draftA) {
      ctx.beginPath();
      ctx.arc(sx(draftA.x), sy(draftA.y), 6, 0, Math.PI * 2);
      ctx.fillStyle = '#dc2626'; ctx.fill();
      ctx.font = 'bold 10px system-ui'; ctx.fillStyle = '#dc2626';
      ctx.fillText('A', sx(draftA.x) + 8, sy(draftA.y) - 5);
    }
  }, [model, sections, activeSec, selectedBh, pickStep, draftA]);

  useEffect(() => { drawPlan(); }, [drawPlan]);

  const handlePlanClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = planRef.current;
    if (!canvas || !model || activeTool !== 'section' || pickStep === 'idle') return;

    const rect = canvas.getBoundingClientRect();
    const { bounds } = model;
    const W = canvas.width; const H = canvas.height;
    const pad = 18;
    const lx = bounds.xMin + ((e.clientX - rect.left - pad) / (W - pad * 2)) * (bounds.xMax - bounds.xMin || 1);
    const ly = bounds.yMin + (1 - (e.clientY - rect.top - pad) / (H - pad * 2)) * (bounds.yMax - bounds.yMin || 1);
    const pt = { x: lx, y: ly };

    if (pickStep === 'a') {
      setDraftA(pt); setPickStep('b');
    } else if (pickStep === 'b' && draftA) {
      const id = `sec-${Date.now()}`;
      const name = `S${sections.length + 1}`;
      const svg = buildSectionSvg(model, draftA, pt, 0);
      setSections(prev => [...prev, { id, name, ptA: draftA, ptB: pt, offset: 0, expanded: true, svg }]);
      setActiveSec(id);
      setPickStep('idle'); setDraftA(null); setActiveTool('select');
    }
  }, [model, activeTool, pickStep, draftA, sections.length]);

  // Update section SVG when offset changes
  const updateSectionOffset = useCallback((id: string, offset: number) => {
    setSections(prev => prev.map(s => {
      if (s.id !== id || !model) return s;
      return { ...s, offset, svg: buildSectionSvg(model, s.ptA, s.ptB, offset) };
    }));
  }, [model]);

  const toggleUnit = (key: string) => {
    setHiddenUnits(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };

  // ── Divider drag ─────────────────────────────────────────────────────────────
  const onDividerMouseDown = () => { dividerDragRef.current = true; };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dividerDragRef.current) return;
      const container = mountRef.current?.parentElement?.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newRight = Math.max(280, Math.min(640, rect.right - e.clientX));
      setRightW(newRight);
    };
    const onUp = () => { dividerDragRef.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // ── SVG export helper ────────────────────────────────────────────────────────
  const exportSectionSvg = (sec: Section) => {
    const blob = new Blob([sec.svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(fileName ?? 'section').replace(/\.ags$/i, '')}-${sec.name}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  const cs: CSSProperties = { boxSizing: 'border-box' };
  const noFile = !fileBytes;
  const noModel = fileBytes && !model;

  if (noFile || noModel) {
    return (
      <div style={{ ...cs, textAlign: 'center', padding: '64px 24px', color: noModel ? '#dc2626' : '#64748b',
        background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8 }}>
        {noFile ? 'Load an AGS file to enable 3-D view' : 'Could not build 3-D model — check that LOCA contains coordinate data'}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: 700, border: '1px solid #cbd5e1', borderRadius: 8, overflow: 'hidden', background: '#edf2f7' }}>

      {/* ── LEFT: 3-D viewport ── */}
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }} onClick={handleCanvasClick}>
        {/* Floating toolbar */}
        <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <ToolBtn active={activeTool === 'select'}
            title="Select borehole (click in 3-D)"
            onClick={() => { setActiveTool('select'); setPickStep('idle'); setDraftA(null); }}>
            ⊙
          </ToolBtn>
          <ToolBtn active={activeTool === 'section'}
            title="Add cross-section (draw A→B on plan)"
            onClick={() => { setActiveTool('section'); setPickStep('a'); setDraftA(null); }}>
            ⊘
          </ToolBtn>
          <ToolBtn active={false}
            title="Clear all sections"
            onClick={() => { setSections([]); setActiveSec(null); }}>
            ✕
          </ToolBtn>
        </div>

        {/* Tool hint overlay */}
        {activeTool === 'section' && pickStep !== 'idle' && (
          <div style={{
            position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 10,
            background: 'rgba(15,22,36,0.82)', color: '#fff', borderRadius: 20,
            padding: '5px 16px', fontSize: 12, fontWeight: 600, pointerEvents: 'none',
          }}>
            {pickStep === 'a' ? 'Click plan view (right panel) to place point A' : 'Click plan view to place point B'}
          </div>
        )}
        {activeTool === 'select' && (
          <div style={{
            position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 10,
            background: 'rgba(15,22,36,0.7)', color: '#fff', borderRadius: 20,
            padding: '5px 16px', fontSize: 11, fontWeight: 500, pointerEvents: 'none',
          }}>
            Click a borehole to view its log →
          </div>
        )}

        <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      </div>

      {/* ── DIVIDER ── */}
      <div
        onMouseDown={onDividerMouseDown}
        style={{ width: 5, background: '#cbd5e1', cursor: 'col-resize', flexShrink: 0, zIndex: 5,
          transition: 'background 0.1s' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#94a3b8')}
        onMouseLeave={e => (e.currentTarget.style.background = '#cbd5e1')}
      />

      {/* ── RIGHT: panel stack ── */}
      <div style={{ width: rightW, flexShrink: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', background: '#fff', minWidth: 0 }}>

        {/* Controls */}
        <CollapsiblePanel title="Controls">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Opacity */}
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 3 }}>Surface opacity</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="range" min={0} max={1} step={0.05} value={opacity}
                  style={{ flex: 1 }} onChange={e => setOpacity(+e.target.value)} />
                <span style={{ fontSize: 11, color: '#64748b', width: 30 }}>{Math.round(opacity * 100)}%</span>
              </div>
            </div>
            {/* V-exag */}
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 3 }}>Vertical exaggeration</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="range" min={0.5} max={10} step={0.5} value={vExag}
                  style={{ flex: 1 }} onChange={e => setVExag(+e.target.value)} />
                <span style={{ fontSize: 11, color: '#64748b', width: 30 }}>{vExag.toFixed(1)}×</span>
              </div>
            </div>
            {/* Unit visibility */}
            {model && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 5 }}>Geological units</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {model.units.map(u => (
                    <button key={u.key} onClick={() => toggleUnit(u.key)} style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '3px 9px', fontSize: 10, fontWeight: 600,
                      border: '1.5px solid #cbd5e1', borderRadius: 20,
                      background: hiddenUnits.has(u.key) ? '#f1f5f9' : u.color,
                      color: hiddenUnits.has(u.key) ? '#94a3b8' : '#1a1a1a',
                      cursor: 'pointer', opacity: hiddenUnits.has(u.key) ? 0.55 : 1,
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: u.color, border: '1px solid rgba(0,0,0,0.2)', flexShrink: 0 }}/>
                      {u.key}
                      {!u.topSurface && <span style={{ color: '#94a3b8', fontSize: 8 }}>◌</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsiblePanel>

        {/* Cross Sections */}
        <CollapsiblePanel title={`Cross Sections${sections.length ? ` (${sections.length})` : ''}`}>
          {/* Add section button */}
          <button
            onClick={() => { setActiveTool('section'); setPickStep('a'); setDraftA(null); }}
            style={{
              width: '100%', padding: '7px 12px', marginBottom: 8,
              border: '1.5px dashed #94a3b8', borderRadius: 6, background: '#f8fafc',
              color: '#475569', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            + Draw new section (A→B on plan)
          </button>

          {sections.length === 0 && (
            <p style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', margin: '8px 0' }}>
              No sections yet — use the ⊘ tool or button above
            </p>
          )}

          {sections.map(sec => (
            <div key={sec.id} style={{
              border: `1.5px solid ${activeSec === sec.id ? '#1a4080' : '#e2e8f0'}`,
              borderRadius: 7, marginBottom: 8, overflow: 'hidden',
            }}>
              {/* Section header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: activeSec === sec.id ? '#eff6ff' : '#f8fafc' }}>
                <button onClick={() => setActiveSec(id => id === sec.id ? null : sec.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 11, color: '#64748b' }}>
                  {sec.expanded ? '▾' : '▸'}
                </button>
                <span style={{ fontWeight: 700, fontSize: 12, color: '#0f2644', flex: 1 }}>{sec.name}</span>
                <button onClick={() => exportSectionSvg(sec)}
                  title="Export SVG"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#2563eb' }}>
                  ↓
                </button>
                <button onClick={() => {
                  setSections(prev => prev.filter(s => s.id !== sec.id));
                  if (activeSec === sec.id) setActiveSec(null);
                }}
                  title="Delete section"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#94a3b8' }}>
                  ×
                </button>
              </div>

              {/* Section controls */}
              <div style={{ padding: '6px 10px 8px', borderTop: '1px solid #f0f4f8' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <label style={{ fontSize: 10, fontWeight: 600, color: '#64748b', whiteSpace: 'nowrap' }}>Shift plane</label>
                  <input type="range"
                    min={-50} max={50} step={1}
                    value={sec.offset}
                    style={{ flex: 1 }}
                    onChange={e => {
                      setActiveSec(sec.id);
                      updateSectionOffset(sec.id, +e.target.value);
                    }}
                  />
                  <span style={{ fontSize: 10, color: '#64748b', width: 36, textAlign: 'right' }}>{sec.offset.toFixed(0)} m</span>
                </div>
                <button onClick={() => {
                  setActiveSec(sec.id);
                  setSections(prev => prev.map(s => s.id === sec.id ? { ...s, expanded: !s.expanded } : s));
                }}
                  style={{ fontSize: 10, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  {sec.expanded ? 'Hide SVG ▲' : 'Show SVG ▼'}
                </button>
              </div>

              {/* Section SVG */}
              {sec.expanded && sec.svg && (
                <div style={{ overflowX: 'auto', padding: '0 10px 10px', background: '#fff' }}>
                  <div dangerouslySetInnerHTML={{ __html: sec.svg }} />
                </div>
              )}
            </div>
          ))}
        </CollapsiblePanel>

        {/* Borehole Log */}
        <CollapsiblePanel title={selectedBh ? `Log: ${selectedBh.id}` : 'Borehole Log'} defaultOpen={true}>
          {!selectedBh && (
            <p style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', margin: '8px 0' }}>
              Click a borehole in the 3-D view to show its log
            </p>
          )}
          {selectedBh && bhLogSvg && (
            <div>
              <div style={{ overflowX: 'auto' }}>
                <div dangerouslySetInnerHTML={{ __html: bhLogSvg }} />
              </div>
              <div style={{ marginTop: 6, fontSize: 10, color: '#94a3b8' }}>
                {selectedBh.layers.length} layer{selectedBh.layers.length !== 1 ? 's' : ''} · {selectedBh.finDepth.toFixed(1)} m depth
              </div>
            </div>
          )}
        </CollapsiblePanel>

        {/* Plan View */}
        <CollapsiblePanel title="Plan View">
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 5 }}>
            {activeTool === 'section' && pickStep !== 'idle'
              ? `Click to place point ${pickStep === 'a' ? 'A' : 'B'}`
              : 'All sections shown · click in 3-D to select a borehole'}
          </div>
          <canvas
            ref={planRef}
            width={rightW - 28}
            height={Math.round((rightW - 28) * 0.65)}
            onClick={handlePlanClick}
            style={{
              borderRadius: 6, border: '1px solid #e2e8f0', display: 'block',
              cursor: activeTool === 'section' && pickStep !== 'idle' ? 'crosshair' : 'default',
            }}
          />
          {/* Legend */}
          {model && (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '3px 10px' }}>
              {model.units.map(u => (
                <div key={u.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: u.color, border: '1px solid rgba(0,0,0,0.15)', display: 'inline-block', flexShrink: 0 }}/>
                  {u.key}
                </div>
              ))}
            </div>
          )}
        </CollapsiblePanel>

      </div>
    </div>
  );
}
