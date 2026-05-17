import { useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { decodeBytes, parseStr, diffFiles, diffToSummary, isIdentical } from '../core.js';
import type { AgsFile, DiffResult, GroupDiff } from '../core.js';
import { DropZone } from '../App.js';

interface FileSlot {
  name: string;
  bytes: Uint8Array;
  text: string;
  parsed: AgsFile;
}

type ViewMode = 'summary' | 'split' | 'unified';

export function DiffTab() {
  const [fileA, setFileA] = useState<FileSlot | null>(null);
  const [fileB, setFileB] = useState<FileSlot | null>(null);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [identical, setIdentical] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('summary');

  const loadFile = (slot: 'a' | 'b') => (name: string, bytes: Uint8Array) => {
    try {
      const text = decodeBytes(bytes);
      const parsed = parseStr(text);
      const entry = { name, bytes, text, parsed: parsed.file };
      if (slot === 'a') setFileA(entry);
      else setFileB(entry);
      setDiffResult(null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const runDiff = () => {
    if (!fileA || !fileB) return;
    setRunning(true);
    setError(null);
    try {
      const result = diffFiles(fileA.parsed, fileB.parsed);
      setIdentical(isIdentical(result));
      setDiffResult(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const summary = diffResult ? diffToSummary(diffResult) : null;

  const pillStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 14px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: active ? 'var(--navy)' : 'var(--card)',
    color: active ? '#fff' : 'var(--muted)',
    cursor: 'pointer',
  });

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>File A</div>
          <DropZone onFile={loadFile('a')} fileName={fileA?.name} fileSize={fileA?.bytes.length} label="File A" />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>File B</div>
          <DropZone onFile={loadFile('b')} fileName={fileB?.name} fileSize={fileB?.bytes.length} label="File B" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <button
          onClick={runDiff}
          disabled={!fileA || !fileB || running}
          style={{ background: 'var(--navy)', color: '#fff', opacity: !fileA || !fileB || running ? 0.4 : 1 }}
        >
          {running ? 'Comparing…' : 'Compare Files'}
        </button>
        {diffResult && (
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button style={pillStyle(viewMode === 'summary')} onClick={() => setViewMode('summary')}>Summary</button>
            <button style={pillStyle(viewMode === 'split')} onClick={() => setViewMode('split')}>Side by Side</button>
            <button style={pillStyle(viewMode === 'unified')} onClick={() => setViewMode('unified')}>Unified</button>
          </div>
        )}
      </div>

      {error && (
        <div style={{ background: 'var(--red-soft)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)', marginBottom: 16 }}>
          {error}
        </div>
      )}

      {diffResult !== null && identical && (
        <div style={{ background: 'var(--green-soft)', border: '1px solid var(--green-border)', borderRadius: 'var(--radius)', padding: '20px 24px', textAlign: 'center', color: 'var(--green)', fontWeight: 600 }}>
          ✓ Files are identical
        </div>
      )}

      {/* ── Summary view ── */}
      {diffResult !== null && !identical && viewMode === 'summary' && summary && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(summary.only_in_a.length > 0 || summary.only_in_b.length > 0) && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', background: 'var(--surface-muted)', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)' }}>
                Groups only in one file
              </div>
              <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {summary.only_in_a.map((g) => (
                  <div key={g} style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'monospace', fontSize: 13 }}>
                    <span style={{ color: 'var(--red)', fontWeight: 700, fontSize: 15, lineHeight: 1 }}>−</span>
                    <span style={{ fontWeight: 600 }}>{g}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}>only in {fileA?.name ?? 'A'}</span>
                  </div>
                ))}
                {summary.only_in_b.map((g) => (
                  <div key={g} style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'monospace', fontSize: 13 }}>
                    <span style={{ color: 'var(--green)', fontWeight: 700, fontSize: 15, lineHeight: 1 }}>+</span>
                    <span style={{ fontWeight: 600 }}>{g}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}>only in {fileB?.name ?? 'B'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {summary.groups.map((g) => {
            const hasChanges = g.rows_added > 0 || g.rows_removed > 0 || g.rows_modified > 0;
            if (!hasChanges) return null;
            const groupDetail = diffResult.group_diffs.find((gd) => gd.group === g.group);
            return (
              <GroupDiffCard
                key={g.group}
                group={g.group}
                added={g.rows_added}
                removed={g.rows_removed}
                modified={g.rows_modified}
                unchanged={g.rows_unchanged}
                groupDetail={groupDetail}
              />
            );
          })}
        </div>
      )}

      {/* ── Text diff views (react-diff-viewer-continued) ── */}
      {diffResult !== null && !identical && (viewMode === 'split' || viewMode === 'unified') && fileA && fileB && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', fontSize: 12 }}>
          <ReactDiffViewer
            oldValue={fileA.text}
            newValue={fileB.text}
            splitView={viewMode === 'split'}
            leftTitle={fileA.name}
            rightTitle={viewMode === 'split' ? fileB.name : undefined}
            compareMethod={DiffMethod.LINES}
            showDiffOnly
            extraLinesSurroundingDiff={3}
            useDarkTheme={false}
            styles={{
              variables: {
                light: {
                  addedBackground: 'var(--green-soft)',
                  addedColor: 'var(--green)',
                  removedBackground: 'var(--red-soft)',
                  removedColor: 'var(--red)',
                  wordAddedBackground: 'var(--green-border)',
                  wordRemovedBackground: 'var(--red-border)',
                  addedGutterBackground: 'var(--green-soft)',
                  removedGutterBackground: 'var(--red-soft)',
                  gutterBackground: 'var(--surface-muted)',
                  gutterBackgroundDark: 'var(--surface-muted)',
                  highlightBackground: 'var(--amber-soft)',
                  highlightGutterBackground: 'var(--amber-soft)',
                  codeFoldGutterBackground: 'var(--border)',
                  codeFoldBackground: 'var(--surface-muted)',
                },
              },
            }}
          />
        </div>
      )}

      {!fileA && !fileB && (
        <div style={{ textAlign: 'center', padding: '24px 24px', color: 'var(--muted)', fontSize: 13 }}>
          Drop two AGS files above to compare them.
        </div>
      )}
    </div>
  );
}

