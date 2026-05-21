import { serialize } from "./ags/serializer.js";
import { decodeBytes, parseStr } from "./ags/parser.js";
import type { AgsFile, AgsGroup, AgsValue } from "./model.js";
import { AgsTypeFunctions } from "./model.js";
import { Option } from "effect";

export type FixChangeKind = "cell_value" | "heading_unit" | "heading_name" | "group_added";

export interface FixChange {
  fix: string;
  group: string;
  row_index?: number;
  heading?: string;
  before: string;
  after: string;
  kind: FixChangeKind;
}

export interface FixLog {
  changes: FixChange[];
}

export interface FixInspection {
  findings: string[];
  is_empty(): boolean;
}

export interface FixResult {
  applied: string[];
  output: string;
  log: FixLog;
}

function agsValueDisplay(v: AgsValue): string {
  if (v === null) return "";
  if (typeof v === "number") {
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(Math.trunc(v));
    return String(v);
  }
  if (typeof v === "boolean") return v ? "Y" : "N";
  return v;
}

// ── NormalizeWhitespace ───────────────────────────────────────────────────────

function applyNormalizeWhitespace(file: AgsFile): FixChange[] {
  const changes: FixChange[] = [];
  for (const [groupName, group] of Object.entries(file.groups)) {
    for (let rowIdx = 0; rowIdx < group.rows.length; rowIdx++) {
      const row = group.rows[rowIdx]!;
      for (const [headingName, value] of Object.entries(row)) {
        if (typeof value === "string") {
          const trimmed = value.trimEnd();
          if (trimmed.length !== value.length) {
            changes.push({
              fix: "normalize-whitespace",
              group: groupName,
              row_index: rowIdx,
              heading: headingName,
              before: value,
              after: trimmed,
              kind: "cell_value",
            });
            row[headingName] = trimmed;
          }
        }
      }
    }
  }
  return changes;
}

// ── NormalizeUnits ────────────────────────────────────────────────────────────

const UNIT_CANONICAL: Record<string, string> = {
  "kN/m2": "kPa", "kn/m2": "kPa", "KN/m2": "kPa", "kN/m²": "kPa",
  "MN/m2": "MPa", "mn/m2": "MPa", "MN/m²": "MPa",
  "N/mm2": "MPa", "n/mm2": "MPa", "N/mm²": "MPa",
  "t/m2": "kPa", "T/m2": "kPa", "t/m²": "kPa", "T/m²": "kPa",
  "kg/m3": "Mg/m3", "kg/m³": "Mg/m3", "KG/m3": "Mg/m3",
  "g/cm3": "Mg/m3", "g/cc": "Mg/m3", "g/cm³": "Mg/m3",
  "degrees": "deg", "Degrees": "deg", "°": "deg", "Deg": "deg",
  "percent": "%", "pct": "%", "PCT": "%", "Percent": "%",
};

function canonicalUnit(raw: string): string | null {
  const s = raw.trim();
  if (UNIT_CANONICAL[s]) return UNIT_CANONICAL[s]!;
  return null;
}

function applyNormalizeUnits(file: AgsFile): FixChange[] {
  const changes: FixChange[] = [];
  for (const [groupName, group] of Object.entries(file.groups)) {
    for (const heading of group.headings) {
      const canon = canonicalUnit(heading.unit);
      if (canon !== null && canon !== heading.unit) {
        changes.push({
          fix: "normalize-units",
          group: groupName,
          heading: heading.name,
          before: heading.unit,
          after: canon,
          kind: "heading_unit",
        });
        heading.unit = canon;
      }
    }
  }
  return changes;
}

// ── NormalizeYnValues ─────────────────────────────────────────────────────────

function ynCanonical(raw: string): "Y" | "N" | null {
  switch (raw.trim().toUpperCase()) {
    case "Y": case "YES": case "TRUE": case "1": return "Y";
    case "N": case "NO": case "FALSE": case "0": return "N";
    default: return null;
  }
}

