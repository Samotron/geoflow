import { describe, expect, it } from "vitest";
import {
  buildSectionData,
  renderCrossSectionSvg,
  extractSectionPolygons,
  suggestSvgHeight,
} from "./cross-section.js";
import { geolHatch } from "./geo3d.js";
import type { Geo3DModel, Borehole3D } from "./geo3d.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeBh(
  id: string,
  x: number,
  y: number,
  elev: number,
  layers: Array<{ key: string; desc: string; top: number; base: number; color?: string }>,
): Borehole3D {
  const finDepth = Math.max(...layers.map(l => l.base));
  return {
    id, x, y, elev, finDepth,
    layers: layers.map(l => ({
      unitKey: l.key,
      desc: l.desc,
      topDepth: l.top,
      baseDepth: l.base,
      topElev: elev - l.top,
      baseElev: elev - l.base,
      color: l.color ?? "#cccccc",
      hatch: geolHatch(l.desc),
    })),
  };
}

function makeModel(): Geo3DModel {
  // Three boreholes along an E-W line, evenly spaced 50 m apart.
  // All have TOPSOIL over CLAY; BH2 has a thinner clay layer.
  const boreholes = [
    makeBh("BH01", 0,   0, 100, [
      { key: "TOPS", desc: "TOPSOIL",    top: 0,   base: 1.0, color: "#5C7A3E" },
      { key: "CLAY", desc: "Brown CLAY", top: 1.0, base: 12.0, color: "#7B9EC5" },
    ]),
    makeBh("BH02", 50,  0,  98, [
      { key: "TOPS", desc: "TOPSOIL",    top: 0,   base: 0.5, color: "#5C7A3E" },
      { key: "CLAY", desc: "Brown CLAY", top: 0.5, base: 8.0, color: "#7B9EC5" },
    ]),
    makeBh("BH03", 100, 0,  95, [
      { key: "TOPS", desc: "TOPSOIL",    top: 0,   base: 0.8, color: "#5C7A3E" },
      { key: "CLAY", desc: "Brown CLAY", top: 0.8, base: 10.0, color: "#7B9EC5" },
    ]),
  ];
  return {
    boreholes,
    units: [],
    contacts: [],
    faults: [],
    bounds: { xMin: 0, xMax: 100, yMin: 0, yMax: 0, zMin: 85, zMax: 100 },
    centroid: { x: 0, y: 0 },
  };
}

// ── buildSectionData ──────────────────────────────────────────────────────────

describe("buildSectionData", () => {
  it("projects boreholes onto the section polyline in chainage order", () => {
    const model = makeModel();
    const data = buildSectionData(model, ["BH01", "BH02", "BH03"]);
    expect(data).not.toBeNull();
    expect(data!.boreholes.map(b => b.id)).toEqual(["BH01", "BH02", "BH03"]);
    expect(data!.boreholes[0]!.chainage).toBeCloseTo(0, 5);
    expect(data!.boreholes[1]!.chainage).toBeCloseTo(50, 5);
    expect(data!.boreholes[2]!.chainage).toBeCloseTo(100, 5);
    expect(data!.totalLength).toBeCloseTo(100, 5);
  });

  it("sorts boreholes by chainage when supplied out of order", () => {
    const model = makeModel();
    const data = buildSectionData(model, ["BH03", "BH01", "BH02"]);
    expect(data).not.toBeNull();
    // Polyline = BH03 → BH01 → BH02, but boreholes get sorted by chainage
    // along that polyline. BH03 is at chainage 0, BH01 at 100, BH02 along the
    // way back — exact values depend on the polyline projection.
    const cs = data!.boreholes.map(b => b.chainage);
    for (let i = 1; i < cs.length; i++) {
      expect(cs[i]!).toBeGreaterThanOrEqual(cs[i - 1]!);
    }
  });

  it("computes correct elevation extents", () => {
    const model = makeModel();
    const data = buildSectionData(model, ["BH01", "BH02", "BH03"]);
    expect(data).not.toBeNull();
    expect(data!.elevMax).toBeCloseTo(100, 5);
    // Deepest base elev across the three holes: BH03 (95) − 10 m = 85
    expect(data!.elevMin).toBeCloseTo(85, 5);
  });

  it("returns null for fewer than two boreholes", () => {
    const model = makeModel();
    expect(buildSectionData(model, [])).toBeNull();
    expect(buildSectionData(model, ["BH01"])).toBeNull();
    expect(buildSectionData(model, ["UNKNOWN", "ALSO_UNKNOWN"])).toBeNull();
  });

  it("computes signed perpendicular offset for off-line boreholes", () => {
    const model = makeModel();
    // Add a fourth BH off the line at y=30
    model.boreholes.push(makeBh("BH04", 50, 30, 97, [
      { key: "TOPS", desc: "TOPSOIL", top: 0, base: 1, color: "#5C7A3E" },
    ]));
    const data = buildSectionData(model, ["BH01", "BH03", "BH04"]);
    expect(data).not.toBeNull();
    const bh04 = data!.boreholes.find(b => b.id === "BH04");
    expect(bh04).toBeDefined();
    // BH04 lies 30 m off the BH01-BH03 line — but the polyline goes
    // BH01 → BH03 → BH04, so BH04 is at the polyline end (offset = 0).
    // With just BH01/BH03 as polyline endpoints (custom polyline test):
    const data2 = buildSectionData(model, ["BH01", "BH03", "BH04"], [
      { x: 0, y: 0 }, { x: 100, y: 0 },
    ]);
    const bh04b = data2!.boreholes.find(b => b.id === "BH04");
    expect(bh04b).toBeDefined();
    expect(Math.abs(bh04b!.offset)).toBeCloseTo(30, 1);
  });
});

