/**
 * cpt.ts — Cone Penetration Test (CPT/CPTu) ingest, classification and
 * derived geotechnical parameters.
 *
 * Scope:
 *   - parse CSV-style CPT files (depth, qc, fs, optional u2)
 *   - parse a minimal subset of Dutch GEF format (header + data block)
 *   - Robertson (1990) Soil Behaviour Type classification (9 zones)
 *   - derived parameters: total/effective stress, qt, Rf, Fr, Bq, Ic,
 *     undrained shear strength (Su = (qt - σv₀) / Nkt),
 *     drained friction angle (Robertson & Campanella 1983),
 *     relative density (Baldi et al. 1986)
 *   - SVG plot of qt / fs / Rf / SBT vs depth
 *
 * No external deps. All numerics in SI units (m, kPa, kN/m³).
 */

// ── Data model ────────────────────────────────────────────────────────────────

/** A single CPT reading at one depth. Inputs are raw cone measurements. */
export interface CptReading {
  /** Depth below ground level (m). */
  depth: number;
  /** Cone tip resistance (kPa). */
  qc: number;
  /** Sleeve friction (kPa). */
  fs: number;
  /** Pore pressure behind cone (u₂), kPa. Optional — required for Bq and Ic_u. */
  u2?: number;
}

/** A full CPT sounding (one location). */
export interface CptSounding {
  /** Identifier — typically the AGS LOCA_ID or sounding name. */
  id: string;
  /** Ground elevation in m OD (optional, only used for elevation-axis plots). */
  groundElev?: number;
  /** Net area ratio (a) of the cone — used to correct qc to qt. Default 0.8. */
  netAreaRatio?: number;
  /** Phreatic surface depth below ground level (m). Default Infinity (dry). */
  waterTableDepth?: number;
  /** Soil unit weight model: either a constant or piecewise by depth. */
  unitWeightProfile?: UnitWeightProfile;
  /** Readings sorted ascending in depth. */
  readings: CptReading[];
}

/**
 * Unit-weight profile. If absent, a generic value of 18 kN/m³ is assumed above
 * the water table and 19 kN/m³ below.
 */
export type UnitWeightProfile =
  | { kind: "constant"; gamma: number }
  | { kind: "layers"; layers: Array<{ topDepth: number; gamma: number }> };

