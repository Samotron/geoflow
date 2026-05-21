/**
 * Search tab — full-text find across every cell in every group of the
 * currently loaded AGS file. Hits can be clicked to jump to the Data tab
 * focused on that row's group.
 *
 * Queries can be saved to IndexedDB and reloaded later; saved searches are
 * project-scoped (or session-scoped when no project is active).
 */

import { useEffect, useMemo, useState } from 'react';
import { parseStr, decodeBytes } from '../core.js';
import type { AgsFile } from '../core.js';
import type { StoredSearch } from '../storage/types.js';
import { getSavedSearches, saveSavedSearch, deleteSavedSearch } from '../storage/db.js';

interface Props {
  fileBytes: Uint8Array | null;
  projectId: string | null;
  onJumpToRow?: (group: string, rowIndex: number) => void;
}

interface Hit {
  group: string;
  rowIndex: number;
  heading: string;
  value: string;
  locaId: string;
}

const MAX_HITS = 500;
const SESSION_PROJECT_ID = '_session';

export function SearchTab({ fileBytes, projectId, onJumpToRow }: Props) {
  const file = useMemo<AgsFile | null>(() => {
    if (!fileBytes) return null;
    try {
      return parseStr(decodeBytes(fileBytes)).file;
    } catch {
      return null;
    }
  }, [fileBytes]);

  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>('*');
  const [exact, setExact] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);

  const allGroups = useMemo(() => {
    if (!file) return [];
    return Object.keys(file.groups).sort();
  }, [file]);

  const { hits, truncated, totalRows, totalCells } = useMemo(() => {
    if (!file || query.trim().length === 0) {
      let cells = 0;
      let rows = 0;
      if (file) {
        for (const g of Object.values(file.groups)) {
          rows += g.rows.length;
          cells += g.rows.length * g.headings.length;
        }
      }
      return { hits: [] as Hit[], truncated: false, totalRows: rows, totalCells: cells };
    }
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches = (haystack: string): boolean => {
      const h = caseSensitive ? haystack : haystack.toLowerCase();
      return exact ? h === needle : h.includes(needle);
    };

    const out: Hit[] = [];
    let cells = 0;
    let rows = 0;
    for (const [groupName, group] of Object.entries(file.groups)) {
      if (groupFilter !== '*' && groupFilter !== groupName) continue;
      rows += group.rows.length;
      const headingNames = group.headings.map((h) => h.name);
      const headingMatches = headingNames.filter(matches);
      for (let i = 0; i < group.rows.length; i++) {
        const row = group.rows[i]!;
        const locaId = String(row['LOCA_ID'] ?? '');
        cells += headingNames.length;

        for (const h of headingMatches) {
          if (out.length >= MAX_HITS) return { hits: out, truncated: true, totalRows: rows, totalCells: cells };
          out.push({
            group: groupName,
            rowIndex: i,
            heading: h,
            value: String(row[h] ?? ''),
            locaId,
          });
        }
        for (const h of headingNames) {
          const v = row[h];
          if (v == null) continue;
          const s = String(v);
          if (!matches(s)) continue;
          if (headingMatches.includes(h)) continue;
          if (out.length >= MAX_HITS) return { hits: out, truncated: true, totalRows: rows, totalCells: cells };
          out.push({ group: groupName, rowIndex: i, heading: h, value: s, locaId });
        }
      }
    }
    return { hits: out, truncated: false, totalRows: rows, totalCells: cells };
  }, [file, query, groupFilter, exact, caseSensitive]);

  // ── Saved searches ──────────────────────────────────────────────────────
  const scopeId = projectId ?? SESSION_PROJECT_ID;
  const [saved, setSaved] = useState<StoredSearch[]>([]);
  const [showSavePanel, setShowSavePanel] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getSavedSearches(scopeId).then((rows) => {
      if (active) setSaved(rows);
    }).catch(() => { /* IDB unavailable */ });
    return () => { active = false; };
  }, [scopeId]);

  const refresh = async () => {
    try {
      const rows = await getSavedSearches(scopeId);
      setSaved(rows);
    } catch {
      // ignore
    }
  };

  const handleSave = async () => {
    setSaveError(null);
    if (!saveName.trim()) {
      setSaveError('Name is required');
      return;
    }
    if (!query.trim()) {
      setSaveError('Enter a query first');
      return;
    }
    const now = Date.now();
    const entry: StoredSearch = {
      id: `${scopeId}-${now}-${Math.random().toString(36).slice(2, 8)}`,
      projectId: scopeId,
      name: saveName.trim(),
      query,
      groupFilter,
      exact,
      caseSensitive,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await saveSavedSearch(entry);
      await refresh();
      setSaveName('');
      setShowSavePanel(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleLoad = (s: StoredSearch) => {
    setQuery(s.query);
    setGroupFilter(s.groupFilter);
    setExact(s.exact);
    setCaseSensitive(s.caseSensitive);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteSavedSearch(id);
      await refresh();
    } catch {
      // ignore
    }
  };

  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
        Drop an AGS file above to search across every group.
      </div>
    );
  }
  if (!file) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--red)' }}>
        Failed to parse the AGS file.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', padding: 12,
      }}>
        <input
          type="search"
          autoFocus
          placeholder="Search heading or cell value…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            flex: '1 1 280px',
            padding: '8px 12px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontSize: 13,
            fontFamily: 'inherit',
          }}
        />

        <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={selectStyle}>
          <option value="*">All groups ({allGroups.length})</option>
          {allGroups.map((g) => (
            <option key={g} value={g}>{g} ({file.groups[g]?.rows.length ?? 0})</option>
          ))}
        </select>

        <label style={checkboxStyle}>
          <input type="checkbox" checked={exact} onChange={(e) => setExact(e.target.checked)} />
          Exact
        </label>
        <label style={checkboxStyle}>
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
          Aa
        </label>

        <button onClick={() => setShowSavePanel((v) => !v)} style={toolbarButton} disabled={query.trim().length === 0}>
          Save
        </button>

        {query.length > 0 && (
          <button onClick={() => setQuery('')} style={toolbarButtonGhost}>Clear</button>
        )}
      </div>

      {/* ── Save panel ─────────────────────────────────────────────────── */}
      {showSavePanel && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--accent-border)',
          borderRadius: 'var(--radius)', padding: 12,
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <input
            placeholder="Save current query as…"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
            style={{ flex: 1, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }}
          />
          <button onClick={() => void handleSave()} style={toolbarButton}>Save query</button>
          <button onClick={() => { setShowSavePanel(false); setSaveError(null); }} style={toolbarButtonGhost}>Cancel</button>
          {saveError && <span style={{ color: 'var(--red)', fontSize: 11 }}>{saveError}</span>}
        </div>
      )}

      {/* ── Saved searches strip ───────────────────────────────────────── */}
      {saved.length > 0 && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: 8,
          display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.3px', color: 'var(--muted)', marginRight: 4 }}>
            Saved:
          </span>
          {saved.map((s) => (
            <div key={s.id} style={savedChipStyle}>
              <button onClick={() => handleLoad(s)} title={`${s.query}${s.groupFilter !== '*' ? ` in ${s.groupFilter}` : ''}`} style={{
                background: 'transparent', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer',
              }}>
                {s.name}
              </button>
              <button onClick={() => void handleDelete(s.id)} title="Delete" style={chipDeleteStyle}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* ── Status line ────────────────────────────────────────────────── */}
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {query.length === 0
          ? <>Index: <strong>{totalRows.toLocaleString()}</strong> rows · <strong>{totalCells.toLocaleString()}</strong> cells</>
          : (
            <>
              <strong>{hits.length}</strong> hit{hits.length !== 1 ? 's' : ''}
              {truncated && <> (showing first {MAX_HITS} — refine to see more)</>}
              {' '} · scanned {totalRows.toLocaleString()} rows
            </>
          )}
      </div>

      {/* ── Results ───────────────────────────────────────────────────── */}
      {query.length > 0 && hits.length === 0 && (
        <div style={{
          padding: '40px 20px', textAlign: 'center', color: 'var(--muted)',
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
        }}>
          No matches.
        </div>
      )}

      {hits.length > 0 && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--surface-muted)' }}>
                <th style={thStyle}>Group</th>
                <th style={thStyle}>LOCA_ID</th>
                <th style={thStyle}>Row</th>
                <th style={thStyle}>Heading</th>
                <th style={thStyle}>Value</th>
                {onJumpToRow && <th style={thStyle}></th>}
              </tr>
            </thead>
            <tbody>
              {hits.map((h, ix) => (
                <tr key={ix} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={tdStyle}><code style={codeStyle}>{h.group}</code></td>
                  <td style={tdStyle}>{h.locaId || '—'}</td>
                  <td style={tdStyle}>{h.rowIndex + 1}</td>
                  <td style={tdStyle}><code style={codeStyle}>{h.heading}</code></td>
                  <td style={{ ...tdStyle, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={h.value}>
                    {highlightMatch(h.value, query, caseSensitive)}
                  </td>
                  {onJumpToRow && (
                    <td style={tdStyle}>
                      <button
                        onClick={() => onJumpToRow(h.group, h.rowIndex)}
                        style={jumpButtonStyle}
                      >
                        View →
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function highlightMatch(value: string, query: string, caseSensitive: boolean) {
  if (!query || !value) return value;
  const haystack = caseSensitive ? value : value.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const ix = haystack.indexOf(needle);
  if (ix < 0) return value;
  return (
    <>
      {value.slice(0, ix)}
      <mark style={{ background: 'var(--amber-soft)', color: 'var(--amber)', padding: '0 1px', borderRadius: 2 }}>
        {value.slice(ix, ix + query.length)}
      </mark>
      {value.slice(ix + query.length)}
    </>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  fontWeight: 700,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.3px',
  color: 'var(--text-dim)',
};
const tdStyle: React.CSSProperties = {
  padding: '6px 10px',
  color: 'var(--text)',
};
const codeStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11,
  background: 'var(--surface-muted)',
  padding: '1px 5px',
  borderRadius: 3,
};
const selectStyle: React.CSSProperties = {
  padding: '7px 10px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 13,
  background: 'var(--card)',
  fontFamily: 'inherit',
};
const checkboxStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: 'var(--text-dim)',
  cursor: 'pointer',
};
const jumpButtonStyle: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: 11,
  fontWeight: 600,
  background: 'var(--accent-soft)',
  color: 'var(--accent)',
  border: '1px solid var(--accent-border)',
  borderRadius: 4,
};
const toolbarButton: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 600,
  background: 'var(--accent-soft)',
  color: 'var(--accent)',
  border: '1px solid var(--accent-border)',
  borderRadius: 4,
};
const toolbarButtonGhost: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 600,
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text-dim)',
};
const savedChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 6px 4px 10px',
  fontSize: 11,
  fontWeight: 600,
  background: 'var(--accent-soft)',
  color: 'var(--accent)',
  border: '1px solid var(--accent-border)',
  borderRadius: 16,
};
const chipDeleteStyle: React.CSSProperties = {
  padding: '0 4px',
  fontSize: 14,
  lineHeight: 1,
  background: 'transparent',
  border: 'none',
  color: 'var(--muted)',
  cursor: 'pointer',
};
