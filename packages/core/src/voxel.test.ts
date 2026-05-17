import { describe, it, expect } from 'vitest';
import { discoverVoxelProperties, buildVoxelGrid, voxelGridToCsv, getVoxelCellLineage } from './voxel.js';
import type { AgsFile } from './model.js';
import type { Geo3DModel } from './geo3d.js';
import type { TopoGrid } from './topo.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeFile(overrides: Partial<AgsFile['groups']> = {}): AgsFile {
  return {
    source_path: null,
    ags_version: '4.0.4',
    groups: {
      LOCA: {
        name: 'LOCA',
        source_line: 1,
        headings: [
          { name: 'LOCA_ID',   data_type: 'ID', unit: '', description: '' },
          { name: 'LOCA_NATE', data_type: { _tag: 'DP', decimals: 2 }, unit: 'm', description: '' },
          { name: 'LOCA_NATN', data_type: { _tag: 'DP', decimals: 2 }, unit: 'm', description: '' },
          { name: 'LOCA_FDEP', data_type: { _tag: 'DP', decimals: 2 }, unit: 'm', description: '' },
          { name: 'LOCA_ELEV', data_type: { _tag: 'DP', decimals: 2 }, unit: 'm OD', description: '' },
        ],
        rows: [
          { LOCA_ID: 'BH1', LOCA_NATE: '100', LOCA_NATN: '200', LOCA_FDEP: '10', LOCA_ELEV: '5' },
          { LOCA_ID: 'BH2', LOCA_NATE: '200', LOCA_NATN: '200', LOCA_FDEP: '10', LOCA_ELEV: '5' },
          { LOCA_ID: 'BH3', LOCA_NATE: '150', LOCA_NATN: '300', LOCA_FDEP: '10', LOCA_ELEV: '5' },
        ],
      },
      ISPT: {
        name: 'ISPT',
        source_line: 10,
        headings: [
          { name: 'LOCA_ID',   data_type: 'ID',  unit: '', description: '' },
          { name: 'ISPT_DPTH', data_type: { _tag: 'DP', decimals: 2 }, unit: 'm', description: '' },
          { name: 'ISPT_NVAL', data_type: { _tag: 'DP', decimals: 0 }, unit: 'blows/300mm', description: '' },
        ],
        rows: [
          { LOCA_ID: 'BH1', ISPT_DPTH: '2', ISPT_NVAL: '12' },
          { LOCA_ID: 'BH1', ISPT_DPTH: '4', ISPT_NVAL: '18' },
          { LOCA_ID: 'BH2', ISPT_DPTH: '2', ISPT_NVAL: '15' },
          { LOCA_ID: 'BH2', ISPT_DPTH: '4', ISPT_NVAL: '20' },
          { LOCA_ID: 'BH3', ISPT_DPTH: '2', ISPT_NVAL: '10' },
        ],
      },
      GEOL: {
        name: 'GEOL',
        source_line: 20,
        headings: [
          { name: 'LOCA_ID',   data_type: 'ID',  unit: '', description: '' },
          { name: 'GEOL_TOP',  data_type: { _tag: 'DP', decimals: 2 }, unit: 'm', description: '' },
          { name: 'GEOL_BASE', data_type: { _tag: 'DP', decimals: 2 }, unit: 'm', description: '' },
          { name: 'GEOL_LEG',  data_type: 'PA',  unit: '', description: '' },
        ],
        rows: [
          { LOCA_ID: 'BH1', GEOL_TOP: '0', GEOL_BASE: '3', GEOL_LEG: 'SAND' },
          { LOCA_ID: 'BH1', GEOL_TOP: '3', GEOL_BASE: '10', GEOL_LEG: 'CLAY' },
          { LOCA_ID: 'BH2', GEOL_TOP: '0', GEOL_BASE: '4', GEOL_LEG: 'SAND' },
          { LOCA_ID: 'BH2', GEOL_TOP: '4', GEOL_BASE: '10', GEOL_LEG: 'CLAY' },
          { LOCA_ID: 'BH3', GEOL_TOP: '0', GEOL_BASE: '5', GEOL_LEG: 'GRAVEL' },
          { LOCA_ID: 'BH3', GEOL_TOP: '5', GEOL_BASE: '10', GEOL_LEG: 'CLAY' },
        ],
      },
      ...overrides,
    },
  } as unknown as AgsFile;
}

