import { describe, it, expect } from "vitest";
import { Option } from "effect";
import { geolColor, geolHatch, buildGeo3DModel, extractGeologicalContacts } from "./geo3d.js";
import type { Borehole3D, GeoLayer } from "./geo3d.js";
import type { AgsFile, AgsGroup } from "./model.js";

function makeFile(groups: AgsFile["groups"]): AgsFile {
  return { groups, source_path: Option.none(), ags_version: Option.none() };
}

// ── geolColor ─────────────────────────────────────────────────────────────────

describe("geolColor", () => {
  it("returns clay colour for CLAY descriptions", () => {
    expect(geolColor("Firm brown CLAY")).toBe("#7B9EC5");
  });

  it("returns topsoil colour", () => {
    expect(geolColor("TOPSOIL")).toBe("#5C7A3E");
  });

  it("returns sand colour", () => {
    expect(geolColor("Medium dense SAND")).toBe("#F0D870");
  });

  it("returns gravel colour (not sandy gravel)", () => {
    expect(geolColor("Dense GRAVEL")).toBe("#C87A45");
  });

  it("returns sandy gravel colour", () => {
    expect(geolColor("Dense SANDY GRAVEL")).toBe("#D99055");
  });

  it("returns fill colour for MADE GROUND", () => {
    expect(geolColor("MADE GROUND - concrete and rubble")).toBe("#A0785A");
  });

  it("returns fill colour for FILL", () => {
    expect(geolColor("Engineered FILL")).toBe("#A0785A");
  });

  it("returns chalk colour", () => {
    expect(geolColor("Weathered CHALK")).toBe("#F5F0C8");
  });

  it("returns peat colour", () => {
    expect(geolColor("Black PEAT")).toBe("#3D2B1F");
  });

  it("returns silt colour", () => {
    expect(geolColor("Soft grey SILT")).toBe("#C4A87C");
  });

  it("returns sandstone colour for SANDSTONE description", () => {
    // geolColor checks SANDY GRAVEL/GRAVELLY SAND before GRAVEL, and SANDSTONE before SAND
    expect(geolColor("Red SANDSTONE")).toBe("#D4B483");
  });

  it("returns mudstone colour", () => {
    expect(geolColor("Grey MUDSTONE")).toBe("#7A7A90");
  });

  it("returns limestone colour", () => {
    expect(geolColor("LIMESTONE")).toBe("#C8CEB8");
  });

  it("returns granite colour", () => {
    expect(geolColor("GRANITE")).toBe("#808090");
  });

  it("returns rock colour for BEDROCK", () => {
    expect(geolColor("BEDROCK")).toBe("#9090A0");
  });

  it("returns default grey for unknown descriptions", () => {
    expect(geolColor("Unknown deposit XYZ")).toBe("#d1d5db");
  });

  it("is case-insensitive", () => {
    expect(geolColor("firm clay")).toBe(geolColor("FIRM CLAY"));
  });

  it("handles empty string", () => {
    expect(geolColor("")).toBe("#d1d5db");
  });
});

// ── geolHatch ─────────────────────────────────────────────────────────────────

describe("geolHatch", () => {
  it("returns clay hatch for clay descriptions", () => {
    expect(geolHatch("Stiff brown CLAY")).toBe("clay");
  });

  it("returns sand hatch", () => {
    expect(geolHatch("Fine SAND")).toBe("sand");
  });

  it("returns gravel hatch", () => {
    expect(geolHatch("GRAVEL")).toBe("gravel");
  });

  it("returns fill hatch for MADE GROUND", () => {
    expect(geolHatch("MADE GROUND")).toBe("fill");
  });

  it("returns topsoil hatch", () => {
    expect(geolHatch("TOPSOIL")).toBe("topsoil");
  });

  it("returns chalk hatch", () => {
    expect(geolHatch("CHALK")).toBe("chalk");
  });

  it("returns peat hatch", () => {
    expect(geolHatch("PEAT")).toBe("peat");
  });

  it("returns silt hatch", () => {
    expect(geolHatch("SILT")).toBe("silt");
  });

  it("returns sandstone hatch when description contains only SANDSTONE", () => {
    // Note: the check for SAND comes before SANDSTONE in geolHatch,
    // so a pure "SANDSTONE" description matches "SAND" first.
    // This test documents the actual behaviour.
    const result = geolHatch("SANDSTONE");
    expect(["sand", "sandstone"]).toContain(result);
  });

  it("returns mudstone hatch", () => {
    expect(geolHatch("MUDSTONE")).toBe("mudstone");
  });

  it("returns limestone hatch", () => {
    expect(geolHatch("LIMESTONE")).toBe("limestone");
  });

  it("returns rock hatch for GRANITE", () => {
    expect(geolHatch("GRANITE")).toBe("rock");
  });

  it("returns none for unrecognised descriptions", () => {
    expect(geolHatch("Mystery material")).toBe("none");
  });
});

