/**
 * ThreeDTab — interactive 3-D geological viewer.
 *
 * Features:
 *   • Three.js scene with orbit controls
 *   • Per-borehole coloured layer cylinders
 *   • RBF (thin-plate spline) interpolated top/base surfaces per geological unit
 *   • Cross-section tool: click two points on the plan-view map → hatched SVG
 */

import {
  useEffect, useRef, useState, useCallback, type CSSProperties,
} from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile } from '../core.js';
import { buildGeo3DModel, geolColor } from '@geoflow/core';
import type { Geo3DModel, GeoUnit, Borehole3D } from '@geoflow/core';

// ── Constants ─────────────────────────────────────────────────────────────────

const GRID_N = 36;          // grid resolution per surface (36×36 = 1296 verts)
const SECTION_SAMPLES = 80; // sample count along cross-section line

// ── SVG hatch pattern definitions ────────────────────────────────────────────

const HATCH_DEFS = `
<defs>
  <pattern id="h-clay" patternUnits="userSpaceOnUse" width="12" height="5">
    <line x1="0" y1="2.5" x2="12" y2="2.5" stroke="#7B9EC5" stroke-width="1"/>
  </pattern>
  <pattern id="h-silt" patternUnits="userSpaceOnUse" width="10" height="4">
    <line x1="0" y1="2" x2="10" y2="2" stroke="#C4A87C" stroke-width="0.7"/>
    <circle cx="5" cy="3.4" r="0.6" fill="#C4A87C"/>
  </pattern>
  <pattern id="h-sand" patternUnits="userSpaceOnUse" width="8" height="8">
    <circle cx="2" cy="2" r="0.9" fill="#c8a600"/>
    <circle cx="6" cy="6" r="0.9" fill="#c8a600"/>
  </pattern>
  <pattern id="h-gravel" patternUnits="userSpaceOnUse" width="12" height="10">
    <ellipse cx="3" cy="3" rx="2.2" ry="1.4" fill="none" stroke="#C87A45" stroke-width="0.9"/>
    <ellipse cx="9" cy="7" rx="2.2" ry="1.4" fill="none" stroke="#C87A45" stroke-width="0.9"/>
  </pattern>
  <pattern id="h-chalk" patternUnits="userSpaceOnUse" width="10" height="10">
    <line x1="0" y1="10" x2="10" y2="0" stroke="#d0c88a" stroke-width="0.8"/>
    <line x1="-2" y1="4"  x2="4"  y2="-2" stroke="#d0c88a" stroke-width="0.8"/>
    <line x1="6"  y1="12" x2="12" y2="6"  stroke="#d0c88a" stroke-width="0.8"/>
  </pattern>
  <pattern id="h-rock" patternUnits="userSpaceOnUse" width="14" height="8">
    <line x1="0" y1="0" x2="14" y2="0" stroke="#8888a0" stroke-width="0.8"/>
    <line x1="0" y1="8" x2="14" y2="8" stroke="#8888a0" stroke-width="0.8"/>
    <line x1="0" y1="0" x2="0"  y2="8" stroke="#8888a0" stroke-width="0.8"/>
    <line x1="7" y1="0" x2="7"  y2="8" stroke="#8888a0" stroke-width="0.8"/>
  </pattern>
  <pattern id="h-sandstone" patternUnits="userSpaceOnUse" width="10" height="10">
    <line x1="0" y1="10" x2="10" y2="0" stroke="#D4B483" stroke-width="0.8"/>
    <circle cx="5" cy="5" r="0.7" fill="#D4B483"/>
  </pattern>
  <pattern id="h-mudstone" patternUnits="userSpaceOnUse" width="10" height="8">
    <line x1="0" y1="4" x2="10" y2="4" stroke="#7A7A90" stroke-width="0.8"/>
    <line x1="0" y1="0" x2="10" y2="8" stroke="#7A7A90" stroke-width="0.5" stroke-dasharray="2,3"/>
  </pattern>
  <pattern id="h-limestone" patternUnits="userSpaceOnUse" width="12" height="8">
    <line x1="0" y1="0" x2="12" y2="0" stroke="#C8CEB8" stroke-width="0.7"/>
    <line x1="0" y1="4" x2="12" y2="4" stroke="#C8CEB8" stroke-width="0.7"/>
    <line x1="6" y1="0" x2="6"  y2="4" stroke="#C8CEB8" stroke-width="0.7"/>
  </pattern>
  <pattern id="h-fill" patternUnits="userSpaceOnUse" width="10" height="10">
    <line x1="0" y1="0" x2="10" y2="10" stroke="#A0785A" stroke-width="0.8"/>
    <line x1="0" y1="5" x2="5"  y2="0"  stroke="#A0785A" stroke-width="0.5"/>
    <line x1="5" y1="10" x2="10" y2="5"  stroke="#A0785A" stroke-width="0.5"/>
  </pattern>
  <pattern id="h-topsoil" patternUnits="userSpaceOnUse" width="8" height="8">
    <line x1="0" y1="4" x2="8" y2="4" stroke="#5C7A3E" stroke-width="0.8"/>
    <circle cx="2" cy="2" r="0.7" fill="#5C7A3E"/>
    <circle cx="6" cy="6" r="0.7" fill="#5C7A3E"/>
  </pattern>
  <pattern id="h-peat" patternUnits="userSpaceOnUse" width="8" height="8">
    <circle cx="2" cy="2" r="1" fill="#3D2B1F"/>
    <circle cx="6" cy="6" r="1" fill="#3D2B1F"/>
    <circle cx="4" cy="4" r="0.5" fill="#3D2B1F"/>
  </pattern>
  <pattern id="h-none" patternUnits="userSpaceOnUse" width="8" height="8">
    <line x1="0" y1="8" x2="8" y2="0" stroke="#999" stroke-width="0.5"/>
  </pattern>
</defs>`;