/** Robertson 1990 Soil Behaviour Type zones (1–9). */
export type SbtZone = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** Derived values for a single reading. */
export interface CptDerived {
  depth: number;
  qt: number;             // corrected cone resistance (kPa)
  fs: number;             // sleeve friction (kPa)
  Rf: number;             // friction ratio (%)
  u0: number;             // hydrostatic pore pressure (kPa)
  sigmaV0: number;        // total vertical stress (kPa)
  sigmaV0Eff: number;     // effective vertical stress (kPa)
  Qt: number;             // normalised cone resistance (-)
  Fr: number;             // normalised friction ratio (%)
  Bq: number | null;      // pore pressure ratio (null if u2 missing)
  Ic: number;             // Robertson (1998) soil behaviour type index
  sbt: SbtZone;           // 1–9 zone from Robertson 1990
  sbtName: string;
  /** Su = (qt − σv₀) / Nkt   (kPa). Caller supplies Nkt; default 14. */
  Su?: number;
  /** Effective friction angle (°), Robertson & Campanella (1983). Coarse soils only. */
  phiPrime?: number;
  /** Relative density (%), Baldi et al. (1986). Coarse soils only. */
  Dr?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Atmospheric reference pressure used by Robertson normalisations (kPa). */
export const PA = 100;

/** Default cone-bearing factor for Su back-calculation. */
export const DEFAULT_NKT = 14;

const G_WATER = 9.81; // unit weight of water, kN/m³

const SBT_NAMES: Record<SbtZone, string> = {
  1: "Sensitive fine grained",
  2: "Organic soils / peat",
  3: "Clay — clay to silty clay",
  4: "Silt mixtures — clayey silt to silty clay",
  5: "Sand mixtures — silty sand to sandy silt",
  6: "Sands — clean sand to silty sand",
  7: "Gravelly sand to dense sand",
  8: "Very stiff sand to clayey sand (heavily over-consolidated)",
  9: "Very stiff fine grained (heavily over-consolidated)",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function gammaAt(profile: UnitWeightProfile | undefined, depth: number, belowWt: boolean): number {
  if (!profile) return belowWt ? 19 : 18;
  if (profile.kind === "constant") return profile.gamma;
  // layers: pick deepest layer whose topDepth ≤ depth
  let g = belowWt ? 19 : 18;
  for (const l of profile.layers) {
    if (l.topDepth <= depth) g = l.gamma;
    else break;
  }
  return g;
}

/**
 * Integrate vertical stress from the ground surface down to each reading
 * using trapezoidal rule with the unit-weight profile.
 */
function buildStressProfile(s: CptSounding): { sigma: number[]; u0: number[] } {
  const wt = s.waterTableDepth ?? Infinity;
  const n = s.readings.length;
  const sigma = new Array<number>(n).fill(0);
  const u0 = new Array<number>(n).fill(0);

  let prevDepth = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const r = s.readings[i]!;
    const dz = r.depth - prevDepth;
    if (dz > 0) {
      const mid = (prevDepth + r.depth) / 2;
      const belowWt = mid > wt;
      const g = gammaAt(s.unitWeightProfile, mid, belowWt);
      acc += g * dz;
    }
    sigma[i] = acc;
    u0[i] = r.depth > wt ? (r.depth - wt) * G_WATER : 0;
    prevDepth = r.depth;
  }
  return { sigma, u0 };
}

/** qt = qc + (1 − a) · u₂  (Lunne et al. 1997). */
function correctQt(qc: number, u2: number | undefined, a: number): number {
  if (u2 === undefined) return qc;
  return qc + (1 - a) * u2;
}

/** Robertson 1998 SBT index Ic. */
function computeIc(Qt: number, Fr: number): number {
  const a = 3.47 - Math.log10(Math.max(Qt, 1e-6));
  const b = Math.log10(Math.max(Fr, 1e-6)) + 1.22;
  return Math.sqrt(a * a + b * b);
}

/**
 * Robertson (1990) SBT zone from normalised (Qt, Fr).
 *
 * Implementation: Ic ranges classify zones 2–7; zones 1, 8, 9 are picked from
 * the corners of the Qt–Fr chart where high Qt and either very low or very
 * high Fr indicate heavily-over-consolidated or sensitive material.
 */
function computeSbt(Qt: number, Fr: number, Ic: number): SbtZone {
  // Corner zones (override Ic when conditions met)
  if (Qt > 100 && Fr < 1.0) return 8;
  if (Qt > 100 && Fr >= 1.0 && Fr < 8.0) return 9;
  if (Qt < 12 && Fr > 6.0) return 1;

  if (Ic > 3.6) return 2;       // organic / peat
  if (Ic > 2.95) return 3;      // clay
  if (Ic > 2.6) return 4;       // silt mixtures
  if (Ic > 2.05) return 5;      // sand mixtures
  if (Ic > 1.31) return 6;      // sands
  return 7;                     // gravelly sand
}

/** Whether a Robertson SBT zone is generally considered "coarse-grained". */
function isCoarseZone(z: SbtZone): boolean {
  return z === 5 || z === 6 || z === 7 || z === 8;
}

/** Whether a zone is generally considered "fine-grained" (cohesive). */
function isFineZone(z: SbtZone): boolean {
  return z === 1 || z === 2 || z === 3 || z === 4 || z === 9;
}

// ── Public API: derive ────────────────────────────────────────────────────────

export interface DeriveOptions {
  /** Cone bearing factor for Su = (qt − σv₀)/Nkt. Default 14. */
  nkt?: number;
  /** Whether to compute φ′ and Dr in coarse-grained zones. Default true. */
  deriveCoarse?: boolean;
  /** Whether to compute Su in fine-grained zones. Default true. */
  deriveFine?: boolean;
}

/**
 * Compute the full derived profile for a CPT sounding.
 *
 * The returned array is parallel to `sounding.readings`. Empty arrays in,
 * empty arrays out.
 */
export function deriveCpt(sounding: CptSounding, opts: DeriveOptions = {}): CptDerived[] {
  const nkt = opts.nkt ?? DEFAULT_NKT;
  const deriveCoarse = opts.deriveCoarse !== false;
  const deriveFine = opts.deriveFine !== false;
  const a = sounding.netAreaRatio ?? 0.8;

  const { sigma, u0 } = buildStressProfile(sounding);
  const out: CptDerived[] = [];

  for (let i = 0; i < sounding.readings.length; i++) {
    const r = sounding.readings[i]!;
    const sigmaV0 = sigma[i]!;
    const u0i = u0[i]!;
    const sigmaV0Eff = Math.max(0.1, sigmaV0 - u0i);
    const qt = correctQt(r.qc, r.u2, a);
    const Rf = qt > 0 ? (r.fs / qt) * 100 : 0;
    const Qt = (qt - sigmaV0) / Math.max(sigmaV0Eff, 0.1);
    const QtPos = Math.max(Qt, 0.01);
    const Fr = (qt - sigmaV0) > 0 ? (r.fs / (qt - sigmaV0)) * 100 : 0;
    const FrPos = Math.max(Fr, 0.01);
    const Bq = r.u2 !== undefined && (qt - sigmaV0) > 0
      ? (r.u2 - u0i) / (qt - sigmaV0)
      : null;
    const Ic = computeIc(QtPos, FrPos);
    const sbt = computeSbt(QtPos, FrPos, Ic);

    const d: CptDerived = {
      depth: r.depth,
      qt, fs: r.fs, Rf,
      u0: u0i, sigmaV0, sigmaV0Eff,
      Qt, Fr, Bq, Ic, sbt, sbtName: SBT_NAMES[sbt],
    };

    if (deriveFine && isFineZone(sbt)) {
      const su = (qt - sigmaV0) / nkt;
      if (su > 0) d.Su = su;
    }
    if (deriveCoarse && isCoarseZone(sbt)) {
      // φ′ — Robertson & Campanella (1983), valid for clean sand.
      // tan(φ′) = (1/2.68) · [log10(qc/σv0′) + 0.29]
      if (sigmaV0Eff > 0 && r.qc > 0) {
        const tanPhi = (1 / 2.68) * (Math.log10(r.qc / sigmaV0Eff) + 0.29);
        if (tanPhi > 0) {
          const phi = Math.atan(tanPhi) * 180 / Math.PI;
          if (phi > 20 && phi < 55) d.phiPrime = phi;
        }
      }
      // Dr — Baldi et al. (1986) for normally-consolidated, uncemented sand.
      // Dr (%) = (1/2.41) · ln[ qc / (157 · σv0′^0.55) ] · 100
      if (sigmaV0Eff > 0 && r.qc > 0) {
        const denom = 157 * Math.pow(sigmaV0Eff, 0.55);
        const dr = (1 / 2.41) * Math.log(r.qc / denom) * 100;
        if (dr > 0 && dr < 105) d.Dr = dr;
      }
    }

    out.push(d);
  }

  return out;
}

// ── Public API: SBT summary ───────────────────────────────────────────────────

export interface SbtBand {
  topDepth: number;
  baseDepth: number;
  sbt: SbtZone;
  name: string;
}

/** Collapse a derived profile into runs of contiguous SBT zone. */
export function summariseSbtBands(derived: CptDerived[]): SbtBand[] {
  if (derived.length === 0) return [];
  const bands: SbtBand[] = [];
  let currentZone = derived[0]!.sbt;
  let bandTop = derived[0]!.depth;
  for (let i = 1; i < derived.length; i++) {
    const d = derived[i]!;
    if (d.sbt !== currentZone) {
      bands.push({
        topDepth: bandTop,
        baseDepth: d.depth,
        sbt: currentZone,
        name: SBT_NAMES[currentZone],
      });
      currentZone = d.sbt;
      bandTop = d.depth;
    }
  }
  const last = derived[derived.length - 1]!;
  bands.push({
    topDepth: bandTop,
    baseDepth: last.depth,
    sbt: currentZone,
    name: SBT_NAMES[currentZone],
  });
  return bands;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

/** Result of a parse, with diagnostics. */
export interface CptParseResult {
  sounding: CptSounding | null;
  warnings: string[];
  errors: string[];
}

interface ParseCptCsvOptions {
  id?: string;
  /** Override the netAreaRatio embedded in the file. */
  netAreaRatio?: number;
  waterTableDepth?: number;
  groundElev?: number;
}

/**
 * Parse a CSV-style CPT file.
 *
 * Accepts comma, tab, semicolon or whitespace as the column separator.
 * Header row required — columns matched case-insensitively against:
 *   depth | z | h    →  depth (m)
 *   qc  | qt        →  cone resistance (kPa or MPa, auto-detected)
 *   fs              →  sleeve friction (kPa or MPa, auto-detected)
 *   u2 | u | u_2    →  pore pressure (kPa or MPa, optional)
 *
 * Unit auto-detection: if the max value in the qc column is < 100 we assume
 * MPa and multiply by 1000 to convert to kPa. fs and u2 are independently
 * checked against their own thresholds.
 */
export function parseCptCsv(text: string, opts: ParseCptCsvOptions = {}): CptParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("#"));
  if (rawLines.length < 2) {
    errors.push("CPT file needs at least a header row and one data row.");
    return { sounding: null, warnings, errors };
  }

