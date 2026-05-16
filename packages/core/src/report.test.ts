import { describe, it, expect } from "vitest";
import { Option } from "effect";
import {
  buildGiReport,
  renderGiReportText,
  renderGiReportJson,
} from "./report.js";
import type { AgsFile } from "./model.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFile(groups: AgsFile["groups"]): AgsFile {
  return { groups, source_path: Option.none(), ags_version: Option.none() };
}

const MINIMAL_FILE = makeFile({});

const FULL_FILE = makeFile({
  PROJ: {
    name: "PROJ",
    headings: [
      { name: "PROJ_ID",   unit: "", data_type: "ID" },
      { name: "PROJ_NAME", unit: "", data_type: "X" },
      { name: "PROJ_LOC",  unit: "", data_type: "X" },
      { name: "PROJ_CLNT", unit: "", data_type: "X" },
      { name: "PROJ_CONT", unit: "", data_type: "X" },
      { name: "PROJ_ENG",  unit: "", data_type: "X" },
    ],
    rows: [{ PROJ_ID: "P001", PROJ_NAME: "Test Site", PROJ_LOC: "Test Town", PROJ_CLNT: "ACME", PROJ_CONT: "Geo Ltd", PROJ_ENG: "Dr Smith" }],
    source_line: Option.none(),
  },
  TRAN: {
    name: "TRAN",
    headings: [
      { name: "TRAN_AGS",  unit: "", data_type: "X" },
      { name: "TRAN_DATE", unit: "yyyy-mm-dd", data_type: "DT" },
      { name: "TRAN_ISSU", unit: "", data_type: "X" },
    ],
    rows: [{ TRAN_AGS: "4.1", TRAN_DATE: "2025-01-15", TRAN_ISSU: "Final" }],
    source_line: Option.none(),
  },
  LOCA: {
    name: "LOCA",
    headings: [
      { name: "LOCA_ID",   unit: "", data_type: "ID" },
      { name: "LOCA_TYPE", unit: "", data_type: "X" },
      { name: "LOCA_NATE", unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "LOCA_NATN", unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "LOCA_GL",   unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "LOCA_FDEP", unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "LOCA_STAR", unit: "yyyy-mm-dd", data_type: "DT" },
      { name: "LOCA_ENDD", unit: "yyyy-mm-dd", data_type: "DT" },
    ],
    rows: [
      { LOCA_ID: "BH01", LOCA_TYPE: "BH", LOCA_NATE: 123456.78, LOCA_NATN: 234567.89, LOCA_GL: 45.67, LOCA_FDEP: 12.0, LOCA_STAR: "2025-01-10", LOCA_ENDD: "2025-01-12" },
      { LOCA_ID: "BH02", LOCA_TYPE: "BH", LOCA_NATE: 123460.00, LOCA_NATN: 234570.00, LOCA_GL: 45.50, LOCA_FDEP: 8.5, LOCA_STAR: "2025-01-13", LOCA_ENDD: "2025-01-14" },
    ],
    source_line: Option.none(),
  },
  GEOL: {
    name: "GEOL",
    headings: [
      { name: "LOCA_ID",   unit: "", data_type: "ID" },
      { name: "GEOL_TOP",  unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "GEOL_BASE", unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "GEOL_DESC", unit: "", data_type: "X" },
      { name: "GEOL_LEG",  unit: "", data_type: "PA" },
    ],
    rows: [
      { LOCA_ID: "BH01", GEOL_TOP: 0.0, GEOL_BASE: 1.5, GEOL_DESC: "Topsoil", GEOL_LEG: "TS" },
      { LOCA_ID: "BH01", GEOL_TOP: 1.5, GEOL_BASE: 12.0, GEOL_DESC: "Sandy clay", GEOL_LEG: "CL" },
      { LOCA_ID: "BH02", GEOL_TOP: 0.0, GEOL_BASE: 1.2, GEOL_DESC: "Topsoil",   GEOL_LEG: "TS" },
      { LOCA_ID: "BH02", GEOL_TOP: 1.2, GEOL_BASE: 8.5, GEOL_DESC: "Sandy clay", GEOL_LEG: "CL" },
    ],
    source_line: Option.none(),
  },
  SAMP: {
    name: "SAMP",
    headings: [
      { name: "LOCA_ID",   unit: "", data_type: "ID" },
      { name: "SAMP_TOP",  unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "SAMP_TYPE", unit: "", data_type: "PA" },
    ],
    rows: [
      { LOCA_ID: "BH01", SAMP_TOP: 2.0, SAMP_TYPE: "U" },
      { LOCA_ID: "BH01", SAMP_TOP: 4.0, SAMP_TYPE: "U" },
      { LOCA_ID: "BH01", SAMP_TOP: 6.0, SAMP_TYPE: "D" },
      { LOCA_ID: "BH02", SAMP_TOP: 2.0, SAMP_TYPE: "U" },
    ],
    source_line: Option.none(),
  },
  ISPT: {
    name: "ISPT",
    headings: [
      { name: "LOCA_ID",   unit: "", data_type: "ID" },
      { name: "ISPT_TOP",  unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "ISPT_NVAL", unit: "blows", data_type: { _tag: "DP", n: 0 } },
    ],
    rows: [
      { LOCA_ID: "BH01", ISPT_TOP: 3.0, ISPT_NVAL: 10 },
      { LOCA_ID: "BH01", ISPT_TOP: 5.0, ISPT_NVAL: 14 },
      { LOCA_ID: "BH02", ISPT_TOP: 3.0, ISPT_NVAL: 8 },
    ],
    source_line: Option.none(),
  },
  LLPL: {
    name: "LLPL",
    headings: [
      { name: "LOCA_ID",  unit: "", data_type: "ID" },
      { name: "SAMP_TOP", unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "LLPL_LL",  unit: "%", data_type: { _tag: "DP", n: 0 } },
      { name: "LLPL_PL",  unit: "%", data_type: { _tag: "DP", n: 0 } },
      { name: "LLPL_PI",  unit: "%", data_type: { _tag: "DP", n: 0 } },
    ],
    rows: [
      { LOCA_ID: "BH01", SAMP_TOP: 2.0, LLPL_LL: 45, LLPL_PL: 22, LLPL_PI: 23 },
      { LOCA_ID: "BH02", SAMP_TOP: 2.0, LLPL_LL: 38, LLPL_PL: 19, LLPL_PI: 19 },
    ],
    source_line: Option.none(),
  },
  RDEN: {
    name: "RDEN",
    headings: [
      { name: "LOCA_ID",   unit: "", data_type: "ID" },
      { name: "SAMP_TOP",  unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "RDEN_BDEN", unit: "Mg/m3", data_type: { _tag: "DP", n: 3 } },
      { name: "RDEN_DDEN", unit: "Mg/m3", data_type: { _tag: "DP", n: 3 } },
    ],
    rows: [
      { LOCA_ID: "BH01", SAMP_TOP: 2.0, RDEN_BDEN: 1.85, RDEN_DDEN: 1.65 },
      { LOCA_ID: "BH02", SAMP_TOP: 2.0, RDEN_BDEN: 1.90, RDEN_DDEN: 1.70 },
    ],
    source_line: Option.none(),
  },
});

