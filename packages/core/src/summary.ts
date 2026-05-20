/**
 * Project-level dashboard summary — a single object that aggregates the
 * high-value metrics the user wants on first sight: project metadata,
 * borehole / sample / test counts, depth distribution, geological unit
 * thicknesses, and a per-hole schedule.
 *
 * Used by the CLI `stats` command and the web app Overview tab.
 */

import type { AgsFile, AgsRow } from "./model.js";

export interface ProjectMeta {
  projId: string;
  projName: string;
  projLoc: string;
  projClnt: string;
  projContr: string;
  projEng: string;
}

export interface HoleScheduleEntry {
  locaId: string;
  type: string;
  status: string;
  depthM: number;
  groundLevel: number | null;
  easting: number | null;
  northing: number | null;
  startDate: string;
  endDate: string;
  method: string;
}

export interface UnitSummaryEntry {
  /** GEOL_GEOL / GEOL_LEG code, or "(none)" when the field is empty. */
  code: string;
  /** First non-empty GEOL_DESC encountered for this code. */
  description: string;
  occurrences: number;
  totalThicknessM: number;
  meanThicknessM: number;
  minThicknessM: number;
  maxThicknessM: number;
  inHoles: number;
}

export interface DepthDistribution {
  totalMetres: number;
  meanDepthM: number;
  medianDepthM: number;
  minDepthM: number;
  maxDepthM: number;
}

export interface ProjectSummary {
  project: ProjectMeta;
  agsVersion: string | null;
  totals: {
    groups: number;
    boreholes: number;
    samples: number;
    sptTests: number;
    waterStrikes: number;
    strata: number;
  };
  depth: DepthDistribution;
  holeTypes: Record<string, number>;
  /** Counts of all groups present, ordered by row count desc. */
  groupRowCounts: Array<{ group: string; rows: number; headings: number }>;
  schedule: HoleScheduleEntry[];
  units: UnitSummaryEntry[];
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(row: AgsRow | undefined, key: string): string {
  if (!row) return "";
  const v = row[key];
  return v == null ? "" : String(v).trim();
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function buildProjectSummary(file: AgsFile): ProjectSummary {
  const projRow = file.groups["PROJ"]?.rows[0];
  const locaRows = file.groups["LOCA"]?.rows ?? [];
  const geolRows = file.groups["GEOL"]?.rows ?? [];
  const sampRows = file.groups["SAMP"]?.rows ?? [];
  const isptRows = file.groups["ISPT"]?.rows ?? [];
  const wstkRows = file.groups["WSTK"]?.rows ?? [];

  // ── Project metadata ──────────────────────────────────────────────────────
  const project: ProjectMeta = {
    projId:    str(projRow, "PROJ_ID"),
    projName:  str(projRow, "PROJ_NAME"),
    projLoc:   str(projRow, "PROJ_LOC"),
    projClnt:  str(projRow, "PROJ_CLNT"),
    projContr: str(projRow, "PROJ_CONT") || str(projRow, "PROJ_CONTRACTOR"),
    projEng:   str(projRow, "PROJ_ENG"),
  };

  // ── Depths ────────────────────────────────────────────────────────────────
  const depths: number[] = [];
  for (const r of locaRows) {
    const d = num(r["LOCA_FDEP"]);
    if (d !== null && d > 0) depths.push(d);
  }
  const totalMetres = depths.reduce((a, b) => a + b, 0);
  const depth: DepthDistribution = {
    totalMetres,
    meanDepthM: depths.length ? totalMetres / depths.length : 0,
    medianDepthM: median(depths),
    minDepthM: depths.length ? Math.min(...depths) : 0,
    maxDepthM: depths.length ? Math.max(...depths) : 0,
  };

  // ── Hole types ────────────────────────────────────────────────────────────
  const holeTypes: Record<string, number> = {};
  for (const r of locaRows) {
    const t = str(r, "LOCA_TYPE") || "(unspecified)";
    holeTypes[t] = (holeTypes[t] ?? 0) + 1;
  }

  // ── Schedule ──────────────────────────────────────────────────────────────
  const hdphByLoca = new Map<string, AgsRow>();
  for (const r of file.groups["HDPH"]?.rows ?? []) {
    const id = str(r, "LOCA_ID");
    if (id) hdphByLoca.set(id, r);
  }

  const schedule: HoleScheduleEntry[] = locaRows.map((r) => {
    const id = str(r, "LOCA_ID");
    const hdph = hdphByLoca.get(id);
    return {
      locaId:       id,
      type:         str(r, "LOCA_TYPE"),
      status:       str(r, "LOCA_STAT"),
      depthM:       num(r["LOCA_FDEP"]) ?? 0,
      groundLevel:  num(r["LOCA_GL"]),
      easting:      num(r["LOCA_NATE"]),
      northing:     num(r["LOCA_NATN"]),
      startDate:    str(r, "LOCA_STAR"),
      endDate:      str(r, "LOCA_ENDD"),
      method:       str(hdph, "HDPH_METH") || str(r, "LOCA_METH"),
    };
  });

  // ── Geological units ──────────────────────────────────────────────────────
  const unitMap = new Map<string, {
    code: string;
    description: string;
    thicknesses: number[];
    holes: Set<string>;
  }>();
  for (const r of geolRows) {
    const code = str(r, "GEOL_GEOL") || str(r, "GEOL_LEG") || "(none)";
    const top = num(r["GEOL_TOP"]);
    const base = num(r["GEOL_BASE"]);
    if (top === null || base === null) continue;
    const thickness = Math.max(0, base - top);
    const desc = str(r, "GEOL_DESC");
    const loca = str(r, "LOCA_ID");

    let entry = unitMap.get(code);
    if (!entry) {
      entry = { code, description: desc, thicknesses: [], holes: new Set() };
      unitMap.set(code, entry);
    } else if (!entry.description && desc) {
      entry.description = desc;
    }
    entry.thicknesses.push(thickness);
    if (loca) entry.holes.add(loca);
  }

  const units: UnitSummaryEntry[] = [...unitMap.values()]
    .map((e) => {
      const total = e.thicknesses.reduce((a, b) => a + b, 0);
      return {
        code: e.code,
        description: e.description,
        occurrences: e.thicknesses.length,
        totalThicknessM: total,
        meanThicknessM: e.thicknesses.length ? total / e.thicknesses.length : 0,
        minThicknessM: e.thicknesses.length ? Math.min(...e.thicknesses) : 0,
        maxThicknessM: e.thicknesses.length ? Math.max(...e.thicknesses) : 0,
        inHoles: e.holes.size,
      };
    })
    .sort((a, b) => b.totalThicknessM - a.totalThicknessM);

  // ── Group inventory ───────────────────────────────────────────────────────
  const groupRowCounts = Object.entries(file.groups)
    .map(([name, g]) => ({ group: name, rows: g.rows.length, headings: g.headings.length }))
    .sort((a, b) => b.rows - a.rows);

  // ── AGS version ───────────────────────────────────────────────────────────
  const versionOpt = file.ags_version as { _tag: string; value?: string };
  const agsVersion = versionOpt._tag === "Some" ? (versionOpt.value ?? null) : null;

  return {
    project,
    agsVersion,
    totals: {
      groups: Object.keys(file.groups).length,
      boreholes: locaRows.length,
      samples: sampRows.length,
      sptTests: isptRows.length,
      waterStrikes: wstkRows.length,
      strata: geolRows.length,
    },
    depth,
    holeTypes,
    groupRowCounts,
    schedule,
    units,
  };
}
