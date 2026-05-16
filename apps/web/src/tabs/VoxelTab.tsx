/**
 * VoxelTab — geostatistical voxel grid viewer.
 *
 * Layout:
 *   LEFT (300 px)  — property selector, sliders, build button, legend, stats, export
 *   RIGHT (flex 1) — Three.js InstancedMesh voxel renderer with OrbitControls
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  decodeBytes, parseStr, buildGeo3DModel,
  discoverVoxelProperties, buildVoxelGrid, voxelGridToCsv,
} from '../core.js';
import type { AgsFile, VoxelProperty, VoxelGrid } from '../core.js';

// ── Colour helpers ─────────────────────────────────────────────────────────────

// Simplified viridis key stops: [R, G, B] in 0–1
const VIRIDIS: [number, number, number][] = [
  [0.267, 0.005, 0.329],  // 0.00 — dark purple
  [0.231, 0.322, 0.545],  // 0.25
  [0.129, 0.569, 0.549],  // 0.50
  [0.369, 0.788, 0.384],  // 0.75
  [0.993, 0.906, 0.144],  // 1.00 — yellow
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

const CAT_PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#be185d', '#65a30d', '#ea580c', '#4f46e5',
  '#0d9488', '#b45309', '#9333ea', '#0284c7', '#c2410c',
  '#1d4ed8', '#b91c1c', '#15803d', '#b45309', '#6d28d9',
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

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  fileBytes: Uint8Array | null;
  fileName?: string | undefined;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function VoxelTab({ fileBytes }: Props) {
  // ── Three.js refs ──────────────────────────────────────────────────────────
  const canvasRef    = useRef<HTMLDivElement>(null);
  const rendererRef  = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef     = useRef<THREE.Scene | null>(null);
  const cameraRef    = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef  = useRef<OrbitControls | null>(null);
  const meshRef      = useRef<THREE.InstancedMesh | null>(null);
  const frameRef     = useRef<number>(0);
  const opacityRef   = useRef<number>(0.8);

  // ── Data state ─────────────────────────────────────────────────────────────
  const [selectedPropId, setSelectedPropId] = useState<string>('');
  const [resolution, setResolution]         = useState(20);
  const [opacity, setOpacity]               = useState(0.8);
  const [vExag, setVExag]                   = useState(1);
  const [grid, setGrid]                     = useState<VoxelGrid | null>(null);
  const [building, setBuilding]             = useState(false);

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

  // Auto-select first property
  useEffect(() => {
    if (properties.length > 0 && !selectedPropId) {
      setSelectedPropId(properties[0]!.id);
    }
  }, [properties, selectedPropId]);

  // Group properties by AGS group for <optgroup>
  const groupedProps = useMemo(() => {
    const map = new Map<string, VoxelProperty[]>();
    for (const p of properties) {
      if (!map.has(p.group)) map.set(p.group, []);
      map.get(p.group)!.push(p);
    }
    return map;
  }, [properties]);

  // ── Three.js init / cleanup ────────────────────────────────────────────────
  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
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

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 0.4);
    dir.position.set(1, 1, 2);
    scene.add(dir);

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
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // ── Rebuild voxel mesh when grid or vExag changes ──────────────────────────
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
    const mat = new THREE.MeshLambertMaterial({ transparent: true, opacity: opacityRef.current });
    const mesh = new THREE.InstancedMesh(geo, mat, cells.length);

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      dummy.position.set(c.cx, c.cy, c.cz * vExag);
      dummy.scale.set(cellSize.dx * 0.92, cellSize.dy * 0.92, cellSize.dz * vExag * 0.92);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      if (property.type === 'numeric' && c.value !== null) {
        viridisColor((c.value - numMin) / numRange, color);
      } else if (c.category !== null) {
        color.set(CAT_PALETTE[(catIndex.get(c.category) ?? 0) % CAT_PALETTE.length]!);
      } else {
        color.set('#888888');
      }
      mesh.setColorAt(i, color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
    meshRef.current = mesh;

    // Fit camera to grid
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
    camera.position.set(cx, cy - span * 1.4, cz + span * 0.7);
    controls.update();
  }, [grid, vExag]);

  // Update material opacity without full mesh rebuild
  useEffect(() => {
    opacityRef.current = opacity;
    if (!meshRef.current) return;
    (meshRef.current.material as THREE.MeshLambertMaterial).opacity = opacity;
  }, [opacity]);

  // ── Build voxel grid ───────────────────────────────────────────────────────
  const buildGrid = useCallback(() => {
    if (!agsFile || !model || !selectedPropId) return;
    const prop = properties.find(p => p.id === selectedPropId);
    if (!prop) return;
    setBuilding(true);
    try {
      const g = buildVoxelGrid(agsFile, model, prop, { nx: resolution, ny: resolution, nz: resolution });
      setGrid(g);
    } finally {
      setBuilding(false);
    }
  }, [agsFile, model, selectedPropId, properties, resolution]);

  // ── Export CSV ─────────────────────────────────────────────────────────────
  const exportCsv = useCallback(() => {
    if (!grid) return;
    const csv = voxelGridToCsv(grid);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voxel_${grid.property.id.toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [grid]);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const totalCells = grid ? grid.nx * grid.ny * grid.nz : 0;
  const filledPct  = grid && totalCells > 0
    ? (grid.cells.length / totalCells * 100).toFixed(1)
    : '0';

  const noFile  = !fileBytes;
  const noModel = fileBytes && !model;
  const canBuild = !!agsFile && !!model && !!selectedPropId && !building;

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 210px)', minHeight: 540 }}>
      {/* ── Left panel ────────────────────────────────────────────────────── */}
      <div style={{ width: 300, flexShrink: 0, overflowY: 'auto' }}>

        {/* Property selector */}
        <div style={PANEL}>
          <label style={SLABEL}>Property</label>
          {noFile && (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>Load an AGS file to begin.</p>
          )}
          {!noFile && properties.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>No interpolatable fields found in this file.</p>
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

        {/* Resolution */}
        <div style={PANEL}>
          <label style={SLABEL}>Grid resolution — {resolution}³ ({resolution ** 3} cells max)</label>
          <input
            type="range" min={10} max={40} step={5} value={resolution}
            onChange={e => setResolution(+e.target.value)}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            <span>10</span><span>25</span><span>40</span>
          </div>
        </div>

        {/* Opacity */}
        <div style={PANEL}>
          <label style={SLABEL}>Opacity — {Math.round(opacity * 100)}%</label>
          <input
            type="range" min={10} max={100} step={5} value={Math.round(opacity * 100)}
            onChange={e => setOpacity(+e.target.value / 100)}
            style={{ width: '100%' }}
          />
        </div>

        {/* V-exaggeration */}
        <div style={PANEL}>
          <label style={SLABEL}>Vertical exaggeration — {vExag}×</label>
          <input
            type="range" min={1} max={10} step={0.5} value={vExag}
            onChange={e => setVExag(+e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        {/* Build button */}
        <button
          onClick={buildGrid}
          disabled={!canBuild}
          style={{ width: '100%', background: 'var(--blue)', color: '#fff', marginBottom: 10 }}
        >
          {building ? 'Building…' : 'Build Voxel Grid'}
        </button>

        {noModel && (
          <p style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginBottom: 10 }}>
            No borehole location data (LOCA group) found.
          </p>
        )}

        {/* Stats */}
        {grid && (
          <div style={PANEL}>
            <label style={SLABEL}>Statistics</label>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <tbody>
                {([
                  ['Property', grid.property.id],
                  ['Grid', `${grid.nx} × ${grid.ny} × ${grid.nz}`],
                  ['Populated', `${grid.cells.length.toLocaleString()} / ${totalCells.toLocaleString()}`],
                  ['Fill ratio', `${filledPct}%`],
                  ...(grid.property.type === 'numeric'
                    ? [
                        ['Min', grid.numericRange[0].toFixed(3) + (grid.property.unit ? ' ' + grid.property.unit : '')],
                        ['Max', grid.numericRange[1].toFixed(3) + (grid.property.unit ? ' ' + grid.property.unit : '')],
                      ]
                    : [['Categories', String(grid.categories.length)]]),
                ] as [string, string][]).map(([k, v]) => (
                  <tr key={k} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ color: 'var(--muted)', padding: '4px 0', paddingRight: 8 }}>{k}</td>
                    <td style={{ fontWeight: 600 }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Numeric legend */}
        {grid?.property.type === 'numeric' && (
          <div style={PANEL}>
            <label style={SLABEL}>
              Legend{grid.property.unit ? ` (${grid.property.unit})` : ''}
            </label>
            <div style={{
              height: 16, borderRadius: 4, marginBottom: 6,
              background: `linear-gradient(to right, ${VIRIDIS.map((s, i) =>
                `rgb(${Math.round(s[0] * 255)},${Math.round(s[1] * 255)},${Math.round(s[2] * 255)}) ${i * 25}%`
              ).join(', ')})`,
            }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span>{grid.numericRange[0].toFixed(2)}</span>
              <span>{((grid.numericRange[0] + grid.numericRange[1]) / 2).toFixed(2)}</span>
              <span>{grid.numericRange[1].toFixed(2)}</span>
            </div>
          </div>
        )}

        {/* Categorical legend */}
        {grid?.property.type === 'categorical' && (
          <div style={PANEL}>
            <label style={SLABEL}>Legend</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {grid.categories.map((cat, i) => (
                <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                    background: CAT_PALETTE[i % CAT_PALETTE.length],
                  }} />
                  <span style={{ wordBreak: 'break-word' }}>{cat}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Export */}
        {grid && grid.cells.length > 0 && (
          <button
            onClick={exportCsv}
            style={{ width: '100%', background: 'var(--green)', color: '#fff' }}
          >
            Export CSV
          </button>
        )}
      </div>

      {/* ── Three.js canvas ────────────────────────────────────────────────── */}
      <div
        ref={canvasRef}
        style={{ flex: 1, borderRadius: 8, overflow: 'hidden', background: '#1a1f2e', position: 'relative' }}
      >
        {(!grid || grid.cells.length === 0) && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            color: 'rgba(255,255,255,0.3)', fontSize: 14, gap: 10,
            pointerEvents: 'none', userSelect: 'none',
          }}>
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
  );
}
