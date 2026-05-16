import { describe, it, expect } from "vitest";
import { ThinPlateSurface, RbfSurface } from "./rbf.js";
import type { Pt3 } from "./rbf.js";

// ── ThinPlateSurface ──────────────────────────────────────────────────────────

describe("ThinPlateSurface", () => {
  it("throws when fewer than 3 points supplied", () => {
    expect(() => new ThinPlateSurface([])).toThrow("≥ 3 points");
    expect(() => new ThinPlateSurface([{ x: 0, y: 0, z: 1 }])).toThrow();
    expect(() => new ThinPlateSurface([{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 2 }])).toThrow();
  });

  it("interpolates exactly through control points (flat surface)", () => {
    // z = 0 everywhere
    const pts: Pt3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 5, y: 10, z: 0 },
    ];
    const surface = new ThinPlateSurface(pts);
    for (const pt of pts) {
      expect(surface.evaluate(pt.x, pt.y)).toBeCloseTo(0, 4);
    }
  });

  it("interpolates exactly through control points (tilted plane)", () => {
    // z = x + y
    const pts: Pt3[] = [
      { x: 0,  y: 0,  z: 0  },
      { x: 10, y: 0,  z: 10 },
      { x: 0,  y: 10, z: 10 },
    ];
    const surface = new ThinPlateSurface(pts);
    for (const pt of pts) {
      expect(surface.evaluate(pt.x, pt.y)).toBeCloseTo(pt.z, 4);
    }
    // Intermediate point should be interpolated correctly for a linear surface
    expect(surface.evaluate(5, 5)).toBeCloseTo(10, 2);
  });

  it("evaluates non-control points smoothly", () => {
    const pts: Pt3[] = [
      { x: 0,  y: 0,  z: 0  },
      { x: 10, y: 0,  z: 1  },
      { x: 0,  y: 10, z: 1  },
      { x: 10, y: 10, z: 2  },
    ];
    const surface = new ThinPlateSurface(pts);
    // Mid-point should be between min and max z
    const mid = surface.evaluate(5, 5);
    expect(mid).toBeGreaterThan(-0.5);
    expect(mid).toBeLessThan(2.5);
  });

  it("handles more than 3 control points", () => {
    const pts: Pt3[] = [
      { x: 0,   y: 0,   z: 0 },
      { x: 100, y: 0,   z: 5 },
      { x: 0,   y: 100, z: 5 },
      { x: 100, y: 100, z: 10 },
      { x: 50,  y: 50,  z: 5 },
    ];
    const surface = new ThinPlateSurface(pts);
    for (const pt of pts) {
      expect(surface.evaluate(pt.x, pt.y)).toBeCloseTo(pt.z, 2);
    }
  });

  it("handles near-coincident points without throwing", () => {
    // Points very close together — the surface may still solve
    const pts: Pt3[] = [
      { x: 0, y: 0, z: 10 },
      { x: 1e-6, y: 0, z: 10 },
      { x: 0, y: 1e-6, z: 10 },
    ];
    // Should not throw (though numerical precision may be poor)
    expect(() => new ThinPlateSurface(pts)).not.toThrow();
  });

  it("returns a finite value at the interpolation point", () => {
    const pts: Pt3[] = [
      { x: 500, y: 200, z: -2.5 },
      { x: 550, y: 200, z: -3.0 },
      { x: 525, y: 250, z: -2.8 },
    ];
    const surface = new ThinPlateSurface(pts);
    const val = surface.evaluate(520, 220);
    expect(isFinite(val)).toBe(true);
  });

  it("interpolation degrades smoothly away from control points", () => {
    const pts: Pt3[] = [
      { x: 0, y: 0, z: 5 },
      { x: 1, y: 0, z: 5 },
      { x: 0, y: 1, z: 5 },
    ];
    const surface = new ThinPlateSurface(pts);
    // Far from control points, a constant z=5 surface should still give ~5
    expect(surface.evaluate(100, 100)).toBeCloseTo(5, 0);
  });
});

// ── RbfSurface ────────────────────────────────────────────────────────────────

