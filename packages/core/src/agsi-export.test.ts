import { describe, expect, it } from "vitest";
import { parseStr } from "./ags/parser.js";
import { toAgsi } from "./agsi-export.js";

const AGS = `"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME","PROJ_LOC","PROJ_CLNT"
"UNIT","","","",""
"TYPE","ID","X","X","X"
"DATA","P-001","Demo project","London","TestCo"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_NATE","LOCA_NATN","LOCA_GL","LOCA_FDEP"
"UNIT","","","m","m","m","m"
"TYPE","ID","PA","2DP","2DP","2DP","2DP"
"DATA","BH01","CP","100.0","200.0","15.0","10.0"
"DATA","BH02","CP","115.0","210.0","14.0","8.0"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC","GEOL_GEOL"
"UNIT","","m","m","",""
"TYPE","ID","2DP","2DP","X","PA"
"DATA","BH01","0.00","2.50","Brown clay","CLAY"
"DATA","BH01","2.50","10.00","Grey gravel","GRAV"
"DATA","BH02","0.00","8.00","Sandy clay","CLAY"
`;

describe("toAgsi", () => {
  const { file } = parseStr(AGS);
  const doc = toAgsi(file, { generatedAt: "2026-01-01T00:00:00Z" });

  it("emits the right top-level shape and AGSi version", () => {
    expect(doc.$schema).toContain("agsi");
    expect(doc.agsiVersion).toBe("1.0.1");
    expect(doc.generator.name).toBe("GeoFlow");
    expect(doc.generatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("captures project metadata", () => {
    expect(doc.project.projectId).toBe("P-001");
    expect(doc.project.projectName).toBe("Demo project");
    expect(doc.project.location).toBe("London");
    expect(doc.project.client).toBe("TestCo");
    expect(doc.project.informationSources).toHaveLength(2);
  });

  it("lists geological units ranked by total thickness", () => {
    expect(doc.geologicalUnits).toHaveLength(2);
    // GRAV (7.5m) > CLAY (10.5m total) -- actually CLAY is 2.5+8=10.5, GRAV is 7.5
    // CLAY should rank first
    expect(doc.geologicalUnits[0]!.unitCode).toBe("CLAY");
    expect(doc.geologicalUnits[0]!.occurrences).toBe(2);
    expect(doc.geologicalUnits[0]!.totalThicknessM).toBeCloseTo(10.5, 1);
    expect(doc.geologicalUnits[0]!.inHoles).toBe(2);
  });

  it("creates one modelInstance per LOCA", () => {
    expect(doc.modelInstances).toHaveLength(2);
    const bh01 = doc.modelInstances.find((m) => m.locaId === "BH01")!;
    expect(bh01.totalDepth).toBe(10);
    expect(bh01.groundLevel).toBe(15);
    expect(bh01.elements).toHaveLength(2);
  });

  it("computes layer RL from groundLevel", () => {
    const bh01 = doc.modelInstances.find((m) => m.locaId === "BH01")!;
    const topLayer = bh01.elements[0]!;
    expect(topLayer.geometry.topDepth).toBe(0);
    expect(topLayer.geometry.topRL).toBe(15);
    expect(topLayer.geometry.baseRL).toBe(12.5);
  });

  it("uses BGL datum when no LOCA_GL is present", () => {
    const noGL = parseStr(`"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_FDEP"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","BH01","5.0"
`).file;
    const d = toAgsi(noGL, { generatedAt: "2026-01-01T00:00:00Z" });
    expect(d.modelInstances[0]!.verticalDatum).toBe("BGL");
    expect(d.modelInstances[0]!.groundLevel).toBeNull();
  });

  it("preserves the GEOL row index in observations", () => {
    const bh01 = doc.modelInstances.find((m) => m.locaId === "BH01")!;
    expect(bh01.elements[0]!.observation.agsGroup).toBe("GEOL");
    expect(bh01.elements[0]!.observation.rowIndex).toBe(0);
    expect(bh01.elements[1]!.observation.rowIndex).toBe(1);
  });
});
