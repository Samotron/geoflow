/**
 * Factual report — a complete self-contained HTML ground investigation
 * factual report combining, in one document:
 *
 *   1. Title block / project metadata
 *   2. Schedule of exploratory holes
 *   3. Geological summary
 *   4. Sample inventory
 *   5. Statistical summary of test results
 *   6. Detailed in-situ and laboratory test result tables ("tests")
 *   7. Borehole strip logs ("logs") — BS 5930 / AGS-convention SVG
 *
 * The report data is built on `buildGiReport` (project / schedule / geology
 * / stats) and the strip logs are produced by `renderBoreholeLogs` so the
 * report and the HTML explorer stay byte-for-byte consistent.
 */

import { Option } from "effect";
import type { AgsFile, AgsRow, AgsGroup } from "./model.js";
import { buildGiReport } from "./report.js";
import type { GiReport } from "./report.js";
import { renderBoreholeLogs } from "./explorer.js";
import { parseStr, decodeBytes } from "./ags/parser.js";

// ── Curated test groups ───────────────────────────────────────────────────────

/**
 * Test groups rendered as detailed tables in the "Test Results" section.
 * `depthCandidates` are tried in order to find a depth column to display;
 * `resultCols` are the result columns shown after LOCA_ID and depth.
 */
interface TestGroupSpec {
  group: string;
  label: string;
  category: "in-situ" | "laboratory";
  depthCandidates: string[];
  resultCols: string[];
}

const TEST_GROUPS: TestGroupSpec[] = [
  // ── In-situ tests ──
  { group: "ISPT", label: "Standard Penetration Tests (SPT)", category: "in-situ",
    depthCandidates: ["ISPT_TOP", "ISPT_DPTH"], resultCols: ["ISPT_TESN", "ISPT_NVAL", "ISPT_SEAT", "ISPT_MAIN", "ISPT_REP"] },
  { group: "IPRM", label: "In-situ Permeability", category: "in-situ",
    depthCandidates: ["IPRM_TOP", "IPRM_DPTH"], resultCols: ["IPRM_BASE", "IPRM_TYPE", "IPRM_KVAL"] },
  { group: "ICBR", label: "In-situ California Bearing Ratio", category: "in-situ",
    depthCandidates: ["ICBR_TOP", "ICBR_DPTH"], resultCols: ["ICBR_CBR", "ICBR_SURC"] },
  { group: "IDEN", label: "In-situ Density", category: "in-situ",
    depthCandidates: ["IDEN_TOP", "IDEN_DPTH"], resultCols: ["IDEN_BDEN", "IDEN_DDEN", "IDEN_MC"] },
  { group: "DPRG", label: "Dynamic Probe", category: "in-situ",
    depthCandidates: ["DPRG_TOP", "DPRG_DPTH"], resultCols: ["DPRG_TYPE", "DPRG_RES"] },
  { group: "WSTK", label: "Water Strikes", category: "in-situ",
    depthCandidates: ["WSTK_DPTH"], resultCols: ["WSTK_TIME", "WSTK_CASG", "WSTK_REM"] },
  // ── Laboratory tests ──
  { group: "LLPL", label: "Atterberg Limits", category: "laboratory",
    depthCandidates: ["SPEC_DPTH", "LLPL_TOP", "SAMP_TOP"], resultCols: ["LLPL_LL", "LLPL_PL", "LLPL_PI", "LLPL_425"] },
  { group: "LNMC", label: "Moisture Content", category: "laboratory",
    depthCandidates: ["SPEC_DPTH", "LNMC_TOP", "SAMP_TOP"], resultCols: ["LNMC_MC"] },
  { group: "GRAG", label: "Particle Size Distribution", category: "laboratory",
    depthCandidates: ["SPEC_DPTH", "GRAG_TOP", "SAMP_TOP"], resultCols: ["GRAG_UC", "GRAG_D10", "GRAG_D60", "GRAG_VCRE"] },
  { group: "RDEN", label: "Bulk & Dry Density", category: "laboratory",
    depthCandidates: ["SPEC_DPTH", "RDEN_TOP", "SAMP_TOP"], resultCols: ["RDEN_BDEN", "RDEN_DDEN"] },
  { group: "TCON", label: "Triaxial — Consolidated", category: "laboratory",
    depthCandidates: ["SPEC_DPTH", "TCON_TOP", "SAMP_TOP"], resultCols: ["TCON_TYPE", "TCON_CU", "TCON_PHI", "TCON_COH"] },
  { group: "TNPC", label: "Pocket Penetrometer", category: "laboratory",
    depthCandidates: ["SPEC_DPTH", "TNPC_TOP", "SAMP_TOP"], resultCols: ["TNPC_CU"] },
  { group: "VANE", label: "Laboratory Vane", category: "laboratory",
    depthCandidates: ["SPEC_DPTH", "VANE_TOP", "SAMP_TOP"], resultCols: ["VANE_CU", "VANE_REM"] },
  { group: "CMPG", label: "Compaction", category: "laboratory",
    depthCandidates: ["SPEC_DPTH", "CMPG_TOP", "SAMP_TOP"], resultCols: ["CMPG_MAXD", "CMPG_MCOP"] },
  { group: "DSSG", label: "Shear Box", category: "laboratory",
    depthCandidates: ["SPEC_DPTH", "DSSG_TOP", "SAMP_TOP"], resultCols: ["DSSG_PHIP", "DSSG_COHP", "DSSG_PHIR", "DSSG_COHR"] },
  { group: "CHOC", label: "Chemical — Organic Content", category: "laboratory",
    depthCandidates: ["SPEC_DPTH", "SAMP_TOP"], resultCols: ["CHOC_OC", "CHOC_TYPE"] },
];

