import type { AgsFile, AgsRow, AgsValue } from "./model.js";

// ── Key heading lookup ────────────────────────────────────────────────────────

function groupKeyHeadings(groupName: string): string[] {
  switch (groupName) {
    case "PROJ": return ["PROJ_ID"];
    case "LOCA": return ["LOCA_ID"];
    case "GEOL": return ["LOCA_ID", "GEOL_TOP"];
    case "SAMP": return ["LOCA_ID", "SAMP_TOP", "SAMP_REF"];
    case "ISPT": return ["LOCA_ID", "ISPT_TOP", "ISPT_TESN"];
    case "WSTK": return ["LOCA_ID", "WSTK_DPTH"];
    case "HOLE": return ["LOCA_ID", "HOLE_DPTH"];
    case "CDIA": return ["LOCA_ID", "CDIA_DPTH"];
    case "CHLG": return ["LOCA_ID", "CHLG_DPTH"];
    case "LLPL": case "LDEN": case "LPDN": case "LPEN": case "LTRT":
      return ["LOCA_ID", "SAMP_TOP", "SAMP_REF", "SPEC_DPTH"];
    default: return [];
  }
}

function rowContentKey(row: AgsRow): string {
  return Object.keys(row)
    .sort()
    .map((k) => `${k}\x01${valueStr(row[k] ?? null)}`)
    .join("\x00");
}

function valueStr(v: AgsValue): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  return v;
}

