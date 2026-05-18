import { describe, expect, it } from "vitest";
import { parseStr } from "./ags/parser.js";
import { representativeGroundModel } from "./ground-model.js";

const AGS_3BH = `"GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_GL"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","BH01","30.00"
"DATA","BH02","31.00"
"DATA","BH03","30.50"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC","GEOL_LEG"
"UNIT","","m","m","",""
"TYPE","ID","2DP","2DP","X","PA"
"DATA","BH01","0.00","0.20","Topsoil","TS"
"DATA","BH01","0.20","3.00","Soft brown CLAY","CL"
"DATA","BH01","3.00","8.00","Dense fine SAND","SA"
"DATA","BH01","8.00","12.00","Weathered ROCK","RX"
"DATA","BH02","0.00","0.15","Topsoil","TS"
"DATA","BH02","0.15","3.50","Soft brown CLAY","CL"
"DATA","BH02","3.50","9.00","Dense fine SAND","SA"
"DATA","BH02","9.00","11.00","Weathered ROCK","RX"
"DATA","BH03","0.00","0.20","Topsoil","TS"
"DATA","BH03","0.20","2.50","Firm brown CLAY","CL"
"DATA","BH03","2.50","7.50","Medium dense SAND","SA"
"DATA","BH03","7.50","10.00","Weathered ROCK","RX"
`;

describe("representativeGroundModel", () => {
  it("returns empty model when fewer than 2 boreholes are supplied", () => {
    const { file } = parseStr(AGS_3BH);
    const m = representativeGroundModel(file, ["BH01"]);
    expect(m.layers).toEqual([]);
    expect(m.contributingLocaIds).toEqual(["BH01"]);
  });

  it("emits a CL → SA → RX representative stack across 3 boreholes", () => {
    const { file } = parseStr(AGS_3BH);
    const m = representativeGroundModel(file, ["BH01", "BH02", "BH03"]);
    expect(m.layers.length).toBeGreaterThan(0);
    expect(m.contributingLocaIds).toHaveLength(3);
    const codes = m.layers.map((l) => l.unitKey);
    expect(codes).toContain("CL");
    expect(codes).toContain("SA");
    expect(codes).toContain("RX");
    // Order is top→base
    const idxCL = codes.indexOf("CL");
    const idxSA = codes.indexOf("SA");
    const idxRX = codes.indexOf("RX");
    expect(idxCL).toBeLessThan(idxSA);
    expect(idxSA).toBeLessThan(idxRX);
  });

  it("attaches a support score to every layer", () => {
    const { file } = parseStr(AGS_3BH);
    const m = representativeGroundModel(file, ["BH01", "BH02", "BH03"]);
    for (const l of m.layers) {
      expect(l.support).toBeGreaterThan(0);
      expect(l.support).toBeLessThanOrEqual(1);
      expect(l.boreholesAtDepth).toBeGreaterThan(0);
    }
    // The SA stratum is present in all 3 boreholes (with slightly different
    // top/base depths) — the coalesced layer's mean support should be high.
    const major = m.layers.find((l) => l.unitKey === "SA");
    expect(major?.support).toBeGreaterThan(0.8);
    expect(major?.boreholesAtDepth).toBe(3);
  });

  it("uses GEOL_GEOL when present, falling back to GEOL_LEG", () => {
    const ags = `"GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_GEOL","GEOL_LEG"
"UNIT","","m","m","",""
"TYPE","ID","2DP","2DP","X","PA"
"DATA","BH01","0.00","5.00","ALLUVIUM","AL"
"DATA","BH02","0.00","4.50","ALLUVIUM","AL"
`;
    const { file } = parseStr(ags);
    const m = representativeGroundModel(file, ["BH01", "BH02"]);
    expect(m.layers[0]?.unitKey).toBe("ALLUVIUM");
  });

  it("skips layers below minSupport", () => {
    const { file } = parseStr(AGS_3BH);
    const m = representativeGroundModel(file, ["BH01", "BH02", "BH03"], { minSupport: 0.99 });
    // All three CL/SA/RX layers have full support so should remain;
    // topsoil sits at 0–0.2 m and has support 1 in all 3 → also kept.
    expect(m.layers.length).toBeGreaterThan(0);
  });
});
