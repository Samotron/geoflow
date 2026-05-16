/**
 * Integration tests for the 3-D geological model pipeline.
 *
 * Coverage:
 *   parse AGS bytes → buildGeo3DModel → ThinPlateSurface fitting
 *   → renderBoreholeStripSvg → geometric invariants
 *
 * Key constraints learned from the implementation:
 *   - locaXY() requires both easting AND northing > 0 (BNG validity check)
 *   - renderBoreholeStripSvg height floors at Math.max(10, deepest layer) + 1 m
 *   - buildGeo3DModel reads LOCA_ELEV (not LOCA_GL); absent → 0
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  buildGeo3DModel,
  renderBoreholeStripSvg,
  geolColor,
  geolHatch,
} from "../../packages/core/src/geo3d.js";
import { parseStr } from "../../packages/core/src/index.js";
import type { Borehole3D } from "../../packages/core/src/geo3d.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dirname, "../fixtures/ags");

function parseAgs(text: string) {
  return parseStr(text).file;
}

/** Minimal AGS preamble block. */
const AGS_PROJ = [
  '"GROUP","PROJ"',
  '"HEADING","PROJ_ID"',
  '"UNIT",""',
  '"TYPE","ID"',
  '"DATA","P1"',
  "",
].join("\r\n");

/**
 * 2×2 grid of boreholes, all having CLAY (0–clayBase m) and SAND (clayBase–sandBase m).
 *
 * Eastings:  100 / 200  (both > 0, passes BNG validity check)
 * Northings: 100 / 200  (both > 0)
 * Centroid:  (150, 150)
 * Local coords: (−50,−50), (+50,−50), (−50,+50), (+50,+50)
 * Ground elevation defaults to 0 m (LOCA_ELEV absent).
 */
function makeGridAgs(opts: { clayBase?: number; sandBase?: number } = {}): string {
  const clayBase = opts.clayBase ?? 5;
  const sandBase = opts.sandBase ?? 15;

  const loca = [
    '"GROUP","LOCA"',
    '"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_FDEP"',
    '"UNIT","","m","m","m"',
    '"TYPE","ID","2DP","2DP","2DP"',
    `"DATA","BH01","100.00","100.00","${sandBase.toFixed(2)}"`,
    `"DATA","BH02","200.00","100.00","${sandBase.toFixed(2)}"`,
    `"DATA","BH03","100.00","200.00","${sandBase.toFixed(2)}"`,
    `"DATA","BH04","200.00","200.00","${sandBase.toFixed(2)}"`,
    "",
  ].join("\r\n");

  const geol = [
    '"GROUP","GEOL"',
    '"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"',
    '"UNIT","","m","m",""',
    '"TYPE","ID","2DP","2DP","X"',
    ...["BH01","BH02","BH03","BH04"].flatMap(id => [
      `"DATA","${id}","0.00","${clayBase.toFixed(2)}","CLAY"`,
      `"DATA","${id}","${clayBase.toFixed(2)}","${sandBase.toFixed(2)}","SAND"`,
    ]),
    "",
  ].join("\r\n");

  return [AGS_PROJ, loca, geol].join("\r\n");
}

// ── 1. Real fixture: browser_explorer.ags ────────────────────────────────────

