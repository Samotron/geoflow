/**
 * GI Factual Report — extracts project metadata, borehole schedule,
 * geological summary and statistical test summaries from an AgsFile.
 */

import { Option } from "effect";
import type { AgsFile, AgsRow } from "./model.js";

// ── Public types ───────────────────────────────────────────────────────────────

export interface GiStats {
  n: number;
  min: number;
  max: number;
  mean: number;
  std: number;
}

export interface GiLocaRow {
  id: string;
  type: string;
  easting: string;
  northing: string;
  lat: string;
  lon: string;
  gl: string;
  fdep: string;
  startDate: string;
  endDate: string;
  term: string;
}

export interface GiGeolUnit {
  code: string;
  description: string;
  count: number;
  minTop: number;
  maxBase: number;
  avgThickness: number;
}

export interface GiSampType {
  type: string;
  count: number;
}

export interface GiTestStats {
  spt: GiStats | null;
  ll: GiStats | null;
  pl: GiStats | null;
  pi: GiStats | null;
  moisture: GiStats | null;
  cu: GiStats | null;
  bulkDensity: GiStats | null;
  dryDensity: GiStats | null;
}

export interface GiReport {
  projId: string;
  projName: string;
  projLoc: string;
  projClnt: string;
  projCont: string;
  projEng: string;
  agsVersion: string;
  tranDate: string;
  tranIssu: string;
  totalHoles: number;
  totalDepth: number;
  loca: GiLocaRow[];
  geolUnits: GiGeolUnit[];
  sampTypes: GiSampType[];
  stats: GiTestStats;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function s(row: AgsRow, key: string): string {
  return String(row[key] ?? "").trim();
}

function n(row: AgsRow, key: string): number | null {
  const v = row[key];
  if (v == null) return null;
  const parsed = parseFloat(String(v));
  return isNaN(parsed) ? null : parsed;
}

function computeStats(values: number[]): GiStats | null {
  const vs = values.filter((v) => isFinite(v));
  if (vs.length === 0) return null;
  const count = vs.length;
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const mean = vs.reduce((a, b) => a + b, 0) / count;
  const variance = count > 1 ? vs.reduce((a, b) => a + (b - mean) ** 2, 0) / (count - 1) : 0;
  return { n: count, min, max, mean, std: Math.sqrt(variance) };
}

// ── Extractors ─────────────────────────────────────────────────────────────────

function extractProjectInfo(file: AgsFile) {
  const p = (file.groups["PROJ"]?.rows[0] ?? {}) as AgsRow;
  const t = (file.groups["TRAN"]?.rows[0] ?? {}) as AgsRow;
  return {
    projId:      s(p, "PROJ_ID"),
    projName:    s(p, "PROJ_NAME"),
    projLoc:     s(p, "PROJ_LOC"),
    projClnt:    s(p, "PROJ_CLNT"),
    projCont:    s(p, "PROJ_CONT"),
    projEng:     s(p, "PROJ_ENG"),
    agsVersion:  s(t, "TRAN_AGS") || s(t, "TRAN_RELE") || Option.getOrElse(file.ags_version, () => ""),
    tranDate:    s(t, "TRAN_DATE"),
    tranIssu:    s(t, "TRAN_ISSU"),
  };
}

function extractLoca(file: AgsFile): GiLocaRow[] {
  return (file.groups["LOCA"]?.rows ?? [])
    .map((r) => ({
      id:        s(r, "LOCA_ID"),
      type:      s(r, "LOCA_TYPE"),
      easting:   s(r, "LOCA_NATE"),
      northing:  s(r, "LOCA_NATN"),
      lat:       s(r, "LOCA_LAT"),
      lon:       s(r, "LOCA_LON"),
      gl:        s(r, "LOCA_GL"),
      fdep:      s(r, "LOCA_FDEP"),
      startDate: s(r, "LOCA_STAR"),
      endDate:   s(r, "LOCA_ENDD"),
      term:      s(r, "LOCA_TERM"),
    }))
    .filter((r) => r.id.length > 0);
}

function extractGeolSummary(file: AgsFile): GiGeolUnit[] {
  const map = new Map<string, GiGeolUnit>();
  for (const r of file.groups["GEOL"]?.rows ?? []) {
    const code = s(r, "GEOL_LEG") || s(r, "GEOL_GEOL") || s(r, "GEOL_DESC").slice(0, 30);
    const desc = s(r, "GEOL_DESC");
    const top  = n(r, "GEOL_TOP");
    const base = n(r, "GEOL_BASE");
    if (!code) continue;
    const existing = map.get(code);
    const thickness = top != null && base != null ? base - top : 0;
    if (existing) {
      existing.count++;
      if (top != null)  existing.minTop  = Math.min(existing.minTop, top);
      if (base != null) existing.maxBase = Math.max(existing.maxBase, base);
      existing.avgThickness += thickness;
    } else {
      map.set(code, {
        code, description: desc, count: 1,
        minTop:  top  ?? Infinity,
        maxBase: base ?? -Infinity,
        avgThickness: thickness,
      });
    }
  }
  // Finalise avgThickness
  for (const unit of map.values()) {
    if (unit.count > 0) unit.avgThickness = unit.avgThickness / unit.count;
  }
  return [...map.values()].sort((a, b) => {
    const at = isFinite(a.minTop) ? a.minTop : 9999;
    const bt = isFinite(b.minTop) ? b.minTop : 9999;
    return at - bt;
  });
}

function extractSampTypes(file: AgsFile): GiSampType[] {
  const map = new Map<string, number>();
  for (const r of file.groups["SAMP"]?.rows ?? []) {
    const t = s(r, "SAMP_TYPE") || "?";
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
}

function extractCuValues(file: AgsFile): number[] {
  const vals: number[] = [];
  // TCON (triaxial compression)
  for (const r of file.groups["TCON"]?.rows ?? []) {
    const v = n(r, "TCON_CU");
    if (v != null && v > 0) vals.push(v);
  }
  // TNPC (pocket penetrometer)
  for (const r of file.groups["TNPC"]?.rows ?? []) {
    const v = n(r, "TNPC_CU");
    if (v != null && v > 0) vals.push(v);
  }
  // VANE
  for (const r of file.groups["VANE"]?.rows ?? []) {
    const v = n(r, "VANE_CU");
    if (v != null && v > 0) vals.push(v);
  }
  return vals;
}

function computeTestStats(file: AgsFile): GiTestStats {
  const sptVals   = (file.groups["ISPT"]?.rows ?? []).flatMap((r) => { const v = n(r, "ISPT_NVAL"); return v != null ? [v] : []; });
  const llVals    = (file.groups["LLPL"]?.rows ?? []).flatMap((r) => { const v = n(r, "LLPL_LL");   return v != null ? [v] : []; });
  const plVals    = (file.groups["LLPL"]?.rows ?? []).flatMap((r) => { const v = n(r, "LLPL_PL");   return v != null ? [v] : []; });
  const piVals: number[] = [];
  for (const r of file.groups["LLPL"]?.rows ?? []) {
    let v = n(r, "LLPL_PI");
    if (v == null) { const ll = n(r, "LLPL_LL"); const pl = n(r, "LLPL_PL"); if (ll != null && pl != null) v = ll - pl; }
    if (v != null) piVals.push(v);
  }
  const mcVals    = (file.groups["LNMC"]?.rows ?? []).flatMap((r) => { const v = n(r, "LNMC_MC"); return v != null ? [v] : []; });
  const bulkVals  = (file.groups["RDEN"]?.rows ?? []).flatMap((r) => { const v = n(r, "RDEN_BDEN"); return v != null ? [v] : []; });
  const dryVals   = (file.groups["RDEN"]?.rows ?? []).flatMap((r) => { const v = n(r, "RDEN_DDEN"); return v != null ? [v] : []; });
  const cuVals    = extractCuValues(file);

  return {
    spt:         computeStats(sptVals),
    ll:          computeStats(llVals),
    pl:          computeStats(plVals),
    pi:          computeStats(piVals),
    moisture:    computeStats(mcVals),
    cu:          computeStats(cuVals),
    bulkDensity: computeStats(bulkVals),
    dryDensity:  computeStats(dryVals),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function buildGiReport(file: AgsFile): GiReport {
  const proj = extractProjectInfo(file);
  const loca = extractLoca(file);
  const totalDepth = loca.reduce((sum, l) => sum + (parseFloat(l.fdep) || 0), 0);
  return {
    ...proj,
    totalHoles: loca.length,
    totalDepth,
    loca,
    geolUnits:  extractGeolSummary(file),
    sampTypes:  extractSampTypes(file),
    stats:      computeTestStats(file),
  };
}

// ── Text renderer ──────────────────────────────────────────────────────────────

function fmt(v: number, dp = 1): string {
  return v.toFixed(dp);
}

function fmtStats(st: GiStats | null, dp = 1): string {
  if (!st) return "  n/a";
  return `  n=${st.n}  min=${fmt(st.min, dp)}  max=${fmt(st.max, dp)}  mean=${fmt(st.mean, dp)}  std=${fmt(st.std, dp)}`;
}

export function renderGiReportText(report: GiReport, filePath?: string): string {
  const header = filePath ? `GI Factual Report — ${filePath}` : "GI Factual Report";
  const line   = "=".repeat(header.length);
  const lines: string[] = [header, line, ""];

  // Project metadata
  if (report.projName) lines.push(`Project:  ${report.projName}`);
  if (report.projLoc)  lines.push(`Location: ${report.projLoc}`);
  if (report.projId)   lines.push(`Ref:      ${report.projId}`);
  if (report.projClnt) lines.push(`Client:   ${report.projClnt}`);
  if (report.projCont) lines.push(`Contractor: ${report.projCont}`);
  if (report.projEng)  lines.push(`Engineer: ${report.projEng}`);
  if (report.agsVersion) lines.push(`AGS ver:  ${report.agsVersion}`);
  if (report.tranDate)   lines.push(`Transfer: ${report.tranDate}`);
  lines.push("");

  // Borehole summary
  lines.push(`Exploratory holes: ${report.totalHoles}  Total depth drilled: ${fmt(report.totalDepth)} m`);
  lines.push("");

  // LOCA schedule
  if (report.loca.length > 0) {
    lines.push("Schedule of Exploratory Holes");
    lines.push("-".repeat(50));
    const hasE = report.loca.some((l) => l.easting);
    const hasN = report.loca.some((l) => l.northing);
    const hasLatLon = report.loca.some((l) => l.lat);
    const hasGl = report.loca.some((l) => l.gl);
    const hasDates = report.loca.some((l) => l.startDate);
    const cols: string[] = ["Hole ID", "Type"];
    if (hasE) cols.push("Easting");
    if (hasN) cols.push("Northing");
    if (hasLatLon) { cols.push("Lat"); cols.push("Lon"); }
    if (hasGl) cols.push("GL (mOD)");
    cols.push("Depth (m)");
    if (hasDates) { cols.push("Start"); cols.push("End"); }
    lines.push(cols.map((c) => c.padEnd(12)).join("  "));
    for (const l of report.loca) {
      const row: string[] = [l.id, l.type || "—"];
      if (hasE) row.push(l.easting || "—");
      if (hasN) row.push(l.northing || "—");
      if (hasLatLon) { row.push(l.lat || "—"); row.push(l.lon || "—"); }
      if (hasGl) row.push(l.gl || "—");
      row.push(l.fdep || "—");
      if (hasDates) { row.push(l.startDate || "—"); row.push(l.endDate || "—"); }
      lines.push(row.map((c) => c.padEnd(12)).join("  "));
    }
    lines.push("");
  }

  // GEOL summary
  if (report.geolUnits.length > 0) {
    lines.push("Geological Units Encountered");
    lines.push("-".repeat(50));
    lines.push("Code          Description                    Count  MinTop   MaxBase  AvgThk");
    for (const g of report.geolUnits) {
      const minTop = isFinite(g.minTop) ? fmt(g.minTop, 2) : "—";
      const maxBase = isFinite(g.maxBase) && g.maxBase > -Infinity ? fmt(g.maxBase, 2) : "—";
      const avgThk = fmt(g.avgThickness, 2);
      lines.push(
        `${g.code.padEnd(14)}${g.description.slice(0, 31).padEnd(31)}  ${String(g.count).padStart(5)}  ${minTop.padStart(7)}  ${maxBase.padStart(7)}  ${avgThk.padStart(6)}`
      );
    }
    lines.push("");
  }

  // Sample inventory
  if (report.sampTypes.length > 0) {
    lines.push("Sample Inventory");
    lines.push("-".repeat(30));
    for (const st of report.sampTypes) {
      lines.push(`  ${st.type.padEnd(4)}  ${st.count}`);
    }
    lines.push("");
  }

  // Statistical summaries
  const st = report.stats;
  const hasStats = st.spt || st.ll || st.pl || st.pi || st.moisture || st.cu || st.bulkDensity || st.dryDensity;
  if (hasStats) {
    lines.push("Statistical Summary of Test Results");
    lines.push("-".repeat(50));
    lines.push("  (n = count, std = sample std dev)");
    if (st.spt)         lines.push(`SPT N-value          ${fmtStats(st.spt, 1)}`);
    if (st.ll)          lines.push(`Liquid limit (%)     ${fmtStats(st.ll, 1)}`);
    if (st.pl)          lines.push(`Plastic limit (%)    ${fmtStats(st.pl, 1)}`);
    if (st.pi)          lines.push(`Plasticity index (%) ${fmtStats(st.pi, 1)}`);
    if (st.moisture)    lines.push(`Moisture content (%) ${fmtStats(st.moisture, 1)}`);
    if (st.cu)          lines.push(`Undrained shear (kPa)${fmtStats(st.cu, 1)}`);
    if (st.bulkDensity) lines.push(`Bulk density (Mg/m³) ${fmtStats(st.bulkDensity, 3)}`);
    if (st.dryDensity)  lines.push(`Dry density (Mg/m³)  ${fmtStats(st.dryDensity, 3)}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── JSON renderer ──────────────────────────────────────────────────────────────

export function renderGiReportJson(report: GiReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
