/**
 * VoxelTab — Minecraft-style geostatistical voxel grid viewer.
 *
 * Layout:
 *   LEFT (300 px)  — property, interpolation, resolution, topo, build, stats, export
 *   CENTER (flex)  — Three.js InstancedMesh voxel renderer + tool overlay
 *   RIGHT (280 px) — cell lineage panel OR virtual borehole log (shown on demand)
 *
 * Features:
 *   • Minecraft-style solid block rendering with face shading
 *   • Topo surface: collar TPS → SRTM → IDW priority chain
 *   • Geological unit inference per cell (colour-by-geology mode)
 *   • Axis-aligned cross-section plane (X / Y / Z, drag slider)
 *   • Virtual borehole: click the model to drill a synthetic log
 *   • Cell lineage: click a voxel to see how its value was computed
 *   • Export: CSV, OBJ (outer faces only), GLB (Three.js scene)
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import {
  decodeBytes, parseStr, buildGeo3DModel,
  discoverVoxelProperties, buildVoxelGrid, voxelGridToCsv,
  getVoxelCellLineage,
  parseAscGrid, parseXyzPoints, sampleTopoAt,
  ThinPlateSurface, geolColor,
} from '../core.js';
import type {
  AgsFile, VoxelProperty, VoxelGrid, VoxelCell,
  VoxelCellLineage, Borehole3D, TopoGrid, GeoUnit,
} from '../core.js';
import { fetchTopoGrid } from '../topo-api.js';
import type { FetchTopoProgress } from '../topo-api.js';
import { LineageModal } from './LineageModal.js';

// ── Colour helpers ─────────────────────────────────────────────────────────────

const VIRIDIS: [number, number, number][] = [
  [0.267, 0.005, 0.329],
  [0.231, 0.322, 0.545],
  [0.129, 0.569, 0.549],
  [0.369, 0.788, 0.384],
  [0.993, 0.906, 0.144],
];

function viridisColor(t: number, out: THREE.Color): void {
  const clamped = Math.max(0, Math.min(1, t));
  const pos = clamped * (VIRIDIS.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, VIRIDIS.length - 1);
  const f = pos - lo;
  const a = VIRIDIS[lo]!;
  const b = VIRIDIS[hi]!;
  out.setRGB(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

const VIRIDIS_CSS = VIRIDIS.map((s, i) =>
  `rgb(${Math.round(s[0]*255)},${Math.round(s[1]*255)},${Math.round(s[2]*255)}) ${i*25}%`
).join(', ');

const CAT_PALETTE = [
  '#2563eb','#dc2626','#16a34a','#d97706','#7c3aed',
  '#0891b2','#be185d','#65a30d','#ea580c','#4f46e5',
  '#0d9488','#b45309','#9333ea','#0284c7','#c2410c',
  '#1d4ed8','#b91c1c','#15803d','#b45309','#6d28d9',
];

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [isNaN(r) ? 0.5 : r, isNaN(g) ? 0.5 : g, isNaN(b) ? 0.5 : b];
}

// ── Lambda presets ─────────────────────────────────────────────────────────────

const LAMBDA_PRESETS: { label: string; value: number }[] = [
  { label: 'None (exact)',  value: 0      },
  { label: 'Very slight',   value: 1      },
  { label: 'Slight',        value: 10     },
  { label: 'Moderate',      value: 100    },
  { label: 'Heavy',         value: 1000   },
  { label: 'Very heavy',    value: 10000  },
];

// ── Style constants ────────────────────────────────────────────────────────────

const PANEL: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '12px 14px',
  marginBottom: 10,
};

const SLABEL: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.4px', color: 'var(--muted)', display: 'block', marginBottom: 6,
};

const ROW: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  fontSize: 12, borderBottom: '1px solid var(--border)', padding: '3px 0',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function topoElevAt(x: number, y: number, boreholes: Borehole3D[]): number {
  let wSum = 0, zSum = 0;
  for (const bh of boreholes) {
    const d2 = (bh.x - x) ** 2 + (bh.y - y) ** 2;
    if (d2 < 1e-6) return bh.elev;
    const w = 1 / Math.sqrt(d2);
    wSum += w; zSum += w * bh.elev;
  }
  return wSum > 0 ? zSum / wSum : 0;
}

function disposeGroup(group: THREE.Group): void {
  group.traverse(obj => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      obj.geometry.dispose();
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else (obj.material as THREE.Material).dispose();
    }
  });
}

// ── OBJ export ─────────────────────────────────────────────────────────────────

/** Export voxel grid as OBJ with only outer (non-occluded) faces. */
function voxelGridToObj(grid: VoxelGrid): string {
  const { cells, nx, ny, nz, cellSize, bounds, centroid } = grid;
  const { dx, dy, dz } = cellSize;

  const occ = new Uint8Array(nx * ny * nz);
  for (const c of cells) occ[c.iz * nx * ny + c.iy * nx + c.ix] = 1;
  const isOcc = (ix: number, iy: number, iz: number) =>
    ix >= 0 && iy >= 0 && iz >= 0 && ix < nx && iy < ny && iz < nz &&
    occ[iz * nx * ny + iy * nx + ix] === 1;

  const vtxLines: string[] = ['# GeoFlow voxel model export'];
  const faceLines: string[] = [];
  let vi = 1;

  // Face definitions: [normalX, normalY, normalZ, offsets for 4 verts relative to cell min corner]
  // Each face: 4 vertices as [dx, dy, dz] offsets
  const FACES: Array<{
    n: [number, number, number];
    check: [number, number, number];
    verts: [number, number, number][];
  }> = [
    { n: [1,0,0],  check:[1,0,0],  verts:[[1,0,0],[1,1,0],[1,1,1],[1,0,1]] },
    { n: [-1,0,0], check:[-1,0,0], verts:[[0,1,0],[0,0,0],[0,0,1],[0,1,1]] },
    { n: [0,1,0],  check:[0,1,0],  verts:[[1,1,0],[0,1,0],[0,1,1],[1,1,1]] },
    { n: [0,-1,0], check:[0,-1,0], verts:[[0,0,0],[1,0,0],[1,0,1],[0,0,1]] },
    { n: [0,0,1],  check:[0,0,1],  verts:[[0,0,1],[1,0,1],[1,1,1],[0,1,1]] },
    { n: [0,0,-1], check:[0,0,-1], verts:[[0,1,0],[1,1,0],[1,0,0],[0,0,0]] },
  ];

  for (const c of cells) {
    // Absolute coords of cell min corner
    const ox = bounds.xMin + c.ix * dx + centroid.x;
    const oy = bounds.yMin + c.iy * dy + centroid.y;
    const oz = c.cz - dz * 0.5;

    for (const face of FACES) {
      const [fcx, fcy, fcz] = face.check;
      if (isOcc(c.ix + fcx, c.iy + fcy, c.iz + fcz)) continue;

      for (const [vdx, vdy, vdz] of face.verts) {
        vtxLines.push(`v ${(ox + vdx * dx).toFixed(3)} ${(oy + vdy * dy).toFixed(3)} ${(oz + vdz * dz).toFixed(3)}`);
      }
      faceLines.push(`f ${vi} ${vi+1} ${vi+2} ${vi+3}`);
      vi += 4;
    }
  }

  return [...vtxLines, ...faceLines].join('\n');
}