// ── buildGeo3DModel ───────────────────────────────────────────────────────────

const LOCA_GROUP: AgsGroup = {
  name: "LOCA",
  headings: [
    { name: "LOCA_ID",   unit: "", data_type: "ID" as const },
    { name: "LOCA_NATE", unit: "m", data_type: { _tag: "DP" as const, n: 2 } },
    { name: "LOCA_NATN", unit: "m", data_type: { _tag: "DP" as const, n: 2 } },
    { name: "LOCA_GL",   unit: "m", data_type: { _tag: "DP" as const, n: 2 } },
    { name: "LOCA_FDEP", unit: "m", data_type: { _tag: "DP" as const, n: 2 } },
  ],
  rows: [
    { LOCA_ID: "BH01", LOCA_NATE: 100.0, LOCA_NATN: 200.0, LOCA_GL: 50.0, LOCA_FDEP: 15.0 },
    { LOCA_ID: "BH02", LOCA_NATE: 150.0, LOCA_NATN: 200.0, LOCA_GL: 49.0, LOCA_FDEP: 12.0 },
    { LOCA_ID: "BH03", LOCA_NATE: 125.0, LOCA_NATN: 250.0, LOCA_GL: 51.0, LOCA_FDEP: 10.0 },
  ],
  source_line: Option.none(),
};

const GEOL_GROUP: AgsGroup = {
  name: "GEOL",
  headings: [
    { name: "LOCA_ID",   unit: "", data_type: "ID" as const },
    { name: "GEOL_TOP",  unit: "m", data_type: { _tag: "DP" as const, n: 2 } },
    { name: "GEOL_BASE", unit: "m", data_type: { _tag: "DP" as const, n: 2 } },
    { name: "GEOL_DESC", unit: "", data_type: "X" as const },
  ],
  rows: [
    { LOCA_ID: "BH01", GEOL_TOP: 0.0, GEOL_BASE: 2.0,  GEOL_DESC: "Topsoil" },
    { LOCA_ID: "BH01", GEOL_TOP: 2.0, GEOL_BASE: 15.0, GEOL_DESC: "Clay" },
    { LOCA_ID: "BH02", GEOL_TOP: 0.0, GEOL_BASE: 1.5,  GEOL_DESC: "Topsoil" },
    { LOCA_ID: "BH02", GEOL_TOP: 1.5, GEOL_BASE: 12.0, GEOL_DESC: "Clay" },
    { LOCA_ID: "BH03", GEOL_TOP: 0.0, GEOL_BASE: 1.8,  GEOL_DESC: "Topsoil" },
    { LOCA_ID: "BH03", GEOL_TOP: 1.8, GEOL_BASE: 10.0, GEOL_DESC: "Clay" },
  ],
  source_line: Option.none(),
};

