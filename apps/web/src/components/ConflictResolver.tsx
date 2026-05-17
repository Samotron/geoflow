import { useState } from 'react';
import type { MergeResult, MergeConflict } from '../merge.js';
import type { AgsRow } from '../core.js';

interface Props {
  result: MergeResult;
  sourceName: string;
  onResolve: (resolved: MergeConflict[]) => void;
  onCancel: () => void;
}

type Side = 'ours' | 'theirs';

function norm(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Y' : 'N';
  return String(v);
}

function differingHeadings(a: AgsRow, b: AgsRow): string[] {
  const all = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...all].filter((k) => norm(a[k]) !== norm(b[k]));
}

export function ConflictResolver({ result, sourceName, onResolve, onCancel }: Props) {
  const { conflicts } = result;

  // Per-conflict choice: keyed by `${group}::${primaryKey}`
  const [choices, setChoices] = useState<Record<string, Side>>(() => {
    const init: Record<string, Side> = {};
    for (const c of conflicts) init[`${c.group}::${c.primaryKey}`] = 'theirs';
    return init;
  });

  function setChoice(conflict: MergeConflict, side: Side) {
    setChoices((prev) => ({ ...prev, [`${conflict.group}::${conflict.primaryKey}`]: side }));
  }

  function handleCommit() {
    const resolved = conflicts.map((c) => {
      const side = choices[`${c.group}::${c.primaryKey}`] ?? 'theirs';
      return { ...c, resolvedRow: side === 'ours' ? c.oursRow : c.theirsRow };
    });
    onResolve(resolved);
  }

  // Group conflicts by AGS group name
  const byGroup = conflicts.reduce<Record<string, MergeConflict[]>>((acc, c) => {
    (acc[c.group] ??= []).push(c);
    return acc;
  }, {});

  const oursCount = Object.values(choices).filter((v) => v === 'ours').length;
  const theirsCount = Object.values(choices).filter((v) => v === 'theirs').length;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--card)', borderRadius: 12, width: 'min(900px, 96vw)', height: 'min(700px, 94vh)', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.35)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ background: 'var(--navy)', color: '#fff', padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
          </svg>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Merge Conflicts — {sourceName}</div>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
              {conflicts.length} conflict{conflicts.length !== 1 ? 's' : ''} detected · auto-resolved to incoming file · review and adjust below
            </div>
          </div>
          <button onClick={onCancel} style={{ marginLeft: 'auto', background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
        </div>

        {/* Summary bar */}
        <div style={{ background: 'var(--surface-muted)', borderBottom: '1px solid var(--border)', padding: '10px 24px', display: 'flex', gap: 20, alignItems: 'center', fontSize: 13, flexShrink: 0 }}>
          <span style={{ color: 'var(--muted)' }}>Keeping current:</span>
          <strong style={{ color: 'var(--blue)' }}>{oursCount}</strong>
          <span style={{ color: 'var(--muted)' }}>Taking incoming:</span>
          <strong style={{ color: 'var(--green)' }}>{theirsCount}</strong>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              onClick={() => setChoices(Object.fromEntries(conflicts.map((c) => [`${c.group}::${c.primaryKey}`, 'ours' as Side])))}
              style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, background: 'var(--accent-soft)', color: 'var(--blue)', border: '1px solid var(--accent-border)', borderRadius: 6, cursor: 'pointer' }}
            >Take all current</button>
            <button
              onClick={() => setChoices(Object.fromEntries(conflicts.map((c) => [`${c.group}::${c.primaryKey}`, 'theirs' as Side])))}
              style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, background: 'var(--green-soft)', color: 'var(--green)', border: '1px solid var(--green-border)', borderRadius: 6, cursor: 'pointer' }}
            >Take all incoming</button>
          </div>
        </div>

        {/* Conflict list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
          {Object.entries(byGroup).map(([groupName, groupConflicts]) => (
            <div key={groupName} style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ background: 'var(--surface-muted)', padding: '2px 8px', borderRadius: 4, fontFamily: 'ui-monospace, monospace' }}>{groupName}</span>
                <span>{groupConflicts.length} conflict{groupConflicts.length !== 1 ? 's' : ''}</span>
              </div>

              {groupConflicts.map((conflict) => {
                const key = `${conflict.group}::${conflict.primaryKey}`;
                const choice = choices[key] ?? 'theirs';
                const diffHeadings = differingHeadings(conflict.oursRow, conflict.theirsRow)
                  .filter((h) => !conflict.primaryKeyHeadings.includes(h));

                return (
                  <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: 10, overflow: 'hidden' }}>
                    {/* Conflict header */}
                    <div style={{ background: 'var(--surface-muted)', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--border)' }}>
                      <code style={{ fontSize: 12, color: 'var(--navy)', fontFamily: 'ui-monospace, monospace', background: 'var(--accent-soft)', padding: '2px 8px', borderRadius: 4 }}>
                        {conflict.primaryKeyHeadings.join(' + ')}: {conflict.primaryKey.replace(/\0/g, ' · ')}
                      </code>
                      <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>
                        {diffHeadings.length} field{diffHeadings.length !== 1 ? 's' : ''} differ
                      </span>
                    </div>

                    {/* Side-by-side diff table */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
                      {/* Column headers */}
                      <div style={{ padding: '7px 14px', background: choice === 'ours' ? 'var(--accent-soft)' : 'var(--surface-muted)', borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="radio" checked={choice === 'ours'} onChange={() => setChoice(conflict, 'ours')} style={{ accentColor: 'var(--blue)' }} />
                        <span style={{ fontWeight: 700, color: choice === 'ours' ? 'var(--blue)' : 'var(--muted)', fontSize: 11 }}>Current (keep)</span>
                      </div>
                      <div style={{ padding: '7px 14px', background: choice === 'theirs' ? 'var(--green-soft)' : 'var(--surface-muted)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="radio" checked={choice === 'theirs'} onChange={() => setChoice(conflict, 'theirs')} style={{ accentColor: 'var(--green)' }} />
                        <span style={{ fontWeight: 700, color: choice === 'theirs' ? 'var(--green)' : 'var(--muted)', fontSize: 11 }}>Incoming — {sourceName}</span>
                      </div>

                      {/* Differing fields */}
                      {diffHeadings.map((heading, i) => {
                        const oursVal = norm(conflict.oursRow[heading]);
                        const theirsVal = norm(conflict.theirsRow[heading]);
                        const rowBg = i % 2 === 0 ? 'var(--surface-muted)' : '#fff';
                        return [
                          <div key={`o-${heading}`} style={{ padding: '6px 14px', background: choice === 'ours' ? 'var(--accent-soft)' : rowBg, borderBottom: '1px solid var(--surface-muted)', borderRight: '1px solid var(--border)' }}>
                            <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>{heading}</div>
                            <div style={{ color: oursVal ? 'var(--text)' : 'var(--border-strong)', fontStyle: oursVal ? undefined : 'italic' }}>{oursVal || '—'}</div>
                          </div>,
                          <div key={`t-${heading}`} style={{ padding: '6px 14px', background: choice === 'theirs' ? 'var(--green-soft)' : rowBg, borderBottom: '1px solid var(--surface-muted)' }}>
                            <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>{heading}</div>
                            <div style={{ color: theirsVal ? 'var(--text)' : 'var(--border-strong)', fontStyle: theirsVal ? undefined : 'italic' }}>{theirsVal || '—'}</div>
                          </div>,
                        ];
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid var(--border)', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface-muted)', flexShrink: 0 }}>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            Non-conflicting rows from both files have already been merged.
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={onCancel} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: 'var(--surface-muted)', color: 'var(--muted)', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleCommit} style={{ padding: '8px 20px', fontSize: 13, fontWeight: 700, background: 'var(--navy)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              Commit merge
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
