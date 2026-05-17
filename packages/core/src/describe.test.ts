import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { enhanceGeol, parseDescription } from "./describe.js";
import type { AgsFile } from "./model.js";

describe("parseDescription — soils", () => {
  it("parses Soft grey CLAY", () => {
    const d = parseDescription("Soft grey CLAY");
    expect(d.consistency).toBe("soft");
    expect(d.primary_soil_type).toBe("clay");
    expect(d.colours).toContain("grey");
    expect(d.material_type).toBe("soil");
    expect(d.strength_params?.cu_min_kpa).toBe(20);
    expect(d.strength_params?.cu_max_kpa).toBe(40);
    expect(d.uscs).toBe("CL");
  });

  it("parses Medium dense brown fine SAND", () => {
    const d = parseDescription("Medium dense brown fine SAND");
    expect(d.density).toBe("medium_dense");
    expect(d.primary_soil_type).toBe("sand");
    expect(d.particle_size).toBe("fine");
    expect(d.colours).toContain("brown");
    expect(d.strength_params?.spt_n_min).toBe(10);
    expect(d.strength_params?.spt_n_max).toBe(30);
    expect(d.strength_params?.phi_min_deg).toBe(30);
    expect(d.uscs).toBe("SP");
  });

  it("expands abbreviations: v soft gy cl", () => {
    const d = parseDescription("v soft gy cl");
    expect(d.consistency).toBe("very_soft");
    expect(d.primary_soil_type).toBe("clay");
    expect(d.colours.some((c) => c.includes("grey"))).toBe(true);
  });

  it("detects made ground in FILL: mixed topsoil and rubble", () => {
    const d = parseDescription("FILL: mixed topsoil and rubble");
    expect(d.is_made_ground).toBe(true);
    expect(d.material_type).toBe("made");
  });

  it("parses consistency range Firm to stiff brown CLAY", () => {
    const d = parseDescription("Firm to stiff brown CLAY");
    expect(d.consistency).toBe("firm_to_stiff");
  });

  it("parses sandy CLAY as primary clay with sand constituent", () => {
    const d = parseDescription("Stiff sandy CLAY");
    expect(d.primary_soil_type).toBe("clay");
    expect(d.secondary_constituents.some((c) => c.soil_type === "sand")).toBe(true);
    expect(d.consistency).toBe("stiff");
  });

  it("trace of gravel yields trace proportion", () => {
    const d = parseDescription("Soft brown CLAY with trace of gravel");
    expect(d.primary_soil_type).toBe("clay");
    const grav = d.secondary_constituents.find((c) => c.soil_type === "gravel");
    expect(grav?.proportion).toBe("trace");
  });

  it("with sand gives moderately proportion", () => {
    const d = parseDescription("Firm CLAY with sand");
    const sand = d.secondary_constituents.find((c) => c.soil_type === "sand");
    expect(sand?.proportion).toBe("moderately");
  });

  it("parses saturated wet moisture", () => {
    expect(parseDescription("Wet brown SAND").moisture).toBe("wet");
    expect(parseDescription("Saturated grey SILT").moisture).toBe("saturated");
  });

  it("parses laminated and fissured structure", () => {
    const d = parseDescription("Stiff laminated fissured grey CLAY");
    expect(d.structures).toContain("laminated");
    expect(d.structures).toContain("fissured");
  });

  it("parses plasticity descriptors", () => {
    const d = parseDescription("Stiff high plasticity grey CLAY");
    expect(d.plasticity).toBe("high");
    expect(d.uscs).toBe("CH");
  });

  it("rejects non-plastic", () => {
    const d = parseDescription("Soft non-plastic grey SILT");
    expect(d.plasticity).toBe("non_plastic");
  });

  it("flags density on cohesive soil with warning", () => {
    const d = parseDescription("Loose grey CLAY");
    expect(d.warnings).toContain("density_on_cohesive_soil");
    expect(d.confidence).toBeLessThan(1);
  });

  it("flags consistency on granular soil with warning", () => {
    const d = parseDescription("Stiff brown SAND");
    expect(d.warnings).toContain("consistency_on_granular_soil");
  });

  it("warns when no primary material identified", () => {
    const d = parseDescription("brown moist");
    expect(d.warnings).toContain("no_primary_material_identified");
    expect(d.material_type).toBe("unknown");
  });
});