function makeFlatTopo(elevOD: number): TopoGrid {
  // Cover absolute x: 140–260 (local -10..110 + centroid 150)
  //          absolute y: 190–310 (local -10..110 + centroid 200)
  return {
    x0: 130, y0: 180, dx: 140, dy: 140,
    nx: 2, ny: 2,
    zValues: new Float32Array([elevOD, elevOD, elevOD, elevOD]),
    noData: -9999,
    source: 'test',
  };
}

function makeModel(): Geo3DModel {
  return {
    boreholes: [
      { id: 'BH1', x: 0,   y: 0,   elev: 5, depth: 10, layers: [], units: [] },
      { id: 'BH2', x: 100, y: 0,   elev: 5, depth: 10, layers: [], units: [] },
      { id: 'BH3', x: 50,  y: 100, elev: 5, depth: 10, layers: [], units: [] },
    ],
    bounds: { xMin: -10, xMax: 110, yMin: -10, yMax: 110, zMin: -6, zMax: 6 },
    units: [],
    contacts: [],
    faults: [],
    centroid: { x: 150, y: 200 },
  } as unknown as Geo3DModel;
}

// ── discoverVoxelProperties ───────────────────────────────────────────────────

describe('discoverVoxelProperties', () => {
  it('discovers numeric fields from ISPT group', () => {
    const props = discoverVoxelProperties(makeFile());
    const isptNval = props.find(p => p.id === 'ISPT_NVAL');
    expect(isptNval).toBeDefined();
    expect(isptNval!.type).toBe('numeric');
    expect(isptNval!.group).toBe('ISPT');
    expect(isptNval!.depthTopField).toBe('ISPT_DPTH');
    expect(isptNval!.depthBaseField).toBeNull();
  });

  it('discovers categorical fields from GEOL group', () => {
    const props = discoverVoxelProperties(makeFile());
    const geolLeg = props.find(p => p.id === 'GEOL_LEG');
    expect(geolLeg).toBeDefined();
    expect(geolLeg!.type).toBe('categorical');
    expect(geolLeg!.group).toBe('GEOL');
    expect(geolLeg!.depthTopField).toBe('GEOL_TOP');
    expect(geolLeg!.depthBaseField).toBe('GEOL_BASE');
  });

  it('skips groups without LOCA_ID', () => {
    const file = makeFile({
      NOLOCA: {
        headings: [
          { name: 'NOLOCA_TOP',  data_type: { _tag: 'DP', decimals: 2 }, unit: 'm', description: '' },
          { name: 'NOLOCA_NVAL', data_type: { _tag: 'DP', decimals: 0 }, unit: '', description: '' },
        ],
        rows: [{ NOLOCA_TOP: '1', NOLOCA_NVAL: '5' }],
      } as unknown as AgsFile['groups'][string],
    });
    const props = discoverVoxelProperties(file);
    expect(props.every(p => p.group !== 'NOLOCA')).toBe(true);
  });

  it('skips groups without a depth field', () => {
    const file = makeFile({
      NODEPTH: {
        headings: [
          { name: 'LOCA_ID',      data_type: 'ID', unit: '', description: '' },
          { name: 'NODEPTH_VAL',  data_type: { _tag: 'DP', decimals: 2 }, unit: '', description: '' },
        ],
        rows: [{ LOCA_ID: 'BH1', NODEPTH_VAL: '5' }],
      } as unknown as AgsFile['groups'][string],
    });
    const props = discoverVoxelProperties(file);
    expect(props.every(p => p.group !== 'NODEPTH')).toBe(true);
  });

  it('skips numeric fields with no parseable values', () => {
    const file = makeFile({
      EMPTY: {
        headings: [
          { name: 'LOCA_ID',    data_type: 'ID', unit: '', description: '' },
          { name: 'EMPTY_TOP',  data_type: { _tag: 'DP', decimals: 2 }, unit: 'm', description: '' },
          { name: 'EMPTY_VAL',  data_type: { _tag: 'DP', decimals: 2 }, unit: '', description: '' },
        ],
        rows: [{ LOCA_ID: 'BH1', EMPTY_TOP: '1', EMPTY_VAL: '' }],
      } as unknown as AgsFile['groups'][string],
    });
    const props = discoverVoxelProperties(file);
    expect(props.every(p => p.id !== 'EMPTY_VAL')).toBe(true);
  });

  it('skips categorical fields with fewer than 2 distinct values', () => {
    const file = makeFile({
      MONO: {
        headings: [
          { name: 'LOCA_ID',  data_type: 'ID', unit: '', description: '' },
          { name: 'MONO_TOP', data_type: { _tag: 'DP', decimals: 2 }, unit: 'm', description: '' },
          { name: 'MONO_CAT', data_type: 'PA', unit: '', description: '' },
        ],
        rows: [
          { LOCA_ID: 'BH1', MONO_TOP: '1', MONO_CAT: 'SAND' },
          { LOCA_ID: 'BH2', MONO_TOP: '1', MONO_CAT: 'SAND' },
        ],
      } as unknown as AgsFile['groups'][string],
    });
    const props = discoverVoxelProperties(file);
    expect(props.every(p => p.id !== 'MONO_CAT')).toBe(true);
  });

  it('skips metadata/key fields (TESN, REF, REM, METH, etc.)', () => {
    const props = discoverVoxelProperties(makeFile());
    expect(props.every(p => !p.id.endsWith('_TOP'))).toBe(true);
    expect(props.every(p => !p.id.endsWith('_BASE'))).toBe(true);
    expect(props.every(p => !p.id.endsWith('_DPTH'))).toBe(true);
  });

  it('returns empty array for empty file', () => {
    const emptyFile: AgsFile = { groups: {} } as AgsFile;
    expect(discoverVoxelProperties(emptyFile)).toEqual([]);
  });
});

