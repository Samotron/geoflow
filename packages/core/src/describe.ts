/**
 * Soil & rock description parser.
 *
 * Converts free-text geotechnical descriptions
 * (e.g. "Soft grey sandy CLAY", "Moderately weathered medium strong grey LIMESTONE")
 * into structured data following BS 5930:2015.
 *
 * Entry points:
 * - `parseDescription(text)` — single text string.
 * - `enhanceGeol(file)` — batch over every GEOL row in an AgsFile.
 */

import { AgsFile } from "./model.js";

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

export type MaterialType = "unknown" | "soil" | "rock" | "made";

export type SoilType =
  | "clay"
  | "silt"
  | "sand"
  | "gravel"
  | "cobbles"
  | "boulders"
  | "peat"
  | "organic";

export type RockType =
  | "limestone"
  | "sandstone"
  | "mudstone"
  | "siltstone"
  | "claystone"
  | "granite"
  | "basalt"
  | "chalk"
  | "flint"
  | "schist"
  | "gneiss"
  | "slate"
  | "shale"
  | "conglomerate"
  | "breccia"
  | "dolerite"
  | "andesite"
  | "rhyolite"
  | "tuff"
  | "coal"
  | "ironstone"
  | "marl"
  | "dolomite"
  | "gypsum"
  | "quartzite"
  | "marble"
  | "gabbro";

/** Strength descriptor for cohesive soils (BS 5930 Table 11). */
export type Consistency =
  | "very_soft"
  | "soft"
  | "soft_to_firm"
  | "firm"
  | "firm_to_stiff"
  | "stiff"
  | "stiff_to_very_stiff"
  | "very_stiff"
  | "hard";

/** Density descriptor for granular soils (BS 5930 Table 14). */
export type Density =
  | "very_loose"
  | "loose"
  | "loose_to_medium_dense"
  | "medium_dense"
  | "medium_dense_to_dense"
  | "dense"
  | "very_dense";

export type Moisture = "dry" | "moist" | "wet" | "saturated";

export type ParticleSize =
  | "fine"
  | "fine_to_medium"
  | "medium"
  | "medium_to_coarse"
  | "coarse";

export type Proportion =
  | "trace"        // <5 %
  | "slightly"     // 5–12 %
  | "moderately"   // 12–35 %
  | "very";        // 35–65 %

/** Rock strength (BS 5930:2015 Table 13, ISO 14689). */
export type RockStrength =
  | "extremely_weak"     // < 1 MPa
  | "very_weak"          // 1–5 MPa
  | "weak"               // 5–25 MPa
  | "medium_strong"      // 25–50 MPa
  | "strong"             // 50–100 MPa
  | "very_strong"        // 100–250 MPa
  | "extremely_strong";  // > 250 MPa

/** ISO 14689 weathering grade. */
export type WeatheringGrade =
  | "fresh"                  // W1
  | "slightly_weathered"     // W2
  | "moderately_weathered"   // W3
  | "highly_weathered"       // W4
  | "completely_weathered"   // W5
  | "residual_soil";         // W6

/** Bedding / discontinuity spacing (BS 5930 Table 16). */
export type Spacing =
  | "extremely_close"   // <20 mm
  | "very_close"        // 20–60 mm
  | "close"             // 60–200 mm
  | "medium"            // 200–600 mm
  | "wide"              // 600–2000 mm
  | "very_wide"         // 2000–6000 mm
  | "extremely_wide";   // >6000 mm

/** Plasticity descriptor for fine-grained soils (BS 5930). */
export type Plasticity =
  | "non_plastic"
  | "low"
  | "intermediate"
  | "high"
  | "very_high"
  | "extremely_high";

/** Structure / fabric of soils. */
export type SoilStructure =
  | "homogeneous"
  | "laminated"
  | "interlaminated"
  | "fissured"
  | "stratified"
  | "bedded"
  | "blocky"
  | "lensoid";

/** Secondary constituent. */
export interface Constituent {
  proportion: Proportion;
  soil_type: SoilType;
}

/** Estimated geotechnical parameters derived from consistency/density. */
export interface StrengthParams {
  /** Undrained shear strength range (kPa) — cohesive soils only. */
  cu_min_kpa?: number | undefined;
  cu_max_kpa?: number | undefined;
  /** SPT N-value range (blows/300 mm) — granular soils only. */
  spt_n_min?: number | undefined;
  spt_n_max?: number | undefined;
  /** Estimated unit weight (kN/m³). */
  unit_weight_min?: number | undefined;
  unit_weight_max?: number | undefined;
  /** Effective friction angle range (°) — granular soils. */
  phi_min_deg?: number | undefined;
  phi_max_deg?: number | undefined;
  /** Uniaxial compressive strength range (MPa) — rocks. */
  ucs_min_mpa?: number | undefined;
  ucs_max_mpa?: number | undefined;
}

/** Inclusions / accessory material mentioned in the description. */
export type Inclusion =
  | "roots"
  | "rootlets"
  | "shells"
  | "fossils"
  | "mica"
  | "calcareous"
  | "organic_matter"
  | "wood"
  | "charcoal"
  | "brick"
  | "ash"
  | "slag"
  | "concrete"
  | "tarmac"
  | "glass"
  | "metal"
  | "plastic"
  | "boulders"
  | "cobbles"
  | "flint"
  | "chert";

