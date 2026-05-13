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

// ── Colour mapping (mirrors Rust geol_color filter) ──────────────────────────

function geolColor(desc: string): string {
  const u = (desc ?? "").toUpperCase();
  if (u.includes("MADE GROUND") || u.includes("FILL") || u.includes("HARDCORE")) return "#A0785A";
  if (u.includes("TOPSOIL") || u.includes("TOP SOIL")) return "#5C7A3E";
  if (u.includes("PEAT") || u.includes("ORGANIC")) return "#3D2B1F";
  if (u.includes("CHALK")) return "#F5F0C8";
  if (u.includes("CLAY")) return "#7B9EC5";
  if (u.includes("SILT")) return "#C4A87C";
  if (u.includes("SANDY GRAVEL") || u.includes("GRAVELLY SAND")) return "#D99055";
  if (u.includes("SILTY SAND") || u.includes("SANDY SILT")) return "#D8C080";
  if (u.includes("GRAVEL")) return "#C87A45";
  if (u.includes("SANDSTONE")) return "#D4B483";
  if (u.includes("SAND")) return "#F0D870";
  if (u.includes("MUDSTONE") || u.includes("SHALE")) return "#7A7A90";
  if (u.includes("LIMESTONE")) return "#C8CEB8";
  if (u.includes("GRANITE") || u.includes("DIORITE") || u.includes("IGNEOUS")) return "#808090";
  if (u.includes("BASALT")) return "#505060";
  if (u.includes("ROCK") || u.includes("BEDROCK")) return "#9090A0";
  return "#d1d5db";
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

function renderBoreholeSvg(
  locaId: string,
  geol: AgsRow[],
  ispt: AgsRow[],
  samp: AgsRow[],
  wstk: AgsRow[],
): string {
  // Determine total depth from GEOL_BASE or ISPT depth
  let maxDepth = 10;
  for (const r of geol) maxDepth = Math.max(maxDepth, num(r["GEOL_BASE"]));
  for (const r of ispt) maxDepth = Math.max(maxDepth, num(r["ISPT_TOP"]));
  maxDepth = Math.ceil(maxDepth) + 1;

  const PX_PER_M = 15;
  const bodyH = maxDepth * PX_PER_M;
  const totalH = bodyH + 30;

  const lines: string[] = [];

  lines.push(`<svg width="520" height="${totalH}" viewBox="0 0 520 ${totalH}" font-family="system-ui,sans-serif" xmlns="http://www.w3.org/2000/svg">`);

  // Header
  lines.push(`<rect x="0" y="0" width="520" height="30" fill="#1e3a5f"/>`);
  lines.push(`<text x="36" y="19" font-size="8.5" font-weight="700" text-anchor="middle" fill="#cbd5e1">Depth (m)</text>`);
  lines.push(`<text x="95" y="19" font-size="8.5" font-weight="700" text-anchor="middle" fill="#fff">Lithology</text>`);
  lines.push(`<text x="265" y="19" font-size="8.5" font-weight="700" text-anchor="middle" fill="#fff">Description</text>`);
  lines.push(`<text x="365" y="13" font-size="8.5" font-weight="700" text-anchor="middle" fill="#fff">SPT N-Value</text>`);
  lines.push(`<text x="345" y="25" font-size="7" fill="#94a3b8">0</text>`);
  lines.push(`<text x="383" y="25" font-size="7" text-anchor="middle" fill="#94a3b8">30</text>`);
  lines.push(`<text x="425" y="25" font-size="7" text-anchor="end" fill="#94a3b8">60</text>`);
  lines.push(`<text x="460" y="19" font-size="8.5" font-weight="700" text-anchor="middle" fill="#fff">Smpl</text>`);
  lines.push(`<text x="497" y="19" font-size="8.5" font-weight="700" text-anchor="middle" fill="#fff">WL</text>`);
  lines.push(`<line x1="50" y1="0" x2="50" y2="30" stroke="#334155" stroke-width="0.5"/>`);
  lines.push(`<line x1="140" y1="0" x2="140" y2="30" stroke="#334155" stroke-width="0.5"/>`);
  lines.push(`<line x1="340" y1="0" x2="340" y2="30" stroke="#334155" stroke-width="0.5"/>`);
  lines.push(`<line x1="430" y1="0" x2="430" y2="30" stroke="#334155" stroke-width="0.5"/>`);
  lines.push(`<line x1="480" y1="0" x2="480" y2="30" stroke="#334155" stroke-width="0.5"/>`);

  lines.push(`<g transform="translate(0,30)">`);

  // Column backgrounds
  lines.push(`<rect x="0"   y="0" width="50"  height="${bodyH}" fill="#f8fafc"/>`);
  lines.push(`<rect x="50"  y="0" width="90"  height="${bodyH}" fill="#fafafa" stroke="#e2e8f0" stroke-width="0.5"/>`);
  lines.push(`<rect x="140" y="0" width="200" height="${bodyH}" fill="#fff"    stroke="#e2e8f0" stroke-width="0.5"/>`);
  lines.push(`<rect x="340" y="0" width="90"  height="${bodyH}" fill="#fafafa" stroke="#e2e8f0" stroke-width="0.5"/>`);
  lines.push(`<rect x="430" y="0" width="50"  height="${bodyH}" fill="#f8fafc" stroke="#e2e8f0" stroke-width="0.5"/>`);
  lines.push(`<rect x="480" y="0" width="40"  height="${bodyH}" fill="#f0f9ff" stroke="#e2e8f0" stroke-width="0.5"/>`);

  // SPT grid
  lines.push(`<line x1="363" y1="0" x2="363" y2="${bodyH}" stroke="#e5e7eb" stroke-width="0.5"/>`);
  lines.push(`<line x1="383" y1="0" x2="383" y2="${bodyH}" stroke="#dde1e7" stroke-width="0.8"/>`);
  lines.push(`<line x1="403" y1="0" x2="403" y2="${bodyH}" stroke="#e5e7eb" stroke-width="0.5"/>`);

  // Depth axis
  lines.push(`<line x1="44" y1="0" x2="44" y2="${bodyH}" stroke="#374151" stroke-width="1"/>`);

  // Depth ticks and grid
  for (let i = 0; i <= maxDepth; i++) {
    const y = i * PX_PER_M;
    if (i % 5 === 0) {
      lines.push(`<text x="40" y="${y + 3}" font-size="9" text-anchor="end" fill="#374151" font-weight="600">${i}</text>`);
      lines.push(`<line x1="36" y1="${y}" x2="44" y2="${y}" stroke="#374151" stroke-width="1"/>`);
      lines.push(`<line x1="50" y1="${y}" x2="520" y2="${y}" stroke="#dde1e7" stroke-width="0.5"/>`);
    } else {
      lines.push(`<line x1="40" y1="${y}" x2="44" y2="${y}" stroke="#9ca3af" stroke-width="0.5"/>`);
    }
  }

  // GEOL layers
  for (const layer of geol) {
    const top = num(layer["GEOL_TOP"]);
    const base = num(layer["GEOL_BASE"]);
    const yTop = top * PX_PER_M;
    const yBot = base * PX_PER_M;
    const h = yBot - yTop;
    const desc = str(layer, "GEOL_DESC");
    const geolGeol = str(layer, "GEOL_GEOL");
    const col = geolColor(desc);

    lines.push(`<rect x="51" y="${yTop}" width="88" height="${h}" fill="${col}" stroke="#6b7280" stroke-width="0.5" opacity="0.9"><title>${esc(desc)} (${top}–${base} m)</title></rect>`);
    lines.push(`<line x1="50" y1="${yBot}" x2="430" y2="${yBot}" stroke="#9ca3af" stroke-width="0.6" stroke-dasharray="3,2"/>`);
    if (h > 12) {
      lines.push(`<text x="144" y="${yTop + 11}" font-size="8.5" font-weight="700" fill="#1f2937">${esc(desc.slice(0, 34))}</text>`);
    }
    if (h > 24 && geolGeol) {
      lines.push(`<text x="144" y="${yTop + 21}" font-size="8" fill="#374151">${esc(geolGeol.slice(0, 40))}</text>`);
    }
  }

  // ISPT SPT bars
  for (const test of ispt) {
    const depth = num(test["ISPT_TOP"]);
    const nval = Math.min(num(test["ISPT_NVAL"]), 60);
    const barPx = nval * 1.333;
    const yBar = depth * PX_PER_M - 4;
    lines.push(`<rect x="340" y="${yBar}" width="${barPx.toFixed(1)}" height="8" fill="#f97316" stroke="#c2410c" stroke-width="0.5" rx="1" opacity="0.85"><title>SPT N=${Math.round(nval)} at ${depth} m</title></rect>`);
    if (nval > 0) {
      lines.push(`<text x="${(342 + barPx).toFixed(1)}" y="${yBar + 6}" font-size="7.5" fill="#374151">${Math.round(nval)}</text>`);
    }
  }

  // SAMP markers
  for (const s of samp) {
    const depth = num(s["SAMP_TOP"]);
    const yS = depth * PX_PER_M - 4;
    const sampType = str(s, "SAMP_TYPE") || "B";
    lines.push(`<rect x="433" y="${yS}" width="42" height="8" fill="#3b82f6" stroke="#1d4ed8" stroke-width="0.5" rx="1"><title>Sample ${esc(str(s, "SAMP_REF"))} (${esc(sampType)}) at ${depth} m</title></rect>`);
    lines.push(`<text x="454" y="${yS + 6}" font-size="7" text-anchor="middle" fill="white" font-weight="700">${esc(sampType.slice(0, 2))}</text>`);
  }

  // WSTK water strikes
  for (const ws of wstk) {
    const depth = num(ws["WSTK_DPTH"]);
    const cy = depth * PX_PER_M;
    lines.push(`<polygon points="500,${cy - 6} 506,${cy} 500,${cy + 6} 494,${cy}" fill="#0ea5e9" stroke="#0369a1" stroke-width="0.5"><title>Water strike at ${depth} m</title></polygon>`);
  }

  lines.push("</g></svg>");
  return lines.join("\n");
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
  const locaIds: string[] = locaGroup
    ? locaGroup.rows.map((r) => String(r["LOCA_ID"] ?? "")).filter(Boolean)
    : [];

  // Build per-borehole SVG sections
  const boreholeSections: string[] = [];
  for (const locaId of locaIds) {
    const filterById = (rows: AgsRow[]) =>
      rows.filter((r) => String(r["LOCA_ID"] ?? "") === locaId);

    const geol = filterById(file.groups["GEOL"]?.rows ?? []);
    const ispt = filterById(file.groups["ISPT"]?.rows ?? []);
    const samp = filterById(file.groups["SAMP"]?.rows ?? []);
    const wstk = filterById(file.groups["WSTK"]?.rows ?? []);

    const svg = renderBoreholeSvg(locaId, geol, ispt, samp, wstk);
    boreholeSections.push(`
      <section class="borehole" id="bh-${esc(locaId)}">
        <h2>Borehole: ${esc(locaId)}</h2>
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