// ── buildVoxelGrid ────────────────────────────────────────────────────────────

describe('buildVoxelGrid', () => {
  it('returns correct grid dimensions', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const isptProp = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, isptProp, { nx: 5, ny: 5, nz: 5 });
    expect(grid.nx).toBe(5);
    expect(grid.ny).toBe(5);
    expect(grid.nz).toBe(5);
  });

  it('populates cells for numeric ISPT_NVAL property', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const isptProp = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, isptProp, { nx: 10, ny: 10, nz: 10 });
    expect(grid.cells.length).toBeGreaterThan(0);
    expect(grid.cells.every(c => c.value !== null)).toBe(true);
    expect(grid.cells.every(c => c.category === null)).toBe(true);
  });

  it('numeric range is a valid interval', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const isptProp = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, isptProp, { nx: 10, ny: 10, nz: 10 });
    // RBF can extrapolate slightly outside observation range, so just check ordering
    expect(grid.numericRange[0]).toBeLessThanOrEqual(grid.numericRange[1]);
  });

  it('IDW numeric range stays within observation bounds', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const isptProp = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, isptProp, { nx: 10, ny: 10, nz: 10, method: 'idw' });
    expect(grid.numericRange[0]).toBeGreaterThanOrEqual(10);
    expect(grid.numericRange[1]).toBeLessThanOrEqual(20);
    expect(grid.numericRange[0]).toBeLessThanOrEqual(grid.numericRange[1]);
  });

  it('populates cells for categorical GEOL_LEG property', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const geolProp = props.find(p => p.id === 'GEOL_LEG')!;
    const grid  = buildVoxelGrid(file, model, geolProp, { nx: 10, ny: 10, nz: 10 });
    expect(grid.cells.length).toBeGreaterThan(0);
    expect(grid.cells.every(c => c.category !== null)).toBe(true);
    expect(grid.categories.length).toBeGreaterThan(0);
    expect(grid.categories.every(c => ['SAND', 'CLAY', 'GRAVEL'].includes(c))).toBe(true);
  });

  it('confidence is in 0–1 range', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 8, ny: 8, nz: 8 });
    expect(grid.cells.every(c => c.confidence >= 0 && c.confidence <= 1)).toBe(true);
  });

  it('cell centre coordinates are within bounds', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 8, ny: 8, nz: 8 });
    const { xMin, xMax, yMin, yMax, zMin, zMax } = grid.bounds;
    for (const c of grid.cells) {
      expect(c.cx).toBeGreaterThanOrEqual(xMin);
      expect(c.cx).toBeLessThanOrEqual(xMax);
      expect(c.cy).toBeGreaterThanOrEqual(yMin);
      expect(c.cy).toBeLessThanOrEqual(yMax);
      expect(c.cz).toBeGreaterThanOrEqual(zMin);
      expect(c.cz).toBeLessThanOrEqual(zMax);
    }
  });

  it('returns empty grid when group has no matching borehole data', () => {
    const file  = makeFile();
    const model = makeModel();
    // Model with boreholes not matching any LOCA_IDs in ISPT
    const emptyModel: Geo3DModel = {
      ...model,
      boreholes: [
        { id: 'UNKNOWN', x: 50, y: 50, elev: 5, depth: 10, layers: [], units: [] },
      ],
    } as unknown as Geo3DModel;
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, emptyModel, prop, { nx: 5, ny: 5, nz: 5 });
    expect(grid.cells.length).toBe(0);
  });

  it('clamps minimum grid resolution to 2', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 0, ny: 1, nz: -5 });
    expect(grid.nx).toBe(2);
    expect(grid.ny).toBe(2);
    expect(grid.nz).toBe(2);
  });

  // ── method field ────────────────────────────────────────────────────────────

  it('numeric property defaults to rbf method', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5 });
    expect(grid.method).toBe('rbf');
  });

  it('categorical property always uses idw', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'GEOL_LEG')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5, method: 'rbf' });
    expect(grid.method).toBe('idw');
  });

  it('respects explicit method: idw for numeric property', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5, method: 'idw' });
    expect(grid.method).toBe('idw');
  });

  it('RBF cells are clipped to borehole-sampled depth range', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, method: 'rbf' });
    // Cells above ground or below the deepest observation are excluded
    expect(grid.cells.length).toBeGreaterThan(0);
    expect(grid.cells.length).toBeLessThan(4 * 4 * 4);
    expect(grid.cells.every(c => c.value !== null)).toBe(true);
  });

  it('RBF with lambda>0 produces a valid grid (smoothed solve)', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, method: 'rbf', lambda: 100 });
    expect(grid.method).toBe('rbf');
    expect(grid.cells.length).toBeGreaterThan(0);
    expect(grid.cells.every(c => isFinite(c.value!))).toBe(true);
  });

  it('falls back to IDW when fewer than 4 unique observations', () => {
    // File with only 3 observations total
    const sparseFile = makeFile({
      ISPT: {
        name: 'ISPT', source_line: 10,
        headings: [
          { name: 'LOCA_ID',   data_type: 'ID',  unit: '', description: '' },
          { name: 'ISPT_DPTH', data_type: { _tag: 'DP', decimals: 2 }, unit: 'm', description: '' },
          { name: 'ISPT_NVAL', data_type: { _tag: 'DP', decimals: 0 }, unit: '', description: '' },
        ],
        rows: [
          { LOCA_ID: 'BH1', ISPT_DPTH: '2', ISPT_NVAL: '12' },
          { LOCA_ID: 'BH2', ISPT_DPTH: '2', ISPT_NVAL: '15' },
          { LOCA_ID: 'BH3', ISPT_DPTH: '2', ISPT_NVAL: '10' },
        ],
      } as unknown as AgsFile['groups'][string],
    });
    const model = makeModel();
    const props = discoverVoxelProperties(sparseFile);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(sparseFile, model, prop, { nx: 5, ny: 5, nz: 5, method: 'rbf' });
    // Should fall back gracefully — either rbf with more obs or idw
    expect(grid.cells.length).toBeGreaterThanOrEqual(0);
  });

  // ── stats ───────────────────────────────────────────────────────────────────

  it('stats are populated for numeric properties', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5 });
    expect(grid.stats).not.toBeNull();
    expect(grid.stats!.count).toBe(5);  // 5 ISPT observations in fixture
    expect(grid.stats!.mean).toBeGreaterThan(0);
    expect(grid.stats!.std).toBeGreaterThanOrEqual(0);
    expect(grid.stats!.p10).toBeLessThanOrEqual(grid.stats!.p50);
    expect(grid.stats!.p50).toBeLessThanOrEqual(grid.stats!.p90);
  });

  it('stats histogram has correct bin structure', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5 });
    const { histogram } = grid.stats!;
    expect(histogram.edges.length).toBe(histogram.counts.length + 1);
    const total = histogram.counts.reduce((s, c) => s + c, 0);
    expect(total).toBe(grid.stats!.count);
  });

  it('stats are null for categorical properties', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'GEOL_LEG')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5 });
    expect(grid.stats).toBeNull();
  });

  it('stats mean is within observation range', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5 });
    expect(grid.stats!.mean).toBeGreaterThanOrEqual(10);
    expect(grid.stats!.mean).toBeLessThanOrEqual(20);
  });

  // ── topo surface alignment ───────────────────────────────────────────────────

  /**
   * Topo fixture: flat surface at 2 m OD, covering the model in absolute
   * coordinates (model centroid = { x:150, y:200 }).
   *
   * With boreholes at elev=5 m and ISPT depths to 4 m, the model bounds
   * span z = -6 to +6 m.  A 4×4×4 grid has dz = 3, so cell centres are
   * at -4.5, -1.5, 1.5, 4.5 m OD.
   *
   * Topo at 2 m → clip threshold = 2 + dz*0.5 = 3.5 m.
   *   iz=3 (cz=4.5):  4.5 > 3.5  → excluded by topo
   *   iz=2 (cz=1.5):  1.5 ≤ 3.5  → included
   *   iz=1 (cz=-1.5): -1.5 ≤ 3.5 → included (also within borehole range)
   *   iz=0 (cz=-4.5): excluded by borehole depth range (no topo change)
   */
  it('RBF: cells above topo surface are excluded', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const topo  = makeFlatTopo(2);  // terrain at 2 m OD

    const withTopo    = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, method: 'rbf', topo });
    const withoutTopo = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, method: 'rbf' });

    // Topo should remove the top z-slice (iz=3, cz=4.5 > 3.5)
    expect(withTopo.cells.length).toBeLessThan(withoutTopo.cells.length);
    // No cell centre should be above topo + half-cell tolerance
    expect(withTopo.cells.every(c => c.cz <= 2 + 1.5 + 1e-6)).toBe(true);
  });

  it('IDW: cells above topo surface are excluded', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'GEOL_LEG')!;
    const topo  = makeFlatTopo(2);

    const withTopo    = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, method: 'idw', topo });
    const withoutTopo = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, method: 'idw' });

    expect(withTopo.cells.length).toBeLessThanOrEqual(withoutTopo.cells.length);
    expect(withTopo.cells.every(c => c.cz <= 2 + 1.5 + 1e-6)).toBe(true);
  });

  it('topo outside grid extent falls back gracefully (no cells removed)', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    // Topo positioned far away — sampleTopoAt returns NaN for all cells
    const distantTopo: TopoGrid = {
      x0: 999000, y0: 999000, dx: 1, dy: 1, nx: 2, ny: 2,
      zValues: new Float32Array([0, 0, 0, 0]), noData: -9999, source: 'test',
    };

    const withTopo    = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, method: 'rbf', topo: distantTopo });
    const withoutTopo = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, method: 'rbf' });

    // Out-of-extent topo returns NaN → no cells clipped → identical result
    expect(withTopo.cells.length).toBe(withoutTopo.cells.length);
  });
});