  const sep = detectSeparator(rawLines[0]!);
  const headers = rawLines[0]!.split(sep).map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""));

  const idxDepth = findIndex(headers, ["depth", "z", "h"]);
  const idxQc    = findIndex(headers, ["qc", "qt", "qcmpa", "qckpa"]);
  const idxFs    = findIndex(headers, ["fs", "fsmpa", "fskpa"]);
  const idxU2    = findIndex(headers, ["u2", "u", "u_2", "u2kpa", "u2mpa"]);

  if (idxDepth < 0 || idxQc < 0 || idxFs < 0) {
    errors.push(`Missing required columns. Got headers: ${headers.join(", ")}`);
    return { sounding: null, warnings, errors };
  }

  const rawRows: Array<{ depth: number; qc: number; fs: number; u2?: number }> = [];
  for (let i = 1; i < rawLines.length; i++) {
    const cols = rawLines[i]!.split(sep).map(c => c.trim());
    if (cols.length < Math.max(idxDepth, idxQc, idxFs) + 1) continue;
    const depth = numOrNaN(cols[idxDepth]);
    const qc = numOrNaN(cols[idxQc]);
    const fs = numOrNaN(cols[idxFs]);
    if (!isFinite(depth) || !isFinite(qc) || !isFinite(fs)) continue;
    const row: { depth: number; qc: number; fs: number; u2?: number } = { depth, qc, fs };
    if (idxU2 >= 0) {
      const u2 = numOrNaN(cols[idxU2]);
      if (isFinite(u2)) row.u2 = u2;
    }
    rawRows.push(row);
  }

  if (rawRows.length === 0) {
    errors.push("No numeric data rows could be parsed.");
    return { sounding: null, warnings, errors };
  }

  rawRows.sort((a, b) => a.depth - b.depth);

  // Auto-detect units (MPa → kPa) — column-by-column
  const maxQc = Math.max(...rawRows.map(r => r.qc));
  const maxFs = Math.max(...rawRows.map(r => r.fs));
  const maxU2 = Math.max(...rawRows.map(r => r.u2 ?? -Infinity));

  let qcMul = 1;
  let fsMul = 1;
  let u2Mul = 1;
  if (maxQc > 0 && maxQc < 100) { qcMul = 1000; warnings.push("Auto-detected qc as MPa; converted to kPa."); }
  if (maxFs > 0 && maxFs < 1) { fsMul = 1000; warnings.push("Auto-detected fs as MPa; converted to kPa."); }
  if (isFinite(maxU2) && maxU2 < 5) { u2Mul = 1000; warnings.push("Auto-detected u2 as MPa; converted to kPa."); }

  const readings: CptReading[] = rawRows.map(r => {
    const reading: CptReading = {
      depth: r.depth,
      qc: r.qc * qcMul,
      fs: r.fs * fsMul,
    };
    if (r.u2 !== undefined) reading.u2 = r.u2 * u2Mul;
    return reading;
  });

  const sounding: CptSounding = {
    id: opts.id ?? "CPT",
    readings,
    netAreaRatio: opts.netAreaRatio ?? 0.8,
    waterTableDepth: opts.waterTableDepth ?? Infinity,
    ...(opts.groundElev !== undefined ? { groundElev: opts.groundElev } : {}),
  };

  return { sounding, warnings, errors };
}