// ── buildGiReport ─────────────────────────────────────────────────────────────

describe("buildGiReport", () => {
  it("returns empty report for empty file", () => {
    const report = buildGiReport(MINIMAL_FILE);
    expect(report.projName).toBe("");
    expect(report.totalHoles).toBe(0);
    expect(report.loca).toHaveLength(0);
    expect(report.geolUnits).toHaveLength(0);
    expect(report.sampTypes).toHaveLength(0);
    expect(report.stats.spt).toBeNull();
  });

  it("extracts project metadata", () => {
    const report = buildGiReport(FULL_FILE);
    expect(report.projId).toBe("P001");
    expect(report.projName).toBe("Test Site");
    expect(report.projLoc).toBe("Test Town");
    expect(report.projClnt).toBe("ACME");
    expect(report.projCont).toBe("Geo Ltd");
    expect(report.projEng).toBe("Dr Smith");
    expect(report.agsVersion).toBe("4.1");
    expect(report.tranDate).toBe("2025-01-15");
    expect(report.tranIssu).toBe("Final");
  });

  it("extracts LOCA schedule", () => {
    const report = buildGiReport(FULL_FILE);
    expect(report.totalHoles).toBe(2);
    expect(report.totalDepth).toBeCloseTo(20.5);
    expect(report.loca[0]?.id).toBe("BH01");
    expect(report.loca[0]?.type).toBe("BH");
    expect(report.loca[0]?.easting).toBe("123456.78");
    expect(report.loca[0]?.fdep).toBe("12");
    expect(report.loca[0]?.startDate).toBe("2025-01-10");
    expect(report.loca[1]?.id).toBe("BH02");
  });

  it("filters out LOCA rows with empty IDs", () => {
    const file = makeFile({
      LOCA: {
        name: "LOCA",
        headings: [{ name: "LOCA_ID", unit: "", data_type: "ID" }, { name: "LOCA_FDEP", unit: "m", data_type: { _tag: "DP", n: 2 } }],
        rows: [
          { LOCA_ID: "BH01", LOCA_FDEP: 5.0 },
          { LOCA_ID: "",     LOCA_FDEP: 3.0 },
        ],
        source_line: Option.none(),
      },
    });
    const report = buildGiReport(file);
    expect(report.loca).toHaveLength(1);
  });

  it("summarises geological units sorted by depth", () => {
    const report = buildGiReport(FULL_FILE);
    expect(report.geolUnits).toHaveLength(2);
    expect(report.geolUnits[0]?.code).toBe("TS");
    expect(report.geolUnits[0]?.count).toBe(2);
    expect(report.geolUnits[0]?.minTop).toBe(0);
    expect(report.geolUnits[0]?.maxBase).toBe(1.5);
    expect(report.geolUnits[0]?.avgThickness).toBeCloseTo(1.35);
    expect(report.geolUnits[1]?.code).toBe("CL");
    expect(report.geolUnits[1]?.count).toBe(2);
  });

  it("uses GEOL_GEOL when GEOL_LEG absent", () => {
    const file = makeFile({
      GEOL: {
        name: "GEOL",
        headings: [
          { name: "LOCA_ID",   unit: "", data_type: "ID" },
          { name: "GEOL_TOP",  unit: "m", data_type: { _tag: "DP", n: 2 } },
          { name: "GEOL_BASE", unit: "m", data_type: { _tag: "DP", n: 2 } },
          { name: "GEOL_DESC", unit: "", data_type: "X" },
          { name: "GEOL_GEOL", unit: "", data_type: "X" },
        ],
        rows: [{ LOCA_ID: "BH01", GEOL_TOP: 0, GEOL_BASE: 2, GEOL_DESC: "Made ground", GEOL_GEOL: "FILL" }],
        source_line: Option.none(),
      },
    });
    const report = buildGiReport(file);
    expect(report.geolUnits[0]?.code).toBe("FILL");
  });

  it("counts sample types", () => {
    const report = buildGiReport(FULL_FILE);
    expect(report.sampTypes).toHaveLength(2);
    const u = report.sampTypes.find((t) => t.type === "U");
    const d = report.sampTypes.find((t) => t.type === "D");
    expect(u?.count).toBe(3);
    expect(d?.count).toBe(1);
    // Sorted by count descending
    expect(report.sampTypes[0]?.type).toBe("U");
  });

  it("computes SPT statistics", () => {
    const report = buildGiReport(FULL_FILE);
    const spt = report.stats.spt;
    expect(spt).not.toBeNull();
    expect(spt!.n).toBe(3);
    expect(spt!.min).toBe(8);
    expect(spt!.max).toBe(14);
    expect(spt!.mean).toBeCloseTo(10.667, 2);
    expect(spt!.std).toBeGreaterThan(0);
  });

  it("computes Atterberg statistics", () => {
    const report = buildGiReport(FULL_FILE);
    expect(report.stats.ll?.n).toBe(2);
    expect(report.stats.ll?.min).toBe(38);
    expect(report.stats.ll?.max).toBe(45);
    expect(report.stats.pl?.n).toBe(2);
    expect(report.stats.pi?.n).toBe(2);
  });

  it("derives PI when not explicitly stored", () => {
    const file = makeFile({
      LLPL: {
        name: "LLPL",
        headings: [
          { name: "LOCA_ID",  unit: "", data_type: "ID" },
          { name: "SAMP_TOP", unit: "m", data_type: { _tag: "DP", n: 2 } },
          { name: "LLPL_LL",  unit: "%", data_type: { _tag: "DP", n: 0 } },
          { name: "LLPL_PL",  unit: "%", data_type: { _tag: "DP", n: 0 } },
        ],
        rows: [{ LOCA_ID: "BH01", SAMP_TOP: 2.0, LLPL_LL: 50, LLPL_PL: 20 }],
        source_line: Option.none(),
      },
    });
    const report = buildGiReport(file);
    expect(report.stats.pi?.n).toBe(1);
    expect(report.stats.pi?.mean).toBeCloseTo(30);
  });

  it("computes density statistics", () => {
    const report = buildGiReport(FULL_FILE);
    expect(report.stats.bulkDensity?.n).toBe(2);
    expect(report.stats.bulkDensity?.mean).toBeCloseTo(1.875, 3);
    expect(report.stats.dryDensity?.n).toBe(2);
  });

  it("returns null stats when groups absent", () => {
    const report = buildGiReport(MINIMAL_FILE);
    expect(report.stats.spt).toBeNull();
    expect(report.stats.ll).toBeNull();
    expect(report.stats.cu).toBeNull();
    expect(report.stats.bulkDensity).toBeNull();
  });

  it("collects Cu from TCON group", () => {
    const file = makeFile({
      TCON: {
        name: "TCON",
        headings: [
          { name: "LOCA_ID",  unit: "", data_type: "ID" },
          { name: "SAMP_TOP", unit: "m", data_type: { _tag: "DP", n: 2 } },
          { name: "TCON_CU",  unit: "kPa", data_type: { _tag: "DP", n: 1 } },
        ],
        rows: [
          { LOCA_ID: "BH01", SAMP_TOP: 2.0, TCON_CU: 75.0 },
          { LOCA_ID: "BH02", SAMP_TOP: 2.0, TCON_CU: 95.0 },
        ],
        source_line: Option.none(),
      },
    });
    const report = buildGiReport(file);
    expect(report.stats.cu?.n).toBe(2);
    expect(report.stats.cu?.mean).toBeCloseTo(85.0);
  });
});

