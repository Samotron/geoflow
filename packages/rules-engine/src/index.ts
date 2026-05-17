import Jexl from "jexl";
import { parse as parseYaml } from "yaml";
import {
  AgsFile,
  AgsRow,
  AgsTypeFunctions,
  AgsValue,
} from "@geoflow/core";
import {
  CHECK_KINDS,
  defaultMessage,
  detectCheckKind,
  scopeFor,
} from "./checks.js";
import type {
  CheckDef,
  CheckKind,
  CheckScope,
  CompareOp,
} from "./checks.js";

export const PACKAGE_NAME = "@geoflow/rules-engine";

export {
  CHECK_KINDS,
  type CheckDef,
  type CheckKind,
  type CheckScope,
  type CompareOp,
};

// ── Pack schema ───────────────────────────────────────────────────────────────

export interface CodelistDef {
  inline?: string[];
}

export interface RuleDef {
  id: string;
  description?: string;
  severity: "error" | "warning" | "info";

  // Declarative form (preferred):
  /** Restrict to one or more group names. Sugar for `when: "group == 'X'"`. */
  in?: string | string[];
  /** Declarative check definition — see CheckDef. */
  check?: CheckDef;

  // Legacy escape-hatch form (still supported):
  /** "file" | "row" (default) | "group:HEADING" */
  scope?: string;
  /** JEXL filter; rule is skipped when this evaluates to false. */
  when?: string;
  /** Main JEXL expression; a violation is raised when this evaluates to false. */
  expr?: string;

  /** Optional message template. If omitted with a declarative check, a default is used. */
  message?: string;
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

// ── JEXL instance + host functions ────────────────────────────────────────────

const jexl = new Jexl.Jexl();

// `value in array | string` binary operator (same precedence as ==).
jexl.addBinaryOp("in", 20, (left: unknown, right: unknown): boolean => {
  if (Array.isArray(right)) return (right as unknown[]).includes(left);
  if (typeof right === "string" && typeof left === "string") return right.includes(left);
  return false;
});

let _ctx: EvalContext | null = null;

interface EvalContext {
  file: AgsFile;
  codelists: Record<string, string[]>;
  groupName: string;
}

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
      const parsed = heading.data_type;
      if (typeof parsed === "object" && "_tag" in parsed && parsed._tag === "Other") {
        return false;
      }
    }
  }
  return true;
});

// ── Message rendering ─────────────────────────────────────────────────────────

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
    if (def.inline) result[id] = def.inline;
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function loc(group: string | null, rowIndex: number | null): PackDiagLocation {
  return { file: null, line: null, column: null, group, row_index: rowIndex };
}

