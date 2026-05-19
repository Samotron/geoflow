/**
 * correlations.ts — empirical correlations for geotechnical design parameters.
 *
 * The Parameters step surfaces these alongside the raw sample stats so the
 * engineer can sanity-check their chosen value against textbook estimates.
 * Every correlation returns its inputs, output range, and a citation; none
 * are auto-applied to the ground model.
 *
 * Conventions
 *  - SI units throughout (kPa, m, m/s, °, kN/m³ for unit weight, Mg/m³ for
 *    density). Conversions are explicit at the call site.
 *  - `Range` carries `min` / `representative` / `max` where possible. Single-
 *    value correlations leave `min`/`max` undefined.
 *  - A correlation that's out of its validity domain returns `undefined`
 *    rather than throwing — the UI just omits the row.
 *
 * Sources cited below each function. These are textbook estimates, not a
 * substitute for in-situ or lab testing.
 */
import type { Sample } from './samples.js';

const ATM = 100; // atmospheric pressure (kPa)
const G = 9.81; // gravity (m/s²)

/** Single correlation output. */
export interface CorrelationResult {
  /** Parameter this correlation estimates (matches Parameter.key). */
  parameter: 'phi' | 'cu' | 'gamma' | 'E' | 'k' | 'c' | 'Dr' | 'Vs' | 'K0' | 'OCR';
  /** Short label, e.g. "ϕ' from N₁,₆₀". */
  label: string;
  /** Author / year citation, e.g. "Hatanaka & Uchida (1996)". */
  source: string;
  /** Output units, e.g. "°", "kPa", "MPa", "m/s". */
  units: string;
  /** Lower bound of the predicted range. */
  min?: number | undefined;
  /** Best-estimate central value. */
  representative?: number | undefined;
  /** Upper bound. */
  max?: number | undefined;
  /** Inputs the correlation was evaluated with — surfaced in the UI tooltip. */
  inputs: Record<string, number>;
  /**
   * Validity / domain notes. Surfaced under the row so the user understands
   * the caveats before they cite the value.
   */
  caveat?: string | undefined;
}

/** Inputs commonly available at the layer level. */
export interface LayerCorrelationInputs {
  /** Mean SPT N (raw blow count). */
  sptN?: number | undefined;
  /** Mean SPT N corrected to 60% energy. */
  N60?: number | undefined;
  /** Mean SPT N corrected for energy + overburden. */
  N1_60?: number | undefined;
  /** Mean depth to the layer mid-point below ground (m). */
  depthMid?: number | undefined;
  /** Vertical effective stress at layer mid-depth (kPa). */
  sigmaVeff?: number | undefined;
  /** Atterberg PI (%) — for clay correlations. */
  pi?: number | undefined;
  /** Atterberg LL (%) — for clay correlations. */
  ll?: number | undefined;
  /** Plastic limit (%) — used with LL/MC for liquidity index. */
  pl?: number | undefined;
  /** Mean moisture content (%). */
  mc?: number | undefined;
  /** Bulk density mean (Mg/m³). */
  bulkDensity?: number | undefined;
  /** Dry density mean (Mg/m³). */
  dryDensity?: number | undefined;
  /** Measured / estimated cu (kPa) — feeds E and K0 correlations. */
  cu?: number | undefined;
  /** Overconsolidation ratio — falls back to 1 (NC) when absent. */
  ocr?: number | undefined;
  /** Soil family hint. */
  family?: 'granular' | 'cohesive' | 'unknown' | undefined;
}

// ── Aggregation helpers ─────────────────────────────────────────────────────

function mean(xs: ReadonlyArray<number>): number | undefined {
  const filt = xs.filter((x) => Number.isFinite(x));
  if (filt.length === 0) return undefined;
  return filt.reduce((a, x) => a + x, 0) / filt.length;
}

/**
 * Build a `LayerCorrelationInputs` from per-channel samples already filtered
 * to a single layer. Channels with no samples are simply absent.
 */
