/**
 * AGSi-aligned JSON export from a parsed AGS file.
 *
 * This is a structural export: each LOCA becomes one OneDimensional
 * modelInstance, each GEOL row becomes a OneDimensionalLayer element with
 * the AGS code preserved as `unitKey`. The shape mirrors the layer/element/
 * unit-key schema used by `@geoflow/ground-model/agsi.ts`, so downstream
 * tools can treat both files the same way.
 *
 * Spec reference: https://ags-data-format-wg.gitlab.io/agsi/
 */

import type { AgsFile } from "./model.js";
import { buildProjectSummary } from "./summary.js";
import type { ProjectSummary } from "./summary.js";

const AGSI_SCHEMA = "https://gitlab.com/ags-data-format-wg/agsi";
const AGSI_VERSION = "1.0.1";

export interface AgsiExportDocument {
  $schema: typeof AGSI_SCHEMA;
  agsiVersion: typeof AGSI_VERSION;
  generator: { name: "GeoFlow"; package: "@geoflow/core"; version: string };
  generatedAt: string;
  project: {
    projectId: string;
    projectName: string;
    description: string;
    location: string;
    client: string;
    informationSources: Array<{ locaId: string }>;
  };
  geologicalUnits: AgsiGeologicalUnit[];
  modelInstances: AgsiModelInstance[];
}

export interface AgsiGeologicalUnit {
  unitId: string;
  unitCode: string;
  unitName: string;
  description: string;
  occurrences: number;
  totalThicknessM: number;
  meanThicknessM: number;
  inHoles: number;
}

export interface AgsiModelInstance {
  modelInstanceId: string;
  modelType: "OneDimensional";
  /** LOCA_ID; identifies the borehole this model represents. */
  locaId: string;
  modelInstanceName: string;
  verticalDatum: "mAOD" | "BGL";
  /** LOCA_GL where available, else null. */
  groundLevel: number | null;
  /** Total depth in metres (LOCA_FDEP). */
  totalDepth: number;
  /** Optional plan position (LOCA_NATE/NATN). */
  easting: number | null;
  northing: number | null;
  elements: AgsiElement[];
}

export interface AgsiElement {
  elementId: string;
  elementName: string;
  description: string;
  /** GEOL_GEOL / GEOL_LEG code, used as the AGSi unit reference. */
  unitKey: string;
  geometry: {
    type: "OneDimensionalLayer";
    /** Depth-from-surface, metres. */
    topDepth: number;
    baseDepth: number;
    thickness: number;
    /** Optional reduced levels when LOCA_GL is known. */
    topRL: number | null;
    baseRL: number | null;
  };
  /** Pointer back to the source AGS row so importers can re-resolve. */
  observation: {
    agsGroup: "GEOL";
    rowIndex: number;
    locaId: string;
  };
}

interface ExportOptions {
  /** Override the default ISO timestamp (mostly useful for snapshot tests). */
  generatedAt?: string;
  /** Override the project name; defaults to PROJ_NAME. */
  projectNameOverride?: string;
  /** Generator version label, defaults to `0.1.0`. */
  generatorVersion?: string;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Build the AGSi document. Pass a precomputed ProjectSummary if you already
 * have one (it's reused, not recomputed); otherwise it's derived here.
 */
export function toAgsi(
  file: AgsFile,
  options: ExportOptions = {},
  summary: ProjectSummary = buildProjectSummary(file),
): AgsiExportDocument {
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const geologicalUnits: AgsiGeologicalUnit[] = summary.units.map((u, ix) => ({
    unitId: `unit-${ix}`,
    unitCode: u.code,
    unitName: u.code,
    description: u.description,
    occurrences: u.occurrences,
    totalThicknessM: round(u.totalThicknessM, 3),
    meanThicknessM: round(u.meanThicknessM, 3),
    inHoles: u.inHoles,
  }));

  // Build per-borehole modelInstances by walking GEOL rows.
  const geolGroup = file.groups["GEOL"];
  const modelInstances: AgsiModelInstance[] = summary.schedule.map((hole) => {
    const elements: AgsiElement[] = [];
    if (geolGroup) {
      for (let i = 0; i < geolGroup.rows.length; i++) {
        const r = geolGroup.rows[i]!;
        if (str(r["LOCA_ID"]) !== hole.locaId) continue;
        const topDepth = num(r["GEOL_TOP"]);
        const baseDepth = num(r["GEOL_BASE"]);
        if (topDepth === null || baseDepth === null) continue;
        const code = str(r["GEOL_GEOL"]) || str(r["GEOL_LEG"]) || "(none)";
        elements.push({
          elementId: `${hole.locaId}-l${i}`,
          elementName: `${hole.locaId} ${code} ${topDepth.toFixed(2)}–${baseDepth.toFixed(2)} m`,
          description: str(r["GEOL_DESC"]),
          unitKey: code,
          geometry: {
            type: "OneDimensionalLayer",
            topDepth: round(topDepth, 3),
            baseDepth: round(baseDepth, 3),
            thickness: round(Math.max(0, baseDepth - topDepth), 3),
            topRL: hole.groundLevel === null ? null : round(hole.groundLevel - topDepth, 3),
            baseRL: hole.groundLevel === null ? null : round(hole.groundLevel - baseDepth, 3),
          },
          observation: {
            agsGroup: "GEOL",
            rowIndex: i,
            locaId: hole.locaId,
          },
        });
      }
    }

    return {
      modelInstanceId: `mi-${hole.locaId}`,
      modelType: "OneDimensional",
      locaId: hole.locaId,
      modelInstanceName: hole.locaId,
      verticalDatum: hole.groundLevel === null ? "BGL" : "mAOD",
      groundLevel: hole.groundLevel,
      totalDepth: round(hole.depthM, 3),
      easting: hole.easting,
      northing: hole.northing,
      elements,
    };
  });

  return {
    $schema: AGSI_SCHEMA,
    agsiVersion: AGSI_VERSION,
    generator: {
      name: "GeoFlow",
      package: "@geoflow/core",
      version: options.generatorVersion ?? "0.1.0",
    },
    generatedAt,
    project: {
      projectId: summary.project.projId,
      projectName: options.projectNameOverride ?? summary.project.projName,
      description: summary.project.projName,
      location: summary.project.projLoc,
      client: summary.project.projClnt,
      informationSources: summary.schedule.map((h) => ({ locaId: h.locaId })),
    },
    geologicalUnits,
    modelInstances,
  };
}

export function toAgsiJson(file: AgsFile, options: ExportOptions = {}): string {
  return JSON.stringify(toAgsi(file, options), null, 2);
}

function round(n: number, dp: number): number {
  if (!Number.isFinite(n)) return 0;
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}