function isEmpty(v: AgsValue | undefined): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function asNumber(v: AgsValue | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function compareValues(left: AgsValue | undefined, op: CompareOp, right: AgsValue | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return true;
  const ln = asNumber(left);
  const rn = asNumber(right);
  if (ln !== null && rn !== null) {
    switch (op) {
      case "<": return ln < rn;
      case "<=": return ln <= rn;
      case "==": return ln === rn;
      case "!=": return ln !== rn;
      case ">=": return ln >= rn;
      case ">": return ln > rn;
    }
  }
  const ls = String(left);
  const rs = String(right);
  switch (op) {
    case "<": return ls < rs;
    case "<=": return ls <= rs;
    case "==": return ls === rs;
    case "!=": return ls !== rs;
    case ">=": return ls >= rs;
    case ">": return ls > rs;
  }
}

function targetGroups(file: AgsFile, inFilter: RuleDef["in"]): string[] {
  if (inFilter === undefined) return Object.keys(file.groups);
  const list = Array.isArray(inFilter) ? inFilter : [inFilter];
  return list.filter((g) => g in file.groups);
}

// ── Declarative check evaluator ──────────────────────────────────────────────

function evaluateCheck(
  rule: RuleDef,
  check: CheckDef,
  file: AgsFile,
  codelists: Record<string, string[]>,
  diagnostics: PackDiagnostic[]
): void {
  const kind = detectCheckKind(check);
  const scope: CheckScope = scopeFor(kind, check);
  const msgTemplate = rule.message ?? defaultMessage(kind, check);

  const emit = (ctx: Record<string, unknown>, group: string | null, rowIdx: number | null) => {
    diagnostics.push({
      rule_id: rule.id,
      severity: rule.severity,
      message: renderMessage(msgTemplate, ctx),
      location: loc(group, rowIdx),
    });
  };

  if (scope === "file") {
    evaluateFileCheck(rule, check, kind, file, emit);
    return;
  }

  const groups = targetGroups(file, rule.in);

  for (const groupName of groups) {
    const group = file.groups[groupName]!;
    _ctx!.groupName = groupName;

    if (scope === "row") {
      for (let rowIdx = 0; rowIdx < group.rows.length; rowIdx++) {
        const row = group.rows[rowIdx]!;
        if (rule.when && !filterExpr(rule.when, { row, group: groupName, rows: group.rows, file })) continue;
        evaluateRowCheck(check, kind, codelists, row, groupName, group.rows, rowIdx, file, emit);
      }
    } else if (scope === "group") {
      evaluateGroupCheck(check, kind, group.rows, groupName, file, emit);
    } else {
      // partition
      const partitionBy = (check as { monotonic: { partition_by: string } }).monotonic.partition_by;
      const partitions = new Map<string, AgsRow[]>();
      for (const row of group.rows) {
        const k = row[partitionBy];
        const key = k === null || k === undefined ? "__null__" : String(k);
        if (!partitions.has(key)) partitions.set(key, []);
        partitions.get(key)!.push(row);
      }
      for (const [partKey, rows] of partitions) {
        evaluatePartitionCheck(check, kind, rows, groupName, partKey, partitionBy, file, emit);
      }
    }
  }
}

function evaluateRowCheck(
  check: CheckDef,
  kind: CheckKind,
  codelists: Record<string, string[]>,
  row: AgsRow,
  groupName: string,
  rows: AgsRow[],
  rowIdx: number,
  file: AgsFile,
  emit: (ctx: Record<string, unknown>, group: string | null, rowIdx: number | null) => void
): void {
  switch (kind) {
    case "required": {
      const fields = (check as { required: string[] }).required;
      for (const field of fields) {
        if (isEmpty(row[field])) {
          emit({ row, rows, group: groupName, file, field, value: row[field] ?? "" }, groupName, rowIdx);
        }
      }
      return;
    }
    case "one_of": {
      const c = (check as { one_of: { field: string; codelist?: string; values?: AgsValue[] } }).one_of;
      const value = row[c.field];
      if (isEmpty(value)) return;
      const permitted = c.values ?? (c.codelist ? codelists[c.codelist] ?? [] : []);
      const sv = String(value);
      const ok = permitted.some((p) => String(p) === sv);
      if (!ok) {
        emit({ row, rows, group: groupName, file, field: c.field, value }, groupName, rowIdx);
      }
      return;
    }
    case "compare": {
      const c = (check as { compare: { left: string; op: CompareOp; right: string | number } }).compare;
      const left = row[c.left];
      const right = typeof c.right === "string" && c.right in row ? row[c.right] : c.right;
      if (!compareValues(left, c.op, right as AgsValue)) {
        emit({ row, rows, group: groupName, file, field: c.left, value: left }, groupName, rowIdx);
      }
      return;
    }
    case "range": {
      const c = (check as { range: { field: string; min?: number; max?: number } }).range;
      const v = row[c.field];
      if (isEmpty(v)) return;
      const n = asNumber(v);
      if (n === null) return;
      const tooLow = c.min !== undefined && n < c.min;
      const tooHigh = c.max !== undefined && n > c.max;
      if (tooLow || tooHigh) {
        emit({ row, rows, group: groupName, file, field: c.field, value: v, min: c.min ?? "", max: c.max ?? "" }, groupName, rowIdx);
      }
      return;
    }
    case "pattern": {
      const c = (check as { pattern: { field: string; regex: string; flags?: string } }).pattern;
      const v = row[c.field];
      if (isEmpty(v)) return;
      let re: RegExp;
      try { re = new RegExp(c.regex, c.flags ?? ""); }
      catch { return; }
      if (!re.test(String(v))) {
        emit({ row, rows, group: groupName, file, field: c.field, value: v, regex: c.regex }, groupName, rowIdx);
      }
      return;
    }
    case "foreign_key": {
      const c = (check as { foreign_key: { fields: string[]; references: string | { group: string; fields?: string[] } } }).foreign_key;
      const refGroup = typeof c.references === "string" ? c.references : c.references.group;
      const refFields = typeof c.references === "string" ? c.fields : (c.references.fields ?? c.fields);
      const target = file.groups[refGroup];
      if (!target) {
        emit({ row, rows, group: groupName, file, field: c.fields.join(","), value: "(none)", ref_group: refGroup }, groupName, rowIdx);
        return;
      }
      // missing keys count as non-violations (handled by `required`)
      const localVals = c.fields.map((f) => row[f]);
      if (localVals.some(isEmpty)) return;
      const ok = target.rows.some((r) => refFields.every((rf, i) => {
        const lv = localVals[i];
        const rv = r[rf];
        if (lv === null || lv === undefined || rv === null || rv === undefined) return false;
        return String(lv) === String(rv);
      }));
      if (!ok) {
        const value = localVals.join(", ");
        emit({ row, rows, group: groupName, file, field: c.fields.join(","), value, ref_group: refGroup }, groupName, rowIdx);
      }
      return;
    }
    case "expr": {
      const c = (check as { expr: string }).expr;
      const ctx = { row, rows, group: groupName, file };
      let ok = true;
      try { ok = Boolean(jexl.evalSync(c, ctx)); } catch { ok = false; }
      if (!ok) emit(ctx, groupName, rowIdx);
      return;
    }
  }
}

function evaluateGroupCheck(
  check: CheckDef,
  kind: CheckKind,
  rows: AgsRow[],
  groupName: string,
  file: AgsFile,
  emit: (ctx: Record<string, unknown>, group: string | null, rowIdx: number | null) => void
): void {
  if (kind === "unique") {
    const fields = (check as { unique: string[] }).unique;
    const seen = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const keyParts = fields.map((f) => {
        const v = row[f];
        return v === null || v === undefined ? "\0" : String(v);
      });
      if (keyParts.some((p) => p === "\0")) continue; // partial keys: ignore
      const key = keyParts.join("\x1f");
      const prev = seen.get(key);
      if (prev !== undefined) {
        emit(
          { row, rows, group: groupName, file, key: keyParts.join(", "), fields: fields.join(",") },
          groupName, i
        );
      } else {
        seen.set(key, i);
      }
    }
    return;
  }
  if (kind === "monotonic") {
    const c = (check as { monotonic: { field: string; strict?: boolean } }).monotonic;
    const strict = c.strict !== false;
    const vals = rows.map((r) => r[c.field] ?? null);
    if (!isMonotonicSeries(vals, strict)) {
      emit({ rows, group: groupName, file, field: c.field, partition: "" }, groupName, null);
    }
    return;
  }
}

