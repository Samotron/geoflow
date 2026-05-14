import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { parseStr } from "./ags/parser.js";
import { assessQuality, renderQualityJson, renderQualityText } from "./quality.js";
import type { AgsFile } from "./model.js";

function parse(raw: string): AgsFile {
  return parseStr(raw).file;
}

// Minimal valid AGS with a PROJ, TRAN, LOCA, and GEOL — used as a clean baseline.
const MINIMAL_VALID = `"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME","PROJ_LOC"
"UNIT","","",""
"TYPE","ID","X","X"
"DATA","PROJ001","Test Project","London"

"GROUP","TRAN"
"HEADING","TRAN_AGS","TRAN_DATE"
"UNIT","",""
"TYPE","X","DT"
"DATA","4.1","2024-01-15"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_FDEP","LOCA_NATE","LOCA_NATN"
"UNIT","","","m","m","m"
"TYPE","ID","PA","2DP","2DP","2DP"
"DATA","BH01","BH","20.00","530000","180000"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","0.00","5.00","Brown silty SAND"
"DATA","BH01","5.00","20.00","Dense grey GRAVEL"
`;

describe("assessQuality", () => {
  it("returns a high score for a clean dataset", () => {
    const file = parse(MINIMAL_VALID);
    const report = assessQuality(file);
    expect(report.overall_score).toBeGreaterThanOrEqual(90);
    expect(report.grade).toBe("A");
    // Only info-level coverage advisory (no samples in minimal fixture) — no warnings or errors
    expect(report.all_diagnostics.filter((d) => d.severity !== "info")).toHaveLength(0);
  });

  it("flags missing PROJ_NAME", () => {
    const ags = `"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P001",""

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-COMP-001");
  });

  it("flags missing LOCA_FDEP", () => {
    const ags = `"GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P001"

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH01","BH"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-COMP-004");
  });

  it("flags missing coordinates", () => {
    const ags = `"GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P001"

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_FDEP"
"UNIT","","","m"
"TYPE","ID","PA","2DP"
"DATA","BH01","BH","10.00"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-COMP-005");
  });

  it("flags empty GEOL_DESC", () => {
    const ags = `"GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P001"

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_FDEP"
"UNIT","","","m"
"TYPE","ID","PA","2DP"
"DATA","BH01","BH","10.00"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","0.00","10.00",""
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-COMP-006");
  });

  it("flags short GEOL_DESC", () => {
    const ags = `"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","0.00","5.00","Snd"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-DESC-001");
  });

  it("flags short ABBR descriptions", () => {
    const ags = `"GROUP","ABBR"
"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"
"UNIT","","",""
"TYPE","X","PA","X"
"DATA","GEOL_GEOL","SC","SC"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-DESC-002");
  });

  it("flags negative ISPT_NVAL as error", () => {
    const ags = `"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_TESN","ISPT_NVAL"
"UNIT","","m","","blows/300mm"
"TYPE","ID","2DP","X","2DP"
"DATA","BH01","5.00","1","-5"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const errors = report.all_diagnostics.filter((d) => d.rule_id === "QUAL-RANGE-001");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.severity).toBe("error");
  });

  it("flags high ISPT_NVAL as warning", () => {
    const ags = `"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_TESN","ISPT_NVAL"
"UNIT","","m","","blows/300mm"
"TYPE","ID","2DP","X","2DP"
"DATA","BH01","5.00","1","200"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const warns = report.all_diagnostics.filter((d) => d.rule_id === "QUAL-RANGE-001");
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]!.severity).toBe("warning");
  });

  it("flags negative depth values", () => {
    const ags = `"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","-1.00","5.00","Brown SAND"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-RANGE-002");
  });

  it("flags LOCA_FDEP shallower than recorded data", () => {
    const ags = `"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_FDEP"
"UNIT","","","m"
"TYPE","ID","PA","2DP"
"DATA","BH01","BH","5.00"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","0.00","10.00","Brown SAND"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-RANGE-003");
  });

  it("flags stratigraphic gaps between GEOL layers", () => {
    const ags = `"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","0.00","3.00","Brown SAND"
"DATA","BH01","5.00","10.00","Grey CLAY"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-STRAT-001");
  });

  it("flags deepest GEOL_BASE differing from LOCA_FDEP", () => {
    const ags = `"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_FDEP"
"UNIT","","","m"
"TYPE","ID","PA","2DP"
"DATA","BH01","BH","15.00"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","0.00","10.00","Brown SAND"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-STRAT-002");
  });

  it("flags locations without geology", () => {
    const ags = `"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH01","BH"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-COV-001");
  });

  it("flags locations without samples or tests", () => {
    const ags = `"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH01","BH"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","0.00","5.00","Brown SAND"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const ids = report.all_diagnostics.map((d) => d.rule_id);
    expect(ids).toContain("QUAL-COV-002");
  });

  it("does not flag coverage for locations with test data but no SAMP", () => {
    const ags = `"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE"
"UNIT","",""
"TYPE","ID","PA"
"DATA","BH01","BH"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","0.00","5.00","Brown SAND"

"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_TESN","ISPT_NVAL"
"UNIT","","m","","blows/300mm"
"TYPE","ID","2DP","X","2DP"
"DATA","BH01","2.00","1","15"
`;
    const file = parse(ags);
    const report = assessQuality(file);
    const cov2 = report.all_diagnostics.filter((d) => d.rule_id === "QUAL-COV-002");
    expect(cov2).toHaveLength(0);
  });

  it("produces a quality report with 5 dimensions", () => {
    const file = parse(MINIMAL_VALID);
    const report = assessQuality(file);
    expect(report.dimensions).toHaveLength(5);
    expect(report.dimensions.map((d) => d.id)).toEqual([
      "completeness",
      "descriptions",
      "ranges",
      "stratigraphy",
      "coverage",
    ]);
  });

  it("overall_score is within 0–100", () => {
    const file = parse(MINIMAL_VALID);
    const report = assessQuality(file);
    expect(report.overall_score).toBeGreaterThanOrEqual(0);
    expect(report.overall_score).toBeLessThanOrEqual(100);
  });
});

