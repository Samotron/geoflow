/**
 * VoxelTab — geostatistical voxel grid viewer.
 *
 * Layout:
 *   LEFT (300 px)  — property, interpolation method, sliders, build, stats,
 *                    histogram, legend, export
 *   RIGHT (flex 1) — Three.js InstancedMesh voxel renderer + OrbitControls
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  decodeBytes, parseStr, buildGeo3DModel,
  discoverVoxelProperties, buildVoxelGrid, voxelGridToCsv,
} from '../core.js';
import type { AgsFile, VoxelProperty, VoxelGrid, Borehole3D } from '../core.js';

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

/** IDW elevation at (x, y) from borehole ground levels. */
function topoElevAt(x: number, y: number, boreholes: Borehole3D[]): number {
  let wSum = 0, zSum = 0;
  for (const bh of boreholes) {
    const d2 = (bh.x - x) ** 2 + (bh.y - y) ** 2;
    if (d2 < 1e-6) return bh.elev;
    const w = 1 / Math.sqrt(d2);
    wSum += w;
    zSum += w * bh.elev;
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

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  fileBytes: Uint8Array | null;
  fileName?: string | undefined;
}

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
  const opacityRef  = useRef<number>(0.8);
  const bhGroupRef  = useRef<THREE.Group | null>(null);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [selectedPropId, setSelectedPropId] = useState<string>('');
  const [resolution, setResolution]         = useState(20);
  const [opacity, setOpacity]               = useState(0.8);
  const [vExag, setVExag]                   = useState(1);
  const [method, setMethod]                 = useState<'rbf' | 'idw'>('rbf');
  const [lambdaIdx, setLambdaIdx]           = useState(0);
  const [grid, setGrid]                     = useState<VoxelGrid | null>(null);
  const [building, setBuilding]             = useState(false);

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

    // Fit camera to grid bounds
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

  useEffect(() => {
    opacityRef.current = opacity;
    if (meshRef.current) {
      (meshRef.current.material as THREE.MeshLambertMaterial).opacity = opacity;
    }
  }, [opacity]);

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

    // ── Topo surface: IDW-interpolated ground levels ──
    const TOPO_N = 28;
    const tdx = (xMax - xMin) / (TOPO_N - 1);
    const tdy = (yMax - yMin) / (TOPO_N - 1);
    const topoVerts = new Float32Array(TOPO_N * TOPO_N * 3);
    for (let iy = 0; iy < TOPO_N; iy++) {
      for (let ix = 0; ix < TOPO_N; ix++) {
        const wx = xMin + ix * tdx;
        const wy = yMin + iy * tdy;
        const wz = topoElevAt(wx, wy, model.boreholes) * vExag;
        const i3 = (iy * TOPO_N + ix) * 3;
        topoVerts[i3] = wx; topoVerts[i3 + 1] = wy; topoVerts[i3 + 2] = wz;
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
    group.add(new THREE.Mesh(topoGeo, new THREE.MeshPhongMaterial({
      color: 0x6b8f5e, transparent: true, opacity: 0.35,
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

    scene.add(group);
    bhGroupRef.current = group;
  }, [model, vExag]);

  // ── Build ──────────────────────────────────────────────────────────────────
  const buildGrid = useCallback(() => {
    if (!agsFile || !model || !selectedPropId) return;
    const prop = properties.find(p => p.id === selectedPropId);
    if (!prop) return;
    setBuilding(true);
    try {
      const g = buildVoxelGrid(agsFile, model, prop, {
        nx: resolution, ny: resolution, nz: resolution,
        method, lambda,
      });
      setGrid(g);
    } finally {
      setBuilding(false);
    }
  }, [agsFile, model, selectedPropId, properties, resolution, method, lambda]);

  // ── Export ─────────────────────────────────────────────────────────────────
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

  // ── Derived display values ─────────────────────────────────────────────────
  const totalCells = grid ? grid.nx * grid.ny * grid.nz : 0;
  const filledPct  = grid && totalCells > 0
    ? (grid.cells.length / totalCells * 100).toFixed(1) : '0';
  const noFile  = !fileBytes;
  const noModel = fileBytes && !model;
  const canBuild = !!agsFile && !!model && !!selectedPropId && !building;
  const isNumeric = selectedProp?.type === 'numeric';

  // Histogram max count for bar scaling
  const histMax = grid?.stats
    ? Math.max(...grid.stats.histogram.counts, 1)
    : 1;

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 210px)', minHeight: 540 }}>
      {/* ── Left panel ────────────────────────────────────────────────────── */}
      <div style={{ width: 300, flexShrink: 0, overflowY: 'auto' }}>

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

        {/* Interpolation method — only relevant for numeric fields */}
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
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 }}>
                  RBF fits a single 3-D radial basis function through all observations.
                  Higher λ smooths out measurement noise.
                </p>
              </>
            )}
            {method === 'idw' && (
              <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
                IDW weights each borehole by 1/distance at matching depth.
              </p>
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
              ...(model ? [['Boreholes', (() => {
                const elevs = model.boreholes.map(b => b.elev);
                const lo = Math.min(...elevs).toFixed(1), hi = Math.max(...elevs).toFixed(1);
                return `${model.boreholes.length} (GL ${lo}–${hi} m OD)`;
              })()] as [string, string]] : []),
              ...(grid.property.type === 'numeric'
                ? [
                    ['Interp. min', grid.numericRange[0].toFixed(3) + (grid.property.unit ? ' ' + grid.property.unit : '')],
                    ['Interp. max', grid.numericRange[1].toFixed(3) + (grid.property.unit ? ' ' + grid.property.unit : '')],
                  ]
                : [['Categories', String(grid.categories.length)]]),
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} style={ROW}>
                <span style={{ color: 'var(--muted)' }}>{k}</span>
                <span style={{ fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
        )}

        {/* Observation statistics (numeric only) */}
        {grid?.stats && (
          <div style={PANEL}>
            <label style={SLABEL}>
              Observations ({grid.stats.count}){grid.property.unit ? ` — ${grid.property.unit}` : ''}
            </label>
            {([
              ['Mean',  grid.stats.mean.toFixed(3)],
              ['Std',   grid.stats.std.toFixed(3)],
              ['P10',   grid.stats.p10.toFixed(3)],
              ['P50',   grid.stats.p50.toFixed(3)],
              ['P90',   grid.stats.p90.toFixed(3)],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} style={ROW}>
                <span style={{ color: 'var(--muted)' }}>{k}</span>
                <span style={{ fontWeight: 600 }}>{v}</span>
              </div>
            ))}
            {/* Mini histogram */}
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 40 }}>
                {grid.stats.histogram.counts.map((count, i) => (
                  <div
                    key={i}
                    title={`${grid.stats!.histogram.edges[i]?.toFixed(2)} – ${grid.stats!.histogram.edges[i+1]?.toFixed(2)}: ${count}`}
                    style={{
                      flex: 1,
                      height: `${Math.max(2, (count / histMax) * 40)}px`,
                      background: `linear-gradient(to right, ${VIRIDIS_CSS})`,
                      backgroundSize: `${grid.stats!.histogram.counts.length * 100}% 100%`,
                      backgroundPositionX: `${(i / (grid.stats!.histogram.counts.length - 1)) * 100}%`,
                      borderRadius: '2px 2px 0 0',
                      cursor: 'default',
                    }}
                  />
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>
                <span>{grid.stats.histogram.edges[0]?.toFixed(1)}</span>
                <span>{grid.stats.histogram.edges[Math.floor(grid.stats.histogram.edges.length / 2)]?.toFixed(1)}</span>
                <span>{grid.stats.histogram.edges[grid.stats.histogram.edges.length - 1]?.toFixed(1)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Numeric legend */}
        {grid?.property.type === 'numeric' && (
          <div style={PANEL}>
            <label style={SLABEL}>Colour scale{grid.property.unit ? ` (${grid.property.unit})` : ''}</label>
            <div style={{
              height: 14, borderRadius: 4, marginBottom: 5,
              background: `linear-gradient(to right, ${VIRIDIS_CSS})`,
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
                  <div style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0, background: CAT_PALETTE[i % CAT_PALETTE.length] }} />
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