export interface ChannelBundle {
  spt?: ReadonlyArray<Sample>;
  mc?: ReadonlyArray<Sample>;
  ll?: ReadonlyArray<Sample>;
  pl?: ReadonlyArray<Sample>;
  pi?: ReadonlyArray<Sample>;
  bulkDensity?: ReadonlyArray<Sample>;
  dryDensity?: ReadonlyArray<Sample>;
  cu?: ReadonlyArray<Sample>;
}

export interface BuildInputsOptions {
  /** Layer top RL (mAOD). */
  topRL: number;
  /** Layer base RL (mAOD). */
  baseRL: number;
  /** Mean ground level over the contributing boreholes (mAOD). */
  meanGL: number;
  /** Assumed unit weight above water table (kN/m³). Default 18. */
  gammaAboveWT?: number;
  /** Assumed unit weight below water table (kN/m³). Default 19. */
  gammaBelowWT?: number;
  /** Water table depth below ground (m). Default +∞ (dry). */
  waterTableDepth?: number;
  /** Energy ratio applied to N values. Default 1.0. */
  energyRatio?: number;
  /** OCR — defaults to 1.0 (normally consolidated). */
  ocr?: number;
  /** Soil family hint. */
  family?: 'granular' | 'cohesive' | 'unknown';
}

export function buildLayerInputs(
  channels: ChannelBundle,
  opts: BuildInputsOptions,
): LayerCorrelationInputs {
  const sptN = mean((channels.spt ?? []).map((s) => s.value));
  const mcV = mean((channels.mc ?? []).map((s) => s.value));
  const llV = mean((channels.ll ?? []).map((s) => s.value));
  const plV = mean((channels.pl ?? []).map((s) => s.value));
  let piV = mean((channels.pi ?? []).map((s) => s.value));
  if (piV === undefined && llV !== undefined && plV !== undefined) piV = llV - plV;
  const bdV = mean((channels.bulkDensity ?? []).map((s) => s.value));
  const ddV = mean((channels.dryDensity ?? []).map((s) => s.value));
  const cuV = mean((channels.cu ?? []).map((s) => s.value));

  const energyRatio = opts.energyRatio ?? 1.0;
  const N60 = sptN !== undefined ? sptN * energyRatio : undefined;

  const layerTopDepth = opts.meanGL - opts.topRL;
  const layerBaseDepth = opts.meanGL - opts.baseRL;
  const depthMid = (Math.max(0, layerTopDepth) + Math.max(0, layerBaseDepth)) / 2;

  const wt = opts.waterTableDepth ?? Number.POSITIVE_INFINITY;
  const gd = opts.gammaAboveWT ?? 18;
  const gw = opts.gammaBelowWT ?? 19;
  const aboveWT = Math.min(depthMid, wt);
  const belowWT = Math.max(0, depthMid - wt);
  const sigmaV = aboveWT * gd + belowWT * gw;
  const u0 = belowWT * G;
  const sigmaVeff = Math.max(0.1, sigmaV - u0);

  let N1_60: number | undefined;
  if (N60 !== undefined && sigmaVeff > 0) {
    const CN = Math.min(1.7, Math.sqrt(ATM / sigmaVeff));
    N1_60 = N60 * CN;
  }

  return {
    sptN,
    N60,
    N1_60,
    depthMid,
    sigmaVeff,
    pi: piV,
    ll: llV,
    pl: plV,
    mc: mcV,
    bulkDensity: bdV,
    dryDensity: ddV,
    cu: cuV,
    ocr: opts.ocr,
    family: opts.family,
  };
}

// ── Correlations: angle of friction (ϕ′) ────────────────────────────────────