// ── renderCrossSectionSvg ─────────────────────────────────────────────────────

describe("renderCrossSectionSvg", () => {
  it("returns an SVG containing all selected boreholes", () => {
    const model = makeModel();
    const svg = renderCrossSectionSvg(model, ["BH01", "BH02", "BH03"]);
    expect(svg).toMatch(/<svg/);
    expect(svg).toMatch(/BH01/);
    expect(svg).toMatch(/BH02/);
    expect(svg).toMatch(/BH03/);
    expect(svg).toMatch(/Chainage/);
    expect(svg).toMatch(/Elevation/);
    expect(svg).toMatch(/<\/svg>/);
  });

  it("contains a legend when showLegend is true", () => {
    const model = makeModel();
    const svg = renderCrossSectionSvg(model, ["BH01", "BH02"], { showLegend: true });
    expect(svg).toMatch(/Stratigraphy/);
  });

  it("omits the legend when showLegend is false", () => {
    const model = makeModel();
    const svg = renderCrossSectionSvg(model, ["BH01", "BH02"], { showLegend: false });
    expect(svg).not.toMatch(/>Stratigraphy</);
  });

  it("renders hatch patterns when showHatch is true", () => {
    const model = makeModel();
    const svg = renderCrossSectionSvg(model, ["BH01", "BH02", "BH03"], { showHatch: true });
    // CLAY description in fixture → gfx-clay pattern referenced
    expect(svg).toMatch(/url\(#gfx-clay\)/);
  });

  it("omits hatch fills when showHatch is false", () => {
    const model = makeModel();
    const svg = renderCrossSectionSvg(model, ["BH01", "BH02", "BH03"], { showHatch: false });
    expect(svg).not.toMatch(/url\(#gfx-clay\)/);
  });

  it("includes A-A' direction labels by default", () => {
    const model = makeModel();
    const svg = renderCrossSectionSvg(model, ["BH01", "BH02", "BH03"]);
    expect(svg).toMatch(/>A</);
    expect(svg).toMatch(/A′/);
  });

  it("respects custom start/end labels", () => {
    const model = makeModel();
    const svg = renderCrossSectionSvg(model, ["BH01", "BH02"], { startLabel: "B", endLabel: "B′" });
    expect(svg).toMatch(/>B</);
    expect(svg).toMatch(/B′/);
  });

  it("renders smooth-interpolation polygons with more points than observations", () => {
    const model = makeModel();
    const svg = renderCrossSectionSvg(model, ["BH01", "BH02", "BH03"], { interpolation: "smooth" });
    // Find the first polygon's points list and count comma-separated coords
    const m = svg.match(/<polygon class="gfx-unit"[^>]*points="([^"]+)"/);
    expect(m).not.toBeNull();
    const nPts = m![1]!.split(/\s+/).length;
    // Smooth densification should produce far more than 6 vertices (3 obs × 2 edges)
    expect(nPts).toBeGreaterThan(20);
  });

  it("renders sparse linear polygons when smoothing is disabled", () => {
    const model = makeModel();
    const svg = renderCrossSectionSvg(model, ["BH01", "BH02", "BH03"], { interpolation: "linear-chainage" });
    const m = svg.match(/<polygon class="gfx-unit"[^>]*points="([^"]+)"/);
    expect(m).not.toBeNull();
    const nPts = m![1]!.split(/\s+/).length;
    // 3 obs × 2 edges = 6 vertices, no densification
    expect(nPts).toBeLessThanOrEqual(10);
  });

  it("emits an error SVG for invalid input", () => {
    const model = makeModel();
    const svg = renderCrossSectionSvg(model, ["BH01"]);
    expect(svg).toMatch(/Select at least 2 boreholes/);
  });

  it("includes the title text when provided", () => {
    const model = makeModel();
    const svg = renderCrossSectionSvg(model, ["BH01", "BH03"], { title: "Section A–A'" });
    expect(svg).toMatch(/Section A–A'/);
  });
});

// ── extractSectionPolygons ────────────────────────────────────────────────────

describe("extractSectionPolygons", () => {
  it("returns one entry per unique unit key", () => {
    const model = makeModel();
    const polys = extractSectionPolygons(model, ["BH01", "BH02", "BH03"]);
    const keys = polys.map(p => p.unitKey).sort();
    expect(keys).toEqual(["CLAY", "TOPS"]);
  });

  it("each polygon has matching top and base edges per borehole", () => {
    const model = makeModel();
    const polys = extractSectionPolygons(model, ["BH01", "BH02", "BH03"]);
    for (const p of polys) {
      expect(p.topEdge.length).toBe(p.baseEdge.length);
      // Edges must be sorted by chainage
      for (let i = 1; i < p.topEdge.length; i++) {
        expect(p.topEdge[i]!.chainage).toBeGreaterThanOrEqual(p.topEdge[i - 1]!.chainage);
      }
    }
  });
});

describe("suggestSvgHeight", () => {
  it("clamps the suggested height to sensible bounds", () => {
    const data = {
      boreholes: [],
      totalLength: 100,
      elevMin: 80, elevMax: 100,
    };
    const h = suggestSvgHeight(data, 900);
    expect(h).toBeGreaterThanOrEqual(280);
    expect(h).toBeLessThanOrEqual(640);
  });
});