function applyNormalizeYnValues(file: AgsFile): FixChange[] {
  const changes: FixChange[] = [];
  for (const [groupName, group] of Object.entries(file.groups)) {
    const ynHeadings = group.headings
      .filter((h) => h.data_type === "YN")
      .map((h) => h.name);
    if (ynHeadings.length === 0) continue;

    for (let rowIdx = 0; rowIdx < group.rows.length; rowIdx++) {
      const row = group.rows[rowIdx]!;
      for (const headingName of ynHeadings) {
        const val = row[headingName];
        if (val === undefined) continue;
        const before = agsValueDisplay(val);
        let canon: "Y" | "N" | null = null;
        if (typeof val === "string") {
          canon = ynCanonical(val);
        } else if (typeof val === "boolean") {
          canon = val ? "Y" : "N";
        }
        if (canon !== null && before !== canon) {
          changes.push({
            fix: "normalize-yn-values",
            group: groupName,
            row_index: rowIdx,
            heading: headingName,
            before,
            after: canon,
            kind: "cell_value",
          });
          row[headingName] = canon;
        }
      }
    }
  }
  return changes;
}

// ── NormalizeDateFields ───────────────────────────────────────────────────────

function reformatDate(s: string): string | null {
  const trimmed = s.trim();
  if (trimmed.length !== 10) return null;

  // Already ISO 8601 YYYY-MM-DD
  if (trimmed[4] === "-" && trimmed[7] === "-" && /^\d{4}/.test(trimmed)) {
    return null;
  }

  const sep2 = trimmed[2];
  // DD/MM/YYYY or DD-MM-YYYY
  if (sep2 === "/" || sep2 === "-") {
    const day = parseInt(trimmed.slice(0, 2), 10);
    const month = parseInt(trimmed.slice(3, 5), 10);
    const year = parseInt(trimmed.slice(6, 10), 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1800) {
      return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }

  // YYYY/MM/DD
  if (trimmed[4] === "/") {
    const year = parseInt(trimmed.slice(0, 4), 10);
    const month = parseInt(trimmed.slice(5, 7), 10);
    const day = parseInt(trimmed.slice(8, 10), 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1800) {
      return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }

  return null;
}

function applyNormalizeDateFields(file: AgsFile): FixChange[] {
  const changes: FixChange[] = [];
  for (const [groupName, group] of Object.entries(file.groups)) {
    const dtHeadings = group.headings
      .filter((h) => h.data_type === "DT")
      .map((h) => h.name);
    if (dtHeadings.length === 0) continue;

    for (let rowIdx = 0; rowIdx < group.rows.length; rowIdx++) {
      const row = group.rows[rowIdx]!;
      for (const headingName of dtHeadings) {
        const val = row[headingName];
        if (typeof val !== "string") continue;
        const normalized = reformatDate(val);
        if (normalized !== null) {
          changes.push({
            fix: "normalize-date-fields",
            group: groupName,
            row_index: rowIdx,
            heading: headingName,
            before: val,
            after: normalized,
            kind: "cell_value",
          });
          row[headingName] = normalized;
        }
      }
    }
  }
  return changes;
}

// ── UppercaseHeadingNames ─────────────────────────────────────────────────────

function applyUppercaseHeadingNames(file: AgsFile): FixChange[] {
  const changes: FixChange[] = [];
  for (const [groupName, group] of Object.entries(file.groups)) {
    const renames: Array<[string, string]> = [];

    for (const heading of group.headings) {
      const upper = heading.name.toUpperCase();
      if (upper !== heading.name) {
        renames.push([heading.name, upper]);
        changes.push({
          fix: "uppercase-heading-names",
          group: groupName,
          before: heading.name,
          after: upper,
          kind: "heading_name",
        });
        heading.name = upper;
      }
    }

    if (renames.length > 0) {
      for (const row of group.rows) {
        for (const [oldName, newName] of renames) {
          if (Object.prototype.hasOwnProperty.call(row, oldName)) {
            const val = row[oldName]!;
            delete row[oldName];
            row[newName] = val;
          }
        }
      }
    }
  }
  return changes;
}

// ── CoerceNumericFields ───────────────────────────────────────────────────────

function applyCoerceNumericFields(file: AgsFile): FixChange[] {
  const changes: FixChange[] = [];
  for (const [groupName, group] of Object.entries(file.groups)) {
    const numericHeadings = group.headings
      .filter((h) => AgsTypeFunctions.isNumeric(h.data_type))
      .map((h) => h.name);
    if (numericHeadings.length === 0) continue;

    for (let rowIdx = 0; rowIdx < group.rows.length; rowIdx++) {
      const row = group.rows[rowIdx]!;
      for (const headingName of numericHeadings) {
        const val = row[headingName];
        if (typeof val !== "string" || val.length === 0) continue;
        const parsed = parseFloat(val.trim());
        if (!isNaN(parsed)) {
          changes.push({
            fix: "coerce-numeric-fields",
            group: groupName,
            row_index: rowIdx,
            heading: headingName,
            before: val,
            after: agsValueDisplay(parsed),
            kind: "cell_value",
          });
          row[headingName] = parsed;
        }
      }
    }
  }
  return changes;
}

// ── StripControlChars ─────────────────────────────────────────────────────────

function stripControl(s: string): string | null {
  // Remove ASCII control chars 0x00–0x1F except TAB (0x09), LF (0x0A), CR (0x0D)
  const cleaned = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  return cleaned.length !== s.length ? cleaned : null;
}

function applyStripControlChars(file: AgsFile): FixChange[] {
  const changes: FixChange[] = [];
  for (const [groupName, group] of Object.entries(file.groups)) {
    for (let rowIdx = 0; rowIdx < group.rows.length; rowIdx++) {
      const row = group.rows[rowIdx]!;
      for (const [headingName, val] of Object.entries(row)) {
        if (typeof val === "string") {
          const cleaned = stripControl(val);
          if (cleaned !== null) {
            changes.push({
              fix: "strip-control-chars",
              group: groupName,
              row_index: rowIdx,
              heading: headingName,
              before: val,
              after: cleaned,
              kind: "cell_value",
            });
            row[headingName] = cleaned;
          }
        }
      }
    }
  }
  return changes;
}

// ── PopulateTranGroup ─────────────────────────────────────────────────────────

function applyPopulateTranGroup(file: AgsFile): FixChange[] {
  if (Object.prototype.hasOwnProperty.call(file.groups, "TRAN")) {
    return [];
  }

  const tranGroup: AgsGroup = {
    name: "TRAN",
    headings: [
      { name: "TRAN_AGS", unit: "", data_type: "X" },
      { name: "TRAN_RCON", unit: "", data_type: "X" },
      { name: "TRAN_DLIM", unit: "", data_type: "X" },
    ],
    rows: [{ TRAN_AGS: "4.1", TRAN_RCON: "+", TRAN_DLIM: ":" }],
    source_line: Option.none(),
  };

  // Insert after PROJ if present, otherwise at position 0
  const keys = Object.keys(file.groups);
  const projIdx = keys.indexOf("PROJ");
  const insertAt = projIdx >= 0 ? projIdx + 1 : 0;

  const entries = Object.entries(file.groups);
  entries.splice(insertAt, 0, ["TRAN", tranGroup]);

  // Rebuild the groups object in correct order
  for (const key of Object.keys(file.groups)) {
    delete file.groups[key];
  }
  for (const [k, v] of entries) {
    file.groups[k] = v;
  }

  return [
    {
      fix: "populate-tran-group",
      group: "TRAN",
      before: "",
      after: "TRAN_AGS=4.1, TRAN_RCON=+, TRAN_DLIM=:",
      kind: "group_added",
    },
  ];
}

// ── Fixer pipeline ────────────────────────────────────────────────────────────

type ModelFixer = {
  name: string;
  apply: (file: AgsFile) => FixChange[];
};

const STANDARD_FIXERS: ModelFixer[] = [
  { name: "normalize-whitespace", apply: applyNormalizeWhitespace },
  { name: "normalize-units", apply: applyNormalizeUnits },
  { name: "normalize-yn-values", apply: applyNormalizeYnValues },
  { name: "normalize-date-fields", apply: applyNormalizeDateFields },
  { name: "uppercase-heading-names", apply: applyUppercaseHeadingNames },
  { name: "coerce-numeric-fields", apply: applyCoerceNumericFields },
  { name: "strip-control-chars", apply: applyStripControlChars },
  { name: "populate-tran-group", apply: applyPopulateTranGroup },
];

export function applyAllFixes(file: AgsFile): { applied: string[]; log: FixLog } {
  const allChanges: FixChange[] = [];
  const applied: string[] = [];
  for (const fixer of STANDARD_FIXERS) {
    const changes = fixer.apply(file);
    if (changes.length > 0) {
      applied.push(fixer.name);
      allChanges.push(...changes);
    }
  }
  return { applied, log: { changes: allChanges } };
}

// ── Text-level inspection ─────────────────────────────────────────────────────

export function inspectBytes(bytes: Uint8Array): FixInspection {
  const findings: string[] = [];

  // BOM detection
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    findings.push("strip-bom");
  }

  const body = (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    ? bytes.slice(3)
    : bytes;

  // Line-ending check
  let hadLoneLf = false;
  let prev = 0;
  for (const b of body) {
    if (b === 0x0a && prev !== 0x0d) {
      hadLoneLf = true;
      break;
    }
    prev = b;
  }
  if (hadLoneLf) findings.push("normalize-line-endings");

  // Decode for line-level checks
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  const lines = text.split(/\r?\n/);

  let consecutiveBlanks = 0;
  let hadDoubledBlank = false;
  let lastRowLabel: string | null = null;
  let hadTypeBeforeUnit = false;
  let hasAnyContent = false;

  for (const line of lines) {
    if (line.trim() === "") {
      consecutiveBlanks++;
      if (consecutiveBlanks >= 2) hadDoubledBlank = true;
      lastRowLabel = null;
      continue;
    }
    consecutiveBlanks = 0;
    hasAnyContent = true;

    if (line.startsWith('"GROUP"')) {
      lastRowLabel = null;
    } else if (line.startsWith('"HEADING"')) {
      lastRowLabel = "HEADING";
    } else if (line.startsWith('"UNIT"')) {
      if (lastRowLabel === "TYPE") hadTypeBeforeUnit = true;
      lastRowLabel = "UNIT";
    } else if (line.startsWith('"TYPE"')) {
      lastRowLabel = "TYPE";
    }
  }

  if (hadDoubledBlank) findings.push("dedupe-blank-lines");
  if (hadTypeBeforeUnit) findings.push("reorder-unit-type");

  // Final newline check
  if (hasAnyContent && body.length > 0 && body[body.length - 1] !== 0x0a) {
    findings.push("enforce-final-newline");
  }

  return {
    findings,
    is_empty() { return findings.length === 0; },
  };
}

// ── fixBytes ─────────────────────────────────────────────────────────────────

export function fixBytes(bytes: Uint8Array): FixResult {
  const inspection = inspectBytes(bytes);
  const originalText = decodeBytes(bytes);
  const parsed = parseStr(originalText);
  const { applied: modelApplied, log } = applyAllFixes(parsed.file);
  const output = stripNumericPadding(serialize(parsed.file));

  const textChanges: FixChange[] = inspection.findings.map((fix) => ({
    fix,
    group: "",
    before: "",
    after: "(text-level normalisation)",
    kind: "cell_value" as FixChangeKind,
  }));

  return {
    applied: [...inspection.findings, ...modelApplied],
    output,
    log: { changes: [...textChanges, ...log.changes] },
  };
}

function stripNumericPadding(text: string): string {
  return text.replace(/"(-?\d+\.\d+)"/g, (_match, value: string) => {
    const trimmed = value
      .replace(/(\.\d*?[1-9])0+$/u, "$1")
      .replace(/\.0+$/u, "");
    return `"${trimmed}"`;
  });
}
