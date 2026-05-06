//! Soil-description parser: converts free-text geotechnical descriptions
//! (e.g. "Soft grey sandy CLAY") into structured data following BS 5930.
//!
//! Entry points:
//! - [`parse_description`] — single text string.
//! - [`enhance_geol`] — batch over every GEOL row in an [`AgsFile`].

use serde::{Deserialize, Serialize};

use crate::model::AgsFile;

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterialType {
    #[default]
    Unknown,
    Soil,
    Rock,
    /// Made ground, fill, topsoil, etc.
    Made,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SoilType {
    Clay,
    Silt,
    Sand,
    Gravel,
    Cobbles,
    Boulders,
    Peat,
    Organic,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RockType {
    Limestone,
    Sandstone,
    Mudstone,
    Granite,
    Basalt,
    Chalk,
    Flint,
    Schist,
    Gneiss,
    Slate,
    Shale,
    Conglomerate,
    Dolerite,
    Andesite,
    Rhyolite,
    Tuff,
    Coal,
    Ironstone,
    Marl,
}

/// Strength descriptor for cohesive soils (BS 5930 Table 11).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Consistency {
    VerySoft,
    Soft,
    SoftToFirm,
    Firm,
    FirmToStiff,
    Stiff,
    StiffToVeryStiff,
    VeryStiff,
    Hard,
}

/// Density descriptor for granular soils (BS 5930 Table 14).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Density {
    VeryLoose,
    Loose,
    LooseToMediumDense,
    MediumDense,
    MediumDenseToDense,
    Dense,
    VeryDense,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Moisture {
    Dry,
    Moist,
    Wet,
    Saturated,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParticleSize {
    Fine,
    FineToMedium,
    Medium,
    MediumToCoarse,
    Coarse,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Proportion {
    /// <5 %
    Trace,
    /// 5–12 %
    Slightly,
    /// 12–35 %
    Moderately,
    /// 35–65 %
    Very,
}

/// A secondary constituent (e.g. "sandy" → Constituent { Slightly, Sand }).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Constituent {
    pub proportion: Proportion,
    pub soil_type: SoilType,
}

/// Estimated strength parameters derived from consistency/density (BS 5930).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrengthParams {
    /// Undrained shear strength range (kPa) — cohesive soils only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cu_min_kpa: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cu_max_kpa: Option<f64>,
    /// SPT N-value range (blows/300 mm) — granular soils only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spt_n_min: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spt_n_max: Option<u32>,
}

/// Fully-structured result for one soil description.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SoilDescription {
    pub raw: String,
    pub material_type: MaterialType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_soil_type: Option<SoilType>,
    /// e.g. the "sandy" part of "sandy CLAY"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secondary_soil_type: Option<SoilType>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub secondary_constituents: Vec<Constituent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rock_type: Option<RockType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consistency: Option<Consistency>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub density: Option<Density>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub colours: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moisture: Option<Moisture>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub particle_size: Option<ParticleSize>,
    pub is_made_ground: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strength_params: Option<StrengthParams>,
    /// 0.0 – 1.0; penalised for missing primary type, mixed signals, etc.
    pub confidence: f32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// One enriched GEOL row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnhancedGeolRow {
    pub loca_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geol_top: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geol_base: Option<f64>,
    pub geol_desc: String,
    pub parsed: SoilDescription,
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

/// Parse a single free-text soil description.
pub fn parse_description(text: &str) -> SoilDescription {
    Parser.parse(text)
}

/// Parse `GEOL_DESC` for every row in the `GEOL` group of an [`AgsFile`].
pub fn enhance_geol(file: &AgsFile) -> Vec<EnhancedGeolRow> {
    let geol = match file.group("GEOL") {
        Some(g) => g,
        None => return vec![],
    };
    geol.rows
        .iter()
        .filter_map(|row| {
            let desc = row.get("GEOL_DESC")?.as_text()?.to_string();
            if desc.trim().is_empty() {
                return None;
            }
            let loca_id = row.get("LOCA_ID")?.as_text()?.to_string();
            let geol_top = row.get("GEOL_TOP").and_then(|v| v.as_number());
            let geol_base = row.get("GEOL_BASE").and_then(|v| v.as_number());
            Some(EnhancedGeolRow {
                loca_id,
                geol_top,
                geol_base,
                geol_desc: desc.clone(),
                parsed: parse_description(&desc),
            })
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal parser
// ─────────────────────────────────────────────────────────────────────────────

struct Parser;

impl Parser {
    fn parse(&self, text: &str) -> SoilDescription {
        let mut desc = SoilDescription {
            raw: text.to_string(),
            ..Default::default()
        };

        let norm = normalize(text);
        let expanded = expand_abbrevs(&norm);

        desc.is_made_ground = is_made_ground(&norm);
        desc.colours = extract_colours(&expanded);
        desc.consistency = extract_consistency(&expanded);
        desc.density = extract_density(&expanded);
        desc.moisture = extract_moisture(&expanded);
        desc.particle_size = extract_particle_size(&expanded);
        desc.rock_type = extract_rock_type(&expanded);

        let (primary, secondary) = extract_soil_types(&expanded);
        desc.primary_soil_type = primary;
        desc.secondary_soil_type = secondary;

        desc.secondary_constituents = extract_constituents(&expanded);

        if desc.is_made_ground {
            desc.material_type = MaterialType::Made;
        } else if desc.rock_type.is_some() {
            desc.material_type = MaterialType::Rock;
        } else if desc.primary_soil_type.is_some() {
            desc.material_type = MaterialType::Soil;
        }

        desc.strength_params = derive_strength(&desc);
        score_and_warn(&mut desc);
        desc
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Text normalisation & abbreviation expansion
// ─────────────────────────────────────────────────────────────────────────────

/// Lowercase and collapse all non-alpha-numeric chars to spaces.
fn normalize(text: &str) -> String {
    let s = text.to_lowercase();
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '/' {
            out.push(c);
        } else {
            out.push(' ');
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Expand common abbreviations using a sliding-window token approach.
fn expand_abbrevs(text: &str) -> String {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let mut result: Vec<String> = Vec::with_capacity(tokens.len());
    let mut i = 0;
    while i < tokens.len() {
        // 3-token window
        if i + 2 < tokens.len() {
            if let Some(exp) = tri_expand(tokens[i], tokens[i + 1], tokens[i + 2]) {
                result.push(exp.to_string());
                i += 3;
                continue;
            }
        }
        // 2-token window
        if i + 1 < tokens.len() {
            if let Some(exp) = bi_expand(tokens[i], tokens[i + 1]) {
                result.push(exp.to_string());
                i += 2;
                continue;
            }
        }
        result.push(mono_expand(tokens[i]));
        i += 1;
    }
    result.join(" ")
}

fn tri_expand(a: &str, b: &str, c: &str) -> Option<&'static str> {
    match (a, b, c) {
        ("soft", "to", "firm") => Some("soft to firm"),
        ("firm", "to", "stiff") => Some("firm to stiff"),
        ("stiff", "to", "very") => None, // handled in bi after consuming "very stiff"
        ("loose", "to", "medium") => None, // "loose to medium dense" — 4 tokens
        ("medium", "dense", "to") => None,
        ("very", "soft", _) => None, // let bi handle
        _ => None,
    }
}

fn bi_expand(a: &str, b: &str) -> Option<&'static str> {
    match (a, b) {
        // Consistency abbreviations
        ("v", "soft") => Some("very soft"),
        ("v", "stiff") => Some("very stiff"),
        ("v", "dense") => Some("very dense"),
        ("v", "loose") => Some("very loose"),
        ("v", "firm") => Some("very firm"),
        ("very", "soft") => Some("very soft"),
        ("very", "stiff") => Some("very stiff"),
        ("very", "dense") => Some("very dense"),
        ("very", "loose") => Some("very loose"),
        // Density abbreviations
        ("m", "dense") | ("med", "dense") | ("medium", "dense") => Some("medium dense"),
        // Particle size
        ("fine", "to") => None, // tri-gram territory
        ("fine", "sand") => Some("fine sand"),
        ("medium", "sand") => Some("medium sand"),
        ("coarse", "sand") => Some("coarse sand"),
        ("fine", "gravel") => Some("fine gravel"),
        ("coarse", "gravel") => Some("coarse gravel"),
        // Colour modifiers
        ("reddish", "brown") => Some("reddish brown"),
        ("yellowish", "brown") => Some("yellowish brown"),
        ("dark", "grey") | ("dark", "gray") => Some("dark grey"),
        ("light", "grey") | ("light", "gray") => Some("light grey"),
        ("dark", "brown") => Some("dark brown"),
        ("light", "brown") => Some("light brown"),
        ("dark", "red") => Some("dark red"),
        ("olive", "brown") => Some("olive brown"),
        ("bluish", "grey") | ("bluish", "gray") => Some("bluish grey"),
        ("greenish", "grey") | ("greenish", "gray") => Some("greenish grey"),
        _ => None,
    }
}

fn mono_expand(t: &str) -> String {
    let expanded: &str = match t {
        // Soil types
        "cl" => "clay",
        "si" => "silt",
        "sa" | "sd" => "sand",
        "gr" | "grv" | "gvl" => "gravel",
        "co" | "cob" => "cobbles",
        "bo" | "boul" => "boulders",
        "pt" => "peat",
        "org" => "organic",
        // Colours
        "br" | "brn" => "brown",
        "gy" | "gry" => "grey",
        "bk" | "blk" => "black",
        "wh" | "wht" => "white",
        "gn" | "grn" => "green",
        "rd" => "red",
        "or" => "orange",
        "yl" | "yel" => "yellow",
        "dk" | "drk" => "dark",
        "lt" | "lgt" => "light",
        // Modifiers
        "v" => "very",
        "m" | "med" => "medium",
        "sl" | "slt" | "sli" => "slightly",
        "tr" | "trc" => "trace",
        "mod" => "moderately",
        "w" | "wth" => "with",
        "incl" => "including",
        // Moisture
        "sat" => "saturated",
        "mst" => "moist",
        // Particle
        "fs" => "fine sand",
        "ms" => "medium sand",
        "cs" => "coarse sand",
        _ => t,
    };
    expanded.to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour extraction
// ─────────────────────────────────────────────────────────────────────────────

fn extract_colours(text: &str) -> Vec<String> {
    // Multi-word first, then single.
    let multi: &[&str] = &[
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
    ];
    let single: &[&str] = &[
        "grey", "gray", "brown", "red", "orange", "yellow", "black", "white", "green", "blue",
        "tan", "buff", "pink", "purple", "beige",
    ];

    let mut found: Vec<String> = Vec::new();
    let mut consumed: Vec<bool> = vec![false; text.len()];

    for &pat in multi {
        let mut start = 0;
        while let Some(pos) = text[start..].find(pat) {
            let abs = start + pos;
            // Word-boundary check
            let before_ok = abs == 0 || !text.as_bytes()[abs - 1].is_ascii_alphanumeric();
            let after_ok = abs + pat.len() >= text.len()
                || !text.as_bytes()[abs + pat.len()].is_ascii_alphanumeric();
            if before_ok && after_ok && !consumed[abs] {
                found.push(pat.to_string());
                for slot in consumed.iter_mut().skip(abs).take(pat.len()) {
                    *slot = true;
                }
            }
            start = abs + 1;
        }
    }

    for &pat in single {
        if word_in(text, pat) {
            // Make sure not already covered by a multi-word colour.
            let already = found.iter().any(|f| f.contains(pat));
            if !already {
                found.push(pat.to_string());
            }
        }
    }

    found
}

// ─────────────────────────────────────────────────────────────────────────────
// Consistency (cohesive)
// ─────────────────────────────────────────────────────────────────────────────

fn extract_consistency(text: &str) -> Option<Consistency> {
    // Ordered from most-specific (ranges) to least.
    if word_seq(text, &["stiff", "to", "very", "stiff"])
        || word_seq(text, &["stiff", "very", "stiff"])
    {
        return Some(Consistency::StiffToVeryStiff);
    }
    if word_seq(text, &["firm", "to", "stiff"]) {
        return Some(Consistency::FirmToStiff);
    }
    if word_seq(text, &["soft", "to", "firm"]) {
        return Some(Consistency::SoftToFirm);
    }
    if word_in(text, "very stiff") {
        return Some(Consistency::VeryStiff);
    }
    if word_in(text, "hard") && !word_in(text, "very hard") {
        return Some(Consistency::Hard);
    }
    if word_in(text, "very soft") {
        return Some(Consistency::VerySoft);
    }
    if word_in(text, "stiff") {
        return Some(Consistency::Stiff);
    }
    if word_in(text, "firm") {
        return Some(Consistency::Firm);
    }
    if word_in(text, "soft") {
        return Some(Consistency::Soft);
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Density (granular)
// ─────────────────────────────────────────────────────────────────────────────

fn extract_density(text: &str) -> Option<Density> {
    if word_seq(text, &["medium", "dense", "to", "dense"]) || word_in(text, "medium dense to dense")
    {
        return Some(Density::MediumDenseToDense);
    }
    if word_seq(text, &["loose", "to", "medium", "dense"]) || word_in(text, "loose to medium dense")
    {
        return Some(Density::LooseToMediumDense);
    }
    if word_in(text, "very dense") {
        return Some(Density::VeryDense);
    }
    if word_in(text, "very loose") {
        return Some(Density::VeryLoose);
    }
    if word_in(text, "medium dense") {
        return Some(Density::MediumDense);
    }
    if word_in(text, "dense") {
        return Some(Density::Dense);
    }
    if word_in(text, "loose") {
        return Some(Density::Loose);
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Moisture
// ─────────────────────────────────────────────────────────────────────────────

fn extract_moisture(text: &str) -> Option<Moisture> {
    if word_in(text, "saturated") {
        return Some(Moisture::Saturated);
    }
    if word_in(text, "wet") {
        return Some(Moisture::Wet);
    }
    if word_in(text, "moist") {
        return Some(Moisture::Moist);
    }
    if word_in(text, "dry") {
        return Some(Moisture::Dry);
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Particle size
// ─────────────────────────────────────────────────────────────────────────────

fn extract_particle_size(text: &str) -> Option<ParticleSize> {
    if word_in(text, "fine to medium") {
        return Some(ParticleSize::FineToMedium);
    }
    if word_in(text, "medium to coarse") {
        return Some(ParticleSize::MediumToCoarse);
    }
    if word_in(text, "fine") {
        return Some(ParticleSize::Fine);
    }
    if word_in(text, "coarse") {
        return Some(ParticleSize::Coarse);
    }
    // "medium" only if not "medium dense"
    if word_in(text, "medium") && !word_in(text, "medium dense") {
        return Some(ParticleSize::Medium);
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Soil type extraction
// ─────────────────────────────────────────────────────────────────────────────

const SOIL_PATTERNS: &[(&str, SoilType, bool)] = &[
    // (pattern, soil_type, is_adjective_form)
    ("clay", SoilType::Clay, false),
    ("clayey", SoilType::Clay, true),
    ("silt", SoilType::Silt, false),
    ("silty", SoilType::Silt, true),
    ("sand", SoilType::Sand, false),
    ("sandy", SoilType::Sand, true),
    ("gravel", SoilType::Gravel, false),
    ("gravelly", SoilType::Gravel, true),
    ("cobbles", SoilType::Cobbles, false),
    ("cobbly", SoilType::Cobbles, true),
    ("boulders", SoilType::Boulders, false),
    ("peat", SoilType::Peat, false),
    ("peaty", SoilType::Peat, true),
    ("organic", SoilType::Organic, false),
];

/// Returns (primary, secondary) soil types.
/// Primary is the dominant (typically UPPERCASE in original, or last noun found).
/// Secondary is the adjective-form modifier if present.
fn extract_soil_types(text: &str) -> (Option<SoilType>, Option<SoilType>) {
    let mut noun_hits: Vec<(&str, &SoilType)> = Vec::new();
    let mut adj_hits: Vec<(&str, &SoilType)> = Vec::new();

    for (pat, st, is_adj) in SOIL_PATTERNS {
        if word_in(text, pat) {
            if *is_adj {
                adj_hits.push((pat, st));
            } else {
                noun_hits.push((pat, st));
            }
        }
    }

    // Primary: last noun mentioned (rightmost in text = dominant BS 5930 convention).
    let primary = noun_hits
        .iter()
        .max_by_key(|(pat, _)| text.rfind(pat).unwrap_or(0))
        .map(|(_, st)| (*st).clone());

    // Secondary: first noun that is NOT the primary, or the first adjective.
    let secondary = if noun_hits.len() > 1 {
        noun_hits
            .iter()
            .min_by_key(|(pat, _)| text.rfind(pat).unwrap_or(0))
            .filter(|(pat, _)| {
                primary.as_ref().is_none_or(|p| {
                    p != noun_hits
                        .iter()
                        .find(|(pp, _)| pp == pat)
                        .map(|(_, s)| *s)
                        .unwrap_or(p)
                })
            })
            .map(|(_, st)| (*st).clone())
    } else {
        adj_hits.first().map(|(_, st)| (*st).clone())
    };

    (primary, secondary)
}

// ─────────────────────────────────────────────────────────────────────────────
// Rock type extraction
// ─────────────────────────────────────────────────────────────────────────────

fn extract_rock_type(text: &str) -> Option<RockType> {
    let patterns: &[(&str, RockType)] = &[
        ("limestone", RockType::Limestone),
        ("sandstone", RockType::Sandstone),
        ("mudstone", RockType::Mudstone),
        ("granite", RockType::Granite),
        ("basalt", RockType::Basalt),
        ("chalk", RockType::Chalk),
        ("flint", RockType::Flint),
        ("schist", RockType::Schist),
        ("gneiss", RockType::Gneiss),
        ("slate", RockType::Slate),
        ("shale", RockType::Shale),
        ("conglomerate", RockType::Conglomerate),
        ("dolerite", RockType::Dolerite),
        ("andesite", RockType::Andesite),
        ("rhyolite", RockType::Rhyolite),
        ("tuff", RockType::Tuff),
        ("coal", RockType::Coal),
        ("ironstone", RockType::Ironstone),
        ("marl", RockType::Marl),
    ];
    for (pat, rt) in patterns {
        if word_in(text, pat) {
            return Some(rt.clone());
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Secondary constituent extraction
// ─────────────────────────────────────────────────────────────────────────────

fn extract_constituents(text: &str) -> Vec<Constituent> {
    let proportion_patterns: &[(&[&str], Proportion)] = &[
        (&["trace", "of", "gravel"], Proportion::Trace),
        (&["trace", "of", "sand"], Proportion::Trace),
        (&["trace", "of", "silt"], Proportion::Trace),
        (&["trace", "of", "clay"], Proportion::Trace),
        (&["trace"], Proportion::Trace),
        (&["slightly"], Proportion::Slightly),
        (&["moderately"], Proportion::Moderately),
        (&["with"], Proportion::Moderately),
    ];

    let adj_soil: &[(&str, SoilType)] = &[
        ("gravelly", SoilType::Gravel),
        ("sandy", SoilType::Sand),
        ("silty", SoilType::Silt),
        ("clayey", SoilType::Clay),
        ("peaty", SoilType::Peat),
        ("cobbles", SoilType::Cobbles),
    ];

    let mut out = Vec::new();

    for (pat, proportion) in proportion_patterns {
        if word_seq(text, pat) {
            // Look for a soil type in the vicinity
            for (adj, st) in adj_soil {
                if word_in(text, adj) {
                    out.push(Constituent {
                        proportion: proportion.clone(),
                        soil_type: st.clone(),
                    });
                    break;
                }
            }
        }
    }

    // Adjective-form without explicit proportion → Slightly
    for (adj, st) in adj_soil {
        if word_in(text, adj) {
            let already = out.iter().any(|c| c.soil_type == *st);
            if !already {
                out.push(Constituent {
                    proportion: Proportion::Slightly,
                    soil_type: st.clone(),
                });
            }
        }
    }

    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Made-ground detection
// ─────────────────────────────────────────────────────────────────────────────

fn is_made_ground(text: &str) -> bool {
    let patterns = [
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
    ];
    for pat in &patterns {
        if word_in(text, pat) {
            return true;
        }
    }
    false
}

// ─────────────────────────────────────────────────────────────────────────────
// Strength parameters (BS 5930)
// ─────────────────────────────────────────────────────────────────────────────

fn derive_strength(desc: &SoilDescription) -> Option<StrengthParams> {
    if let Some(c) = &desc.consistency {
        let (min, max) = match c {
            Consistency::VerySoft => (0.0, 20.0),
            Consistency::Soft => (20.0, 40.0),
            Consistency::SoftToFirm => (20.0, 75.0),
            Consistency::Firm => (40.0, 75.0),
            Consistency::FirmToStiff => (40.0, 150.0),
            Consistency::Stiff => (75.0, 150.0),
            Consistency::StiffToVeryStiff => (75.0, 300.0),
            Consistency::VeryStiff => (150.0, 300.0),
            Consistency::Hard => (300.0, f64::INFINITY),
        };
        return Some(StrengthParams {
            cu_min_kpa: Some(min),
            cu_max_kpa: if max.is_finite() { Some(max) } else { None },
            spt_n_min: None,
            spt_n_max: None,
        });
    }

    if let Some(d) = &desc.density {
        let (min, max) = match d {
            Density::VeryLoose => (0, 4),
            Density::Loose => (4, 10),
            Density::LooseToMediumDense => (4, 30),
            Density::MediumDense => (10, 30),
            Density::MediumDenseToDense => (10, 50),
            Density::Dense => (30, 50),
            Density::VeryDense => (50, 100),
        };
        return Some(StrengthParams {
            cu_min_kpa: None,
            cu_max_kpa: None,
            spt_n_min: Some(min),
            spt_n_max: Some(max),
        });
    }

    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence & warnings
// ─────────────────────────────────────────────────────────────────────────────

fn score_and_warn(desc: &mut SoilDescription) {
    let mut conf = 1.0_f32;

    if desc.primary_soil_type.is_none() && desc.rock_type.is_none() && !desc.is_made_ground {
        desc.warnings.push("no_primary_material_identified".into());
        conf -= 0.3;
    }

    // Consistency on granular / density on cohesive → cross-signal warning
    if desc.consistency.is_some() {
        let is_granular = matches!(
            desc.primary_soil_type,
            Some(SoilType::Sand)
                | Some(SoilType::Gravel)
                | Some(SoilType::Cobbles)
                | Some(SoilType::Boulders)
        );
        if is_granular {
            desc.warnings.push("consistency_on_granular_soil".into());
            conf -= 0.15;
        }
    }

    if desc.density.is_some() {
        let is_cohesive = matches!(
            desc.primary_soil_type,
            Some(SoilType::Clay) | Some(SoilType::Silt) | Some(SoilType::Peat)
        );
        if is_cohesive {
            desc.warnings.push("density_on_cohesive_soil".into());
            conf -= 0.15;
        }
    }

    if desc.colours.is_empty() {
        conf -= 0.05; // minor: colour not always required
    }

    desc.confidence = conf.max(0.0);
}

// ─────────────────────────────────────────────────────────────────────────────
// String helpers
// ─────────────────────────────────────────────────────────────────────────────

/// True if `pattern` appears in `text` as a whole-word (space or boundary delimited).
fn word_in(text: &str, pattern: &str) -> bool {
    let text = text.as_bytes();
    let pat = pattern.as_bytes();
    let plen = pat.len();
    let tlen = text.len();
    if plen > tlen {
        return false;
    }
    let mut i = 0;
    while i + plen <= tlen {
        if &text[i..i + plen] == pat {
            let before = i == 0 || !text[i - 1].is_ascii_alphabetic();
            let after = i + plen == tlen || !text[i + plen].is_ascii_alphabetic();
            if before && after {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// True if all words in `seq` appear consecutively in `text`.
fn word_seq(text: &str, seq: &[&str]) -> bool {
    if seq.is_empty() {
        return true;
    }
    let joined = seq.join(" ");
    word_in(text, &joined)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_soft_grey_clay() {
        let d = parse_description("Soft grey CLAY");
        assert_eq!(d.consistency, Some(Consistency::Soft));
        assert_eq!(d.primary_soil_type, Some(SoilType::Clay));
        assert!(d.colours.contains(&"grey".to_string()));
        assert_eq!(d.material_type, MaterialType::Soil);
        assert!(d.strength_params.is_some());
        let sp = d.strength_params.unwrap();
        assert_eq!(sp.cu_min_kpa, Some(20.0));
        assert_eq!(sp.cu_max_kpa, Some(40.0));
    }

    #[test]
    fn test_medium_dense_sand() {
        let d = parse_description("Medium dense brown fine SAND");
        assert_eq!(d.density, Some(Density::MediumDense));
        assert_eq!(d.primary_soil_type, Some(SoilType::Sand));
        assert_eq!(d.particle_size, Some(ParticleSize::Fine));
        assert!(d.colours.contains(&"brown".to_string()));
        let sp = d.strength_params.unwrap();
        assert_eq!(sp.spt_n_min, Some(10));
        assert_eq!(sp.spt_n_max, Some(30));
    }

    #[test]
    fn test_abbreviation_expansion() {
        let d = parse_description("v soft gy cl");
        assert_eq!(d.consistency, Some(Consistency::VerySoft));
        assert_eq!(d.primary_soil_type, Some(SoilType::Clay));
        assert!(d
            .colours
            .iter()
            .any(|c| c.contains("grey") || c.contains("gray")));
    }

    #[test]
    fn test_made_ground() {
        let d = parse_description("FILL: mixed topsoil and rubble");
        assert!(d.is_made_ground);
        assert_eq!(d.material_type, MaterialType::Made);
    }

    #[test]
    fn test_consistency_range() {
        let d = parse_description("Firm to stiff brown CLAY");
        assert_eq!(d.consistency, Some(Consistency::FirmToStiff));
    }

    #[test]
    fn test_rock_type() {
        let d = parse_description("Moderately weathered grey LIMESTONE");
        assert_eq!(d.rock_type, Some(RockType::Limestone));
        assert_eq!(d.material_type, MaterialType::Rock);
    }

    #[test]
    fn test_sandy_clay() {
        let d = parse_description("Stiff sandy CLAY");
        assert_eq!(d.primary_soil_type, Some(SoilType::Clay));
        assert!(d
            .secondary_constituents
            .iter()
            .any(|c| c.soil_type == SoilType::Sand));
    }

    #[test]
    fn test_word_in() {
        assert!(word_in("soft grey clay", "grey"));
        assert!(!word_in("soft grey clay", "rey"));
        assert!(word_in("very stiff clay", "very stiff"));
    }
}