describe("parseDescription — rocks", () => {
  it("parses Moderately weathered grey LIMESTONE", () => {
    const d = parseDescription("Moderately weathered grey LIMESTONE");
    expect(d.rock_type).toBe("limestone");
    expect(d.material_type).toBe("rock");
    expect(d.weathering).toBe("moderately_weathered");
  });

  it("parses W3 grade code", () => {
    const d = parseDescription("W3 grey SANDSTONE");
    expect(d.weathering).toBe("moderately_weathered");
  });

  it("parses rock strength medium strong", () => {
    const d = parseDescription("Medium strong fresh grey GRANITE");
    expect(d.rock_strength).toBe("medium_strong");
    expect(d.weathering).toBe("fresh");
    expect(d.strength_params?.ucs_min_mpa).toBe(25);
    expect(d.strength_params?.ucs_max_mpa).toBe(50);
  });

  it("parses very weak rock", () => {
    const d = parseDescription("Highly weathered very weak grey MUDSTONE");
    expect(d.rock_strength).toBe("very_weak");
    expect(d.weathering).toBe("highly_weathered");
    expect(d.strength_params?.ucs_min_mpa).toBe(1);
    expect(d.strength_params?.ucs_max_mpa).toBe(5);
  });

  it("detects bedding spacing", () => {
    const d = parseDescription("Strong fresh medium bedded grey SANDSTONE");
    expect(d.bedding_spacing).toBe("medium");
    expect(d.rock_strength).toBe("strong");
  });

  it("detects close jointed", () => {
    const d = parseDescription("Strong close jointed grey LIMESTONE");
    expect(d.bedding_spacing).toBe("close");
  });

  it("detects metamorphic rock types", () => {
    expect(parseDescription("grey SCHIST").rock_type).toBe("schist");
    expect(parseDescription("pink GNEISS").rock_type).toBe("gneiss");
    expect(parseDescription("white QUARTZITE").rock_type).toBe("quartzite");
    expect(parseDescription("white MARBLE").rock_type).toBe("marble");
  });

  it("detects evaporites and carbonates", () => {
    expect(parseDescription("grey DOLOMITE").rock_type).toBe("dolomite");
    expect(parseDescription("white GYPSUM").rock_type).toBe("gypsum");
  });
});

describe("parseDescription — inclusions", () => {
  it("detects rootlets and roots", () => {
    expect(parseDescription("Brown TOPSOIL with rootlets").inclusions).toContain("rootlets");
    expect(parseDescription("Stiff CLAY with roots").inclusions).toContain("roots");
  });

  it("detects fossils and shells", () => {
    expect(parseDescription("Fossiliferous grey LIMESTONE").inclusions).toContain("fossils");
    expect(parseDescription("Soft CLAY with shells").inclusions).toContain("shells");
  });

  it("detects organic debris", () => {
    expect(parseDescription("Loose SAND with charcoal and wood").inclusions).toContain("charcoal");
    expect(parseDescription("Loose SAND with charcoal and wood").inclusions).toContain("wood");
  });

  it("flags anthropogenic inclusions in made ground", () => {
    const d = parseDescription("FILL with brick, concrete and glass");
    expect(d.is_made_ground).toBe(true);
    expect(d.inclusions).toEqual(expect.arrayContaining(["brick", "concrete", "glass"]));
  });
});

describe("parseDescription — USCS inference", () => {
  it("maps PEAT to Pt", () => {
    expect(parseDescription("Spongy brown PEAT").uscs).toBe("Pt");
  });

  it("maps clayey SAND to SC", () => {
    expect(parseDescription("Dense brown clayey SAND").uscs).toBe("SC");
  });

  it("maps silty SAND to SM", () => {
    expect(parseDescription("Loose brown silty SAND").uscs).toBe("SM");
  });

  it("maps well-graded SAND to SW", () => {
    expect(parseDescription("Dense brown fine to medium SAND").uscs).toBe("SW");
  });
});

describe("enhanceGeol", () => {
  it("returns enriched rows for every GEOL_DESC", () => {
    const file: AgsFile = {
      groups: {
        GEOL: {
          name: "GEOL",
          headings: [
            { name: "LOCA_ID", unit: "", data_type: "X" },
            { name: "GEOL_TOP", unit: "m", data_type: { _tag: "DP", n: 2 } },
            { name: "GEOL_BASE", unit: "m", data_type: { _tag: "DP", n: 2 } },
            { name: "GEOL_DESC", unit: "", data_type: "X" },
          ],
          rows: [
            { LOCA_ID: "BH01", GEOL_TOP: 0, GEOL_BASE: 1.2, GEOL_DESC: "Soft grey CLAY" },
            { LOCA_ID: "BH01", GEOL_TOP: 1.2, GEOL_BASE: 3.5, GEOL_DESC: "Medium dense brown SAND" },
            { LOCA_ID: "BH01", GEOL_TOP: 3.5, GEOL_BASE: 5.0, GEOL_DESC: "" },
          ],
          source_line: Option.none(),
        },
      },
      source_path: Option.none(),
      ags_version: Option.none(),
    };

    const out = enhanceGeol(file);
    expect(out).toHaveLength(2);
    expect(out[0]!.loca_id).toBe("BH01");
    expect(out[0]!.geol_top).toBe(0);
    expect(out[0]!.parsed.primary_soil_type).toBe("clay");
    expect(out[1]!.parsed.primary_soil_type).toBe("sand");
  });

  it("returns empty array when GEOL group is absent", () => {
    const file: AgsFile = {
      groups: {},
      source_path: Option.none(),
      ags_version: Option.none(),
    };
    expect(enhanceGeol(file)).toEqual([]);
  });
});