/**
 * Parse a minimal subset of the GEF (Geotechnical Exchange Format) CPT file.
 *
 * Supports:
 *   - #COLUMN= header definitions (column number, type, unit)
 *   - #MEASUREMENTTEXT= 4, <id>   (sounding ID, if present)
 *   - #ZID= ..., <elev>, ...      (ground elevation)
 *   - #EOH=                        end of header marker
 *
 * The data block is parsed with whitespace as the column separator and the
 * value at column "1" (or "depth"/"penetration length") is treated as depth.
 *
 * Anything not understood is reported as a warning rather than an error.
 */
export function parseCptGef(text: string, opts: ParseCptCsvOptions = {}): CptParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const lines = text.split(/\r?\n/);
  let i = 0;

  interface Col { type: string; unit: string }
  const columns = new Map<number, Col>(); // 1-based
  let id = opts.id ?? "CPT";
  let groundElev: number | undefined = opts.groundElev;

  // Header
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#EOH")) { i++; break; }
    if (!line.startsWith("#")) break; // implicit end of header
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(1, eq).trim().toUpperCase();
    const value = line.slice(eq + 1).trim();
    if (key === "COLUMN") {
      // e.g. COLUMN= 1, length, m
      const parts = value.split(",").map(p => p.trim());
      const idx = parseInt(parts[0] ?? "", 10);
      const type = (parts[1] ?? "").toLowerCase();
      const unit = (parts[2] ?? "").toLowerCase();
      if (!isNaN(idx)) columns.set(idx, { type, unit });
    } else if (key === "COLUMNINFO") {
      // GEF standard: #COLUMNINFO= 1, m, length, 11
      const parts = value.split(",").map(p => p.trim());
      const idx = parseInt(parts[0] ?? "", 10);
      const unit = (parts[1] ?? "").toLowerCase();
      const type = (parts[2] ?? "").toLowerCase();
      if (!isNaN(idx)) columns.set(idx, { type, unit });
    } else if (key === "MEASUREMENTTEXT") {
      const parts = value.split(",").map(p => p.trim());
      if (parts[0] === "4" && parts[1]) id = parts[1];
    } else if (key === "ZID") {
      const parts = value.split(",").map(p => p.trim());
      const z = parseFloat(parts[1] ?? "");
      if (isFinite(z)) groundElev = z;
    }
  }

  if (columns.size === 0) {
    warnings.push("No #COLUMN/#COLUMNINFO definitions found — assuming depth, qc, fs, u2 order.");
    columns.set(1, { type: "length", unit: "m" });
    columns.set(2, { type: "qc", unit: "mpa" });
    columns.set(3, { type: "fs", unit: "mpa" });
    columns.set(4, { type: "u2", unit: "mpa" });
  }

  // Resolve which column index is which
  const colDepth = findGefColumn(columns, ["length", "depth", "penetration"]);
  const colQc    = findGefColumn(columns, ["qc", "cone", "conetip"]);
  const colFs    = findGefColumn(columns, ["fs", "sleeve", "friction"]);
  const colU2    = findGefColumn(columns, ["u2", "u", "porewaterpressure"]);

  if (colDepth < 0 || colQc < 0 || colFs < 0) {
    errors.push(`GEF file missing required columns (depth, qc, fs).`);
    return { sounding: null, warnings, errors };
  }

  const qcUnit = columns.get(colQc)?.unit ?? "mpa";
  const fsUnit = columns.get(colFs)?.unit ?? "mpa";
  const u2Unit = colU2 > 0 ? (columns.get(colU2)?.unit ?? "mpa") : "mpa";
  const qcMul = unitToKpa(qcUnit);
  const fsMul = unitToKpa(fsUnit);
  const u2Mul = unitToKpa(u2Unit);

  const readings: CptReading[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
    const parts = line.split(/[\s,;]+/).filter(p => p.length > 0);
    const depth = numOrNaN(parts[colDepth - 1]);
    const qc = numOrNaN(parts[colQc - 1]);
    const fs = numOrNaN(parts[colFs - 1]);
    if (!isFinite(depth) || !isFinite(qc) || !isFinite(fs)) continue;
    const reading: CptReading = { depth, qc: qc * qcMul, fs: fs * fsMul };
    if (colU2 > 0) {
      const u2 = numOrNaN(parts[colU2 - 1]);
      if (isFinite(u2)) reading.u2 = u2 * u2Mul;
    }
    readings.push(reading);
  }

  if (readings.length === 0) {
    errors.push("GEF file contained no parseable data rows.");
    return { sounding: null, warnings, errors };
  }

  readings.sort((a, b) => a.depth - b.depth);

  const sounding: CptSounding = {
    id,
    readings,
    netAreaRatio: opts.netAreaRatio ?? 0.8,
    waterTableDepth: opts.waterTableDepth ?? Infinity,
    ...(groundElev !== undefined ? { groundElev } : {}),
  };
  return { sounding, warnings, errors };
}

