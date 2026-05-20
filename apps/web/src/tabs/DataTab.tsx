import { useState, useEffect, useMemo, type MutableRefObject } from 'react';
import { decodeBytes, parseStr, diffFiles } from '../core.js';
import type { AgsFile, AgsGroup, AgsRow, GroupDiff } from '../core.js';
import { exportExcel } from '../export/excel.js';
import { exportGeopackage } from '../export/geopackage.js';
import { exportAsDuckDb } from '../query/duckdb.js';
import { downloadBlob, exportBaseName, exportDatePrefix, toCsvRow } from '../export/utils.js';

interface Props {
  fileBytes: Uint8Array | null;
  fileName?: string | undefined;
  pendingHoleRef?: MutableRefObject<string | null>;
  /** Optional group to switch to on next mount (e.g. via Search "View" button). */
  pendingGroupRef?: MutableRefObject<string | null>;
}

// ── CSV export helpers ────────────────────────────────────────────────────────

function exportGroupCsv(group: AgsGroup, groupName: string, fileName: string | undefined) {
  const date = exportDatePrefix();
  const base = exportBaseName(fileName);
  const headings = group.headings.map((h) => h.name);
  const rows = group.rows.map((row) => toCsvRow(headings, row));
  downloadBlob([headings.join(','), ...rows].join('\n'), `${date}-${base}-${groupName}.csv`, 'text/csv');
}

function exportAllCsv(agsFile: AgsFile, fileName: string | undefined) {
  const date = exportDatePrefix();
  const base = exportBaseName(fileName);
  for (const [groupName, group] of Object.entries(agsFile.groups)) {
    if (!group) continue;
    const headings = group.headings.map((h) => h.name);
    const rows = group.rows.map((row) => toCsvRow(headings, row));
    downloadBlob([headings.join(','), ...rows].join('\n'), `${date}-${base}-${groupName}.csv`, 'text/csv');
  }
}

// ── Hole detail view ──────────────────────────────────────────────────────────