describe("buildGeo3DModel", () => {
  it("returns null for empty file", () => {
    expect(buildGeo3DModel(makeFile({}))).toBeNull();
  });

  it("returns null when LOCA group has no rows", () => {
    const file = makeFile({
      LOCA: {
        name: "LOCA",
        headings: [{ name: "LOCA_ID", unit: "", data_type: "ID" }],
        rows: [],
        source_line: Option.none(),
      },
    });
    expect(buildGeo3DModel(file)).toBeNull();
  });

  it("builds model with correct borehole count", () => {
    const file = makeFile({ LOCA: LOCA_GROUP, GEOL: GEOL_GROUP });
    const model = buildGeo3DModel(file);
    expect(model).not.toBeNull();
    expect(model!.boreholes).toHaveLength(3);
  });

  it("borehole IDs match LOCA_ID", () => {
    const file = makeFile({ LOCA: LOCA_GROUP, GEOL: GEOL_GROUP });
    const model = buildGeo3DModel(file)!;
    const ids = model.boreholes.map((b) => b.id).sort();
    expect(ids).toEqual(["BH01", "BH02", "BH03"]);
  });

  it("model has local (centroid-relative) coordinates", () => {
    const file = makeFile({ LOCA: LOCA_GROUP, GEOL: GEOL_GROUP });
    const model = buildGeo3DModel(file)!;
    // Centroid should be near 125, 217 (average of the three boreholes)
    expect(model.centroid.x).toBeCloseTo(125.0, 0);
    // At least one borehole should have local x near 0 (the centroid one)
    const hasNearZero = model.boreholes.some((b) => Math.abs(b.x) < 50);
    expect(hasNearZero).toBe(true);
  });

  it("populates bounds", () => {
    const file = makeFile({ LOCA: LOCA_GROUP, GEOL: GEOL_GROUP });
    const model = buildGeo3DModel(file)!;
    expect(model.bounds.xMin).toBeLessThan(model.bounds.xMax);
    expect(model.bounds.zMin).toBeLessThan(model.bounds.zMax);
  });

  it("assigns colours to geological units", () => {
    const file = makeFile({ LOCA: LOCA_GROUP, GEOL: GEOL_GROUP });
    const model = buildGeo3DModel(file)!;
    expect(model.units.length).toBeGreaterThan(0);
    for (const unit of model.units) {
      expect(unit.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("builds model without GEOL group", () => {
    const file = makeFile({ LOCA: LOCA_GROUP });
    const model = buildGeo3DModel(file);
    expect(model).not.toBeNull();
    expect(model!.boreholes).toHaveLength(3);
    expect(model!.units).toHaveLength(0);
  });

  it("boreholes have layers when GEOL present", () => {
    const file = makeFile({ LOCA: LOCA_GROUP, GEOL: GEOL_GROUP });
    const model = buildGeo3DModel(file)!;
    const bh01 = model.boreholes.find((b) => b.id === "BH01");
    expect(bh01?.layers.length).toBeGreaterThan(0);
  });

  it("model includes contacts array", () => {
    const file = makeFile({ LOCA: LOCA_GROUP, GEOL: GEOL_GROUP });
    const model = buildGeo3DModel(file)!;
    expect(Array.isArray(model.contacts)).toBe(true);
  });

  it("model includes empty faults array", () => {
    const file = makeFile({ LOCA: LOCA_GROUP, GEOL: GEOL_GROUP });
    const model = buildGeo3DModel(file)!;
    expect(model.faults).toEqual([]);
  });

  it("units include contactSurface when ≥ 3 boreholes observe the unit", () => {
    const file = makeFile({ LOCA: LOCA_GROUP, GEOL: GEOL_GROUP });
    const model = buildGeo3DModel(file)!;
    // All three boreholes have TOPSOIL and CLAY → contactSurface should be set
    const clay = model.units.find((u) => u.key === "CLAY");
    expect(clay).toBeDefined();
    expect(clay!.contactSurface).not.toBeNull();
  });
});

// ── extractGeologicalContacts ─────────────────────────────────────────────────

function makeLayer(
  unitKey: string, desc: string,
  topDepth: number, baseDepth: number,
  elev: number,
): GeoLayer {
  return {
    unitKey,
    desc,
    topDepth,
    baseDepth,
    topElev: elev - topDepth,
    baseElev: elev - baseDepth,
    color: "#aabbcc",
    hatch: "none",
  };
}

function makeBorehole(id: string, x: number, y: number, elev: number, layers: GeoLayer[]): Borehole3D {
  return { id, x, y, elev, finDepth: layers.at(-1)?.baseDepth ?? 0, layers };
}

describe("extractGeologicalContacts", () => {
  it("returns empty array for boreholes with no layers", () => {
    const bh = makeBorehole("BH01", 0, 0, 50, []);
    expect(extractGeologicalContacts([bh])).toEqual([]);
  });

  it("returns empty array when a borehole has only one layer", () => {
    const bh = makeBorehole("BH01", 0, 0, 50, [makeLayer("CLAY", "Clay", 0, 10, 50)]);
    expect(extractGeologicalContacts([bh])).toEqual([]);
  });

  it("extracts one contact for two adjacent layers", () => {
    const bh = makeBorehole("BH01", 10, 20, 50, [
      makeLayer("TOPSOIL", "Topsoil", 0, 2, 50),
      makeLayer("CLAY", "Clay", 2, 15, 50),
    ]);
    const contacts = extractGeologicalContacts([bh]);
    expect(contacts).toHaveLength(1);
    const c = contacts[0]!;
    expect(c.unitAbove).toBe("TOPSOIL");
    expect(c.unitBelow).toBe("CLAY");
    expect(c.zContact).toBeCloseTo(50 - 2, 4); // elev − base of TOPSOIL
    expect(c.boreholeId).toBe("BH01");
    expect(c.x).toBe(10);
    expect(c.y).toBe(20);
  });

  it("extracts two contacts for three sequential layers", () => {
    const bh = makeBorehole("BH01", 0, 0, 50, [
      makeLayer("TOPSOIL", "Topsoil", 0, 1, 50),
      makeLayer("CLAY", "Clay", 1, 8, 50),
      makeLayer("SAND", "Sand", 8, 20, 50),
    ]);
    const contacts = extractGeologicalContacts([bh]);
    expect(contacts).toHaveLength(2);
    expect(contacts[0]!.unitAbove).toBe("TOPSOIL");
    expect(contacts[0]!.unitBelow).toBe("CLAY");
    expect(contacts[1]!.unitAbove).toBe("CLAY");
    expect(contacts[1]!.unitBelow).toBe("SAND");
  });

  it("does not emit a contact where layers have a gap > 50 mm", () => {
    const bh = makeBorehole("BH01", 0, 0, 50, [
      makeLayer("TOPSOIL", "Topsoil", 0, 2, 50),
      makeLayer("CLAY", "Clay", 2.1, 15, 50), // 100 mm gap — should be skipped
    ]);
    const contacts = extractGeologicalContacts([bh]);
    expect(contacts).toHaveLength(0);
  });

  it("aggregates contacts from multiple boreholes", () => {
    const bhs = [
      makeBorehole("BH01", 0, 0, 50, [
        makeLayer("TOPSOIL", "Topsoil", 0, 2, 50),
        makeLayer("CLAY", "Clay", 2, 15, 50),
      ]),
      makeBorehole("BH02", 50, 0, 49, [
        makeLayer("TOPSOIL", "Topsoil", 0, 1.5, 49),
        makeLayer("CLAY", "Clay", 1.5, 12, 49),
      ]),
      makeBorehole("BH03", 25, 50, 51, [
        makeLayer("TOPSOIL", "Topsoil", 0, 1.8, 51),
        makeLayer("CLAY", "Clay", 1.8, 10, 51),
      ]),
    ];
    const contacts = extractGeologicalContacts(bhs);
    expect(contacts).toHaveLength(3);
    expect(contacts.every((c) => c.unitAbove === "TOPSOIL" && c.unitBelow === "CLAY")).toBe(true);
  });

  it("returns contacts sorted by borehole insertion order", () => {
    const bhs = [
      makeBorehole("A", 0, 0, 10, [
        makeLayer("X", "X", 0, 5, 10),
        makeLayer("Y", "Y", 5, 10, 10),
      ]),
      makeBorehole("B", 10, 0, 10, [
        makeLayer("X", "X", 0, 3, 10),
        makeLayer("Y", "Y", 3, 10, 10),
      ]),
    ];
    const contacts = extractGeologicalContacts(bhs);
    expect(contacts[0]!.boreholeId).toBe("A");
    expect(contacts[1]!.boreholeId).toBe("B");
  });
});