// ── SVG plot ──────────────────────────────────────────────────────────────────

export interface CptSvgOptions {
  width?: number;
  height?: number;
  /** Whether to include the Su column (only meaningful if Nkt was applied). */
  showSu?: boolean;
}

/** Render a multi-track SVG plot: qt / fs / Rf / SBT vs depth. */
export function renderCptSvg(
  sounding: CptSounding,
  derived: CptDerived[],
  opts: CptSvgOptions = {},
): string {
  const W = opts.width ?? 720;
  const H = opts.height ?? 720;
  const margin = { top: 36, right: 12, bottom: 28, left: 48 };
  const trackGap = 10;
  const showSu = opts.showSu ?? derived.some(d => d.Su !== undefined);
  const trackCount = showSu ? 5 : 4;
  const trackW = (W - margin.left - margin.right - trackGap * (trackCount - 1)) / trackCount;
  const plotH = H - margin.top - margin.bottom;

  const maxDepth = Math.max(...derived.map(d => d.depth), 1);
  const yScale = (d: number) => margin.top + (d / maxDepth) * plotH;

  const maxQt = Math.max(...derived.map(d => d.qt), 1);
  const qtMax = roundUp(maxQt);
  const fsMax = Math.max(50, roundUp(Math.max(...derived.map(d => d.fs))));
  const suMax = showSu ? Math.max(50, roundUp(Math.max(...derived.map(d => d.Su ?? 0)))) : 0;

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif">`);
  lines.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

  // Track titles
  const titles = showSu
    ? ["qt (kPa)", "fs (kPa)", "Rf (%)", "SBT", "Su (kPa)"]
    : ["qt (kPa)", "fs (kPa)", "Rf (%)", "SBT"];

  for (let t = 0; t < trackCount; t++) {
    const x0 = margin.left + t * (trackW + trackGap);
    const x1 = x0 + trackW;
    lines.push(`<rect x="${x0.toFixed(1)}" y="${margin.top}" width="${trackW.toFixed(1)}" height="${plotH}" fill="#fafafa" stroke="#e2e8f0"/>`);
    lines.push(`<text x="${((x0 + x1) / 2).toFixed(1)}" y="${margin.top - 10}" text-anchor="middle" font-size="11" font-weight="700" fill="#334155">${titles[t]}</text>`);
  }

  // Depth axis (left)
  lines.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#94a3b8" stroke-width="0.6"/>`);
  const depthStep = niceStep(maxDepth);
  for (let d = 0; d <= maxDepth + 1e-6; d += depthStep) {
    const y = yScale(d);
    lines.push(`<line x1="${margin.left - 4}" y1="${y.toFixed(1)}" x2="${margin.left}" y2="${y.toFixed(1)}" stroke="#94a3b8"/>`);
    lines.push(`<text x="${margin.left - 6}" y="${(y + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="#475569">${d.toFixed(0)}</text>`);
  }
  lines.push(`<text x="${margin.left - 30}" y="${margin.top - 12}" font-size="9" font-weight="700" fill="#475569">Depth (m)</text>`);

  // Helper: draw a polyline track
  const drawLine = (trackIdx: number, valueOf: (d: CptDerived) => number, xMax: number, stroke: string) => {
    const x0 = margin.left + trackIdx * (trackW + trackGap);
    const xScale = (v: number) => x0 + Math.max(0, Math.min(trackW, (v / xMax) * trackW));
    // x-axis ticks
    for (let v = 0; v <= xMax + 1e-6; v += niceStep(xMax)) {
      const xt = xScale(v);
      lines.push(`<line x1="${xt.toFixed(1)}" y1="${margin.top + plotH}" x2="${xt.toFixed(1)}" y2="${margin.top + plotH + 4}" stroke="#94a3b8"/>`);
      lines.push(`<text x="${xt.toFixed(1)}" y="${(margin.top + plotH + 16).toFixed(1)}" font-size="9" text-anchor="middle" fill="#475569">${formatTick(v)}</text>`);
    }
    const pts = derived
      .map(d => `${xScale(valueOf(d)).toFixed(1)},${yScale(d.depth).toFixed(1)}`)
      .join(" ");
    lines.push(`<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.1"/>`);
  };

  drawLine(0, d => d.qt, qtMax, "#1e40af");
  drawLine(1, d => d.fs, fsMax, "#9333ea");
  drawLine(2, d => Math.max(0, Math.min(10, d.Rf)), 10, "#16a34a");

  // SBT colour strip
  const sbtX0 = margin.left + 3 * (trackW + trackGap);
  for (let i = 1; i < derived.length; i++) {
    const dPrev = derived[i - 1]!;
    const d = derived[i]!;
    const yA = yScale(dPrev.depth);
    const yB = yScale(d.depth);
    lines.push(`<rect x="${sbtX0.toFixed(1)}" y="${yA.toFixed(1)}" width="${trackW.toFixed(1)}" height="${Math.max(1, yB - yA).toFixed(1)}" fill="${sbtColor(dPrev.sbt)}"/>`);
  }
  // SBT zone labels (every band)
  const bands = summariseSbtBands(derived);
  for (const b of bands) {
    if (b.baseDepth - b.topDepth < 0.4) continue;
    const ym = (yScale(b.topDepth) + yScale(b.baseDepth)) / 2;
    lines.push(`<text x="${(sbtX0 + trackW / 2).toFixed(1)}" y="${(ym + 3).toFixed(1)}" font-size="9" text-anchor="middle" fill="#0f172a">${b.sbt}</text>`);
  }

  if (showSu) {
    drawLine(4, d => d.Su ?? 0, suMax, "#dc2626");
  }

  lines.push("</svg>");
  return lines.join("\n");
}