describe("RbfSurface", () => {
  it("throws when fewer than 3 points supplied", () => {
    expect(() => new RbfSurface([])).toThrow("≥ 3 points");
    expect(() => new RbfSurface([{ x: 0, y: 0, z: 1 }])).toThrow();
  });

  it("interpolates exactly through control points with lambda=0 (flat surface)", () => {
    const pts: Pt3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 5, y: 10, z: 0 },
    ];
    const surface = new RbfSurface(pts, 0);
    for (const pt of pts) {
      expect(surface.evaluate(pt.x, pt.y)).toBeCloseTo(0, 3);
    }
  });

  it("interpolates exactly through control points with lambda=0 (tilted plane)", () => {
    const pts: Pt3[] = [
      { x: 0,  y: 0,  z: 0  },
      { x: 10, y: 0,  z: 10 },
      { x: 0,  y: 10, z: 10 },
    ];
    const surface = new RbfSurface(pts, 0);
    for (const pt of pts) {
      expect(surface.evaluate(pt.x, pt.y)).toBeCloseTo(pt.z, 3);
    }
    expect(surface.evaluate(5, 5)).toBeCloseTo(10, 1);
  });

  it("returns finite values for geologically realistic inputs", () => {
    const pts: Pt3[] = [
      { x: 500, y: 200, z: -2.5 },
      { x: 550, y: 200, z: -3.0 },
      { x: 525, y: 250, z: -2.8 },
    ];
    const surface = new RbfSurface(pts);
    expect(isFinite(surface.evaluate(520, 220))).toBe(true);
  });

  it("smooths when lambda > 0 (deviates at a nonlinear bump point)", () => {
    // Four corner points on z = (x+y)/10, plus a bump at centre that breaks linearity
    const pts: Pt3[] = [
      { x: 0,   y: 0,   z: 0  },
      { x: 100, y: 0,   z: 10 },
      { x: 0,   y: 100, z: 10 },
      { x: 100, y: 100, z: 20 },
      { x: 50,  y: 50,  z: 50 }, // bump: z=50 instead of the linear z=10
    ];
    const exact  = new RbfSurface(pts, 0);
    const smooth = new RbfSurface(pts, 1e8); // large λ suppresses the bump
    // Exact must pass through the bump
    expect(exact.evaluate(50, 50)).toBeCloseTo(50, 1);
    // Smoothed surface should pull toward the background trend, deviating noticeably
    expect(smooth.evaluate(50, 50)).toBeLessThan(45);
  });

  it("distToNearest returns 0 at a control point", () => {
    const pts: Pt3[] = [
      { x: 0, y: 0, z: 1 },
      { x: 10, y: 0, z: 2 },
      { x: 5, y: 8, z: 1.5 },
    ];
    const surface = new RbfSurface(pts);
    expect(surface.distToNearest(0, 0)).toBeCloseTo(0, 6);
  });

  it("distToNearest increases with distance from boreholes", () => {
    const pts: Pt3[] = [
      { x: 0, y: 0, z: 1 },
      { x: 10, y: 0, z: 1 },
      { x: 5, y: 10, z: 1 },
    ];
    const surface = new RbfSurface(pts);
    const near = surface.distToNearest(1, 1);
    const far  = surface.distToNearest(100, 100);
    expect(far).toBeGreaterThan(near);
  });

  it("evaluateGrid returns correct dimensions", () => {
    const pts: Pt3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 1 },
      { x: 5, y: 10, z: 0.5 },
    ];
    const surface = new RbfSurface(pts);
    const grid = surface.evaluateGrid(0, 10, 0, 10, 4, 5);
    expect(grid.length).toBe(4 * 5);
  });

  it("sampleLine returns n points along the line", () => {
    const pts: Pt3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 1 },
      { x: 5, y: 10, z: 0.5 },
    ];
    const surface = new RbfSurface(pts);
    const samples = surface.sampleLine(0, 0, 10, 10, 8);
    expect(samples).toHaveLength(8);
    expect(samples[0]!.dist).toBeCloseTo(0, 6);
    expect(samples[7]!.dist).toBeCloseTo(Math.sqrt(200), 4);
  });
});