function phiHatanakaUchida(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  const N1 = inp.N1_60 ?? inp.N60;
  if (N1 === undefined || N1 <= 0) return undefined;
  if (inp.family === 'cohesive') return undefined;
  const phi = Math.sqrt(20 * N1) + 20;
  if (phi <= 20 || phi >= 50) return undefined;
  return {
    parameter: 'phi',
    label: "ϕ' from N₁,₆₀",
    source: 'Hatanaka & Uchida (1996)',
    units: '°',
    representative: phi,
    min: phi - 3,
    max: phi + 3,
    inputs: { N1_60: N1 },
    caveat: 'Granular soils; assumes Mohr–Coulomb failure envelope.',
  };
}

function phiPeckHansonThornburn(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  if (inp.family === 'cohesive') return undefined;
  // φ ≈ 27.1 + 0.3·N − 0.00054·N² (Peck-Hanson-Thornburn 1974)
  const phi = 27.1 + 0.3 * N - 0.00054 * N * N;
  if (phi <= 20 || phi >= 50) return undefined;
  return {
    parameter: 'phi',
    label: "ϕ' from N₆₀",
    source: 'Peck-Hanson-Thornburn (1974)',
    units: '°',
    representative: phi,
    inputs: { N60: N },
    caveat: 'Empirical fit; tends to underestimate at high N.',
  };
}

function phiWolff(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  if (inp.family === 'cohesive') return undefined;
  // φ ≈ 27.1 + 0.3·N − 0.00054·N²  (Wolff 1989 — quadratic curve fit)
  const phi = 27.1 + 0.3 * N - 0.00054 * N * N;
  if (phi <= 20 || phi >= 50) return undefined;
  return {
    parameter: 'phi',
    label: "ϕ' (Wolff)",
    source: 'Wolff (1989)',
    units: '°',
    representative: phi,
    min: phi - 2,
    max: phi + 2,
    inputs: { N60: N },
  };
}

function phiMeyerhof(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  if (inp.family === 'cohesive') return undefined;
  // φ ≈ 28 + 0.15·D_r ⇒ via Dr from Skempton
  const N1 = inp.N1_60 ?? N;
  const dr = Math.min(100, Math.sqrt(N1 / 60) * 100);
  const phi = 28 + 0.15 * dr;
  if (phi <= 20 || phi >= 50) return undefined;
  return {
    parameter: 'phi',
    label: "ϕ' from Dr (Meyerhof)",
    source: 'Meyerhof (1956)',
    units: '°',
    representative: phi,
    inputs: { N60: N, Dr: dr },
  };
}

function phiSchmertmann(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'cohesive') return undefined;
  const N = inp.N60 ?? inp.sptN;
  const sigma = inp.sigmaVeff;
  if (N === undefined || sigma === undefined || N <= 0 || sigma <= 0) return undefined;
  // tan φ = (N / (12.2 + 20.3·σv'/Pa))^0.34   (Schmertmann 1975)
  const inner = N / (12.2 + 20.3 * (sigma / ATM));
  if (inner <= 0) return undefined;
  const phi = (Math.atan(Math.pow(inner, 0.34)) * 180) / Math.PI;
  if (phi <= 20 || phi >= 50) return undefined;
  return {
    parameter: 'phi',
    label: "ϕ' (Schmertmann)",
    source: 'Schmertmann (1975)',
    units: '°',
    representative: phi,
    inputs: { N60: N, sigmaVeff: sigma },
    caveat: 'Sensitive to σv′; suspect at very shallow depths.',
  };
}

// ── Correlations: relative density (Dr) ─────────────────────────────────────

function drSkempton(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'cohesive') return undefined;
  const N1 = inp.N1_60 ?? inp.N60;
  if (N1 === undefined || N1 <= 0) return undefined;
  const dr = Math.min(100, Math.sqrt(N1 / 60) * 100);
  return {
    parameter: 'Dr',
    label: 'Dr from N₁,₆₀',
    source: 'Skempton (1986)',
    units: '%',
    representative: dr,
    inputs: { N1_60: N1 },
    caveat: 'Granular soils; calibration constant a = 60 typical.',
  };
}

