/**
 * Soil & rock description parser.
 *
 * Converts free-text geotechnical descriptions
 * (e.g. "Soft grey sandy CLAY", "Moderately weathered medium strong grey LIMESTONE")
 * into structured data following BS 5930:2015, with additional outputs for
 * ASTM D2488, USCS, AASHTO and ISO 14688/14689.
 *
 * Designed to be tolerant of:
 *  - dialects and shorthand from multiple standards
 *  - misspellings (fuzzy match to a known vocabulary)
 *  - mixed-case and idiosyncratic punctuation
 *  - aggregated descriptions (e.g. "Stiff, fissured, dark grey to brown, sandy CLAY
 *    with occasional sub-rounded fine gravel; calcareous; non-plastic to low plasticity")
 *
 * Entry points:
 *  - `parseDescription(text, options?)` — single description string.
 *  - `enhanceGeol(file)` — batch over every GEOL row in an AgsFile.
 *  - `getDescribeVocabulary()` — vocabulary used for fuzzy spell-correction.
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
  | "gabbro"
  | "diorite"
  | "anhydrite"
  | "halite"
  | "chert";

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
  | "lensoid"
  | "slickensided"
  | "varved";

/** Particle roundness (BS 5930 / ASTM). */
export type Roundness =
  | "very_angular"
  | "angular"
  | "sub_angular"
  | "sub_rounded"
  | "rounded"
  | "well_rounded";

/** Particle sorting / grading. */
export type Sorting = "well_sorted" | "moderately_sorted" | "poorly_sorted" | "well_graded" | "poorly_graded";

/** Cementation (ASTM D2488). */
export type Cementation = "weakly_cemented" | "moderately_cemented" | "strongly_cemented";

/** Calcareous reaction with dilute HCl (ASTM D2488). */
export type HclReaction = "none" | "weak" | "strong";

/** Odour. */
export type Odour =
  | "organic"
  | "earthy"
  | "hydrocarbon"
  | "sulphurous"
  | "septic"
  | "musty";

/** Depositional environment / origin (BS 5930 Annex B). */
export type Origin =
  | "alluvial"
  | "lacustrine"
  | "marine"
  | "glacial"
  | "glaciofluvial"
  | "aeolian"
  | "colluvial"
  | "fluvial"
  | "estuarine"
  | "residual"
  | "anthropogenic"
  | "volcanic";

/** Geological period / age (very simplified). */
export type GeologicalAge =
  | "quaternary"
  | "neogene"
  | "palaeogene"
  | "cretaceous"
  | "jurassic"
  | "triassic"
  | "permian"
  | "carboniferous"
  | "devonian"
  | "silurian"
  | "ordovician"
  | "cambrian"
  | "precambrian";

/** Joint aperture (ISO 14689 Table B.5). */
export type JointAperture =
  | "tight"               // <0.1 mm
  | "extremely_narrow"    // 0.1–0.25 mm
  | "very_narrow"         // 0.25–0.5 mm
  | "narrow"              // 0.5–2.5 mm
  | "moderately_wide"     // 2.5–10 mm
  | "wide"                // 10–25 mm
  | "very_wide"           // 25–100 mm
  | "extremely_wide";     // >100 mm

/** Joint roughness (ISO 14689). */
export type JointRoughness =
  | "rough"
  | "smooth"
  | "slickensided"
  | "stepped"
  | "undulating"
  | "planar";

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
  | "ferruginous"
  | "gypsiferous"
  | "carbonaceous"
  | "iron_staining"
  | "manganese_staining"
  | "hydrocarbon_staining"
  | "quartz_veins"
  | "calcite_veins"
  | "organic_matter"
  | "wood"
  | "charcoal"
  | "brick"
  | "ash"
  | "slag"
  | "clinker"
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
 * USCS group symbols (ASTM D2487 / D2488).
 */
export type UscsSymbol =
  | "GW" | "GP" | "GM" | "GC"
  | "SW" | "SP" | "SM" | "SC"
  | "ML" | "CL" | "OL"
  | "MH" | "CH" | "OH"
  | "Pt";

/**
 * AASHTO soil-classification group (M 145).
 * Granular: A-1-a, A-1-b, A-2-4, A-2-5, A-2-6, A-2-7, A-3
 * Silt/clay: A-4, A-5, A-6, A-7-5, A-7-6
 * Highly organic: A-8
 */
export type AashtoSymbol =
  | "A-1-a" | "A-1-b" | "A-2-4" | "A-2-5" | "A-2-6" | "A-2-7"
  | "A-3" | "A-4" | "A-5" | "A-6" | "A-7-5" | "A-7-6" | "A-8";

/** Output of the multi-standard classifier. */
export interface Classifications {
  /** USCS (ASTM D2487/D2488) group symbol. */
  uscs?: UscsSymbol | undefined;
  /** AASHTO (M 145) classification group. */
  aashto?: AashtoSymbol | undefined;
  /** BS 5930 principal group symbol (e.g. CLAY, sCLAY, saSAND). */
  bs5930?: string | undefined;
  /** ISO 14688 grouping (e.g. clCo, saCl, Gr). */
  iso14688?: string | undefined;
}

