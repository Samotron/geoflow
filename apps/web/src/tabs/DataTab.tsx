import { useState, useEffect, useRef, type MutableRefObject } from 'react';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile, AgsGroup, AgsRow } from '../core.js';
import { exportExcel } from '../export/excel.js';
import { exportGeopackage } from '../export/geopackage.js';
import { exportAsDuckDb } from '../query/duckdb.js';
import { downloadBlob, exportBaseName, exportDatePrefix, toCsvRow } from '../export/utils.js';

interface Props {
  fileBytes: Uint8Array | null;
  fileName?: string | undefined;
  pendingHoleRef?: MutableRefObject<string | null>;
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

function GroupTable({
  group,
  groupName,
  fileName,
  onLocaClick,
}: {
  group: AgsGroup;
  groupName: string;
  fileName: string | undefined;
  onLocaClick: (id: string) => void;
}) {
  const [search, setSearch] = useState('');

  const filteredRows = group.rows.filter((row) => {
    if (!search) return true;
    return Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(search.toLowerCase()));
  });

  const hasLocaId = group.headings.some((h) => h.name === 'LOCA_ID');

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
            {filteredRows.map((row, i) => (
              <tr key={i}>
                <td style={{ padding: '6px 12px', borderBottom: '1px solid var(--surface-muted)', color: 'var(--muted)', textAlign: 'right', fontSize: 10, background: 'var(--surface-muted)', fontFamily: 'monospace' }}>{i + 1}</td>
                {group.headings.map((h) => {
                  const v = row[h.name];
                  const isNull = v === null || v === undefined;
                  const isNum = typeof v === 'number';
                  const isLocaCell = hasLocaId && h.name === 'LOCA_ID' && !isNull;
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
                      }}
                    >
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

// ── Main DataTab ──────────────────────────────────────────────────────────────

export function DataTab({ fileBytes, fileName, pendingHoleRef }: Props) {
  const [agsFile, setAgsFile] = useState<AgsFile | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [holeView, setHoleView] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

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
      setSelectedGroup(Object.keys(parsed.file.groups)[0] ?? null);
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
        <GroupTable
          key={selectedGroup}
          group={group}
          groupName={selectedGroup}
          fileName={fileName}
          onLocaClick={(id) => setHoleView(id)}
        />
      ) : (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          Select a group from the left panel
        </div>
      )}
    </div>
  );
}