describe("renderQualityText", () => {
  it("includes overall score and grade", () => {
    const file = parse(MINIMAL_VALID);
    const report = assessQuality(file);
    const text = renderQualityText(report);
    expect(text).toMatch(/Overall score: \d+\/100/);
    expect(text).toMatch(/\([ABCDF]\)/);
  });

  it("includes all dimension names", () => {
    const file = parse(MINIMAL_VALID);
    const report = assessQuality(file);
    const text = renderQualityText(report);
    expect(text).toContain("Completeness");
    expect(text).toContain("Descriptions");
    expect(text).toContain("Value Ranges");
    expect(text).toContain("Stratigraphy");
    expect(text).toContain("Coverage");
  });

  it("includes the file path in header when provided", () => {
    const file = parse(MINIMAL_VALID);
    const report = assessQuality(file);
    const text = renderQualityText(report, "/path/to/my.ags");
    expect(text).toContain("/path/to/my.ags");
  });
});

describe("renderQualityJson", () => {
  it("produces valid JSON with expected keys", () => {
    const file = parse(MINIMAL_VALID);
    const report = assessQuality(file);
    const json = JSON.parse(renderQualityJson(report));
    expect(json).toHaveProperty("overall_score");
    expect(json).toHaveProperty("grade");
    expect(json).toHaveProperty("dimensions");
    expect(Array.isArray(json.dimensions)).toBe(true);
    expect(json.dimensions).toHaveLength(5);
  });

  it("each dimension has id, name, score, issue_count, issues", () => {
    const file = parse(MINIMAL_VALID);
    const report = assessQuality(file);
    const json = JSON.parse(renderQualityJson(report));
    for (const dim of json.dimensions) {
      expect(dim).toHaveProperty("id");
      expect(dim).toHaveProperty("name");
      expect(dim).toHaveProperty("score");
      expect(dim).toHaveProperty("issue_count");
      expect(dim).toHaveProperty("issues");
    }
  });
});
