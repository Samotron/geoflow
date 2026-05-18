/**
 * spt.ts — Standard Penetration Test parameter correlations.
 *
 * Given an SPT N-value, vertical effective stress and an indication of
 * soil type (cohesive vs granular), return the standard textbook
 * correlations for:
 *
 *   - N60 / N1,60 normalisation (Skempton 1986, Liao & Whitman 1986)
 *   - φ′ — drained friction angle (Hatanaka & Uchida 1996, Peck/Hanson/Thornburn)
 *   - Dr  — relative density (Skempton 1986)
 *   - su  — undrained shear strength (Stroud 1974, Terzaghi & Peck 1967)
 *   - Es  — Young's modulus (Schmertmann 1970, Bowles 1996)
 *   - Vs  — shear-wave velocity (Imai 1981, Ohta–Goto 1978)
 *
 * Every correlation has a relevant soil-type domain. The functions return
 * `undefined` if the input is outside the domain (e.g. asking for `phi`
 * on a cohesive sample). Callers should treat all values as estimates;
 * none are a substitute for in-situ or laboratory testing.
 *
 * All functions take SI units (kPa, m/s, °).
 */

import type { AgsFile, AgsRow } from "./model.js";

// ── Inputs ───────────────────────────────────────────────────────────────────

export type SoilFamily = "granular" | "cohesive" | "unknown";

export interface SptInput {
  /** Raw SPT N (blows per 300 mm). */
  N: number;
  /** Vertical effective stress at the test depth (kPa). */
  sigmaVeff?: number;
  /** Energy correction factor — N60 = N × (ER/60). UK donut hammer typically 0.7–0.8, US safety hammer 0.6–0.7. Default 1.0 (assume N already at 60% energy). */
  energyRatio?: number;
  /** Soil family for domain-checks; `unknown` returns the union of granular + cohesive correlations. */
  family?: SoilFamily;
  /** Test depth (m bgl) — used by Vs correlations. */
  depth?: number;
}

export interface SptCorrelations {
  /** N corrected to 60% energy ratio. */
  N60: number;
  /** N corrected to 60% energy and overburden stress (Liao & Whitman 1986). */
  N1_60?: number;
  /** Drained friction angle (°) — Hatanaka & Uchida (1996) for granular soils. */
  phiPrime?: number;
  /** Relative density (%) — Skempton (1986) for granular soils. */
  Dr?: number;
  /** Undrained shear strength (kPa) — Stroud (1974) range for cohesive soils. */
  cuMin?: number;
  cuMax?: number;
  /** Young's modulus (MPa) — Schmertmann/Bowles broad estimate. */
  EsMin?: number;
  EsMax?: number;
  /** Shear-wave velocity (m/s) — Imai (1981). */
  VsImai?: number;
  /** Shear-wave velocity (m/s) — Ohta–Goto (1978) generic soils. */
  VsOhtaGoto?: number;
}

// ── Core correlations ────────────────────────────────────────────────────────

const ATM = 100; // atmospheric pressure (kPa)

/**
 * Compute every applicable SPT correlation. Values outside the validity
 * domain (e.g. `phiPrime` on cohesive soils) are omitted.
 */
export function correlateSpt(input: SptInput): SptCorrelations {
  const family = input.family ?? "unknown";
  const ER = input.energyRatio ?? 1.0;
  const N60 = input.N * ER;
  const out: SptCorrelations = { N60 };

  // Overburden correction (Liao & Whitman 1986): CN = √(Pa/σv'); capped at 1.7.
  if (input.sigmaVeff !== undefined && input.sigmaVeff > 0) {
    const CN = Math.min(1.7, Math.sqrt(ATM / input.sigmaVeff));
    out.N1_60 = N60 * CN;
  }

  if (family !== "cohesive") {
    // φ′ — Hatanaka & Uchida (1996): φ′ = √(20·N1,60) + 20
    const N1 = out.N1_60 ?? N60;
    if (N1 > 0) {
      const phi = Math.sqrt(20 * N1) + 20;
      if (phi > 20 && phi < 50) out.phiPrime = phi;
    }
    // Dr — Skempton (1986): Dr² = N1,60 / 60. Returns %.
    if (N1 > 0) {
      const drFraction = Math.sqrt(N1 / 60);
      const dr = Math.min(1.05, drFraction) * 100;
      if (dr > 0) out.Dr = dr;
    }
    // Young's modulus — Bowles 1996 (sand): Es ≈ 0.5·(N+15) MPa to 1.0·(N+15) MPa.
    out.EsMin = 0.5 * (N60 + 15);
    out.EsMax = 1.0 * (N60 + 15);
  }

  if (family !== "granular") {
    // su — Stroud (1974) for UK overconsolidated clays: cu = f1 × N60, f1 ≈ 4–6 kPa.
    out.cuMin = 4 * N60;
    out.cuMax = 6 * N60;
    if (family !== "unknown") {
      // For clay, Bowles gives Es ≈ 250–500·cu (very broad) — express via N.
      out.EsMin = 0.25 * out.cuMin / 1000 * 1000; // kPa → MPa, keep as MPa
      out.EsMax = 0.5 * out.cuMax;
    }
  }

  // Vs — Imai (1981): Vs = 91 · N^0.337 (m/s).
  if (N60 > 0) {
    out.VsImai = 91 * Math.pow(N60, 0.337);
  }
  // Vs — Ohta–Goto (1978) generic: Vs = 85.35 · N^0.348 · z^0.199 (m/s).
  if (N60 > 0 && input.depth !== undefined && input.depth > 0) {
    out.VsOhtaGoto = 85.35 * Math.pow(N60, 0.348) * Math.pow(input.depth, 0.199);
  }

  return out;
}