function valueDisplay(v: AgsValue): string {
  if (v === null) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function rowKey(row: AgsRow, keyHeadings: string[]): string | null {
  if (keyHeadings.length === 0) return null;
  const parts: string[] = [];
  for (const h of keyHeadings) {
    const v = row[h];
    if (v === undefined) return null;
    parts.push(valueStr(v));
  }
  return parts.join("\x00");
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface FieldChange {
  heading: string;
  before: string;
  after: string;
}

export interface RowChange {
  key: string;
  changes: FieldChange[];
}

export interface GroupDiff {
  group: string;
  key_headings: string[];
  rows_added: AgsRow[];
  rows_removed: AgsRow[];
  rows_changed: RowChange[];
  rows_unchanged: number;
  rows_moved: number;
}

export interface DiffResult {
  only_in_a: string[];
  only_in_b: string[];
  group_diffs: GroupDiff[];
}

// ── Diff algorithm ────────────────────────────────────────────────────────────

export function diffFiles(a: AgsFile, b: AgsFile): DiffResult {
  const keysA = new Set(Object.keys(a.groups));
  const keysB = new Set(Object.keys(b.groups));

  const only_in_a: string[] = [...keysA].filter((k) => !keysB.has(k)).sort();
  const only_in_b: string[] = [...keysB].filter((k) => !keysA.has(k)).sort();
  const common: string[] = [...keysA].filter((k) => keysB.has(k)).sort();

  const group_diffs: GroupDiff[] = common.map((name) =>
    diffGroup(name, a.groups[name]!.rows, b.groups[name]!.rows)
  );

  return { only_in_a, only_in_b, group_diffs };
}

function diffGroup(groupName: string, rowsA: AgsRow[], rowsB: AgsRow[]): GroupDiff {
  const keyHeadings = groupKeyHeadings(groupName);

  const mapA = buildKeyedMap(rowsA, keyHeadings);
  const mapB = buildKeyedMap(rowsB, keyHeadings);

  if (mapA.size === 0 && mapB.size === 0) {
    return diffPositional(groupName, rowsA, rowsB);
  }

  const keysA = new Set(mapA.keys());
  const keysB = new Set(mapB.keys());

  // Build position-by-key for move detection
  const indexA = new Map<string, number>();
  for (let i = 0; i < rowsA.length; i++) {
    const k = rowKey(rowsA[i]!, keyHeadings);
    if (k !== null) indexA.set(k, i);
  }
  const indexB = new Map<string, number>();
  for (let i = 0; i < rowsB.length; i++) {
    const k = rowKey(rowsB[i]!, keyHeadings);
    if (k !== null) indexB.set(k, i);
  }

  const rows_removed: AgsRow[] = [...keysA]
    .filter((k) => !keysB.has(k))
    .map((k) => mapA.get(k)!)
    .filter(Boolean);

  const rows_added: AgsRow[] = [...keysB]
    .filter((k) => !keysA.has(k))
    .map((k) => mapB.get(k)!)
    .filter(Boolean);

  const rows_changed: RowChange[] = [];
  let rows_unchanged = 0;
  let rows_moved = 0;

  for (const key of keysA) {
    if (!keysB.has(key)) continue;
    const ra = mapA.get(key)!;
    const rb = mapB.get(key)!;
    const changes = rowFieldDiff(ra, rb);
    if (changes.length === 0) {
      if (indexA.get(key) !== indexB.get(key)) {
        rows_moved++;
      } else {
        rows_unchanged++;
      }
    } else {
      rows_changed.push({ key: key.replace(/\x00/g, " / "), changes });
    }
  }

  return {
    group: groupName,
    key_headings: keyHeadings,
    rows_added,
    rows_removed,
    rows_changed,
    rows_unchanged,
    rows_moved,
  };
}

function diffPositional(groupName: string, rowsA: AgsRow[], rowsB: AgsRow[]): GroupDiff {
  // Content-based matching: pair identical rows regardless of position so
  // a reordered-but-unchanged row is counted as moved, not as removed+added.
  const contentMapA = new Map<string, number[]>();
  for (let i = 0; i < rowsA.length; i++) {
    const key = rowContentKey(rowsA[i]!);
    if (!contentMapA.has(key)) contentMapA.set(key, []);
    contentMapA.get(key)!.push(i);
  }

  const matchedA = new Set<number>();
  const matchedB = new Set<number>();
  let rows_unchanged = 0;
  let rows_moved = 0;

  for (let j = 0; j < rowsB.length; j++) {
    const key = rowContentKey(rowsB[j]!);
    const candidates = contentMapA.get(key);
    if (candidates && candidates.length > 0) {
      const i = candidates.shift()!;
      matchedA.add(i);
      matchedB.add(j);
      if (i === j) {
        rows_unchanged++;
      } else {
        rows_moved++;
      }
    }
  }

  const rows_removed: AgsRow[] = [];
  for (let i = 0; i < rowsA.length; i++) {
    if (!matchedA.has(i)) rows_removed.push(rowsA[i]!);
  }

  const rows_added: AgsRow[] = [];
  for (let j = 0; j < rowsB.length; j++) {
    if (!matchedB.has(j)) rows_added.push(rowsB[j]!);
  }

  return {
    group: groupName,
    key_headings: [],
    rows_added,
    rows_removed,
    rows_changed: [],
    rows_unchanged,
    rows_moved,
  };
}

function buildKeyedMap(rows: AgsRow[], keyHeadings: string[]): Map<string, AgsRow> {
  const map = new Map<string, AgsRow>();
  for (const row of rows) {
    const key = rowKey(row, keyHeadings);
    if (key !== null) map.set(key, row);
  }
  return map;
}

function rowFieldDiff(a: AgsRow, b: AgsRow): FieldChange[] {
  const allHeadings = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changes: FieldChange[] = [];
  const sorted = [...allHeadings].sort();
  for (const h of sorted) {
    const va: AgsValue = h in a ? (a[h] ?? null) : null;
    const vb: AgsValue = h in b ? (b[h] ?? null) : null;
    if (!valuesEqual(va, vb)) {
      changes.push({ heading: h, before: valueDisplay(va), after: valueDisplay(vb) });
    }
  }
  return changes;
}

function valuesEqual(a: AgsValue, b: AgsValue): boolean {
  return a === b;
}

// ── Text renderer ─────────────────────────────────────────────────────────────

function rowPreview(row: AgsRow, maxLen: number): string {
  const parts = Object.entries(row)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${valueDisplay(v)}`);
  const s = parts.join(", ");
  const codePoints = [...s];
  if (codePoints.length > maxLen) {
    return codePoints.slice(0, maxLen - 1).join("") + "…";
  }
  return s;
}

export function isIdentical(result: DiffResult): boolean {
  return (
    result.only_in_a.length === 0 &&
    result.only_in_b.length === 0 &&
    result.group_diffs.every(
      (g) =>
        g.rows_added.length === 0 &&
        g.rows_removed.length === 0 &&
        g.rows_changed.length === 0 &&
        g.rows_moved === 0
    )
  );
}

export function renderDiffText(result: DiffResult): string {
  if (isIdentical(result)) {
    return "files are identical\n";
  }

  let out = "";
  if (result.only_in_a.length > 0) {
    out += `only in a: ${result.only_in_a.join(", ")}\n`;
  }
  if (result.only_in_b.length > 0) {
    out += `only in b: ${result.only_in_b.join(", ")}\n`;
  }

  for (const gd of result.group_diffs) {
    if (
      gd.rows_added.length === 0 &&
      gd.rows_removed.length === 0 &&
      gd.rows_changed.length === 0 &&
      gd.rows_moved === 0
    ) {
      continue;
    }
    out += "\n";
    const parts: string[] = [];
    if (gd.rows_unchanged > 0) parts.push(`${gd.rows_unchanged} unchanged`);
    if (gd.rows_moved > 0) parts.push(`${gd.rows_moved} reordered`);
    if (gd.rows_added.length > 0) parts.push(`${gd.rows_added.length} added`);
    if (gd.rows_removed.length > 0) parts.push(`${gd.rows_removed.length} removed`);
    if (gd.rows_changed.length > 0) parts.push(`${gd.rows_changed.length} modified`);
    out += `${gd.group}: ${parts.join("  ")}\n`;

    for (const row of gd.rows_added) {
      out += `  + ${rowPreview(row, 60)}\n`;
    }
    for (const row of gd.rows_removed) {
      out += `  - ${rowPreview(row, 60)}\n`;
    }
    for (const change of gd.rows_changed) {
      out += `  ~ ${change.key}\n`;
      for (const fc of change.changes) {
        out += `      ${fc.heading}: ${fc.before} → ${fc.after}\n`;
      }
    }
  }

  return out;
}

// ── JSON renderer ─────────────────────────────────────────────────────────────

export interface DiffSummary {
  identical: boolean;
  only_in_a: string[];
  only_in_b: string[];
  groups: Array<{
    group: string;
    rows_added: number;
    rows_removed: number;
    rows_modified: number;
    rows_unchanged: number;
    rows_moved: number;
  }>;
}

export function diffToSummary(result: DiffResult): DiffSummary {
  return {
    identical: isIdentical(result),
    only_in_a: result.only_in_a,
    only_in_b: result.only_in_b,
    groups: result.group_diffs
      .filter(
        (g) =>
          g.rows_added.length > 0 ||
          g.rows_removed.length > 0 ||
          g.rows_changed.length > 0 ||
          g.rows_unchanged > 0 ||
          g.rows_moved > 0
      )
      .map((g) => ({
        group: g.group,
        rows_added: g.rows_added.length,
        rows_removed: g.rows_removed.length,
        rows_modified: g.rows_changed.length,
        rows_unchanged: g.rows_unchanged,
        rows_moved: g.rows_moved,
      })),
  };
}