interface GroupDiffCardProps {
  group: string;
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  groupDetail: GroupDiff | undefined;
}

type GroupView = 'list' | 'table';

function GroupDiffCard({ group, added, removed, modified, unchanged, groupDetail }: GroupDiffCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [groupView, setGroupView] = useState<GroupView>('list');

  const totalChanged = added + removed + modified;

  const pillStyle = (active: boolean): React.CSSProperties => ({
    padding: '2px 8px', fontSize: 10, fontWeight: 600, borderRadius: 4,
    border: '1px solid var(--border)',
    background: active ? 'var(--navy)' : 'var(--surface-muted)',
    color: active ? '#fff' : 'var(--muted)',
    cursor: 'pointer',
  });

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <div
        onClick={() => setExpanded((e) => !e)}
        style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', background: 'var(--surface-muted)', borderBottom: expanded ? '1px solid var(--border)' : undefined }}
      >
        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>{group}</span>
        <div style={{ display: 'flex', gap: 8, fontSize: 12 }}>
          {added > 0 && <span style={{ color: 'var(--green)', fontWeight: 600 }}>+{added}</span>}
          {removed > 0 && <span style={{ color: 'var(--red)', fontWeight: 600 }}>−{removed}</span>}
          {modified > 0 && <span style={{ color: 'var(--amber)', fontWeight: 600 }}>~{modified}</span>}
          {unchanged > 0 && <span style={{ color: 'var(--muted)' }}>{unchanged} unchanged</span>}
        </div>
        {expanded && (
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }} onClick={e => e.stopPropagation()}>
            <button
              style={{ ...pillStyle(groupView === 'list'), padding: '2px 8px', fontSize: 10 }}
              onClick={() => setGroupView('list')}
            >List</button>
            <button
              style={{ ...pillStyle(groupView === 'table'), padding: '2px 8px', fontSize: 10 }}
              onClick={() => setGroupView('table')}
            >Table</button>
          </div>
        )}
        <span style={{ marginLeft: expanded ? 0 : 'auto', color: 'var(--muted)', fontSize: 12 }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && groupDetail && groupView === 'list' && (
        <div style={{ fontSize: 12, fontFamily: 'monospace' }}>
          {groupDetail.rows_added.map((row, i) => (
            <div key={`add-${i}`} style={{ padding: '6px 16px', background: 'var(--green-soft)', borderBottom: '1px solid var(--green-soft)', color: 'var(--green)' }}>
              <span style={{ fontWeight: 700, marginRight: 8 }}>+</span>
              {Object.entries(row).slice(0, 4).map(([k, v]) => `${k}=${String(v ?? '')}`).join('  ')}
            </div>
          ))}
          {groupDetail.rows_removed.map((row, i) => (
            <div key={`rem-${i}`} style={{ padding: '6px 16px', background: 'var(--red-soft)', borderBottom: '1px solid var(--red-border)', color: 'var(--red)' }}>
              <span style={{ fontWeight: 700, marginRight: 8 }}>−</span>
              {Object.entries(row).slice(0, 4).map(([k, v]) => `${k}=${String(v ?? '')}`).join('  ')}
            </div>
          ))}
          {groupDetail.rows_changed.map((change, i) => (
            <div key={`chg-${i}`} style={{ borderBottom: '1px solid var(--surface-muted)' }}>
              <div style={{ padding: '6px 16px', background: 'var(--amber-soft)', color: 'var(--amber)', fontWeight: 600 }}>
                ~ {change.key}
              </div>
              {change.changes.map((fc, j) => (
                <div key={j} style={{ padding: '4px 32px', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ color: 'var(--muted)', minWidth: 120 }}>{fc.heading}</span>
                  <span style={{ color: 'var(--red)', textDecoration: 'line-through' }}>{fc.before}</span>
                  <span style={{ color: 'var(--muted)' }}>→</span>
                  <span style={{ color: 'var(--green)' }}>{fc.after}</span>
                </div>
              ))}
            </div>
          ))}
          {totalChanged === 0 && (
            <div style={{ padding: '12px 16px', color: 'var(--muted)', textAlign: 'center' }}>No row-level changes</div>
          )}
        </div>
      )}

      {expanded && groupDetail && groupView === 'table' && (
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {groupDetail.rows_changed.map((change, i) => (
            <div key={`tbl-chg-${i}`} style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ padding: '5px 12px', background: 'var(--amber-soft)', fontSize: 11, fontWeight: 700, color: 'var(--amber)', borderBottom: '1px solid var(--border)' }}>
                ~ {change.key}
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
                <thead>
                  <tr>
                    <th style={{ padding: '5px 12px', textAlign: 'left', background: 'var(--surface-muted)', borderBottom: '1px solid var(--border)', width: '33%', fontWeight: 600 }}>Field</th>
                    <th style={{ padding: '5px 12px', textAlign: 'left', background: 'var(--red-soft)', borderBottom: '1px solid var(--border)', width: '33%', fontWeight: 600, color: 'var(--red)' }}>File A</th>
                    <th style={{ padding: '5px 12px', textAlign: 'left', background: 'var(--green-soft)', borderBottom: '1px solid var(--border)', width: '33%', fontWeight: 600, color: 'var(--green)' }}>File B</th>
                  </tr>
                </thead>
                <tbody>
                  {change.changes.map((fc, j) => (
                    <tr key={j}>
                      <td style={{ padding: '4px 12px', borderBottom: '1px solid var(--surface-muted)', color: 'var(--muted)' }}>{fc.heading}</td>
                      <td style={{ padding: '4px 12px', borderBottom: '1px solid var(--surface-muted)', background: 'var(--red-soft)', color: 'var(--red)' }}>{fc.before}</td>
                      <td style={{ padding: '4px 12px', borderBottom: '1px solid var(--surface-muted)', background: 'var(--green-soft)', color: 'var(--green)' }}>{fc.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {groupDetail.rows_added.map((row, i) => (
            <div key={`tbl-add-${i}`} style={{ border: '1px solid var(--green-border)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ padding: '5px 12px', background: 'var(--green-soft)', fontSize: 11, fontWeight: 700, color: 'var(--green)', borderBottom: '1px solid var(--green-border)' }}>
                + Added row
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
                <thead>
                  <tr>
                    <th style={{ padding: '4px 12px', textAlign: 'left', background: 'var(--surface-muted)', borderBottom: '1px solid var(--green-soft)', width: '40%' }}>Field</th>
                    <th style={{ padding: '4px 12px', textAlign: 'left', background: 'var(--green-soft)', borderBottom: '1px solid var(--green-soft)', color: 'var(--green)' }}>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(row).map(([k, v], j) => (
                    <tr key={j}><td style={{ padding: '3px 12px', borderBottom: '1px solid var(--green-soft)', color: 'var(--muted)' }}>{k}</td><td style={{ padding: '3px 12px', borderBottom: '1px solid var(--green-soft)', color: 'var(--green)' }}>{String(v ?? '')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {groupDetail.rows_removed.map((row, i) => (
            <div key={`tbl-rem-${i}`} style={{ border: '1px solid var(--red-border)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ padding: '5px 12px', background: 'var(--red-soft)', fontSize: 11, fontWeight: 700, color: 'var(--red)', borderBottom: '1px solid var(--red-border)' }}>
                − Removed row
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
                <thead>
                  <tr>
                    <th style={{ padding: '4px 12px', textAlign: 'left', background: 'var(--surface-muted)', borderBottom: '1px solid var(--red-border)', width: '40%' }}>Field</th>
                    <th style={{ padding: '4px 12px', textAlign: 'left', background: 'var(--red-soft)', borderBottom: '1px solid var(--red-border)', color: 'var(--red)' }}>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(row).map(([k, v], j) => (
                    <tr key={j}><td style={{ padding: '3px 12px', borderBottom: '1px solid var(--red-soft)', color: 'var(--muted)' }}>{k}</td><td style={{ padding: '3px 12px', borderBottom: '1px solid var(--red-soft)', color: 'var(--red)' }}>{String(v ?? '')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {totalChanged === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12, padding: 12 }}>No row-level changes</div>
          )}
        </div>
      )}
    </div>
  );
}