function evaluatePartitionCheck(
  check: CheckDef,
  kind: CheckKind,
  rows: AgsRow[],
  groupName: string,
  partKey: string,
  partitionBy: string,
  file: AgsFile,
  emit: (ctx: Record<string, unknown>, group: string | null, rowIdx: number | null) => void
): void {
  if (kind === "monotonic") {
    const c = (check as { monotonic: { field: string; strict?: boolean } }).monotonic;
    const strict = c.strict !== false;
    const vals = rows.map((r) => r[c.field] ?? null);
    if (!isMonotonicSeries(vals, strict)) {
      const key: AgsRow = {};
      key[partitionBy] = rows[0]?.[partitionBy] ?? null;
      emit(
        { rows, group: groupName, file, field: c.field, partition: ` under ${partitionBy}=${partKey}`, key },
        groupName, null
      );
    }
  }
}

function evaluateFileCheck(
  rule: RuleDef,
  check: CheckDef,
  kind: CheckKind,
  file: AgsFile,
  emit: (ctx: Record<string, unknown>, group: string | null, rowIdx: number | null) => void
): void {
  switch (kind) {
    case "group_exists": {
      const g = (check as { group_exists: string }).group_exists;
      if (!(g in file.groups)) emit({ file, group: g }, null, null);
      return;
    }
    case "group_size": {
      const c = (check as { group_size: { group: string; equals?: number; min?: number; max?: number } }).group_size;
      const actual = file.groups[c.group]?.rows.length ?? 0;
      const exp = c.equals !== undefined ? `${c.equals}` : `[${c.min ?? 0}, ${c.max ?? "∞"}]`;
      const ok =
        (c.equals === undefined || actual === c.equals) &&
        (c.min === undefined || actual >= c.min) &&
        (c.max === undefined || actual <= c.max);
      if (!ok) emit({ file, group: c.group, actual, expected: exp }, null, null);
      return;
    }
    case "heading_present": {
      const c = (check as { heading_present: { group: string; heading: string } }).heading_present;
      const g = file.groups[c.group];
      const ok = g !== undefined && g.headings.some((h) => h.name === c.heading);
      if (!ok) emit({ file, group: c.group, heading: c.heading }, c.group ?? null, null);
      return;
    }
    case "depth_unit": {
      const c = (check as { depth_unit: { headings?: string[]; unit: string } }).depth_unit;
      const targets = c.headings;
      for (const [groupName, group] of Object.entries(file.groups)) {
        for (const heading of group.headings) {
          const isTarget = targets ? targets.includes(heading.name) : AgsTypeFunctions.isNumeric(heading.data_type);
          if (!isTarget) continue;
          if (heading.unit.trim() !== c.unit) {
            emit(
              { file, group: groupName, field: heading.name, unit: c.unit, actual: heading.unit || "(blank)" },
              groupName, null
            );
          }
        }
      }
      return;
    }
    case "numeric_type": {
      const c = (check as { numeric_type: { fields?: string[] } }).numeric_type;
      const fields = c.fields;
      for (const [groupName, group] of Object.entries(file.groups)) {
        for (const heading of group.headings) {
          if (fields !== undefined && !fields.includes(heading.name)) continue;
          if (!AgsTypeFunctions.isNumeric(heading.data_type)) {
            emit({ file, group: groupName, field: heading.name }, groupName, null);
          }
        }
      }
      return;
    }
    case "expr": {
      const c = (check as { expr: string }).expr;
      const ctx = { file, groups_meta: buildGroupsMeta(file) };
      if (rule.when && !filterExpr(rule.when, ctx)) return;
      let ok = true;
      try { ok = Boolean(jexl.evalSync(c, ctx)); } catch { ok = false; }
      if (!ok) emit(ctx, null, null);
      return;
    }
  }
}

