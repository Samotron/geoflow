import { describe, expect, it } from "vitest";
import { correlateSpt, correlateIspt } from "./spt.js";
import { parseStr } from "./ags/parser.js";

describe("correlateSpt", () => {
  it("returns N60 with the supplied energy ratio", () => {
    const r = correlateSpt({ N: 20, energyRatio: 1.0 });
    expect(r.N60).toBe(20);
    const r2 = correlateSpt({ N: 20, energyRatio: 1.3 });
    expect(r2.N60).toBeCloseTo(26, 3);
  });

  it("applies Liao-Whitman overburden correction (CN capped at 1.7)", () => {
    const deep = correlateSpt({ N: 10, sigmaVeff: 400 });
    // CN = √(100/400) = 0.5
    expect(deep.N1_60).toBeCloseTo(5, 3);
    const shallow = correlateSpt({ N: 10, sigmaVeff: 1 });
    // CN = √(100/1) = 10 → capped at 1.7
    expect(shallow.N1_60).toBeCloseTo(17, 3);
  });

  it("emits φ′ and Dr for granular soils only", () => {
    const gran = correlateSpt({ N: 25, sigmaVeff: 100, family: "granular" });
    expect(gran.phiPrime).toBeDefined();
    expect(gran.phiPrime).toBeGreaterThan(20);
    expect(gran.Dr).toBeDefined();
    expect(gran.Dr).toBeGreaterThan(0);
    expect(gran.cuMin).toBeUndefined();

    const coh = correlateSpt({ N: 10, family: "cohesive" });
    expect(coh.phiPrime).toBeUndefined();
    expect(coh.Dr).toBeUndefined();
    expect(coh.cuMin).toBeCloseTo(40, 3);
    expect(coh.cuMax).toBeCloseTo(60, 3);
  });

  it("emits both granular and cohesive correlations when family is unknown", () => {
    const r = correlateSpt({ N: 15, sigmaVeff: 80 });
    expect(r.phiPrime).toBeDefined();
    expect(r.cuMin).toBeDefined();
  });

  it("computes Vs (Imai) for any N>0 and Vs (Ohta-Goto) only when depth provided", () => {
    const a = correlateSpt({ N: 10 });
    expect(a.VsImai).toBeGreaterThan(150);
    expect(a.VsOhtaGoto).toBeUndefined();

    const b = correlateSpt({ N: 10, depth: 5 });
    expect(b.VsOhtaGoto).toBeDefined();
    expect(b.VsOhtaGoto!).toBeGreaterThan(0);
  });
});

describe("correlateIspt", () => {
  const ags = `"GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_GL"
"UNIT","","","m"
"TYPE","ID","X","2DP"
"DATA","BH01","CP","30.00"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC","GEOL_LEG"
"UNIT","","m","m","",""
"TYPE","ID","2DP","2DP","X","PA"
"DATA","BH01","0.00","2.00","Soft grey CLAY","CL"
"DATA","BH01","2.00","6.00","Medium dense fine SAND","SA"

"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_TESN","ISPT_NVAL"
"UNIT","","m","",""
"TYPE","ID","2DP","X","2SF"
"DATA","BH01","1.00","SPT","5"
"DATA","BH01","3.50","SPT","18"
`;

  it("returns one row per ISPT entry with inferred soil family", () => {
    const { file } = parseStr(ags);
    const rows = correlateIspt(file);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.loca_id).toBe("BH01");
    expect(rows[0]!.depth).toBe(1.0);
    expect(rows[0]!.family).toBe("cohesive");
    expect(rows[1]!.family).toBe("granular");
  });

  it("applies water-table-aware effective stress and produces N1_60", () => {
    const { file } = parseStr(ags);
    const rows = correlateIspt(file, { waterTableDepth: 2 });
    expect(rows[0]!.correlations.N1_60).toBeDefined();
    expect(rows[1]!.correlations.N1_60).toBeDefined();
    // Deeper sand row should have a lower CN.
    expect(rows[1]!.correlations.N1_60!).toBeLessThan(rows[1]!.N * 1.7);
  });

  it("skips ISPT rows with no depth or zero N", () => {
    const noisy = `"GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_TESN","ISPT_NVAL"
"UNIT","","m","",""
"TYPE","ID","2DP","X","2SF"
"DATA","BH01","","SPT","10"
"DATA","BH01","2.00","SPT","0"
"DATA","BH01","3.00","SPT","12"
`;
    const { file } = parseStr(noisy);
    expect(correlateIspt(file)).toHaveLength(1);
  });
});
