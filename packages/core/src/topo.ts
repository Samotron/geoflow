/**
 * topo.ts — topographic surface import and bilinear sampling.
 *
 * Supports:
 *   ESRI ASCII Grid (.asc) — OS Terrain 50/5, SRTM exports, any GIS output
 *   XYZ point cloud (.xyz, .csv) — three columns: x y z
 *
 * The TopoGrid stores elevations in the file's native coordinate system.
 * The caller is responsible for using consistent coordinates when sampling.
 */

export interface TopoGrid {
  /** Lower-left corner in the file's native coordinate system (m). */
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  /**
   * Elevations (m OD), row-major, row 0 = southernmost (y0),
   * row ny-1 = northernmost.
   */
  zValues: Float32Array;
  noData: number;
  source: string;
}

function isNoData(v: number, noData: number): boolean {
  return v === noData || isNaN(v);
}

/**
 * Parse an ESRI ASCII Grid file (.asc).
 *
 * Standard keywords: ncols, nrows, xllcorner / xllcenter,
 * yllcorner / yllcenter, cellsize, nodata_value.
 * Data rows run top-to-bottom (north-to-south) in the file.
 */
export function parseAscGrid(text: string, sourceName = '.asc grid'): TopoGrid {
  const lines = text.split(/\r?\n/);
  const header: Record<string, number> = {};
  let dataStart = 0;

  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const line = lines[i]!.trim();
    if (!line) { dataStart = i + 1; continue; }
    const parts = line.split(/\s+/);
    // Header lines start with a non-numeric keyword
    if (parts.length === 2 && !/^-?\d/.test(parts[0]!)) {
      header[parts[0]!.toLowerCase()] = parseFloat(parts[1]!);
      dataStart = i + 1;
    } else {
      break;
    }
  }

  const ncols    = Math.round(header['ncols']   ?? 0);
  const nrows    = Math.round(header['nrows']   ?? 0);
  const cellsize = header['cellsize']           ?? 1;
  const noData   = header['nodata_value']       ?? -9999;

  const xll = header['xllcorner'] != null
    ? header['xllcorner']!
    : (header['xllcenter'] ?? 0) - cellsize / 2;
  const yll = header['yllcorner'] != null
    ? header['yllcorner']!
    : (header['yllcenter'] ?? 0) - cellsize / 2;

  if (ncols <= 0 || nrows <= 0) {
    throw new Error('Invalid .asc file: missing ncols / nrows in header');
  }

  const zValues = new Float32Array(ncols * nrows);
  // File rows run north-to-south; store south-to-north (row 0 = yll).
  let row = nrows - 1;

  for (let i = dataStart; i < lines.length && row >= 0; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const vals = line.split(/\s+/);
    for (let c = 0; c < ncols; c++) {
      zValues[row * ncols + c] = c < vals.length ? parseFloat(vals[c]!) : noData;
    }
    row--;
  }

  return { x0: xll, y0: yll, dx: cellsize, dy: cellsize, nx: ncols, ny: nrows, zValues, noData, source: sourceName };
}

/**
 * Parse an XYZ point cloud (whitespace- or comma-delimited, columns: x y z).
 * Resamples to a regular gridN × gridN grid using IDW (power 2).
 */
export function parseXyzPoints(text: string, gridN = 60, sourceName = 'XYZ points'): TopoGrid {
  const pts: { x: number; y: number; z: number }[] = [];

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.split(/[\s,]+/);
    if (p.length < 3) continue;
    const x = parseFloat(p[0]!), y = parseFloat(p[1]!), z = parseFloat(p[2]!);
    if (isFinite(x) && isFinite(y) && isFinite(z)) pts.push({ x, y, z });
  }
  if (pts.length === 0) throw new Error('No valid XYZ points found in file');

  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const p of pts) {
    if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
  }

  const dx = (xMax - xMin) / Math.max(gridN - 1, 1);
  const dy = (yMax - yMin) / Math.max(gridN - 1, 1);
  const noData = -9999;
  const zValues = new Float32Array(gridN * gridN);

  for (let iy = 0; iy < gridN; iy++) {
    for (let ix = 0; ix < gridN; ix++) {
      const gx = xMin + ix * dx;
      const gy = yMin + iy * dy;
      let wSum = 0, zSum = 0;
      let exactZ = NaN;
      for (const p of pts) {
        const d2 = (p.x - gx) ** 2 + (p.y - gy) ** 2;
        if (d2 < 1e-8) { exactZ = p.z; break; }
        const w = 1 / d2;
        wSum += w; zSum += w * p.z;
      }
      zValues[iy * gridN + ix] = isNaN(exactZ) ? (wSum > 0 ? zSum / wSum : noData) : exactZ;
    }
  }

  return { x0: xMin, y0: yMin, dx, dy, nx: gridN, ny: gridN, zValues, noData, source: sourceName };
}

/**
 * Sample a TopoGrid at absolute coordinates (x, y) using bilinear interpolation.
 * Returns NaN when the point is outside the grid or adjacent to a noData cell.
 *
 * The coordinate system must match the one used when the grid was built:
 *   - file upload: the file's native CRS (typically BNG for UK files)
 *   - API fetch: absolute easting/northing from the model centroid
 */
export function sampleTopoAt(topo: TopoGrid, x: number, y: number): number {
  const fx = (x - topo.x0) / topo.dx;
  const fy = (y - topo.y0) / topo.dy;

  // Reject out-of-bounds; clamp to last cell so exact far-edge coords work.
  if (fx < 0 || fx > topo.nx - 1 || fy < 0 || fy > topo.ny - 1) return NaN;
  const ix = Math.min(Math.floor(fx), topo.nx - 2);
  const iy = Math.min(Math.floor(fy), topo.ny - 2);

  const tx = fx - ix, ty = fy - iy;
  const z00 = topo.zValues[iy * topo.nx + ix]!;
  const z10 = topo.zValues[iy * topo.nx + ix + 1]!;
  const z01 = topo.zValues[(iy + 1) * topo.nx + ix]!;
  const z11 = topo.zValues[(iy + 1) * topo.nx + ix + 1]!;

  if (isNoData(z00, topo.noData) || isNoData(z10, topo.noData) ||
      isNoData(z01, topo.noData) || isNoData(z11, topo.noData)) return NaN;

  return z00 * (1 - tx) * (1 - ty) + z10 * tx * (1 - ty)
       + z01 * (1 - tx) * ty       + z11 * tx * ty;
}
