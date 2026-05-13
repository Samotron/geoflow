import Jexl from "jexl";
import { parse as parseYaml } from "yaml";
import {
  AgsFile,
  AgsRow,
  AgsTypeFunctions,
  AgsValue,
} from "@geoflow/core";

export const PACKAGE_NAME = "@geoflow/rules-engine";

// ── Pack schema ───────────────────────────────────────────────────────────────

export interface CodelistDef {
  inline?: string[];
}

export interface RuleDef {
  id: string;
  description?: string;
  severity: "error" | "warning" | "info";
  /** "file" | "row" (default) | "group:HEADING" */
  scope?: string;
  /** Filter expression: rule is skipped if this evaluates to false */
  when?: string;
  /** Main expression: a violation is raised when this evaluates to false */
  expr: string;
  message: string;
}

export interface Pack {
  version: number;
  name?: string;
  pack_version?: string;
  codelists?: Record<string, CodelistDef>;
  rules: RuleDef[];
}

// ── Output types ──────────────────────────────────────────────────────────────

export interface PackDiagLocation {
  file: string | null;
  line: number | null;
  column: number | null;
  group: string | null;
  row_index: number | null;
}

export interface PackDiagnostic {
  rule_id: string;
  severity: string;
  message: string;
  location: PackDiagLocation;
}

// ── JEXL instance ─────────────────────────────────────────────────────────────

const jexl = new Jexl.Jexl();

// `value in array` binary operator (precedence 20, same as ==)
jexl.addBinaryOp("in", 20, (left: unknown, right: unknown): boolean => {
  if (Array.isArray(right)) return (right as unknown[]).includes(left);
  if (typeof right === "string" && typeof left === "string") return right.includes(left);
  return false;
});

// ── Module-level evaluation context (set before each eval, reset after) ───────

let _ctx: EvalContext | null = null;

interface EvalContext {
  file: AgsFile;
  codelists: Record<string, string[]>;
  groupName: string;
}

// ── Host functions ────────────────────────────────────────────────────────────

jexl.addFunction("has_group", (name: string): boolean => {
  return _ctx !== null && name in _ctx.file.groups;
});

jexl.addFunction("group_size", (name: string): number => {
  if (_ctx === null) return 0;
  return _ctx.file.groups[name]?.rows.length ?? 0;
});

jexl.addFunction("group_has_heading", (groupName: string, headingName: string): boolean => {
  if (_ctx === null) return false;
  const group = _ctx.file.groups[groupName];
  return group !== undefined && group.headings.some((h) => h.name === headingName);
});

jexl.addFunction("exists_in", (groupName: string, headingName: string, value: AgsValue): boolean => {
  if (_ctx === null) return false;
  const group = _ctx.file.groups[groupName];
  if (group === undefined) return false;
  const sv = value === null ? "" : String(value);
  return group.rows.some((row) => {
    const rv = row[headingName] ?? null;
    return rv !== null && String(rv) === sv;
  });
});

jexl.addFunction("codelist", (id: string): string[] => {
  if (_ctx === null) return [];
  return _ctx.codelists[id] ?? [];
});

jexl.addFunction("pluck", (rows: AgsRow[], field: string): AgsValue[] => {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => r[field] ?? null);
});

jexl.addFunction("is_monotonic", (values: unknown[]): boolean => {
  if (!Array.isArray(values) || values.length < 2) return true;
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    if (typeof prev !== "number" || typeof curr !== "number") {
      const ps = prev === null ? "" : String(prev);
      const cs = curr === null ? "" : String(curr);
      if (cs <= ps) return false;
    } else {
      if (curr <= prev) return false;
    }
  }
  return true;
});

jexl.addFunction("is_valid_ags_type", (typeStr: string): boolean => {
  if (typeof typeStr !== "string") return false;
  try {
    const parsed = AgsTypeFunctions.parse(typeStr);
    if (typeof parsed === "string") return true;
    return parsed._tag !== "Other";
  } catch {
    return false;
  }
});