/** Token span in the *normalised* input — useful for UI highlighting. */
export interface ParsedToken {
  kind: ParsedTokenKind;
  text: string;
  value: string;
  /** Start index in the *normalised lowercase* string. */
  start: number;
  /** End index (exclusive) in the *normalised lowercase* string. */
  end: number;
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
  | "proportion"
  | "roundness"
  | "sorting"
  | "cementation"
  | "hcl_reaction"
  | "odour"
  | "origin"
  | "age"
  | "joint_aperture"
  | "joint_roughness"
  | "formation";

/** Detection of a known formation / lithostratigraphic unit. */
export interface FormationMatch {
  name: string;
  /** Optional age (when the formation maps to a known geological period). */
  age?: GeologicalAge | undefined;
}

/** Fully-structured result for one description. */
export interface SoilDescription {
  raw: string;
  /** Normalised (lowercase, punctuation-stripped) text used internally. */
  normalised: string;
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
  /** Bedding/discontinuity spacing. */
  bedding_spacing?: Spacing | undefined;
  /** Plasticity descriptor (fine-grained soils). */
  plasticity?: Plasticity | undefined;
  /** Soil structure / fabric. */
  structures: SoilStructure[];
  /** Listed inclusions / accessory material. */
  inclusions: Inclusion[];
  /** Particle roundness/angularity. */
  roundness?: Roundness | undefined;
  /** Particle sorting / grading. */
  sorting?: Sorting | undefined;
  /** Cementation descriptor (ASTM D2488). */
  cementation?: Cementation | undefined;
  /** Reaction with dilute HCl (ASTM D2488). */
  hcl_reaction?: HclReaction | undefined;
  /** Odour descriptor. */
  odour?: Odour | undefined;
  /** Depositional environment / origin. */
  origin?: Origin | undefined;
  /** Geological period / age. */
  age?: GeologicalAge | undefined;
  /** Joint aperture (rocks). */
  joint_aperture?: JointAperture | undefined;
  /** Joint roughness (rocks). */
  joint_roughness?: JointRoughness | undefined;
  /** Lithostratigraphic formation matches. */
  formations: FormationMatch[];
  /** Multi-standard classifications. */
  classifications: Classifications;
  /** Estimated USCS symbol (kept for back-compat; equal to classifications.uscs). */
  uscs?: UscsSymbol | undefined;
  /** Derived strength / state parameters. */
  strength_params?: StrengthParams | undefined;
  /** Original token spans extracted (for highlighting). */
  tokens: ParsedToken[];
  /** Spelling corrections that were applied. */
  spelling_corrections: SpellingCorrection[];
  /** 0.0 – 1.0; penalised for missing primary type, mixed signals, etc. */
  confidence: number;
  warnings: string[];
}

export interface SpellingCorrection {
  original: string;
  corrected: string;
  start: number;
  end: number;
}

/** One enriched GEOL row. */
export interface EnhancedGeolRow {
  loca_id: string;
  geol_top?: number | undefined;
  geol_base?: number | undefined;
  geol_desc: string;
  parsed: SoilDescription;
}

/** Options controlling parser behaviour. */
export interface ParseOptions {
  /**
   * Maximum Levenshtein distance allowed when fuzzy-matching unknown tokens to
   * the vocabulary. 0 disables spell correction. Default: 1 for tokens of
   * length 4–6, 2 for tokens of length ≥ 7.
   */
  spellCorrection?: boolean | undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Public entry points
// ───────────────────────────────────────────────────────────────────────────

/** Parse a single free-text soil/rock description. */
export function parseDescription(text: string, options: ParseOptions = {}): SoilDescription {
  return parseInternal(text, options);
}

/** Parse `GEOL_DESC` for every row in the `GEOL` group of an AgsFile. */
export function enhanceGeol(file: AgsFile, options: ParseOptions = {}): EnhancedGeolRow[] {
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
      parsed: parseDescription(desc, options),
    });
  }
  return out;
}

/** Return the union of every fixed phrase / keyword the parser recognises. */
export function getDescribeVocabulary(): readonly string[] {
  if (VOCAB_CACHE.length > 0) return VOCAB_CACHE;
  const set = new Set<string>();
  for (const p of MULTI_COLOURS) set.add(p);
  for (const p of SINGLE_COLOURS) set.add(p);
  for (const list of CONSISTENCY_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of DENSITY_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of MOISTURE_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of PARTICLE_SIZE_PATTERNS) for (const p of list[0]) set.add(p);
  for (const p of SOIL_PATTERNS) set.add(p.pattern);
  for (const p of ROCK_PATTERNS) set.add(p.pattern);
  for (const p of INCLUSION_PATTERNS) set.add(p.pattern);
  for (const list of WEATHERING_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of ROCK_STRENGTH_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of PLASTICITY_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of CEMENTATION_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of ROUNDNESS_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of SORTING_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of ODOUR_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of ORIGIN_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of AGE_PATTERNS) for (const p of list[0]) set.add(p);
  for (const list of STRUCTURE_PATTERNS) for (const p of list[0]) set.add(p);
  for (const f of FORMATIONS) set.add(f.name.toLowerCase());
  for (const p of MADE_GROUND_PATTERNS) set.add(p);
  for (const list of HCL_PATTERNS) for (const p of list[0]) set.add(p);
  VOCAB_CACHE.push(...Array.from(set));
  return VOCAB_CACHE;
}

const VOCAB_CACHE: string[] = [];

// ───────────────────────────────────────────────────────────────────────────
// Internal parser
// ───────────────────────────────────────────────────────────────────────────