describe("buildGeo3DModel with browser_explorer.ags (real fixture)", () => {
  const file  = parseAgs(readFileSync(join(FIXTURES, "browser_explorer.ags"), "utf8"));
  const model = buildGeo3DModel(file)!;

  it("returns a non-null model", () => {
    expect(model).not.toBeNull();
  });

  it("has exactly 3 boreholes matching LOCA rows", () => {
    expect(model.boreholes).toHaveLength(3);
    expect(model.boreholes.map(b => b.id).sort()).toEqual(["BH01", "BH02", "TP01"]);
  });

  it("centroid is the mean of the three LOCA easting/northing values", () => {
    // BH01=(100,200) BH02=(115,212) TP01=(130,225)
    expect(model.centroid.x).toBeCloseTo((100 + 115 + 130) / 3, 4);
    expect(model.centroid.y).toBeCloseTo((200 + 212 + 225) / 3, 4);
  });

  it("local coordinates sum to zero — centroid invariant", () => {
    const sumX = model.boreholes.reduce((s, b) => s + b.x, 0);
    const sumY = model.boreholes.reduce((s, b) => s + b.y, 0);
    expect(Math.abs(sumX)).toBeLessThan(1e-9);
    expect(Math.abs(sumY)).toBeLessThan(1e-9);
  });

  it("bounds contain every borehole's local position", () => {
    const { xMin, xMax, yMin, yMax } = model.bounds;
    for (const bh of model.boreholes) {
      expect(bh.x).toBeGreaterThanOrEqual(xMin);
      expect(bh.x).toBeLessThanOrEqual(xMax);
      expect(bh.y).toBeGreaterThanOrEqual(yMin);
      expect(bh.y).toBeLessThanOrEqual(yMax);
    }
  });

  it("xMin < xMax and yMin < yMax (non-degenerate extent)", () => {
    expect(model.bounds.xMin).toBeLessThan(model.bounds.xMax);
    expect(model.bounds.yMin).toBeLessThan(model.bounds.yMax);
  });

  it("zMin < zMax (non-degenerate depth range)", () => {
    expect(model.bounds.zMin).toBeLessThan(model.bounds.zMax);
  });

  it("BH01 has 2 GEOL layers, TP01 has 1 layer", () => {
    const bh01 = model.boreholes.find(b => b.id === "BH01")!;
    const tp01 = model.boreholes.find(b => b.id === "TP01")!;
    expect(bh01.layers).toHaveLength(2);
    expect(tp01.layers).toHaveLength(1);
  });

  it("every layer has a valid hex colour", () => {
    for (const bh of model.boreholes) {
      for (const layer of bh.layers) {
        expect(layer.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it("every layer has topDepth < baseDepth", () => {
    for (const bh of model.boreholes) {
      for (const layer of bh.layers) {
        expect(layer.topDepth).toBeLessThan(layer.baseDepth);
      }
    }
  });

  it("topElev = elev − topDepth and baseElev = elev − baseDepth for every layer", () => {
    for (const bh of model.boreholes) {
      for (const layer of bh.layers) {
        expect(layer.topElev).toBeCloseTo(bh.elev - layer.topDepth, 6);
        expect(layer.baseElev).toBeCloseTo(bh.elev - layer.baseDepth, 6);
      }
    }
  });

  it("each unit has a valid hex colour", () => {
    expect(model.units.length).toBeGreaterThan(0);
    for (const unit of model.units) {
      expect(unit.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("surfaces are null for units that appear in fewer than 3 boreholes", () => {
    // Each GEOL description in this fixture appears in exactly one borehole.
    for (const unit of model.units) {
      expect(unit.topSurface).toBeNull();
      expect(unit.baseSurface).toBeNull();
    }
  });
});

// ── 2. Synthetic 4-borehole grid — surface fitting ────────────────────────────

describe("buildGeo3DModel with 4-borehole grid — surface fitting", () => {
  const model = buildGeo3DModel(parseAgs(makeGridAgs()))!;

  it("builds a model with 4 boreholes", () => {
    expect(model.boreholes).toHaveLength(4);
  });

  it("centroid is at (150, 150) — centre of the 100×100 m grid", () => {
    expect(model.centroid.x).toBeCloseTo(150, 6);
    expect(model.centroid.y).toBeCloseTo(150, 6);
  });

  it("CLAY and SAND units are both present", () => {
    const keys = model.units.map(u => u.key);
    expect(keys).toContain("CLAY");
    expect(keys).toContain("SAND");
  });

  it("units with 4 occurrences each have non-null top and base surfaces", () => {
    for (const unit of model.units) {
      expect(unit.topSurface).not.toBeNull();
      expect(unit.baseSurface).not.toBeNull();
    }
  });

  it("CLAY topSurface exactly reproduces control elevations at each borehole", () => {
    // All boreholes: elev=0, CLAY topDepth=0 → topElev=0 everywhere
    const clay = model.units.find(u => u.key === "CLAY")!;
    for (const bh of model.boreholes) {
      expect(clay.topSurface!.evaluate(bh.x, bh.y)).toBeCloseTo(bh.elev, 3);
    }
  });

  it("CLAY baseSurface exactly reproduces control elevations (all −5 m)", () => {
    const clay = model.units.find(u => u.key === "CLAY")!;
    for (const bh of model.boreholes) {
      expect(clay.baseSurface!.evaluate(bh.x, bh.y)).toBeCloseTo(bh.elev - 5, 3);
    }
  });

  it("SAND baseSurface exactly reproduces control elevations (all −15 m)", () => {
    const sand = model.units.find(u => u.key === "SAND")!;
    for (const bh of model.boreholes) {
      expect(sand.baseSurface!.evaluate(bh.x, bh.y)).toBeCloseTo(bh.elev - 15, 3);
    }
  });

  it("CLAY surface evaluates to flat z=0 at the centroid (local origin)", () => {
    const clay = model.units.find(u => u.key === "CLAY")!;
    expect(clay.topSurface!.evaluate(0, 0)).toBeCloseTo(0, 2);
  });

  it("CLAY colour matches geolColor('CLAY')", () => {
    const clay = model.units.find(u => u.key === "CLAY")!;
    expect(clay.color).toBe(geolColor("CLAY"));
  });

  it("CLAY hatch matches geolHatch('CLAY')", () => {
    const clay = model.units.find(u => u.key === "CLAY")!;
    expect(clay.hatch).toBe(geolHatch("CLAY"));
  });
});

// ── 3. ThinPlateSurface methods: evaluateGrid and sampleLine ──────────────────

describe("ThinPlateSurface.evaluateGrid and sampleLine on model surfaces", () => {
  const model = buildGeo3DModel(parseAgs(makeGridAgs()))!;
  const clay  = model.units.find(u => u.key === "CLAY")!;
  const { xMin, xMax, yMin, yMax } = model.bounds;

  it("evaluateGrid returns a Float32Array of the requested size (nx × ny)", () => {
    const grid = clay.topSurface!.evaluateGrid(xMin, xMax, yMin, yMax, 5, 5);
    expect(grid).toBeInstanceOf(Float32Array);
    expect(grid).toHaveLength(25);
  });

  it("evaluateGrid: every cell is a finite number", () => {
    const grid = clay.topSurface!.evaluateGrid(xMin, xMax, yMin, yMax, 8, 8);
    for (const v of grid) {
      expect(isFinite(v)).toBe(true);
    }
  });

  it("evaluateGrid on flat z=0 surface: all values within ±0.1 m of zero", () => {
    const grid = clay.topSurface!.evaluateGrid(xMin, xMax, yMin, yMax, 10, 10);
    for (const v of grid) {
      expect(Math.abs(v)).toBeLessThan(0.1);
    }
  });

  it("evaluateGrid corners agree with pointwise evaluate()", () => {
    const surf = clay.topSurface!;
    const nx = 3; const ny = 3;
    const grid = surf.evaluateGrid(xMin, xMax, yMin, yMax, nx, ny);
    expect(grid[0]).toBeCloseTo(surf.evaluate(xMin, yMin), 3);
    expect(grid[nx - 1]).toBeCloseTo(surf.evaluate(xMax, yMin), 3);
    expect(grid[(ny - 1) * nx]).toBeCloseTo(surf.evaluate(xMin, yMax), 3);
    expect(grid[nx * ny - 1]).toBeCloseTo(surf.evaluate(xMax, yMax), 3);
  });

  it("evaluateGrid on flat z=−5 base surface: all values within ±0.1 m of −5", () => {
    const grid = clay.baseSurface!.evaluateGrid(xMin, xMax, yMin, yMax, 10, 10);
    for (const v of grid) {
      expect(Math.abs(v - (-5))).toBeLessThan(0.1);
    }
  });

  it("sampleLine returns exactly n sample points", () => {
    const pts = clay.topSurface!.sampleLine(xMin, yMin, xMax, yMax, 10);
    expect(pts).toHaveLength(10);
  });

  it("sampleLine: distances are monotonically increasing", () => {
    const pts = clay.topSurface!.sampleLine(xMin, yMin, xMax, yMax, 8);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.dist).toBeGreaterThan(pts[i - 1]!.dist);
    }
  });

  it("sampleLine: first sample has distance 0", () => {
    const pts = clay.topSurface!.sampleLine(xMin, yMin, xMax, yMax, 5);
    expect(pts[0]!.dist).toBeCloseTo(0, 9);
  });

  it("sampleLine: last sample distance equals the line length", () => {
    const pts = clay.topSurface!.sampleLine(xMin, yMin, xMax, yMax, 5);
    const expected = Math.sqrt((xMax - xMin) ** 2 + (yMax - yMin) ** 2);
    expect(pts[pts.length - 1]!.dist).toBeCloseTo(expected, 3);
  });

  it("sampleLine endpoints match evaluate() at the line's start and end coords", () => {
    const surf = clay.topSurface!;
    const pts  = surf.sampleLine(xMin, yMin, xMax, yMax, 5);
    expect(pts[0]!.z).toBeCloseTo(surf.evaluate(xMin, yMin), 3);
    expect(pts[pts.length - 1]!.z).toBeCloseTo(surf.evaluate(xMax, yMax), 3);
  });
});

// ── 4. renderBoreholeStripSvg ─────────────────────────────────────────────────

describe("renderBoreholeStripSvg produces valid SVG", () => {
  // Use real fixture boreholes for content checks
  const file  = parseAgs(readFileSync(join(FIXTURES, "browser_explorer.ags"), "utf8"));
  const model = buildGeo3DModel(file)!;
  const bh01  = model.boreholes.find(b => b.id === "BH01")!;
  const tp01  = model.boreholes.find(b => b.id === "TP01")!;

  // Synthetic boreholes for height-scaling test:
  // deep:    layers to 20 m  → maxDepth = max(10,20)+1 = 21  → height = ceil(21)*14+36 = 330
  // shallow: layers to  3 m  → maxDepth = max(10, 3)+1 = 11  → height = ceil(11)*14+36 = 190
  const deepBh: Borehole3D = {
    id: "DEEP", x: 0, y: 0, elev: 0, finDepth: 20,
    layers: [{
      unitKey: "CLAY", desc: "CLAY",
      topDepth: 0, baseDepth: 20, topElev: 0, baseElev: -20,
      color: geolColor("CLAY"), hatch: geolHatch("CLAY"),
    }],
  };
  const shallowBh: Borehole3D = {
    id: "SHALLOW", x: 0, y: 0, elev: 0, finDepth: 3,
    layers: [{
      unitKey: "TOPSOIL", desc: "TOPSOIL",
      topDepth: 0, baseDepth: 3, topElev: 0, baseElev: -3,
      color: geolColor("TOPSOIL"), hatch: geolHatch("TOPSOIL"),
    }],
  };

  it("returns a string opening with <svg", () => {
    expect(renderBoreholeStripSvg(bh01).trimStart()).toMatch(/^<svg /);
  });

  it("SVG closes with </svg>", () => {
    expect(renderBoreholeStripSvg(bh01).trimEnd()).toMatch(/<\/svg>$/);
  });

  it("SVG embeds the borehole ID", () => {
    expect(renderBoreholeStripSvg(bh01)).toContain("BH01");
    expect(renderBoreholeStripSvg(tp01)).toContain("TP01");
  });

  it("SVG width is the fixed 300 px layout constant", () => {
    expect(renderBoreholeStripSvg(bh01)).toContain('width="300"');
  });

  it("deeper borehole (20 m layers) produces a taller SVG than shallow (3 m layers)", () => {
    const parse = (svg: string) => parseInt(svg.match(/height="(\d+)"/)![1]!, 10);
    expect(parse(renderBoreholeStripSvg(deepBh))).toBeGreaterThan(
      parse(renderBoreholeStripSvg(shallowBh))
    );
  });

  it("SVG contains the geological layer fill colour", () => {
    // BH01: "Brown CLAY with occasional gravel" → geolColor → #7B9EC5
    expect(renderBoreholeStripSvg(bh01)).toContain(geolColor("CLAY"));
  });

  it("SVG contains one <rect> per layer plus header and background rects", () => {
    const svg   = renderBoreholeStripSvg(bh01);
    const rects = (svg.match(/<rect /g) ?? []).length;
    expect(rects).toBeGreaterThanOrEqual(bh01.layers.length + 2);
  });

  it("SVG has a depth tick at 0", () => {
    expect(renderBoreholeStripSvg(bh01)).toContain(">0<");
  });

  it("SVG contains GL elevation reference and unit label", () => {
    const svg = renderBoreholeStripSvg(bh01);
    expect(svg).toContain("GL:");
    expect(svg).toContain("m OD");
  });

  it("borehole with no geological layers renders without throwing", () => {
    const emptyBh: Borehole3D = {
      id: "EMPTY", x: 0, y: 0, elev: 5, finDepth: 10, layers: [],
    };
    expect(() => renderBoreholeStripSvg(emptyBh)).not.toThrow();
    expect(renderBoreholeStripSvg(emptyBh)).toContain("EMPTY");
  });
});

// ── 5. Edge cases ─────────────────────────────────────────────────────────────

describe("buildGeo3DModel edge cases", () => {
  it("returns null for a file with no LOCA group", () => {
    expect(buildGeo3DModel(parseAgs(AGS_PROJ))).toBeNull();
  });

  it("returns null when all LOCA rows lack valid BNG coordinates", () => {
    // Row with no LOCA_NATE/NATN → locaXY returns null
    const ags = [AGS_PROJ,
      '"GROUP","LOCA"',
      '"HEADING","LOCA_ID"',
      '"UNIT",""',
      '"TYPE","ID"',
      '"DATA","BH01"',
      "",
    ].join("\r\n");
    expect(buildGeo3DModel(parseAgs(ags))).toBeNull();
  });

  it("single borehole: model has non-degenerate bounds (padded ±10 m)", () => {
    const ags = [AGS_PROJ,
      '"GROUP","LOCA"',
      '"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_FDEP"',
      '"UNIT","","m","m","m"',
      '"TYPE","ID","2DP","2DP","2DP"',
      '"DATA","BH01","500.00","500.00","10.00"',
      "",
    ].join("\r\n");
    const model = buildGeo3DModel(parseAgs(ags))!;
    expect(model.bounds.xMin).toBeLessThan(model.bounds.xMax);
    expect(model.bounds.yMin).toBeLessThan(model.bounds.yMax);
  });

  it("single borehole: all units have null surfaces (need ≥ 3 points)", () => {
    const ags = [AGS_PROJ,
      '"GROUP","LOCA"',
      '"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_FDEP"',
      '"UNIT","","m","m","m"',
      '"TYPE","ID","2DP","2DP","2DP"',
      '"DATA","BH01","500.00","500.00","10.00"',
      "",
      '"GROUP","GEOL"',
      '"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"',
      '"UNIT","","m","m",""',
      '"TYPE","ID","2DP","2DP","X"',
      '"DATA","BH01","0.00","10.00","CLAY"',
      "",
    ].join("\r\n");
    const model = buildGeo3DModel(parseAgs(ags))!;
    for (const unit of model.units) {
      expect(unit.topSurface).toBeNull();
      expect(unit.baseSurface).toBeNull();
    }
  });

  it("two boreholes: all units have null surfaces (need ≥ 3 points)", () => {
    const ags = [AGS_PROJ,
      '"GROUP","LOCA"',
      '"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_FDEP"',
      '"UNIT","","m","m","m"',
      '"TYPE","ID","2DP","2DP","2DP"',
      '"DATA","BH01","100.00","100.00","10.00"',
      '"DATA","BH02","200.00","100.00","10.00"',
      "",
      '"GROUP","GEOL"',
      '"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"',
      '"UNIT","","m","m",""',
      '"TYPE","ID","2DP","2DP","X"',
      '"DATA","BH01","0.00","10.00","CLAY"',
      '"DATA","BH02","0.00","10.00","CLAY"',
      "",
    ].join("\r\n");
    const model = buildGeo3DModel(parseAgs(ags))!;
    expect(model.boreholes).toHaveLength(2);
    for (const unit of model.units) {
      expect(unit.topSurface).toBeNull();
      expect(unit.baseSurface).toBeNull();
    }
  });

  it("GEOL rows referencing unknown LOCA IDs are silently skipped", () => {
    const ags = [AGS_PROJ,
      '"GROUP","LOCA"',
      '"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_FDEP"',
      '"UNIT","","m","m","m"',
      '"TYPE","ID","2DP","2DP","2DP"',
      '"DATA","BH01","100.00","100.00","10.00"',
      "",
      '"GROUP","GEOL"',
      '"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"',
      '"UNIT","","m","m",""',
      '"TYPE","ID","2DP","2DP","X"',
      '"DATA","BH01","0.00","10.00","CLAY"',
      '"DATA","GHOST","0.00","10.00","CLAY"',
      "",
    ].join("\r\n");
    const model = buildGeo3DModel(parseAgs(ags))!;
    expect(model.boreholes).toHaveLength(1);
    expect(model.boreholes[0]!.layers).toHaveLength(1);
  });

  it("collinear boreholes do not throw (singular matrix caught internally)", () => {
    const ags = [AGS_PROJ,
      '"GROUP","LOCA"',
      '"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_FDEP"',
      '"UNIT","","m","m","m"',
      '"TYPE","ID","2DP","2DP","2DP"',
      '"DATA","BH01","100.00","100.00","10.00"',
      '"DATA","BH02","150.00","100.00","10.00"',
      '"DATA","BH03","200.00","100.00","10.00"',
      "",
      '"GROUP","GEOL"',
      '"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"',
      '"UNIT","","m","m",""',
      '"TYPE","ID","2DP","2DP","X"',
      '"DATA","BH01","0.00","10.00","CLAY"',
      '"DATA","BH02","0.00","10.00","CLAY"',
      '"DATA","BH03","0.00","10.00","CLAY"',
      "",
    ].join("\r\n");
    expect(() => buildGeo3DModel(parseAgs(ags))).not.toThrow();
  });

  it("partial coverage: CLAY in 4 boreholes gets surfaces; GRAVEL in 2 does not", () => {
    const ags = [AGS_PROJ,
      '"GROUP","LOCA"',
      '"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_FDEP"',
      '"UNIT","","m","m","m"',
      '"TYPE","ID","2DP","2DP","2DP"',
      '"DATA","BH01","100.00","100.00","15.00"',
      '"DATA","BH02","200.00","100.00","15.00"',
      '"DATA","BH03","100.00","200.00","15.00"',
      '"DATA","BH04","200.00","200.00","15.00"',
      "",
      '"GROUP","GEOL"',
      '"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"',
      '"UNIT","","m","m",""',
      '"TYPE","ID","2DP","2DP","X"',
      '"DATA","BH01","0.00","5.00","CLAY"',
      '"DATA","BH02","0.00","5.00","CLAY"',
      '"DATA","BH03","0.00","5.00","CLAY"',
      '"DATA","BH04","0.00","5.00","CLAY"',
      '"DATA","BH01","5.00","15.00","GRAVEL"',
      '"DATA","BH02","5.00","15.00","GRAVEL"',
      "",
    ].join("\r\n");
    const model = buildGeo3DModel(parseAgs(ags))!;
    const clay   = model.units.find(u => u.key === "CLAY")!;
    const gravel = model.units.find(u => u.key === "GRAVEL")!;

    expect(clay.topSurface).not.toBeNull();
    expect(gravel.topSurface).toBeNull();
  });
});

// ── 6. Cross-section geometry via sampleLine ──────────────────────────────────

describe("cross-section geometry via sampleLine on the 4-borehole grid", () => {
  const model = buildGeo3DModel(parseAgs(makeGridAgs()))!;
  const clay  = model.units.find(u => u.key === "CLAY")!;
  const sand  = model.units.find(u => u.key === "SAND")!;
  const { xMin, xMax, yMin, yMax } = model.bounds;

  it("section along x-axis at yMin: top surface stays flat at z ≈ 0", () => {
    for (const pt of clay.topSurface!.sampleLine(xMin, yMin, xMax, yMin, 20)) {
      expect(Math.abs(pt.z)).toBeLessThan(0.05);
    }
  });

  it("section along y-axis at xMin: base surface stays flat at z ≈ −5", () => {
    for (const pt of clay.baseSurface!.sampleLine(xMin, yMin, xMin, yMax, 20)) {
      expect(Math.abs(pt.z - (-5))).toBeLessThan(0.05);
    }
  });

  it("diagonal section has strictly increasing distances", () => {
    const pts = clay.topSurface!.sampleLine(xMin, yMin, xMax, yMax, 15);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.dist).toBeGreaterThan(pts[i - 1]!.dist);
    }
  });

  it("top surface is always strictly above base surface along any section", () => {
    const topPts  = clay.topSurface!.sampleLine(xMin, yMin, xMax, yMax, 10);
    const basePts = clay.baseSurface!.sampleLine(xMin, yMin, xMax, yMax, 10);
    for (let i = 0; i < topPts.length; i++) {
      expect(topPts[i]!.z).toBeGreaterThan(basePts[i]!.z);
    }
  });

  it("SAND top surface coincides with CLAY base surface (shared stratigraphic interface)", () => {
    const clayBase = clay.baseSurface!.sampleLine(xMin, yMin, xMax, yMax, 10);
    const sandTop  = sand.topSurface!.sampleLine(xMin, yMin, xMax, yMax, 10);
    for (let i = 0; i < clayBase.length; i++) {
      expect(clayBase[i]!.z).toBeCloseTo(sandTop[i]!.z, 2);
    }
  });
});
