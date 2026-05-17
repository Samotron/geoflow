import { Option } from 'effect';
import type { AgsFile, AgsGroup, AgsHeading, AgsRow, AgsValue } from './core.js';

export interface MergeConflict {
  group: string;
  primaryKey: string;           // '\0'-joined composite key value
  primaryKeyHeadings: string[];
  oursRow: AgsRow;
  theirsRow: AgsRow;
  resolvedRow: AgsRow;          // auto-set to theirsRow; user may override
}

export interface MergeResult {
  merged: AgsFile;
  conflicts: MergeConflict[];
}

// Normalise an AgsValue to a string for comparison — treats null/''/false/0
// as distinct but uses the same canonical form for each.
function norm(v: AgsValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Y' : 'N';
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

// AGS 4 marks primary-key headings with data_type 'ID'.
function pkOf(headings: AgsHeading[]): string[] {
  return headings.filter((h) => h.data_type === 'ID').map((h) => h.name);
}

function rowKey(row: AgsRow, pkHeadings: string[]): string {
  return pkHeadings.map((h) => norm(row[h])).join('\0');
}

/**
 * Merge two AgsFiles using primary-key awareness.
 *
 * - Rows unique to one side are taken as-is.
 * - Rows with the same primary key and identical values are deduplicated.
 * - Rows with the same primary key but different values are conflicts:
 *   auto-resolved to "theirs" and recorded in the returned conflicts array.
 * - Groups with no primary-key headings fall back to full-row deduplication.
 */
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
      // No primary key — deduplicate by full row equality then concatenate
      const rows = [...oursGroup.rows];
      for (const r of theirsGroup.rows) {
        if (!rows.some((existing) => rowsEqual(existing, r, mergedHeadings))) rows.push(r);
      }
      mergedGroups[groupName] = { ...oursGroup, headings: mergedHeadings, rows };
      continue;
    }

    // Build keyed lookup maps preserving insertion order
    const oursMap = new Map<string, AgsRow>();
    for (const row of oursGroup.rows) oursMap.set(rowKey(row, pkHeadings), row);

    const theirsMap = new Map<string, AgsRow>();
    for (const row of theirsGroup.rows) theirsMap.set(rowKey(row, pkHeadings), row);

    // Output order: ours-order first, then theirs-only rows appended
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
        mergedRows.push(oursRow); // identical — keep one
      } else {
        // Conflict: auto-take theirs, record for UI
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
 * Rebuild the merged AgsFile after the user has chosen a side for each conflict.
 * Conflicts whose resolvedRow has been changed to oursRow are patched in.
 */
export function applyConflictResolutions(
  merged: AgsFile,
  resolvedConflicts: MergeConflict[],
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
