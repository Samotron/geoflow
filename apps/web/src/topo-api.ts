/**
 * topo-api.ts — fetch SRTM 30m elevation data.
 *
 * Samples a 20×20 grid over the model extent (+ 30% margin) and returns
 * a TopoGrid whose coordinates match the model's absolute easting/northing
 * frame.  Supports UK BNG coordinates (auto-detected by range) and
 * WGS84-based sites.
 *
 * Provider chain (each tried in order; on transient failure the next is used):
 *   1. opentopodata.org/srtm30m      — 1 req/s, 100 loc/req, primary
 *   2. open-elevation.com/api/v1     — POST API, more permissive CORS,
 *                                      no per-second rate limit
 *
 * The fallback exists because opentopodata occasionally returns 502/503 or
 * is blocked by browser CORS in certain GitHub Pages deployments.
 */

import proj4 from 'proj4';
import type { Geo3DModel } from '@geoflow/core';
import type { TopoGrid } from './core.js';

// British National Grid
const BNG = '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs';

const GRID_N   = 20;   // 20×20 = 400 sample points
const BATCH    = 100;  // max locations per opentopodata request
const RATE_MS  = 1100; // ≥1 s between requests
const DATASET  = 'srtm30m';
const API_BASE = 'https://api.opentopodata.org/v1';
const FALLBACK_API = 'https://api.open-elevation.com/api/v1/lookup';

export interface FetchTopoProgress { batch: number; total: number }

/**
 * Convert absolute model coordinates (easting/northing) to WGS84 [lat, lon].
 * Detects BNG automatically by range; falls back to equirectangular inversion.
 */
function toLatLon(absX: number, absY: number): [number, number] | null {
  if (absX > 0 && absX < 800000 && absY > 0 && absY < 1400000) {
    try {
      const [lng, lat] = proj4(BNG, 'EPSG:4326', [absX, absY]) as [number, number];
      if (lat >= 49 && lat <= 62 && lng >= -9 && lng <= 3) return [lat, lng];
    } catch { /* not BNG */ }
  }
  // Equirectangular inversion (geo3d.ts fallback for lat/lon sites)
  const lat = absY / 110540;
  const lon = absX / (111320 * Math.cos((lat * Math.PI) / 180));
  if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return [lat, lon];
  return null;
}

/**
 * Build the opentopodata request URL for an array of [lat, lon] pairs.
 * Pipe-separated coordinates must NOT be percent-encoded — the server
 * expects literal `|` and will return HTTP 400 for `%7C`.
 * Lat/lon values contain only digits, `.`, and `-`, so they are safe
 * to include unencoded in a query string.
 */
export function buildTopoUrl(points: Array<[number, number]>, dataset = DATASET): string {
  const locs = points.map(([la, lo]) => `${la.toFixed(6)},${lo.toFixed(6)}`).join('|');
  return `${API_BASE}/${dataset}?locations=${locs}`;
}

async function fetchBatchOpenTopoData(
  points: Array<[number, number]>,
  signal?: AbortSignal,
): Promise<number[]> {
  const url = buildTopoUrl(points);
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`opentopodata HTTP ${res.status}`);
  const json = await res.json() as { status: string; results: { elevation: number | null }[] };
  if (json.status !== 'OK') throw new Error(`opentopodata: ${json.status}`);
  return json.results.map(r => r.elevation ?? NaN);
}

async function fetchBatchOpenElevation(
  points: Array<[number, number]>,
  signal?: AbortSignal,
): Promise<number[]> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations: points.map(([la, lo]) => ({ latitude: la, longitude: lo })) }),
  };
  if (signal) init.signal = signal;
  const res = await fetch(FALLBACK_API, init);
  if (!res.ok) throw new Error(`open-elevation HTTP ${res.status}`);
  const json = await res.json() as { results: { elevation: number | null }[] };
  return json.results.map(r => r.elevation ?? NaN);
}

async function fetchBatch(
  points: Array<[number, number]>,
  signal?: AbortSignal,
): Promise<number[]> {
  try {
    return await fetchBatchOpenTopoData(points, signal);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // Network / CORS / 5xx — try the fallback provider once
    return await fetchBatchOpenElevation(points, signal);
  }
}

/**
 * Fetch a SRTM 30m topo grid from opentopodata.org covering the model
 * extent plus a 30% margin.  Returns null if coordinates cannot be
 * projected to WGS84 (no internet access is also surfaced as an Error).
 *
 * onProgress is called after each completed batch so the UI can show
 * progress.  Pass an AbortSignal to cancel mid-fetch.
 */
export async function fetchTopoGrid(
  model: Geo3DModel,
  onProgress?: (p: FetchTopoProgress) => void,
  signal?: AbortSignal,
): Promise<TopoGrid | null> {
  const { bounds, centroid } = model;

  // Verify centroid is projectable before committing to the fetch
  if (!toLatLon(centroid.x, centroid.y)) return null;

  const mx = (bounds.xMax - bounds.xMin) * 0.30;
  const my = (bounds.yMax - bounds.yMin) * 0.30;
  const lxMin = bounds.xMin - mx, lxMax = bounds.xMax + mx;
  const lyMin = bounds.yMin - my, lyMax = bounds.yMax + my;

  const dx = (lxMax - lxMin) / (GRID_N - 1);
  const dy = (lyMax - lyMin) / (GRID_N - 1);

  // Build ordered list of (ix, iy, lat, lon) — row-major, bottom (south) first
  type GridPt = { lat: number; lon: number };
  const gridPts: GridPt[] = [];
  for (let iy = 0; iy < GRID_N; iy++) {
    for (let ix = 0; ix < GRID_N; ix++) {
      const absX = lxMin + ix * dx + centroid.x;
      const absY = lyMin + iy * dy + centroid.y;
      const ll = toLatLon(absX, absY);
      if (!ll) return null;
      gridPts.push({ lat: ll[0], lon: ll[1] });
    }
  }

  const elevations = new Float32Array(GRID_N * GRID_N).fill(NaN);
  const batches = Math.ceil(gridPts.length / BATCH);

  let usedFallback = false;
  for (let b = 0; b < batches; b++) {
    if (signal?.aborted) throw new DOMException('Fetch cancelled', 'AbortError');
    const chunk = gridPts.slice(b * BATCH, (b + 1) * BATCH);
    let elev: number[];
    try {
      elev = await fetchBatchOpenTopoData(chunk.map(p => [p.lat, p.lon]), signal);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      elev = await fetchBatchOpenElevation(chunk.map(p => [p.lat, p.lon]), signal);
      usedFallback = true;
    }
    for (let i = 0; i < chunk.length; i++) {
      elevations[b * BATCH + i] = elev[i] ?? NaN;
    }
    onProgress?.({ batch: b + 1, total: batches });
    if (b < batches - 1) await new Promise<void>(r => setTimeout(r, RATE_MS));
  }

  return {
    x0: lxMin + centroid.x,
    y0: lyMin + centroid.y,
    dx,
    dy,
    nx: GRID_N,
    ny: GRID_N,
    zValues: elevations,
    noData: NaN,
    source: usedFallback
      ? 'SRTM 30m (open-elevation.com)'
      : 'SRTM 30m (opentopodata.org)',
  };
}