function HoleDetailView({
  locaId,
  agsFile,
  fileName,
  onClose,
}: {
  locaId: string;
  agsFile: AgsFile;
  fileName: string | undefined;
  onClose: () => void;
}) {
  const groups = Object.entries(agsFile.groups).filter(([, g]) => {
    if (!g) return false;
    return g.headings.some((h) => h.name === 'LOCA_ID') && g.rows.some((r) => String(r['LOCA_ID'] ?? '') === locaId);
  });

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button
          onClick={onClose}
          style={{ background: 'var(--border)', color: 'var(--text)', padding: '7px 14px', fontSize: 12 }}
        >
          ← Back
        </button>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>
          Location: <span style={{ fontFamily: 'monospace', color: 'var(--blue)' }}>{locaId}</span>
        </h2>
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>{groups.length} group{groups.length !== 1 ? 's' : ''}</span>
        <button
          onClick={() => {
            const date = exportDatePrefix();
            const base = exportBaseName(fileName);
            for (const [name, g] of groups) {
              if (!g) continue;
              const rows = g.rows.filter((r) => String(r['LOCA_ID'] ?? '') === locaId);
              const headings = g.headings.map((h) => h.name);
              const csvRows = rows.map((r) => toCsvRow(headings, r));
              downloadBlob([headings.join(','), ...csvRows].join('\n'), `${date}-${base}-${locaId}-${name}.csv`, 'text/csv');
            }
          }}
          style={{ marginLeft: 'auto', background: 'var(--navy)', color: '#fff', fontSize: 12, padding: '7px 14px' }}
        >
          Export All CSV
        </button>
      </div>

      {/* One table per group */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {groups.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
            No related data found for this location.
          </div>
        )}
        {groups.map(([groupName, group]) => {
          if (!group) return null;
          const rows = group.rows.filter((r) => String(r['LOCA_ID'] ?? '') === locaId);
          return (
            <div key={groupName} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)' }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace' }}>{groupName}</h3>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rows.length} row{rows.length !== 1 ? 's' : ''}</span>
                <button
                  onClick={() => {
                    const date = exportDatePrefix();
                    const base = exportBaseName(fileName);
                    const headings = group.headings.map((h) => h.name);
                    const csvRows = rows.map((r) => toCsvRow(headings, r));
                    downloadBlob([headings.join(','), ...csvRows].join('\n'), `${date}-${base}-${locaId}-${groupName}.csv`, 'text/csv');
                  }}
                  style={{ marginLeft: 'auto', background: 'var(--border)', color: 'var(--text)', fontSize: 11, padding: '4px 10px' }}
                >
                  Export CSV
                </button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      {group.headings.map((h) => (
                        <th key={h.name} style={{ background: 'var(--surface-muted)', padding: '6px 12px', textAlign: 'left', fontWeight: 700, fontFamily: 'monospace', fontSize: 11, color: 'var(--text)', borderBottom: '2px solid var(--border)', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                          {h.name}
                          {h.unit && <span style={{ display: 'block', fontWeight: 400, fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>{h.unit}</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i}>
                        {group.headings.map((h) => {
                          const v = row[h.name];
                          const isNull = v === null || v === undefined;
                          const isNum = typeof v === 'number';
                          return (
                            <td key={h.name} style={{ padding: '6px 12px', borderBottom: '1px solid var(--surface-muted)', borderRight: '1px solid var(--surface-muted)', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap', textAlign: isNum ? 'right' : undefined, color: isNull ? 'var(--border-strong)' : isNum ? 'var(--text)' : undefined }}>
                              {isNull ? 'null' : String(v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Group table view ──────────────────────────────────────────────────────────

// ── Row diff classification ──────────────────────────────────────────────────

type RowStatus = 'added' | 'removed' | 'changed' | 'unchanged';

interface RowAnnotation {
  status: RowStatus;
  /** Headings that differ from the comparison row (only for status='changed'). */
  changedFields: Set<string>;
  /** For 'removed' rows, the original row from the comparison file. */
  removedRow?: AgsRow;
}

function buildRowAnnotations(group: AgsGroup, groupDiff: GroupDiff | undefined): {
  byRowIndex: Map<number, RowAnnotation>;
  removedRows: AgsRow[];
} {
  const byRowIndex = new Map<number, RowAnnotation>();
  const removedRows: AgsRow[] = [];
  if (!groupDiff) return { byRowIndex, removedRows };

  const keyHeadings = groupDiff.key_headings;
  const keyOf = (row: AgsRow): string => keyHeadings.map((h) => String(row[h] ?? '')).join('\0');

  const addedKeys = new Set(groupDiff.rows_added.map(keyOf));
  const changedByKey = new Map<string, Set<string>>();
  for (const c of groupDiff.rows_changed) {
    changedByKey.set(c.key, new Set(c.changes.map((f) => f.heading)));
  }

  for (let i = 0; i < group.rows.length; i++) {
    const row = group.rows[i]!;
    const k = keyOf(row);
    if (addedKeys.has(k)) {
      byRowIndex.set(i, { status: 'added', changedFields: new Set() });
    } else if (changedByKey.has(k)) {
      byRowIndex.set(i, { status: 'changed', changedFields: changedByKey.get(k)! });
    } else {
      byRowIndex.set(i, { status: 'unchanged', changedFields: new Set() });
    }
  }
  removedRows.push(...groupDiff.rows_removed);
  return { byRowIndex, removedRows };
}

function GroupTable({
  group,
  groupName,
  fileName,
  onLocaClick,
  groupDiff,
}: {
  group: AgsGroup;
  groupName: string;
  fileName: string | undefined;
  onLocaClick: (id: string) => void;
  groupDiff?: GroupDiff | undefined;
}) {
  const [search, setSearch] = useState('');

  const filteredRows = group.rows.filter((row) => {
    if (!search) return true;
    return Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(search.toLowerCase()));
  });

  const hasLocaId = group.headings.some((h) => h.name === 'LOCA_ID');
  const annotations = useMemo(() => buildRowAnnotations(group, groupDiff), [group, groupDiff]);
  const diffActive = !!groupDiff;
  const counts = useMemo(() => {
    if (!groupDiff) return null;
    let added = 0, changed = 0;
    for (const a of annotations.byRowIndex.values()) {
      if (a.status === 'added') added++;
      else if (a.status === 'changed') changed++;
    }
    return { added, changed, removed: annotations.removedRows.length };
  }, [groupDiff, annotations]);

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace' }}>{groupName}</h2>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{group.headings.length} columns · {group.rows.length} rows</span>
        {hasLocaId && (
          <span style={{ fontSize: 11, color: 'var(--blue)', background: 'var(--accent-soft)', padding: '2px 8px', borderRadius: 99, border: '1px solid var(--accent-border)' }}>
            LOCA_ID clickable
          </span>
        )}
        {counts && (
          <span style={{ display: 'inline-flex', gap: 8, fontSize: 11 }}>
            {counts.added > 0 && (
              <span style={diffPillStyle('green')}>+{counts.added} added</span>
            )}
            {counts.changed > 0 && (
              <span style={diffPillStyle('amber')}>~{counts.changed} changed</span>
            )}
            {counts.removed > 0 && (
              <span style={diffPillStyle('red')}>−{counts.removed} removed</span>
            )}
          </span>
        )}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          style={{ marginLeft: 'auto', padding: '5px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, outline: 'none', width: 180 }}
        />
        <button
          onClick={() => exportGroupCsv(group, groupName, fileName)}
          style={{ background: 'var(--border)', color: 'var(--text)', fontSize: 12, padding: '5px 12px' }}
        >
          Export CSV
        </button>
      </div>
      <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 220px)' }}>
        <table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
            <tr>
              <th style={{ background: 'var(--surface-muted)', padding: '7px 12px', textAlign: 'left', fontWeight: 400, fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)', borderBottom: '2px solid var(--border)', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>#</th>
              {group.headings.map((h) => (
                <th key={h.name} style={{ background: 'var(--surface-muted)', padding: '7px 12px', textAlign: 'left', fontWeight: 700, fontFamily: 'monospace', fontSize: 11, color: 'var(--text)', borderBottom: '2px solid var(--border)', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                  {h.name}
                  {h.unit && <span style={{ display: 'block', fontWeight: 400, fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>{h.unit}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row, i) => {
              // i is the index within filteredRows; we need the original index for diff lookup
              const originalIndex = group.rows.indexOf(row);
              const ann = annotations.byRowIndex.get(originalIndex);
              const rowBg = diffActive && ann ? diffRowBg(ann.status) : undefined;
              const rowLeftBorder = diffActive && ann && ann.status !== 'unchanged'
                ? `3px solid ${diffColor(ann.status)}` : undefined;
              return (
                <tr key={i} style={{ background: rowBg, boxShadow: rowLeftBorder ? `inset ${rowLeftBorder.split(' ').slice(2).join(' ')} 0 0 0 ${rowLeftBorder.split(' ')[0]}` : undefined }}>
                  <td style={{
                    padding: '6px 12px',
                    borderBottom: '1px solid var(--surface-muted)',
                    color: 'var(--muted)',
                    textAlign: 'right',
                    fontSize: 10,
                    background: 'var(--surface-muted)',
                    fontFamily: 'monospace',
                    borderLeft: rowLeftBorder ?? undefined,
                  }}>{i + 1}</td>
                  {group.headings.map((h) => {
                    const v = row[h.name];
                    const isNull = v === null || v === undefined;
                    const isNum = typeof v === 'number';
                    const isLocaCell = hasLocaId && h.name === 'LOCA_ID' && !isNull;
                    const cellChanged = !!ann && ann.changedFields.has(h.name);
                    return (
                      <td
                        key={h.name}
                        onClick={isLocaCell ? () => onLocaClick(String(v)) : undefined}
                        style={{
                          padding: '6px 12px',
                          borderBottom: '1px solid var(--surface-muted)',
                          borderRight: '1px solid var(--surface-muted)',
                          verticalAlign: 'middle',
                          whiteSpace: 'nowrap',
                          fontFamily: 'monospace',
                          fontSize: 12,
                          maxWidth: 260,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          textAlign: isNum ? 'right' : undefined,
                          color: isNull ? 'var(--border-strong)' : isLocaCell ? 'var(--blue)' : isNum ? 'var(--text)' : undefined,
                          cursor: isLocaCell ? 'pointer' : undefined,
                          textDecoration: isLocaCell ? 'underline' : undefined,
                          background: cellChanged ? 'var(--amber-soft)' : undefined,
                          fontWeight: cellChanged ? 700 : undefined,
                        }}
                      >
                        {isNull ? 'null' : String(v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {/* Removed rows from the comparison file render as ghost rows at the bottom. */}
            {diffActive && annotations.removedRows.length > 0 && annotations.removedRows.slice(0, 50).map((row, j) => (
              <tr key={`removed-${j}`} style={{ background: 'var(--red-soft)', opacity: 0.7 }}>
                <td style={{
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--surface-muted)',
                  color: 'var(--red)',
                  textAlign: 'right',
                  fontSize: 10,
                  background: 'var(--red-soft)',
                  fontFamily: 'monospace',
                  borderLeft: `3px solid var(--red)`,
                }}>−</td>
                {group.headings.map((h) => {
                  const v = row[h.name];
                  const isNull = v === null || v === undefined;
                  return (
                    <td key={h.name} style={{
                      padding: '6px 12px',
                      borderBottom: '1px solid var(--surface-muted)',
                      borderRight: '1px solid var(--surface-muted)',
                      whiteSpace: 'nowrap',
                      fontFamily: 'monospace',
                      fontSize: 12,
                      maxWidth: 260,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      textDecoration: 'line-through',
                      color: 'var(--red)',
                    }}>
                      {isNull ? 'null' : String(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {filteredRows.length === 0 && (
          <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            {search ? 'No rows match search' : 'No data rows'}
          </div>
        )}
      </div>
      {search && filteredRows.length < group.rows.length && (
        <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>
          Showing {filteredRows.length} of {group.rows.length} rows
        </div>
      )}
    </div>
  );
}

// ── Diff styling helpers ─────────────────────────────────────────────────────

function diffColor(status: RowStatus): string {
  switch (status) {
    case 'added':     return 'var(--green)';
    case 'changed':   return 'var(--amber)';
    case 'removed':   return 'var(--red)';
    case 'unchanged': return 'transparent';
  }
}

function diffRowBg(status: RowStatus): string | undefined {
  switch (status) {
    case 'added':     return 'var(--green-soft)';
    case 'changed':   return 'var(--amber-soft)';
    case 'removed':   return 'var(--red-soft)';
    case 'unchanged': return undefined;
  }
}

function diffPillStyle(tone: 'green' | 'amber' | 'red'): React.CSSProperties {
  const bg = tone === 'green' ? 'var(--green-soft)' : tone === 'amber' ? 'var(--amber-soft)' : 'var(--red-soft)';
  const fg = tone === 'green' ? 'var(--green)' : tone === 'amber' ? 'var(--amber)' : 'var(--red)';
  return {
    padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700,
    background: bg, color: fg, border: `1px solid ${fg}`,
  };
}

// ── Main DataTab ──────────────────────────────────────────────────────────────

export function DataTab({ fileBytes, fileName, pendingHoleRef, pendingGroupRef }: Props) {
  const [agsFile, setAgsFile] = useState<AgsFile | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [holeView, setHoleView] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Optional "compare against" file for inline diff highlighting.
  const [compareFile, setCompareFile] = useState<AgsFile | null>(null);
  const [compareFileName, setCompareFileName] = useState<string | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  // Recompute per-group diff whenever current/compare changes.
  const diffByGroup = useMemo<Map<string, GroupDiff>>(() => {
    if (!agsFile || !compareFile) return new Map();
    try {
      const result = diffFiles(compareFile, agsFile); // compare = "before", current = "after"
      const map = new Map<string, GroupDiff>();
      for (const g of result.group_diffs) map.set(g.group, g);
      return map;
    } catch {
      return new Map();
    }
  }, [agsFile, compareFile]);

  const onCompareFileChange = async (file: File | null) => {
    setCompareError(null);
    if (!file) {
      setCompareFile(null);
      setCompareFileName(null);
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const text = decodeBytes(new Uint8Array(buf));
      const parsed = parseStr(text);
      setCompareFile(parsed.file);
      setCompareFileName(file.name);
    } catch (e) {
      setCompareError(e instanceof Error ? e.message : String(e));
      setCompareFile(null);
      setCompareFileName(null);
    }
  };

  useEffect(() => {
    if (!fileBytes) {
      setAgsFile(null);
      setSelectedGroup(null);
      setHoleView(null);
      return;
    }
    try {
      const text = decodeBytes(fileBytes);
      const parsed = parseStr(text);
      setAgsFile(parsed.file);
      // Group navigation has priority over the default-first behaviour.
      const pendingGroup = pendingGroupRef?.current ?? null;
      if (pendingGroup && parsed.file.groups[pendingGroup]) {
        pendingGroupRef!.current = null;
        setSelectedGroup(pendingGroup);
      } else {
        setSelectedGroup(Object.keys(parsed.file.groups)[0] ?? null);
      }
      setError(null);
      // Check for pending borehole navigation (e.g. from Map tab "View Data" click)
      const pendingId = pendingHoleRef?.current ?? null;
      if (pendingId) {
        pendingHoleRef!.current = null;
        setHoleView(pendingId);
      } else {
        setHoleView(null);
      }
    } catch (e) {
      setError(String(e));
      setAgsFile(null);
    }
  }, [fileBytes]);

  // React to pendingGroupRef changes while the tab is already mounted.
  // Re-runs on every render (no dep array) because pendingGroupRef.current
  // is mutated externally; the conditional check makes this a no-op except
  // when a new group has been queued.
  useEffect(() => {
    if (!agsFile || !pendingGroupRef?.current) return;
    const g = pendingGroupRef.current;
    if (agsFile.groups[g]) {
      pendingGroupRef.current = null;
      setSelectedGroup(g);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
        <p>Drop an AGS file above to browse its data.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ background: 'var(--red-soft)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)' }}>
        {error}
      </div>
    );
  }

  if (!agsFile) return null;

  // Hole detail view
  if (holeView) {
    return (
      <HoleDetailView
        locaId={holeView}
        agsFile={agsFile}
        fileName={fileName}
        onClose={() => setHoleView(null)}
      />
    );
  }

  const groupNames = Object.keys(agsFile.groups);
  const group: AgsGroup | undefined = selectedGroup ? agsFile.groups[selectedGroup] : undefined;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 16, alignItems: 'start' }}>
      {/* Group list */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', position: 'sticky', top: 16, maxHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>
          Groups ({groupNames.length})
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {groupNames.map((name) => {
            const g = agsFile.groups[name];
            const active = name === selectedGroup;
            return (
              <div
                key={name}
                onClick={() => setSelectedGroup(name)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', fontFamily: 'monospace', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid var(--surface-muted)', background: active ? 'var(--navy)' : undefined, color: active ? '#fff' : 'var(--text)', transition: 'background .1s' }}
              >
                <span>{name}</span>
                <span style={{ fontSize: 11, color: active ? 'rgba(255,255,255,0.6)' : 'var(--muted)', background: active ? 'transparent' : 'var(--border)', padding: '1px 6px', borderRadius: 99, fontFamily: 'system-ui' }}>
                  {g?.rows.length ?? 0}
                </span>
              </div>
            );
          })}
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface-muted)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            onClick={() => exportAllCsv(agsFile, fileName)}
            style={{ width: '100%', background: 'var(--green)', color: '#fff', fontSize: 12, padding: '7px 10px' }}
          >
            All CSV
          </button>
          <button
            onClick={() => { void exportExcel(agsFile, fileName).catch(e => setExportError(`Excel export failed: ${String(e)}`)); }}
            style={{ width: '100%', background: 'var(--green)', color: '#fff', fontSize: 12, padding: '7px 10px' }}
          >
            Excel (.xlsx)
          </button>
          <button
            onClick={() => { void exportGeopackage(agsFile, fileName).catch(e => setExportError(`GeoPackage export failed: ${String(e)}`)); }}
            style={{ width: '100%', background: 'var(--amber)', color: '#fff', fontSize: 12, padding: '7px 10px' }}
          >
            GeoPackage (.gpkg)
          </button>
          <button
            onClick={() => { void exportAsDuckDb(agsFile, fileName).catch(e => setExportError(`DuckDB export failed: ${String(e)}`)); }}
            style={{ width: '100%', background: 'var(--accent)', color: '#fff', fontSize: 12, padding: '7px 10px' }}
          >
            DuckDB (.duckdb)
          </button>
          {exportError && (
            <div style={{ background: 'var(--red-soft)', border: '1px solid var(--red-border)', borderRadius: 4, padding: '6px 10px', fontSize: 11, color: 'var(--red)', marginTop: 4 }}>
              {exportError}
              <button onClick={() => setExportError(null)} style={{ float: 'right', background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', padding: 0, fontSize: 13 }}>×</button>
            </div>
          )}
        </div>
      </div>

      {/* Data panel */}
      {group && selectedGroup ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          {/* Compare-against toolbar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
            background: compareFile ? 'var(--amber-soft)' : 'var(--card)',
            border: `1px solid ${compareFile ? 'var(--amber-border)' : 'var(--border)'}`,
            borderRadius: 'var(--radius)', fontSize: 12, flexWrap: 'wrap',
          }}>
            <span style={{ fontWeight: 700, color: compareFile ? 'var(--amber)' : 'var(--muted)' }}>
              {compareFile ? 'Comparing against:' : 'Compare with:'}
            </span>
            {compareFile ? (
              <>
                <code style={{
                  fontFamily: 'ui-monospace, monospace', fontSize: 12,
                  background: 'var(--card)', padding: '2px 8px', borderRadius: 4,
                  border: '1px solid var(--amber-border)',
                }}>
                  {compareFileName}
                </code>
                <span style={{ color: 'var(--muted)' }}>
                  {diffByGroup.size} group{diffByGroup.size !== 1 ? 's' : ''} compared
                </span>
                <button
                  onClick={() => { setCompareFile(null); setCompareFileName(null); }}
                  style={{
                    marginLeft: 'auto', padding: '4px 10px', fontSize: 11, fontWeight: 600,
                    background: 'transparent', border: '1px solid var(--amber-border)',
                    borderRadius: 4, color: 'var(--amber)',
                  }}
                >
                  Stop comparing
                </button>
              </>
            ) : (
              <>
                <label style={{
                  padding: '4px 10px', fontSize: 11, fontWeight: 600,
                  background: 'var(--accent-soft)', border: '1px solid var(--accent-border)',
                  color: 'var(--accent)', borderRadius: 4, cursor: 'pointer',
                }}>
                  Load AGS file…
                  <input
                    type="file"
                    accept=".ags,.xml"
                    style={{ display: 'none' }}
                    onChange={(e) => void onCompareFileChange(e.target.files?.[0] ?? null)}
                  />
                </label>
                <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                  …to see inline added / changed / removed rows.
                </span>
              </>
            )}
            {compareError && (
              <span style={{ color: 'var(--red)', fontSize: 11 }}>{compareError}</span>
            )}
          </div>
          <GroupTable
            key={selectedGroup}
            group={group}
            groupName={selectedGroup}
            fileName={fileName}
            onLocaClick={(id) => setHoleView(id)}
            groupDiff={diffByGroup.get(selectedGroup)}
          />
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          Select a group from the left panel
        </div>
      )}
    </div>
  );
}