function hatchUrl(hatch: string): string {
  const known = ['clay','silt','sand','gravel','chalk','rock','sandstone','mudstone','limestone','fill','topsoil','peat'];
  return `url(#h-${known.includes(hatch) ? hatch : 'none'})`;
}

// ── Colour helpers ────────────────────────────────────────────────────────────

function hexToThree(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

function darken(hex: string, factor = 0.75): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(factor);
  return '#' + c.getHexString();
}

// ── Three.js geometry builders ────────────────────────────────────────────────

function buildSurfaceMesh(
  model: Geo3DModel,
  unit: GeoUnit,
  side: 'top' | 'base',
  opacity: number,
): THREE.Mesh | null {
  const surface = side === 'top' ? unit.topSurface : unit.baseSurface;
  if (!surface) return null;

  const { xMin, xMax, yMin, yMax } = model.bounds;
  const nx = GRID_N; const ny = GRID_N;

  const zGrid = surface.evaluateGrid(xMin, xMax, yMin, yMax, nx, ny);

  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(nx * ny * 3);
  const normals   = new Float32Array(nx * ny * 3);
  const indices: number[] = [];

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const idx = iy * nx + ix;
      const x = xMin + (ix / (nx - 1)) * (xMax - xMin);
      const y = yMin + (iy / (ny - 1)) * (yMax - yMin);
      const z = zGrid[idx] ?? 0;
      positions[idx * 3]     = x;
      positions[idx * 3 + 1] = z;   // Three.js Y = elevation
      positions[idx * 3 + 2] = -y;  // Three.js Z = -northing (right-hand)
    }
  }

  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iy * nx + ix;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshPhongMaterial({
    color: hexToThree(side === 'top' ? unit.color : darken(unit.color, 0.6)),
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    shininess: 20,
  });

  return new THREE.Mesh(geo, mat);
}

function buildBoreholeMeshes(
  bh: Borehole3D,
  model: Geo3DModel,
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(bh.x, 0, -bh.y);

  // Stick — thin black line from ground to final depth
  const stickGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, bh.elev,               0),
    new THREE.Vector3(0, bh.elev - bh.finDepth, 0),
  ]);
  group.add(new THREE.Line(stickGeo, new THREE.LineBasicMaterial({ color: 0x111111 })));

  // Geological layer cylinders
  for (const layer of bh.layers) {
    const h = Math.max(0.01, layer.baseDepth - layer.topDepth);
    const geo = new THREE.CylinderGeometry(1.5, 1.5, h, 8);
    const mat = new THREE.MeshPhongMaterial({ color: hexToThree(layer.color), shininess: 30 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, bh.elev - layer.topDepth - h / 2, 0);
    group.add(mesh);
  }

  // Label sprite
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 20px system-ui,sans-serif';
  ctx.fillText(bh.id, 8, 44);
  const tex = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.position.set(4, bh.elev + 4, 0);
  sprite.scale.set(20, 5, 1);
  group.add(sprite);

  void model; // suppress unused lint
  return group;
}