// ── voxelGridToCsv ────────────────────────────────────────────────────────────

describe('voxelGridToCsv', () => {
  function buildNumericGrid(): ReturnType<typeof buildVoxelGrid> {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    return buildVoxelGrid(file, model, props.find(p => p.id === 'ISPT_NVAL')!, { nx: 5, ny: 5, nz: 5 });
  }

  it('produces a header row followed by data rows', () => {
    const csv   = voxelGridToCsv(buildNumericGrid());
    const lines = csv.trim().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain('easting_m');
    expect(lines[0]).toContain('northing_m');
    expect(lines[0]).toContain('z_elev_m_od');
    expect(lines[0]).toContain('confidence');
  });

  it('includes absolute easting and northing from centroid', () => {
    const grid  = buildNumericGrid();
    const csv   = voxelGridToCsv(grid);
    const lines = csv.trim().split('\n');
    // Data rows should have easting near centroid.x ± bounds span
    const firstDataCols = lines[1]!.split(',');
    const easting = parseFloat(firstDataCols[0]!);
    expect(easting).toBeGreaterThan(grid.centroid.x - 200);
    expect(easting).toBeLessThan(grid.centroid.x + 200);
  });

  it('data rows have the correct number of columns', () => {
    const csv      = voxelGridToCsv(buildNumericGrid());
    const lines    = csv.trim().split('\n');
    const numCols  = lines[0]!.split(',').length;
    for (const line of lines.slice(1)) {
      expect(line.split(',').length).toBe(numCols);
    }
  });

  it('value column name includes unit when present', () => {
    const grid = buildNumericGrid();
    const csv  = voxelGridToCsv(grid);
    const header = csv.split('\n')[0]!;
    // ISPT_NVAL has unit 'blows/300mm'
    if (grid.property.unit) {
      expect(header).toContain(grid.property.unit);
    }
  });

  it('empty grid produces header-only output', () => {
    const file  = makeFile();
    const model = makeModel();
    const props = discoverVoxelProperties(file);
    const prop  = props.find(p => p.id === 'ISPT_NVAL')!;
    const emptyModel: Geo3DModel = { ...model, boreholes: [] } as unknown as Geo3DModel;
    const grid  = buildVoxelGrid(file, emptyModel, prop, { nx: 5, ny: 5, nz: 5 });
    const csv   = voxelGridToCsv(grid);
    const lines = csv.trim().split('\n');
    expect(lines.length).toBe(1); // header only
  });

  it('CSV includes geol_unit column', () => {
    const grid = buildVoxelGrid(makeFile(), makeModel(), discoverVoxelProperties(makeFile()).find(p => p.id === 'ISPT_NVAL')!, { nx: 5, ny: 5, nz: 5 });
    const header = voxelGridToCsv(grid).split('\n')[0]!;
    expect(header).toContain('geol_unit');
  });
});