function parseInternal(text: string, options: ParseOptions): SoilDescription {
  const normRaw = normalize(text);
  const corrections: SpellingCorrection[] = [];

  // Step 1 — token-level abbreviation expansion (keeps phrase structure)
  const expanded = expandAbbrevs(normRaw);

  // Step 2 — fuzzy spell-correct unknown tokens against vocabulary.
  const spelled = options.spellCorrection !== false
    ? spellCorrectTokens(expanded, corrections)
    : expanded;

  const tokens: ParsedToken[] = [];

  const isMadeGround = detectMadeGround(spelled, tokens);
  const colours = extractColours(spelled, tokens);
  const consistency = extractConsistency(spelled, tokens);
  const density = extractDensity(spelled, tokens);
  const moisture = extractMoisture(spelled, tokens);
  const particleSize = extractParticleSize(spelled, tokens);
  const rockType = extractRockType(spelled, tokens);
  const weathering = extractWeathering(spelled, tokens);
  const rockStrength = extractRockStrength(spelled, tokens);
  const beddingSpacing = extractSpacing(spelled, tokens);
  const plasticity = extractPlasticity(spelled, tokens);
  const structures = extractStructures(spelled, tokens);
  const inclusions = extractInclusions(spelled, tokens);
  const roundness = extractRoundness(spelled, tokens);
  const sorting = extractSorting(spelled, tokens);
  const cementation = extractCementation(spelled, tokens);
  const hcl = extractHclReaction(spelled, tokens);
  const odour = extractOdour(spelled, tokens);
  const origin = extractOrigin(spelled, tokens);
  const age = extractAge(spelled, tokens);
  const jointAperture = extractJointAperture(spelled, tokens);
  const jointRoughness = extractJointRoughness(spelled, tokens);
  const formations = extractFormations(spelled, tokens);

  const { primary, secondary } = extractSoilTypes(spelled, tokens);
  const constituents = extractConstituents(spelled, tokens);

  let materialType: MaterialType = "unknown";
  if (rockType !== undefined) materialType = "rock";
  else if (isMadeGround) materialType = "made";
  else if (primary !== undefined) materialType = "soil";

  // Promote formation-derived age when no explicit age token was found.
  let resolvedAge = age;
  if (!resolvedAge) {
    for (const f of formations) {
      if (f.age) { resolvedAge = f.age; break; }
    }
  }

  const desc: SoilDescription = {
    raw: text,
    normalised: spelled,
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
    roundness,
    sorting,
    cementation,
    hcl_reaction: hcl,
    odour,
    origin,
    age: resolvedAge,
    joint_aperture: jointAperture,
    joint_roughness: jointRoughness,
    formations,
    classifications: {},
    tokens,
    spelling_corrections: corrections,
    confidence: 1,
    warnings: [],
  };

  desc.classifications = inferClassifications(desc);
  desc.uscs = desc.classifications.uscs;
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
  "v weak": "very weak",
  "v strong": "very strong",
  // Density
  "m dense": "medium dense",
  "med dense": "medium dense",
  // Particle size
  "f sand": "fine sand",
  "m sand": "medium sand",
  "c sand": "coarse sand",
  "f gravel": "fine gravel",
  "c gravel": "coarse gravel",
  // Colour modifiers
  "dark grey": "dark grey",
  "dark gray": "dark grey",
  "light grey": "light grey",
  "light gray": "light grey",
  "dark brown": "dark brown",
  "light brown": "light brown",
  "dark red": "dark red",
  "olive brown": "olive brown",
  "reddish brown": "reddish brown",
  "yellowish brown": "yellowish brown",
  "bluish grey": "bluish grey",
  "bluish gray": "bluish grey",
  "greenish grey": "greenish grey",
  "greenish gray": "greenish grey",
  // Roundness shorthand
  "sub ang": "sub angular",
  "subang": "sub angular",
  "subr": "sub rounded",
  "sub rnd": "sub rounded",
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
  occ: "occasional",
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
  // Roundness
  ang: "angular",
  rnd: "rounded",
  subr: "sub rounded",
  // Weathering grades
  w1: "fresh",
  w2: "slightly weathered",
  w3: "moderately weathered",
  w4: "highly weathered",
  w5: "completely weathered",
  w6: "residual soil",
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
// Fuzzy spell-correction
// ───────────────────────────────────────────────────────────────────────────

/**
 * Walk every whitespace-delimited token and, when it doesn't appear in our
 * vocabulary directly, try to find a vocabulary entry within Levenshtein
 * distance ≤ 1 (or 2 for long words). Tokens shorter than 4 chars are left
 * alone — too many false positives.
 */
function spellCorrectTokens(text: string, corrections: SpellingCorrection[]): string {
  const vocab = getDescribeVocabulary();
  // Single-word vocab is matched directly. We also consider individual words
  // that appear inside any multi-word vocab phrase as 'known' so we don't
  // accidentally correct e.g. "weathered" → "unweathered" while it sits inside
  // "moderately weathered".
  const singles = new Set<string>();
  for (const entry of vocab) {
    if (entry.includes(" ")) {
      for (const w of entry.split(" ")) singles.add(w);
    } else {
      singles.add(entry);
    }
  }
  // Add a few words commonly used as connectors that must not be 'corrected'
  // to something else (e.g. "with" → "wet" via 1 edit).
  const STOPWORDS = new Set([
    "to", "of", "and", "with", "or", "in", "on", "is", "the", "a", "an",
    "no", "not", "non", "some", "few", "many", "much", "less", "more",
    "becoming", "becomes", "interbedded", "occasional", "frequent",
    "thin", "thick", "soft", "hard", "brown", "grey", "gray", "black",
    "white", "red", "yellow", "blue", "green", "orange", "tan", "buff",
    "pink", "purple", "beige", "cream", "mottled",
  ]);

  let cursor = 0;
  const tokens: string[] = [];
  const pieces = text.split(" ");
  for (const tok of pieces) {
    if (tok.length === 0) continue;
    const before = cursor;
    const after = cursor + tok.length;
    cursor = after + 1; // account for the space

    if (tok.length < 4) { tokens.push(tok); continue; }
    if (STOPWORDS.has(tok) || singles.has(tok)) { tokens.push(tok); continue; }
    if (/^\d/.test(tok)) { tokens.push(tok); continue; }

    const candidate = nearestVocab(tok, singles);
    if (candidate !== null) {
      corrections.push({ original: tok, corrected: candidate, start: before, end: after });
      tokens.push(candidate);
    } else {
      tokens.push(tok);
    }
  }
  return tokens.join(" ");
}

/** Find the closest vocab entry within an edit distance budget. */
function nearestVocab(token: string, vocab: Set<string>): string | null {
  const budget = token.length >= 7 ? 2 : 1;
  let best: { word: string; dist: number } | null = null;

  for (const word of vocab) {
    // Length pre-filter: edit distance ≥ |len_a - len_b|
    if (Math.abs(word.length - token.length) > budget) continue;
    // Avoid 'correcting' to a token with a different starting letter unless
    // we already know the first letter is wrong (would be a too-aggressive fix).
    if (word[0] !== token[0] && budget < 2) continue;

    const d = levenshtein(token, word, budget);
    if (d <= budget && (best === null || d < best.dist)) {
      best = { word, dist: d };
      if (d === 0) break;
    }
  }
  return best?.word ?? null;
}

/** Levenshtein distance with an early-exit threshold. */
function levenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j] + 1,            // deletion
        prev[j - 1] + cost      // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ───────────────────────────────────────────────────────────────────────────
// Generic "first phrase matches → value" helpers
// ───────────────────────────────────────────────────────────────────────────

type PatternList<T> = ReadonlyArray<readonly [readonly string[], T]>;

function matchFirst<T>(
  text: string,
  patterns: PatternList<T>,
  tokens: ParsedToken[],
  kind: ParsedTokenKind
): T | undefined {
  for (const [phrases, value] of patterns) {
    for (const phrase of phrases) {
      const span = findWord(text, phrase);
      if (span) {
        tokens.push({ kind, text: phrase, value: String(value), start: span[0], end: span[1] });
        return value;
      }
    }
  }
  return undefined;
}