jexl.addFunction("is_numeric_ags_type", (typeStr: string): boolean => {
  if (typeof typeStr !== "string") return false;
  try {
    const parsed = AgsTypeFunctions.parse(typeStr);
    return AgsTypeFunctions.isNumeric(parsed);
  } catch {
    return false;
  }
});

jexl.addFunction("has_trailing_whitespace", (row: AgsRow): boolean => {
  if (typeof row !== "object" || row === null) return false;
  return Object.values(row).some(
    (v) => typeof v === "string" && v !== v.trimEnd()
  );
});

// File-level aggregate checks (used by the AGS standard pack)
jexl.addFunction("all_groups_have_headings", (): boolean => {
  if (_ctx === null) return true;
  return Object.values(_ctx.file.groups).every((g) => g.headings.length > 0);
});

jexl.addFunction("all_numeric_headings_have_unit", (): boolean => {
  if (_ctx === null) return true;
  for (const group of Object.values(_ctx.file.groups)) {
    for (const heading of group.headings) {
      if (AgsTypeFunctions.isNumeric(heading.data_type) && heading.unit.trim() === "") {
        return false;
      }
    }
  }
  return true;
});

jexl.addFunction("all_headings_have_type", (): boolean => {
  if (_ctx === null) return true;
  for (const group of Object.values(_ctx.file.groups)) {
    for (const heading of group.headings) {
      const ts = AgsTypeFunctions.toString(heading.data_type);
      if (ts.trim() === "") return false;
    }
  }
  return true;
});

jexl.addFunction("all_headings_have_valid_type", (): boolean => {
  if (_ctx === null) return true;
  for (const group of Object.values(_ctx.file.groups)) {
    for (const heading of group.headings) {
      try {
        const parsed = heading.data_type;
        if (typeof parsed === "object" && "_tag" in parsed && parsed._tag === "Other") {
          return false;
        }
      } catch {
        return false;
      }
    }
  }
  return true;
});

// ── Message template substitution ────────────────────────────────────────────

function renderMessage(template: string, evalCtx: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, expr: string) => {
    try {
      const val = jexl.evalSync(expr.trim(), evalCtx);
      return val === null || val === undefined ? "" : String(val);
    } catch {
      return `{${expr}}`;
    }
  });
}

// ── Codelist resolution ───────────────────────────────────────────────────────

function resolveCodelists(pack: Pack): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!pack.codelists) return result;
  for (const [id, def] of Object.entries(pack.codelists)) {
    if (def.inline) {
      result[id] = def.inline;
    }
  }
  return result;
}

// ── Pack loader ───────────────────────────────────────────────────────────────

export function loadPack(yamlText: string): Pack {
  const raw = parseYaml(yamlText) as Pack;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Invalid rule pack: must be a YAML object");
  }
  if (!Array.isArray(raw.rules)) {
    throw new Error("Invalid rule pack: 'rules' must be an array");
  }
  return raw;
}

// ── Core evaluator ────────────────────────────────────────────────────────────

function makeLocation(
  groupName: string | null,
  rowIndex: number | null
): PackDiagLocation {
  return { file: null, line: null, column: null, group: groupName, row_index: rowIndex };
}

function evalExpr(expr: string, ctx: Record<string, unknown>): boolean {
  const result = jexl.evalSync(expr, ctx);
  return Boolean(result);
}

function filterExpr(expr: string, ctx: Record<string, unknown>): boolean {
  try {
    return Boolean(jexl.evalSync(expr, ctx));
  } catch {
    return false;
  }
}