// ── Cross-section SVG builder ─────────────────────────────────────────────────

interface SectionPt { x: number; y: number; } // local coords

function buildCrossSectionSvg(
  model: Geo3DModel,
  p0: SectionPt,
  p1: SectionPt,
): string {
  const { zMin, zMax } = model.bounds;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const totalDist = Math.sqrt(dx * dx + dy * dy);
  if (totalDist < 0.01) return '<svg/>';

  const SVG_W = 900;
  const SVG_H = 460;
  const PAD_L = 70; const PAD_R = 20;
  const PAD_T = 30; const PAD_B = 50;
  const plotW = SVG_W - PAD_L - PAD_R;
  const plotH = SVG_H - PAD_T - PAD_B;

  const xScale = (d: number) => PAD_L + (d / totalDist) * plotW;
  const elevRange = Math.max(zMax - zMin, 1);
  const yScale = (z: number) => PAD_T + (1 - (z - zMin) / elevRange) * plotH;

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" font-family="system-ui,sans-serif">`);
  lines.push(HATCH_DEFS);

  // Background
  lines.push(`<rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${plotH}" fill="#f8fafc" stroke="#94a3b8" stroke-width="1"/>`);

  // Grid lines (elevation)
  const elevStep = niceStep(elevRange / 6);
  const elevStart = Math.ceil(zMin / elevStep) * elevStep;
  for (let z = elevStart; z <= zMax + 0.001; z += elevStep) {
    const sy = yScale(z);
    lines.push(`<line x1="${PAD_L}" y1="${sy.toFixed(1)}" x2="${PAD_L + plotW}" y2="${sy.toFixed(1)}" stroke="#e2e8f0" stroke-width="0.8"/>`);
    lines.push(`<text x="${PAD_L - 6}" y="${(sy + 4).toFixed(1)}" font-size="10" fill="#64748b" text-anchor="end">${z.toFixed(0)}</text>`);
  }

  // Distance tick marks
  const distStep = niceStep(totalDist / 6);
  const distStart = 0;
  for (let d = distStart; d <= totalDist + 0.001; d += distStep) {
    const sx = xScale(d);
    lines.push(`<line x1="${sx.toFixed(1)}" y1="${PAD_T + plotH}" x2="${sx.toFixed(1)}" y2="${PAD_T + plotH + 6}" stroke="#64748b" stroke-width="1"/>`);
    lines.push(`<text x="${sx.toFixed(1)}" y="${PAD_T + plotH + 20}" font-size="10" fill="#64748b" text-anchor="middle">${d.toFixed(0)}</text>`);
  }
  lines.push(`<text x="${PAD_L + plotW / 2}" y="${SVG_H - 8}" font-size="11" fill="#475569" text-anchor="middle">Distance along section (m)</text>`);
  lines.push(`<text x="14" y="${PAD_T + plotH / 2}" font-size="11" fill="#475569" text-anchor="middle" transform="rotate(-90 14 ${PAD_T + plotH / 2})">Elevation (m OD)</text>`);

  // ── Draw surfaces per unit ──────────────────────────────────────────────────
  for (const unit of model.units) {
    const topSurf  = unit.topSurface;
    const baseSurf = unit.baseSurface;
    if (!topSurf && !baseSurf) continue;

    const topSamples  = topSurf  ? topSurf.sampleLine(p0.x, p0.y, p1.x, p1.y, SECTION_SAMPLES) : null;
    const baseSamples = baseSurf ? baseSurf.sampleLine(p0.x, p0.y, p1.x, p1.y, SECTION_SAMPLES) : null;

    if (!topSamples || !baseSamples) continue;

    // Build a closed polygon: top curve forward, base curve reversed
    const pts: string[] = [];
    for (const s of topSamples) {
      pts.push(`${xScale(s.dist).toFixed(1)},${yScale(s.z).toFixed(1)}`);
    }
    for (let i = baseSamples.length - 1; i >= 0; i--) {
      const s = baseSamples[i];
      if (!s) continue;
      pts.push(`${xScale(s.dist).toFixed(1)},${yScale(s.z).toFixed(1)}`);
    }

    const poly = pts.join(' ');
    // Filled background colour
    lines.push(`<polygon points="${poly}" fill="${unit.color}" fill-opacity="0.55" stroke="none"/>`);
    // Hatching overlay
    lines.push(`<polygon points="${poly}" fill="${hatchUrl(unit.hatch)}" fill-opacity="0.9" stroke="none"/>`);
    // Boundary
    const topPts = topSamples.map(s => `${xScale(s.dist).toFixed(1)},${yScale(s.z).toFixed(1)}`).join(' ');
    const basePts = baseSamples.map(s => `${xScale(s.dist).toFixed(1)},${yScale(s.z).toFixed(1)}`).join(' ');
    lines.push(`<polyline points="${topPts}" fill="none" stroke="${darken(unit.color, 0.7)}" stroke-width="1.2"/>`);
    lines.push(`<polyline points="${basePts}" fill="none" stroke="${darken(unit.color, 0.5)}" stroke-width="1" stroke-dasharray="4,2"/>`);
  }

  // ── Boreholes that are near the section ──────────────────────────────────

  for (const bh of model.boreholes) {
    // Project borehole onto section line
    const t = ((bh.x - p0.x) * dx + (bh.y - p0.y) * dy) / (totalDist * totalDist);
    if (t < 0 || t > 1) continue;
    const projDist = t * totalDist;

    // Perpendicular distance
    const perpX = p0.x + t * dx - bh.x;
    const perpY = p0.y + t * dy - bh.y;
    const perpDist = Math.sqrt(perpX * perpX + perpY * perpY);
    if (perpDist > totalDist * 0.15 + 5) continue; // within 15% of section length

    const sx = xScale(projDist);

    // Draw each geological layer as a coloured rectangle
    for (const layer of bh.layers) {
      const y1 = yScale(layer.topElev);
      const y2 = yScale(layer.baseElev);
      const h = Math.abs(y2 - y1);
      lines.push(`<rect x="${(sx - 5).toFixed(1)}" y="${Math.min(y1, y2).toFixed(1)}" width="10" height="${h.toFixed(1)}" fill="${layer.color}" stroke="#333" stroke-width="0.4"/>`);
    }

    // Borehole stick outline
    const top = yScale(bh.elev);
    const bot = yScale(bh.elev - bh.finDepth);
    lines.push(`<line x1="${sx.toFixed(1)}" y1="${top.toFixed(1)}" x2="${sx.toFixed(1)}" y2="${bot.toFixed(1)}" stroke="#111" stroke-width="2"/>`);

    // Label
    lines.push(`<text x="${sx.toFixed(1)}" y="${(top - 6).toFixed(1)}" font-size="9" fill="#0f2644" text-anchor="middle" font-weight="600">${bh.id}</text>`);
  }

  // Section line endpoints A / B
  lines.push(`<text x="${PAD_L}" y="${PAD_T - 8}" font-size="11" fill="#1a4080" font-weight="700">A</text>`);
  lines.push(`<text x="${PAD_L + plotW}" y="${PAD_T - 8}" font-size="11" fill="#1a4080" font-weight="700" text-anchor="end">B</text>`);

  // Clip plot area
  lines.push(`<rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${plotH}" fill="none" stroke="#64748b" stroke-width="1.5"/>`);

  lines.push('</svg>');
  return lines.join('\n');
}