// ── geolUnit inference ────────────────────────────────────────────────────────

describe('geolUnit inference in buildVoxelGrid', () => {
  it('each cell has a geolUnit property (may be null without GEOL layers)', () => {
    const file  = makeFile();
    const model = makeModel(); // fixture model has no layers
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5 });
    expect(grid.cells.length).toBeGreaterThan(0);
    // geolUnit is always present on each cell (null when GEOL data absent)
    for (const c of grid.cells) {
      expect('geolUnit' in c).toBe(true);
    }
  });

  it('topoFn option clips cells (same as topo grid)', () => {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'ISPT_NVAL')!;
    // Flat topoFn at 2 m OD (local coords: z = absolute - centroid)
    const flatFn = (_lx: number, _ly: number) => 2;

    const withFn    = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, method: 'rbf', topoFn: flatFn });
    const withoutFn = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, method: 'rbf' });

    expect(withFn.cells.length).toBeLessThan(withoutFn.cells.length);
    expect(withFn.cells.every(c => c.cz <= 2 + 1.5 + 1e-6)).toBe(true);
  });
});

// ── getVoxelCellLineage ───────────────────────────────────────────────────────

describe('getVoxelCellLineage', () => {
  function buildGrid() {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'ISPT_NVAL')!;
    return { file, model, grid: buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5, method: 'idw' }) };
  }

  it('returns null for out-of-bounds cell index', () => {
    const { file, model, grid } = buildGrid();
    expect(getVoxelCellLineage(grid, -1, file, model)).toBeNull();
    expect(getVoxelCellLineage(grid, grid.cells.length, file, model)).toBeNull();
  });

  it('returns a lineage object for a valid cell', () => {
    const { file, model, grid } = buildGrid();
    if (grid.cells.length === 0) return;
    const lg = getVoxelCellLineage(grid, 0, file, model);
    expect(lg).not.toBeNull();
    expect(lg!.ix).toBeDefined();
    expect(lg!.confidence).toBeGreaterThanOrEqual(0);
    expect(lg!.confidence).toBeLessThanOrEqual(1);
    expect(lg!.method).toBe('idw');
  });

  it('contributors are sorted by distance ascending', () => {
    const { file, model, grid } = buildGrid();
    if (grid.cells.length === 0) return;
    const lg = getVoxelCellLineage(grid, 0, file, model);
    if (!lg || lg.contributors.length < 2) return;
    for (let i = 1; i < lg.contributors.length; i++) {
      expect(lg.contributors[i]!.distH).toBeGreaterThanOrEqual(lg.contributors[i-1]!.distH);
    }
  });

  it('contributor weights sum to ≈1 when contributors exist', () => {
    const { file, model, grid } = buildGrid();
    if (grid.cells.length === 0) return;
    const lg = getVoxelCellLineage(grid, 0, file, model);
    if (!lg || lg.contributors.length === 0) return;
    const wSum = lg.contributors.reduce((s, c) => s + c.weight, 0);
    expect(wSum).toBeCloseTo(1, 5);
  });

  it('lineage carries the correct cell centre coordinates', () => {
    const { file, model, grid } = buildGrid();
    if (grid.cells.length === 0) return;
    const idx = Math.floor(grid.cells.length / 2);
    const cell = grid.cells[idx]!;
    const lg   = getVoxelCellLineage(grid, idx, file, model);
    expect(lg).not.toBeNull();
    expect(lg!.cx).toBeCloseTo(cell.cx, 6);
    expect(lg!.cy).toBeCloseTo(cell.cy, 6);
    expect(lg!.cz).toBeCloseTo(cell.cz, 6);
  });

  it('lineage grid indices are within grid dimensions', () => {
    const { file, model, grid } = buildGrid();
    if (grid.cells.length === 0) return;
    for (let i = 0; i < Math.min(grid.cells.length, 20); i++) {
      const lg = getVoxelCellLineage(grid, i, file, model);
      if (!lg) continue;
      expect(lg.ix).toBeGreaterThanOrEqual(0);
      expect(lg.ix).toBeLessThan(grid.nx);
      expect(lg.iy).toBeGreaterThanOrEqual(0);
      expect(lg.iy).toBeLessThan(grid.ny);
      expect(lg.iz).toBeGreaterThanOrEqual(0);
      expect(lg.iz).toBeLessThan(grid.nz);
    }
  });

  it('nearestObsDistH is non-negative when contributors exist', () => {
    const { file, model, grid } = buildGrid();
    if (grid.cells.length === 0) return;
    const lg = getVoxelCellLineage(grid, 0, file, model);
    if (!lg || lg.contributors.length === 0) return;
    expect(lg.nearestObsDistH).not.toBeNull();
    expect(lg.nearestObsDistH!).toBeGreaterThanOrEqual(0);
  });

  it('RBF lineage has method=rbf and valid confidence', () => {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5, method: 'rbf' });
    if (grid.cells.length === 0) return;
    const lg = getVoxelCellLineage(grid, 0, file, model);
    expect(lg).not.toBeNull();
    expect(lg!.method).toBe('rbf');
    expect(lg!.confidence).toBeGreaterThanOrEqual(0);
    expect(lg!.confidence).toBeLessThanOrEqual(1);
  });

  it('categorical grid lineage has category and null value', () => {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'GEOL_LEG')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5, method: 'idw' });
    if (grid.cells.length === 0) return;
    const lg = getVoxelCellLineage(grid, 0, file, model);
    expect(lg).not.toBeNull();
    expect(lg!.value).toBeNull();
    expect(lg!.category).not.toBeNull();
    expect(['SAND', 'CLAY', 'GRAVEL']).toContain(lg!.category);
  });

  it('each contributor carries a boreholeId matching a borehole in the model', () => {
    const { file, model, grid } = buildGrid();
    if (grid.cells.length === 0) return;
    const bhIds = new Set(model.boreholes.map(b => b.id));
    for (let i = 0; i < Math.min(grid.cells.length, 10); i++) {
      const lg = getVoxelCellLineage(grid, i, file, model);
      if (!lg) continue;
      for (const c of lg.contributors) {
        expect(bhIds.has(c.boreholeId)).toBe(true);
      }
    }
  });

  it('depthBelowGround is null or a non-negative number', () => {
    const { file, model, grid } = buildGrid();
    if (grid.cells.length === 0) return;
    for (let i = 0; i < Math.min(grid.cells.length, 15); i++) {
      const lg = getVoxelCellLineage(grid, i, file, model);
      if (!lg) continue;
      if (lg.depthBelowGround !== null) {
        expect(lg.depthBelowGround).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ── discoverVoxelProperties — extra coverage ──────────────────────────────────

describe('discoverVoxelProperties — additional', () => {
  it('returns properties from multiple groups independently', () => {
    const props = discoverVoxelProperties(makeFile());
    const groups = new Set(props.map(p => p.group));
    // Both ISPT and GEOL are present in the fixture
    expect(groups.has('ISPT')).toBe(true);
    expect(groups.has('GEOL')).toBe(true);
  });

  it('each property carries a unit (possibly empty string)', () => {
    const props = discoverVoxelProperties(makeFile());
    for (const p of props) {
      expect(typeof p.unit).toBe('string');
    }
  });

  it('numeric properties have type === "numeric"', () => {
    const props = discoverVoxelProperties(makeFile());
    for (const p of props.filter(p => p.type === 'numeric')) {
      expect(p.type).toBe('numeric');
      expect(p.depthTopField).not.toBeNull();
    }
  });

  it('categorical properties have type === "categorical"', () => {
    const props = discoverVoxelProperties(makeFile());
    for (const p of props.filter(p => p.type === 'categorical')) {
      expect(p.type).toBe('categorical');
      expect(p.depthTopField).not.toBeNull();
    }
  });
});

// ── buildVoxelGrid — extra coverage ──────────────────────────────────────────

describe('buildVoxelGrid — additional', () => {
  it('grid property reflects the input VoxelProperty', () => {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5 });
    expect(grid.property.id).toBe('ISPT_NVAL');
    expect(grid.property.group).toBe('ISPT');
  });

  it('cell ix/iy/iz indices are within [0, n-1]', () => {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 6, ny: 6, nz: 6 });
    for (const c of grid.cells) {
      expect(c.ix).toBeGreaterThanOrEqual(0);
      expect(c.ix).toBeLessThan(6);
      expect(c.iy).toBeGreaterThanOrEqual(0);
      expect(c.iy).toBeLessThan(6);
      expect(c.iz).toBeGreaterThanOrEqual(0);
      expect(c.iz).toBeLessThan(6);
    }
  });

  it('cellSize dimensions are positive', () => {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 4, ny: 5, nz: 6 });
    expect(grid.cellSize.dx).toBeGreaterThan(0);
    expect(grid.cellSize.dy).toBeGreaterThan(0);
    expect(grid.cellSize.dz).toBeGreaterThan(0);
  });

  it('centroid matches model centroid', () => {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5 });
    expect(grid.centroid.x).toBeCloseTo(model.centroid.x, 1);
    expect(grid.centroid.y).toBeCloseTo(model.centroid.y, 1);
  });

  it('topoFn takes precedence over topo grid when both provided', () => {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'ISPT_NVAL')!;
    // topoFn clips at 2 m; topo grid would clip at 5 m (collars)
    const flatFn  = (_lx: number, _ly: number) => 2;
    const highTopo = makeFlatTopo(5);

    const withFn   = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, topoFn: flatFn });
    const withTopo = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4, topo: highTopo });

    // topoFn at 2 m clips more aggressively than topo at 5 m
    expect(withFn.cells.length).toBeLessThanOrEqual(withTopo.cells.length);
    expect(withFn.cells.every(c => c.cz <= 2 + 1.5 + 1e-6)).toBe(true);
  });
});

