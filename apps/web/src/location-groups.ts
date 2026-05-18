/**
 * location-groups.ts — user-defined groupings of boreholes (location groups).
 *
 * A LocationGroup is just a named set of LOCA_IDs. Groups are persisted in
 * localStorage and scoped to the currently loaded set of boreholes — switching
 * to a different AGS file with a different LOCA_ID set shows a different
 * collection of groups.
 *
 * Used across the app to filter plots, the map, and reports to a subset of
 * locations (e.g. "north of railway", "phase 2 ground investigation").
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

export interface LocationGroup {
  id: string;
  name: string;
  /** Hex colour used to render group markers on the map. */
  color: string;
  /** LOCA_IDs that belong to this group. */
  locaIds: string[];
}

const STORAGE_PREFIX = 'geoflow.location-groups.';

const GROUP_COLORS = [
  '#dc2626', '#2563eb', '#059669', '#d97706', '#7c3aed',
  '#0891b2', '#c026d3', '#ca8a04', '#16a34a', '#e11d48',
];

export function nextGroupColor(existing: LocationGroup[]): string {
  const used = new Set(existing.map((g) => g.color));
  return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[existing.length % GROUP_COLORS.length]!;
}

/**
 * Stable fingerprint for a set of LOCA_IDs. Sorting first so the order
 * within the file doesn't change the key.
 */
export function fingerprintLocaSet(locaIds: string[]): string {
  if (locaIds.length === 0) return 'empty';
  const sorted = [...locaIds].sort();
  // Lightweight non-cryptographic hash (FNV-1a 32-bit)
  let h = 2166136261;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x7c; // '|' separator
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + '-' + sorted.length;
}

function loadGroups(key: string): LocationGroup[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LocationGroup[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (g) => g && typeof g.id === 'string' && typeof g.name === 'string' && Array.isArray(g.locaIds),
    );
  } catch {
    return [];
  }
}

function saveGroups(key: string, groups: LocationGroup[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(groups));
  } catch {
    // quota exceeded / private mode — silently ignore
  }
}

/**
 * React hook: manage location groups for the current LOCA_ID set.
 *
 * Pass the full list of LOCA_IDs from the loaded AGS file. Groups are
 * automatically loaded/persisted in localStorage scoped by the LOCA_ID set
 * fingerprint. Switching to a different file (different LOCA_IDs) gives a
 * different set of groups — no cross-talk.
 */
export function useLocationGroups(allLocaIds: string[]) {
  const fingerprint = useMemo(() => fingerprintLocaSet(allLocaIds), [allLocaIds]);
  const [groups, setGroups] = useState<LocationGroup[]>(() => loadGroups(fingerprint));
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);

  // Re-load when file changes
  useEffect(() => {
    setGroups(loadGroups(fingerprint));
    setActiveGroupId(null);
  }, [fingerprint]);

  // Persist on every change
  useEffect(() => {
    saveGroups(fingerprint, groups);
  }, [fingerprint, groups]);

  const create = useCallback((name: string, locaIds: string[]): LocationGroup => {
    const id = 'lg-' + Math.random().toString(36).slice(2, 10);
    const trimmed = name.trim() || `Group ${groups.length + 1}`;
    const known = new Set(allLocaIds);
    const filtered = locaIds.filter((id) => known.has(id));
    const group: LocationGroup = {
      id,
      name: trimmed,
      color: nextGroupColor(groups),
      locaIds: filtered,
    };
    setGroups((prev) => [...prev, group]);
    return group;
  }, [groups, allLocaIds]);

  const update = useCallback((id: string, patch: Partial<Omit<LocationGroup, 'id'>>) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    );
  }, []);

  const remove = useCallback((id: string) => {
    setGroups((prev) => prev.filter((g) => g.id !== id));
    setActiveGroupId((cur) => (cur === id ? null : cur));
  }, []);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? null,
    [groups, activeGroupId],
  );

  /**
   * The set of LOCA_IDs to include when `activeGroupId` is set. Returns
   * an empty Set when no group is active — callers can interpret that
   * as "no filter applied".
   */
  const activeLocaSet = useMemo<Set<string>>(() => {
    if (!activeGroup) return new Set();
    return new Set(activeGroup.locaIds);
  }, [activeGroup]);

  return {
    groups,
    activeGroupId,
    activeGroup,
    activeLocaSet,
    setActiveGroupId,
    create,
    update,
    remove,
  };
}

/**
 * Group LOCA_IDs by which group they belong to. A borehole that belongs to
 * multiple groups is returned in every matching group; those that are in no
 * group appear under `_ungrouped`.
 */
export function groupLocaIds(
  allLocaIds: string[],
  groups: LocationGroup[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const g of groups) {
    out.set(g.id, g.locaIds.filter((id) => allLocaIds.includes(id)));
  }
  const assigned = new Set(groups.flatMap((g) => g.locaIds));
  out.set('_ungrouped', allLocaIds.filter((id) => !assigned.has(id)));
  return out;
}