function drMeyerhof(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'cohesive') return undefined;
  const N = inp.N60 ?? inp.sptN;
  const sigma = inp.sigmaVeff;
  if (N === undefined || sigma === undefined || N <= 0) return undefined;
  // Dr (%) = 21 · √(N / (σv'/100 + 0.7))   (Meyerhof 1957, sigma in kPa)
  const dr = Math.min(100, 21 * Math.sqrt(N / (sigma / 100 + 0.7)));
  return {
    parameter: 'Dr',
    label: 'Dr (Meyerhof)',
    source: 'Meyerhof (1957)',
    units: '%',
    representative: dr,
    inputs: { N60: N, sigmaVeff: sigma },
  };
}

// ── Correlations: undrained shear strength (cu) ─────────────────────────────

function cuStroud(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'granular') return undefined;
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  return {
    parameter: 'cu',
    label: 'cu from N₆₀',
    source: 'Stroud (1974)',
    units: 'kPa',
    min: 4 * N,
    max: 6 * N,
    representative: 5 * N,
    inputs: { N60: N },
    caveat: 'UK overconsolidated clays; f₁ = 4–6.',
  };
}

function cuTerzaghiPeck(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'granular') return undefined;
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  return {
    parameter: 'cu',
    label: 'cu (Terzaghi-Peck)',
    source: 'Terzaghi & Peck (1967)',
    units: 'kPa',
    representative: 6.25 * N,
    min: 5 * N,
    max: 7.5 * N,
    inputs: { N60: N },
  };
}

function cuHaraEtAl(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'granular') return undefined;
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  // cu = 29 · N^0.72  (Hara et al. 1974, units: kPa)
  return {
    parameter: 'cu',
    label: 'cu (Hara)',
    source: 'Hara et al. (1974)',
    units: 'kPa',
    representative: 29 * Math.pow(N, 0.72),
    inputs: { N60: N },
  };
}

function cuSkemptonFromOCR(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'granular') return undefined;
  const sigma = inp.sigmaVeff;
  if (sigma === undefined || sigma <= 0) return undefined;
  const ocr = inp.ocr ?? 1;
  // cu/σv' = 0.23 · OCR^0.8 ± 0.04   (Ladd 1991 ≈ SHANSEP; Skempton-style)
  const ratio = 0.23 * Math.pow(ocr, 0.8);
  return {
    parameter: 'cu',
    label: 'cu/σv′ (SHANSEP)',
    source: 'Ladd (1991)',
    units: 'kPa',
    representative: ratio * sigma,
    min: (ratio - 0.04) * sigma,
    max: (ratio + 0.04) * sigma,
    inputs: { sigmaVeff: sigma, ocr },
    caveat: 'For undisturbed clays; OCR=1 ⇒ NC clay.',
  };
}

function cuFromPI(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  // Bjerrum-style correlation between cu/σv' and PI for NC clay
  if (inp.family === 'granular') return undefined;
  const sigma = inp.sigmaVeff;
  const pi = inp.pi;
  if (sigma === undefined || pi === undefined || pi <= 0) return undefined;
  // Skempton 1957: cu/σv' = 0.11 + 0.0037·PI   (NC)
  const ratio = 0.11 + 0.0037 * pi;
  return {
    parameter: 'cu',
    label: 'cu/σv′ from PI',
    source: 'Skempton (1957)',
    units: 'kPa',
    representative: ratio * sigma,
    inputs: { sigmaVeff: sigma, pi },
    caveat: 'Applies to normally consolidated clays; sensitive to PI.',
  };
}

// ── Correlations: Young's modulus (E) ───────────────────────────────────────

function eBowlesSand(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'cohesive') return undefined;
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  return {
    parameter: 'E',
    label: 'Es (Bowles, sand)',
    source: 'Bowles (1996)',
    units: 'MPa',
    min: 0.5 * (N + 15),
    max: 1.0 * (N + 15),
    representative: 0.75 * (N + 15),
    inputs: { N60: N },
  };
}

