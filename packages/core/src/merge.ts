/**
 * Primary-key-aware merge of two (or more) AgsFile values.
 *
 *  - Rows unique to one side are taken as-is.
 *  - Rows with the same primary key and identical values are deduplicated.
 *  - Rows with the same primary key but different non-PK values are conflicts:
 *    auto-resolved to "theirs" and reported back so the caller can render a
 *    conflict UI / abort / pick a side.
 *  - Groups with no AGS-4 ID headings fall back to full-row dedup.
 *
 * The web app and the CLI both consume this — it intentionally has no UI
 * concerns. The web `apps/web/src/merge.ts` re-exports these symbols and
 * adds the conflict-resolver flow.
 */

import { Option } from "effect";
import type { AgsFile, AgsGroup, AgsHeading, AgsRow, AgsValue } from "./model.js";

export interface MergeConflict {
  group: string;
  /** '\0'-joined PK value used as the row identity. */
  primaryKey: string;
  primaryKeyHeadings: string[];
  oursRow: AgsRow;
  theirsRow: AgsRow;
  /** Auto-set to `theirsRow`; the caller may swap it to `oursRow` and re-apply. */
  resolvedRow: AgsRow;
}

export interface MergeResult {
  merged: AgsFile;
  conflicts: MergeConflict[];
}

function norm(v: AgsValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Y" : "N";
  return String(v);
}

function rowsEqual(a: AgsRow, b: AgsRow, headings: AgsHeading[]): boolean {
  return headings.every((h) => norm(a[h.name]) === norm(b[h.name]));
}

function unionHeadings(ours: AgsHeading[], theirs: AgsHeading[]): AgsHeading[] {
  const result = [...ours];
  for (const h of theirs) {
    if (!result.some((r) => r.name === h.name)) result.push(h);
  }
  return result;
}

function pkOf(headings: AgsHeading[]): string[] {
  return headings.filter((h) => h.data_type === "ID").map((h) => h.name);
}

function rowKey(row: AgsRow, pkHeadings: string[]): string {
  return pkHeadings.map((h) => norm(row[h])).join("\0");
}

export function mergeAgsFiles(ours: AgsFile, theirs: AgsFile): MergeResult {
  const allGroupNames = new Set([
    ...Object.keys(ours.groups),
    ...Object.keys(theirs.groups),
  ]);

  const mergedGroups: Record<string, AgsGroup> = {};
  const conflicts: MergeConflict[] = [];

  for (const groupName of allGroupNames) {
    const oursGroup = ours.groups[groupName];
    const theirsGroup = theirs.groups[groupName];

    if (!oursGroup && theirsGroup) { mergedGroups[groupName] = theirsGroup; continue; }
    if (oursGroup && !theirsGroup) { mergedGroups[groupName] = oursGroup; continue; }
    if (!oursGroup || !theirsGroup) continue;

    const mergedHeadings = unionHeadings(oursGroup.headings, theirsGroup.headings);
    const pkHeadings = pkOf(mergedHeadings);

    if (pkHeadings.length === 0) {
      const rows = [...oursGroup.rows];
      for (const r of theirsGroup.rows) {
        if (!rows.some((existing) => rowsEqual(existing, r, mergedHeadings))) rows.push(r);
      }
      mergedGroups[groupName] = { ...oursGroup, headings: mergedHeadings, rows };
      continue;
    }

    const oursMap = new Map<string, AgsRow>();
    for (const row of oursGroup.rows) oursMap.set(rowKey(row, pkHeadings), row);

    const theirsMap = new Map<string, AgsRow>();
    for (const row of theirsGroup.rows) theirsMap.set(rowKey(row, pkHeadings), row);

    const orderedKeys = [...oursMap.keys()];
    for (const key of theirsMap.keys()) {
      if (!oursMap.has(key)) orderedKeys.push(key);
    }

    const mergedRows: AgsRow[] = [];
    for (const key of orderedKeys) {
      const oursRow = oursMap.get(key);
      const theirsRow = theirsMap.get(key);

      if (!oursRow) {
        mergedRows.push(theirsRow!);
      } else if (!theirsRow) {
        mergedRows.push(oursRow);
      } else if (rowsEqual(oursRow, theirsRow, mergedHeadings)) {
        mergedRows.push(oursRow);
      } else {
        conflicts.push({
          group: groupName,
          primaryKey: key,
          primaryKeyHeadings: pkHeadings,
          oursRow,
          theirsRow,
          resolvedRow: theirsRow,
        });
        mergedRows.push(theirsRow);
      }
    }

    mergedGroups[groupName] = { ...oursGroup, headings: mergedHeadings, rows: mergedRows };
  }

  return {
    merged: { groups: mergedGroups, source_path: Option.none(), ags_version: ours.ags_version },
    conflicts,
  };
}

/**
 * Fold N AgsFile values in left-to-right order. Conflicts encountered at each
 * step are appended to a flat list; the caller decides whether to abort.
 */
export function mergeAgsFilesN(files: ReadonlyArray<AgsFile>): MergeResult {
  if (files.length === 0) {
    return {
      merged: { groups: {}, source_path: Option.none(), ags_version: Option.none() },
      conflicts: [],
    };
  }
  let acc: AgsFile = files[0]!;
  const allConflicts: MergeConflict[] = [];
  for (let i = 1; i < files.length; i++) {
    const result = mergeAgsFiles(acc, files[i]!);
    acc = result.merged;
    allConflicts.push(...result.conflicts);
  }
  return { merged: acc, conflicts: allConflicts };
}

export function applyConflictResolutions(
  merged: AgsFile,
  resolvedConflicts: ReadonlyArray<MergeConflict>,
): AgsFile {
  if (resolvedConflicts.length === 0) return merged;

  const groups = { ...merged.groups };
  for (const conflict of resolvedConflicts) {
    const group = groups[conflict.group];
    if (!group) continue;
    const pkHeadings = conflict.primaryKeyHeadings;
    groups[conflict.group] = {
      ...group,
      rows: group.rows.map((row) =>
        rowKey(row, pkHeadings) === conflict.primaryKey ? conflict.resolvedRow : row,
      ),
    };
  }
  return { ...merged, groups };
}
