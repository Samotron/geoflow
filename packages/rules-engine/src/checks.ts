// Declarative check kinds. Each kind is a small, focused primitive that maps
// to a real-world data requirement (required headings, foreign keys, codelists,
// monotonicity, …). The set is intentionally closed: when none fits, drop down
// to `expr` for arbitrary JEXL.

import type { AgsValue } from "@geoflow/core";

export type CompareOp = "<" | "<=" | "==" | "!=" | ">=" | ">";

export type CheckDef =
  | { required: string[] }
  | { unique: string[] }
  | { foreign_key: { fields: string[]; references: string | { group: string; fields?: string[] } } }
  | { one_of: { field: string; codelist?: string; values?: AgsValue[] } }
  | { compare: { left: string; op: CompareOp; right: string | number } }
  | { range: { field: string; min?: number; max?: number } }
  | { monotonic: { field: string; partition_by?: string; strict?: boolean } }
  | { pattern: { field: string; regex: string; flags?: string } }
  | { group_exists: string }
  | { group_size: { group: string; equals?: number; min?: number; max?: number } }
  | { heading_present: { group: string; heading: string } }
  | { depth_unit: { headings?: string[]; unit: string } }
  | { numeric_type: { fields?: string[] } }
  | { expr: string };

export type CheckKind =
  | "required" | "unique" | "foreign_key" | "one_of" | "compare" | "range"
  | "monotonic" | "pattern" | "group_exists" | "group_size" | "heading_present"
  | "depth_unit" | "numeric_type" | "expr";

export function detectCheckKind(check: CheckDef): CheckKind {
  const keys = Object.keys(check);
  if (keys.length !== 1) {
    throw new Error(`check must have exactly one key, got: ${keys.join(", ") || "(none)"}`);
  }
  return keys[0] as CheckKind;
}

export const CHECK_KINDS: CheckKind[] = [
  "required", "unique", "foreign_key", "one_of", "compare", "range",
  "monotonic", "pattern", "group_exists", "group_size", "heading_present",
  "depth_unit", "numeric_type", "expr",
];

// Scope a check applies at: row | group-partitioned | group | file.
export type CheckScope = "row" | "group" | "partition" | "file";

export function scopeFor(kind: CheckKind, check: CheckDef): CheckScope {
  switch (kind) {
    case "required":
    case "one_of":
    case "compare":
    case "range":
    case "pattern":
    case "expr":
      return "row";
    case "unique":
      return "group";
    case "foreign_key":
      return "row";
    case "monotonic":
      return (check as { monotonic: { partition_by?: string } }).monotonic.partition_by
        ? "partition"
        : "group";
    case "group_exists":
    case "group_size":
    case "heading_present":
    case "depth_unit":
    case "numeric_type":
      return "file";
  }
}

// Human-readable default message for a check, used when the rule omits `message:`.
export function defaultMessage(kind: CheckKind, check: CheckDef): string {
  switch (kind) {
    case "required":
      return "{group}: required field {field} is missing or empty";
    case "unique":
      return "{group}: duplicate key {key}";
    case "foreign_key": {
      const fk = (check as { foreign_key: { references: string | { group: string } } }).foreign_key;
      const ref = typeof fk.references === "string" ? fk.references : fk.references.group;
      return `{group}: foreign key {value} not found in ${ref}`;
    }
    case "one_of":
      return "{group}.{field}: value {value} is not in the permitted set";
    case "compare": {
      const c = (check as { compare: { left: string; op: CompareOp; right: string | number } }).compare;
      return `{group}: ${c.left} ({row.${c.left}}) ${c.op} ${c.right}${typeof c.right === "string" ? ` ({row.${c.right}})` : ""} not satisfied`;
    }
    case "range":
      return "{group}.{field}: value {value} out of range";
    case "monotonic":
      return "{group}: {field} is not strictly increasing{partition}";
    case "pattern":
      return "{group}.{field}: value {value} does not match pattern";
    case "group_exists":
      return "missing required group {group}";
    case "group_size":
      return "group {group} has {actual} rows, expected {expected}";
    case "heading_present":
      return "missing heading {heading} in group {group}";
    case "depth_unit":
      return "{group}.{field}: depth heading must have unit '{unit}', got '{actual}'";
    case "numeric_type":
      return "{group}.{field}: numeric value expected";
    case "expr":
      return "{group}: rule violated";
  }
}