function eSchmertmann(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'cohesive') return undefined;
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  // Es ≈ 0.766·N (MPa) — Schmertmann 1970 for sands
  return {
    parameter: 'E',
    label: 'Es (Schmertmann)',
    source: 'Schmertmann (1970)',
    units: 'MPa',
    representative: 0.766 * N,
    inputs: { N60: N },
  };
}

function eDuncanBuchignani(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'granular') return undefined;
  const cu = inp.cu;
  const pi = inp.pi;
  const ocr = inp.ocr ?? 1;
  if (cu === undefined) return undefined;
  // E/cu varies with PI and OCR (Duncan-Buchignani 1976 chart, simplified):
  //   high PI (>50): ~150
  //   med  PI (20-50): 400
  //   low  PI (<20): 1000
  // adjusted by OCR^(-0.5) — falls with OCR
  let base = 400;
  if (pi !== undefined) {
    if (pi > 50) base = 150;
    else if (pi < 20) base = 1000;
  }
  const ratio = base / Math.sqrt(ocr);
  const E = (ratio * cu) / 1000; // kPa → MPa
  return {
    parameter: 'E',
    label: "Eu/cu (Duncan-Buchignani)",
    source: 'Duncan & Buchignani (1976)',
    units: 'MPa',
    representative: E,
    min: 0.5 * E,
    max: 1.5 * E,
    inputs: { cu, pi: pi ?? -1, ocr },
    caveat: 'Undrained Eu; very PI-dependent.',
  };
}

function eBurlandBurbidge(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'cohesive') return undefined;
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  // Ic = 1.71 / N^1.4 (m/MN per m for unit pressure)  →  inverted, Es ∝ N^1.4
  // Useful as a rough Es band for granular settlement design.
  const E = 1.71 * Math.pow(N, 1.4) / 10; // → MPa, rough scaling
  return {
    parameter: 'E',
    label: "E' (Burland-Burbidge)",
    source: 'Burland & Burbidge (1985)',
    units: 'MPa',
    representative: E,
    min: 0.5 * E,
    max: 2 * E,
    inputs: { N60: N },
    caveat: 'Compressibility index — order-of-magnitude only.',
  };
}

// ── Correlations: bulk unit weight (γ) ──────────────────────────────────────

function gammaFromBulkDensity(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  const bd = inp.bulkDensity;
  if (bd === undefined || bd <= 0) return undefined;
  const gamma = bd * G; // Mg/m³ × m/s² ≈ kN/m³
  return {
    parameter: 'gamma',
    label: 'γ from ρb',
    source: 'γ = ρb · g',
    units: 'kN/m³',
    representative: gamma,
    inputs: { bulkDensity: bd },
  };
}

function gammaFromDryDensity(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  const dd = inp.dryDensity;
  if (dd === undefined || dd <= 0) return undefined;
  const mc = inp.mc ?? 0;
  const bd = dd * (1 + mc / 100);
  const gamma = bd * G;
  return {
    parameter: 'gamma',
    label: 'γ from ρd · (1+w)',
    source: 'γ = ρd·(1+w)·g',
    units: 'kN/m³',
    representative: gamma,
    inputs: { dryDensity: dd, mc },
  };
}