// ── Virtual borehole SVG ───────────────────────────────────────────────────────

interface VirtualBhEntry {
  cz: number; topElev: number; baseElev: number;
  value: number | null; category: string | null;
  geolUnit: string | null; confidence: number;
}

interface VirtualBh {
  cx: number; cy: number; lx: number; ly: number;
  topElev: number; botElev: number;
  entries: VirtualBhEntry[];
}

function buildVirtualBhSvg(vbh: VirtualBh, grid: VoxelGrid): string {
  if (vbh.entries.length === 0) return '';
  const PX_PER_M = 12;
  const span = vbh.topElev - vbh.botElev || 1;
  const H = Math.round(span * PX_PER_M) + 60;
  const W = 260;
  const Y0 = 48;
  const isNum = grid.property.type === 'numeric';
  const [numMin, numMax] = grid.numericRange;
  const numRange = numMax - numMin || 1;

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif">`);
  lines.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#f8fafc"/>`);
  lines.push(`<rect x="0" y="0" width="${W}" height="32" fill="#1e3a5f"/>`);
  lines.push(`<text x="12" y="21" font-size="11" font-weight="700" fill="#fff">Virtual Borehole</text>`);
  lines.push(`<text x="${W-8}" y="21" font-size="9" fill="#94a3b8" text-anchor="end">lx:${vbh.lx.toFixed(0)} ly:${vbh.ly.toFixed(0)}</text>`);

  // Column headers
  lines.push(`<text x="26" y="44" font-size="8" fill="#64748b" text-anchor="middle">m OD</text>`);
  lines.push(`<text x="88" y="44" font-size="8" fill="#64748b" text-anchor="middle">Geology</text>`);
  lines.push(`<text x="180" y="44" font-size="8" fill="#64748b" text-anchor="middle">${isNum ? grid.property.id : 'Category'}</text>`);

  // Elevation ticks
  const tickInterval = span > 50 ? 10 : span > 20 ? 5 : 2;
  const firstTick = Math.floor(vbh.botElev / tickInterval) * tickInterval;
  for (let elev = firstTick; elev <= vbh.topElev; elev += tickInterval) {
    const y = Y0 + (vbh.topElev - elev) * PX_PER_M;
    lines.push(`<line x1="10" y1="${y.toFixed(1)}" x2="44" y2="${y.toFixed(1)}" stroke="#94a3b8" stroke-width="0.5"/>`);
    lines.push(`<text x="26" y="${(y + 3).toFixed(1)}" font-size="7" fill="#64748b" text-anchor="middle">${elev}</text>`);
  }

  for (const e of vbh.entries) {
    const y1 = Y0 + (vbh.topElev - e.topElev) * PX_PER_M;
    const y2 = Y0 + (vbh.topElev - e.baseElev) * PX_PER_M;
    const cellH = Math.max(2, y2 - y1);

    // Geology column
    const geoFill = e.geolUnit ? geolColor(e.geolUnit) : '#d1d5db';
    lines.push(`<rect x="50" y="${y1.toFixed(1)}" width="70" height="${cellH.toFixed(1)}" fill="${geoFill}" stroke="#94a3b8" stroke-width="0.3"/>`);

    // Value bar or category
    if (isNum && e.value !== null) {
      const t = (e.value - numMin) / numRange;
      const barW = Math.max(2, t * 80);
      const r = Math.round(VIRIDIS[Math.min(4, Math.floor(t * 4))]![0] * 255);
      const g2 = Math.round(VIRIDIS[Math.min(4, Math.floor(t * 4))]![1] * 255);
      const bv = Math.round(VIRIDIS[Math.min(4, Math.floor(t * 4))]![2] * 255);
      lines.push(`<rect x="130" y="${(y1 + 0.5).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, cellH - 1).toFixed(1)}" fill="rgb(${r},${g2},${bv})"/>`);
      if (cellH > 10) {
        lines.push(`<text x="215" y="${(y1 + cellH/2 + 3).toFixed(1)}" font-size="7" fill="#334155" text-anchor="middle">${e.value.toFixed(1)}</text>`);
      }
    } else if (!isNum && e.category) {
      if (cellH > 8) {
        const label = e.category.length > 14 ? e.category.slice(0, 13) + '…' : e.category;
        lines.push(`<text x="180" y="${(y1 + cellH/2 + 3).toFixed(1)}" font-size="7" fill="#334155" text-anchor="middle">${label}</text>`);
      }
    }

    // Confidence strip (right edge)
    const confR = Math.round(255 * (1 - e.confidence));
    const confG = Math.round(255 * e.confidence);
    lines.push(`<rect x="246" y="${y1.toFixed(1)}" width="10" height="${cellH.toFixed(1)}" fill="rgb(${confR},${confG},0)" opacity="0.7"/>`);
  }

  // Borehole outline
  lines.push(`<line x1="85" y1="${Y0}" x2="85" y2="${(Y0 + span * PX_PER_M).toFixed(1)}" stroke="#334155" stroke-width="1.5"/>`);
  lines.push(`</svg>`);
  return lines.join('\n');
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  fileBytes: Uint8Array | null;
  fileName?: string | undefined;
}

type ColorMode = 'property' | 'geol' | 'confidence';
type ToolMode = 'orbit' | 'pick' | 'drillBh';
type CrossAxis = 'x' | 'y' | 'z';

// ── Component ──────────────────────────────────────────────────────────────────