// ── RbfVolume ─────────────────────────────────────────────────────────────────

import { RbfVolume } from './rbf.js';
import type { Pt4 } from './rbf.js';

describe('RbfVolume', () => {
  // Four corners of a cube + centre — guarantees non-coplanar points
  const cubePts: Pt4[] = [
    { x: 0,   y: 0,   z: 0,   v: 0  },
    { x: 100, y: 0,   z: 0,   v: 10 },
    { x: 0,   y: 100, z: 0,   v: 10 },
    { x: 0,   y: 0,   z: 10,  v: 5  },
    { x: 100, y: 100, z: 10,  v: 20 },
  ];

  it('throws when fewer than 4 points supplied', () => {
    expect(() => new RbfVolume([])).toThrow('≥ 4 points');
    expect(() => new RbfVolume([
      { x: 0, y: 0, z: 0, v: 1 },
      { x: 1, y: 0, z: 0, v: 1 },
      { x: 0, y: 1, z: 0, v: 1 },
    ])).toThrow('≥ 4 points');
  });

  it('interpolates exactly through control points with lambda=0', () => {
    const vol = new RbfVolume(cubePts, 0);
    for (const p of cubePts) {
      expect(vol.evaluate(p.x, p.y, p.z)).toBeCloseTo(p.v, 2);
    }
  });

  it('auto-computes a positive anisotropy when az=0', () => {
    const vol = new RbfVolume(cubePts, 0, 0);
    expect(vol.az).toBeGreaterThan(1);
  });

  it('uses the supplied az when non-zero', () => {
    const vol = new RbfVolume(cubePts, 0, 7);
    expect(vol.az).toBe(7);
  });

  it('returns finite values at arbitrary query points', () => {
    const vol = new RbfVolume(cubePts);
    expect(isFinite(vol.evaluate(50, 50, 5))).toBe(true);
    expect(isFinite(vol.evaluate(-10, 200, -5))).toBe(true);
  });

  it('smoothing lambda>0 deviates from an outlier control point', () => {
    const pts: Pt4[] = [
      { x: 0,   y: 0,   z: 0,  v: 0  },
      { x: 100, y: 0,   z: 0,  v: 10 },
      { x: 0,   y: 100, z: 0,  v: 10 },
      { x: 0,   y: 0,   z: 10, v: 5  },
      { x: 50,  y: 50,  z: 5,  v: 999 }, // extreme outlier
    ];
    const exact  = new RbfVolume(pts, 0);
    const smooth = new RbfVolume(pts, 1e8);
    expect(exact.evaluate(50, 50, 5)).toBeCloseTo(999, 0);
    // Smoothed result must pull strongly away from the outlier
    expect(Math.abs(smooth.evaluate(50, 50, 5))).toBeLessThan(700);
  });

  it('distToNearest returns 0 at a control point', () => {
    const vol = new RbfVolume(cubePts);
    expect(vol.distToNearest(0, 0, 0)).toBeCloseTo(0, 6);
  });

  it('distToNearest is larger far from control points', () => {
    const vol = new RbfVolume(cubePts);
    const near = vol.distToNearest(1, 1, 0);
    const far  = vol.distToNearest(500, 500, 100);
    expect(far).toBeGreaterThan(near);
  });

  it('interpolates a planar field exactly (v = x/10 + y/10 + z)', () => {
    const pts: Pt4[] = [
      { x: 0,   y: 0,   z: 0,  v: 0  },
      { x: 100, y: 0,   z: 0,  v: 10 },
      { x: 0,   y: 100, z: 0,  v: 10 },
      { x: 0,   y: 0,   z: 5,  v: 5  },
      { x: 100, y: 100, z: 5,  v: 25 },
    ];
    const vol = new RbfVolume(pts, 0);
    // Mid-point of a linear field
    expect(vol.evaluate(50, 50, 2.5)).toBeCloseTo(12.5, 1);
  });
});