/**
 * Estimated Unified Soil Classification System group symbol
 * (BS EN ISO 14688 / ASTM D2487).
 */
export type UscsSymbol =
  | "GW" | "GP" | "GM" | "GC"
  | "SW" | "SP" | "SM" | "SC"
  | "ML" | "CL" | "OL"
  | "MH" | "CH" | "OH"
  | "Pt";

/** Fully-structured result for one description. */
export interface SoilDescription {
  raw: string;
  material_type: MaterialType;
  primary_soil_type?: SoilType | undefined;
  /** e.g. the "sandy" part of "sandy CLAY" */
  secondary_soil_type?: SoilType | undefined;
  secondary_constituents: Constituent[];
  rock_type?: RockType | undefined;
  consistency?: Consistency | undefined;
  density?: Density | undefined;
  colours: string[];
  moisture?: Moisture | undefined;
  particle_size?: ParticleSize | undefined;
  is_made_ground: boolean;
  /** Rock weathering grade (BS 5930 / ISO 14689). */
  weathering?: WeatheringGrade | undefined;
  /** Rock material strength. */
  rock_strength?: RockStrength | undefined;
  /** Bedding/discontinuity spacing (rocks). */
  bedding_spacing?: Spacing | undefined;
  /** Plasticity descriptor (fine-grained soils). */
  plasticity?: Plasticity | undefined;
  /** Soil structure / fabric. */
  structures: SoilStructure[];
  /** Listed inclusions / accessory material. */
  inclusions: Inclusion[];
  /** Estimated USCS symbol. */
  uscs?: UscsSymbol | undefined;
  /** Derived strength / state parameters. */
  strength_params?: StrengthParams | undefined;
  /** Original token spans extracted (for highlighting). */
  tokens: ParsedToken[];
  /** 0.0 – 1.0; penalised for missing primary type, mixed signals, etc. */
  confidence: number;
  warnings: string[];
}

export type ParsedTokenKind =
  | "consistency"
  | "density"
  | "moisture"
  | "particle_size"
  | "colour"
  | "soil_type"
  | "rock_type"
  | "weathering"
  | "rock_strength"
  | "spacing"
  | "plasticity"
  | "structure"
  | "inclusion"
  | "made_ground"
  | "proportion";

export interface ParsedToken {
  kind: ParsedTokenKind;
  text: string;
  value: string;
}

/** One enriched GEOL row. */
export interface EnhancedGeolRow {
  loca_id: string;
  geol_top?: number | undefined;
  geol_base?: number | undefined;
  geol_desc: string;
  parsed: SoilDescription;
}

// ───────────────────────────────────────────────────────────────────────────
// Public entry points
// ───────────────────────────────────────────────────────────────────────────

/** Parse a single free-text soil/rock description. */
export function parseDescription(text: string): SoilDescription {
  return parseInternal(text);
}

