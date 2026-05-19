/**
 * Types for 1D ground models in GeoFlow.
 *
 * A GroundModel is built from a "location group" — a named set of LOCA_IDs —
 * and consists of an ordered stack of Layers (top→base) defined on Reduced
 * Level (mAOD). Each Layer carries user-chosen Parameter values plus the
 * provenance refs (LOCA_ID + AGS group + row index) for every measurement
 * used to inform those values.
 *
 * The on-disk JSON shape is intentionally close to AGSi (the AGS Industry
 * data format for ground models) so that `toAgsi(...)` is a straight
 * structural mapping rather than a heavy transform.
 */

/**
 * Reference back to a single row in the source AGS file. Mirrors the
 * `__src` shape used by `@geoflow/transform` cell lineage, so a ground
 * model's provenance can be looked up alongside SQL pipeline output.
 */
export interface SampleRef {
  /** LOCA_ID the sample belongs to. */
  locaId: string;
  /** AGS group name (e.g. 'ISPT', 'GEOL', 'LLPL'). */
  group: string;
  /** 0-based row index inside that group. */
  rowIndex: number;
  /** Sample depth below ground (m), if known — informational only. */
  depth?: number;
  /** Sample reduced level (mAOD), if known — informational only. */
  rl?: number;
}

/**
 * One layer boundary candidate from a particular evidence source. Surfaced
 * to the user in the LayersStep so they can split / merge as they like.
 */
export interface BoundarySuggestion {
  /** Reduced level (mAOD) of the suggested boundary. */
  rl: number;
  /** Where the suggestion came from. */
  source: 'GEOL' | 'ISPT' | 'CPT' | 'lab';
  /** Confidence 0–1; producer-specific. */
  confidence: number;
  /** Human-readable rationale ("CL → SA contact", "SPT N step + 18 → 42"). */
  note?: string;
}

/**
 * A single parameter value selected by the user for one layer. The numeric
 * value is whatever the user typed; the package never derives it.
 */
export interface ParameterValue {
  /** Parameter key, e.g. 'gamma', 'phi', 'cohesion', 'cu', 'E', 'k'. */
  key: string;
  /** Display label, e.g. "γ (kN/m³)". */
  label: string;
  /** Units the value is in. */
  units: string;
  /** The chosen value. null = user has not chosen yet. */
  value: number | null;
  /** Free-text justification supplied by the user. */
  note: string;
  /** Refs to the AGS rows the user was looking at when they decided. */
  evidenceRefs: SampleRef[];
}

/**
 * One stratum in the 1D model.
 *
 * Boundaries are stored in RL because the model represents a group of
 * boreholes (which may have differing ground levels). Depth views are
 * derived per-LOCA at render time.
 */
export interface Layer {
  /** Stable id (used as React key and for AGSi element ids). */
  id: string;
  /** Top RL (mAOD), inclusive. */
  topRL: number;
  /** Base RL (mAOD), exclusive. topRL > baseRL. */
  baseRL: number;
  /** Canonical unit key (GEOL_GEOL/GEOL_LEG) at this depth — initial seed. */
  unitKey: string;
  /** Display name; defaults to unitKey but user can rename. */
  name: string;
  /** A representative description from the seed pass. */
  description: string;
  /** Hex colour used in the strip log. */
  color: string;
  /** User-chosen design parameters. */
  parameters: ParameterValue[];
}

/**
 * A named selection of LOCA_IDs that informs one or more ground models.
 * Mirrors `LocationGroup` from the existing web app but lives in the
 * model file so JSON exports/imports are self-contained.
 */
export interface GroundModelGroup {
  id: string;
  name: string;
  locaIds: string[];
  /**
   * Optional cluster centroid (E, N) — populated when the group was
   * derived from DBSCAN suggestion. Informational only.
   */
  centroid?: { east: number; north: number } | undefined;
}

/**
 * A user-supplied density measurement. Lets the engineer drop bulk/dry
 * density values onto the column even when the AGS file has no RDEN group
 * (or to override a single dubious lab measurement with field judgement).
 */
export interface UserDensityEntry {
  /** Stable id (React key). */
  id: string;
  /** Reduced level (mAOD) at which the value applies. */
  rl: number;
  /** Density value. */
  value: number;
  /** Which density quantity this is. */
  kind: 'bulk' | 'dry';
  /** Units; only Mg/m³ supported today, but stored for forward-compat. */
  units: 'Mg/m³';
  /** Optional free-text source / note. */
  note: string;
}

export interface GroundModel {
  /** Stable id (used as IndexedDB primary key and AGSi modelInstance id). */
  id: string;
  /** Human name, e.g. "Phase 2 — north cluster". */
  name: string;
  /** Free-text description shown in the export header. */
  description: string;
  /** Group of boreholes this model is built from. */
  group: GroundModelGroup;
  /** Layer stack, top→base by RL. */
  layers: Layer[];
  /** Sample step (m) used when running the GEOL skeleton. */
  sampleStep: number;
  /**
   * GEOL column used to seed the layer skeleton (e.g. `'GEOL_GEOL'`,
   * `'GEOL_LEG'`, `'GEOL_STAT'`, `'GEOL_BGS'`). Undefined = use the default
   * waterfall in `representativeGroundModel`.
   */
  unitKeyField?: string | undefined;
  /**
   * Engineer-entered density measurements that should be considered alongside
   * AGS RDEN rows when picking γ values. Empty / missing = none.
   */
  userDensities?: UserDensityEntry[] | undefined;
  createdAt: number;
  updatedAt: number;
}

/** The fixed core parameter set shown when a new layer is created. */
export const DEFAULT_PARAMETERS: ReadonlyArray<Omit<ParameterValue, 'value' | 'note' | 'evidenceRefs'>> = [
  { key: 'gamma',  label: 'γ — bulk unit weight',     units: 'kN/m³' },
  { key: 'phi',    label: "ϕ' — angle of friction",   units: '°' },
  { key: 'c',      label: "c' — effective cohesion",  units: 'kPa' },
  { key: 'cu',     label: 'cu — undrained strength',  units: 'kPa' },
  { key: 'E',      label: "E' — Young's modulus",     units: 'MPa' },
  { key: 'k',      label: 'k — permeability',         units: 'm/s' },
];

/** Build a fresh empty parameter list for a new layer. */
export function defaultParameterValues(): ParameterValue[] {
  return DEFAULT_PARAMETERS.map((p) => ({
    ...p,
    value: null,
    note: '',
    evidenceRefs: [],
  }));
}