function gammaFromSptGranular(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'cohesive') return undefined;
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  // Lookup table (Bowles 1996): N → γ_moist for sand
  const knots: ReadonlyArray<[number, number]> = [
    [4, 12], [10, 14.5], [30, 17], [50, 18.5], [80, 20],
  ];
  let g = knots[0]![1]!;
  for (let i = 1; i < knots.length; i++) {
    const [nA, gA] = knots[i - 1]!;
    const [nB, gB] = knots[i]!;
    if (N <= nB) {
      const t = (N - nA) / (nB - nA);
      g = gA + t * (gB - gA);
      return {
        parameter: 'gamma',
        label: 'γ from N (sand)',
        source: 'Bowles (1996) Table',
        units: 'kN/m³',
        representative: g,
        min: g - 1,
        max: g + 1,
        inputs: { N60: N },
      };
    }
  }
  g = knots[knots.length - 1]![1]!;
  return {
    parameter: 'gamma',
    label: 'γ from N (sand)',
    source: 'Bowles (1996) Table',
    units: 'kN/m³',
    representative: g,
    min: g - 1,
    max: g + 1,
    inputs: { N60: N },
  };
}

function gammaFromSptCohesive(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'granular') return undefined;
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  // Lookup (Bowles 1996): N → γ for clay
  const knots: ReadonlyArray<[number, number]> = [
    [2, 16], [4, 17], [8, 18], [15, 19], [30, 20], [60, 22],
  ];
  let g = knots[0]![1]!;
  for (let i = 1; i < knots.length; i++) {
    const [nA, gA] = knots[i - 1]!;
    const [nB, gB] = knots[i]!;
    if (N <= nB) {
      const t = (N - nA) / (nB - nA);
      g = gA + t * (gB - gA);
      return {
        parameter: 'gamma',
        label: 'γ from N (clay)',
        source: 'Bowles (1996) Table',
        units: 'kN/m³',
        representative: g,
        min: g - 1,
        max: g + 1,
        inputs: { N60: N },
      };
    }
  }
  g = knots[knots.length - 1]![1]!;
  return {
    parameter: 'gamma',
    label: 'γ from N (clay)',
    source: 'Bowles (1996) Table',
    units: 'kN/m³',
    representative: g,
    min: g - 1,
    max: g + 1,
    inputs: { N60: N },
  };
}

// ── Correlations: shear wave velocity (Vs) ──────────────────────────────────

function vsImai(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  const N = inp.N60 ?? inp.sptN;
  if (N === undefined || N <= 0) return undefined;
  return {
    parameter: 'Vs',
    label: 'Vs (Imai)',
    source: 'Imai (1981)',
    units: 'm/s',
    representative: 91 * Math.pow(N, 0.337),
    inputs: { N60: N },
  };
}

function vsOhtaGoto(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  const N = inp.N60 ?? inp.sptN;
  const z = inp.depthMid;
  if (N === undefined || z === undefined || N <= 0 || z <= 0) return undefined;
  return {
    parameter: 'Vs',
    label: 'Vs (Ohta-Goto)',
    source: 'Ohta & Goto (1978)',
    units: 'm/s',
    representative: 85.35 * Math.pow(N, 0.348) * Math.pow(z, 0.199),
    inputs: { N60: N, depthMid: z },
  };
}

// ── Correlations: permeability (k) ──────────────────────────────────────────

function kHazen(_inp: LayerCorrelationInputs): CorrelationResult | undefined {
  // Hazen's formula needs D10 (grain size) which we don't store on layers yet.
  // Left as a stub so the UI can show "Hazen requires D10" hint later.
  return undefined;
}

function kFromCuClays(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'granular') return undefined;
  // Very rough: for stiff overconsolidated clays k ≈ 1e-9 m/s, soft NC ≈ 1e-10
  const cu = inp.cu;
  if (cu === undefined) return undefined;
  const k = cu > 100 ? 1e-9 : cu > 40 ? 5e-10 : 1e-10;
  return {
    parameter: 'k',
    label: 'k (clay band)',
    source: 'Lambe & Whitman (1969) range',
    units: 'm/s',
    representative: k,
    min: k * 0.1,
    max: k * 10,
    inputs: { cu },
    caveat: 'Order-of-magnitude only; replace with falling-head data when available.',
  };
}

// ── Correlations: lateral pressure (K0) ─────────────────────────────────────

