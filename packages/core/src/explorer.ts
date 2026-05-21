/**
 * HTML explorer: generates a self-contained single-file HTML report for an
 * AGS file, including per-borehole SVG strip logs.
 */

import { Option } from "effect";
import type { AgsFile, AgsRow } from "./model.js";
import { Severity } from "./diagnostics.js";
import { Registry, validate } from "./validate.js";
import { render, Format } from "./render.js";
import { parseStr, decodeBytes } from "./ags/parser.js";

// ── Lithology classification ──────────────────────────────────────────────────

type LithoKind =
  | "fill" | "topsoil" | "peat" | "chalk" | "sandgravel" | "clay" | "silt"
  | "gravel" | "sandstone" | "sand" | "mudstone" | "limestone" | "basalt"
  | "igneous" | "bedrock" | "other";

function geolKind(desc: string): LithoKind {
  const u = (desc ?? "").toUpperCase();
  if (u.includes("MADE GROUND") || u.includes("FILL") || u.includes("HARDCORE")) return "fill";
  if (u.includes("TOPSOIL") || u.includes("TOP SOIL")) return "topsoil";
  if (u.includes("PEAT") || u.includes("ORGANIC")) return "peat";
  if (u.includes("CHALK")) return "chalk";
  if (u.includes("SANDY GRAVEL") || u.includes("GRAVELLY SAND")) return "sandgravel";
  if (u.includes("CLAY")) return "clay";
  if (u.includes("SILT")) return "silt";
  if (u.includes("GRAVEL")) return "gravel";
  if (u.includes("SANDSTONE")) return "sandstone";
  if (u.includes("SAND")) return "sand";
  if (u.includes("MUDSTONE") || u.includes("SHALE")) return "mudstone";
  if (u.includes("LIMESTONE")) return "limestone";
  if (u.includes("BASALT")) return "basalt";
  if (u.includes("GRANITE") || u.includes("DIORITE") || u.includes("IGNEOUS")) return "igneous";
  if (u.includes("ROCK") || u.includes("BEDROCK")) return "bedrock";
  return "other";
}

const LITHO_INFO: Record<LithoKind, { color: string; label: string }> = {
  fill:       { color: "#A0785A", label: "Made Ground / Fill" },
  topsoil:    { color: "#5C7A3E", label: "Topsoil" },
  peat:       { color: "#3D2B1F", label: "Peat / Organic" },
  chalk:      { color: "#F5F0C8", label: "Chalk" },
  sandgravel: { color: "#D99055", label: "Sandy Gravel" },
  clay:       { color: "#7B9EC5", label: "Clay" },
  silt:       { color: "#C4A87C", label: "Silt" },
  gravel:     { color: "#C87A45", label: "Gravel" },
  sandstone:  { color: "#D4B483", label: "Sandstone" },
  sand:       { color: "#F0D870", label: "Sand" },
  mudstone:   { color: "#7A7A90", label: "Mudstone / Shale" },
  limestone:  { color: "#C8CEB8", label: "Limestone" },
  basalt:     { color: "#505060", label: "Basalt" },
  igneous:    { color: "#808090", label: "Igneous" },
  bedrock:    { color: "#9090A0", label: "Bedrock" },
  other:      { color: "#d1d5db", label: "Other / Unclassified" },
};

/** SVG <pattern> bodies for traditional BS 5930-style lithology symbols.
 *  Stroke-only so they overlay on the colour fill. IDs are suffixed per
 *  borehole to keep multiple inline SVGs isolated within one HTML document. */