function isMonotonicSeries(values: unknown[], strict: boolean): boolean {
  if (values.length < 2) return true;
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    if (typeof prev === "number" && typeof curr === "number") {
      if (strict ? curr <= prev : curr < prev) return false;
    } else {
      const ps = prev === null || prev === undefined ? "" : String(prev);
      const cs = curr === null || curr === undefined ? "" : String(curr);
      if (strict ? cs <= ps : cs < ps) return false;
    }
  }
  return true;
}

function filterExpr(expr: string, ctx: Record<string, unknown>): boolean {
  try { return Boolean(jexl.evalSync(expr, ctx)); }
  catch { return false; }
}

function buildGroupsMeta(file: AgsFile) {
  return Object.entries(file.groups).map(([name, group]) => ({
    name,
    headings: group.headings.map((h) => ({
      name: h.name,
      unit: h.unit,
      type: AgsTypeFunctions.toString(h.data_type),
    })),
  }));
}

// ── Legacy expr-based evaluator (preserved for backwards compat) ─────────────

function evaluateLegacy(rule: RuleDef, file: AgsFile, diagnostics: PackDiagnostic[]): void {
  const scopeStr = rule.scope ?? "row";
  const expr = rule.expr;
  if (!expr) return;
  const msg = rule.message ?? "{group}: rule violated";

  if (scopeStr === "file") {
    const ctx: Record<string, unknown> = { file, groups_meta: buildGroupsMeta(file) };
    if (rule.when && !filterExpr(rule.when, ctx)) return;
    let passes = true;
    try { passes = Boolean(jexl.evalSync(expr, ctx)); } catch { passes = false; }
    if (!passes) {
      diagnostics.push({
        rule_id: rule.id, severity: rule.severity,
        message: renderMessage(msg, ctx), location: loc(null, null),
      });
    }
    return;
  }

  if (scopeStr.startsWith("group:")) {
    const keyHeading = scopeStr.slice("group:".length);
    for (const [groupName, group] of Object.entries(file.groups)) {
      if (rule.when) {
        const checkCtx = { group: groupName, row: {}, rows: [] };
        if (!filterExpr(rule.when, checkCtx)) continue;
      }
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
      for (const { rows, keyRow } of partitions.values()) {
        const ctx: Record<string, unknown> = { group: groupName, rows, key: keyRow, row: rows[0] ?? {}, file };
        let passes = true;
        try { passes = Boolean(jexl.evalSync(expr, ctx)); } catch { passes = false; }
        if (!passes) {
          diagnostics.push({
            rule_id: rule.id, severity: rule.severity,
            message: renderMessage(msg, ctx), location: loc(groupName, null),
          });
        }
      }
    }
    return;
  }

  // row scope
  for (const [groupName, group] of Object.entries(file.groups)) {
    _ctx!.groupName = groupName;
    for (let rowIdx = 0; rowIdx < group.rows.length; rowIdx++) {
      const row = group.rows[rowIdx]!;
      const ctx = { row, group: groupName, rows: group.rows, file };
      if (rule.when && !filterExpr(rule.when, ctx)) continue;
      let passes = true;
      try { passes = Boolean(jexl.evalSync(expr, ctx)); } catch { passes = false; }
      if (!passes) {
        diagnostics.push({
          rule_id: rule.id, severity: rule.severity,
          message: renderMessage(msg, ctx), location: loc(groupName, rowIdx),
        });
      }
    }
  }
}

// ── Public evaluator ─────────────────────────────────────────────────────────

export function evaluatePack(pack: Pack, file: AgsFile): PackDiagnostic[] {
  const codelists = resolveCodelists(pack);
  const diagnostics: PackDiagnostic[] = [];

  _ctx = { file, codelists, groupName: "" };
  try {
    for (const rule of pack.rules) {
      if (rule.check) {
        evaluateCheck(rule, rule.check, file, codelists, diagnostics);
      } else if (rule.expr) {
        evaluateLegacy(rule, file, diagnostics);
      }
    }
  } finally {
    _ctx = null;
  }

  return diagnostics;
}

export function evaluatePackYaml(yamlText: string, file: AgsFile): PackDiagnostic[] {
  return evaluatePack(loadPack(yamlText), file);
}
