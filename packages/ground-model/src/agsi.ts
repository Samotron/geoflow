/**
 * agsi.ts — serialise a GroundModel into an AGSi-aligned JSON document.
 *
 * AGSi (the AGS Industry data format for ground models) is published by
 * the AGS Data Format Working Group as a JSON schema for exchanging
 * ground models, design parameters, and observation references. We
 * mirror the top-level shape (Project / ModelInstance / Element /
 * Property / ObservationData) without trying to validate against the
 * upstream JSON Schema: GeoFlow's UI is the source of truth, AGSi is
 * the wire format. A roundtrip importer can be added later if needed.
 *
 * Spec reference: https://ags-data-format-wg.gitlab.io/agsi/
 */

import type { GroundModel, SampleRef } from './model.js';

const AGSI_SCHEMA = 'https://gitlab.com/ags-data-format-wg/agsi';
const AGSI_VERSION = '1.0.1';

export interface AgsiDocument {
  $schema: typeof AGSI_SCHEMA;
  agsiVersion: typeof AGSI_VERSION;
  generator: { name: 'GeoFlow'; package: '@geoflow/ground-model'; version: '0.1.0' };
  generatedAt: string;
  project: AgsiProject;
  modelInstance: AgsiModelInstance;
}

export interface AgsiProject {
  projectId: string;
  projectName: string;
  description: string;
  /** LOCA_IDs that informed the model — stored as informationSources so the
   *  AGSi consumer can cross-reference. */
  informationSources: Array<{ locaId: string }>;
}

export interface AgsiModelInstance {
  modelInstanceId: string;
  modelType: 'OneDimensional';
  modelInstanceName: string;
  /** Vertical axis convention. Always 'mAOD' for now. */
  verticalDatum: 'mAOD';
  /** Sample step used to build the GEOL skeleton (m). */
  sampleStep: number;
  elements: AgsiElement[];
}

/**
 * One stratum in AGSi terminology. Geometry is a top/base RL pair; in the
 * full AGSi schema this maps to a `Geometry` of type `LayerBoundary` but
 * for 1D models we collapse to a simple flat pair.
 */
export interface AgsiElement {
  elementId: string;
  elementName: string;
  description: string;
  /** AGS unit key (GEOL_GEOL / GEOL_LEG) — preserved for traceability. */
  unitKey: string;
  color: string;
  geometry: {
    type: 'OneDimensionalLayer';
    topRL: number;
    baseRL: number;
    thickness: number;
  };
  /** User-chosen parameter values. */
  properties: AgsiProperty[];
}

export interface AgsiProperty {
  propertyId: string;
  /** Short symbol, e.g. 'gamma', 'phi'. */
  propertyCode: string;
  propertyName: string;
  units: string;
  /** null when the user has not assigned a value. */
  propertyValue: number | null;
  /** Free-text justification from the user. */
  remarks: string;
  /** Refs to the source AGS rows that informed this value. */
  observations: AgsiObservation[];
}

/**
 * Reference to the AGS source row(s) that contributed to a property. In
 * full AGSi this would be a nested `ObservationData` record; we keep the
 * essentials (locaId, agsGroup, rowIndex, depth, RL) and let importers
 * resolve back to the AGS file. The shape matches @geoflow/transform's
 * `__src` provenance format, so it round-trips with pipeline lineage.
 */
export interface AgsiObservation {
  locaId: string;
  agsGroup: string;
  rowIndex: number;
  depth?: number | undefined;
  rl?: number | undefined;
}

function obs(refs: ReadonlyArray<SampleRef>): AgsiObservation[] {
  return refs.map((r) => ({
    locaId: r.locaId,
    agsGroup: r.group,
    rowIndex: r.rowIndex,
    depth: r.depth,
    rl: r.rl,
  }));
}

export function toAgsi(model: GroundModel, projectName = 'GeoFlow project'): AgsiDocument {
  return {
    $schema: AGSI_SCHEMA,
    agsiVersion: AGSI_VERSION,
    generator: { name: 'GeoFlow', package: '@geoflow/ground-model', version: '0.1.0' },
    generatedAt: new Date(model.updatedAt).toISOString(),
    project: {
      projectId: model.group.id,
      projectName,
      description: model.description,
      informationSources: model.group.locaIds.map((locaId) => ({ locaId })),
    },
    modelInstance: {
      modelInstanceId: model.id,
      modelType: 'OneDimensional',
      modelInstanceName: model.name,
      verticalDatum: 'mAOD',
      sampleStep: model.sampleStep,
      elements: model.layers.map((layer, idx) => ({
        elementId: layer.id,
        elementName: layer.name || `Layer ${idx + 1}`,
        description: layer.description,
        unitKey: layer.unitKey,
        color: layer.color,
        geometry: {
          type: 'OneDimensionalLayer',
          topRL: layer.topRL,
          baseRL: layer.baseRL,
          thickness: Math.abs(layer.topRL - layer.baseRL),
        },
        properties: layer.parameters.map((p, pi) => ({
          propertyId: `${layer.id}-prop-${pi}`,
          propertyCode: p.key,
          propertyName: p.label,
          units: p.units,
          propertyValue: p.value,
          remarks: p.note,
          observations: obs(p.evidenceRefs),
        })),
      })),
    },
  };
}

/** Convenience: stringified pretty-printed JSON ready to download. */
export function toAgsiJson(model: GroundModel, projectName?: string): string {
  return JSON.stringify(toAgsi(model, projectName), null, 2);
}
