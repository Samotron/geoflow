import { describe, expect, it } from "vitest";
import { parseStr } from "./ags/parser.js";
import {
  buildTestTables,
  renderFactualReportHtml,
  renderFactualReportFromText,
} from "./factual-report.js";

const AGS = `"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME","PROJ_LOC","PROJ_CLNT","PROJ_ENG"
"UNIT","","","","",""
"TYPE","ID","X","X","X","X"
"DATA","P-100","Riverside Investigation","Riverside, Anytown","Acme Developments","J. Rogers"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_NATE","LOCA_NATN","LOCA_GL","LOCA_FDEP","LOCA_STAR","LOCA_ENDD"
"UNIT","","","m","m","m","m","",""
"TYPE","ID","PA","2DP","2DP","2DP","2DP","DT","DT"
"DATA","BH01","CP","100.00","200.00","15.00","10.50","2024-03-01","2024-03-02"
"DATA","BH02","CP","115.00","212.00","14.80","12.00","2024-03-03","2024-03-04"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC","GEOL_LEG"
"UNIT","","m","m","",""
"TYPE","ID","2DP","2DP","X","PA"
"DATA","BH01","0.00","2.50","Firm brown CLAY","CL"
"DATA","BH01","2.50","10.50","Dense grey SAND and GRAVEL","SG"
"DATA","BH02","0.00","3.00","Firm brown CLAY","CL"
"DATA","BH02","3.00","12.00","Dense grey SAND and GRAVEL","SG"

"GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_TOP","SAMP_REF","SAMP_TYPE"
"UNIT","","m","",""
"TYPE","ID","2DP","ID","PA"
"DATA","BH01","1.00","S1","U"
"DATA","BH01","5.00","S2","B"
"DATA","BH02","2.00","S3","U"

"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_TESN","ISPT_NVAL"
"UNIT","","m","",""
"TYPE","ID","2DP","X","X"
"DATA","BH01","2.00","1","12"
"DATA","BH01","5.00","2","28"
"DATA","BH02","4.00","1","18"

"GROUP","LLPL"
"HEADING","LOCA_ID","SPEC_DPTH","LLPL_LL","LLPL_PL","LLPL_PI"
"UNIT","","m","%","%","%"
"TYPE","ID","2DP","1DP","1DP","1DP"
"DATA","BH01","1.00","45.0","22.0","23.0"
"DATA","BH02","2.00","52.0","25.0","27.0"

"GROUP","WSTK"
"HEADING","LOCA_ID","WSTK_DPTH","WSTK_REM"
"UNIT","","m",""
"TYPE","ID","2DP","X"
"DATA","BH01","3.20","Slow seepage"
`;

describe("buildTestTables", () => {
  const { file } = parseStr(AGS);
  const tables = buildTestTables(file);

  it("finds the curated in-situ and laboratory groups present", () => {
    const groups = tables.map((t) => t.group).sort();
    expect(groups).toContain("ISPT");
    expect(groups).toContain("LLPL");
    expect(groups).toContain("WSTK");
  });

  it("orders columns LOCA_ID, depth, then result columns", () => {
    const ispt = tables.find((t) => t.group === "ISPT")!;
    expect(ispt.columns[0]).toBe("LOCA_ID");
    expect(ispt.columns[1]).toBe("ISPT_TOP");
    expect(ispt.columns).toContain("ISPT_NVAL");
  });

  it("captures every row of a test group", () => {
    const ispt = tables.find((t) => t.group === "ISPT")!;
    expect(ispt.rows).toHaveLength(3);
    expect(ispt.rows[0]).toContain("BH01");
    expect(ispt.rows[0]).toContain("12");
  });

  it("picks SPEC_DPTH as the depth column for lab tests", () => {
    const llpl = tables.find((t) => t.group === "LLPL")!;
    expect(llpl.columns[1]).toBe("SPEC_DPTH");
    expect(llpl.category).toBe("laboratory");
  });

  it("drops result columns absent from the group", () => {
    const llpl = tables.find((t) => t.group === "LLPL")!;
    // LLPL_425 is in the spec but not in this file
    expect(llpl.columns).not.toContain("LLPL_425");
  });

  it("returns an empty list when no test groups are present", () => {
    const { file: bare } = parseStr(`"GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"
`);
    expect(buildTestTables(bare)).toHaveLength(0);
  });
});

describe("renderFactualReportHtml", () => {
  const { file } = parseStr(AGS);

  it("produces a complete self-contained HTML document", () => {
    const html = renderFactualReportHtml(file, { sourcePath: "riverside.ags" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
    expect(html).toContain("Factual Report");
  });

  it("includes the project title block", () => {
    const html = renderFactualReportHtml(file);
    expect(html).toContain("Riverside Investigation");
    expect(html).toContain("Acme Developments");
    expect(html).toContain("P-100");
  });

  it("includes the schedule of exploratory holes", () => {
    const html = renderFactualReportHtml(file);
    expect(html).toContain("Schedule of Exploratory Holes");
    expect(html).toContain("BH01");
    expect(html).toContain("BH02");
  });

  it("includes the geological summary", () => {
    const html = renderFactualReportHtml(file);
    expect(html).toContain("Geological Units Encountered");
    expect(html).toContain("Firm brown CLAY");
  });

  it("includes detailed test tables when includeTests is true", () => {
    const html = renderFactualReportHtml(file, { includeTests: true });
    expect(html).toContain("In-situ &amp; Laboratory Test Results");
    expect(html).toContain("Standard Penetration Tests");
    expect(html).toContain("Atterberg Limits");
  });

  it("omits the test section when includeTests is false", () => {
    const html = renderFactualReportHtml(file, { includeTests: false });
    expect(html).not.toContain("In-situ &amp; Laboratory Test Results");
  });

  it("embeds borehole strip logs when includeStripLogs is true", () => {
    const html = renderFactualReportHtml(file, { includeStripLogs: true });
    expect(html).toContain("Borehole Logs");
    expect(html).toContain("<svg");
    expect(html).toContain('id="log-BH01"');
  });

  it("omits strip logs when includeStripLogs is false", () => {
    const html = renderFactualReportHtml(file, { includeStripLogs: false });
    expect(html).not.toContain("Borehole Logs");
    expect(html).not.toContain('id="log-BH01"');
  });

  it("escapes HTML-significant characters in data", () => {
    const { file: nasty } = parseStr(`"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","<script>alert(1)</script>"
`);
    const html = renderFactualReportHtml(nasty);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders from raw AGS text via the convenience wrapper", () => {
    const html = renderFactualReportFromText(AGS, "x.ags");
    expect(html).toContain("Factual Report");
    expect(html).toContain("BH01");
  });

  it("handles an empty file without throwing", () => {
    expect(() => renderFactualReportHtml(parseStr("").file)).not.toThrow();
  });
});