/** Parse `GEOL_DESC` for every row in the `GEOL` group of an AgsFile. */
export function enhanceGeol(file: AgsFile): EnhancedGeolRow[] {
  const geol = file.groups["GEOL"];
  if (!geol) return [];
  const out: EnhancedGeolRow[] = [];
  for (const row of geol.rows) {
    const desc = typeof row["GEOL_DESC"] === "string" ? row["GEOL_DESC"] : null;
    if (!desc || desc.trim() === "") continue;
    const locaId = typeof row["LOCA_ID"] === "string" ? row["LOCA_ID"] : "";
    const topRaw = row["GEOL_TOP"];
    const baseRaw = row["GEOL_BASE"];
    out.push({
      loca_id: locaId,
      geol_top: typeof topRaw === "number" ? topRaw : undefined,
      geol_base: typeof baseRaw === "number" ? baseRaw : undefined,
      geol_desc: desc,
      parsed: parseDescription(desc),
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Internal parser
// ───────────────────────────────────────────────────────────────────────────

function parseInternal(text: string): SoilDescription {
  const norm = normalize(text);
  const expanded = expandAbbrevs(norm);

  const tokens: ParsedToken[] = [];
  const isMadeGround = detectMadeGround(expanded, tokens);
  const colours = extractColours(expanded, tokens);
  const consistency = extractConsistency(expanded, tokens);
  const density = extractDensity(expanded, tokens);
  const moisture = extractMoisture(expanded, tokens);
  const particleSize = extractParticleSize(expanded, tokens);
  const rockType = extractRockType(expanded, tokens);
  const weathering = extractWeathering(expanded, tokens);
  const rockStrength = extractRockStrength(expanded, tokens);
  const beddingSpacing = extractSpacing(expanded, tokens);
  const plasticity = extractPlasticity(expanded, tokens);
  const structures = extractStructures(expanded, tokens);
  const inclusions = extractInclusions(expanded, tokens);

  const { primary, secondary } = extractSoilTypes(expanded, tokens);
  const constituents = extractConstituents(expanded, tokens);

  let materialType: MaterialType = "unknown";
  if (isMadeGround) materialType = "made";
  else if (rockType !== undefined) materialType = "rock";
  else if (primary !== undefined) materialType = "soil";

  const desc: SoilDescription = {
    raw: text,
    material_type: materialType,
    primary_soil_type: primary,
    secondary_soil_type: secondary,
    secondary_constituents: constituents,
    rock_type: rockType,
    consistency,
    density,
    colours,
    moisture,
    particle_size: particleSize,
    is_made_ground: isMadeGround,
    weathering,
    rock_strength: rockStrength,
    bedding_spacing: beddingSpacing,
    plasticity,
    structures,
    inclusions,
    tokens,
    confidence: 1,
    warnings: [],
  };

  desc.uscs = inferUscs(desc);
  desc.strength_params = deriveStrength(desc);
  scoreAndWarn(desc);
  return desc;
}

// ───────────────────────────────────────────────────────────────────────────
// Text normalisation & abbreviation expansion
// ───────────────────────────────────────────────────────────────────────────

/** Lowercase and collapse non-alphanumeric chars to spaces. */
function normalize(text: string): string {
  const s = text.toLowerCase();
  let out = "";
  for (const ch of s) {
    if (/[a-z0-9]/.test(ch) || ch === " " || ch === "-" || ch === "/") {
      out += ch;
    } else {
      out += " ";
    }
  }
  return out.split(/\s+/).filter(Boolean).join(" ");
}

const BI_EXPANSIONS: Record<string, string> = {
  // Consistency
  "v soft": "very soft",
  "v stiff": "very stiff",
  "v dense": "very dense",
  "v loose": "very loose",
  "v firm": "very firm",
  // Density abbreviations
  "m dense": "medium dense",
  "med dense": "medium dense",
  // Particle size
  "f sand": "fine sand",
  "m sand": "medium sand",
  "c sand": "coarse sand",
  "f gravel": "fine gravel",
  "c gravel": "coarse gravel",
  // Colour modifiers
  "reddish brown": "reddish brown",
  "yellowish brown": "yellowish brown",
  "dark grey": "dark grey",
  "dark gray": "dark grey",
  "light grey": "light grey",
  "light gray": "light grey",
  "dark brown": "dark brown",
  "light brown": "light brown",
  "dark red": "dark red",
  "olive brown": "olive brown",
  "bluish grey": "bluish grey",
  "bluish gray": "bluish grey",
  "greenish grey": "greenish grey",
  "greenish gray": "greenish grey",
  // Weathering
  "v weathered": "very weathered",
};

const MONO_EXPANSIONS: Record<string, string> = {
  // Soil types
  cl: "clay",
  si: "silt",
  sa: "sand",
  sd: "sand",
  gr: "gravel",
  grv: "gravel",
  gvl: "gravel",
  co: "cobbles",
  cob: "cobbles",
  bo: "boulders",
  boul: "boulders",
  pt: "peat",
  org: "organic",
  // Colours
  br: "brown",
  brn: "brown",
  gy: "grey",
  gry: "grey",
  bk: "black",
  blk: "black",
  wh: "white",
  wht: "white",
  gn: "green",
  grn: "green",
  rd: "red",
  or: "orange",
  yl: "yellow",
  yel: "yellow",
  dk: "dark",
  drk: "dark",
  lt: "light",
  lgt: "light",
  // Modifiers
  v: "very",
  m: "medium",
  med: "medium",
  sl: "slightly",
  slt: "slightly",
  sli: "slightly",
  tr: "trace",
  trc: "trace",
  mod: "moderately",
  w: "with",
  wth: "with",
  incl: "including",
  // Moisture
  sat: "saturated",
  mst: "moist",
  // Particle (composite)
  fs: "fine sand",
  ms: "medium sand",
  cs: "coarse sand",
};

function expandAbbrevs(text: string): string {
  const tokens = text.split(" ").filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const a = tokens[i]!;
    const b = i + 1 < tokens.length ? tokens[i + 1]! : null;

    if (b !== null) {
      const bi = BI_EXPANSIONS[`${a} ${b}`];
      if (bi !== undefined) {
        out.push(bi);
        i += 2;
        continue;
      }
    }
    out.push(MONO_EXPANSIONS[a] ?? a);
    i += 1;
  }
  return out.join(" ");
}

// ───────────────────────────────────────────────────────────────────────────
// Colour extraction
// ───────────────────────────────────────────────────────────────────────────

const MULTI_COLOURS: readonly string[] = [
  "reddish brown",
  "yellowish brown",
  "dark grey",
  "light grey",
  "dark brown",
  "light brown",
  "dark red",
  "olive brown",
  "bluish grey",
  "greenish grey",
  "dark green",
  "light green",
  "grey brown",
  "brown grey",
  "mottled grey",
  "mottled brown",
];

const SINGLE_COLOURS: readonly string[] = [
  "grey", "gray", "brown", "red", "orange", "yellow", "black", "white",
  "green", "blue", "tan", "buff", "pink", "purple", "beige", "cream",
  "mottled",
];

function extractColours(text: string, tokens: ParsedToken[]): string[] {
  const found: string[] = [];
  for (const pat of MULTI_COLOURS) {
    if (wordIn(text, pat)) {
      found.push(pat);
      tokens.push({ kind: "colour", text: pat, value: pat });
    }
  }
  for (const pat of SINGLE_COLOURS) {
    if (wordIn(text, pat)) {
      if (!found.some((f) => f.includes(pat))) {
        found.push(pat);
        tokens.push({ kind: "colour", text: pat, value: pat });
      }
    }
  }
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
// Consistency
// ───────────────────────────────────────────────────────────────────────────

function extractConsistency(text: string, tokens: ParsedToken[]): Consistency | undefined {
  const push = (text2: string, value: Consistency): Consistency => {
    tokens.push({ kind: "consistency", text: text2, value });
    return value;
  };
  if (wordIn(text, "stiff to very stiff")) return push("stiff to very stiff", "stiff_to_very_stiff");
  if (wordIn(text, "firm to stiff")) return push("firm to stiff", "firm_to_stiff");
  if (wordIn(text, "soft to firm")) return push("soft to firm", "soft_to_firm");
  if (wordIn(text, "very stiff")) return push("very stiff", "very_stiff");
  if (wordIn(text, "very soft")) return push("very soft", "very_soft");
  if (wordIn(text, "hard") && !wordIn(text, "very hard")) return push("hard", "hard");
  if (wordIn(text, "stiff")) return push("stiff", "stiff");
  if (wordIn(text, "firm")) return push("firm", "firm");
  if (wordIn(text, "soft")) return push("soft", "soft");
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Density
// ───────────────────────────────────────────────────────────────────────────

function extractDensity(text: string, tokens: ParsedToken[]): Density | undefined {
  const push = (text2: string, value: Density): Density => {
    tokens.push({ kind: "density", text: text2, value });
    return value;
  };
  if (wordIn(text, "medium dense to dense")) return push("medium dense to dense", "medium_dense_to_dense");
  if (wordIn(text, "loose to medium dense")) return push("loose to medium dense", "loose_to_medium_dense");
  if (wordIn(text, "very dense")) return push("very dense", "very_dense");
  if (wordIn(text, "very loose")) return push("very loose", "very_loose");
  if (wordIn(text, "medium dense")) return push("medium dense", "medium_dense");
  if (wordIn(text, "dense")) return push("dense", "dense");
  if (wordIn(text, "loose")) return push("loose", "loose");
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Moisture
// ───────────────────────────────────────────────────────────────────────────

function extractMoisture(text: string, tokens: ParsedToken[]): Moisture | undefined {
  const push = (text2: string, value: Moisture): Moisture => {
    tokens.push({ kind: "moisture", text: text2, value });
    return value;
  };
  if (wordIn(text, "saturated")) return push("saturated", "saturated");
  if (wordIn(text, "wet")) return push("wet", "wet");
  if (wordIn(text, "moist")) return push("moist", "moist");
  if (wordIn(text, "dry")) return push("dry", "dry");
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Particle size
// ───────────────────────────────────────────────────────────────────────────

function extractParticleSize(text: string, tokens: ParsedToken[]): ParticleSize | undefined {
  const push = (text2: string, value: ParticleSize): ParticleSize => {
    tokens.push({ kind: "particle_size", text: text2, value });
    return value;
  };
  if (wordIn(text, "fine to medium")) return push("fine to medium", "fine_to_medium");
  if (wordIn(text, "medium to coarse")) return push("medium to coarse", "medium_to_coarse");
  if (wordIn(text, "fine")) return push("fine", "fine");
  if (wordIn(text, "coarse")) return push("coarse", "coarse");
  // "medium" only if it stands alone — not in a compound phrase
  if (
    wordIn(text, "medium") &&
    !wordIn(text, "medium dense") &&
    !wordIn(text, "medium strong") &&
    !wordIn(text, "medium bedded") &&
    !wordIn(text, "medium spaced") &&
    !wordIn(text, "medium plastic")
  ) {
    return push("medium", "medium");
  }
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Weathering (rock)
// ───────────────────────────────────────────────────────────────────────────

function extractWeathering(text: string, tokens: ParsedToken[]): WeatheringGrade | undefined {
  const push = (text2: string, value: WeatheringGrade): WeatheringGrade => {
    tokens.push({ kind: "weathering", text: text2, value });
    return value;
  };
  // Explicit grade codes
  const m = text.match(/\bw([1-6])\b/);
  if (m) {
    const grade: WeatheringGrade = (
      ["fresh", "slightly_weathered", "moderately_weathered",
       "highly_weathered", "completely_weathered", "residual_soil"]
      [parseInt(m[1]!, 10) - 1]
    ) as WeatheringGrade;
    return push(m[0], grade);
  }
  if (wordIn(text, "completely weathered")) return push("completely weathered", "completely_weathered");
  if (wordIn(text, "highly weathered")) return push("highly weathered", "highly_weathered");
  if (wordIn(text, "moderately weathered")) return push("moderately weathered", "moderately_weathered");
  if (wordIn(text, "slightly weathered")) return push("slightly weathered", "slightly_weathered");
  if (wordIn(text, "residual soil")) return push("residual soil", "residual_soil");
  if (wordIn(text, "fresh")) return push("fresh", "fresh");
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Rock strength
// ───────────────────────────────────────────────────────────────────────────

function extractRockStrength(text: string, tokens: ParsedToken[]): RockStrength | undefined {
  const push = (text2: string, value: RockStrength): RockStrength => {
    tokens.push({ kind: "rock_strength", text: text2, value });
    return value;
  };
  if (wordIn(text, "extremely weak")) return push("extremely weak", "extremely_weak");
  if (wordIn(text, "extremely strong")) return push("extremely strong", "extremely_strong");
  if (wordIn(text, "very weak")) return push("very weak", "very_weak");
  if (wordIn(text, "very strong")) return push("very strong", "very_strong");
  if (wordIn(text, "medium strong") || wordIn(text, "moderately strong")) {
    return push("medium strong", "medium_strong");
  }
  if (wordIn(text, "weak")) return push("weak", "weak");
  if (wordIn(text, "strong")) return push("strong", "strong");
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Bedding / discontinuity spacing
// ───────────────────────────────────────────────────────────────────────────

function extractSpacing(text: string, tokens: ParsedToken[]): Spacing | undefined {
  const push = (text2: string, value: Spacing): Spacing => {
    tokens.push({ kind: "spacing", text: text2, value });
    return value;
  };
  // Look for "<modifier> bedded" or "<modifier> spaced"
  const triggers = ["bedded", "bedding", "spaced", "spacing", "jointed", "fractured"];
  if (!triggers.some((t) => wordIn(text, t))) return undefined;
  if (wordIn(text, "extremely close")) return push("extremely close", "extremely_close");
  if (wordIn(text, "very close")) return push("very close", "very_close");
  if (wordIn(text, "extremely wide")) return push("extremely wide", "extremely_wide");
  if (wordIn(text, "very wide")) return push("very wide", "very_wide");
  if (wordIn(text, "close")) return push("close", "close");
  if (wordIn(text, "medium") && !wordIn(text, "medium dense") && !wordIn(text, "medium strong")) {
    return push("medium", "medium");
  }
  if (wordIn(text, "wide")) return push("wide", "wide");
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Plasticity
// ───────────────────────────────────────────────────────────────────────────

function extractPlasticity(text: string, tokens: ParsedToken[]): Plasticity | undefined {
  const push = (text2: string, value: Plasticity): Plasticity => {
    tokens.push({ kind: "plasticity", text: text2, value });
    return value;
  };
  // Match "<modifier> plasticity" or "<modifier> plastic"
  if (!(wordIn(text, "plastic") || wordIn(text, "plasticity"))) return undefined;
  if (wordIn(text, "non plastic") || wordIn(text, "non-plastic")) {
    return push("non plastic", "non_plastic");
  }
  if (wordIn(text, "extremely high")) return push("extremely high plasticity", "extremely_high");
  if (wordIn(text, "very high")) return push("very high plasticity", "very_high");
  if (wordIn(text, "high")) return push("high plasticity", "high");
  if (wordIn(text, "intermediate")) return push("intermediate plasticity", "intermediate");
  if (wordIn(text, "low")) return push("low plasticity", "low");
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Soil structure
// ───────────────────────────────────────────────────────────────────────────

function extractStructures(text: string, tokens: ParsedToken[]): SoilStructure[] {
  const candidates: Array<[string, SoilStructure]> = [
    ["interlaminated", "interlaminated"],
    ["laminated", "laminated"],
    ["fissured", "fissured"],
    ["stratified", "stratified"],
    ["bedded", "bedded"],
    ["blocky", "blocky"],
    ["lensoid", "lensoid"],
    ["homogeneous", "homogeneous"],
  ];
  const out: SoilStructure[] = [];
  for (const [pat, value] of candidates) {
    if (wordIn(text, pat)) {
      out.push(value);
      tokens.push({ kind: "structure", text: pat, value });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Soil types
// ───────────────────────────────────────────────────────────────────────────

interface SoilPattern {
  pattern: string;
  type: SoilType;
  isAdjective: boolean;
}

const SOIL_PATTERNS: readonly SoilPattern[] = [
  { pattern: "clay", type: "clay", isAdjective: false },
  { pattern: "clayey", type: "clay", isAdjective: true },
  { pattern: "silt", type: "silt", isAdjective: false },
  { pattern: "silty", type: "silt", isAdjective: true },
  { pattern: "sand", type: "sand", isAdjective: false },
  { pattern: "sandy", type: "sand", isAdjective: true },
  { pattern: "gravel", type: "gravel", isAdjective: false },
  { pattern: "gravelly", type: "gravel", isAdjective: true },
  { pattern: "cobbles", type: "cobbles", isAdjective: false },
  { pattern: "cobbly", type: "cobbles", isAdjective: true },
  { pattern: "boulders", type: "boulders", isAdjective: false },
  { pattern: "peat", type: "peat", isAdjective: false },
  { pattern: "peaty", type: "peat", isAdjective: true },
  { pattern: "organic", type: "organic", isAdjective: false },
];

interface SoilHit {
  pattern: string;
  type: SoilType;
  position: number;
}

/** Soil nouns that follow these tokens are secondary constituents, not primary. */
const SECONDARY_PREFIXES = ["trace", "with", "of", "slightly", "moderately", "very", "and"];

function extractSoilTypes(
  text: string,
  tokens: ParsedToken[]
): { primary?: SoilType | undefined; secondary?: SoilType | undefined } {
  const nounHits: SoilHit[] = [];
  const adjHits: SoilHit[] = [];
  const constituentNounHits: SoilHit[] = [];

  for (const { pattern, type, isAdjective } of SOIL_PATTERNS) {
    if (wordIn(text, pattern)) {
      const pos = text.lastIndexOf(pattern);
      if (isAdjective) {
        adjHits.push({ pattern, type, position: pos });
      } else {
        // Walk backwards a few tokens; if a SECONDARY_PREFIX appears immediately
        // before the noun (allowing one optional connector), classify as constituent.
        const before = text.slice(Math.max(0, pos - 30), pos).trim();
        const tail = before.split(/\s+/).slice(-2);
        const isConstituent = tail.some((t) => SECONDARY_PREFIXES.includes(t));
        if (isConstituent) {
          constituentNounHits.push({ pattern, type, position: pos });
        } else {
          nounHits.push({ pattern, type, position: pos });
        }
      }
    }
  }

  // Primary: rightmost noun (BS 5930 convention: capitalised principal name last).
  let primary: SoilType | undefined;
  let primaryHit: SoilHit | undefined;
  if (nounHits.length > 0) {
    primaryHit = nounHits.reduce((a, b) => (a.position >= b.position ? a : b));
    primary = primaryHit.type;
    tokens.push({ kind: "soil_type", text: primaryHit.pattern, value: primary });
  }

  // Secondary: another noun or first adjective
  let secondary: SoilType | undefined;
  if (nounHits.length > 1) {
    const others = nounHits.filter((h) => h !== primaryHit && h.type !== primary);
    if (others.length > 0) {
      const sec = others.reduce((a, b) => (a.position <= b.position ? a : b));
      secondary = sec.type;
      tokens.push({ kind: "soil_type", text: sec.pattern, value: secondary });
    }
  } else if (adjHits.length > 0) {
    // First adjective that doesn't match primary
    const candidate = adjHits.find((h) => h.type !== primary) ?? adjHits[0]!;
    secondary = candidate.type;
    tokens.push({ kind: "soil_type", text: candidate.pattern, value: secondary });
  }

  return { primary, secondary };
}

// ───────────────────────────────────────────────────────────────────────────
// Rock type
// ───────────────────────────────────────────────────────────────────────────

const ROCK_PATTERNS: readonly { pattern: string; type: RockType }[] = [
  { pattern: "limestone", type: "limestone" },
  { pattern: "sandstone", type: "sandstone" },
  { pattern: "mudstone", type: "mudstone" },
  { pattern: "siltstone", type: "siltstone" },
  { pattern: "claystone", type: "claystone" },
  { pattern: "granite", type: "granite" },
  { pattern: "basalt", type: "basalt" },
  { pattern: "chalk", type: "chalk" },
  { pattern: "flint", type: "flint" },
  { pattern: "schist", type: "schist" },
  { pattern: "gneiss", type: "gneiss" },
  { pattern: "slate", type: "slate" },
  { pattern: "shale", type: "shale" },
  { pattern: "conglomerate", type: "conglomerate" },
  { pattern: "breccia", type: "breccia" },
  { pattern: "dolerite", type: "dolerite" },
  { pattern: "andesite", type: "andesite" },
  { pattern: "rhyolite", type: "rhyolite" },
  { pattern: "tuff", type: "tuff" },
  { pattern: "coal", type: "coal" },
  { pattern: "ironstone", type: "ironstone" },
  { pattern: "marl", type: "marl" },
  { pattern: "dolomite", type: "dolomite" },
  { pattern: "gypsum", type: "gypsum" },
  { pattern: "quartzite", type: "quartzite" },
  { pattern: "marble", type: "marble" },
  { pattern: "gabbro", type: "gabbro" },
];

function extractRockType(text: string, tokens: ParsedToken[]): RockType | undefined {
  for (const { pattern, type } of ROCK_PATTERNS) {
    if (wordIn(text, pattern)) {
      tokens.push({ kind: "rock_type", text: pattern, value: type });
      return type;
    }
  }
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Inclusions
// ───────────────────────────────────────────────────────────────────────────

const INCLUSION_PATTERNS: readonly { pattern: string; value: Inclusion }[] = [
  { pattern: "rootlets", value: "rootlets" },
  { pattern: "roots", value: "roots" },
  { pattern: "shells", value: "shells" },
  { pattern: "fossils", value: "fossils" },
  { pattern: "fossiliferous", value: "fossils" },
  { pattern: "micaceous", value: "mica" },
  { pattern: "mica", value: "mica" },
  { pattern: "calcareous", value: "calcareous" },
  { pattern: "organic matter", value: "organic_matter" },
  { pattern: "wood", value: "wood" },
  { pattern: "charcoal", value: "charcoal" },
  { pattern: "brick", value: "brick" },
  { pattern: "ash", value: "ash" },
  { pattern: "slag", value: "slag" },
  { pattern: "concrete", value: "concrete" },
  { pattern: "tarmac", value: "tarmac" },
  { pattern: "asphalt", value: "tarmac" },
  { pattern: "glass", value: "glass" },
  { pattern: "metal", value: "metal" },
  { pattern: "plastic", value: "plastic" },
  { pattern: "cobbles", value: "cobbles" },
  { pattern: "boulders", value: "boulders" },
  { pattern: "flint", value: "flint" },
  { pattern: "chert", value: "chert" },
];

function extractInclusions(text: string, tokens: ParsedToken[]): Inclusion[] {
  const out: Inclusion[] = [];
  for (const { pattern, value } of INCLUSION_PATTERNS) {
    if (wordIn(text, pattern) && !out.includes(value)) {
      out.push(value);
      tokens.push({ kind: "inclusion", text: pattern, value });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Secondary constituents
// ───────────────────────────────────────────────────────────────────────────

const ADJ_SOIL: readonly { adj: string; type: SoilType }[] = [
  { adj: "gravelly", type: "gravel" },
  { adj: "sandy", type: "sand" },
  { adj: "silty", type: "silt" },
  { adj: "clayey", type: "clay" },
  { adj: "peaty", type: "peat" },
  { adj: "cobbly", type: "cobbles" },
];

function extractConstituents(text: string, tokens: ParsedToken[]): Constituent[] {
  const out: Constituent[] = [];
  const seen = new Set<SoilType>();

  /** Find the proportion qualifier closest to (and preceding) an adjective hit. */
  const proportionFor = (adj: string): Proportion => {
    const adjIdx = text.indexOf(adj);
    if (adjIdx < 0) return "slightly";
    const before = text.slice(Math.max(0, adjIdx - 30), adjIdx);
    if (/\btrace\s*(of)?\s*$/.test(before)) {
      tokens.push({ kind: "proportion", text: "trace", value: "trace" });
      return "trace";
    }
    if (/\bslightly\s*$/.test(before)) {
      tokens.push({ kind: "proportion", text: "slightly", value: "slightly" });
      return "slightly";
    }
    if (/\bmoderately\s*$/.test(before)) {
      tokens.push({ kind: "proportion", text: "moderately", value: "moderately" });
      return "moderately";
    }
    if (/\bvery\s*$/.test(before)) {
      tokens.push({ kind: "proportion", text: "very", value: "very" });
      return "very";
    }
    if (/\bwith\s*$/.test(before)) {
      tokens.push({ kind: "proportion", text: "with", value: "moderately" });
      return "moderately";
    }
    return "slightly";
  };

  for (const { adj, type } of ADJ_SOIL) {
    if (wordIn(text, adj) && !seen.has(type)) {
      seen.add(type);
      out.push({ proportion: proportionFor(adj), soil_type: type });
    }
  }

  // Explicit "trace of X" / "with X" → look for the noun form
  const nounMatchers: Array<[RegExp, SoilType, Proportion, string]> = [
    [/\btrace\s+(of\s+)?gravel\b/, "gravel", "trace", "trace of gravel"],
    [/\btrace\s+(of\s+)?sand\b/, "sand", "trace", "trace of sand"],
    [/\btrace\s+(of\s+)?silt\b/, "silt", "trace", "trace of silt"],
    [/\btrace\s+(of\s+)?clay\b/, "clay", "trace", "trace of clay"],
    [/\bwith\s+gravel\b/, "gravel", "moderately", "with gravel"],
    [/\bwith\s+sand\b/, "sand", "moderately", "with sand"],
    [/\bwith\s+silt\b/, "silt", "moderately", "with silt"],
    [/\bwith\s+clay\b/, "clay", "moderately", "with clay"],
  ];
  for (const [re, type, proportion, label] of nounMatchers) {
    if (re.test(text) && !seen.has(type)) {
      seen.add(type);
      out.push({ proportion, soil_type: type });
      tokens.push({ kind: "proportion", text: label, value: proportion });
    }
  }

  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Made-ground detection
// ───────────────────────────────────────────────────────────────────────────

function detectMadeGround(text: string, tokens: ParsedToken[]): boolean {
  const patterns = [
    "made ground",
    "made-ground",
    "fill",
    "topsoil",
    "tarmac",
    "asphalt",
    "concrete",
    "slag",
    "demolition",
    "rubble",
    "hardcore",
    "anthropogenic",
  ];
  for (const p of patterns) {
    if (wordIn(text, p)) {
      tokens.push({ kind: "made_ground", text: p, value: p });
      return true;
    }
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// USCS inference
// ───────────────────────────────────────────────────────────────────────────

function inferUscs(desc: SoilDescription): UscsSymbol | undefined {
  if (desc.material_type !== "soil") return undefined;
  const primary = desc.primary_soil_type;
  if (!primary) return undefined;

  const hasFines = desc.secondary_constituents.some(
    (c) => c.soil_type === "silt" || c.soil_type === "clay"
  );
  const highPlasticity =
    desc.plasticity === "high" ||
    desc.plasticity === "very_high" ||
    desc.plasticity === "extremely_high";

  switch (primary) {
    case "peat":
      return "Pt";
    case "organic":
      return highPlasticity ? "OH" : "OL";
    case "clay":
      return highPlasticity ? "CH" : "CL";
    case "silt":
      return highPlasticity ? "MH" : "ML";
    case "sand": {
      if (desc.secondary_constituents.some((c) => c.soil_type === "clay")) return "SC";
      if (hasFines) return "SM";
      const wellGraded = desc.particle_size === "fine_to_medium" || desc.particle_size === "medium_to_coarse";
      return wellGraded ? "SW" : "SP";
    }
    case "gravel": {
      if (desc.secondary_constituents.some((c) => c.soil_type === "clay")) return "GC";
      if (hasFines) return "GM";
      const wellGraded = desc.particle_size === "fine_to_medium" || desc.particle_size === "medium_to_coarse";
      return wellGraded ? "GW" : "GP";
    }
    default:
      return undefined;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Strength / state parameter derivation
// ───────────────────────────────────────────────────────────────────────────

function deriveStrength(desc: SoilDescription): StrengthParams | undefined {
  // Rock UCS from strength descriptor
  if (desc.material_type === "rock" && desc.rock_strength) {
    const map: Record<RockStrength, [number, number | undefined]> = {
      extremely_weak: [0.25, 1],
      very_weak: [1, 5],
      weak: [5, 25],
      medium_strong: [25, 50],
      strong: [50, 100],
      very_strong: [100, 250],
      extremely_strong: [250, undefined],
    };
    const [min, max] = map[desc.rock_strength];
    return { ucs_min_mpa: min, ucs_max_mpa: max };
  }

  if (desc.consistency) {
    const cuMap: Record<Consistency, [number, number | undefined]> = {
      very_soft: [0, 20],
      soft: [20, 40],
      soft_to_firm: [20, 75],
      firm: [40, 75],
      firm_to_stiff: [40, 150],
      stiff: [75, 150],
      stiff_to_very_stiff: [75, 300],
      very_stiff: [150, 300],
      hard: [300, undefined],
    };
    const [cuMin, cuMax] = cuMap[desc.consistency];
    return {
      cu_min_kpa: cuMin,
      cu_max_kpa: cuMax,
      unit_weight_min: 17,
      unit_weight_max: 21,
    };
  }

  if (desc.density) {
    const nMap: Record<Density, [number, number]> = {
      very_loose: [0, 4],
      loose: [4, 10],
      loose_to_medium_dense: [4, 30],
      medium_dense: [10, 30],
      medium_dense_to_dense: [10, 50],
      dense: [30, 50],
      very_dense: [50, 100],
    };
    const phiMap: Record<Density, [number, number]> = {
      very_loose: [25, 28],
      loose: [28, 30],
      loose_to_medium_dense: [28, 33],
      medium_dense: [30, 35],
      medium_dense_to_dense: [30, 38],
      dense: [35, 40],
      very_dense: [38, 45],
    };
    const [nMin, nMax] = nMap[desc.density];
    const [phiMin, phiMax] = phiMap[desc.density];
    return {
      spt_n_min: nMin,
      spt_n_max: nMax,
      phi_min_deg: phiMin,
      phi_max_deg: phiMax,
      unit_weight_min: 16,
      unit_weight_max: 22,
    };
  }

  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Confidence & warnings
// ───────────────────────────────────────────────────────────────────────────

function scoreAndWarn(desc: SoilDescription): void {
  let conf = 1;

  if (!desc.primary_soil_type && !desc.rock_type && !desc.is_made_ground) {
    desc.warnings.push("no_primary_material_identified");
    conf -= 0.3;
  }

  // Consistency on granular → suspicious
  if (desc.consistency) {
    const isGranular =
      desc.primary_soil_type === "sand" ||
      desc.primary_soil_type === "gravel" ||
      desc.primary_soil_type === "cobbles" ||
      desc.primary_soil_type === "boulders";
    if (isGranular) {
      desc.warnings.push("consistency_on_granular_soil");
      conf -= 0.15;
    }
  }

  // Density on cohesive → suspicious
  if (desc.density) {
    const isCohesive =
      desc.primary_soil_type === "clay" ||
      desc.primary_soil_type === "silt" ||
      desc.primary_soil_type === "peat";
    if (isCohesive) {
      desc.warnings.push("density_on_cohesive_soil");
      conf -= 0.15;
    }
  }

  // Rock strength on soil / consistency on rock → suspicious
  if (desc.rock_strength && desc.material_type === "soil") {
    desc.warnings.push("rock_strength_on_soil");
    conf -= 0.1;
  }
  if (desc.consistency && desc.material_type === "rock") {
    desc.warnings.push("consistency_on_rock");
    conf -= 0.1;
  }

  if (desc.colours.length === 0 && desc.material_type !== "unknown") {
    conf -= 0.05;
  }

  desc.confidence = Math.max(0, conf);
}

// ───────────────────────────────────────────────────────────────────────────
// String helpers
// ───────────────────────────────────────────────────────────────────────────

/** Whole-word containment. Letters before/after pattern fail the match. */
function wordIn(text: string, pattern: string): boolean {
  const tlen = text.length;
  const plen = pattern.length;
  if (plen === 0 || plen > tlen) return false;
  let i = 0;
  while (i + plen <= tlen) {
    if (text.substring(i, i + plen) === pattern) {
      const before = i === 0 || !isAlpha(text.charCodeAt(i - 1));
      const after = i + plen === tlen || !isAlpha(text.charCodeAt(i + plen));
      if (before && after) return true;
    }
    i += 1;
  }
  return false;
}

function isAlpha(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}