// ── Public types ──────────────────────────────────────────────────────────────

export interface FactualReportOptions {
  sourcePath?: string;
  /** Embed BS 5930 strip logs. Default true. */
  includeStripLogs?: boolean;
  /** Embed detailed in-situ / laboratory test tables. Default true. */
  includeTests?: boolean;
}

export interface TestTable {
  group: string;
  label: string;
  category: "in-situ" | "laboratory";
  columns: string[];
  rows: string[][];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cell(row: AgsRow, key: string): string {
  const v = row[key];
  return v == null ? "" : String(v);
}

function pickDepthColumn(group: AgsGroup, candidates: string[]): string | null {
  const headingNames = new Set(group.headings.map((h) => h.name));
  for (const c of candidates) {
    if (headingNames.has(c)) return c;
  }
  return null;
}

/**
 * Build the detailed test-result tables for every curated test group present
 * in the file. Result columns absent from a group are silently dropped.
 */
export function buildTestTables(file: AgsFile): TestTable[] {
  const tables: TestTable[] = [];
  for (const spec of TEST_GROUPS) {
    const group = file.groups[spec.group];
    if (!group || group.rows.length === 0) continue;

    const headingNames = new Set(group.headings.map((h) => h.name));
    const depthCol = pickDepthColumn(group, spec.depthCandidates);
    const presentResultCols = spec.resultCols.filter((c) => headingNames.has(c));
    const hasLoca = headingNames.has("LOCA_ID");

    const columns: string[] = [];
    if (hasLoca) columns.push("LOCA_ID");
    if (depthCol) columns.push(depthCol);
    columns.push(...presentResultCols);
    if (columns.length === 0) continue;

    const rows = group.rows.map((r) => columns.map((c) => cell(r, c)));
    tables.push({
      group: spec.group,
      label: spec.label,
      category: spec.category,
      columns,
      rows,
    });
  }
  return tables;
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function renderTitleBlock(report: GiReport, sourcePath: string, generatedAt: string): string {
  const allMeta: Array<[string, string]> = [
    ["Project name", report.projName],
    ["Project ref.", report.projId],
    ["Location", report.projLoc],
    ["Client", report.projClnt],
    ["Contractor", report.projCont],
    ["Engineer", report.projEng],
    ["AGS version", report.agsVersion],
    ["Data transfer date", report.tranDate],
    ["Source file", sourcePath],
    ["Report generated", generatedAt],
  ];
  const meta = allMeta.filter(([, v]) => v && v.length > 0);

  return `
  <section class="cover">
    <p class="doc-kind">Ground Investigation</p>
    <h1>Factual Report</h1>
    <h2 class="proj-title">${esc(report.projName || "Untitled project")}</h2>
    <table class="meta">
      <tbody>
        ${meta.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("\n        ")}
      </tbody>
    </table>
    <p class="headline">
      <strong>${report.totalHoles}</strong> exploratory hole${report.totalHoles !== 1 ? "s" : ""}
      &nbsp;·&nbsp; <strong>${report.totalDepth.toFixed(1)} m</strong> total depth drilled
    </p>
  </section>`;
}

function renderScheduleSection(report: GiReport): string {
  if (report.loca.length === 0) return "";
  const hasE = report.loca.some((l) => l.easting);
  const hasN = report.loca.some((l) => l.northing);
  const hasGl = report.loca.some((l) => l.gl);
  const hasDates = report.loca.some((l) => l.startDate);

  const headCols = ["Hole ID", "Type"];
  if (hasE) headCols.push("Easting");
  if (hasN) headCols.push("Northing");
  if (hasGl) headCols.push("GL (m OD)");
  headCols.push("Final depth (m)");
  if (hasDates) { headCols.push("Started"); headCols.push("Completed"); }

  const bodyRows = report.loca.map((l) => {
    const cells = [esc(l.id), esc(l.type || "—")];
    if (hasE) cells.push(esc(l.easting || "—"));
    if (hasN) cells.push(esc(l.northing || "—"));
    if (hasGl) cells.push(esc(l.gl || "—"));
    cells.push(esc(l.fdep || "—"));
    if (hasDates) { cells.push(esc(l.startDate || "—")); cells.push(esc(l.endDate || "—")); }
    return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  }).join("\n      ");

  return `
  <section id="schedule">
    <h2>1. Schedule of Exploratory Holes</h2>
    <table class="data">
      <thead><tr>${headCols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>
      ${bodyRows}
      </tbody>
    </table>
  </section>`;
}

function renderGeologySection(report: GiReport): string {
  if (report.geolUnits.length === 0) return "";
  const bodyRows = report.geolUnits.map((g) => {
    const minTop = isFinite(g.minTop) ? g.minTop.toFixed(2) : "—";
    const maxBase = isFinite(g.maxBase) && g.maxBase > -Infinity ? g.maxBase.toFixed(2) : "—";
    return `<tr>
        <td>${esc(g.code)}</td>
        <td>${esc(g.description)}</td>
        <td class="num">${g.count}</td>
        <td class="num">${minTop}</td>
        <td class="num">${maxBase}</td>
        <td class="num">${g.avgThickness.toFixed(2)}</td>
      </tr>`;
  }).join("\n      ");

  return `
  <section id="geology">
    <h2>2. Geological Units Encountered</h2>
    <table class="data">
      <thead><tr>
        <th>Code</th><th>Description</th><th>Layers</th>
        <th>Min top (m)</th><th>Max base (m)</th><th>Mean thickness (m)</th>
      </tr></thead>
      <tbody>
      ${bodyRows}
      </tbody>
    </table>
  </section>`;
}

function renderSampleAndStatsSection(report: GiReport): string {
  const parts: string[] = [];

  if (report.sampTypes.length > 0) {
    const rows = report.sampTypes
      .map((s) => `<tr><td>${esc(s.type)}</td><td class="num">${s.count}</td></tr>`)
      .join("\n        ");
    parts.push(`
    <h3>3.1 Sample Inventory</h3>
    <table class="data narrow">
      <thead><tr><th>Sample type</th><th>Count</th></tr></thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`);
  }

  const st = report.stats;
  const statRows: Array<[string, typeof st.spt, number]> = [
    ["SPT N-value (blows/300mm)", st.spt, 1],
    ["Liquid limit (%)", st.ll, 1],
    ["Plastic limit (%)", st.pl, 1],
    ["Plasticity index (%)", st.pi, 1],
    ["Moisture content (%)", st.moisture, 1],
    ["Undrained shear strength (kPa)", st.cu, 1],
    ["Bulk density (Mg/m³)", st.bulkDensity, 3],
    ["Dry density (Mg/m³)", st.dryDensity, 3],
  ];
  const present = statRows.filter(([, s]) => s !== null);
  if (present.length > 0) {
    const rows = present.map(([label, s, dp]) => {
      const v = s!;
      return `<tr>
        <td>${esc(label)}</td>
        <td class="num">${v.n}</td>
        <td class="num">${v.min.toFixed(dp)}</td>
        <td class="num">${v.max.toFixed(dp)}</td>
        <td class="num">${v.mean.toFixed(dp)}</td>
        <td class="num">${v.std.toFixed(dp)}</td>
      </tr>`;
    }).join("\n        ");
    parts.push(`
    <h3>3.2 Statistical Summary of Test Results</h3>
    <table class="data">
      <thead><tr>
        <th>Parameter</th><th>n</th><th>Min</th><th>Max</th><th>Mean</th><th>Std dev</th>
      </tr></thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`);
  }

  if (parts.length === 0) return "";
  return `
  <section id="samples">
    <h2>3. Samples &amp; Test Statistics</h2>
    ${parts.join("\n")}
  </section>`;
}

function renderTestTablesSection(tables: TestTable[]): string {
  if (tables.length === 0) {
    return `
  <section id="tests">
    <h2>4. In-situ &amp; Laboratory Test Results</h2>
    <p class="empty">No recognised in-situ or laboratory test groups in this file.</p>
  </section>`;
  }

  const renderOne = (t: TestTable, ix: number): string => {
    const head = t.columns.map((c) => `<th>${esc(c)}</th>`).join("");
    const body = t.rows.map((r) =>
      `<tr>${r.map((v, i) => `<td${i === 0 ? "" : ' class="num"'}>${esc(v || "—")}</td>`).join("")}</tr>`
    ).join("\n        ");
    return `
    <h3>4.${ix + 1} ${esc(t.label)} <span class="grp">${esc(t.group)}</span> <span class="cat">${esc(t.category)}</span></h3>
    <table class="data test">
      <thead><tr>${head}</tr></thead>
      <tbody>
        ${body}
      </tbody>
    </table>
    <p class="count">${t.rows.length} record${t.rows.length !== 1 ? "s" : ""}</p>`;
  };

  return `
  <section id="tests">
    <h2>4. In-situ &amp; Laboratory Test Results</h2>
    ${tables.map(renderOne).join("\n")}
  </section>`;
}

function renderStripLogsSection(file: AgsFile): string {
  const logs = renderBoreholeLogs(file);
  if (logs.length === 0) {
    return `
  <section id="logs">
    <h2>5. Borehole Logs</h2>
    <p class="empty">No exploratory holes with loggable data.</p>
  </section>`;
  }
  const sections = logs.map((log) => `
    <div class="log" id="log-${esc(log.locaId)}">
      <h3>${esc(log.locaId)}</h3>
      ${log.svg}
    </div>`).join("\n");
  return `
  <section id="logs">
    <h2>5. Borehole Logs</h2>
    <p class="note">Strip logs follow BS 5930 / AGS column conventions.</p>
    ${sections}
  </section>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render the complete factual report as a single self-contained HTML string.
 */
export function renderFactualReportHtml(
  file: AgsFile,
  options: FactualReportOptions = {},
): string {
  const sourcePath = options.sourcePath ??
    (Option.isSome(file.source_path) ? file.source_path.value : "In-memory");
  const includeStripLogs = options.includeStripLogs ?? true;
  const includeTests = options.includeTests ?? true;
  const generatedAt = new Date().toISOString().slice(0, 10);

  const report = buildGiReport(file);
  const testTables = includeTests ? buildTestTables(file) : [];

  // Contents list — section numbers match the rendered headings.
  const contents: Array<[string, string]> = [
    ["#schedule", "1. Schedule of Exploratory Holes"],
    ["#geology", "2. Geological Units Encountered"],
    ["#samples", "3. Samples & Test Statistics"],
  ];
  if (includeTests) contents.push(["#tests", "4. In-situ & Laboratory Test Results"]);
  if (includeStripLogs) contents.push(["#logs", "5. Borehole Logs"]);

  const body = [
    renderTitleBlock(report, sourcePath, generatedAt),
    `<nav class="toc"><h2>Contents</h2><ol>${
      contents.map(([href, label]) => `<li><a href="${href}">${esc(label)}</a></li>`).join("")
    }</ol></nav>`,
    renderScheduleSection(report),
    renderGeologySection(report),
    renderSampleAndStatsSection(report),
    includeTests ? renderTestTablesSection(testTables) : "",
    includeStripLogs ? renderStripLogsSection(file) : "",
  ].filter((s) => s.length > 0).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Factual Report — ${esc(report.projName || sourcePath)}</title>
<style>
  :root { font-family: "Helvetica Neue", Arial, sans-serif; color: #1f2937; }
  * { box-sizing: border-box; }
  body { max-width: 1000px; margin: 0 auto; padding: 1.5rem 2rem 4rem; background: #fff; }
  h1 { font-size: 2.4rem; color: #0f172a; margin: .2rem 0; letter-spacing: -0.5px; }
  h2 { font-size: 1.3rem; color: #1e3a5f; border-bottom: 2px solid #1e3a5f; padding-bottom: .3rem; margin-top: 2.5rem; }
  h3 { font-size: 1.02rem; color: #1e40af; margin-top: 1.6rem; }
  h3 .grp { font-family: ui-monospace, monospace; font-size: .75rem; background: #e8eef9; color: #1e40af; padding: 1px 7px; border-radius: 4px; margin-left: .3rem; }
  h3 .cat { font-size: .7rem; text-transform: uppercase; letter-spacing: .5px; color: #64748b; margin-left: .2rem; }
  .cover { border-bottom: 3px double #1e3a5f; padding-bottom: 1.4rem; margin-bottom: 1rem; }
  .doc-kind { text-transform: uppercase; letter-spacing: 3px; font-size: .8rem; color: #64748b; font-weight: 700; margin: 0; }
  .proj-title { font-size: 1.3rem; color: #475569; font-weight: 600; margin: .2rem 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin: .6rem 0; }
  table.meta { width: auto; }
  table.meta th, table.meta td { border: none; padding: .2rem 1.4rem .2rem 0; text-align: left; font-size: .92rem; }
  table.meta th { color: #64748b; font-weight: 600; }
  table.data th, table.data td { border: 1px solid #cbd5e1; padding: .35rem .6rem; font-size: .85rem; text-align: left; }
  table.data th { background: #1e3a5f; color: #fff; font-weight: 600; white-space: nowrap; }
  table.data tr:nth-child(even) td { background: #f1f5f9; }
  table.data td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.data.narrow { width: auto; }
  table.data.test { font-size: .8rem; }
  .headline { font-size: 1.05rem; margin-top: 1rem; color: #334155; }
  .count { font-size: .78rem; color: #64748b; margin: .2rem 0 0; }
  .note, .empty { font-size: .85rem; color: #64748b; }
  .empty { font-style: italic; }
  nav.toc { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: .4rem; padding: .6rem 1.4rem 1rem; margin: 1.4rem 0; }
  nav.toc h2 { font-size: 1rem; border: none; margin: .4rem 0; }
  nav.toc ol { margin: 0; padding-left: 1.4rem; }
  nav.toc a { color: #1e40af; text-decoration: none; }
  nav.toc a:hover { text-decoration: underline; }
  .log { margin-top: 1.6rem; page-break-inside: avoid; }
  .log h3 { margin-bottom: .4rem; }
  .log svg { max-width: 100%; height: auto; border: 1px solid #e2e8f0; }
  footer { margin-top: 3rem; border-top: 1px solid #e2e8f0; padding-top: .8rem; font-size: .75rem; color: #94a3b8; }
  @media print {
    body { max-width: none; padding: 0; }
    h2 { page-break-after: avoid; }
    section { page-break-before: auto; }
    #logs .log { page-break-before: always; }
  }
</style>
</head>
<body>
${body}
<footer>
  Generated by GeoFlow on ${esc(generatedAt)} from ${esc(sourcePath)}.
  This is a factual report; it presents data without interpretation.
</footer>
</body>
</html>`;
}

export function renderFactualReportFromText(text: string, sourcePath?: string): string {
  const { file } = parseStr(text);
  const opts: FactualReportOptions = sourcePath !== undefined ? { sourcePath } : {};
  return renderFactualReportHtml(file, opts);
}

export function renderFactualReportFromBytes(bytes: Uint8Array, sourcePath?: string): string {
  return renderFactualReportFromText(decodeBytes(bytes), sourcePath);
}