/** All phrases that match yield separate tokens (no early exit). */
function matchAll<T>(
  text: string,
  patterns: PatternList<T>,
  tokens: ParsedToken[],
  kind: ParsedTokenKind
): T[] {
  const out: T[] = [];
  for (const [phrases, value] of patterns) {
    for (const phrase of phrases) {
      const span = findWord(text, phrase);
      if (span) {
        out.push(value);
        tokens.push({ kind, text: phrase, value: String(value), start: span[0], end: span[1] });
        break;
      }
    }
  }
  return out;
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
  "khaki", "olive", "ochre", "mottled",
];

function extractColours(text: string, tokens: ParsedToken[]): string[] {
  const found: string[] = [];
  for (const pat of MULTI_COLOURS) {
    const span = findWord(text, pat);
    if (span) {
      found.push(pat);
      tokens.push({ kind: "colour", text: pat, value: pat, start: span[0], end: span[1] });
    }
  }
  for (const pat of SINGLE_COLOURS) {
    const span = findWord(text, pat);
    if (span && !found.some((f) => f.includes(pat))) {
      found.push(pat);
      tokens.push({ kind: "colour", text: pat, value: pat, start: span[0], end: span[1] });
    }
  }
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
// Pattern tables (phrases listed most-specific first)
// ───────────────────────────────────────────────────────────────────────────

const CONSISTENCY_PATTERNS: PatternList<Consistency> = [
  [["stiff to very stiff"], "stiff_to_very_stiff"],
  [["firm to stiff"], "firm_to_stiff"],
  [["soft to firm"], "soft_to_firm"],
  [["very stiff"], "very_stiff"],
  [["very soft"], "very_soft"],
  [["hard"], "hard"],
  [["stiff"], "stiff"],
  [["firm"], "firm"],
  [["soft"], "soft"],
];

const DENSITY_PATTERNS: PatternList<Density> = [
  [["medium dense to dense"], "medium_dense_to_dense"],
  [["loose to medium dense"], "loose_to_medium_dense"],
  [["very dense"], "very_dense"],
  [["very loose"], "very_loose"],
  [["medium dense", "medium-dense"], "medium_dense"],
  [["dense"], "dense"],
  [["loose"], "loose"],
];

const MOISTURE_PATTERNS: PatternList<Moisture> = [
  [["saturated"], "saturated"],
  [["wet"], "wet"],
  [["damp"], "moist"],
  [["moist"], "moist"],
  [["dry"], "dry"],
];

const PARTICLE_SIZE_PATTERNS: PatternList<ParticleSize> = [
  [["fine to medium"], "fine_to_medium"],
  [["medium to coarse"], "medium_to_coarse"],
];

const WEATHERING_PATTERNS: PatternList<WeatheringGrade> = [
  [["completely weathered"], "completely_weathered"],
  [["highly weathered"], "highly_weathered"],
  [["moderately weathered"], "moderately_weathered"],
  [["slightly weathered"], "slightly_weathered"],
  [["residual soil"], "residual_soil"],
  [["unweathered", "fresh"], "fresh"],
];

const ROCK_STRENGTH_PATTERNS: PatternList<RockStrength> = [
  [["extremely weak"], "extremely_weak"],
  [["extremely strong"], "extremely_strong"],
  [["very weak"], "very_weak"],
  [["very strong"], "very_strong"],
  [["medium strong", "moderately strong"], "medium_strong"],
  [["weak"], "weak"],
  [["strong"], "strong"],
];

const PLASTICITY_PATTERNS: PatternList<Plasticity> = [
  [["extremely high plasticity"], "extremely_high"],
  [["very high plasticity"], "very_high"],
  [["high plasticity"], "high"],
  [["intermediate plasticity"], "intermediate"],
  [["low plasticity"], "low"],
  [["non plastic", "non-plastic", "nonplastic"], "non_plastic"],
];

const CEMENTATION_PATTERNS: PatternList<Cementation> = [
  [["weakly cemented"], "weakly_cemented"],
  [["moderately cemented"], "moderately_cemented"],
  [["strongly cemented", "well cemented"], "strongly_cemented"],
];

const ROUNDNESS_PATTERNS: PatternList<Roundness> = [
  [["very angular"], "very_angular"],
  [["well rounded"], "well_rounded"],
  [["sub angular", "sub-angular", "subangular"], "sub_angular"],
  [["sub rounded", "sub-rounded", "subrounded"], "sub_rounded"],
  [["angular"], "angular"],
  [["rounded"], "rounded"],
];

const SORTING_PATTERNS: PatternList<Sorting> = [
  [["well sorted", "well-sorted"], "well_sorted"],
  [["moderately sorted"], "moderately_sorted"],
  [["poorly sorted", "poorly-sorted"], "poorly_sorted"],
  [["well graded", "well-graded"], "well_graded"],
  [["poorly graded", "poorly-graded", "uniformly graded"], "poorly_graded"],
];

const ODOUR_PATTERNS: PatternList<Odour> = [
  [["hydrocarbon odour", "hydrocarbon odor", "hydrocarbon smell", "petroleum odour"], "hydrocarbon"],
  [["organic odour", "organic odor", "organic smell"], "organic"],
  [["sulphurous", "sulfurous", "rotten egg", "hydrogen sulphide", "hydrogen sulfide"], "sulphurous"],
  [["septic"], "septic"],
  [["musty"], "musty"],
  [["earthy"], "earthy"],
];

const ORIGIN_PATTERNS: PatternList<Origin> = [
  [["glaciofluvial", "glacio-fluvial"], "glaciofluvial"],
  [["glacial till", "glacial", "till", "boulder clay"], "glacial"],
  [["alluvial", "alluvium"], "alluvial"],
  [["lacustrine"], "lacustrine"],
  [["marine"], "marine"],
  [["aeolian", "eolian", "wind blown"], "aeolian"],
  [["colluvial", "colluvium"], "colluvial"],
  [["fluvial"], "fluvial"],
  [["estuarine"], "estuarine"],
  [["residual"], "residual"],
  [["anthropogenic"], "anthropogenic"],
  [["volcanic"], "volcanic"],
];

const AGE_PATTERNS: PatternList<GeologicalAge> = [
  [["quaternary", "holocene", "pleistocene"], "quaternary"],
  [["neogene", "miocene", "pliocene"], "neogene"],
  [["palaeogene", "paleogene", "eocene", "oligocene", "palaeocene", "paleocene"], "palaeogene"],
  [["cretaceous"], "cretaceous"],
  [["jurassic"], "jurassic"],
  [["triassic"], "triassic"],
  [["permian"], "permian"],
  [["carboniferous"], "carboniferous"],
  [["devonian"], "devonian"],
  [["silurian"], "silurian"],
  [["ordovician"], "ordovician"],
  [["cambrian"], "cambrian"],
  [["precambrian", "proterozoic", "archaean", "archean"], "precambrian"],
];

const STRUCTURE_PATTERNS: PatternList<SoilStructure> = [
  [["interlaminated"], "interlaminated"],
  [["laminated"], "laminated"],
  [["fissured"], "fissured"],
  [["stratified"], "stratified"],
  [["bedded"], "bedded"],
  [["blocky"], "blocky"],
  [["lensoid"], "lensoid"],
  [["homogeneous"], "homogeneous"],
  [["slickensided"], "slickensided"],
  [["varved"], "varved"],
];

const HCL_PATTERNS: PatternList<HclReaction> = [
  [["strong reaction with hcl", "strongly effervescent", "violently effervescent"], "strong"],
  [["weak reaction with hcl", "weakly effervescent"], "weak"],
  [["no reaction with hcl", "non effervescent", "non-effervescent"], "none"],
];

const JOINT_APERTURE_PATTERNS: PatternList<JointAperture> = [
  [["extremely wide aperture"], "extremely_wide"],
  [["very wide aperture"], "very_wide"],
  [["wide aperture"], "wide"],
  [["moderately wide aperture"], "moderately_wide"],
  [["narrow aperture"], "narrow"],
  [["very narrow aperture"], "very_narrow"],
  [["extremely narrow aperture"], "extremely_narrow"],
  [["tight"], "tight"],
];

const JOINT_ROUGHNESS_PATTERNS: PatternList<JointRoughness> = [
  [["slickensided joints", "slickensided"], "slickensided"],
  [["stepped"], "stepped"],
  [["undulating"], "undulating"],
  [["planar joints"], "planar"],
  [["rough joints", "rough"], "rough"],
  [["smooth joints", "smooth"], "smooth"],
];

const MADE_GROUND_PATTERNS: readonly string[] = [
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
  "clinker",
  "anthropogenic",
];

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
  { pattern: "diorite", type: "diorite" },
  { pattern: "anhydrite", type: "anhydrite" },
  { pattern: "halite", type: "halite" },
  { pattern: "chert", type: "chert" },
];