function lithologyPatternDefs(suffix: string): string {
  const p = (id: string, w: number, h: number, body: string) =>
    `<pattern id="pat-${id}-${suffix}" patternUnits="userSpaceOnUse" width="${w}" height="${h}">${body}</pattern>`;
  const s = (extra = "") => `stroke="#1f2937" stroke-width="0.55" fill="none" ${extra}`;
  return [
    p("fill",       10, 10, `<polygon points="2,2 5,6 8,3"  ${s()}/><polygon points="1,8 4,9 3,6" ${s()}/>`),
    p("topsoil",     6,  6, `<line x1="2" y1="1" x2="2" y2="4" ${s()}/><line x1="4" y1="2" x2="4" y2="5" ${s()}/>`),
    p("peat",       12,  6, `<path d="M0,3 Q3,0 6,3 T12,3" ${s()}/>`),
    p("chalk",      10,  8, `<polyline points="1,2 5,6 9,2" ${s()}/>`),
    p("sandgravel", 10, 10, `<circle cx="3" cy="3" r="1.4" ${s()}/><circle cx="7" cy="7" r="0.7" fill="#1f2937"/>`),
    p("clay",        8,  6, `<line x1="1" y1="3" x2="7" y2="3" ${s()}/>`),
    p("silt",        6,  6, `<line x1="3" y1="1" x2="3" y2="3" ${s()}/>`),
    p("gravel",     10, 10, `<circle cx="3" cy="3" r="1.6" ${s()}/><circle cx="7" cy="7" r="1.2" ${s()}/>`),
    p("sandstone",  10,  6, `<line x1="0" y1="0.5" x2="10" y2="0.5" ${s()}/><circle cx="3" cy="3.5" r="0.6" fill="#1f2937"/><circle cx="7" cy="3.5" r="0.6" fill="#1f2937"/>`),
    p("sand",        6,  6, `<circle cx="3" cy="3" r="0.7" fill="#1f2937"/>`),
    p("mudstone",    8,  4, `<line x1="0" y1="2" x2="8" y2="2" ${s()}/>`),
    p("limestone",  14,  8, `<path d="M0,0 H14 M0,4 H14 M7,0 V4 M3.5,4 V8 M10.5,4 V8 M0,8 H14" ${s()}/>`),
    p("basalt",      6,  6, `<path d="M0,0 L6,6 M6,0 L0,6 M0,3 H6 M3,0 V6" ${s()}/>`),
    p("igneous",     8,  8, `<path d="M0,0 L8,8 M8,0 L0,8" ${s()}/>`),
    p("bedrock",     6,  6, `<line x1="0" y1="6" x2="6" y2="0" ${s()}/>`),
    p("other",       6,  6, `<circle cx="3" cy="3" r="0.4" fill="#94a3b8"/>`),
  ].join("");
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function num(v: unknown, fallback = 0): number {
  const n = parseFloat(String(v ?? ""));
  return isNaN(n) ? fallback : n;
}

function str(row: AgsRow, key: string): string {
  return String(row[key] ?? "");
}

// ── SVG borehole strip log ────────────────────────────────────────────────────

interface BoreholeMeta {
  projId?: string;
  projName?: string;
  projLoc?: string;
  loca?: AgsRow;
  hdph?: AgsRow;
  wgen?: AgsRow[];
  generatedAt?: string;
}

/** Column geometry — single source of truth so headers, dividers and body align.
 *  Order follows traditional UK/AGS convention: depth & level on the left,
 *  graphic strata column immediately adjacent to the description. */
const COLS = {
  depth: { x:   0, w:  32, label: "Depth",  unit: "(m)" },
  level: { x:  32, w:  42, label: "Level",  unit: "(m OD)" },
  water: { x:  74, w:  30, label: "Water",  unit: "" },
  samp:  { x: 104, w:  60, label: "Samples",  unit: "& Tests" },
  spt:   { x: 164, w:  72, label: "SPT (N)",  unit: "blows/300mm" },
  litho: { x: 236, w:  50, label: "Legend", unit: "" },
  desc:  { x: 286, w: 234, label: "Stratum Description", unit: "" },
} as const;
const TOTAL_W = 520;

/** Standard AGS sample-type abbreviations (BS EN ISO 22475-1). */
const SAMP_TYPE_LABELS: Record<string, string> = {
  B:   "Bulk disturbed",
  BLK: "Block sample",
  D:   "Small disturbed",
  ES:  "Environmental sample",
  J:   "Jar sample",
  P:   "Piston (thin-wall)",
  PS:  "Piston sample",
  SPT: "SPT split-spoon",
  U:   "Undisturbed (U100)",
  U4:  "Undisturbed (U100)",
  W:   "Water sample",
  WS:  "Wash sample",
};

function renderBoreholeSvg(
  locaId: string,
  geol: AgsRow[],
  ispt: AgsRow[],
  samp: AgsRow[],
  wstk: AgsRow[],
  meta: BoreholeMeta = {},
): string {
  // ── Inputs ────────────────────────────────────────────────────────────────
  const loca = meta.loca ?? {};
  const hdph = meta.hdph ?? {};
  const wgen = meta.wgen ?? [];
  const fdep = num(loca["LOCA_FDEP"]);
  const glNum = parseFloat(String(loca["LOCA_GL"] ?? ""));
  const hasGL = !isNaN(glNum);

  let maxDepth = Math.max(10, fdep);
  for (const r of geol) maxDepth = Math.max(maxDepth, num(r["GEOL_BASE"]));
  for (const r of ispt) maxDepth = Math.max(maxDepth, num(r["ISPT_TOP"]));
  for (const r of wgen) maxDepth = Math.max(maxDepth, num(r["WGEN_DTOP"]));
  maxDepth = Math.ceil(maxDepth) + 1;

  const PX_PER_M = 18;
  const bodyH   = maxDepth * PX_PER_M;
  const HEAD_H  = 116;   // 4-row title block
  const COL_H   = 28;    // 2-row column header strip
  const FOOT_H  = 18;    // attribution strip

  // Lithology kinds present (drives the legend block size)
  const kindsInUse = new Set<LithoKind>();
  for (const layer of geol) kindsInUse.add(geolKind(str(layer, "GEOL_DESC")));
  const legendItems = Array.from(kindsInUse);

  // Sample-type codes present (drives the abbreviations block size)
  const sampTypesInUse = new Set<string>();
  for (const s of samp) {
    const t = str(s, "SAMP_TYPE").trim().toUpperCase();
    if (t) sampTypesInUse.add(t);
  }
  if (ispt.length) sampTypesInUse.add("SPT");
  const abbrItems = Array.from(sampTypesInUse).sort();

  // Lower legend/key block: two columns side-by-side (lithology | abbreviations).
  // The water-symbol row at the bottom of the abbreviations panel always
  // reserves an additional row so it never overlaps the type-code list.
  const LEG_ROW_H = 14;
  const lithoRows = Math.ceil(Math.max(legendItems.length, 1) / 2);
  const abbrRows  = Math.ceil(Math.max(abbrItems.length, 1) / 2);
  const KEY_H = (legendItems.length === 0 && abbrItems.length === 0)
    ? 0
    : 22 + Math.max(lithoRows, abbrRows + 1) * LEG_ROW_H + 6;

  const totalH = HEAD_H + COL_H + bodyH + KEY_H + FOOT_H;

  // Metadata strings
  const projId   = meta.projId   ?? "";
  const projName = meta.projName ?? "";
  const projLoc  = meta.projLoc  ?? "";
  const holeType = str(loca, "LOCA_TYPE") || "BH";
  const east     = str(loca, "LOCA_NATE");
  const north    = str(loca, "LOCA_NATN");
  const gl       = str(loca, "LOCA_GL");
  const startDt  = str(loca, "LOCA_STAR");
  const endDt    = str(loca, "LOCA_ENDD");
  const logger   = str(loca, "LOCA_LOGD") || str(loca, "LOCA_ENG");
  const checker  = str(loca, "LOCA_CHKD");
  const method   = str(hdph, "HDPH_METH") || str(loca, "LOCA_METH");
  const hdia     = str(hdph, "HDPH_HDIA");
  const contractor = str(hdph, "HDPH_CONT") || str(hdph, "HDPH_NGCO");
  const tdShown  = (fdep > 0 ? fdep : maxDepth - 1).toFixed(2);
  const idSuffix = (locaId || "x").replace(/[^A-Za-z0-9_-]/g, "_");

  const lines: string[] = [];
  lines.push(`<svg width="${TOTAL_W}" height="${totalH}" viewBox="0 0 ${TOTAL_W} ${totalH}" font-family="'Helvetica Neue',Arial,sans-serif" xmlns="http://www.w3.org/2000/svg">`);
  lines.push(`<defs>${lithologyPatternDefs(idSuffix)}</defs>`);
  lines.push(`<rect x="0.5" y="0.5" width="${TOTAL_W - 1}" height="${totalH - 1}" fill="#fff" stroke="#111" stroke-width="1"/>`);

  // ── 1. Title block (4 rows × variable columns) ────────────────────────────
  const tb = (x: number, y: number, w: number, h: number) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="#111" stroke-width="0.7"/>`;
  const tbLabel = (x: number, y: number, t: string) =>
    `<text x="${x + 4}" y="${y + 8}" font-size="6.2" fill="#475569" font-weight="700" letter-spacing="0.5">${esc(t.toUpperCase())}</text>`;
  const tbValue = (x: number, y: number, t: string, size = 9, weight = "600") =>
    `<text x="${x + 4}" y="${y + 19}" font-size="${size}" fill="#0f172a" font-weight="${weight}">${esc(t)}</text>`;
  const tbCell = (x: number, y: number, w: number, h: number, label: string, value: string, size = 9) => {
    return [
      tb(x, y, w, h),
      tbLabel(x, y, label),
      tbValue(x, y, value || "—", size, "600"),
    ].join("");
  };

  // Row 1 (44px) — big BH-ID block + project banner
  lines.push(tb(0, 0, 150, 44));
  lines.push(tbLabel(0, 0, "Borehole / Trial Pit"));
  lines.push(`<text x="6" y="36" font-size="22" font-weight="800" fill="#0f172a">${esc(locaId)}</text>`);
  lines.push(`<text x="144" y="38" font-size="8" font-weight="700" fill="#475569" text-anchor="end">${esc(holeType)}</text>`);

  lines.push(tb(150, 0, TOTAL_W - 150, 44));
  lines.push(tbLabel(150, 0, "Project"));
  lines.push(`<text x="156" y="26" font-size="13" font-weight="700" fill="#0f172a">${esc(projName || "—")}</text>`);
  if (projLoc) {
    lines.push(`<text x="156" y="38" font-size="8" fill="#475569">${esc(projLoc)}</text>`);
  }
  if (projId) {
    lines.push(`<text x="${TOTAL_W - 6}" y="14" font-size="7" font-weight="700" fill="#475569" text-anchor="end">PROJ ID: ${esc(projId)}</text>`);
  }

  // Row 2 (24px) — coordinates / GL / final depth
  let x = 0;
  const r2y = 44;
  lines.push(tbCell(x, r2y, 100, 24, "Easting (m)",        east));    x += 100;
  lines.push(tbCell(x, r2y, 100, 24, "Northing (m)",       north));   x += 100;
  lines.push(tbCell(x, r2y, 110, 24, "Ground Level (m OD)", gl));     x += 110;
  lines.push(tbCell(x, r2y,  95, 24, "Final Depth (m)",    tdShown)); x += 95;
  lines.push(tbCell(x, r2y, TOTAL_W - x, 24, "Hole Diameter (mm)", hdia));

  // Row 3 (24px) — dates / logged / checked
  x = 0;
  const r3y = 68;
  const dateStr = startDt && endDt && startDt !== endDt
    ? `${startDt} – ${endDt}`
    : (startDt || endDt || meta.generatedAt || "");
  lines.push(tbCell(x, r3y, 140, 24, "Date Drilled",  dateStr, 8.5)); x += 140;
  lines.push(tbCell(x, r3y, 110, 24, "Logged by",     logger,  8.5)); x += 110;
  lines.push(tbCell(x, r3y, 110, 24, "Checked by",    checker, 8.5)); x += 110;
  lines.push(tbCell(x, r3y, TOTAL_W - x, 24, "Contractor", contractor, 8.5));

  // Row 4 (24px) — method / scale / sheet
  x = 0;
  const r4y = 92;
  lines.push(tbCell(x, r4y, 250, 24, "Drilling Method", method, 8.5)); x += 250;
  lines.push(tbCell(x, r4y, 110, 24, "Scale (vertical)", `1 cm ≈ ${(10 / PX_PER_M).toFixed(2)} m`, 8.5)); x += 110;
  lines.push(tbCell(x, r4y, 80, 24, "Sheet",  "1 of 1", 8.5)); x += 80;
  lines.push(tbCell(x, r4y, TOTAL_W - x, 24, "Hole Type", holeType, 8.5));

  // ── 2. Column header strip (two rows: label + unit/sub-label) ─────────────
  const colHeadY = HEAD_H;
  lines.push(`<rect x="0" y="${colHeadY}" width="${TOTAL_W}" height="${COL_H}" fill="#1e293b" stroke="#111" stroke-width="1"/>`);
  for (const c of Object.values(COLS)) {
    lines.push(`<line x1="${c.x}" y1="${colHeadY}" x2="${c.x}" y2="${colHeadY + COL_H}" stroke="#0f172a" stroke-width="0.6"/>`);
    const labelFont = c.label.length > 10 ? 7.5 : 8.5;
    lines.push(`<text x="${c.x + c.w / 2}" y="${colHeadY + 12}" font-size="${labelFont}" font-weight="700" fill="#f8fafc" text-anchor="middle" letter-spacing="0.4">${esc(c.label.toUpperCase())}</text>`);
    if (c.unit) {
      lines.push(`<text x="${c.x + c.w / 2}" y="${colHeadY + 22}" font-size="6.5" fill="#cbd5e1" text-anchor="middle" font-style="italic">${esc(c.unit)}</text>`);
    }
  }
  // SPT axis tick labels live in the unit row (overrides the generic unit text)
  lines.push(`<rect x="${COLS.spt.x + 1}" y="${colHeadY + 15}" width="${COLS.spt.w - 2}" height="11" fill="#1e293b"/>`);
  lines.push(`<text x="${COLS.spt.x + 4}" y="${colHeadY + 24}" font-size="6.5" fill="#cbd5e1">0</text>`);
  lines.push(`<text x="${COLS.spt.x + COLS.spt.w * 0.25}" y="${colHeadY + 24}" font-size="6.5" fill="#cbd5e1" text-anchor="middle">15</text>`);
  lines.push(`<text x="${COLS.spt.x + COLS.spt.w * 0.5}" y="${colHeadY + 24}" font-size="6.5" fill="#cbd5e1" text-anchor="middle">30</text>`);
  lines.push(`<text x="${COLS.spt.x + COLS.spt.w * 0.75}" y="${colHeadY + 24}" font-size="6.5" fill="#cbd5e1" text-anchor="middle">45</text>`);
  lines.push(`<text x="${COLS.spt.x + COLS.spt.w - 4}" y="${colHeadY + 24}" font-size="6.5" fill="#cbd5e1" text-anchor="end">60</text>`);

  // ── 3. Body ───────────────────────────────────────────────────────────────
  const bodyY = HEAD_H + COL_H;
  lines.push(`<g transform="translate(0,${bodyY})">`);

  // Backgrounds + crisp dividers
  lines.push(`<rect x="0" y="0" width="${TOTAL_W}" height="${bodyH}" fill="#fff"/>`);
  // Subtle tint on the narrow data columns to differentiate from description
  lines.push(`<rect x="${COLS.depth.x}" y="0" width="${COLS.depth.w + COLS.level.w}" height="${bodyH}" fill="#f1f5f9"/>`);
  lines.push(`<rect x="${COLS.water.x}" y="0" width="${COLS.water.w}" height="${bodyH}" fill="#f0f9ff"/>`);
  lines.push(`<rect x="${COLS.litho.x}" y="0" width="${COLS.litho.w}" height="${bodyH}" fill="#fafafa"/>`);
  for (const c of Object.values(COLS)) {
    lines.push(`<line x1="${c.x}" y1="0" x2="${c.x}" y2="${bodyH}" stroke="#111" stroke-width="0.7"/>`);
  }
  lines.push(`<line x1="${TOTAL_W}" y1="0" x2="${TOTAL_W}" y2="${bodyH}" stroke="#111" stroke-width="0.7"/>`);

  // SPT axis gridlines at N = 15, 30, 45 (dashed)
  for (const n of [15, 30, 45]) {
    const gx = COLS.spt.x + (n / 60) * COLS.spt.w;
    lines.push(`<line x1="${gx}" y1="0" x2="${gx}" y2="${bodyH}" stroke="#cbd5e1" stroke-width="0.4" stroke-dasharray="2,3"/>`);
  }

  // Depth + Reduced Level scale (per-metre ticks; bold every 5 m)
  for (let i = 0; i <= maxDepth; i++) {
    const y = i * PX_PER_M;
    const major = i % 5 === 0;
    const dxR = COLS.depth.x + COLS.depth.w; // right edge of depth col
    const lxR = COLS.level.x + COLS.level.w; // right edge of level col
    if (major) {
      // Bold tick across both Depth and Level columns
      lines.push(`<line x1="0" y1="${y}" x2="${lxR}" y2="${y}" stroke="#111" stroke-width="0.7"/>`);
      // Faint full-width grid line across data columns (helps eye trace)
      lines.push(`<line x1="${lxR}" y1="${y}" x2="${TOTAL_W}" y2="${y}" stroke="#e2e8f0" stroke-width="0.5"/>`);
      lines.push(`<text x="${dxR - 3}" y="${y + 3}" font-size="9" text-anchor="end" font-weight="700" fill="#0f172a">${i.toFixed(0)}</text>`);
      if (hasGL) {
        lines.push(`<text x="${lxR - 3}" y="${y + 3}" font-size="8.5" text-anchor="end" font-weight="600" fill="#0f172a">${(glNum - i).toFixed(2)}</text>`);
      }
    } else {
      // Minor tick — just a small mark on the depth col right edge
      lines.push(`<line x1="${dxR - 5}" y1="${y}" x2="${dxR}" y2="${y}" stroke="#475569" stroke-width="0.45"/>`);
      lines.push(`<text x="${dxR - 3}" y="${y + 3}" font-size="6.5" text-anchor="end" fill="#64748b">${i.toFixed(0)}</text>`);
    }
  }

  // GEOL layers — graphic strata + description
  for (const layer of geol) {
    const top = num(layer["GEOL_TOP"]);
    const base = num(layer["GEOL_BASE"]);
    const yTop = top * PX_PER_M;
    const yBot = base * PX_PER_M;
    const h = yBot - yTop;
    if (h <= 0) continue;
    const desc = str(layer, "GEOL_DESC");
    const geolGeol = str(layer, "GEOL_GEOL");
    const geolStat = str(layer, "GEOL_STAT");
    const kind = geolKind(desc);
    const col = LITHO_INFO[kind].color;

    // Graphic strata column (colour + hatch overlay + border)
    lines.push(`<rect x="${COLS.litho.x}" y="${yTop}" width="${COLS.litho.w}" height="${h}" fill="${col}"/>`);
    lines.push(`<rect x="${COLS.litho.x}" y="${yTop}" width="${COLS.litho.w}" height="${h}" fill="url(#pat-${kind}-${idSuffix})"/>`);
    lines.push(`<rect x="${COLS.litho.x}" y="${yTop}" width="${COLS.litho.w}" height="${h}" fill="none" stroke="#111" stroke-width="0.5"><title>${esc(desc)} (${top.toFixed(2)} – ${base.toFixed(2)} m)</title></rect>`);

    // Stratum-base contact: solid line across every column except graphic + depth/level
    lines.push(`<line x1="${COLS.water.x}" y1="${yBot}" x2="${COLS.litho.x}" y2="${yBot}" stroke="#111" stroke-width="0.5"/>`);
    lines.push(`<line x1="${COLS.desc.x}" y1="${yBot}" x2="${TOTAL_W}" y2="${yBot}" stroke="#111" stroke-width="0.7"/>`);

    // Stratigraphy code badge inside the graphic column (where it fits)
    if (geolGeol && h > 14) {
      lines.push(`<text x="${COLS.litho.x + COLS.litho.w - 3}" y="${yTop + 9}" font-size="7" font-weight="700" fill="#0f172a" text-anchor="end" opacity="0.7">${esc(geolGeol.slice(0, 4))}</text>`);
    }

    // Description: bold lithology summary then wrapped detail
    const headerParts: string[] = [];
    headerParts.push(`${top.toFixed(2)} – ${base.toFixed(2)} m`);
    if (geolGeol) headerParts.push(geolGeol);
    if (geolStat) headerParts.push(geolStat);
    lines.push(`<text x="${COLS.desc.x + 5}" y="${yTop + 10}" font-size="7" font-weight="700" fill="#475569" letter-spacing="0.3">${esc(headerParts.join("  ·  "))}</text>`);
    if (h > 16) {
      const maxLines = Math.floor((h - 12) / 9);
      const wrapped = wrapText(desc, 52, maxLines);
      wrapped.forEach((ln, ix) => {
        lines.push(`<text x="${COLS.desc.x + 5}" y="${yTop + 20 + ix * 9}" font-size="8" fill="#0f172a">${esc(ln)}</text>`);
      });
    }
  }

  // ISPT — SPT N-value bars with numeric label
  for (const test of ispt) {
    const depth = num(test["ISPT_TOP"]);
    const rawN = num(test["ISPT_NVAL"]);
    const nval = Math.min(rawN, 60);
    const barPx = (nval / 60) * COLS.spt.w;
    const yCentre = depth * PX_PER_M;
    const yBar = yCentre - 3.5;
    lines.push(`<rect x="${COLS.spt.x}" y="${yBar}" width="${barPx.toFixed(1)}" height="7" fill="#f97316" stroke="#9a3412" stroke-width="0.5"><title>SPT N=${Math.round(rawN)} at ${depth.toFixed(2)} m</title></rect>`);
    if (rawN > 0) {
      const labelX = COLS.spt.x + Math.min(COLS.spt.w - 3, barPx + 3);
      lines.push(`<text x="${labelX}" y="${yBar + 6}" font-size="7" font-weight="700" fill="#0f172a">N=${Math.round(rawN)}</text>`);
    }
  }

  // SAMP — narrow vertical "stick" + boxed type code at the sample depth
  for (const s of samp) {
    const depthTop = num(s["SAMP_TOP"]);
    const depthBase = num(s["SAMP_BASE"]) || depthTop;
    const sampType = (str(s, "SAMP_TYPE") || "B").toUpperCase();
    const sampRef = str(s, "SAMP_REF");
    const yT = depthTop * PX_PER_M;
    const yB = Math.max(depthBase * PX_PER_M, yT + 2);
    const stickX = COLS.samp.x + 6;
    // Recovery / interval stick (left side of column)
    lines.push(`<line x1="${stickX}" y1="${yT}" x2="${stickX}" y2="${yB}" stroke="#1e3a8a" stroke-width="1.4"/>`);
    lines.push(`<line x1="${stickX - 3}" y1="${yT}" x2="${stickX + 3}" y2="${yT}" stroke="#1e3a8a" stroke-width="1"/>`);
    lines.push(`<line x1="${stickX - 3}" y1="${yB}" x2="${stickX + 3}" y2="${yB}" stroke="#1e3a8a" stroke-width="1"/>`);
    // Type-code box to the right of the stick + small SAMP_REF label below
    const boxX = stickX + 6;
    const boxY = yT - 5;
    const boxW = COLS.samp.x + COLS.samp.w - boxX - 3;
    lines.push(`<rect x="${boxX}" y="${boxY}" width="${boxW}" height="10" fill="#fff" stroke="#1e3a8a" stroke-width="0.7"><title>Sample ${esc(sampRef)} (${esc(sampType)}) ${depthTop.toFixed(2)}–${depthBase.toFixed(2)} m</title></rect>`);
    lines.push(`<text x="${boxX + boxW / 2}" y="${boxY + 7.5}" font-size="7" text-anchor="middle" font-weight="700" fill="#1e3a8a">${esc(sampType.slice(0, 3))}</text>`);
    if (sampRef && yB - yT < 14) {
      lines.push(`<text x="${boxX + boxW / 2}" y="${boxY + 16}" font-size="6" text-anchor="middle" fill="#475569">${esc(sampRef.slice(0, 8))}</text>`);
    }
  }

  // WSTK — water strike encountered while drilling: OPEN inverted triangle ∇
  for (const ws of wstk) {
    const depth = num(ws["WSTK_DPTH"]);
    const cy = depth * PX_PER_M;
    const cx = COLS.water.x + COLS.water.w / 2;
    lines.push(`<line x1="${COLS.water.x + 2}" y1="${cy}" x2="${COLS.water.x + COLS.water.w - 2}" y2="${cy}" stroke="#0369a1" stroke-width="0.6" stroke-dasharray="2,2"/>`);
    lines.push(`<polygon points="${cx - 5},${cy} ${cx + 5},${cy} ${cx},${cy + 8}" fill="#fff" stroke="#0369a1" stroke-width="0.9"><title>Water strike at ${depth.toFixed(2)} m</title></polygon>`);
  }

  // WGEN — standing water level after monitoring: FILLED triangle ▼
  for (const ws of wgen) {
    const depth = num(ws["WGEN_DTOP"]);
    if (depth <= 0) continue;
    const cy = depth * PX_PER_M;
    const cx = COLS.water.x + COLS.water.w / 2;
    lines.push(`<line x1="${COLS.water.x + 2}" y1="${cy}" x2="${COLS.water.x + COLS.water.w - 2}" y2="${cy}" stroke="#0369a1" stroke-width="0.7"/>`);
    lines.push(`<polygon points="${cx - 5},${cy} ${cx + 5},${cy} ${cx},${cy + 8}" fill="#0ea5e9" stroke="#0369a1" stroke-width="0.7"><title>Standing water at ${depth.toFixed(2)} m</title></polygon>`);
  }

  // End-of-hole marker — thick black line across all columns
  if (fdep > 0 && fdep <= maxDepth) {
    const y = fdep * PX_PER_M;
    lines.push(`<line x1="0" y1="${y}" x2="${TOTAL_W}" y2="${y}" stroke="#111" stroke-width="1.6"/>`);
    lines.push(`<text x="${COLS.desc.x + COLS.desc.w / 2}" y="${y + 11}" font-size="8" font-weight="700" fill="#0f172a" text-anchor="middle" letter-spacing="0.4">End of Borehole at ${fdep.toFixed(2)} m</text>`);
  }

  lines.push(`</g>`);

  // ── 4. Key block — lithology legend (left) + abbreviations (right) ────────
  if (KEY_H > 0) {
    const kY = HEAD_H + COL_H + bodyH;
    const half = TOTAL_W / 2;
    lines.push(`<rect x="0" y="${kY}" width="${TOTAL_W}" height="${KEY_H}" fill="#f8fafc" stroke="#111" stroke-width="1"/>`);
    lines.push(`<line x1="${half}" y1="${kY}" x2="${half}" y2="${kY + KEY_H}" stroke="#111" stroke-width="0.7"/>`);

    // LEFT: Lithology legend
    lines.push(`<text x="8" y="${kY + 14}" font-size="7.5" font-weight="700" fill="#475569" letter-spacing="0.5">LITHOLOGY KEY</text>`);
    const lithoColW = (half - 16) / 2;
    legendItems.forEach((kind, ix) => {
      const row = Math.floor(ix / 2);
      const col = ix % 2;
      const lx = 8 + col * lithoColW;
      const ly = kY + 22 + row * LEG_ROW_H;
      const info = LITHO_INFO[kind];
      lines.push(`<rect x="${lx}" y="${ly}" width="20" height="10" fill="${info.color}" stroke="#111" stroke-width="0.5"/>`);
      lines.push(`<rect x="${lx}" y="${ly}" width="20" height="10" fill="url(#pat-${kind}-${idSuffix})"/>`);
      lines.push(`<text x="${lx + 24}" y="${ly + 8}" font-size="7.5" fill="#0f172a">${esc(info.label)}</text>`);
    });

    // RIGHT: Abbreviations / sample-type key
    lines.push(`<text x="${half + 8}" y="${kY + 14}" font-size="7.5" font-weight="700" fill="#475569" letter-spacing="0.5">SAMPLE / TEST KEY</text>`);
    const abbrColW = (half - 16) / 2;
    abbrItems.forEach((code, ix) => {
      const row = Math.floor(ix / 2);
      const col = ix % 2;
      const ax = half + 8 + col * abbrColW;
      const ay = kY + 22 + row * LEG_ROW_H;
      const label = SAMP_TYPE_LABELS[code] ?? "—";
      lines.push(`<rect x="${ax}" y="${ay}" width="22" height="10" fill="#fff" stroke="#1e3a8a" stroke-width="0.6"/>`);
      lines.push(`<text x="${ax + 11}" y="${ay + 7.5}" font-size="6.5" text-anchor="middle" font-weight="700" fill="#1e3a8a">${esc(code)}</text>`);
      lines.push(`<text x="${ax + 26}" y="${ay + 8}" font-size="7.5" fill="#0f172a">${esc(label)}</text>`);
    });

    // Water-symbol key — slotted into the row immediately below the
    // last abbreviation entry so it never overlaps the type-code list.
    const wsY = kY + 22 + abbrRows * LEG_ROW_H + 1;
    const symX = half + 8;
    lines.push(`<polygon points="${symX + 5},${wsY} ${symX + 13},${wsY} ${symX + 9},${wsY + 7}" fill="#fff" stroke="#0369a1" stroke-width="0.7"/>`);
    lines.push(`<text x="${symX + 18}" y="${wsY + 7}" font-size="7" fill="#0f172a">Water strike</text>`);
    lines.push(`<polygon points="${symX + 80},${wsY} ${symX + 88},${wsY} ${symX + 84},${wsY + 7}" fill="#0ea5e9" stroke="#0369a1" stroke-width="0.7"/>`);
    lines.push(`<text x="${symX + 93}" y="${wsY + 7}" font-size="7" fill="#0f172a">Standing water</text>`);
  }

  // ── 5. Footer ────────────────────────────────────────────────────────────
  const fY = totalH - FOOT_H;
  lines.push(`<line x1="0" y1="${fY}" x2="${TOTAL_W}" y2="${fY}" stroke="#111" stroke-width="1"/>`);
  lines.push(`<text x="6" y="${fY + 12}" font-size="7" fill="#475569">GeoFlow Explorer  ·  Strip log to BS 5930 / AGS conventions  ·  not to scale when reproduced</text>`);
  if (meta.generatedAt) {
    lines.push(`<text x="${TOTAL_W - 6}" y="${fY + 12}" font-size="7" fill="#475569" text-anchor="end">Generated ${esc(meta.generatedAt)}</text>`);
  }

  lines.push(`</svg>`);
  return lines.join("\n");
}

/** Greedy word-wrap; falls back to hard-cut if a single token exceeds width. */
function wrapText(s: string, maxChars: number, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const words = (s ?? "").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if (cur.length + 1 + w.length <= maxChars) { cur += " " + w; }
    else {
      out.push(cur);
      if (out.length === maxLines) break;
      cur = w;
    }
  }
  if (cur && out.length < maxLines) out.push(cur);
  if (out.length === maxLines && words.join(" ").length > out.join(" ").length) {
    const last = out[out.length - 1] ?? "";
    out[out.length - 1] = last.slice(0, Math.max(0, maxChars - 1)) + "…";
  }
  return out;
}

// ── Per-borehole strip log (reusable) ─────────────────────────────────────────

export interface BoreholeLog {
  locaId: string;
  /** Self-contained SVG markup for the BS 5930 / AGS-style strip log. */
  svg: string;
}

/**
 * Render a BS 5930 / AGS-convention strip log for every LOCA in the file.
 * Shared by the HTML explorer and the factual report so both stay in sync.
 */
export function renderBoreholeLogs(file: AgsFile): BoreholeLog[] {
  const locaRows = file.groups["LOCA"]?.rows ?? [];
  const locaIds = locaRows
    .map((r) => String(r["LOCA_ID"] ?? ""))
    .filter(Boolean);

  const projRow = file.groups["PROJ"]?.rows[0] ?? {};
  const projId = str(projRow as AgsRow, "PROJ_ID");
  const projName = str(projRow as AgsRow, "PROJ_NAME");
  const projLoc = str(projRow as AgsRow, "PROJ_LOC");
  const generatedAt = new Date().toISOString().slice(0, 10);

  const logs: BoreholeLog[] = [];
  for (const locaId of locaIds) {
    const filterById = (rows: AgsRow[]) =>
      rows.filter((r) => String(r["LOCA_ID"] ?? "") === locaId);

    const loca = locaRows.find((r) => String(r["LOCA_ID"] ?? "") === locaId);
    const geol = filterById(file.groups["GEOL"]?.rows ?? []);
    const ispt = filterById(file.groups["ISPT"]?.rows ?? []);
    const samp = filterById(file.groups["SAMP"]?.rows ?? []);
    const wstk = filterById(file.groups["WSTK"]?.rows ?? []);
    const wgen = filterById(file.groups["WGEN"]?.rows ?? []);
    const hdph = filterById(file.groups["HDPH"]?.rows ?? [])[0];

    const meta: BoreholeMeta = { projId, projName, generatedAt };
    if (projLoc) meta.projLoc = projLoc;
    if (loca) meta.loca = loca;
    if (hdph) meta.hdph = hdph;
    if (wgen.length) meta.wgen = wgen;
    logs.push({ locaId, svg: renderBoreholeSvg(locaId, geol, ispt, samp, wstk, meta) });
  }
  return logs;
}

// ── Full HTML report ──────────────────────────────────────────────────────────

export interface ExplorerOptions {
  sourcePath?: string;
}

export function renderExplorer(file: AgsFile, options: ExplorerOptions = {}): string {
  const sourcePath = options.sourcePath ??
    (Option.isSome(file.source_path) ? file.source_path.value : "In-memory");

  const diagnostics = [...validate(file, Registry.standard())];
  const errorCount = diagnostics.filter((d) => d.severity === Severity.Error).length;
  const warnCount = diagnostics.filter((d) => d.severity === Severity.Warning).length;

  const locaGroup = file.groups["LOCA"];
  const locaRows = locaGroup ? locaGroup.rows : [];
  const locaIds: string[] = locaRows
    .map((r) => String(r["LOCA_ID"] ?? ""))
    .filter(Boolean);

  // Build per-borehole SVG sections
  const boreholeSections: string[] = renderBoreholeLogs(file).map((log) => `
      <section class="borehole" id="bh-${esc(log.locaId)}">
        ${log.svg}
      </section>`);

  // Groups table
  const groupRows = Object.entries(file.groups)
    .map(([name, g]) =>
      `<tr><td>${esc(name)}</td><td>${g.rows.length}</td><td>${g.headings.length}</td></tr>`)
    .join("\n");

  // Validation section
  const validationText = diagnostics.length === 0
    ? "<p style='color:#16a34a'>No issues found.</p>"
    : `<pre class="diag">${esc(render(diagnostics, Format.Text))}</pre>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeoFlow Explorer — ${esc(sourcePath)}</title>
<style>
  :root { font-family: system-ui, sans-serif; color: #1f2937; background: #f8fafc; }
  body { max-width: 900px; margin: 0 auto; padding: 1rem 1.5rem; }
  h1 { font-size: 1.5rem; color: #1e3a5f; border-bottom: 2px solid #1e3a5f; padding-bottom: .4rem; }
  h2 { font-size: 1.1rem; color: #1e40af; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; margin: .8rem 0; }
  th, td { border: 1px solid #d1d5db; padding: .35rem .7rem; font-size: .9rem; text-align: left; }
  th { background: #1e3a5f; color: #fff; }
  tr:nth-child(even) td { background: #f1f5f9; }
  .badges { display: flex; gap: .5rem; margin: .5rem 0; }
  .badge { padding: .2rem .6rem; border-radius: 9999px; font-size: .8rem; font-weight: 700; }
  .badge-error { background: #fee2e2; color: #b91c1c; }
  .badge-warn  { background: #fef9c3; color: #854d0e; }
  .badge-ok    { background: #dcfce7; color: #15803d; }
  .borehole { margin-top: 2rem; border-top: 1px solid #e2e8f0; padding-top: 1rem; }
  .borehole svg { max-width: 100%; height: auto; }
  pre.diag { background: #0f172a; color: #e2e8f0; padding: 1rem; border-radius: .4rem; overflow-x: auto; font-size: .8rem; line-height: 1.5; }
  nav { display: flex; flex-wrap: wrap; gap: .4rem; margin: 1rem 0; }
  nav a { background: #1e40af; color: #fff; padding: .25rem .6rem; border-radius: .3rem; text-decoration: none; font-size: .85rem; }
  nav a:hover { background: #1e3a5f; }
</style>
</head>
<body>
<h1>GeoFlow Explorer</h1>
<p><strong>Source:</strong> ${esc(sourcePath)}</p>

<div class="badges">
  ${errorCount > 0 ? `<span class="badge badge-error">${errorCount} error${errorCount !== 1 ? "s" : ""}</span>` : ""}
  ${warnCount > 0 ? `<span class="badge badge-warn">${warnCount} warning${warnCount !== 1 ? "s" : ""}</span>` : ""}
  ${errorCount === 0 && warnCount === 0 ? `<span class="badge badge-ok">No issues</span>` : ""}
</div>

${locaIds.length > 0 ? `<nav>${locaIds.map((id) => `<a href="#bh-${esc(id)}">${esc(id)}</a>`).join("")}</nav>` : ""}

<h2>Groups</h2>
<table>
  <thead><tr><th>Group</th><th>Rows</th><th>Headings</th></tr></thead>
  <tbody>${groupRows}</tbody>
</table>

<h2>Validation</h2>
${validationText}

${boreholeSections.join("\n")}

</body>
</html>`;
}

// ── Convenience wrapper ───────────────────────────────────────────────────────

export function renderExplorerFromText(text: string, sourcePath?: string): string {
  const { file } = parseStr(text);
  const opts: ExplorerOptions = sourcePath !== undefined ? { sourcePath } : {};
  return renderExplorer(file, opts);
}

export function renderExplorerFromBytes(bytes: Uint8Array, sourcePath?: string): string {
  return renderExplorerFromText(decodeBytes(bytes), sourcePath);
}
