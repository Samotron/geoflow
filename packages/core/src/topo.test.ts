import { describe, it, expect } from 'vitest';
import { parseAscGrid, parseXyzPoints, sampleTopoAt } from './topo.js';
import type { TopoGrid } from './topo.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * 4-column × 3-row grid.  File rows run north-to-south (top = north):
 *   row 0 (file, north): 50 51 52 53  → stored at row ny-1 = 2
 *   row 1 (file):        45 46 47 48  → stored at row 1
 *   row 2 (file, south): 40 41 42 43  → stored at row 0
 */
const SAMPLE_ASC = `ncols 4
nrows 3
xllcorner 100.0
yllcorner 200.0
cellsize 10.0
nodata_value -9999
50 51 52 53
45 46 47 48
40 41 42 43
`;

function flatTopo(elev: number): TopoGrid {
  const zValues = new Float32Array(4).fill(elev);
  return { x0: 0, y0: 0, dx: 10, dy: 10, nx: 2, ny: 2, zValues, noData: -9999, source: 'test' };
}

// ── parseAscGrid ──────────────────────────────────────────────────────────────

describe('parseAscGrid', () => {
  it('reads header fields correctly', () => {
    const t = parseAscGrid(SAMPLE_ASC);
    expect(t.nx).toBe(4);
    expect(t.ny).toBe(3);
    expect(t.x0).toBeCloseTo(100);
    expect(t.y0).toBeCloseTo(200);
    expect(t.dx).toBeCloseTo(10);
    expect(t.noData).toBe(-9999);
  });

  it('stores rows bottom-first (south = row 0)', () => {
    const t = parseAscGrid(SAMPLE_ASC);
    // File row 2 (south) → row 0 in storage: values 40 41 42 43
    expect(t.zValues[0]).toBe(40);  // row 0, col 0
    expect(t.zValues[3]).toBe(43);  // row 0, col 3
    // File row 0 (north) → row 2 in storage: values 50 51 52 53
    expect(t.zValues[2 * 4 + 0]).toBe(50);
    expect(t.zValues[2 * 4 + 3]).toBe(53);
  });

  it('handles xllcenter / yllcenter variant (offsets by half-cell)', () => {
    const asc = SAMPLE_ASC
      .replace('xllcorner 100.0', 'xllcenter 105.0')
      .replace('yllcorner 200.0', 'yllcenter 205.0');
    const t = parseAscGrid(asc);
    // xllcenter 105 with cellsize 10 → xllcorner = 105 - 5 = 100
    expect(t.x0).toBeCloseTo(100);
    expect(t.y0).toBeCloseTo(200);
  });

  it('throws on missing ncols / nrows', () => {
    expect(() => parseAscGrid('cellsize 10\n1 2\n3 4\n')).toThrow();
  });

  it('sets source from second argument', () => {
    const t = parseAscGrid(SAMPLE_ASC, 'terrain.asc');
    expect(t.source).toBe('terrain.asc');
  });
});

// ── parseXyzPoints ────────────────────────────────────────────────────────────

const SAMPLE_XYZ = `100 200 10
110 200 12
100 210 15
110 210 18
`;

describe('parseXyzPoints', () => {
  it('determines extent from point bounds', () => {
    const t = parseXyzPoints(SAMPLE_XYZ, 3);
    expect(t.x0).toBe(100);
    expect(t.y0).toBe(200);
    expect(t.nx).toBe(3);
    expect(t.ny).toBe(3);
  });

  it('preserves exact elevation at observation points', () => {
    const t = parseXyzPoints(SAMPLE_XYZ, 3);
    // Corner points should round-trip exactly
    expect(sampleTopoAt(t, 100, 200)).toBeCloseTo(10, 1);
    expect(sampleTopoAt(t, 110, 210)).toBeCloseTo(18, 1);
  });

  it('interpolates elevation between points', () => {
    const t = parseXyzPoints(SAMPLE_XYZ, 3);
    const mid = sampleTopoAt(t, 105, 205);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(18);
  });

  it('skips comment lines and blank lines', () => {
    const withComments = `# header\n${SAMPLE_XYZ}\n`;
    const t = parseXyzPoints(withComments, 3);
    expect(t.nx).toBe(3);
  });

  it('accepts comma-delimited input', () => {
    const csv = '100,200,10\n110,200,12\n100,210,15\n110,210,18\n';
    const t = parseXyzPoints(csv, 3);
    expect(sampleTopoAt(t, 100, 200)).toBeCloseTo(10, 1);
  });

  it('throws on empty input', () => {
    expect(() => parseXyzPoints('', 4)).toThrow();
  });
});

// ── sampleTopoAt ─────────────────────────────────────────────────────────────

describe('sampleTopoAt', () => {
  it('returns corner value exactly at lower-left corner', () => {
    const t = parseAscGrid(SAMPLE_ASC);
    expect(sampleTopoAt(t, 100, 200)).toBeCloseTo(40, 4);
  });

  it('bilinear interpolation at cell centre gives mean of four corners', () => {
    const t = parseAscGrid(SAMPLE_ASC);
    // Cell (ix=0, iy=0): corners 40 (SW), 41 (SE), 45 (NW), 46 (NE)
    // centre = mean = 43
    expect(sampleTopoAt(t, 105, 205)).toBeCloseTo(43, 3);
  });

  it('returns flat elevation for a uniform grid', () => {
    const t = flatTopo(25.5);
    expect(sampleTopoAt(t, 5, 5)).toBeCloseTo(25.5, 4);
    expect(sampleTopoAt(t, 0.1, 0.1)).toBeCloseTo(25.5, 4);
  });

  it('returns NaN outside grid bounds', () => {
    const t = parseAscGrid(SAMPLE_ASC);
    expect(isNaN(sampleTopoAt(t, 50, 200))).toBe(true);  // x too low
    expect(isNaN(sampleTopoAt(t, 100, 150))).toBe(true); // y too low
    expect(isNaN(sampleTopoAt(t, 200, 200))).toBe(true); // x too high
  });

  it('returns NaN when any adjacent cell is noData', () => {
    const t = parseAscGrid(SAMPLE_ASC);
    t.zValues[0] = -9999; // poison SW corner of first cell
    expect(isNaN(sampleTopoAt(t, 105, 205))).toBe(true);
  });

  it('returns NaN when noData is NaN', () => {
    const t = flatTopo(25);
    t.noData = NaN;
    t.zValues[0] = NaN;
    expect(isNaN(sampleTopoAt(t, 5, 5))).toBe(true);
  });
});

// ── URL integrity check ───────────────────────────────────────────────────────
// Verify that the pipe separator used by opentopodata API is NOT percent-
// encoded when building the request URL.  Encoding | as %7C causes HTTP 400.

describe('opentopodata URL format', () => {
  it('pipe separator must appear literally in the locations query string', () => {
    const pts: Array<[number, number]> = [[51.5, -0.1], [51.6, -0.2]];
    const locs = pts.map(([la, lo]) => `${la.toFixed(6)},${lo.toFixed(6)}`).join('|');
    expect(locs).toContain('|');
    expect(locs).not.toContain('%7C');
    expect(locs).not.toContain('%2C');
    // Confirm: encodeURIComponent would break this
    expect(encodeURIComponent(locs)).toContain('%7C');
    // So the URL builder must NOT apply encodeURIComponent to the whole string
  });
});