// ── Bulk derivation from an AGS file ─────────────────────────────────────────

export interface IsptCorrelationRow {
  loca_id: string;
  depth: number;
  N: number;
  family: SoilFamily;
  correlations: SptCorrelations;
}

export interface IsptCorrelationOptions {
  /** Energy correction factor applied to every row. Default 1.0 (i.e. ISPT_NVAL already at 60%). */
  energyRatio?: number;
  /** Assumed soil unit weight (kN/m³) above water table. Default 18. */
  gammaDry?: number;
  /** Assumed soil unit weight (kN/m³) below water table. Default 19. */
  gammaWet?: number;
  /** Phreatic surface depth below ground level (m). Default Infinity (dry). */
  waterTableDepth?: number;
}

/**
 * Compute SPT correlations for every ISPT row in an AgsFile.
 *
 * Soil family is inferred from the matching GEOL row at the same LOCA_ID
 * and depth. Falls back to `unknown` (returns both granular and cohesive
 * correlations) if no GEOL match is available.
 */
export function correlateIspt(
  file: AgsFile,
  options: IsptCorrelationOptions = {},
): IsptCorrelationRow[] {
  const ispt = file.groups.ISPT;
  if (!ispt) return [];

  const energyRatio = options.energyRatio ?? 1.0;
  const gammaDry = options.gammaDry ?? 18;
  const gammaWet = options.gammaWet ?? 19;
  const wtDepth = options.waterTableDepth ?? Number.POSITIVE_INFINITY;

  const geolByLoca = new Map<string, Array<{ top: number; base: number; family: SoilFamily }>>();
  for (const r of file.groups.GEOL?.rows ?? []) {
    const id = stringValue(r["LOCA_ID"]);
    const top = numericValue(r["GEOL_TOP"]);
    const base = numericValue(r["GEOL_BASE"]);
    if (id === null || top === null || base === null) continue;
    const desc = `${stringValue(r["GEOL_DESC"]) ?? ""} ${stringValue(r["GEOL_LEG"]) ?? ""}`.toLowerCase();
    const family = inferFamilyFromDesc(desc);
    const list = geolByLoca.get(id) ?? [];
    list.push({ top, base, family });
    geolByLoca.set(id, list);
  }

  const out: IsptCorrelationRow[] = [];
  for (const row of ispt.rows) {
    const locaId = stringValue(row["LOCA_ID"]);
    const N = nValue(row["ISPT_NVAL"]);
    const depth = numericValue(row["ISPT_TOP"])
      ?? numericValue(row["ISPT_DPTH"])
      ?? numericValue(row["SAMP_TOP"]);
    if (locaId === null || N === null || depth === null) continue;
    if (N <= 0) continue;

    const sigmaVeff = effectiveStress(depth, wtDepth, gammaDry, gammaWet);
    const family = lookupFamily(geolByLoca.get(locaId) ?? [], depth);
    const correlations = correlateSpt({
      N,
      sigmaVeff,
      energyRatio,
      family,
      depth,
    });
    out.push({ loca_id: locaId, depth, N, family, correlations });
  }
  return out;
}

function effectiveStress(depth: number, wt: number, gd: number, gw: number): number {
  if (depth <= 0) return 0.1;
  const aboveWT = Math.min(depth, wt);
  const belowWT = Math.max(0, depth - wt);
  const sigmaV = aboveWT * gd + belowWT * gw;
  const u0 = belowWT * 9.81;
  return Math.max(0.1, sigmaV - u0);
}

function inferFamilyFromDesc(desc: string): SoilFamily {
  if (!desc) return "unknown";
  if (/\bclay|silt|peat|organic\b/.test(desc)) return "cohesive";
  if (/\bsand|gravel|cobble|boulder\b/.test(desc)) return "granular";
  return "unknown";
}

function lookupFamily(
  layers: Array<{ top: number; base: number; family: SoilFamily }>,
  depth: number,
): SoilFamily {
  for (const l of layers) {
    if (depth >= l.top && depth <= l.base) return l.family;
  }
  return "unknown";
}

function stringValue(v: AgsRow[string] | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function numericValue(v: AgsRow[string] | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse ISPT_NVAL tolerantly:
 *   "35"        → 35
 *   "50/100mm"  → 50  (refusal — keep numerator)
 *   "R"/"REF"   → 50  (assume refusal cap)
 */
function nValue(v: AgsRow[string] | undefined): number | null {
  const direct = numericValue(v);
  if (direct !== null) return direct;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const slash = s.match(/^(\d+)\s*\//);
  if (slash) return parseInt(slash[1]!, 10);
  if (/^R(EF(USAL)?)?$/i.test(s)) return 50;
  return null;
}