function niceStep(rough: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  if (norm < 1.5) return pow;
  if (norm < 3.5) return 2 * pow;
  if (norm < 7.5) return 5 * pow;
  return 10 * pow;
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
}

type SectionMode = 'idle' | 'picking-a' | 'picking-b' | 'done';

interface PlanPoint { x: number; y: number; }

export function ThreeDTab({ fileBytes, fileName }: Props) {
  const mountRef   = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef    = useRef<THREE.Scene | null>(null);
  const cameraRef   = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const frameRef    = useRef<number>(0);
  const surfGrpRef  = useRef<THREE.Group | null>(null);

  const [model, setModel] = useState<Geo3DModel | null>(null);
  const [opacity, setOpacity] = useState(0.55);
  const [hiddenUnits, setHiddenUnits] = useState<Set<string>>(new Set());
  const [vExag, setVExag] = useState(1.0);

  // Cross-section state
  const [sectionMode, setSectionMode] = useState<SectionMode>('idle');
  const [ptA, setPtA] = useState<PlanPoint | null>(null);
  const [ptB, setPtB] = useState<PlanPoint | null>(null);
  const [sectionSvg, setSectionSvg] = useState<string | null>(null);

  // ── Parse file ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!fileBytes) { setModel(null); return; }
    try {
      const text: string = decodeBytes(fileBytes);
      const file: AgsFile = parseStr(text).file;
      const m = buildGeo3DModel(file);
      setModel(m);
      setHiddenUnits(new Set());
      setSectionMode('idle');
      setPtA(null); setPtB(null); setSectionSvg(null);
    } catch {
      setModel(null);
    }
  }, [fileBytes]);

  // ── Three.js setup ──────────────────────────────────────────────────────────

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const w = el.clientWidth;
    const h = el.clientHeight || 520;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f4f8);
    sceneRef.current = scene;

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(100, 200, 80);
    scene.add(dir);

    // Camera
    const cam = new THREE.PerspectiveCamera(45, w / h, 0.1, 50000);
    cam.position.set(0, 200, 400);
    cameraRef.current = cam;

    // Controls
    const controls = new OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controlsRef.current = controls;

    // Grid helper
    const grid = new THREE.GridHelper(1000, 20, 0xaabbcc, 0xdde4ee);
    scene.add(grid);

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, cam);
    };
    animate();

    const onResize = () => {
      const nw = el.clientWidth; const nh = el.clientHeight || 520;
      cam.aspect = nw / nh;
      cam.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  // ── Rebuild scene when model / visual parameters change ─────────────────────

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !model) return;

    // Clear previous model objects (keep lights/grid)
    const toRemove: THREE.Object3D[] = [];
    scene.traverse(o => {
      if (o.userData['isModel']) toRemove.push(o);
    });
    toRemove.forEach(o => scene.remove(o));
    surfGrpRef.current = null;

    const { bounds } = model;

    // Ground plane
    const groundW = (bounds.xMax - bounds.xMin) + 60;
    const groundD = (bounds.yMax - bounds.yMin) + 60;
    const groundGeo = new THREE.PlaneGeometry(groundW, groundD);
    const groundMat = new THREE.MeshPhongMaterial({ color: 0xd0d8e0, transparent: true, opacity: 0.45 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(
      (bounds.xMin + bounds.xMax) / 2,
      bounds.zMin - 1,
      -(bounds.yMin + bounds.yMax) / 2,
    );
    ground.userData['isModel'] = true;
    scene.add(ground);

    // Boreholes
    for (const bh of model.boreholes) {
      const g = buildBoreholeMeshes(bh, model);
      g.userData['isModel'] = true;
      g.scale.y = vExag;
      scene.add(g);
    }

    // Surfaces group
    const surfGrp = new THREE.Group();
    surfGrp.userData['isModel'] = true;
    surfGrp.scale.y = vExag;
    surfGrpRef.current = surfGrp;

    for (const unit of model.units) {
      if (hiddenUnits.has(unit.key)) continue;
      const topMesh  = buildSurfaceMesh(model, unit, 'top', opacity);
      const baseMesh = buildSurfaceMesh(model, unit, 'base', opacity * 0.7);
      if (topMesh)  surfGrp.add(topMesh);
      if (baseMesh) surfGrp.add(baseMesh);
    }
    scene.add(surfGrp);

    // Fit camera
    const cx = (bounds.xMin + bounds.xMax) / 2;
    const cy = (bounds.yMin + bounds.yMax) / 2;
    const cz = (bounds.zMin + bounds.zMax) / 2;
    const r = Math.max(bounds.xMax - bounds.xMin, bounds.yMax - bounds.yMin, bounds.zMax - bounds.zMin) * 0.8;
    cameraRef.current?.position.set(cx + r, cz * vExag + r * 0.8, -cy + r);
    controlsRef.current?.target.set(cx, cz * vExag, -cy);
    controlsRef.current?.update();
  }, [model, opacity, hiddenUnits, vExag]);

  // ── Re-generate cross-section when both points are set ──────────────────────

  useEffect(() => {
    if (model && ptA && ptB) {
      setSectionSvg(buildCrossSectionSvg(model, ptA, ptB));
    }
  }, [model, ptA, ptB]);

  // ── Plan-view canvas for cross-section picking ─────────────────────────────

  const planRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = planRef.current;
    if (!canvas || !model) return;
    const ctx = canvas.getContext('2d')!;
    const { bounds } = model;
    const W = canvas.width; const H = canvas.height;
    const padX = 20; const padY = 20;

    const sx = (x: number) => padX + ((x - bounds.xMin) / (bounds.xMax - bounds.xMin + 0.01)) * (W - padX * 2);
    const sy = (y: number) => padY + (1 - (y - bounds.yMin) / (bounds.yMax - bounds.yMin + 0.01)) * (H - padY * 2);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f0f4f8';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#94a3b8';
    ctx.strokeRect(padX, padY, W - padX * 2, H - padY * 2);

    // Boreholes as dots
    for (const bh of model.boreholes) {
      ctx.beginPath();
      ctx.arc(sx(bh.x), sy(bh.y), 5, 0, Math.PI * 2);
      ctx.fillStyle = '#1a4080';
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.font = '9px system-ui';
      ctx.fillText(bh.id, sx(bh.x) + 7, sy(bh.y) + 3);
    }

    // Section line
    if (ptA) {
      ctx.beginPath();
      ctx.arc(sx(ptA.x), sy(ptA.y), 6, 0, Math.PI * 2);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.fillStyle = '#dc2626';
      ctx.font = 'bold 11px system-ui';
      ctx.fillText('A', sx(ptA.x) + 8, sy(ptA.y) - 6);
    }
    if (ptA && ptB) {
      ctx.beginPath();
      ctx.moveTo(sx(ptA.x), sy(ptA.y));
      ctx.lineTo(sx(ptB.x), sy(ptB.y));
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(sx(ptB.x), sy(ptB.y), 6, 0, Math.PI * 2);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.fillStyle = '#dc2626';
      ctx.fillText('B', sx(ptB.x) + 8, sy(ptB.y) - 6);
    }
  }, [model, ptA, ptB]);

  const handlePlanClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!model || sectionMode === 'idle' || sectionMode === 'done') return;
    const canvas = planRef.current!;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const W = canvas.width; const H = canvas.height;
    const padX = 20; const padY = 20;
    const { bounds } = model;

    const lx = bounds.xMin + ((px - padX) / (W - padX * 2)) * (bounds.xMax - bounds.xMin + 0.01);
    const ly = bounds.yMin + (1 - (py - padY) / (H - padY * 2)) * (bounds.yMax - bounds.yMin + 0.01);

    if (sectionMode === 'picking-a') {
      setPtA({ x: lx, y: ly });
      setPtB(null);
      setSectionMode('picking-b');
    } else if (sectionMode === 'picking-b') {
      setPtB({ x: lx, y: ly });
      setSectionMode('done');
    }
  }, [model, sectionMode]);

  const toggleUnit = (key: string) => {
    setHiddenUnits(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  const noFile = !fileBytes;
  const noModel = fileBytes && !model;

  const panelStyle: CSSProperties = {
    background: '#fff',
    border: '1px solid #cbd5e1',
    borderRadius: 8,
    padding: '14px 18px',
  };

  const labelStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.4px',
    color: '#64748b',
    marginBottom: 6,
    display: 'block',
  };

  const btnStyle = (active: boolean): CSSProperties => ({
    padding: '7px 14px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 6,
    border: 'none',
    background: active ? '#1a4080' : '#e2e8f0',
    color: active ? '#fff' : '#475569',
    cursor: 'pointer',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {noFile && (
        <div style={{ ...panelStyle, textAlign: 'center', padding: '48px 24px', color: '#64748b' }}>
          Load an AGS file to enable 3-D view
        </div>
      )}

      {noModel && (
        <div style={{ ...panelStyle, textAlign: 'center', padding: '48px 24px', color: '#dc2626' }}>
          Could not build 3-D model — ensure the file contains LOCA with coordinate data
        </div>
      )}

      {model && (
        <>
          {/* ── Controls bar ── */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>

            {/* Surface opacity */}
            <div style={panelStyle}>
              <label style={labelStyle}>Surface opacity</label>
              <input type="range" min={0} max={1} step={0.05} value={opacity}
                style={{ width: 140 }}
                onChange={e => setOpacity(parseFloat(e.target.value))} />
              <span style={{ marginLeft: 8, fontSize: 12, color: '#64748b' }}>{Math.round(opacity * 100)}%</span>
            </div>

            {/* Vertical exaggeration */}
            <div style={panelStyle}>
              <label style={labelStyle}>Vertical exaggeration</label>
              <input type="range" min={0.5} max={10} step={0.5} value={vExag}
                style={{ width: 140 }}
                onChange={e => setVExag(parseFloat(e.target.value))} />
              <span style={{ marginLeft: 8, fontSize: 12, color: '#64748b' }}>{vExag.toFixed(1)}×</span>
            </div>

            {/* Unit visibility */}
            <div style={{ ...panelStyle, flex: 1, minWidth: 220 }}>
              <label style={labelStyle}>Geological units</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {model.units.map(u => (
                  <button key={u.key} onClick={() => toggleUnit(u.key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      padding: '4px 10px', fontSize: 11, fontWeight: 600,
                      border: '1.5px solid #cbd5e1', borderRadius: 20,
                      background: hiddenUnits.has(u.key) ? '#f1f5f9' : u.color,
                      color: hiddenUnits.has(u.key) ? '#94a3b8' : '#000',
                      cursor: 'pointer',
                      opacity: hiddenUnits.has(u.key) ? 0.5 : 1,
                    }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: u.color, border: '1px solid rgba(0,0,0,0.2)', display: 'inline-block' }}/>
                    {u.key}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── 3D viewport ── */}
          <div ref={mountRef} style={{
            width: '100%', height: 540,
            borderRadius: 8, overflow: 'hidden',
            border: '1px solid #cbd5e1',
            background: '#f0f4f8',
          }} />

          {/* ── Cross-section panel ── */}
          <div style={panelStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#0f2644' }}>Cross Section</span>
              {sectionMode === 'idle' && (
                <button style={btnStyle(false)} onClick={() => { setSectionMode('picking-a'); setPtA(null); setPtB(null); setSectionSvg(null); }}>
                  Draw section A→B
                </button>
              )}
              {(sectionMode === 'picking-a' || sectionMode === 'picking-b') && (
                <span style={{ fontSize: 12, color: '#1a4080', fontWeight: 600 }}>
                  {sectionMode === 'picking-a' ? 'Click plan to place point A' : 'Click plan to place point B'}
                </span>
              )}
              {sectionMode === 'done' && (
                <>
                  <button style={btnStyle(false)} onClick={() => { setSectionMode('picking-a'); setPtA(null); setPtB(null); setSectionSvg(null); }}>
                    New section
                  </button>
                  <button style={btnStyle(false)} onClick={() => {
                    if (!sectionSvg) return;
                    const blob = new Blob([sectionSvg], { type: 'image/svg+xml' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `${(fileName ?? 'section').replace(/\.ags$/i, '')}-cross-section.svg`; a.click();
                    URL.revokeObjectURL(url);
                  }}>
                    Export SVG
                  </button>
                </>
              )}
              {sectionMode !== 'idle' && (
                <button style={btnStyle(false)} onClick={() => { setSectionMode('idle'); setPtA(null); setPtB(null); setSectionSvg(null); }}>
                  Cancel
                </button>
              )}
            </div>

            {/* Plan view for picking */}
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4, fontWeight: 600 }}>
                  Plan view {sectionMode !== 'idle' ? '— click to set section endpoints' : ''}
                </div>
                <canvas
                  ref={planRef}
                  width={260} height={200}
                  onClick={handlePlanClick}
                  style={{
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                    cursor: sectionMode !== 'idle' && sectionMode !== 'done' ? 'crosshair' : 'default',
                    display: 'block',
                  }}
                />
              </div>

              {/* Legend */}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4, fontWeight: 600 }}>Legend</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
                  {model.units.map(u => (
                    <div key={u.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                      <span style={{ width: 14, height: 14, borderRadius: 2, background: u.color, border: '1px solid rgba(0,0,0,0.15)', display: 'inline-block', flexShrink: 0 }}/>
                      {u.key}
                      {u.topSurface ? '' : <span style={{ color: '#94a3b8', fontSize: 9 }}> (no surface)</span>}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Cross-section SVG */}
            {sectionSvg && (
              <div style={{ marginTop: 16, overflowX: 'auto' }}>
                <div dangerouslySetInnerHTML={{ __html: sectionSvg }} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