// ── renderGiReportText ────────────────────────────────────────────────────────

describe("renderGiReportText", () => {
  it("produces a non-empty text report for empty file", () => {
    const report = buildGiReport(MINIMAL_FILE);
    const text = renderGiReportText(report);
    expect(text).toContain("GI Factual Report");
    expect(text).toContain("Exploratory holes: 0");
  });

  it("includes file path in header when provided", () => {
    const report = buildGiReport(MINIMAL_FILE);
    const text = renderGiReportText(report, "/path/to/test.ags");
    expect(text).toContain("/path/to/test.ags");
  });

  it("includes project metadata", () => {
    const report = buildGiReport(FULL_FILE);
    const text = renderGiReportText(report);
    expect(text).toContain("Test Site");
    expect(text).toContain("ACME");
    expect(text).toContain("4.1");
  });

  it("includes borehole schedule", () => {
    const report = buildGiReport(FULL_FILE);
    const text = renderGiReportText(report);
    expect(text).toContain("BH01");
    expect(text).toContain("BH02");
    expect(text).toContain("Schedule of Exploratory Holes");
  });

  it("includes geology summary", () => {
    const report = buildGiReport(FULL_FILE);
    const text = renderGiReportText(report);
    expect(text).toContain("Geological Units");
    expect(text).toContain("TS");
    expect(text).toContain("CL");
  });

  it("includes sample inventory", () => {
    const report = buildGiReport(FULL_FILE);
    const text = renderGiReportText(report);
    expect(text).toContain("Sample Inventory");
    expect(text).toContain("3"); // 3 U samples
  });

  it("includes statistical summaries", () => {
    const report = buildGiReport(FULL_FILE);
    const text = renderGiReportText(report);
    expect(text).toContain("Statistical Summary");
    expect(text).toContain("SPT N-value");
    expect(text).toContain("Liquid limit");
    expect(text).toContain("Bulk density");
  });

  it("omits statistical section when no test data", () => {
    const report = buildGiReport(MINIMAL_FILE);
    const text = renderGiReportText(report);
    expect(text).not.toContain("Statistical Summary");
  });
});

