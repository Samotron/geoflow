import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  decodeBytes,
  parseStr,
  validate,
  Registry,
  assessQuality,
  serialize,
  fixBytes,
  AgsTypeFunctions,
} from '../core.js';
import type {
  AgsFile,
  AgsGroup,
  AgsRow,
  AgsValue,
  AgsType,
  Diagnostic,
  QualityReport,
} from '../core.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface EditEntry {
  id: string;
  timestamp: string;
  group: string;
  heading: string;
  rowIndex: number;
  oldValue: AgsValue;
  newValue: AgsValue;
}

interface EditingCell {
  group: string;
  rowIndex: number;
  heading: string;
  draft: string;
}

interface Props {
  fileBytes: Uint8Array | null;
  fileName?: string | undefined;
  onAutoCommit?: ((bytes: Uint8Array, editCount: number) => void) | undefined;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Maps quality rule IDs to the heading name they most directly concern,
// enabling per-cell highlighting in the table.
const RULE_TO_HEADING: Record<string, string> = {
  'QUAL-COMP-001': 'PROJ_NAME',
  'QUAL-COMP-002': 'PROJ_LOC',
  'QUAL-COMP-003': 'TRAN_DATE',
  'QUAL-COMP-004': 'LOCA_FDEP',
  'QUAL-COMP-006': 'GEOL_DESC',
  'QUAL-DESC-001': 'GEOL_DESC',
  'QUAL-DESC-002': 'ABBR_DESC',
  'QUAL-DESC-003': 'SAMP_TYPE',
  'QUAL-RANGE-001': 'ISPT_NVAL',
  'QUAL-RANGE-003': 'LOCA_FDEP',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function optVal<T>(opt: { _tag: string; value?: T }): T | null {
  if (opt._tag !== 'Some') return null;
  return (opt as { _tag: 'Some'; value: T }).value;
}

function sevColor(sev: string): string {
  if (sev === 'error') return 'var(--red)';
  if (sev === 'warning') return 'var(--orange)';
  return 'var(--accent)';
}

function sevBg(sev: string): string {
  if (sev === 'error') return 'var(--red-soft)';
  if (sev === 'warning') return 'var(--orange-soft)';
  return 'var(--accent-soft)';
}

function worstSev(diags: Diagnostic[]): string {
  if (diags.some((d) => d.severity === 'error')) return 'error';
  if (diags.some((d) => d.severity === 'warning')) return 'warning';
  if (diags.length > 0) return 'info';
  return '';
}

function scoreColor(score: number): string {
  if (score >= 90) return 'var(--green)';
  if (score >= 75) return 'var(--accent)';
  if (score >= 60) return 'var(--amber)';
  if (score >= 40) return 'var(--orange)';
  return 'var(--red)';
}

function coerceValue(raw: string, type?: AgsType): AgsValue {
  const t = raw.trim();
  if (t === '') return null;
  if (type !== undefined && AgsTypeFunctions.isNumeric(type)) {
    const n = parseFloat(t);
    if (!isNaN(n)) return n;
  }
  if (type === 'YN') {
    if (t.toUpperCase() === 'Y') return true;
    if (t.toUpperCase() === 'N') return false;
  }
  return t;
}

function displayVal(v: AgsValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Y' : 'N';
  return String(v);
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({ score, label }: { score: number; label: string }) {
  return (
    <div style={{ width: 140 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${score}%`, background: scoreColor(score), borderRadius: 99, transition: 'width 0.4s ease, background 0.4s ease' }} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color: scoreColor(score), minWidth: 32 }}>{score}</span>
      </div>
    </div>
  );
}

// ── Issues sidebar ────────────────────────────────────────────────────────────

interface IssuesSidebarProps {
  diagnostics: Diagnostic[];
  focusedKey: string | null;
  onSelect: (d: Diagnostic) => void;
}

function IssuesSidebar({ diagnostics, focusedKey, onSelect }: IssuesSidebarProps) {
  const [filter, setFilter] = useState<'all' | 'error' | 'warning' | 'info'>('all');

  const counts = {
    error: diagnostics.filter((d) => d.severity === 'error').length,
    warning: diagnostics.filter((d) => d.severity === 'warning').length,
    info: diagnostics.filter((d) => d.severity === 'info').length,
  };
  const visible = filter === 'all' ? diagnostics : diagnostics.filter((d) => d.severity === filter);

  const pill = (active: boolean): React.CSSProperties => ({
    padding: '2px 8px',
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 99,
    border: `1px solid ${active ? 'var(--navy)' : 'var(--border)'}`,
    background: active ? 'var(--navy)' : 'var(--card)',
    color: active ? '#fff' : 'var(--muted)',
    cursor: 'pointer',
  });

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)', flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6 }}>
          Issues ({diagnostics.length})
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={pill(filter === 'all')} onClick={() => setFilter('all')}>ALL</button>
          <button style={{ ...pill(filter === 'error'), color: filter === 'error' ? '#fff' : 'var(--red)' }} onClick={() => setFilter('error')}>ERR {counts.error}</button>
          <button style={{ ...pill(filter === 'warning'), color: filter === 'warning' ? '#fff' : 'var(--orange)' }} onClick={() => setFilter('warning')}>WARN {counts.warning}</button>
          <button style={{ ...pill(filter === 'info'), color: filter === 'info' ? '#fff' : 'var(--accent)' }} onClick={() => setFilter('info')}>INFO {counts.info}</button>
        </div>
      </div>
      {/* List */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {visible.length === 0 && diagnostics.length === 0 && (
          <div style={{ padding: '20px 12px', textAlign: 'center', color: 'var(--green)', fontWeight: 600, fontSize: 13 }}>
            ✓ All issues resolved
          </div>
        )}
        {visible.length === 0 && diagnostics.length > 0 && (
          <div style={{ padding: '16px 12px', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
            No issues match filter
          </div>
        )}
        {visible.map((d, i) => {
          const group = optVal(d.location.group);
          const rowIdx = optVal(d.location.row_index);
          const key = group && rowIdx !== null ? `${group}:${rowIdx}` : null;
          const isFocused = key !== null && key === focusedKey;
          return (
            <button
              key={i}
              onClick={() => onSelect(d)}
              style={{
                width: '100%',
                display: 'block',
                textAlign: 'left',
                padding: '8px 12px',
                background: isFocused ? sevBg(d.severity) : 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--surface-muted)',
                borderLeft: `3px solid ${isFocused ? sevColor(d.severity) : 'transparent'}`,
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'background 0.1s',
              }}
            >
              <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 3, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: sevColor(d.severity) }}>
                  {d.severity === 'error' ? 'ERR' : d.severity === 'warning' ? 'WARN' : 'INFO'}
                </span>
                <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>{d.rule_id}</span>
                {group && (
                  <span style={{ fontSize: 9, color: 'var(--muted)', background: 'var(--surface-muted)', padding: '1px 5px', borderRadius: 99, fontFamily: 'ui-monospace, monospace' }}>
                    {group}{rowIdx !== null ? ` ·${rowIdx}` : ''}
                  </span>
                )}
                {d.fix_id._tag === 'Some' && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--green)', background: 'var(--green-soft)', padding: '1px 5px', borderRadius: 99, border: '1px solid var(--green-border)' }}>
                    ⚡ auto-fixable
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.4 }}>{d.message}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Edit history panel ────────────────────────────────────────────────────────

function EditHistoryPanel({ history, onUndo }: { history: EditEntry[]; onUndo: () => void }) {
  const [open, setOpen] = useState(false);
  if (history.length === 0) return null;

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          background: 'none',
          border: 'none',
          borderRadius: 0,
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>
          Edit History
        </span>
        <span style={{ fontSize: 11, background: 'var(--blue)', color: '#fff', borderRadius: 99, padding: '1px 7px', fontWeight: 700 }}>
          {history.length}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onUndo(); }}
          style={{ padding: '3px 10px', fontSize: 11, background: 'var(--red-soft)', color: 'var(--red)', border: '1px solid var(--red-border)', borderRadius: 4, fontWeight: 600 }}
        >
          ↩ Undo
        </button>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', maxHeight: 200, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
            <thead>
              <tr style={{ background: 'var(--surface-muted)' }}>
                {['Time', 'Group', 'Heading', 'Row', 'Old', 'New'].map((h) => (
                  <th key={h} style={{ padding: '5px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...history].reverse().map((e) => (
                <tr key={e.id} style={{ borderBottom: '1px solid var(--surface-muted)' }}>
                  <td style={{ padding: '4px 10px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>{e.timestamp.slice(11, 19)}</td>
                  <td style={{ padding: '4px 10px' }}>{e.group}</td>
                  <td style={{ padding: '4px 10px', color: 'var(--blue)' }}>{e.heading}</td>
                  <td style={{ padding: '4px 10px', color: 'var(--muted)' }}>{e.rowIndex}</td>
                  <td style={{ padding: '4px 10px', color: 'var(--red)', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayVal(e.oldValue) || <span style={{ fontStyle: 'italic' }}>empty</span>}
                  </td>
                  <td style={{ padding: '4px 10px', color: 'var(--green)', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayVal(e.newValue) || <span style={{ fontStyle: 'italic' }}>empty</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Editable table ────────────────────────────────────────────────────────────

interface EditableTableProps {
  groupName: string;
  group: AgsGroup;
  rowIssueMap: Map<string, Diagnostic[]>;
  editingCell: EditingCell | null;
  focusedRowKey: string | null;
  focusedCellHeading: string | null;
  rowRefs: React.MutableRefObject<Map<string, HTMLTableRowElement>>;
  onCellClick: (rowIndex: number, heading: string, currentVal: AgsValue) => void;
  onDraftChange: (draft: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function EditableTable({
  groupName,
  group,
  rowIssueMap,
  editingCell,
  focusedRowKey,
  focusedCellHeading,
  rowRefs,
  onCellClick,
  onDraftChange,
  onCommit,
  onCancel,
}: EditableTableProps) {
  if (group.rows.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
        No data rows in {groupName}
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 340px)', minHeight: 200 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
        <thead>
          <tr style={{ background: 'var(--surface-muted)', position: 'sticky', top: 0, zIndex: 2 }}>
            <th style={thStyle}>#</th>
            {group.headings.map((h) => (
              <th key={h.name} style={thStyle}>
                <div style={{ color: 'var(--navy)' }}>{h.name}</div>
                {h.unit && <div style={{ fontWeight: 400, fontSize: 9, color: 'var(--muted)', textTransform: 'none', letterSpacing: 0 }}>{h.unit}</div>}
                <div style={{ fontWeight: 400, fontSize: 9, color: 'var(--muted)', textTransform: 'none', letterSpacing: 0 }}>
                  {AgsTypeFunctions.toString(h.data_type)}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {group.rows.map((row, rowIdx) => {
            const rowKey = `${groupName}:${rowIdx}`;
            const rowDiags = rowIssueMap.get(rowKey) ?? [];
            const worst = worstSev(rowDiags);
            const isFocused = focusedRowKey === rowKey;

            return (
              <tr
                key={rowIdx}
                ref={(el) => {
                  if (el) rowRefs.current.set(rowKey, el);
                  else rowRefs.current.delete(rowKey);
                }}
                style={{
                  borderLeft: worst ? `4px solid ${sevColor(worst)}` : '4px solid transparent',
                  background: isFocused ? 'var(--accent-soft)' : rowIdx % 2 === 0 ? 'var(--card)' : 'var(--surface-muted)',
                  transition: 'background 0.25s',
                }}
              >
                <td style={{ padding: '5px 8px', color: 'var(--muted)', borderBottom: '1px solid var(--surface-muted)', userSelect: 'none', fontSize: 10, textAlign: 'right' }}>{rowIdx}</td>
                {group.headings.map((h) => {
                  const cellVal: AgsValue = (row as Record<string, AgsValue>)[h.name] ?? null;
                  const isEditing =
                    editingCell !== null &&
                    editingCell.group === groupName &&
                    editingCell.rowIndex === rowIdx &&
                    editingCell.heading === h.name;

                  // Highlight cell if a rule maps directly to this heading
                  const cellDiags = rowDiags.filter((d) => RULE_TO_HEADING[d.rule_id] === h.name);
                  const cellWorst = worstSev(cellDiags);
                  const isFocusedCell = isFocused && focusedCellHeading === h.name && !isEditing;

                  return (
                    <td
                      key={h.name}
                      onClick={() => {
                        if (!isEditing) onCellClick(rowIdx, h.name, cellVal);
                      }}
                      title={cellWorst ? `${cellDiags.map((d) => d.message).join(' | ')}` : undefined}
                      style={{
                        padding: '5px 8px',
                        borderBottom: '1px solid var(--surface-muted)',
                        cursor: 'text',
                        maxWidth: 220,
                        background: isFocusedCell ? 'var(--accent-soft)' : cellWorst ? sevBg(cellWorst) : undefined,
                        outline: isFocusedCell ? '2px solid var(--accent)' : cellWorst ? `1px solid ${sevColor(cellWorst)}55` : undefined,
                        outlineOffset: isFocusedCell ? -2 : -1,
                        boxShadow: isFocusedCell ? '0 0 0 3px rgba(37,99,235,0.2)' : undefined,
                        position: 'relative',
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editingCell!.draft}
                          onChange={(e) => onDraftChange(e.target.value)}
                          onBlur={onCommit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
                            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                          }}
                          style={{
                            width: '100%',
                            minWidth: 80,
                            border: '1px solid var(--blue)',
                            borderRadius: 3,
                            padding: '2px 5px',
                            fontFamily: 'inherit',
                            fontSize: 12,
                            background: 'var(--accent-soft)',
                            outline: '2px solid rgba(26,64,128,0.25)',
                          }}
                        />
                      ) : (
                        <span style={{
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: cellVal === null ? 'var(--border-strong)' : 'var(--text)',
                          fontStyle: cellVal === null ? 'italic' : undefined,
                        }}>
                          {cellVal === null ? '—' : displayVal(cellVal)}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '7px 8px',
  textAlign: 'left',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: 'var(--muted)',
  borderBottom: '2px solid var(--border)',
  whiteSpace: 'nowrap',
  verticalAlign: 'bottom',
};

// ── Auto-fix helpers ──────────────────────────────────────────────────────────

interface FixNotice {
  applied: string[];
  editCount: number;
}

// Diffs two AgsFiles cell-by-cell and returns EditEntry records for each change.
function diffAgsFilesForHistory(before: AgsFile, after: AgsFile): EditEntry[] {
  const edits: EditEntry[] = [];
  const now = new Date().toISOString();
  for (const [groupName, afterGroup] of Object.entries(after.groups)) {
    const beforeGroup = before.groups[groupName];
    if (!beforeGroup) {
      // Group added by a fixer (e.g. populate-tran-group)
      edits.push({ id: crypto.randomUUID(), timestamp: now, group: groupName, heading: '[group created]', rowIndex: -1, oldValue: null, newValue: `${afterGroup.rows.length} row(s)` });
      continue;
    }
    const rowCount = Math.min(beforeGroup.rows.length, afterGroup.rows.length);
    for (let i = 0; i < rowCount; i++) {
      const br = beforeGroup.rows[i] as Record<string, AgsValue>;
      const ar = afterGroup.rows[i] as Record<string, AgsValue>;
      if (!br || !ar) continue;
      for (const h of afterGroup.headings) {
        const bv: AgsValue = br[h.name] ?? null;
        const av: AgsValue = ar[h.name] ?? null;
        if (displayVal(bv) !== displayVal(av)) {
          edits.push({ id: crypto.randomUUID(), timestamp: now, group: groupName, heading: h.name, rowIndex: i, oldValue: bv, newValue: av });
        }
      }
    }
  }
  return edits;
}

// ── Main EditTab ───────────────────────────────────────────────────────────────

export function EditTab({ fileBytes, fileName, onAutoCommit }: Props) {
  const [agsFile, setAgsFile] = useState<AgsFile | null>(null);
  const [editHistory, setEditHistory] = useState<EditEntry[]>([]);
  const [initialMetrics, setInitialMetrics] = useState<{ score: number; count: number } | null>(null);
  const [activeGroup, setActiveGroup] = useState<string>('');
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [focusedCellHeading, setFocusedCellHeading] = useState<string | null>(null);
  const [fixNotice, setFixNotice] = useState<FixNotice | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'pending' | 'saved'>('idle');
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  // Auto-commit: fire onAutoCommit 30 s after the last edit, using refs to
  // avoid stale closures without needing useCallback dependencies.
  const autoCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAutoCommitRef = useRef(onAutoCommit);
  useEffect(() => { onAutoCommitRef.current = onAutoCommit; }, [onAutoCommit]);
  const latestAgsFileRef = useRef(agsFile);
  useEffect(() => { latestAgsFileRef.current = agsFile; }, [agsFile]);
  const latestEditCountRef = useRef(0);
  useEffect(() => { latestEditCountRef.current = editHistory.length; }, [editHistory]);

  const scheduleAutoCommit = useCallback(() => {
    if (!onAutoCommitRef.current) return;
    setAutoSaveStatus('pending');
    if (autoCommitTimerRef.current) clearTimeout(autoCommitTimerRef.current);
    autoCommitTimerRef.current = setTimeout(() => {
      const file = latestAgsFileRef.current;
      const count = latestEditCountRef.current;
      const cb = onAutoCommitRef.current;
      if (file && count > 0 && cb) {
        cb(new TextEncoder().encode(serialize(file)), count);
        setAutoSaveStatus('saved');
        setTimeout(() => setAutoSaveStatus('idle'), 4000);
      }
    }, 30_000);
  }, []);

  // Parse on file change
  useEffect(() => {
    if (!fileBytes) {
      setAgsFile(null);
      setEditHistory([]);
      setInitialMetrics(null);
      setActiveGroup('');
      setEditingCell(null);
      setFocusedRowKey(null);
      return;
    }
    const text = decodeBytes(fileBytes);
    const { file } = parseStr(text);
    setAgsFile(file);
    setEditHistory([]);
    setEditingCell(null);
    setFocusedRowKey(null);

    const report = assessQuality(file);
    const valDiags = validate(file, Registry.standard());
    setInitialMetrics({
      score: report.overall_score,
      count: report.all_diagnostics.length + valDiags.length,
    });

    const firstGroup = Object.keys(file.groups)[0] ?? '';
    setActiveGroup(firstGroup);
  }, [fileBytes]);

  // All diagnostics (validation + quality), re-computed whenever agsFile changes
  const allDiagnostics = useMemo((): Diagnostic[] => {
    if (!agsFile) return [];
    return [...validate(agsFile, Registry.standard()), ...assessQuality(agsFile).all_diagnostics];
  }, [agsFile]);

  const qualityReport = useMemo((): QualityReport | null => {
    if (!agsFile) return null;
    return assessQuality(agsFile);
  }, [agsFile]);

  // Group-indexed issue map for row highlighting: `${group}:${rowIdx}` → Diagnostic[]
  const rowIssueMap = useMemo(() => {
    const map = new Map<string, Diagnostic[]>();
    for (const d of allDiagnostics) {
      const g = optVal(d.location.group);
      const r = optVal(d.location.row_index);
      if (g !== null && r !== null) {
        const k = `${g}:${r}`;
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(d);
      }
    }
    return map;
  }, [allDiagnostics]);

  // Issue count per group (for tab badges)
  const groupIssueCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of allDiagnostics) {
      const g = optVal(d.location.group);
      if (g) map.set(g, (map.get(g) ?? 0) + 1);
    }
    return map;
  }, [allDiagnostics]);

  // Commit a cell edit to agsFile and record in history
  const commitEdit = useCallback(
    (group: string, rowIndex: number, heading: string, draft: string) => {
      setEditingCell(null);
      if (!agsFile) return;
      const grp = agsFile.groups[group];
      if (!grp) return;
      const row = grp.rows[rowIndex];
      if (!row) return;

      const headingDef = grp.headings.find((h) => h.name === heading);
      const oldValue: AgsValue = (row as Record<string, AgsValue>)[heading] ?? null;
      const newValue: AgsValue = coerceValue(draft, headingDef?.data_type);

      if (displayVal(oldValue) === displayVal(newValue)) return;

      const newRows: AgsRow[] = grp.rows.map((r, i) =>
        i === rowIndex ? ({ ...r, [heading]: newValue } as AgsRow) : r
      );
      const newGroup: AgsGroup = { ...grp, rows: newRows };
      const newFile: AgsFile = { ...agsFile, groups: { ...agsFile.groups, [group]: newGroup } };

      setAgsFile(newFile);
      setEditHistory((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          group,
          heading,
          rowIndex,
          oldValue,
          newValue,
        },
      ]);
      scheduleAutoCommit();
    },
    [agsFile, scheduleAutoCommit]
  );

  // Undo the most recent edit
  const undo = useCallback(() => {
    if (editHistory.length === 0 || !agsFile) return;
    const last = editHistory[editHistory.length - 1]!;
    const grp = agsFile.groups[last.group];
    if (!grp) return;
    const newRows: AgsRow[] = grp.rows.map((r, i) =>
      i === last.rowIndex ? ({ ...r, [last.heading]: last.oldValue } as AgsRow) : r
    );
    const newGroup: AgsGroup = { ...grp, rows: newRows };
    const newFile: AgsFile = { ...agsFile, groups: { ...agsFile.groups, [last.group]: newGroup } };
    setAgsFile(newFile);
    setEditHistory((prev) => prev.slice(0, -1));
  }, [agsFile, editHistory]);

  // Auto-dismiss fix notice after 5 s
  useEffect(() => {
    if (!fixNotice) return;
    const t = setTimeout(() => setFixNotice(null), 5000);
    return () => clearTimeout(t);
  }, [fixNotice]);

  // Apply all standard fixers to the current agsFile state
  const applyAutoFixes = useCallback(() => {
    if (!agsFile) return;
    setEditingCell(null);
    const text = serialize(agsFile);
    const bytes = new TextEncoder().encode(text);
    const result = fixBytes(bytes);
    if (result.applied.length === 0) {
      setFixNotice({ applied: [], editCount: 0 });
      return;
    }
    const { file: fixedFile } = parseStr(result.output);
    const newEdits = diffAgsFilesForHistory(agsFile, fixedFile);
    setAgsFile(fixedFile);
    setEditHistory((prev) => [...prev, ...newEdits]);
    setFixNotice({ applied: result.applied, editCount: newEdits.length });
    scheduleAutoCommit();
  }, [agsFile, scheduleAutoCommit]);

  // Jump to a row from the issue sidebar
  const handleIssueSelect = useCallback(
    (d: Diagnostic) => {
      const group = optVal(d.location.group);
      const rowIdx = optVal(d.location.row_index);
      if (!group) {
        setFocusedCellHeading(null);
        return;
      }
      setActiveGroup(group);
      setEditingCell(null);
      if (rowIdx !== null) {
        const key = `${group}:${rowIdx}`;
        setFocusedRowKey(key);
        setFocusedCellHeading(RULE_TO_HEADING[d.rule_id] ?? null);
        setTimeout(() => {
          rowRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 60);
      } else {
        setFocusedRowKey(null);
        setFocusedCellHeading(null);
      }
    },
    []
  );

  const downloadAgs = useCallback(() => {
    if (!agsFile) return;
    const text = serialize(agsFile);
    const base = fileName?.replace(/\.[^.]+$/, '') ?? 'edited';
    downloadBlob(text, `${base}-fixed.ags`, 'text/plain');
  }, [agsFile, fileName]);

  const downloadSummary = useCallback(() => {
    if (!agsFile || !qualityReport) return;
    const summary = {
      original_file: fileName ?? 'unknown.ags',
      exported_at: new Date().toISOString(),
      quality: {
        initial_score: initialMetrics?.score ?? null,
        final_score: qualityReport.overall_score,
        initial_grade: initialMetrics ? qualityReport.grade : null,
        final_grade: qualityReport.grade,
        initial_issue_count: initialMetrics?.count ?? null,
        final_issue_count: allDiagnostics.length,
        dimensions: qualityReport.dimensions.map((dim) => ({
          id: dim.id,
          name: dim.name,
          score: dim.score,
          issue_count: dim.issues.length,
        })),
      },
      edits: editHistory.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        group: e.group,
        heading: e.heading,
        row_index: e.rowIndex,
        old_value: e.oldValue,
        new_value: e.newValue,
      })),
    };
    const base = fileName?.replace(/\.[^.]+$/, '') ?? 'edits';
    downloadBlob(JSON.stringify(summary, null, 2), `${base}-edit-summary.json`, 'application/json');
  }, [agsFile, qualityReport, editHistory, fileName, initialMetrics, allDiagnostics]);

  // ── Empty state ──────────────────────────────────────────────────────────────

  if (!agsFile) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--muted)' }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 12px', display: 'block', opacity: 0.35 }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
        </svg>
        <p style={{ fontSize: 14, fontWeight: 500 }}>Load an AGS file above to start editing</p>
        <p style={{ fontSize: 12, marginTop: 6, opacity: 0.7 }}>Issues will be highlighted in the table. Click any cell to edit.</p>
      </div>
    );
  }

  const groups = Object.keys(agsFile.groups);
  const currentGroup = agsFile.groups[activeGroup];
  const currentScore = qualityReport?.overall_score ?? 100;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Header bar ── */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        {/* Score */}
        <ScoreBar score={currentScore} label="Quality Score" />
        {initialMetrics && initialMetrics.score !== currentScore && (
          <div style={{ fontSize: 12, color: 'var(--green)', background: 'var(--green-soft)', padding: '4px 10px', borderRadius: 99, fontWeight: 600, border: '1px solid var(--green-border)' }}>
            ↑ {initialMetrics.score} → {currentScore}
          </div>
        )}

        <div style={{ width: 1, height: 32, background: 'var(--border)', flexShrink: 0 }} />

        {/* Issue count */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)', marginBottom: 4 }}>Issues</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['error', 'warning', 'info'] as const).map((s) => {
              const n = allDiagnostics.filter((d) => d.severity === s).length;
              if (n === 0) return null;
              return (
                <span key={s} style={{ fontSize: 12, fontWeight: 700, color: sevColor(s), background: sevBg(s), padding: '2px 8px', borderRadius: 99 }}>
                  {n} {s === 'error' ? 'err' : s === 'warning' ? 'warn' : 'info'}
                </span>
              );
            })}
            {allDiagnostics.length === 0 && (
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--green)' }}>✓ clean</span>
            )}
          </div>
        </div>

        <div style={{ width: 1, height: 32, background: 'var(--border)', flexShrink: 0 }} />

        {/* Edit count */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)', marginBottom: 4 }}>Edits Made</div>
          <span style={{ fontSize: 16, fontWeight: 700, color: editHistory.length > 0 ? 'var(--blue)' : 'var(--muted)' }}>{editHistory.length}</span>
        </div>

        {/* Auto-save status */}
        {autoSaveStatus !== 'idle' && (
          <span style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: '1px solid', ...(autoSaveStatus === 'saved' ? { color: 'var(--green)', background: 'var(--green-soft)', borderColor: 'var(--green-border)' } : { color: 'var(--muted)', background: 'var(--surface-muted)', borderColor: 'var(--border)' }) }}>
            {autoSaveStatus === 'pending' ? '● Unsaved edits…' : '✓ Auto-committed'}
          </span>
        )}

        {/* Auto-fix + Downloads */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Fix notice toast */}
          {fixNotice && (
            <span style={{ fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 6, border: '1px solid', ...(fixNotice.applied.length === 0 ? { color: 'var(--green)', background: 'var(--green-soft)', borderColor: 'var(--green-border)' } : { color: 'var(--accent)', background: 'var(--accent-soft)', borderColor: 'var(--accent-border)' }) }}>
              {fixNotice.applied.length === 0
                ? '✓ Nothing to auto-fix'
                : `⚡ ${fixNotice.editCount} cell${fixNotice.editCount !== 1 ? 's' : ''} fixed (${fixNotice.applied.join(', ')})`}
            </span>
          )}
          <button
            onClick={applyAutoFixes}
            title="Apply all standard auto-fixes: whitespace, units, Y/N values, date formats, numeric coercion…"
            style={{ background: 'var(--green-soft)', color: 'var(--green)', border: '1px solid var(--green-border)', fontSize: 12, padding: '8px 14px', fontWeight: 700 }}
          >
            ⚡ Auto-Fix All
          </button>
          <div style={{ width: 1, height: 24, background: 'var(--border)' }} />
          <button onClick={downloadAgs} style={{ background: 'var(--navy)', color: '#fff', fontSize: 12, padding: '8px 14px' }}>
            ↓ Download Fixed AGS
          </button>
          <button
            onClick={downloadSummary}
            disabled={editHistory.length === 0}
            style={{ background: editHistory.length > 0 ? 'var(--blue)' : 'var(--border)', color: editHistory.length > 0 ? '#fff' : 'var(--muted)', fontSize: 12, padding: '8px 14px' }}
          >
            ↓ Edit Summary JSON
          </button>
        </div>
      </div>

      {/* ── Edit history (collapsible) ── */}
      <EditHistoryPanel history={editHistory} onUndo={undo} />

      {/* ── Main area: sidebar + table ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '270px 1fr', gap: 12, alignItems: 'start' }}>

        {/* Issues sidebar */}
        <div style={{ position: 'sticky', top: 16, maxHeight: 'calc(100vh - 240px)', display: 'flex', flexDirection: 'column' }}>
          <IssuesSidebar
            diagnostics={allDiagnostics}
            focusedKey={focusedRowKey}
            onSelect={handleIssueSelect}
          />
          {/* Dimension scores */}
          {qualityReport && (
            <div style={{ marginTop: 10, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 14px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 10 }}>Quality Dimensions</div>
              {qualityReport.dimensions.map((dim) => (
                <div key={dim.id} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 11, color: 'var(--text)' }}>{dim.name}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: scoreColor(dim.score) }}>{dim.score}</span>
                  </div>
                  <div style={{ height: 4, background: 'var(--border)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${dim.score}%`, background: scoreColor(dim.score), borderRadius: 99, transition: 'width 0.4s' }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Table editor */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {/* Group tabs */}
          <div style={{ display: 'flex', overflowX: 'auto', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)', padding: '8px 12px 0', gap: 4, flexWrap: 'wrap' }}>
            {groups.map((g) => {
              const count = groupIssueCounts.get(g) ?? 0;
              const isActive = activeGroup === g;
              return (
                <button
                  key={g}
                  onClick={() => { setActiveGroup(g); setEditingCell(null); setFocusedRowKey(null); setFocusedCellHeading(null); }}
                  style={{
                    padding: '5px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    borderRadius: '6px 6px 0 0',
                    border: `1px solid ${isActive ? 'var(--border)' : 'transparent'}`,
                    borderBottom: isActive ? '1px solid var(--card)' : '1px solid transparent',
                    background: isActive ? 'var(--card)' : 'transparent',
                    color: isActive ? 'var(--navy)' : count > 0 ? 'var(--orange)' : 'var(--muted)',
                    cursor: 'pointer',
                    marginBottom: -1,
                    whiteSpace: 'nowrap',
                    position: 'relative',
                  }}
                >
                  {g}
                  {count > 0 && (
                    <span style={{ marginLeft: 5, fontSize: 9, background: count > 0 ? (isActive ? 'var(--navy)' : 'var(--orange)') : 'var(--border)', color: '#fff', borderRadius: 99, padding: '1px 5px', fontWeight: 800 }}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Hint bar */}
          <div style={{ padding: '6px 12px', background: 'var(--surface-muted)', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)', display: 'flex', gap: 12 }}>
            <span>Click a cell to edit</span>
            <span>·</span>
            <span><kbd style={{ background: 'var(--border)', padding: '1px 4px', borderRadius: 3, fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>Enter</kbd> confirm</span>
            <span>·</span>
            <span><kbd style={{ background: 'var(--border)', padding: '1px 4px', borderRadius: 3, fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>Esc</kbd> cancel</span>
            <span style={{ marginLeft: 'auto' }}>
              Highlighted cells have quality issues — hover for details
            </span>
          </div>

          {/* Table */}
          {currentGroup ? (
            <EditableTable
              groupName={activeGroup}
              group={currentGroup}
              rowIssueMap={rowIssueMap}
              editingCell={editingCell}
              focusedRowKey={focusedRowKey}
              focusedCellHeading={focusedCellHeading}
              rowRefs={rowRefs}
              onCellClick={(rowIndex, heading, currentVal) => {
                setEditingCell({ group: activeGroup, rowIndex, heading, draft: displayVal(currentVal) });
              }}
              onDraftChange={(draft) => setEditingCell((prev) => prev ? { ...prev, draft } : null)}
              onCommit={() => {
                if (editingCell) commitEdit(editingCell.group, editingCell.rowIndex, editingCell.heading, editingCell.draft);
              }}
              onCancel={() => setEditingCell(null)}
            />
          ) : (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
              No groups found
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