function k0JakyNC(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  // Needs a phi estimate; use Hatanaka–Uchida internally so K0 is available
  // even without a stored phi value.
  const phiR = phiHatanakaUchida(inp);
  const phi = phiR?.representative;
  if (phi === undefined) return undefined;
  const k0 = 1 - Math.sin((phi * Math.PI) / 180);
  return {
    parameter: 'K0',
    label: 'K₀ (Jáky NC)',
    source: 'Jáky (1944)',
    units: '–',
    representative: k0,
    inputs: { phi },
    caveat: 'NC soils only; OC clays use K0_NC · OCR^sin(φ′).',
  };
}

function k0OCMayne(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  const phiR = phiHatanakaUchida(inp);
  const phi = phiR?.representative;
  if (phi === undefined) return undefined;
  const ocr = inp.ocr ?? 1;
  if (ocr <= 1) return undefined;
  const k0NC = 1 - Math.sin((phi * Math.PI) / 180);
  const k0 = k0NC * Math.pow(ocr, Math.sin((phi * Math.PI) / 180));
  return {
    parameter: 'K0',
    label: 'K₀ (Mayne-Kulhawy)',
    source: 'Mayne & Kulhawy (1982)',
    units: '–',
    representative: k0,
    inputs: { phi, ocr },
  };
}

// ── Correlations: OCR ───────────────────────────────────────────────────────

function ocrMayneFromN(inp: LayerCorrelationInputs): CorrelationResult | undefined {
  if (inp.family === 'granular') return undefined;
  const N = inp.N60 ?? inp.sptN;
  const sigma = inp.sigmaVeff;
  if (N === undefined || sigma === undefined || N <= 0 || sigma <= 0) return undefined;
  // Mayne (1995): OCR ≈ 0.5 · N · Pa / σv'   (rough, for clays)
  const ocr = (0.5 * N * ATM) / sigma;
  if (ocr < 0.5) return undefined;
  return {
    parameter: 'OCR',
    label: 'OCR from N',
    source: 'Mayne (1995)',
    units: '–',
    representative: ocr,
    inputs: { N60: N, sigmaVeff: sigma },
    caveat: 'Clays only; large scatter — corroborate with consolidation data.',
  };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

const ALL_CORRELATIONS: ReadonlyArray<(inp: LayerCorrelationInputs) => CorrelationResult | undefined> = [
  // ϕ′
  phiHatanakaUchida,
  phiPeckHansonThornburn,
  phiWolff,
  phiMeyerhof,
  phiSchmertmann,
  // Dr
  drSkempton,
  drMeyerhof,
  // cu
  cuStroud,
  cuTerzaghiPeck,
  cuHaraEtAl,
  cuSkemptonFromOCR,
  cuFromPI,
  // E
  eBowlesSand,
  eSchmertmann,
  eDuncanBuchignani,
  eBurlandBurbidge,
  // γ
  gammaFromBulkDensity,
  gammaFromDryDensity,
  gammaFromSptGranular,
  gammaFromSptCohesive,
  // Vs
  vsImai,
  vsOhtaGoto,
  // k
  kHazen,
  kFromCuClays,
  // K0
  k0JakyNC,
  k0OCMayne,
  // OCR
  ocrMayneFromN,
];

/**
 * Run every correlation against the supplied inputs. Correlations whose
 * inputs are missing or out-of-domain are silently skipped.
 */
export function runCorrelations(inputs: LayerCorrelationInputs): CorrelationResult[] {
  const out: CorrelationResult[] = [];
  for (const fn of ALL_CORRELATIONS) {
    const r = fn(inputs);
    if (r) out.push(r);
  }
  return out;
}

/** Filter results to those that estimate a given parameter. */
export function correlationsForParameter(
  results: ReadonlyArray<CorrelationResult>,
  paramKey: string,
): CorrelationResult[] {
  return results.filter((r) => r.parameter === paramKey);
}