// ── Robertson SBT colours (matched to typical chart) ──────────────────────────

export function sbtColor(z: SbtZone): string {
  switch (z) {
    case 1: return "#9ca3af"; // sensitive — grey
    case 2: return "#3d2b1f"; // organic — dark brown
    case 3: return "#7b9ec5"; // clay — blue
    case 4: return "#c4a87c"; // silt — tan
    case 5: return "#d8c080"; // sand mixtures — pale ochre
    case 6: return "#f0d870"; // sand — yellow
    case 7: return "#c87a45"; // gravelly — orange-brown
    case 8: return "#94a3b8"; // OC sand — slate
    case 9: return "#64748b"; // OC fines — dark slate
  }
}

export function sbtName(z: SbtZone): string {
  return SBT_NAMES[z];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function detectSeparator(headerLine: string): RegExp | string {
  if (headerLine.includes("\t")) return "\t";
  if (headerLine.includes(";")) return ";";
  if (headerLine.includes(",")) return ",";
  return /\s+/;
}

function findIndex(headers: string[], candidates: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    if (candidates.includes(headers[i]!)) return i;
  }
  return -1;
}

function findGefColumn(cols: Map<number, { type: string; unit: string }>, candidates: string[]): number {
  for (const [idx, info] of cols) {
    const t = info.type.replace(/[^a-z0-9]/g, "");
    if (candidates.includes(t)) return idx;
  }
  return -1;
}

function unitToKpa(unit: string): number {
  const u = unit.toLowerCase().replace(/[^a-z]/g, "");
  if (u === "kpa") return 1;
  if (u === "mpa") return 1000;
  if (u === "pa")  return 0.001;
  if (u === "bar") return 100;
  return 1;
}

function numOrNaN(s: string | undefined): number {
  if (s === undefined) return NaN;
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

function roundUp(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const mant = v / exp;
  let nice = 10;
  if (mant <= 1) nice = 1;
  else if (mant <= 2) nice = 2;
  else if (mant <= 5) nice = 5;
  return nice * exp;
}

function niceStep(max: number): number {
  const target = max / 5;
  const exp = Math.pow(10, Math.floor(Math.log10(Math.max(target, 1e-9))));
  const mant = target / exp;
  let nice = 10;
  if (mant <= 1) nice = 1;
  else if (mant <= 2) nice = 2;
  else if (mant <= 5) nice = 5;
  return nice * exp;
}

function formatTick(v: number): string {
  if (v === 0) return "0";
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + "k";
  if (Math.abs(v) < 1) return v.toFixed(2);
  return v.toFixed(0);
}
