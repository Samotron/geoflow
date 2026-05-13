import { useState, useEffect } from 'react';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile, AgsGroup } from '../core.js';

interface Props {
  fileBytes: Uint8Array | null;
}

export function DataTab({ fileBytes }: Props) {
  const [agsFile, setAgsFile] = useState<AgsFile | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fileBytes) {
      setAgsFile(null);
      setSelectedGroup(null);
      return;
    }
    try {
      const text = decodeBytes(fileBytes);
      const parsed = parseStr(text);
      setAgsFile(parsed.file);
      const firstGroup = Object.keys(parsed.file.groups)[0] ?? null;
      setSelectedGroup(firstGroup);
      setError(null);
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
      <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)' }}>
        {error}
      </div>
    );
  }

  if (!agsFile) return null;

  const groupNames = Object.keys(agsFile.groups);
  const group: AgsGroup | undefined = selectedGroup ? agsFile.groups[selectedGroup] : undefined;

  const filteredRows = group?.rows.filter((row) => {
    if (!search) return true;
    return Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(search.toLowerCase()));
  }) ?? [];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 16, alignItems: 'start' }}>
      {/* Group list */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', position: 'sticky', top: 16, maxHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: '#f8fafc', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>
          Groups ({groupNames.length})
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {groupNames.map((name) => {
            const g = agsFile.groups[name];
            const active = name === selectedGroup;
            return (
              <div
                key={name}
                onClick={() => { setSelectedGroup(name); setSearch(''); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 14px',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  cursor: 'pointer',
                  borderBottom: '1px solid #f1f5f9',
                  background: active ? 'var(--navy)' : undefined,
                  color: active ? '#fff' : 'var(--text)',
                  transition: 'background .1s',
                }}
              >
                <span>{name}</span>
                <span style={{ fontSize: 11, color: active ? 'rgba(255,255,255,0.6)' : 'var(--muted)', background: active ? 'transparent' : '#e2e8f0', padding: '1px 6px', borderRadius: 99, fontFamily: 'system-ui' }}>
                  {g?.rows.length ?? 0}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Data panel */}
      {group ? (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: '#f8fafc' }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace' }}>{selectedGroup}</h2>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{group.headings.length} columns · {group.rows.length} rows</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              style={{ marginLeft: 'auto', padding: '5px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, outline: 'none', width: 180 }}
            />
          </div>
          <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 200px)' }}>
            <table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
                <tr>
                  <th style={{ background: '#f8fafc', padding: '7px 12px', textAlign: 'left', fontWeight: 400, fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)', borderBottom: '2px solid var(--border)', borderRight: '1px solid #e2e8f0', whiteSpace: 'nowrap' }}>#</th>
                  {group.headings.map((h) => (
                    <th key={h.name} style={{ background: '#f8fafc', padding: '7px 12px', textAlign: 'left', fontWeight: 700, fontFamily: 'monospace', fontSize: 11, color: 'var(--text)', borderBottom: '2px solid var(--border)', borderRight: '1px solid #e2e8f0', whiteSpace: 'nowrap' }}>
                      {h.name}
                      {h.unit && <span style={{ display: 'block', fontWeight: 400, fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>{h.unit}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row, i) => (
                  <tr key={i}>
                    <td style={{ padding: '6px 12px', borderBottom: '1px solid #f1f5f9', color: 'var(--muted)', textAlign: 'right', fontSize: 10, background: '#fafafa', fontFamily: 'monospace' }}>{i + 1}</td>
                    {group.headings.map((h) => {
                      const v = row[h.name];
                      const isNull = v === null || v === undefined;
                      const isNum = typeof v === 'number';
                      return (
                        <td key={h.name} style={{ padding: '6px 12px', borderBottom: '1px solid #f1f5f9', borderRight: '1px solid #f8fafc', verticalAlign: 'middle', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', textAlign: isNum ? 'right' : undefined, color: isNull ? '#cbd5e1' : isNum ? '#334155' : undefined }}>
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
      ) : (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          Select a group from the left panel
        </div>
      )}
    </div>
  );
}
