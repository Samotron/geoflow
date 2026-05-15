import { describe, it, expect } from "vitest";
import { ThinPlateSurface } from "./rbf.js";
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
