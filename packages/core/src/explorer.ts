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
  loca?: AgsRow;
  generatedAt?: string;
}

/** Column geometry — single source of truth so headers, dividers and body align. */
const COLS = {
  depth: { x: 0,   w: 52,  label: "Depth (m)" },
  litho: { x: 52,  w: 88,  label: "Legend" },
  desc:  { x: 140, w: 200, label: "Description" },
  spt:   { x: 340, w: 90,  label: "SPT N-Value" },
  samp:  { x: 430, w: 50,  label: "Sample" },
  water: { x: 480, w: 40,  label: "Water" },
} as const;
const TOTAL_W = 520;

function renderBoreholeSvg(
  locaId: string,
  geol: AgsRow[],
  ispt: AgsRow[],
  samp: AgsRow[],
  wstk: AgsRow[],
  meta: BoreholeMeta = {},
): string {
  // ── Depth scale ────────────────────────────────────────────────────────────
  const loca = meta.loca ?? {};
  const fdep = num(loca["LOCA_FDEP"]);
  let maxDepth = Math.max(10, fdep);
  for (const r of geol) maxDepth = Math.max(maxDepth, num(r["GEOL_BASE"]));
  for (const r of ispt) maxDepth = Math.max(maxDepth, num(r["ISPT_TOP"]));
  maxDepth = Math.ceil(maxDepth) + 1;

  const PX_PER_M = 18;
  const bodyH = maxDepth * PX_PER_M;
  const HEAD_H = 90;    // title block
  const COL_H  = 22;    // column header strip
  const FOOT_H = 18;    // footer attribution

  // ── Legend block (only for kinds present in this borehole) ────────────────
  const kindsInUse = new Set<LithoKind>();
  for (const layer of geol) kindsInUse.add(geolKind(str(layer, "GEOL_DESC")));
  const legendItems = Array.from(kindsInUse);
  const LEG_COLS = 3;
  const LEG_ROW_H = 14;
  const legendRows = Math.max(1, Math.ceil(legendItems.length / LEG_COLS));
  const LEG_H = legendItems.length === 0 ? 0 : 22 + legendRows * LEG_ROW_H + 6;

  const totalH = HEAD_H + COL_H + bodyH + LEG_H + FOOT_H;

  // ── Metadata strings ──────────────────────────────────────────────────────
  const projId   = meta.projId   ?? "";
  const projName = meta.projName ?? "";
  const holeType = str(loca, "LOCA_TYPE") || "BH";
  const east     = str(loca, "LOCA_NATE");
  const north    = str(loca, "LOCA_NATN");
  const gl       = str(loca, "LOCA_GL");
  const startDt  = str(loca, "LOCA_STAR") || str(loca, "LOCA_ENDD");
  const logger   = str(loca, "LOCA_LOGD") || str(loca, "LOCA_ENG");
  const tdShown  = (fdep > 0 ? fdep : maxDepth - 1).toFixed(2);
  const idSuffix = (locaId || "x").replace(/[^A-Za-z0-9_-]/g, "_");

  const lines: string[] = [];
  lines.push(`<svg width="${TOTAL_W}" height="${totalH}" viewBox="0 0 ${TOTAL_W} ${totalH}" font-family="'Helvetica Neue',Arial,sans-serif" xmlns="http://www.w3.org/2000/svg">`);

  // Definitions: lithology hatch patterns
  lines.push(`<defs>${lithologyPatternDefs(idSuffix)}</defs>`);

  // Outer engineering frame
  lines.push(`<rect x="0.5" y="0.5" width="${TOTAL_W - 1}" height="${totalH - 1}" fill="#fff" stroke="#111" stroke-width="1"/>`);

  // ── 1. Title block ────────────────────────────────────────────────────────
  const tb = (x: number, y: number, w: number, h: number) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="#111" stroke-width="1"/>`;
  const tbLabel = (x: number, y: number, t: string) =>
    `<text x="${x + 4}" y="${y + 8}" font-size="6.5" fill="#475569" font-weight="700" letter-spacing="0.5">${esc(t.toUpperCase())}</text>`;
  const tbValue = (x: number, y: number, t: string, size = 10, weight = "600") =>
    `<text x="${x + 4}" y="${y + 20}" font-size="${size}" fill="#0f172a" font-weight="${weight}">${esc(t)}</text>`;

  // Row 1 (40px high): big BH-ID + project banner
  lines.push(tb(0, 0, 180, 40));
  lines.push(tbLabel(0, 0, "Borehole / Trial Pit"));
  lines.push(`<text x="6" y="32" font-size="20" font-weight="800" fill="#0f172a" font-family="'Helvetica Neue',Arial,sans-serif">${esc(locaId)}</text>`);
  lines.push(`<text x="170" y="32" font-size="8" font-weight="700" fill="#475569" text-anchor="end">${esc(holeType)}</text>`);

  lines.push(tb(180, 0, TOTAL_W - 180, 40));
  lines.push(tbLabel(180, 0, "Project"));
  lines.push(`<text x="186" y="28" font-size="12" font-weight="700" fill="#0f172a">${esc(projName || "—")}</text>`);
  if (projId) {
    lines.push(`<text x="${TOTAL_W - 6}" y="14" font-size="7" font-weight="700" fill="#475569" text-anchor="end">PROJ ID: ${esc(projId)}</text>`);
  }

  // Row 2 (24px) — coordinates
  lines.push(tb(0,   40, 130, 24));
  lines.push(tbLabel(0,   40, "Easting (m)"));
  lines.push(tbValue(0,   40, east || "—", 9));
  lines.push(tb(130, 40, 130, 24));
  lines.push(tbLabel(130, 40, "Northing (m)"));
  lines.push(tbValue(130, 40, north || "—", 9));
  lines.push(tb(260, 40, 130, 24));
  lines.push(tbLabel(260, 40, "Ground Level (m OD)"));
  lines.push(tbValue(260, 40, gl || "—", 9));
  lines.push(tb(390, 40, TOTAL_W - 390, 24));
  lines.push(tbLabel(390, 40, "Final Depth (m)"));
  lines.push(tbValue(390, 40, tdShown, 9));

  // Row 3 (26px) — dates / scale / sheet
  lines.push(tb(0,   64, 200, 26));
  lines.push(tbLabel(0,   64, "Date"));
  lines.push(tbValue(0,   64, startDt || meta.generatedAt || "—", 9, "500"));
  lines.push(tb(200, 64, 140, 26));
  lines.push(tbLabel(200, 64, "Logged by"));
  lines.push(tbValue(200, 64, logger || "—", 9, "500"));
  lines.push(tb(340, 64, 110, 26));
  lines.push(tbLabel(340, 64, "Scale"));
  lines.push(tbValue(340, 64, `1 cm ≈ ${(10 / PX_PER_M).toFixed(2)} m`, 8, "500"));
  lines.push(tb(450, 64, TOTAL_W - 450, 26));
  lines.push(tbLabel(450, 64, "Sheet"));
  lines.push(tbValue(450, 64, "1 of 1", 9, "500"));

  // ── 2. Column header strip ───────────────────────────────────────────────
  const colHeadY = HEAD_H;
  lines.push(`<rect x="0" y="${colHeadY}" width="${TOTAL_W}" height="${COL_H}" fill="#1e293b" stroke="#111" stroke-width="1"/>`);
  for (const c of Object.values(COLS)) {
    lines.push(`<line x1="${c.x}" y1="${colHeadY}" x2="${c.x}" y2="${colHeadY + COL_H}" stroke="#0f172a" stroke-width="0.7"/>`);
    lines.push(`<text x="${c.x + c.w / 2}" y="${colHeadY + 14}" font-size="8.5" font-weight="700" fill="#f8fafc" text-anchor="middle" letter-spacing="0.4">${esc(c.label.toUpperCase())}</text>`);
  }
  // SPT axis sub-labels (0 / 30 / 60)
  lines.push(`<text x="${COLS.spt.x + 4}" y="${colHeadY + 20}" font-size="6" fill="#cbd5e1">0</text>`);
  lines.push(`<text x="${COLS.spt.x + COLS.spt.w / 2}" y="${colHeadY + 20}" font-size="6" fill="#cbd5e1" text-anchor="middle">30</text>`);
  lines.push(`<text x="${COLS.spt.x + COLS.spt.w - 4}" y="${colHeadY + 20}" font-size="6" fill="#cbd5e1" text-anchor="end">60</text>`);

  // ── 3. Body ───────────────────────────────────────────────────────────────
  const bodyY = HEAD_H + COL_H;
  lines.push(`<g transform="translate(0,${bodyY})">`);

  // Column backgrounds + crisp dividers
  lines.push(`<rect x="0" y="0" width="${TOTAL_W}" height="${bodyH}" fill="#fff"/>`);
  for (const c of Object.values(COLS)) {
    lines.push(`<line x1="${c.x}" y1="0" x2="${c.x}" y2="${bodyH}" stroke="#111" stroke-width="0.8"/>`);
  }
  lines.push(`<line x1="${TOTAL_W}" y1="0" x2="${TOTAL_W}" y2="${bodyH}" stroke="#111" stroke-width="0.8"/>`);

  // SPT axis gridlines (at N=15,30,45)
  for (const n of [15, 30, 45]) {
    const x = COLS.spt.x + (n / 60) * COLS.spt.w;
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${bodyH}" stroke="#e5e7eb" stroke-width="0.5" stroke-dasharray="2,3"/>`);
  }

  // Depth scale: minor tick every 1 m, major tick + label every metre,
  // bold tick + bold label every 5 m, full-width grid line every 5 m.
  for (let i = 0; i <= maxDepth; i++) {
    const y = i * PX_PER_M;
    const major = i % 5 === 0;
    if (major) {
      lines.push(`<line x1="${COLS.depth.x}" y1="${y}" x2="${COLS.depth.x + COLS.depth.w}" y2="${y}" stroke="#111" stroke-width="0.8"/>`);
      lines.push(`<line x1="${COLS.depth.x + COLS.depth.w}" y1="${y}" x2="${TOTAL_W}" y2="${y}" stroke="#cbd5e1" stroke-width="0.5"/>`);
      lines.push(`<text x="${COLS.depth.x + COLS.depth.w - 18}" y="${y + 3}" font-size="9" text-anchor="end" font-weight="700" fill="#0f172a">${i}</text>`);
    } else {
      lines.push(`<line x1="${COLS.depth.x + COLS.depth.w - 8}" y1="${y}" x2="${COLS.depth.x + COLS.depth.w}" y2="${y}" stroke="#475569" stroke-width="0.5"/>`);
      lines.push(`<text x="${COLS.depth.x + COLS.depth.w - 12}" y="${y + 3}" font-size="7" text-anchor="end" fill="#475569">${i}</text>`);
    }
  }

  // GEOL layers — colour fill, hatch overlay, description
  for (const layer of geol) {
    const top = num(layer["GEOL_TOP"]);
    const base = num(layer["GEOL_BASE"]);
    const yTop = top * PX_PER_M;
    const yBot = base * PX_PER_M;
    const h = yBot - yTop;
    if (h <= 0) continue;
    const desc = str(layer, "GEOL_DESC");
    const geolGeol = str(layer, "GEOL_GEOL");
    const kind = geolKind(desc);
    const col = LITHO_INFO[kind].color;

    // Colour fill + pattern overlay in the Legend column
    lines.push(`<rect x="${COLS.litho.x}" y="${yTop}" width="${COLS.litho.w}" height="${h}" fill="${col}"/>`);
    lines.push(`<rect x="${COLS.litho.x}" y="${yTop}" width="${COLS.litho.w}" height="${h}" fill="url(#pat-${kind}-${idSuffix})"/>`);
    lines.push(`<rect x="${COLS.litho.x}" y="${yTop}" width="${COLS.litho.w}" height="${h}" fill="none" stroke="#111" stroke-width="0.6"><title>${esc(desc)} (${top.toFixed(2)} – ${base.toFixed(2)} m)</title></rect>`);

    // Solid contact line across the data columns
    lines.push(`<line x1="${COLS.desc.x}" y1="${yBot}" x2="${TOTAL_W}" y2="${yBot}" stroke="#111" stroke-width="0.6"/>`);

    // Description: depth-range + lithology code, then the full description
    lines.push(`<text x="${COLS.desc.x + 6}" y="${yTop + 11}" font-size="7" font-weight="700" fill="#475569" letter-spacing="0.3">${top.toFixed(2)} – ${base.toFixed(2)} m${geolGeol ? `  ·  ${esc(geolGeol)}` : ""}</text>`);
    if (h > 18) {
      // Word-wrap description across however many lines fit
      const maxLines = Math.floor((h - 14) / 9);
      const wrapped = wrapText(desc, 36, maxLines);
      wrapped.forEach((ln, ix) => {
        lines.push(`<text x="${COLS.desc.x + 6}" y="${yTop + 22 + ix * 9}" font-size="8" fill="#0f172a">${esc(ln)}</text>`);
      });
    }
  }

  // ISPT SPT bars (preserved improvement, now horizontal bar + N label)
  for (const test of ispt) {
    const depth = num(test["ISPT_TOP"]);
    const rawN = num(test["ISPT_NVAL"]);
    const nval = Math.min(rawN, 60);
    const barPx = (nval / 60) * COLS.spt.w;
    const yBar = depth * PX_PER_M - 4;
    lines.push(`<line x1="${COLS.spt.x}" y1="${depth * PX_PER_M}" x2="${COLS.spt.x + barPx}" y2="${depth * PX_PER_M}" stroke="#9a3412" stroke-width="0.4"/>`);
    lines.push(`<rect x="${COLS.spt.x}" y="${yBar}" width="${barPx.toFixed(1)}" height="8" fill="#f97316" stroke="#9a3412" stroke-width="0.6"><title>SPT N=${Math.round(rawN)} at ${depth.toFixed(2)} m</title></rect>`);
    if (rawN > 0) {
      const labelX = COLS.spt.x + Math.min(COLS.spt.w - 4, barPx + 3);
      lines.push(`<text x="${labelX}" y="${yBar + 6}" font-size="7.5" font-weight="700" fill="#0f172a">${Math.round(rawN)}</text>`);
    }
  }

  // SAMP markers — engineering-style boxed icon with type code
  for (const s of samp) {
    const depth = num(s["SAMP_TOP"]);
    const yS = depth * PX_PER_M - 5;
    const sampType = str(s, "SAMP_TYPE") || "B";
    const sampRef = str(s, "SAMP_REF");
    lines.push(`<rect x="${COLS.samp.x + 4}" y="${yS}" width="${COLS.samp.w - 8}" height="10" fill="#fff" stroke="#1e3a8a" stroke-width="0.7"><title>Sample ${esc(sampRef)} (${esc(sampType)}) at ${depth.toFixed(2)} m</title></rect>`);
    lines.push(`<text x="${COLS.samp.x + COLS.samp.w / 2}" y="${yS + 7.5}" font-size="7.5" text-anchor="middle" font-weight="700" fill="#1e3a8a">${esc(sampType.slice(0, 3))}</text>`);
  }

  // WSTK water strikes — inverted triangle + horizontal level line
  for (const ws of wstk) {
    const depth = num(ws["WSTK_DPTH"]);
    const cy = depth * PX_PER_M;
    const cx = COLS.water.x + COLS.water.w / 2;
    lines.push(`<line x1="${COLS.water.x + 4}" y1="${cy}" x2="${COLS.water.x + COLS.water.w - 4}" y2="${cy}" stroke="#0369a1" stroke-width="0.6" stroke-dasharray="3,2"/>`);
    lines.push(`<polygon points="${cx},${cy + 8} ${cx - 5},${cy - 2} ${cx + 5},${cy - 2}" fill="#0ea5e9" stroke="#0369a1" stroke-width="0.6"><title>Water strike at ${depth.toFixed(2)} m</title></polygon>`);
  }

  // End-of-hole marker
  if (fdep > 0 && fdep <= maxDepth) {
    const y = fdep * PX_PER_M;
    lines.push(`<line x1="${COLS.litho.x}" y1="${y}" x2="${TOTAL_W}" y2="${y}" stroke="#111" stroke-width="1.4"/>`);
    lines.push(`<text x="${COLS.desc.x + COLS.desc.w / 2}" y="${y + 11}" font-size="8" font-weight="700" fill="#475569" text-anchor="middle" letter-spacing="0.4">END OF HOLE — ${fdep.toFixed(2)} m</text>`);
  }

  lines.push(`</g>`);

  // ── 4. Legend block ──────────────────────────────────────────────────────
  if (LEG_H > 0) {
    const lY = HEAD_H + COL_H + bodyH;
    lines.push(`<rect x="0" y="${lY}" width="${TOTAL_W}" height="${LEG_H}" fill="#f8fafc" stroke="#111" stroke-width="1"/>`);
    lines.push(`<text x="8" y="${lY + 14}" font-size="8" font-weight="700" fill="#475569" letter-spacing="0.5">LEGEND — LITHOLOGY</text>`);
    const colW = (TOTAL_W - 16) / LEG_COLS;
    legendItems.forEach((kind, ix) => {
      const row = Math.floor(ix / LEG_COLS);
      const col = ix % LEG_COLS;
      const x = 8 + col * colW;
      const y = lY + 22 + row * LEG_ROW_H;
      const info = LITHO_INFO[kind];
      lines.push(`<rect x="${x}" y="${y}" width="22" height="10" fill="${info.color}" stroke="#111" stroke-width="0.5"/>`);
      lines.push(`<rect x="${x}" y="${y}" width="22" height="10" fill="url(#pat-${kind}-${idSuffix})"/>`);
      lines.push(`<text x="${x + 28}" y="${y + 8}" font-size="8" fill="#0f172a">${esc(info.label)}</text>`);
    });
  }

  // ── 5. Footer ────────────────────────────────────────────────────────────
  const fY = totalH - FOOT_H;
  lines.push(`<line x1="0" y1="${fY}" x2="${TOTAL_W}" y2="${fY}" stroke="#111" stroke-width="1"/>`);
  lines.push(`<text x="6" y="${fY + 12}" font-size="7" fill="#475569">GeoFlow Explorer  ·  Borehole strip log  ·  not to scale when reproduced</text>`);
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

  // Project metadata (shared across boreholes)
  const projRow = file.groups["PROJ"]?.rows[0] ?? {};
  const projId = str(projRow as AgsRow, "PROJ_ID");
  const projName = str(projRow as AgsRow, "PROJ_NAME");
  const generatedAt = new Date().toISOString().slice(0, 10);

  // Build per-borehole SVG sections
  const boreholeSections: string[] = [];
  for (const locaId of locaIds) {
    const filterById = (rows: AgsRow[]) =>
      rows.filter((r) => String(r["LOCA_ID"] ?? "") === locaId);

    const loca = locaRows.find((r) => String(r["LOCA_ID"] ?? "") === locaId);
    const geol = filterById(file.groups["GEOL"]?.rows ?? []);
    const ispt = filterById(file.groups["ISPT"]?.rows ?? []);
    const samp = filterById(file.groups["SAMP"]?.rows ?? []);
    const wstk = filterById(file.groups["WSTK"]?.rows ?? []);

    const meta: BoreholeMeta = { projId, projName, generatedAt };
    if (loca) meta.loca = loca;
    const svg = renderBoreholeSvg(locaId, geol, ispt, samp, wstk, meta);
    boreholeSections.push(`
      <section class="borehole" id="bh-${esc(locaId)}">
        ${svg}
      </section>`);
  }

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
