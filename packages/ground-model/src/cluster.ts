/**
 * cluster.ts — spatial DBSCAN over (LOCA_NATE, LOCA_NATN) for suggesting
 * borehole groupings to inform a ground model.
 *
 * DBSCAN is preferred over k-means because the user doesn't know k upfront
 * and ground-investigation campaigns naturally form irregular clusters with
 * outliers — exactly what DBSCAN handles well.
 *
 * Outputs both the clusters and the noise points (single-borehole holes
 * that didn't reach the density threshold) so the UI can show them as
 * "ungrouped".
 */

export interface LocaPoint {
  locaId: string;
  east: number;
  north: number;
}

export interface ClusterResult {
  /** Each cluster as an array of LOCA_IDs. */
  clusters: string[][];
  /** LOCA_IDs that DBSCAN flagged as noise. */
  noise: string[];
  /** Suggested centroid (E, N) for each cluster, parallel to `clusters`. */
  centroids: Array<{ east: number; north: number }>;
}

export interface DbscanOptions {
  /**
   * Neighbourhood radius in the same units as `east`/`north` (typically m).
   * Default: derived from data spread — 1/6 of the bounding-box diagonal,
   * clamped to [10 m, 250 m].
   */
  epsilon?: number;
  /** Minimum points (incl. self) to form a dense region. Default 2. */
  minPoints?: number;
}

/**
 * Run DBSCAN over an array of LOCA points. Returns the formed clusters plus
 * the noise points and per-cluster centroids.
 *
 * Empty input → empty result. Single-point input → one noise point.
 */
export function clusterLocations(points: LocaPoint[], opts: DbscanOptions = {}): ClusterResult {
  if (points.length === 0) {
    return { clusters: [], noise: [], centroids: [] };
  }
  const minPoints = Math.max(1, opts.minPoints ?? 2);
  const epsilon = opts.epsilon ?? defaultEpsilon(points);

  const n = points.length;
  const labels = new Array<number>(n).fill(-1); // -1 = unvisited, -2 = noise, ≥0 = cluster idx
  let clusterIdx = 0;

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;
    const neighbours = regionQuery(points, i, epsilon);
    if (neighbours.length < minPoints) {
      labels[i] = -2;
      continue;
    }
    labels[i] = clusterIdx;
    const seed = [...neighbours];
    let k = 0;
    while (k < seed.length) {
      const j = seed[k]!;
      if (labels[j] === -2) labels[j] = clusterIdx;
      if (labels[j] === -1) {
        labels[j] = clusterIdx;
        const jn = regionQuery(points, j, epsilon);
        if (jn.length >= minPoints) {
          for (const m of jn) if (!seed.includes(m)) seed.push(m);
        }
      }
      k++;
    }
    clusterIdx++;
  }

  const clusters: string[][] = Array.from({ length: clusterIdx }, () => []);
  const noise: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const lbl = labels[i]!;
    if (lbl >= 0) clusters[lbl]!.push(p.locaId);
    else noise.push(p.locaId);
  }
  const centroids = clusters.map((ids) => {
    const cs = ids.map((id) => points.find((p) => p.locaId === id)!).filter(Boolean);
    const e = cs.reduce((a, p) => a + p.east, 0) / cs.length;
    const n_ = cs.reduce((a, p) => a + p.north, 0) / cs.length;
    return { east: e, north: n_ };
  });

  return { clusters, noise, centroids };
}

function regionQuery(points: LocaPoint[], idx: number, eps: number): number[] {
  const p = points[idx]!;
  const out: number[] = [];
  const eps2 = eps * eps;
  for (let i = 0; i < points.length; i++) {
    const q = points[i]!;
    const dx = q.east - p.east;
    const dy = q.north - p.north;
    if (dx * dx + dy * dy <= eps2) out.push(i);
  }
  return out;
}

function defaultEpsilon(points: LocaPoint[]): number {
  if (points.length < 2) return 50;
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const p of points) {
    if (p.east < minE) minE = p.east;
    if (p.east > maxE) maxE = p.east;
    if (p.north < minN) minN = p.north;
    if (p.north > maxN) maxN = p.north;
  }
  const dx = maxE - minE, dy = maxN - minN;
  const diag = Math.sqrt(dx * dx + dy * dy);
  return Math.min(250, Math.max(10, diag / 6));
}
