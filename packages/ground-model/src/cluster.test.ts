import { describe, expect, it } from 'vitest';
import { clusterLocations } from './cluster.js';

describe('clusterLocations (DBSCAN)', () => {
  it('returns empty on empty input', () => {
    const r = clusterLocations([]);
    expect(r.clusters).toEqual([]);
    expect(r.noise).toEqual([]);
  });

  it('treats a lone point as noise', () => {
    const r = clusterLocations([{ locaId: 'A', east: 0, north: 0 }]);
    expect(r.clusters).toEqual([]);
    expect(r.noise).toEqual(['A']);
  });

  it('groups two tight clusters and flags the outlier', () => {
    const r = clusterLocations(
      [
        // Cluster 1 — tight
        { locaId: 'A', east: 0,   north: 0 },
        { locaId: 'B', east: 5,   north: 5 },
        { locaId: 'C', east: 8,   north: 2 },
        // Cluster 2 — tight, 200 m away
        { locaId: 'D', east: 200, north: 200 },
        { locaId: 'E', east: 205, north: 198 },
        { locaId: 'F', east: 203, north: 207 },
        // Outlier
        { locaId: 'Z', east: 1000, north: 1000 },
      ],
      { epsilon: 30, minPoints: 2 },
    );
    expect(r.clusters).toHaveLength(2);
    const flat = new Set(r.clusters.flat());
    expect(flat.has('A') && flat.has('B') && flat.has('C')).toBe(true);
    expect(flat.has('D') && flat.has('E') && flat.has('F')).toBe(true);
    expect(r.noise).toEqual(['Z']);
  });

  it('computes a centroid for each cluster', () => {
    const r = clusterLocations(
      [
        { locaId: 'A', east: 0,   north: 0 },
        { locaId: 'B', east: 10,  north: 10 },
      ],
      { epsilon: 30, minPoints: 2 },
    );
    expect(r.centroids).toHaveLength(1);
    expect(r.centroids[0]!.east).toBeCloseTo(5);
    expect(r.centroids[0]!.north).toBeCloseTo(5);
  });
});
