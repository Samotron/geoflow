import { describe, expect, it } from "vitest";
import { parseStr } from "./ags/parser.js";
import { buildProjectSummary } from "./summary.js";

const SAMPLE_AGS = `"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME","PROJ_LOC","PROJ_CLNT","PROJ_ENG"
"UNIT","","","","",""
"TYPE","ID","X","X","X","X"
"DATA","P-001","Test Project","London","TestCo","Eng A"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_NATE","LOCA_NATN","LOCA_GL","LOCA_FDEP","LOCA_STAR","LOCA_ENDD"
"UNIT","","","m","m","m","m","",""
"TYPE","ID","PA","2DP","2DP","2DP","2DP","DT","DT"
"DATA","BH01","CP","100.00","200.00","15.00","10.50","2024-01-01","2024-01-02"
"DATA","BH02","CP","115.00","212.00","14.80","12.00","2024-01-03","2024-01-04"
"DATA","TP01","TP","130.00","225.00","15.00","2.00","2024-01-05","2024-01-05"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC","GEOL_GEOL"
"UNIT","","m","m","",""
"TYPE","ID","2DP","2DP","X","PA"
"DATA","BH01","0.00","2.50","Brown soft clay","CLAY"
"DATA","BH01","2.50","10.50","Grey gravel","GRAV"
"DATA","BH02","0.00","3.00","Brown clay","CLAY"
"DATA","BH02","3.00","12.00","Grey gravel","GRAV"

"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL"
"UNIT","","m","blows"
"TYPE","ID","2DP","X"
"DATA","BH01","2.00","12"
"DATA","BH02","5.00","18"
`;

describe("buildProjectSummary", () => {
  const { file } = parseStr(SAMPLE_AGS);
  const summary = buildProjectSummary(file);

  it("extracts project metadata", () => {
    expect(summary.project.projId).toBe("P-001");
    expect(summary.project.projName).toBe("Test Project");
    expect(summary.project.projLoc).toBe("London");
    expect(summary.project.projClnt).toBe("TestCo");
  });

  it("counts boreholes and groups", () => {
    expect(summary.totals.boreholes).toBe(3);
    expect(summary.totals.strata).toBe(4);
    expect(summary.totals.sptTests).toBe(2);
    expect(summary.totals.groups).toBe(4);
  });

  it("aggregates total drilled metres", () => {
    expect(summary.depth.totalMetres).toBeCloseTo(24.5, 1);
    expect(summary.depth.maxDepthM).toBe(12);
    expect(summary.depth.minDepthM).toBe(2);
  });

  it("groups hole types", () => {
    expect(summary.holeTypes["CP"]).toBe(2);
    expect(summary.holeTypes["TP"]).toBe(1);
  });

  it("produces a per-hole schedule", () => {
    expect(summary.schedule).toHaveLength(3);
    const bh01 = summary.schedule.find((h) => h.locaId === "BH01")!;
    expect(bh01.depthM).toBe(10.5);
    expect(bh01.easting).toBe(100);
    expect(bh01.groundLevel).toBe(15);
  });

  it("aggregates geological units by code", () => {
    expect(summary.units).toHaveLength(2);
    const clay = summary.units.find((u) => u.code === "CLAY")!;
    expect(clay.occurrences).toBe(2);
    expect(clay.totalThicknessM).toBeCloseTo(5.5, 1);
    expect(clay.inHoles).toBe(2);

    const gravel = summary.units.find((u) => u.code === "GRAV")!;
    expect(gravel.occurrences).toBe(2);
    expect(gravel.totalThicknessM).toBeCloseTo(17, 1);
  });

  it("sorts groupRowCounts by row count desc", () => {
    expect(summary.groupRowCounts[0]!.rows).toBeGreaterThanOrEqual(summary.groupRowCounts[1]!.rows);
  });

  it("handles an empty file gracefully", () => {
    const { file: empty } = parseStr("");
    const s = buildProjectSummary(empty);
    expect(s.totals.boreholes).toBe(0);
    expect(s.depth.totalMetres).toBe(0);
    expect(s.units).toHaveLength(0);
  });
});
