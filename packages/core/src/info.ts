import { Option } from "effect";
import { decodeBytes, parseStr } from "./ags/parser.js";
import type { Diagnostic } from "./diagnostics.js";
import type { AgsFile, AgsRow } from "./model.js";

export interface InfoSummary {
  file: string;
  agsVersion?: string;
  groups: number;
  rows: number;
  locations?: number;
  project?: string;
  depthRange?: {
    min: number;
    max: number;
  };
  diagnostics: number;
}

export function summarizeInfo(text: string, file: string): InfoSummary {
  const parsed = parseStr(text);
  return summarizeParsedInfo(parsed.file, parsed.diagnostics, file);
}

export function summarizeInfoBytes(bytes: Uint8Array, file: string): InfoSummary {
  return summarizeInfo(decodeBytes(bytes), file);
}

export function summarizeParsedInfo(file: AgsFile, diagnostics: readonly Diagnostic[], sourcePath: string): InfoSummary {
  const rows = Object.values(file.groups).reduce((count, group) => count + group.rows.length, 0);
  const locations = file.groups.LOCA?.rows.length;
  const project = textField(file.groups.PROJ?.rows[0], "PROJ_NAME");
  const depthRange = computeDepthRange(file);
  const agsVersion = Option.getOrUndefined(file.ags_version);

  return {
    file: sourcePath,
    groups: Object.keys(file.groups).length,
    rows,
    diagnostics: diagnostics.length,
    ...(locations === undefined ? {} : { locations }),
    ...(agsVersion === undefined ? {} : { agsVersion }),
    ...(project === null ? {} : { project }),
    ...(depthRange === null ? {} : { depthRange }),
  };
}

export function renderInfo(summary: InfoSummary): string {
  const lines = [`file: ${summary.file}`];
  if (summary.agsVersion !== undefined) {
    lines.push(`ags version: ${summary.agsVersion}`);
  }
  lines.push(`groups: ${summary.groups}`);
  lines.push(`rows: ${summary.rows}`);
  if (summary.locations !== undefined) {
    lines.push(`locations: ${summary.locations}`);
  }
  if (summary.project !== undefined) {
    lines.push(`project: ${summary.project}`);
  }
  if (summary.depthRange !== undefined) {
    lines.push(`depth range: ${formatNumber(summary.depthRange.min)}..${formatNumber(summary.depthRange.max)} m`);
  }
  if (summary.diagnostics > 0) {
    lines.push(`diagnostics: ${summary.diagnostics}`);
  }
  return `${lines.join("\n")}\n`;
}

function textField(row: AgsRow | undefined, heading: string): string | null {
  if (!row) {
    return null;
  }
  const value = row[heading];
  return typeof value === "string" ? value : null;
}

function computeDepthRange(file: AgsFile): { min: number; max: number } | null {
  const geol = file.groups.GEOL;
  if (!geol) {
    return null;
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const row of geol.rows) {
    for (const heading of ["GEOL_TOP", "GEOL_BASE"]) {
      const value = row[heading];
      if (typeof value === "number" && Number.isFinite(value)) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }

  return { min, max };
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return `${value}`;
  }
  return `${value}`;
}