export function evaluatePack(pack: Pack, file: AgsFile): PackDiagnostic[] {
  const codelists = resolveCodelists(pack);
  const diagnostics: PackDiagnostic[] = [];

  // Set module-level context for host functions
  _ctx = { file, codelists, groupName: "" };

  try {
    for (const rule of pack.rules) {
      const scopeStr = rule.scope ?? "row";

      if (scopeStr === "file") {
        // File scope: evaluate once
        const ctx: Record<string, unknown> = { file, groups_meta: buildGroupsMeta(file) };
        if (rule.when && !filterExpr(rule.when, ctx)) continue;
        let passes = true;
        try { passes = evalExpr(rule.expr, ctx); } catch { passes = false; }
        if (!passes) {
          diagnostics.push({
            rule_id: rule.id,
            severity: rule.severity,
            message: renderMessage(rule.message, ctx),
            location: makeLocation(null, null),
          });
        }
        continue;
      }

      if (scopeStr.startsWith("group:")) {
        // Group scope: group rows by key heading, evaluate once per partition
        const keyHeading = scopeStr.slice("group:".length);
        evaluateGroupScope(rule, file, keyHeading, codelists, diagnostics);
        continue;
      }

      // Row scope (default): evaluate once per row per group
      for (const [groupName, group] of Object.entries(file.groups)) {
        _ctx.groupName = groupName;
        for (let rowIdx = 0; rowIdx < group.rows.length; rowIdx++) {
          const row = group.rows[rowIdx]!;
          const ctx: Record<string, unknown> = {
            row,
            group: groupName,
            rows: group.rows,
            file,
          };
          // Apply `when` filter
          if (rule.when && !filterExpr(rule.when, ctx)) continue;
          let passes = true;
          try { passes = evalExpr(rule.expr, ctx); } catch { passes = false; }
          if (!passes) {
            diagnostics.push({
              rule_id: rule.id,
              severity: rule.severity,
              message: renderMessage(rule.message, ctx),
              location: makeLocation(groupName, rowIdx),
            });
          }
        }
      }
    }
  } finally {
    _ctx = null;
  }

  return diagnostics;
}

function evaluateGroupScope(
  rule: RuleDef,
  file: AgsFile,
  keyHeading: string,
  codelists: Record<string, string[]>,
  diagnostics: PackDiagnostic[]
): void {
  // Find target groups (filtered by `when: "group == 'X'"`)
  for (const [groupName, group] of Object.entries(file.groups)) {
    // Check `when` filter at group level
    if (rule.when) {
      const checkCtx: Record<string, unknown> = { group: groupName, row: {}, rows: [] };
      if (!filterExpr(rule.when, checkCtx)) continue;
    }

    // Partition rows by keyHeading value
    const partitions = new Map<string, { rows: AgsRow[]; keyRow: AgsRow }>();
    for (const row of group.rows) {
      const keyVal = row[keyHeading] ?? null;
      const keyStr = keyVal === null ? "__null__" : String(keyVal);
      if (!partitions.has(keyStr)) {
        const keyRow: AgsRow = {};
        keyRow[keyHeading] = keyVal;
        partitions.set(keyStr, { rows: [], keyRow });
      }
      partitions.get(keyStr)!.rows.push(row);
    }

    // Evaluate rule for each partition
    for (const { rows, keyRow } of partitions.values()) {
      const ctx: Record<string, unknown> = {
        group: groupName,
        rows,
        key: keyRow,
        row: rows[0] ?? {},
        file,
      };
      let passes = true;
      try { passes = evalExpr(rule.expr, ctx); } catch { passes = false; }
      if (!passes) {
        diagnostics.push({
          rule_id: rule.id,
          severity: rule.severity,
          message: renderMessage(rule.message, ctx),
          location: makeLocation(groupName, null),
        });
      }
    }
  }
}

function buildGroupsMeta(file: AgsFile): Array<{ name: string; headings: Array<{ name: string; unit: string; type: string }> }> {
  return Object.entries(file.groups).map(([name, group]) => ({
    name,
    headings: group.headings.map((h) => ({
      name: h.name,
      unit: h.unit,
      type: AgsTypeFunctions.toString(h.data_type),
    })),
  }));
}

// ── Top-level convenience function ────────────────────────────────────────────

export function evaluatePackYaml(yamlText: string, file: AgsFile): PackDiagnostic[] {
  const pack = loadPack(yamlText);
  return evaluatePack(pack, file);
}