export function VoxelTab({ fileBytes }: Props) {
  // ── Three.js refs ──────────────────────────────────────────────────────────
  const canvasRef   = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef    = useRef<THREE.Scene | null>(null);
  const cameraRef   = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef     = useRef<THREE.InstancedMesh | null>(null);
  const frameRef    = useRef<number>(0);
  const opacityRef  = useRef<number>(0.95);
  const bhGroupRef  = useRef<THREE.Group | null>(null);
  const sectionMeshRef = useRef<THREE.Mesh | null>(null);
  const clipPlaneRef   = useRef<THREE.Plane>(new THREE.Plane());

  // ── UI state ───────────────────────────────────────────────────────────────
  const [selectedPropId, setSelectedPropId] = useState<string>('');
  const [resolution, setResolution]         = useState(20);
  const [opacity, setOpacity]               = useState(0.95);
  const [vExag, setVExag]                   = useState(1);
  const [method, setMethod]                 = useState<'rbf' | 'idw'>('rbf');
  const [lambdaIdx, setLambdaIdx]           = useState(0);
  const [grid, setGrid]                     = useState<VoxelGrid | null>(null);
  const [building, setBuilding]             = useState(false);
  const [topoGrid, setTopoGrid]             = useState<TopoGrid | null>(null);
  const [topoFetching, setTopoFetching]     = useState(false);
  const [topoError, setTopoError]           = useState('');
  const [fetchProgress, setFetchProgress]   = useState<FetchTopoProgress>({ batch: 0, total: 0 });
  const topoFileRef = useRef<HTMLInputElement>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);

  // Color & tool modes
  const [colorMode, setColorMode]       = useState<ColorMode>('property');
  const [toolMode, setToolMode]         = useState<ToolMode>('orbit');
  const [lineage, setLineage]           = useState<VoxelCellLineage | null>(null);
  const [lineageModalOpen, setLineageModalOpen] = useState(false);
  const [virtualBh, setVirtualBh]       = useState<VirtualBh | null>(null);
  const [virtualBhSvg, setVirtualBhSvg] = useState('');

  // Cross-section
  const [crossEnabled, setCrossEnabled] = useState(false);
  const [crossAxis, setCrossAxis]       = useState<CrossAxis>('x');
  const [crossPos, setCrossPos]         = useState(0.5);

  const lambda = LAMBDA_PRESETS[lambdaIdx]?.value ?? 0;

  // ── Derived data ───────────────────────────────────────────────────────────
  const agsFile = useMemo<AgsFile | null>(() => {
    if (!fileBytes) return null;
    try { return parseStr(decodeBytes(fileBytes)).file; } catch { return null; }
  }, [fileBytes]);

  const model = useMemo(() => {
    if (!agsFile) return null;
    try { return buildGeo3DModel(agsFile); } catch { return null; }
  }, [agsFile]);

  const properties = useMemo<VoxelProperty[]>(() => {
    if (!agsFile) return [];
    try { return discoverVoxelProperties(agsFile); } catch { return []; }
  }, [agsFile]);

  useEffect(() => {
    if (properties.length > 0 && !selectedPropId) setSelectedPropId(properties[0]!.id);
  }, [properties, selectedPropId]);

  const groupedProps = useMemo(() => {
    const map = new Map<string, VoxelProperty[]>();
    for (const p of properties) {
      if (!map.has(p.group)) map.set(p.group, []);
      map.get(p.group)!.push(p);
    }
    return map;
  }, [properties]);

  const selectedProp = properties.find(p => p.id === selectedPropId);

  // Unit colour map from the geo3d model
  const unitColors = useMemo(() => {
    if (!model) return new Map<string, string>();
    return new Map<string, string>(model.units.map((u: GeoUnit) => [u.key, u.color]));
  }, [model]);

  // TPS surface fitted to borehole collar elevations — used as primary topo surface
  const collarTps = useMemo(() => {
    if (!model || model.boreholes.length < 3) return null;
    try {
      return new ThinPlateSurface(
        model.boreholes.map(bh => ({ x: bh.x, y: bh.y, z: bh.elev }))
      );
    } catch { return null; }
  }, [model]);

  // Combined topo function with priority: collar TPS → SRTM/upload → IDW
  const combinedTopoFn = useMemo(() => {
    if (!model) return undefined;
    return (lx: number, ly: number): number => {
      if (collarTps) {
        const z = collarTps.evaluate(lx, ly);
        if (isFinite(z)) return z;
      }
      if (topoGrid) {
        const z = sampleTopoAt(topoGrid, lx + model.centroid.x, ly + model.centroid.y);
        if (!isNaN(z)) return z;
      }
      return topoElevAt(lx, ly, model.boreholes);
    };
  }, [model, collarTps, topoGrid]);

  // ── Three.js init / cleanup ────────────────────────────────────────────────
  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.localClippingEnabled = true; // enable cross-section clipping
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#1a1f2e');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100000);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -500, 300);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;

    // Minecraft-style lighting: strong directional from upper-left + soft ambient
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(0.6, 0.4, 1.5); // mostly from above, slightly south-east
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xaaccff, 0.25);
    fill.position.set(-1, -1, 0.5);
    scene.add(fill);

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const obs = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    obs.observe(container);

    return () => {
      obs.disconnect();
      cancelAnimationFrame(frameRef.current);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, []);

  // ── Rebuild voxel mesh ─────────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (meshRef.current) {
      scene.remove(meshRef.current);
      meshRef.current.geometry.dispose();
      (meshRef.current.material as THREE.Material).dispose();
      meshRef.current = null;
    }

    if (!grid || grid.cells.length === 0) return;

    const { cells, property, numericRange, categories, cellSize, bounds } = grid;
    const [numMin, numMax] = numericRange;
    const numRange = numMax - numMin || 1;
    const catIndex = new Map(categories.map((c, i) => [c, i]));

    const geo = new THREE.BoxGeometry(1, 1, 1);
    // Minecraft-style material: high roughness, no gloss
    const mat = new THREE.MeshStandardMaterial({
      transparent: true,
      opacity: opacityRef.current,
      roughness: 0.95,
      metalness: 0,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, cells.length);
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      dummy.position.set(c.cx, c.cy, c.cz * vExag);
      // 0.99 scale: near-touching blocks (Minecraft aesthetic, prevents z-fighting)
      dummy.scale.set(cellSize.dx * 0.99, cellSize.dy * 0.99, cellSize.dz * vExag * 0.99);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Colour by selected mode
      if (colorMode === 'geol' && c.geolUnit) {
        const hex = unitColors.get(c.geolUnit) ?? geolColor(c.geolUnit);
        const [r, g, b] = hexToRgb(hex);
        color.setRGB(r, g, b);
      } else if (colorMode === 'confidence') {
        // Green (high) → Amber → Red (low)
        const conf = c.confidence;
        if (conf > 0.5) {
          color.setRGB(1 - (conf - 0.5) * 2 * 0.5, 0.8 - (1 - conf) * 0.3, 0);
        } else {
          color.setRGB(1, conf * 1.6, 0);
        }
      } else {
        // Property mode
        if (property.type === 'numeric' && c.value !== null) {
          viridisColor((c.value - numMin) / numRange, color);
        } else if (c.category !== null) {
          color.set(CAT_PALETTE[(catIndex.get(c.category) ?? 0) % CAT_PALETTE.length]!);
        } else {
          color.set('#888888');
        }
      }
      mesh.setColorAt(i, color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
    meshRef.current = mesh;

    // Fit camera to grid bounds on first build
    const camera = cameraRef.current!;
    const controls = controlsRef.current!;
    const cx = (bounds.xMin + bounds.xMax) / 2;
    const cy = (bounds.yMin + bounds.yMax) / 2;
    const cz = ((bounds.zMin + bounds.zMax) / 2) * vExag;
    const span = Math.max(
      bounds.xMax - bounds.xMin,
      bounds.yMax - bounds.yMin,
      (bounds.zMax - bounds.zMin) * vExag,
    );
    controls.target.set(cx, cy, cz);
    camera.position.set(cx - span * 0.8, cy - span * 1.2, cz + span * 0.9);
    controls.update();
  }, [grid, vExag, colorMode, unitColors]);

  // ── Opacity live update ────────────────────────────────────────────────────
  useEffect(() => {
    opacityRef.current = opacity;
    if (meshRef.current) {
      (meshRef.current.material as THREE.MeshStandardMaterial).opacity = opacity;
    }
  }, [opacity]);

  // ── Cross-section plane ────────────────────────────────────────────────────
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    if (!renderer || !scene) return;

    // Remove old section plane visualisation
    if (sectionMeshRef.current) {
      scene.remove(sectionMeshRef.current);
      sectionMeshRef.current.geometry.dispose();
      (sectionMeshRef.current.material as THREE.Material).dispose();
      sectionMeshRef.current = null;
    }

    if (!crossEnabled || !grid) {
      renderer.clippingPlanes = [];
      return;
    }

    const { xMin, xMax, yMin, yMax, zMin, zMax } = grid.bounds;
    let planeNormal: THREE.Vector3;
    let cutCoord: number;

    if (crossAxis === 'x') {
      cutCoord = xMin + crossPos * (xMax - xMin);
      planeNormal = new THREE.Vector3(1, 0, 0);
    } else if (crossAxis === 'y') {
      cutCoord = yMin + crossPos * (yMax - yMin);
      planeNormal = new THREE.Vector3(0, 1, 0);
    } else {
      cutCoord = (zMin + crossPos * (zMax - zMin)) * vExag;
      planeNormal = new THREE.Vector3(0, 0, 1);
    }

    clipPlaneRef.current.set(planeNormal, -cutCoord);
    renderer.clippingPlanes = [clipPlaneRef.current];

    // Semi-transparent cutting plane visualisation
    let planeGeo: THREE.BufferGeometry;
    const spanXY = Math.max(xMax - xMin, yMax - yMin) * 1.1;
    const spanZ  = (zMax - zMin) * vExag * 1.1;
    if (crossAxis === 'x') {
      planeGeo = new THREE.PlaneGeometry(spanXY, spanZ);
      planeGeo.rotateY(Math.PI / 2);
      const pm = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      pm.position.set(cutCoord, (yMin + yMax) / 2, ((zMin + zMax) / 2) * vExag);
      scene.add(pm);
      sectionMeshRef.current = pm;
    } else if (crossAxis === 'y') {
      planeGeo = new THREE.PlaneGeometry(spanXY, spanZ);
      planeGeo.rotateX(Math.PI / 2);
      const pm = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      pm.position.set((xMin + xMax) / 2, cutCoord, ((zMin + zMax) / 2) * vExag);
      scene.add(pm);
      sectionMeshRef.current = pm;
    } else {
      planeGeo = new THREE.PlaneGeometry(spanXY, spanXY);
      const pm = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      pm.position.set((xMin + xMax) / 2, (yMin + yMax) / 2, cutCoord);
      scene.add(pm);
      sectionMeshRef.current = pm;
    }
  }, [crossEnabled, crossAxis, crossPos, grid, vExag]);

  // ── Borehole sticks + topo surface ─────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (bhGroupRef.current) {
      scene.remove(bhGroupRef.current);
      disposeGroup(bhGroupRef.current);
      bhGroupRef.current = null;
    }

    if (!model || model.boreholes.length === 0) return;

    const group = new THREE.Group();
    const { xMin, xMax, yMin, yMax } = model.bounds;
    const spanXY = Math.max(xMax - xMin, yMax - yMin, 1);

    // ── Topo surface using priority chain: collar TPS → SRTM → IDW ──
    const TOPO_N = 32;
    const tdx = (xMax - xMin) / (TOPO_N - 1);
    const tdy = (yMax - yMin) / (TOPO_N - 1);
    const topoVerts = new Float32Array(TOPO_N * TOPO_N * 3);
    for (let iy = 0; iy < TOPO_N; iy++) {
      for (let ix = 0; ix < TOPO_N; ix++) {
        const wx = xMin + ix * tdx;
        const wy = yMin + iy * tdy;
        let elev: number;

        // Priority 1: Collar TPS (ground-truthed at borehole positions)
        if (collarTps) {
          const z = collarTps.evaluate(wx, wy);
          elev = isFinite(z) ? z : topoElevAt(wx, wy, model.boreholes);
        } else {
          elev = topoElevAt(wx, wy, model.boreholes);
        }

        // Priority 2: SRTM fills in where collar TPS may extrapolate poorly
        // (only use for edge of model where boreholes are sparse)
        if (topoGrid) {
          const absX = wx + model.centroid.x;
          const absY = wy + model.centroid.y;
          const srtmZ = sampleTopoAt(topoGrid, absX, absY);
          // Blend: near boreholes use collar TPS, far away use SRTM
          if (!isNaN(srtmZ) && !collarTps) {
            elev = srtmZ;
          }
        }

        const i3 = (iy * TOPO_N + ix) * 3;
        topoVerts[i3] = wx; topoVerts[i3 + 1] = wy; topoVerts[i3 + 2] = elev * vExag;
      }
    }
    const topoIdx: number[] = [];
    for (let iy = 0; iy < TOPO_N - 1; iy++) {
      for (let ix = 0; ix < TOPO_N - 1; ix++) {
        const a = iy * TOPO_N + ix, b = a + 1, c = a + TOPO_N, d = c + 1;
        topoIdx.push(a, c, b, b, c, d);
      }
    }
    const topoGeo = new THREE.BufferGeometry();
    topoGeo.setAttribute('position', new THREE.BufferAttribute(topoVerts, 3));
    topoGeo.setIndex(topoIdx);
    topoGeo.computeVertexNormals();
    group.add(new THREE.Mesh(topoGeo, new THREE.MeshStandardMaterial({
      color: 0x6b8f5e, roughness: 0.9, metalness: 0,
      transparent: true, opacity: 0.30,
      side: THREE.DoubleSide, depthWrite: false,
    })));

    // ── Borehole sticks ──
    const stickColor = new THREE.Color(0xffcc00);
    const sphereR = Math.max(spanXY * 0.008, 0.3);
    for (const bh of model.boreholes) {
      const maxLayerDepth = bh.layers.length > 0
        ? Math.max(...bh.layers.map(l => l.baseDepth)) : 0;
      const fd = Math.max(bh.finDepth, maxLayerDepth, 1);
      const topZ = bh.elev * vExag;
      const botZ = (bh.elev - fd) * vExag;

      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(bh.x, bh.y, botZ),
        new THREE.Vector3(bh.x, bh.y, topZ),
      ]);
      group.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: stickColor })));

      const sphereGeo = new THREE.SphereGeometry(sphereR, 8, 6);
      const sphere = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: stickColor }));
      sphere.position.set(bh.x, bh.y, topZ);
      group.add(sphere);
    }

    sceneRef.current!.add(group);
    bhGroupRef.current = group;
  }, [model, vExag, topoGrid, collarTps]);

  // ── Canvas click handler (pick / virtualBh) ────────────────────────────────
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (toolMode === 'orbit') return;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const mesh = meshRef.current;
    if (!renderer || !camera || !grid) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

    if (toolMode === 'pick' && mesh && agsFile && model) {
      const hits = raycaster.intersectObject(mesh);
      if (hits.length > 0 && hits[0]!.instanceId !== undefined) {
        const idx = hits[0]!.instanceId;
        const lg = getVoxelCellLineage(grid, idx, agsFile, model);
        setLineage(lg);
        setVirtualBh(null);
      }
    }

    if (toolMode === 'drillBh' && model) {
      // Cast against a horizontal plane at the model's max elevation
      const { zMax } = grid.bounds;
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -zMax * vExag);
      const hit = new THREE.Vector3();
      raycaster.ray.intersectPlane(plane, hit);
      if (!hit) return;

      // Find the nearest grid column (ix, iy) to the hit point
      const bXMin = grid.bounds.xMin;
      const bYMin = grid.bounds.yMin;
      const { dx, dy } = grid.cellSize;

      const targetIx = Math.round((hit.x - bXMin) / dx - 0.5);
      const targetIy = Math.round((hit.y - bYMin) / dy - 0.5);
      const clampIx = Math.max(0, Math.min(grid.nx - 1, targetIx));
      const clampIy = Math.max(0, Math.min(grid.ny - 1, targetIy));

      const colCells = grid.cells
        .filter(c => c.ix === clampIx && c.iy === clampIy)
        .sort((a, b) => b.cz - a.cz); // top to bottom

      if (colCells.length === 0) return;

      const topElev = colCells[0]!.cz + grid.cellSize.dz * 0.5;
      const botElev = colCells[colCells.length - 1]!.cz - grid.cellSize.dz * 0.5;

      const entries: VirtualBhEntry[] = colCells.map(c => ({
        cz: c.cz,
        topElev: c.cz + grid.cellSize.dz * 0.5,
        baseElev: c.cz - grid.cellSize.dz * 0.5,
        value: c.value,
        category: c.category,
        geolUnit: c.geolUnit,
        confidence: c.confidence,
      }));

      const cx = bXMin + (clampIx + 0.5) * dx;
      const cy = bYMin + (clampIy + 0.5) * dy;
      const vbh: VirtualBh = { cx, cy, lx: cx, ly: cy, topElev, botElev, entries };
      setVirtualBh(vbh);
      setVirtualBhSvg(buildVirtualBhSvg(vbh, grid));
      setLineage(null);
    }
  }, [toolMode, grid, agsFile, model, vExag]);

  // ── Topo file upload ───────────────────────────────────────────────────────
  const handleTopoFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setTopoError('');
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      try {
        const tg = file.name.toLowerCase().endsWith('.asc')
          ? parseAscGrid(text, file.name)
          : parseXyzPoints(text, 60, file.name);
        setTopoGrid(tg);
      } catch (err) {
        setTopoError(err instanceof Error ? err.message : 'Failed to parse topo file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, []);

  // ── SRTM API fetch ─────────────────────────────────────────────────────────
  const handleFetchSrtm = useCallback(async () => {
    if (!model) return;
    if (fetchAbortRef.current) fetchAbortRef.current.abort();
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;
    setTopoFetching(true);
    setTopoError('');
    setFetchProgress({ batch: 0, total: 0 });
    try {
      const tg = await fetchTopoGrid(model, p => setFetchProgress(p), ctrl.signal);
      if (tg) setTopoGrid(tg);
      else setTopoError('Could not project site coordinates to WGS84.');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setTopoError(err instanceof Error ? err.message : 'Fetch failed');
      }
    } finally {
      setTopoFetching(false);
      fetchAbortRef.current = null;
    }
  }, [model]);

  // ── Build ──────────────────────────────────────────────────────────────────
  const buildGrid = useCallback(() => {
    if (!agsFile || !model || !selectedPropId) return;
    const prop = properties.find(p => p.id === selectedPropId);
    if (!prop) return;
    setBuilding(true);
    try {
      const buildOpts: Parameters<typeof buildVoxelGrid>[3] = {
        nx: resolution, ny: resolution, nz: resolution,
        method, lambda,
      };
      if (combinedTopoFn) buildOpts.topoFn = combinedTopoFn;
      const g = buildVoxelGrid(agsFile, model, prop, buildOpts);
      setGrid(g);
      setLineage(null);
      setVirtualBh(null);
    } finally {
      setBuilding(false);
    }
  }, [agsFile, model, selectedPropId, properties, resolution, method, lambda, combinedTopoFn]);

  // ── Export ─────────────────────────────────────────────────────────────────
  const exportCsv = useCallback(() => {
    if (!grid) return;
    const blob = new Blob([voxelGridToCsv(grid)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voxel_${grid.property.id.toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [grid]);

  const exportObj = useCallback(() => {
    if (!grid) return;
    const obj = voxelGridToObj(grid);
    const blob = new Blob([obj], { type: 'model/obj' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voxel_${grid.property.id.toLowerCase()}.obj`;
    a.click();
    URL.revokeObjectURL(url);
  }, [grid]);

  const exportGlb = useCallback(() => {
    const mesh = meshRef.current;
    if (!mesh || !grid) return;
    const exporter = new GLTFExporter();
    exporter.parse(
      mesh,
      (result) => {
        const buf = result instanceof ArrayBuffer ? result : new TextEncoder().encode(JSON.stringify(result));
        const blob = new Blob([buf], { type: 'model/gltf-binary' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `voxel_${grid.property.id.toLowerCase()}.glb`;
        a.click();
        URL.revokeObjectURL(url);
      },
      (err) => console.error('GLB export failed', err),
      { binary: true },
    );
  }, [grid]);

  // ── Derived display values ─────────────────────────────────────────────────
  const totalCells = grid ? grid.nx * grid.ny * grid.nz : 0;
  const filledPct  = grid && totalCells > 0
    ? (grid.cells.length / totalCells * 100).toFixed(1) : '0';
  const noFile  = !fileBytes;
  const noModel = fileBytes && !model;
  const canBuild = !!agsFile && !!model && !!selectedPropId && !building;
  const isNumeric = selectedProp?.type === 'numeric';
  const histMax = grid?.stats ? Math.max(...grid.stats.histogram.counts, 1) : 1;

  const rightPanelOpen = !!lineage || !!virtualBh;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', gap: 12, height: 'calc(100vh - 210px)', minHeight: 540 }}>

      {/* ── Left panel ────────────────────────────────────────────────────── */}
      <div style={{ width: 296, flexShrink: 0, overflowY: 'auto' }}>

        {/* Property */}
        <div style={PANEL}>
          <label style={SLABEL}>Property</label>
          {noFile && <p style={{ fontSize: 13, color: 'var(--muted)' }}>Load an AGS file to begin.</p>}
          {!noFile && properties.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>No interpolatable fields found.</p>
          )}
          {properties.length > 0 && (
            <select
              value={selectedPropId}
              onChange={e => setSelectedPropId(e.target.value)}
              style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13, background: 'var(--card)' }}
            >
              {[...groupedProps.entries()].map(([grp, props]) => (
                <optgroup key={grp} label={grp}>
                  {props.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.id}{p.unit ? ` (${p.unit})` : ''} — {p.type}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </div>

        {/* Colour mode */}
        {grid && (
          <div style={PANEL}>
            <label style={SLABEL}>Colour by</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['property', 'geol', 'confidence'] as ColorMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setColorMode(m)}
                  style={{
                    flex: 1, padding: '5px 0', fontSize: 11, fontWeight: 600,
                    borderRadius: 6, border: '1px solid var(--border)',
                    background: colorMode === m ? 'var(--navy)' : 'var(--card)',
                    color: colorMode === m ? '#fff' : 'var(--muted)',
                    cursor: 'pointer',
                  }}
                >
                  {m === 'property' ? 'Value' : m === 'geol' ? 'Geology' : 'Certainty'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Interpolation method */}
        {isNumeric && (
          <div style={PANEL}>
            <label style={SLABEL}>Interpolation method</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {(['rbf', 'idw'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  style={{
                    flex: 1, padding: '6px 0', fontSize: 12, fontWeight: 600,
                    borderRadius: 6, border: '1px solid var(--border)',
                    background: method === m ? 'var(--navy)' : 'var(--card)',
                    color: method === m ? '#fff' : 'var(--muted)',
                    cursor: 'pointer',
                  }}
                >
                  {m === 'rbf' ? '3-D RBF' : 'IDW'}
                </button>
              ))}
            </div>
            {method === 'rbf' && (
              <>
                <label style={{ ...SLABEL, marginTop: 4 }}>
                  Smoothing (λ) — {LAMBDA_PRESETS[lambdaIdx]?.label}
                </label>
                <input
                  type="range" min={0} max={LAMBDA_PRESETS.length - 1} step={1} value={lambdaIdx}
                  onChange={e => setLambdaIdx(+e.target.value)}
                  style={{ width: '100%' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                  <span>Exact</span><span>Heavy</span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Resolution */}
        <div style={PANEL}>
          <label style={SLABEL}>Grid resolution — {resolution}³</label>
          <input
            type="range" min={10} max={40} step={5} value={resolution}
            onChange={e => setResolution(+e.target.value)}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            <span>10</span><span>25</span><span>40</span>
          </div>
        </div>

        {/* Opacity + V-exag */}
        <div style={PANEL}>
          <label style={SLABEL}>Opacity — {Math.round(opacity * 100)}%</label>
          <input
            type="range" min={10} max={100} step={5} value={Math.round(opacity * 100)}
            onChange={e => setOpacity(+e.target.value / 100)}
            style={{ width: '100%' }}
          />
          <label style={{ ...SLABEL, marginTop: 8 }}>Vertical exaggeration — {vExag}×</label>
          <input
            type="range" min={1} max={10} step={0.5} value={vExag}
            onChange={e => setVExag(+e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        {/* Cross-section */}
        <div style={PANEL}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <label style={{ ...SLABEL, marginBottom: 0 }}>Cross-section</label>
            <button
              onClick={() => setCrossEnabled(v => !v)}
              disabled={!grid}
              style={{
                fontSize: 11, padding: '3px 10px', borderRadius: 6,
                border: '1px solid var(--border)',
                background: crossEnabled ? '#2563eb' : 'var(--card)',
                color: crossEnabled ? '#fff' : 'var(--muted)',
                cursor: grid ? 'pointer' : 'not-allowed',
                opacity: grid ? 1 : 0.4,
              }}
            >
              {crossEnabled ? 'On' : 'Off'}
            </button>
          </div>
          {crossEnabled && (
            <>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                {(['x', 'y', 'z'] as CrossAxis[]).map(ax => (
                  <button
                    key={ax}
                    onClick={() => setCrossAxis(ax)}
                    style={{
                      flex: 1, padding: '5px 0', fontSize: 12, fontWeight: 700,
                      borderRadius: 6, border: '1px solid var(--border)',
                      background: crossAxis === ax ? 'var(--navy)' : 'var(--card)',
                      color: crossAxis === ax ? '#fff' : 'var(--muted)',
                      cursor: 'pointer',
                    }}
                  >
                    {ax.toUpperCase()}
                  </button>
                ))}
              </div>
              <label style={{ ...SLABEL }}>
                Position — {Math.round(crossPos * 100)}%
              </label>
              <input
                type="range" min={0} max={100} step={1} value={Math.round(crossPos * 100)}
                onChange={e => setCrossPos(+e.target.value / 100)}
                style={{ width: '100%' }}
              />
            </>
          )}
        </div>

        {/* Topo surface */}
        <div style={PANEL}>
          <label style={SLABEL}>Topo surface</label>
          <div style={{ fontSize: 12, marginBottom: 4 }}>
            {collarTps ? (
              <span style={{ color: '#22c55e' }}>✓ Collar TPS ({model?.boreholes.length} points)</span>
            ) : (
              <span style={{ color: 'var(--muted)' }}>IDW from borehole collars</span>
            )}
          </div>
          {topoGrid && (
            <div style={{ fontSize: 12, color: '#3b82f6', marginBottom: 6 }}>
              + {topoGrid.source} (fill beyond boreholes)
            </div>
          )}
          <input ref={topoFileRef} type="file" accept=".asc,.xyz,.csv,.txt"
            style={{ display: 'none' }} onChange={handleTopoFileUpload} />
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <button
              onClick={() => topoFileRef.current?.click()}
              style={{ flex: 1, fontSize: 12, padding: '5px 0', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer' }}
            >
              Load .asc / .xyz
            </button>
            <button
              onClick={handleFetchSrtm}
              disabled={topoFetching || !model}
              style={{ flex: 1, fontSize: 12, padding: '5px 0', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', cursor: topoFetching || !model ? 'not-allowed' : 'pointer', opacity: topoFetching || !model ? 0.5 : 1 }}
            >
              {topoFetching ? `SRTM… ${fetchProgress.batch}/${fetchProgress.total}` : 'Fetch SRTM 30m'}
            </button>
          </div>
          {topoGrid && (
            <button
              onClick={() => { setTopoGrid(null); setTopoError(''); }}
              style={{ width: '100%', fontSize: 11, padding: '4px 0', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--muted)', cursor: 'pointer' }}
            >
              Clear SRTM/topo
            </button>
          )}
          {topoError && <p style={{ fontSize: 11, color: '#dc2626', marginTop: 6 }}>{topoError}</p>}
        </div>

        {/* Build */}
        <button
          onClick={buildGrid}
          disabled={!canBuild}
          style={{ width: '100%', background: 'var(--blue)', color: '#fff', marginBottom: 10 }}
        >
          {building ? 'Building…' : 'Build Voxel Grid'}
        </button>

        {noModel && (
          <p style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginBottom: 10 }}>
            No borehole location data (LOCA) found.
          </p>
        )}

        {/* Grid info */}
        {grid && (
          <div style={PANEL}>
            <label style={SLABEL}>Grid</label>
            {([
              ['Method', grid.method === 'rbf' ? '3-D RBF' : 'IDW'],
              ['Size', `${grid.nx} × ${grid.ny} × ${grid.nz}`],
              ['Populated', `${grid.cells.length.toLocaleString()} / ${totalCells.toLocaleString()} (${filledPct}%)`],
              ['Elevation', `${grid.bounds.zMin.toFixed(1)} – ${grid.bounds.zMax.toFixed(1)} m OD`],
              ...(model ? [['Boreholes', `${model.boreholes.length}`]] as [string, string][] : []),
              ...(grid.property.type === 'numeric'
                ? [['Range', `${grid.numericRange[0].toFixed(2)} – ${grid.numericRange[1].toFixed(2)}${grid.property.unit ? ' ' + grid.property.unit : ''}`]]
                : [['Categories', String(grid.categories.length)]]) as [string, string][],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} style={ROW}>
                <span style={{ color: 'var(--muted)' }}>{k}</span>
                <span style={{ fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
        )}

        {/* Statistics */}
        {grid?.stats && (
          <div style={PANEL}>
            <label style={SLABEL}>Observations ({grid.stats.count}){grid.property.unit ? ` — ${grid.property.unit}` : ''}</label>
            {([['Mean', grid.stats.mean.toFixed(3)], ['Std', grid.stats.std.toFixed(3)], ['P10', grid.stats.p10.toFixed(3)], ['P50', grid.stats.p50.toFixed(3)], ['P90', grid.stats.p90.toFixed(3)]] as [string, string][]).map(([k, v]) => (
              <div key={k} style={ROW}>
                <span style={{ color: 'var(--muted)' }}>{k}</span>
                <span style={{ fontWeight: 600 }}>{v}</span>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 40, marginTop: 10 }}>
              {grid.stats.histogram.counts.map((count, i) => (
                <div key={i}
                  title={`${grid.stats!.histogram.edges[i]?.toFixed(2)} – ${grid.stats!.histogram.edges[i+1]?.toFixed(2)}: ${count}`}
                  style={{ flex: 1, height: `${Math.max(2, (count / histMax) * 40)}px`, background: `linear-gradient(to right, ${VIRIDIS_CSS})`, backgroundSize: `${grid.stats!.histogram.counts.length * 100}% 100%`, backgroundPositionX: `${(i / (grid.stats!.histogram.counts.length - 1)) * 100}%`, borderRadius: '2px 2px 0 0' }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>
              <span>{grid.stats.histogram.edges[0]?.toFixed(1)}</span>
              <span>{grid.stats.histogram.edges[Math.floor(grid.stats.histogram.edges.length / 2)]?.toFixed(1)}</span>
              <span>{grid.stats.histogram.edges[grid.stats.histogram.edges.length - 1]?.toFixed(1)}</span>
            </div>
          </div>
        )}

        {/* Colour legend */}
        {grid?.property.type === 'numeric' && colorMode === 'property' && (
          <div style={PANEL}>
            <label style={SLABEL}>Colour scale{grid.property.unit ? ` (${grid.property.unit})` : ''}</label>
            <div style={{ height: 14, borderRadius: 4, marginBottom: 5, background: `linear-gradient(to right, ${VIRIDIS_CSS})` }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span>{grid.numericRange[0].toFixed(2)}</span>
              <span>{((grid.numericRange[0] + grid.numericRange[1]) / 2).toFixed(2)}</span>
              <span>{grid.numericRange[1].toFixed(2)}</span>
            </div>
          </div>
        )}
        {grid?.property.type === 'categorical' && colorMode === 'property' && (
          <div style={PANEL}>
            <label style={SLABEL}>Legend</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {grid.categories.map((cat, i) => (
                <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0, background: CAT_PALETTE[i % CAT_PALETTE.length] }} />
                  <span style={{ wordBreak: 'break-word' }}>{cat}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {colorMode === 'geol' && model && model.units.length > 0 && (
          <div style={PANEL}>
            <label style={SLABEL}>Geological units</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {model.units.map(u => (
                <div key={u.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 2, flexShrink: 0, background: u.color }} />
                  <span>{u.key}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {colorMode === 'confidence' && (
          <div style={PANEL}>
            <label style={SLABEL}>Certainty scale</label>
            <div style={{ height: 14, borderRadius: 4, marginBottom: 5, background: 'linear-gradient(to right, #dc2626, #f59e0b, #16a34a)' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span>Low</span><span>Medium</span><span>High</span>
            </div>
          </div>
        )}

        {/* Export */}
        {grid && grid.cells.length > 0 && (
          <div style={PANEL}>
            <label style={SLABEL}>Export</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={exportCsv} style={{ flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer' }}>CSV</button>
              <button onClick={exportObj} style={{ flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer' }}>OBJ</button>
              <button onClick={exportGlb} style={{ flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer' }}>GLB</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Centre: Three.js canvas ────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

        {/* Tool bar */}
        {grid && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
            {([
              { id: 'orbit',   label: 'Orbit',        icon: '⟳' },
              { id: 'pick',    label: 'Cell Info',     icon: '🔍' },
              { id: 'drillBh', label: 'Virtual BH',   icon: '⬇' },
            ] as { id: ToolMode; label: string; icon: string }[]).map(t => (
              <button
                key={t.id}
                onClick={() => setToolMode(t.id)}
                title={t.label}
                style={{
                  padding: '5px 12px', fontSize: 12, fontWeight: 600,
                  borderRadius: 6, border: '1px solid var(--border)',
                  background: toolMode === t.id ? 'var(--navy)' : 'var(--card)',
                  color: toolMode === t.id ? '#fff' : 'var(--fg)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                <span>{t.icon}</span>{t.label}
              </button>
            ))}
            <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 4 }}>
              {toolMode === 'pick' ? 'Click a voxel to inspect its lineage' : toolMode === 'drillBh' ? 'Click the model surface to drill a virtual borehole' : 'Drag to orbit · Scroll to zoom'}
            </span>
          </div>
        )}

        <div
          ref={canvasRef}
          onClick={handleCanvasClick}
          style={{
            flex: 1, borderRadius: 8, overflow: 'hidden', background: '#1a1f2e',
            position: 'relative',
            cursor: toolMode === 'orbit' ? 'grab' : toolMode === 'pick' ? 'crosshair' : 'cell',
          }}
        >
          {(!grid || grid.cells.length === 0) && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 14, gap: 10, pointerEvents: 'none', userSelect: 'none' }}>
              <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                <line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
              <span>Select a property and click Build Voxel Grid</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Right panel: lineage or virtual borehole ───────────────────────── */}
      {rightPanelOpen && (
        <div style={{ width: 280, flexShrink: 0, overflowY: 'auto' }}>

          {/* Lineage panel */}
          {lineage && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>Cell Lineage</span>
                <button onClick={() => setLineage(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 16 }}>✕</button>
              </div>

              <div style={PANEL}>
                <label style={SLABEL}>Position</label>
                {([
                  ['Grid', `(${lineage.ix}, ${lineage.iy}, ${lineage.iz})`],
                  ['Elevation', `${lineage.cz.toFixed(2)} m OD`],
                  ['Depth below GL', lineage.depthBelowGround !== null ? `${lineage.depthBelowGround.toFixed(1)} m` : '—'],
                  ['Local X', `${lineage.cx.toFixed(1)} m`],
                  ['Local Y', `${lineage.cy.toFixed(1)} m`],
                ] as [string, string][]).map(([k, v]) => (
                  <div key={k} style={ROW}>
                    <span style={{ color: 'var(--muted)' }}>{k}</span>
                    <span style={{ fontWeight: 600 }}>{v}</span>
                  </div>
                ))}
              </div>

              <div style={PANEL}>
                <label style={SLABEL}>Value</label>
                {([
                  ['Method', lineage.method === 'rbf' ? '3-D RBF' : 'IDW'],
                  ['Value', lineage.value !== null ? lineage.value.toFixed(3) + (grid?.property.unit ? ' ' + grid.property.unit : '') : (lineage.category ?? '—')],
                  ['Geology', lineage.geolUnit ?? '(unknown)'],
                  ['Certainty', `${Math.round(lineage.confidence * 100)}%`],
                  ['Nearest obs.', lineage.nearestObsDistH !== null ? `${lineage.nearestObsDistH.toFixed(0)} m` : '—'],
                ] as [string, string][]).map(([k, v]) => (
                  <div key={k} style={ROW}>
                    <span style={{ color: 'var(--muted)' }}>{k}</span>
                    <span style={{ fontWeight: 600 }}>{v}</span>
                  </div>
                ))}
              </div>

              {lineage.contributors.length > 0 && (
                <div style={PANEL}>
                  <label style={SLABEL}>Contributing boreholes ({lineage.contributors.length})</label>
                  <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        {['BH ID', 'Dist (m)', 'Wt %', 'Value'].map(h => (
                          <th key={h} style={{ textAlign: 'left', color: 'var(--muted)', fontWeight: 600, paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {lineage.contributors.map((c, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '3px 0', fontWeight: 600 }}>{c.boreholeId}</td>
                          <td style={{ padding: '3px 4px' }}>{c.distH.toFixed(0)}</td>
                          <td style={{ padding: '3px 4px' }}>{Math.round(c.weight * 100)}</td>
                          <td style={{ padding: '3px 0' }}>
                            {c.value !== null ? c.value.toFixed(2) : (c.category ?? '—')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 }}>
                    Depth window: ±{grid ? (grid.cellSize.dz * 0.55).toFixed(1) : '?'} m from cell centre.
                    Weights shown are IDW (1/distance) normalised — RBF uses a global solve.
                  </p>
                </div>
              )}

              {/* Full lineage detail view */}
              <button
                onClick={() => setLineageModalOpen(true)}
                style={{
                  width: '100%', padding: '8px 0', borderRadius: 8,
                  border: '1px solid #2563eb', background: 'transparent',
                  color: '#3b82f6', fontSize: 12, fontWeight: 700,
                  cursor: 'pointer', marginTop: 4,
                }}
              >
                Full Lineage View →
              </button>
            </div>
          )}

          {/* Virtual borehole panel */}
          {virtualBh && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>Virtual Borehole</span>
                <button onClick={() => setVirtualBh(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 16 }}>✕</button>
              </div>
              <div style={PANEL}>
                <label style={SLABEL}>Position (local)</label>
                <div style={ROW}><span style={{ color: 'var(--muted)' }}>X</span><span style={{ fontWeight: 600 }}>{virtualBh.lx.toFixed(1)} m</span></div>
                <div style={ROW}><span style={{ color: 'var(--muted)' }}>Y</span><span style={{ fontWeight: 600 }}>{virtualBh.ly.toFixed(1)} m</span></div>
                <div style={ROW}><span style={{ color: 'var(--muted)' }}>Depth</span><span style={{ fontWeight: 600 }}>{(virtualBh.topElev - virtualBh.botElev).toFixed(1)} m</span></div>
                <div style={ROW}><span style={{ color: 'var(--muted)' }}>Cells</span><span style={{ fontWeight: 600 }}>{virtualBh.entries.length}</span></div>
              </div>
              {virtualBhSvg && (
                <div
                  style={{ background: '#f8fafc', borderRadius: 8, overflow: 'hidden' }}
                  dangerouslySetInnerHTML={{ __html: virtualBhSvg }}
                />
              )}
              <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4, padding: '0 2px' }}>
                Strip log shows geology (colour), property value (bar), and certainty (right strip: green = high, red = low).
              </p>
            </div>
          )}
        </div>
      )}

      {lineageModalOpen && lineage && model && grid && (
        <LineageModal
          lineage={lineage}
          model={model}
          grid={grid}
          onClose={() => setLineageModalOpen(false)}
        />
      )}
    </div>
  );
}