const INCLUSION_PATTERNS: readonly { pattern: string; value: Inclusion }[] = [
  { pattern: "rootlets", value: "rootlets" },
  { pattern: "roots", value: "roots" },
  { pattern: "shells", value: "shells" },
  { pattern: "fossils", value: "fossils" },
  { pattern: "fossiliferous", value: "fossils" },
  { pattern: "micaceous", value: "mica" },
  { pattern: "mica", value: "mica" },
  { pattern: "calcareous", value: "calcareous" },
  { pattern: "ferruginous", value: "ferruginous" },
  { pattern: "gypsiferous", value: "gypsiferous" },
  { pattern: "carbonaceous", value: "carbonaceous" },
  { pattern: "iron staining", value: "iron_staining" },
  { pattern: "iron stained", value: "iron_staining" },
  { pattern: "manganese staining", value: "manganese_staining" },
  { pattern: "hydrocarbon staining", value: "hydrocarbon_staining" },
  { pattern: "quartz veins", value: "quartz_veins" },
  { pattern: "calcite veins", value: "calcite_veins" },
  { pattern: "organic matter", value: "organic_matter" },
  { pattern: "wood", value: "wood" },
  { pattern: "charcoal", value: "charcoal" },
  { pattern: "brick", value: "brick" },
  { pattern: "ash", value: "ash" },
  { pattern: "slag", value: "slag" },
  { pattern: "clinker", value: "clinker" },
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

interface FormationEntry {
  name: string;
  age?: GeologicalAge;
}

/** A small curated list of common UK / global formations. */
const FORMATIONS: readonly FormationEntry[] = [
  { name: "London Clay", age: "palaeogene" },
  { name: "Lambeth Group", age: "palaeogene" },
  { name: "Thanet Sand", age: "palaeogene" },
  { name: "Chalk Group", age: "cretaceous" },
  { name: "Gault Clay", age: "cretaceous" },
  { name: "Mercia Mudstone", age: "triassic" },
  { name: "Sherwood Sandstone", age: "triassic" },
  { name: "Lias", age: "jurassic" },
  { name: "Oxford Clay", age: "jurassic" },
  { name: "Kimmeridge Clay", age: "jurassic" },
  { name: "Coal Measures", age: "carboniferous" },
  { name: "Millstone Grit", age: "carboniferous" },
  { name: "Old Red Sandstone", age: "devonian" },
  { name: "Atherfield Clay", age: "cretaceous" },
  { name: "Weald Clay", age: "cretaceous" },
  { name: "Boulder Clay", age: "quaternary" },
  { name: "River Terrace Deposits", age: "quaternary" },
  { name: "Alluvium", age: "quaternary" },
  { name: "Head Deposits", age: "quaternary" },
  // International
  { name: "Bay Mud" },
  { name: "Loess" },
  { name: "Marl" },
];

// ───────────────────────────────────────────────────────────────────────────
// Wrapper extractors
// ───────────────────────────────────────────────────────────────────────────

function extractConsistency(text: string, tokens: ParsedToken[]): Consistency | undefined {
  return matchFirst(text, CONSISTENCY_PATTERNS, tokens, "consistency");
}

function extractDensity(text: string, tokens: ParsedToken[]): Density | undefined {
  return matchFirst(text, DENSITY_PATTERNS, tokens, "density");
}

function extractMoisture(text: string, tokens: ParsedToken[]): Moisture | undefined {
  return matchFirst(text, MOISTURE_PATTERNS, tokens, "moisture");
}

function extractParticleSize(text: string, tokens: ParsedToken[]): ParticleSize | undefined {
  const ranged = matchFirst(text, PARTICLE_SIZE_PATTERNS, tokens, "particle_size");
  if (ranged !== undefined) return ranged;
  if (findWord(text, "fine")) {
    const span = findWord(text, "fine")!;
    tokens.push({ kind: "particle_size", text: "fine", value: "fine", start: span[0], end: span[1] });
    return "fine";
  }
  if (findWord(text, "coarse")) {
    const span = findWord(text, "coarse")!;
    tokens.push({ kind: "particle_size", text: "coarse", value: "coarse", start: span[0], end: span[1] });
    return "coarse";
  }
  // "medium" only when standing alone
  if (
    findWord(text, "medium") &&
    !findWord(text, "medium dense") &&
    !findWord(text, "medium strong") &&
    !findWord(text, "medium bedded") &&
    !findWord(text, "medium spaced") &&
    !findWord(text, "medium plastic") &&
    !findWord(text, "medium sorted") &&
    !findWord(text, "moderately strong")
  ) {
    const span = findWord(text, "medium")!;
    tokens.push({ kind: "particle_size", text: "medium", value: "medium", start: span[0], end: span[1] });
    return "medium";
  }
  return undefined;
}

function extractWeathering(text: string, tokens: ParsedToken[]): WeatheringGrade | undefined {
  return matchFirst(text, WEATHERING_PATTERNS, tokens, "weathering");
}

function extractRockStrength(text: string, tokens: ParsedToken[]): RockStrength | undefined {
  return matchFirst(text, ROCK_STRENGTH_PATTERNS, tokens, "rock_strength");
}

function extractSpacing(text: string, tokens: ParsedToken[]): Spacing | undefined {
  const triggers = ["bedded", "bedding", "spaced", "spacing", "jointed", "fractured"];
  if (!triggers.some((t) => findWord(text, t))) return undefined;
  if (findWord(text, "extremely close")) {
    const span = findWord(text, "extremely close")!;
    tokens.push({ kind: "spacing", text: "extremely close", value: "extremely_close", start: span[0], end: span[1] });
    return "extremely_close";
  }
  if (findWord(text, "very close")) {
    const span = findWord(text, "very close")!;
    tokens.push({ kind: "spacing", text: "very close", value: "very_close", start: span[0], end: span[1] });
    return "very_close";
  }
  if (findWord(text, "extremely wide")) {
    const span = findWord(text, "extremely wide")!;
    tokens.push({ kind: "spacing", text: "extremely wide", value: "extremely_wide", start: span[0], end: span[1] });
    return "extremely_wide";
  }
  if (findWord(text, "very wide")) {
    const span = findWord(text, "very wide")!;
    tokens.push({ kind: "spacing", text: "very wide", value: "very_wide", start: span[0], end: span[1] });
    return "very_wide";
  }
  if (findWord(text, "close")) {
    const span = findWord(text, "close")!;
    tokens.push({ kind: "spacing", text: "close", value: "close", start: span[0], end: span[1] });
    return "close";
  }
  if (
    findWord(text, "medium") &&
    !findWord(text, "medium dense") &&
    !findWord(text, "medium strong")
  ) {
    const span = findWord(text, "medium")!;
    tokens.push({ kind: "spacing", text: "medium", value: "medium", start: span[0], end: span[1] });
    return "medium";
  }
  if (findWord(text, "wide")) {
    const span = findWord(text, "wide")!;
    tokens.push({ kind: "spacing", text: "wide", value: "wide", start: span[0], end: span[1] });
    return "wide";
  }
  return undefined;
}

function extractPlasticity(text: string, tokens: ParsedToken[]): Plasticity | undefined {
  if (!findWord(text, "plastic") && !findWord(text, "plasticity")) return undefined;
  return matchFirst(text, PLASTICITY_PATTERNS, tokens, "plasticity");
}

function extractStructures(text: string, tokens: ParsedToken[]): SoilStructure[] {
  return matchAll(text, STRUCTURE_PATTERNS, tokens, "structure");
}

function extractRoundness(text: string, tokens: ParsedToken[]): Roundness | undefined {
  return matchFirst(text, ROUNDNESS_PATTERNS, tokens, "roundness");
}

function extractSorting(text: string, tokens: ParsedToken[]): Sorting | undefined {
  return matchFirst(text, SORTING_PATTERNS, tokens, "sorting");
}

function extractCementation(text: string, tokens: ParsedToken[]): Cementation | undefined {
  return matchFirst(text, CEMENTATION_PATTERNS, tokens, "cementation");
}

function extractHclReaction(text: string, tokens: ParsedToken[]): HclReaction | undefined {
  return matchFirst(text, HCL_PATTERNS, tokens, "hcl_reaction");
}

function extractOdour(text: string, tokens: ParsedToken[]): Odour | undefined {
  return matchFirst(text, ODOUR_PATTERNS, tokens, "odour");
}

function extractOrigin(text: string, tokens: ParsedToken[]): Origin | undefined {
  return matchFirst(text, ORIGIN_PATTERNS, tokens, "origin");
}

function extractAge(text: string, tokens: ParsedToken[]): GeologicalAge | undefined {
  return matchFirst(text, AGE_PATTERNS, tokens, "age");
}

function extractJointAperture(text: string, tokens: ParsedToken[]): JointAperture | undefined {
  if (!findWord(text, "aperture") && !findWord(text, "tight")) return undefined;
  return matchFirst(text, JOINT_APERTURE_PATTERNS, tokens, "joint_aperture");
}

function extractJointRoughness(text: string, tokens: ParsedToken[]): JointRoughness | undefined {
  if (
    !findWord(text, "joint") &&
    !findWord(text, "joints") &&
    !findWord(text, "rough") &&
    !findWord(text, "smooth") &&
    !findWord(text, "slickensided") &&
    !findWord(text, "stepped") &&
    !findWord(text, "undulating") &&
    !findWord(text, "planar")
  ) return undefined;
  return matchFirst(text, JOINT_ROUGHNESS_PATTERNS, tokens, "joint_roughness");
}

function extractFormations(text: string, tokens: ParsedToken[]): FormationMatch[] {
  const out: FormationMatch[] = [];
  for (const f of FORMATIONS) {
    const lower = f.name.toLowerCase();
    const span = findWord(text, lower);
    if (span) {
      out.push({ name: f.name, age: f.age });
      tokens.push({ kind: "formation", text: lower, value: f.name, start: span[0], end: span[1] });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Soil types
// ───────────────────────────────────────────────────────────────────────────

interface SoilHit {
  pattern: string;
  type: SoilType;
  position: number;
}

/** Soil nouns following these tokens are secondary constituents, not primary. */
const SECONDARY_PREFIXES = [
  "trace", "with", "of", "slightly", "moderately", "very", "and",
  "occasional", "rare", "few", "some", "frequent",
];

function extractSoilTypes(
  text: string,
  tokens: ParsedToken[]
): { primary?: SoilType | undefined; secondary?: SoilType | undefined } {
  const nounHits: SoilHit[] = [];
  const adjHits: SoilHit[] = [];
  const constituentNounHits: SoilHit[] = [];

  for (const { pattern, type, isAdjective } of SOIL_PATTERNS) {
    const span = findWord(text, pattern);
    if (!span) continue;
    const pos = span[0];
    if (isAdjective) {
      adjHits.push({ pattern, type, position: pos });
    } else {
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

  let primary: SoilType | undefined;
  let primaryHit: SoilHit | undefined;
  if (nounHits.length > 0) {
    primaryHit = nounHits.reduce((a, b) => (a.position >= b.position ? a : b));
    primary = primaryHit.type;
    tokens.push({
      kind: "soil_type",
      text: primaryHit.pattern,
      value: primary,
      start: primaryHit.position,
      end: primaryHit.position + primaryHit.pattern.length,
    });
  }

  let secondary: SoilType | undefined;
  if (nounHits.length > 1) {
    const others = nounHits.filter((h) => h !== primaryHit && h.type !== primary);
    if (others.length > 0) {
      const sec = others.reduce((a, b) => (a.position <= b.position ? a : b));
      secondary = sec.type;
      tokens.push({
        kind: "soil_type",
        text: sec.pattern,
        value: secondary,
        start: sec.position,
        end: sec.position + sec.pattern.length,
      });
    }
  } else if (adjHits.length > 0) {
    const candidate = adjHits.find((h) => h.type !== primary) ?? adjHits[0]!;
    secondary = candidate.type;
    tokens.push({
      kind: "soil_type",
      text: candidate.pattern,
      value: secondary,
      start: candidate.position,
      end: candidate.position + candidate.pattern.length,
    });
  }

  return { primary, secondary };
}

// ───────────────────────────────────────────────────────────────────────────
// Rock type
// ───────────────────────────────────────────────────────────────────────────

function extractRockType(text: string, tokens: ParsedToken[]): RockType | undefined {
  for (const { pattern, type } of ROCK_PATTERNS) {
    const span = findWord(text, pattern);
    if (span) {
      tokens.push({ kind: "rock_type", text: pattern, value: type, start: span[0], end: span[1] });
      return type;
    }
  }
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Inclusions
// ───────────────────────────────────────────────────────────────────────────

function extractInclusions(text: string, tokens: ParsedToken[]): Inclusion[] {
  const out: Inclusion[] = [];
  for (const { pattern, value } of INCLUSION_PATTERNS) {
    const span = findWord(text, pattern);
    if (span && !out.includes(value)) {
      out.push(value);
      tokens.push({ kind: "inclusion", text: pattern, value, start: span[0], end: span[1] });
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

  const proportionFor = (adj: string): Proportion => {
    const adjIdx = text.indexOf(adj);
    if (adjIdx < 0) return "slightly";
    const before = text.slice(Math.max(0, adjIdx - 30), adjIdx);
    if (/\btrace\s*(of)?\s*$/.test(before)) return record("trace", "trace", adjIdx);
    if (/\bslightly\s*$/.test(before)) return record("slightly", "slightly", adjIdx);
    if (/\bmoderately\s*$/.test(before)) return record("moderately", "moderately", adjIdx);
    if (/\bvery\s*$/.test(before)) return record("very", "very", adjIdx);
    if (/\bwith\s*$/.test(before)) return record("with", "moderately", adjIdx);
    if (/\boccasional\s*$/.test(before)) return record("occasional", "trace", adjIdx);
    if (/\brare\s*$/.test(before)) return record("rare", "trace", adjIdx);
    if (/\bfrequent\s*$/.test(before)) return record("frequent", "moderately", adjIdx);
    if (/\b(some|few)\s*$/.test(before)) return record("some", "slightly", adjIdx);
    return "slightly";
  };

  const record = (label: string, value: Proportion, idx: number): Proportion => {
    tokens.push({ kind: "proportion", text: label, value, start: idx - label.length - 1, end: idx - 1 });
    return value;
  };

  for (const { adj, type } of ADJ_SOIL) {
    if (findWord(text, adj) && !seen.has(type)) {
      seen.add(type);
      out.push({ proportion: proportionFor(adj), soil_type: type });
    }
  }

  const nounMatchers: Array<[RegExp, SoilType, Proportion, string]> = [
    [/\btrace\s+(of\s+)?gravel\b/, "gravel", "trace", "trace of gravel"],
    [/\btrace\s+(of\s+)?sand\b/, "sand", "trace", "trace of sand"],
    [/\btrace\s+(of\s+)?silt\b/, "silt", "trace", "trace of silt"],
    [/\btrace\s+(of\s+)?clay\b/, "clay", "trace", "trace of clay"],
    [/\bwith\s+gravel\b/, "gravel", "moderately", "with gravel"],
    [/\bwith\s+sand\b/, "sand", "moderately", "with sand"],
    [/\bwith\s+silt\b/, "silt", "moderately", "with silt"],
    [/\bwith\s+clay\b/, "clay", "moderately", "with clay"],
    [/\boccasional\s+gravel\b/, "gravel", "trace", "occasional gravel"],
    [/\boccasional\s+sand\b/, "sand", "trace", "occasional sand"],
    [/\bfrequent\s+gravel\b/, "gravel", "moderately", "frequent gravel"],
    [/\bfrequent\s+sand\b/, "sand", "moderately", "frequent sand"],
  ];
  for (const [re, type, proportion, label] of nounMatchers) {
    if (re.test(text) && !seen.has(type)) {
      seen.add(type);
      out.push({ proportion, soil_type: type });
      const m = re.exec(text);
      if (m) {
        tokens.push({ kind: "proportion", text: label, value: proportion, start: m.index, end: m.index + m[0].length });
      }
    }
  }

  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Made-ground detection
// ───────────────────────────────────────────────────────────────────────────

function detectMadeGround(text: string, tokens: ParsedToken[]): boolean {
  for (const p of MADE_GROUND_PATTERNS) {
    const span = findWord(text, p);
    if (span) {
      tokens.push({ kind: "made_ground", text: p, value: p, start: span[0], end: span[1] });
      return true;
    }
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// Classification (USCS / AASHTO / BS / ISO)
// ───────────────────────────────────────────────────────────────────────────

function inferClassifications(desc: SoilDescription): Classifications {
  return {
    uscs: inferUscs(desc),
    aashto: inferAashto(desc),
    bs5930: inferBs5930(desc),
    iso14688: inferIso14688(desc),
  };
}

function inferUscs(desc: SoilDescription): UscsSymbol | undefined {
  if (desc.material_type !== "soil") return undefined;
  const primary = desc.primary_soil_type;
  if (!primary) return undefined;

  const hasFines = desc.secondary_constituents.some(
    (c) => c.soil_type === "silt" || c.soil_type === "clay"
  );
  const hasClayFines = desc.secondary_constituents.some((c) => c.soil_type === "clay");
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
      if (hasClayFines) return "SC";
      if (hasFines) return "SM";
      const wellGraded =
        desc.particle_size === "fine_to_medium" ||
        desc.particle_size === "medium_to_coarse" ||
        desc.sorting === "well_graded";
      return wellGraded ? "SW" : "SP";
    }
    case "gravel": {
      if (hasClayFines) return "GC";
      if (hasFines) return "GM";
      const wellGraded =
        desc.particle_size === "fine_to_medium" ||
        desc.particle_size === "medium_to_coarse" ||
        desc.sorting === "well_graded";
      return wellGraded ? "GW" : "GP";
    }
    default:
      return undefined;
  }
}

function inferAashto(desc: SoilDescription): AashtoSymbol | undefined {
  if (desc.material_type !== "soil") return undefined;
  const primary = desc.primary_soil_type;
  if (!primary) return undefined;
  const highPlasticity =
    desc.plasticity === "high" ||
    desc.plasticity === "very_high" ||
    desc.plasticity === "extremely_high";
  const hasFines = desc.secondary_constituents.some(
    (c) => c.soil_type === "silt" || c.soil_type === "clay"
  );

  switch (primary) {
    case "peat":
    case "organic":
      return "A-8";
    case "gravel":
      if (!hasFines) return "A-1-a";
      return highPlasticity ? "A-2-7" : "A-2-6";
    case "sand":
      if (!hasFines) return "A-3";
      if (desc.secondary_constituents.some((c) => c.soil_type === "clay")) {
        return highPlasticity ? "A-2-7" : "A-2-6";
      }
      return highPlasticity ? "A-2-5" : "A-2-4";
    case "silt":
      return highPlasticity ? "A-5" : "A-4";
    case "clay":
      if (highPlasticity) return desc.plasticity === "very_high" || desc.plasticity === "extremely_high" ? "A-7-6" : "A-6";
      return "A-6";
    default:
      return undefined;
  }
}

/**
 * BS 5930 symbolic group name. Uses ALL CAPS for the primary, lowercase
 * adjective prefixes for secondaries, e.g.
 *   "Sandy CLAY" → "saCLAY"
 *   "Gravelly fine SAND" → "grSAND"
 *   "Highly weathered LIMESTONE" → "LIMESTONE"
 */
function inferBs5930(desc: SoilDescription): string | undefined {
  if (desc.material_type === "soil" && desc.primary_soil_type) {
    let symbol = "";
    for (const c of desc.secondary_constituents) {
      const prefix = SOIL_SHORT[c.soil_type];
      symbol += c.proportion === "very" ? prefix.toUpperCase() : prefix;
    }
    symbol += SOIL_SHORT[desc.primary_soil_type].toUpperCase();
    return symbol;
  }
  if (desc.material_type === "rock" && desc.rock_type) {
    return desc.rock_type.toUpperCase();
  }
  if (desc.material_type === "made") {
    return "MADE GROUND";
  }
  return undefined;
}

/** ISO 14688 symbol — similar to BS but with two-letter codes. */
function inferIso14688(desc: SoilDescription): string | undefined {
  if (desc.material_type === "soil" && desc.primary_soil_type) {
    const primary = SOIL_ISO[desc.primary_soil_type];
    if (!primary) return undefined;
    let prefix = "";
    for (const c of desc.secondary_constituents) {
      const code = SOIL_ISO[c.soil_type];
      if (code) prefix += code.charAt(0).toLowerCase() + code.charAt(1).toLowerCase();
    }
    return prefix + primary;
  }
  return undefined;
}

const SOIL_SHORT: Record<SoilType, string> = {
  clay: "cl",
  silt: "si",
  sand: "sa",
  gravel: "gr",
  cobbles: "co",
  boulders: "bo",
  peat: "pt",
  organic: "or",
};

const SOIL_ISO: Record<SoilType, string> = {
  clay: "Cl",
  silt: "Si",
  sand: "Sa",
  gravel: "Gr",
  cobbles: "Co",
  boulders: "Bo",
  peat: "Pt",
  organic: "Or",
};

// ───────────────────────────────────────────────────────────────────────────
// Strength / state parameter derivation
// ───────────────────────────────────────────────────────────────────────────

function deriveStrength(desc: SoilDescription): StrengthParams | undefined {
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

  if (desc.rock_strength && desc.material_type === "soil") {
    desc.warnings.push("rock_strength_on_soil");
    conf -= 0.1;
  }
  if (desc.consistency && desc.material_type === "rock") {
    desc.warnings.push("consistency_on_rock");
    conf -= 0.1;
  }

  // Penalise lots of spell corrections on a short input — likely garbage in.
  if (desc.spelling_corrections.length > 0) {
    const tokenCount = Math.max(1, desc.normalised.split(/\s+/).length);
    const ratio = desc.spelling_corrections.length / tokenCount;
    if (ratio > 0.4) {
      desc.warnings.push("heavy_spelling_corrections");
      conf -= 0.1;
    }
  }

  if (desc.colours.length === 0 && desc.material_type !== "unknown") {
    conf -= 0.05;
  }

  desc.confidence = Math.max(0, conf);
}

// ───────────────────────────────────────────────────────────────────────────
// String helpers
// ───────────────────────────────────────────────────────────────────────────

/** Whole-word search returning [start, end) span, or null. */
function findWord(text: string, pattern: string): [number, number] | null {
  const tlen = text.length;
  const plen = pattern.length;
  if (plen === 0 || plen > tlen) return null;
  let i = 0;
  while (i + plen <= tlen) {
    if (text.substring(i, i + plen) === pattern) {
      const before = i === 0 || !isAlpha(text.charCodeAt(i - 1));
      const after = i + plen === tlen || !isAlpha(text.charCodeAt(i + plen));
      if (before && after) return [i, i + plen];
    }
    i += 1;
  }
  return null;
}

function isAlpha(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}