// ── renderGiReportJson ────────────────────────────────────────────────────────

describe("renderGiReportJson", () => {
  it("produces valid JSON", () => {
    const report = buildGiReport(FULL_FILE);
    const json = renderGiReportJson(report);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("includes all top-level fields", () => {
    const report = buildGiReport(FULL_FILE);
    const parsed = JSON.parse(renderGiReportJson(report));
    expect(parsed).toHaveProperty("projName", "Test Site");
    expect(parsed).toHaveProperty("totalHoles", 2);
    expect(parsed).toHaveProperty("loca");
    expect(parsed).toHaveProperty("geolUnits");
    expect(parsed).toHaveProperty("sampTypes");
    expect(parsed).toHaveProperty("stats");
    expect(Array.isArray(parsed.loca)).toBe(true);
    expect(parsed.loca).toHaveLength(2);
  });

  it("stats fields are null or objects", () => {
    const report = buildGiReport(MINIMAL_FILE);
    const parsed = JSON.parse(renderGiReportJson(report));
    expect(parsed.stats.spt).toBeNull();
    expect(parsed.stats.ll).toBeNull();
  });

  it("stats objects have required numeric fields", () => {
    const report = buildGiReport(FULL_FILE);
    const parsed = JSON.parse(renderGiReportJson(report));
    const spt = parsed.stats.spt;
    expect(typeof spt.n).toBe("number");
    expect(typeof spt.min).toBe("number");
    expect(typeof spt.max).toBe("number");
    expect(typeof spt.mean).toBe("number");
    expect(typeof spt.std).toBe("number");
  });
});