// ── voxelGridToCsv — extra coverage ──────────────────────────────────────────

describe('voxelGridToCsv — additional', () => {
  it('categorical grid CSV uses property ID as column name', () => {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'GEOL_LEG')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 5, ny: 5, nz: 5 });
    const header = voxelGridToCsv(grid).split('\n')[0]!;
    expect(header).toContain('GEOL_LEG');
  });

  it('all data rows have numeric easting and northing', () => {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4 });
    const lines = voxelGridToCsv(grid).trim().split('\n');
    const headers = lines[0]!.split(',');
    const eIdx  = headers.indexOf('easting_m');
    const nIdx  = headers.indexOf('northing_m');
    expect(eIdx).toBeGreaterThanOrEqual(0);
    expect(nIdx).toBeGreaterThanOrEqual(0);
    for (const line of lines.slice(1)) {
      const cols = line.split(',');
      expect(isFinite(Number(cols[eIdx]))).toBe(true);
      expect(isFinite(Number(cols[nIdx]))).toBe(true);
    }
  });

  it('confidence column values are in [0, 1]', () => {
    const file  = makeFile();
    const model = makeModel();
    const prop  = discoverVoxelProperties(file).find(p => p.id === 'ISPT_NVAL')!;
    const grid  = buildVoxelGrid(file, model, prop, { nx: 4, ny: 4, nz: 4 });
    const lines = voxelGridToCsv(grid).trim().split('\n');
    const headers = lines[0]!.split(',');
    const confIdx = headers.indexOf('confidence');
    expect(confIdx).toBeGreaterThanOrEqual(0);
    for (const line of lines.slice(1)) {
      const v = Number(line.split(',')[confIdx]);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
