import { useState, useCallback, useEffect, useRef, useMemo, type DragEvent, type ReactNode } from 'react';
import { Option } from 'effect';
import type { TabId } from './types.js';
import { parseStr, decodeBytes, serialize } from './core.js';
import type { AgsFile, AgsGroup } from './core.js';
import { InspectTab } from './tabs/InspectTab.js';
import { OverviewTab } from './tabs/OverviewTab.js';
import { SearchTab } from './tabs/SearchTab.js';
import { ConvertTab } from './tabs/ConvertTab.js';
import { DataTab } from './tabs/DataTab.js';
import { DiffTab } from './tabs/DiffTab.js';
import { EditTab } from './tabs/EditTab.js';
import { MapTab } from './tabs/MapTab.js';
import { RulesTab } from './tabs/RulesTab.js';
import { QueryTab } from './tabs/QueryTab.js';
import { ThreeDTab } from './tabs/ThreeDTab.js';
import { VoxelTab } from './tabs/VoxelTab.js';
import { PlotsTab } from './tabs/PlotsTab.js';
import { ReportTab } from './tabs/ReportTab.js';
import { DescribeTab } from './tabs/DescribeTab.js';
import { SectionTab } from './tabs/SectionTab.js';
import { CptTab } from './tabs/CptTab.js';
import { CorrelationsTab } from './tabs/CorrelationsTab.js';
import { TransformTab } from './tabs/TransformTab.js';
import { GroundModelMode } from './ground-model/GroundModelMode.js';
import { ProjectManager } from './components/ProjectManager.js';
import { ConflictResolver } from './components/ConflictResolver.js';
import { DisclaimerBanner, DisclaimerModal } from './components/Disclaimer.js';
import type { Project, Commit } from './storage/types.js';
import { saveProject, saveCommit, getCommit } from './storage/db.js';
import { mergeAgsFiles, applyConflictResolutions } from './merge.js';
import type { MergeResult, MergeConflict } from './merge.js';
import { compress, computeDelta, reconstructAgsBytes } from './delta.js';
import { useLocationGroups } from './location-groups.js';

// ── Global styles ─────────────────────────────────────────────────────────────

const GLOBAL_STYLE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    /* Pastel palette — desaturated slate-blue chrome on warm cream */
    --navy: #54678a;          /* dusty slate-blue (header/status chrome) */
    --navy-2: #6a7fa3;
    --blue: #7a93bd;
    --accent: #7a9ee0;        /* soft sky-blue */
    --accent-soft: #e8eef9;
    --accent-border: #c8d5ee;
    --amber: #d9a05a;
    --amber-soft: #fbf3e2;
    --amber-border: #ecd5a3;
    --red: #d57878;
    --red-soft: #fbecec;
    --red-border: #efcfcf;
    --orange: #e8a070;
    --orange-soft: #fbeee0;
    --orange-border: #f2d2b0;
    --green: #82c096;
    --green-soft: #ecf4ee;
    --green-border: #c4dccb;
    --bg: #faf7f2;            /* warm cream */
    --card: #ffffff;
    --surface-muted: #f4f0e9; /* faint cream inset (panel headers, code blocks) */
    --surface-hover: #ece6db;
    --sidebar: #ffffff;
    --sidebar-fg: #334155;
    --sidebar-muted: #7c8b9b;
    --sidebar-hover: #f4f1ec;
    --sidebar-active: #eef2fb;
    --border: #e8e3dc;        /* warm grey border */
    --border-strong: #d4ccc0;
    --text: #334155;
    --text-dim: #5a6878;      /* secondary text */
    --muted: #7c8b9b;
    --radius: 8px;
    --radius-sm: 6px;
    --header-h: 48px;
    --status-h: 26px;
    --sidebar-w: 240px;
    --sidebar-w-collapsed: 52px;
  }
  html, body, #root {
    height: 100%;
  }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    background: var(--bg);
    color: var(--text);
    overflow: hidden;
  }
  button {
    padding: 9px 18px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity .15s, background .15s, color .15s, border-color .15s;
    font-family: inherit;
  }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  pre { white-space: pre-wrap; word-break: break-word; }
  input, select, textarea { font-family: inherit; }
  input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 6px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background: var(--muted); }
  .gf-nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
    margin: 1px 8px;
    border-radius: 6px;
    color: var(--sidebar-fg);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    user-select: none;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .gf-nav-item:hover { background: var(--sidebar-hover); }
  .gf-nav-item.active {
    background: var(--sidebar-active);
    color: var(--accent);
    border-color: var(--accent-border);
    font-weight: 600;
  }
  .gf-nav-item.disabled { opacity: 0.45; cursor: not-allowed; }
  .gf-nav-item.disabled:hover { background: transparent; }
  .gf-nav-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    color: currentColor;
  }
  .gf-nav-group-label {
    padding: 14px 20px 4px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--sidebar-muted);
  }
  .gf-iconbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: inherit;
    cursor: pointer;
  }
  .gf-iconbtn:hover { background: rgba(255,255,255,0.10); }
`;

// ── Severity helpers ──────────────────────────────────────────────────────────

export type SevFilter = 'all' | 'error' | 'warning' | 'info';

function sevColor(sev: string): string {
  if (sev === 'error') return 'var(--red)';
  if (sev === 'warning') return 'var(--orange)';
  return 'var(--accent)';
}

// ── DiagnosticsPanel ─────────────────────────────────────────────────────────

interface DiagnosticsItem {
  rule_id: string;
  severity: string;
  message: string;
  group?: string | null;
  row_index?: number | null;
  source?: string | null;
}

interface DiagnosticsPanelProps {
  items: DiagnosticsItem[];
  title?: string;
}

export function DiagnosticsPanel({ items, title = 'Diagnostics' }: DiagnosticsPanelProps) {
  const [filter, setFilter] = useState<SevFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<string | 'all'>('all');

  const counts = {
    error: items.filter((d) => d.severity === 'error').length,
    warning: items.filter((d) => d.severity === 'warning').length,
    info: items.filter((d) => d.severity === 'info').length,
  };

  const sources = Array.from(new Set(items.map((d) => d.source).filter((s): s is string => !!s)));
  const showSourceColumn = sources.length > 0;

  const visible = items.filter((d) => {
    if (filter !== 'all' && d.severity !== filter) return false;
    if (sourceFilter !== 'all' && (d.source ?? 'built-in') !== sourceFilter) return false;
    return true;
  });

  const pillStyle = (active: boolean): React.CSSProperties => ({
    padding: '3px 10px',
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 99,
    border: '1px solid var(--border)',
    background: active ? 'var(--navy)' : 'var(--card)',
    color: active ? '#fff' : 'var(--muted)',
    cursor: 'pointer',
  });

  const gridCols = showSourceColumn ? '44px 110px 100px 120px 1fr' : '44px 100px 120px 1fr';

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)', position: 'sticky', top: 0, zIndex: 1, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)' }}>{title}</h2>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {showSourceColumn && (
            <>
              <button style={pillStyle(sourceFilter === 'all')} onClick={() => setSourceFilter('all')}>ALL SOURCES</button>
              {sources.map((s) => (
                <button key={s} style={pillStyle(sourceFilter === s)} onClick={() => setSourceFilter(s)}>{s}</button>
              ))}
            </>
          )}
          <button style={pillStyle(filter === 'all')} onClick={() => setFilter('all')}>ALL {items.length}</button>
          <button style={pillStyle(filter === 'error')} onClick={() => setFilter('error')}>ERR {counts.error}</button>
          <button style={pillStyle(filter === 'warning')} onClick={() => setFilter('warning')}>WARN {counts.warning}</button>
          <button style={pillStyle(filter === 'info')} onClick={() => setFilter('info')}>INFO {counts.info}</button>
        </div>
      </div>
      <div style={{ maxHeight: 560, overflowY: 'auto' }}>
        {visible.length === 0 && items.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--green)', fontWeight: 600 }}>
            ✓ No issues found
          </div>
        )}
        {visible.length === 0 && items.length > 0 && (
          <div style={{ textAlign: 'center', padding: '16px', color: 'var(--muted)', fontSize: 13 }}>
            No diagnostics match filter
          </div>
        )}
        {visible.map((d, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: gridCols, alignItems: 'baseline', gap: '0 10px', padding: '7px 16px', borderBottom: '1px solid var(--surface-muted)', fontFamily: "'Menlo', 'Consolas', monospace", fontSize: 12, lineHeight: 1.5 }}>
            <span style={{ fontWeight: 700, fontSize: 10, letterSpacing: '0.5px', textTransform: 'uppercase', color: sevColor(d.severity) }}>
              {d.severity === 'error' ? 'ERR' : d.severity === 'warning' ? 'WARN' : 'INFO'}
            </span>
            {showSourceColumn && (
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--muted)', textAlign: 'center', alignSelf: 'center' }}>
                {d.source ?? 'built-in'}
              </span>
            )}
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>{d.rule_id}</span>
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>
              {d.group ? `${d.group}${d.row_index != null ? ` · ${d.row_index}` : ''}` : ''}
            </span>
            <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{d.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── DropZone ─────────────────────────────────────────────────────────────────

interface DropZoneProps {
  onFile: (name: string, bytes: Uint8Array) => void;
  fileName?: string | undefined;
  fileSize?: number | undefined;
  accept?: string | undefined;
  label?: string | undefined;
  compact?: boolean | undefined;
}

export function DropZone({ onFile, fileName, fileSize, accept = '.ags,.xml,.diggs', label, compact }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf = e.target?.result;
      if (buf instanceof ArrayBuffer) {
        onFile(file.name, new Uint8Array(buf));
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const onDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }, [onFile]);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);

  const loaded = !!fileName;

  const pad = compact ? '14px 12px' : '32px 24px';
  const iconSize = compact ? 24 : 36;

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      style={{
        border: `2px dashed ${dragging ? 'var(--accent)' : loaded ? 'var(--green)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--radius)',
        background: dragging ? 'var(--accent-soft)' : loaded ? 'var(--green-soft)' : 'var(--card)',
        padding: pad,
        textAlign: 'center',
        cursor: 'pointer',
        transition: 'border-color .15s, background .15s',
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => handleFiles(e.target.files)}
      />
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: `0 auto ${compact ? 6 : 10}px`, display: 'block', color: 'var(--muted)' }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
      {label && <p style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: compact ? 2 : 6 }}>{label}</p>}
      {fileName ? (
        <p style={{ fontWeight: 600, color: 'var(--blue)', fontSize: compact ? 12 : 13, wordBreak: 'break-all' }}>
          {fileName}
          {fileSize !== undefined && <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 8 }}>({formatBytes(fileSize)})</span>}
        </p>
      ) : (
        <p style={{ color: 'var(--muted)', lineHeight: 1.6, fontSize: compact ? 12 : 14 }}>
          <strong style={{ color: 'var(--text)' }}>Drop a file</strong> or click to browse
          {!compact && (<>
            <br />
            <span style={{ fontSize: 12 }}>Accepts .ags, .xml, .diggs</span>
          </>)}
        </p>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── Logo ─────────────────────────────────────────────────────────────────────

// A chibi sauropod mascot for GeoFlow — flat-fill silhouette in the style of
// the Bun mark, sitting on the strata. Back spikes hint at geological layers.
function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* Tail */}
      <path d="M6 19 Q2 19 2.5 22 Q4 22 6 21 Z" fill="#a6e3bf" />
      {/* Body */}
      <rect x="5" y="15" width="18" height="11" rx="5.5" fill="#a6e3bf" />
      {/* Back spikes (geological strata cue) */}
      <path d="M8 15 L10 11 L12 15 Z M12 15 L14.5 10 L17 15 Z M17 15 L19 11.5 L21 15 Z" fill="#7cc99e" />
      {/* Neck */}
      <path d="M19 15 Q21 13 22 11 L26 12 Q25 15 23 16 Z" fill="#a6e3bf" />
      {/* Head */}
      <circle cx="26" cy="10" r="4.2" fill="#a6e3bf" />
      {/* Cheek highlight */}
      <ellipse cx="24.5" cy="11.6" rx="1.1" ry="0.6" fill="#fcc4c4" opacity="0.85" />
      {/* Eye */}
      <circle cx="27.2" cy="9" r="1" fill="#3c4a63" />
      <circle cx="27.5" cy="8.6" r="0.3" fill="#fff" />
      {/* Tiny smile */}
      <path d="M25.2 11.4 Q26.2 12.2 27.4 11.6" stroke="#3c4a63" strokeWidth="0.55" fill="none" strokeLinecap="round" />
      {/* Feet */}
      <rect x="8" y="24" width="3.2" height="2.5" rx="0.8" fill="#7cc99e" />
      <rect x="16.5" y="24" width="3.2" height="2.5" rx="0.8" fill="#7cc99e" />
    </svg>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg className="gf-nav-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const ICONS: Record<TabId, ReactNode> = {
  overview: <Icon d="M4 4h7v7H4z M13 4h7v4h-7z M13 10h7v10h-7z M4 13h7v7H4z" />,
  search: <Icon d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14z" />,
  inspect: <Icon d="M11 4a7 7 0 015.74 11.01l3.62 3.62a1 1 0 01-1.41 1.41l-3.62-3.62A7 7 0 1111 4zm0 2a5 5 0 100 10 5 5 0 000-10z" />,
  data: <Icon d="M3 5h18M3 12h18M3 19h18M9 5v14M15 5v14" />,
  edit: <Icon d="M4 20h4l10.5-10.5a2.83 2.83 0 00-4-4L4 16v4z M13.5 6.5l4 4" />,
  map: <Icon d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z M9 3v15 M15 6v15" />,
  '3d': <Icon d="M12 3l9 5v8l-9 5-9-5V8l9-5z M3 8l9 5 9-5 M12 13v10" />,
  voxel: <Icon d="M3 7l9-4 9 4-9 4-9-4z M3 12l9 4 9-4 M3 17l9 4 9-4" />,
  plots: <Icon d="M3 3v18h18 M7 15l4-4 3 3 5-6" />,
  report: <Icon d="M7 3h7l5 5v13H7V3z M14 3v6h6 M9 13h8 M9 17h8 M9 9h3" />,
  diff: <Icon d="M5 4v16 M12 2v20 M19 4v16 M5 12h14" />,
  convert: <Icon d="M7 7h11l-3-3 M17 17H6l3 3" />,
  query: <Icon d="M3 6h18 M6 12h12 M10 18h4" />,
  rules: <Icon d="M9 12l2 2 4-4 M12 22s8-4 8-12V5l-8-3-8 3v5c0 8 8 12 8 12z" />,
  describe: <Icon d="M4 6h10 M4 10h12 M4 14h8 M16 14l4 4-4 4" />,
  section: <Icon d="M3 4v16 M21 4v16 M3 8h18 M3 13h18 M3 18h18 M8 4l-2 4 3 5-2 5 2 2 M16 4l2 4-3 5 2 5-2 2" />,
  cpt: <Icon d="M12 2v2 M11 4h2v3h-2z M12 7v15 M9 10l3 2 3-2 M9 14l3 2 3-2 M9 18l3 2 3-2" />,
  correlations: <Icon d="M4 20h16 M4 4v16 M8 14l3-4 4 2 5-7" />,
  transform: <Icon d="M4 5h7l-3-3 M4 5l3 3 M20 19h-7l3 3 M20 19l-3-3 M10 12h4" />,
};

// ── Nav structure ────────────────────────────────────────────────────────────

interface NavItem { id: TabId; label: string }
interface NavGroup { title: string; items: NavItem[] }

const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Review',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'inspect', label: 'Inspect' },
      { id: 'data', label: 'Data' },
      { id: 'search', label: 'Search' },
      { id: 'edit', label: 'Edit' },
    ],
  },
  {
    title: 'Visualize',
    items: [
      { id: 'map', label: 'Map' },
      { id: 'section', label: 'Section' },
      { id: '3d', label: '3D View' },
      { id: 'voxel', label: 'Voxels' },
      { id: 'plots', label: 'Plots' },
    ],
  },
  {
    title: 'Analyze',
    items: [
      { id: 'diff', label: 'Diff' },
      { id: 'query', label: 'Query' },
      { id: 'transform', label: 'Transform' },
      { id: 'rules', label: 'Rules' },
      { id: 'describe', label: 'Describe' },
      { id: 'cpt', label: 'CPT' },
      { id: 'correlations', label: 'Correlations' },
    ],
  },
  {
    title: 'Output',
    items: [
      { id: 'report', label: 'Report' },
      { id: 'convert', label: 'Convert' },
    ],
  },
];

const ALL_TAB_IDS: TabId[] = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));

// Tabs that need a file loaded to be useful (diff & describe also work without one).
const TABS_NEED_FILE = new Set<TabId>(ALL_TAB_IDS.filter((t) => t !== 'diff' && t !== 'describe' && t !== 'cpt' && t !== 'transform'));

function hashTab(): TabId {
  const hash = window.location.hash.replace('#', '') as TabId;
  return ALL_TAB_IDS.includes(hash) ? hash : 'overview';
}

interface LoadedFile { name: string; bytes: Uint8Array }

function mergeAgsBytes(files: LoadedFile[]): Uint8Array {
  if (files.length === 1) return files[0]!.bytes;
  const parsed = files
    .map((f) => parseStr(decodeBytes(f.bytes)).file)
    .filter((f): f is AgsFile => f !== null);
  if (parsed.length === 0) return files[0]!.bytes;
  const groups: Record<string, AgsGroup> = {};
  for (const ags of parsed) {
    for (const [name, group] of Object.entries(ags.groups)) {
      if (!group) continue;
      if (!groups[name]) {
        groups[name] = { ...group, rows: [...group.rows] };
      } else {
        groups[name] = { ...groups[name], rows: [...groups[name].rows, ...group.rows] };
      }
    }
  }
  const merged: AgsFile = { groups, source_path: Option.none(), ags_version: parsed[0]!.ags_version };
  return new TextEncoder().encode(serialize(merged));
}

// Lightweight summary for status bar (avoids re-parsing whole file in tabs).
interface FileSummary {
  agsVersion: string;
  groupCount: number;
  rowCount: number;
  hasLoca: boolean;
  locaCount: number;
}

function summarizeFile(bytes: Uint8Array): FileSummary | null {
  try {
    const f = parseStr(decodeBytes(bytes)).file;
    if (!f) return null;
    let rows = 0;
    let groups = 0;
    let locaCount = 0;
    for (const [name, g] of Object.entries(f.groups)) {
      if (!g) continue;
      groups += 1;
      rows += g.rows.length;
      if (name === 'LOCA') locaCount = g.rows.length;
    }
    const versionOpt = f.ags_version as { _tag: string; value?: string };
    const agsVersion = versionOpt._tag === 'Some' ? (versionOpt.value ?? '?') : '?';
    return {
      agsVersion,
      groupCount: groups,
      rowCount: rows,
      hasLoca: locaCount > 0,
      locaCount,
    };
  } catch {
    return null;
  }
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  tab: TabId;
  onTab: (id: TabId) => void;
  hasFile: boolean;
  loadedFiles: LoadedFile[];
  currentProject: Project | null;
  headCommit: Commit | null;
  onFile: (name: string, bytes: Uint8Array) => void;
  onAddFile: (name: string, bytes: Uint8Array) => void;
  onRemoveFile: (index: number) => void;
  onClearSession: () => void;
}

function Sidebar(props: SidebarProps) {
  const {
    collapsed, onToggleCollapsed, tab, onTab, hasFile,
    loadedFiles, currentProject, headCommit,
    onFile, onAddFile, onRemoveFile, onClearSession,
  } = props;

  return (
    <aside
      style={{
        gridArea: 'sidebar',
        background: 'var(--sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        width: collapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)',
        transition: 'width .18s ease',
        overflow: 'hidden',
      }}
    >
      {/* File / project block */}
      {!collapsed && (
        <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--sidebar-muted)', marginBottom: 8, paddingLeft: 4 }}>
            {currentProject ? 'Project' : 'Source'}
          </div>

          {currentProject && (
            <div style={{
              padding: '8px 10px', marginBottom: 8, background: 'var(--surface-muted)',
              borderRadius: 6, border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, color: 'var(--navy)' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
                </svg>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentProject.name}</span>
              </div>
              {headCommit && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontFamily: 'monospace' }}>
                  HEAD · {headCommit.id.slice(0, 7)}
                </div>
              )}
            </div>
          )}

          {hasFile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {loadedFiles.length > 0 ? (
                <>
                  {loadedFiles.map((f, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '6px 8px', background: 'var(--surface-muted)',
                        border: '1px solid var(--border)', borderRadius: 6, fontSize: 12,
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.5" style={{ flexShrink: 0 }}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
                      </svg>
                      <span style={{ flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }} title={f.name}>{f.name}</span>
                      <span style={{ color: 'var(--muted)', fontSize: 11 }}>{formatBytes(f.bytes.length)}</span>
                      {loadedFiles.length > 1 && (
                        <button
                          onClick={() => onRemoveFile(i)}
                          title="Remove"
                          style={{ padding: '1px 6px', fontSize: 11, background: 'transparent', color: 'var(--muted)', border: 'none', cursor: 'pointer', fontWeight: 700 }}
                        >✕</button>
                      )}
                    </div>
                  ))}
                  <DropZone
                    onFile={onAddFile}
                    label="+ Add another"
                    compact
                  />
                  {!currentProject && (
                    <button
                      onClick={onClearSession}
                      style={{
                        marginTop: 2, padding: '6px 10px', fontSize: 11, fontWeight: 600,
                        background: 'transparent', color: 'var(--muted)',
                        border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
                      }}
                    >Clear session</button>
                  )}
                </>
              ) : (
                <DropZone onFile={onFile} compact />
              )}
            </div>
          ) : (
            <DropZone onFile={onFile} compact />
          )}
        </div>
      )}

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
        {NAV_GROUPS.map((group) => (
          <div key={group.title}>
            {!collapsed && (
              <div className="gf-nav-group-label">{group.title}</div>
            )}
            {collapsed && (
              <div style={{ borderTop: '1px solid var(--border)', margin: '6px 8px 4px' }} />
            )}
            {group.items.map((item) => {
              const disabled = !hasFile && TABS_NEED_FILE.has(item.id);
              const active = tab === item.id;
              return (
                <div
                  key={item.id}
                  className={`gf-nav-item ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
                  onClick={() => { if (!disabled) onTab(item.id); }}
                  title={collapsed ? item.label : undefined}
                  style={{ justifyContent: collapsed ? 'center' : 'flex-start', padding: collapsed ? '8px 0' : '7px 12px' }}
                >
                  {ICONS[item.id]}
                  {!collapsed && <span>{item.label}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Collapse toggle */}
      <div style={{ borderTop: '1px solid var(--border)', padding: 8, display: 'flex', justifyContent: collapsed ? 'center' : 'flex-end' }}>
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 30, height: 30, padding: 0,
            background: 'transparent', color: 'var(--muted)',
            border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform .18s' }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </div>
    </aside>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

const SIDEBAR_STATE_KEY = 'geoflow:sidebar-collapsed';
const MODE_STATE_KEY = 'geoflow:mode';

export type AppMode = 'data' | 'ground-models';

function initialMode(): AppMode {
  try {
    const m = localStorage.getItem(MODE_STATE_KEY);
    return m === 'ground-models' ? 'ground-models' : 'data';
  } catch {
    return 'data';
  }
}

export default function App() {
  const [tab, setTab] = useState<TabId>(hashTab);
  const [mode, setModeState] = useState<AppMode>(initialMode);
  const setMode = useCallback((m: AppMode) => {
    setModeState(m);
    try { localStorage.setItem(MODE_STATE_KEY, m); } catch { /* ignore */ }
  }, []);

  // ── No-project state: naive multi-file merge ──────────────────────────────
  const [loadedFiles, setLoadedFiles] = useState<LoadedFile[]>([]);

  // ── Project state: git-model commit chain ─────────────────────────────────
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [headCommit, setHeadCommit] = useState<Commit | null>(null);
  // Bytes for the current editing session (set on load/import, NOT updated on auto-commit
  // so that EditTab is not forced to re-parse during an active session).
  const [projectBytes, setProjectBytes] = useState<Uint8Array | null>(null);
  const [sessionFileName, setSessionFileName] = useState<string | undefined>();
  const [pendingMerge, setPendingMerge] = useState<{ result: MergeResult; incomingName: string } | null>(null);

  const [showProjectManager, setShowProjectManager] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const pendingHoleRef = useRef<string | null>(null);
  // Tracks the last committed AgsFile so edit deltas are computed incrementally.
  const lastCommittedFileRef = useRef<AgsFile | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(SIDEBAR_STATE_KEY) === '1'; } catch { return false; }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(SIDEBAR_STATE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // ── Derived values passed to tabs ─────────────────────────────────────────
  const fileBytes = useMemo(() => {
    if (currentProject) return projectBytes;
    return loadedFiles.length === 0 ? null : mergeAgsBytes(loadedFiles);
  }, [currentProject, projectBytes, loadedFiles]);

  const fileName = currentProject
    ? (sessionFileName ?? currentProject.name)
    : loadedFiles.length === 0 ? undefined
    : loadedFiles.length === 1 ? loadedFiles[0]!.name
    : `${loadedFiles[0]!.name} +${loadedFiles.length - 1} more`;

  const fileSummary = useMemo(() => fileBytes ? summarizeFile(fileBytes) : null, [fileBytes]);
  const totalBytes = fileBytes?.length ?? 0;

  const hasFile = fileBytes !== null;

  // ── Location groups (shared across Map / Plots / Report) ───────────────────
  const allLocaIds = useMemo<string[]>(() => {
    if (!fileBytes) return [];
    try {
      const file = parseStr(decodeBytes(fileBytes)).file;
      return (file.groups['LOCA']?.rows ?? [])
        .map((r) => String(r['LOCA_ID'] ?? '').trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }, [fileBytes]);
  const locationGroups = useLocationGroups(allLocaIds);

  useEffect(() => {
    const onHash = () => setTab(hashTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const switchTab = useCallback((id: TabId) => {
    window.location.hash = id;
    setTab(id);
  }, []);

  // ── Project commit helpers ────────────────────────────────────────────────

  async function persistCommit(commit: Commit, project: Project): Promise<void> {
    await saveCommit(commit);
    const updated = { ...project, headCommitId: commit.id, updatedAt: Date.now() };
    await saveProject(updated);
    setCurrentProject(updated);
    setHeadCommit(commit);
  }

  async function createSnapshotCommit(
    project: Project,
    parent: Commit | null,
    message: string,
    bytes: Uint8Array,
    conflictCount = 0,
  ): Promise<Commit> {
    const gz = await compress(bytes);
    const commit: Commit = {
      id: crypto.randomUUID(),
      projectId: project.id,
      parentId: parent?.id ?? null,
      message,
      storage: { kind: 'snapshot', gz },
      timestamp: Date.now(),
      conflictCount,
    };
    await persistCommit(commit, project);
    return commit;
  }

  async function createDeltaCommit(
    project: Project,
    parent: Commit | null,
    message: string,
    before: AgsFile,
    after: AgsFile,
  ): Promise<Commit> {
    const delta = computeDelta(before, after);
    const commit: Commit = {
      id: crypto.randomUUID(),
      projectId: project.id,
      parentId: parent?.id ?? null,
      message,
      storage: { kind: 'delta', delta },
      timestamp: Date.now(),
      conflictCount: 0,
    };
    await persistCommit(commit, project);
    return commit;
  }

  // Handles any file dropped/added when a project is active.
  // First drop → initial import commit (snapshot). Subsequent drops → git merge (snapshot).
  async function handleProjectFile(name: string, bytes: Uint8Array) {
    if (!currentProject) return;
    if (!headCommit) {
      const commit = await createSnapshotCommit(currentProject, null, `Import ${name}`, bytes);
      lastCommittedFileRef.current = parseStr(decodeBytes(bytes)).file;
      void commit;
      setProjectBytes(bytes);
      setSessionFileName(name);
    } else {
      const headBytes = await reconstructAgsBytes(headCommit, getCommit);
      const currentAgs = parseStr(decodeBytes(headBytes)).file;
      const incomingAgs = parseStr(decodeBytes(bytes)).file;
      if (!currentAgs || !incomingAgs) return;
      const result = mergeAgsFiles(currentAgs, incomingAgs);
      if (result.conflicts.length === 0) {
        const mergedBytes = new TextEncoder().encode(serialize(result.merged));
        await createSnapshotCommit(currentProject, headCommit, `Merge ${name}`, mergedBytes);
        lastCommittedFileRef.current = result.merged;
        setProjectBytes(mergedBytes);
        setSessionFileName(name);
      } else {
        setPendingMerge({ result, incomingName: name });
      }
    }
  }

  async function onResolveConflicts(resolved: MergeConflict[]) {
    if (!pendingMerge || !currentProject) return;
    const finalFile = applyConflictResolutions(pendingMerge.result.merged, resolved);
    const bytes = new TextEncoder().encode(serialize(finalFile));
    const n = pendingMerge.result.conflicts.length;
    const msg = `Merge ${pendingMerge.incomingName}${n > 0 ? ` (${n} conflict${n > 1 ? 's' : ''} resolved)` : ''}`;
    await createSnapshotCommit(currentProject, headCommit, msg, bytes, n);
    lastCommittedFileRef.current = finalFile;
    setProjectBytes(bytes);
    setSessionFileName(pendingMerge.incomingName);
    setPendingMerge(null);
  }

  // Called by EditTab after 30 s of idle. Stores a delta commit so storage
  // stays small. Does NOT call setProjectBytes — EditTab keeps its session.
  async function handleAutoCommit(bytes: Uint8Array, editCount: number) {
    if (!currentProject || !lastCommittedFileRef.current) return;
    const afterFile = parseStr(decodeBytes(bytes)).file;
    if (!afterFile) return;
    const msg = `Edit: ${editCount} cell${editCount !== 1 ? 's' : ''} changed`;
    await createDeltaCommit(currentProject, headCommit, msg, lastCommittedFileRef.current, afterFile);
    lastCommittedFileRef.current = afterFile;
  }

  // ── Drop zone handlers ────────────────────────────────────────────────────

  // Primary zone: replaces session (no-project) or imports/merges (project)
  const onFile = useCallback(async (name: string, bytes: Uint8Array) => {
    if (currentProject) {
      await handleProjectFile(name, bytes);
    } else {
      setLoadedFiles([{ name, bytes }]);
    }
  }, [currentProject, headCommit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Secondary zone: appends (no-project) or merges (project)
  const onAddFile = useCallback(async (name: string, bytes: Uint8Array) => {
    if (currentProject) {
      await handleProjectFile(name, bytes);
    } else {
      setLoadedFiles((prev) => [...prev, { name, bytes }]);
    }
  }, [currentProject, headCommit]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRemoveFile = useCallback((index: number) => {
    setLoadedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const onClearSession = useCallback(() => {
    setLoadedFiles([]);
  }, []);

  // Called from ProjectManager when user opens a commit
  const onLoadFromProject = useCallback(async (commitId: string, name: string, project: Project) => {
    const commit = await getCommit(commitId);
    if (!commit) return;
    const bytes = await reconstructAgsBytes(commit, getCommit);
    const agsFile = parseStr(decodeBytes(bytes)).file;
    lastCommittedFileRef.current = agsFile;
    setProjectBytes(bytes);
    setSessionFileName(name);
    setHeadCommit(commit);
    setCurrentProject(project);
  }, []);

  // Welcome message when nothing is loaded
  const welcomePane = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 32 }}>
      <div style={{ textAlign: 'center', maxWidth: 520 }}>
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--border-strong)" strokeWidth="1.4" style={{ margin: '0 auto 18px' }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
          Load an AGS file to begin
        </h2>
        <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6, marginBottom: 18 }}>
          Drop an <code style={{ background: 'var(--surface-muted)', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>.ags</code> or
          {' '}<code style={{ background: 'var(--surface-muted)', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>.xml</code> file into the panel on the left,
          or open the <strong>Projects</strong> menu to restore a saved session.
        </p>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 22 }}>
          The <strong>Diff</strong> tab works without a loaded file.
        </p>
        <DisclaimerBanner onOpen={() => setShowDisclaimer(true)} />
      </div>
    </div>
  );

  return (
    <>
      <style>{GLOBAL_STYLE}</style>
      <div
        style={{
          display: 'grid',
          gridTemplateAreas: '"header header" "sidebar main" "status status"',
          gridTemplateRows: 'var(--header-h) 1fr var(--status-h)',
          gridTemplateColumns: 'auto 1fr',
          height: '100vh',
          width: '100vw',
        }}
      >
        {/* ── Header ───────────────────────────────────────────────────────── */}
        <header
          style={{
            gridArea: 'header',
            background: 'var(--navy)',
            color: '#fff',
            padding: '0 14px 0 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            borderBottom: '1px solid rgba(0,0,0,0.15)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Logo size={26} />
            <h1 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.2px' }}>GeoFlow</h1>
          </div>

          {/* Breadcrumb */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#e2e6ee', marginLeft: 4, overflow: 'hidden' }}>
            <span style={{ color: '#a3b1c8' }}>/</span>
            {currentProject ? (
              <>
                <span style={{ fontWeight: 600, color: '#ffffff' }}>{currentProject.name}</span>
                <span style={{ color: '#a3b1c8' }}>/</span>
                <span style={{ color: '#cfd6e3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                  {fileName ?? '(no file)'}
                </span>
              </>
            ) : (
              <span style={{ color: '#cfd6e3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                {fileName ?? 'No file loaded'}
              </span>
            )}
          </div>

          <ModeToggle mode={mode} onChange={setMode} />

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setShowProjectManager(true)}
              title="Manage projects"
              style={{
                padding: '6px 12px', fontSize: 12, fontWeight: 600,
                background: 'rgba(255,255,255,0.10)', color: '#fff',
                border: '1px solid rgba(255,255,255,0.18)', borderRadius: 6,
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
              </svg>
              Projects
            </button>
            <span style={{ fontSize: 11, color: '#cfd6e3', opacity: 0.7, borderLeft: '1px solid rgba(255,255,255,0.18)', paddingLeft: 12 }}>
              AGS Validator &amp; Converter
            </span>
          </div>
        </header>

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        {mode === 'data' && (
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebar}
            tab={tab}
            onTab={switchTab}
            hasFile={hasFile}
            loadedFiles={loadedFiles}
            currentProject={currentProject}
            headCommit={headCommit}
            onFile={(n, b) => { void onFile(n, b); }}
            onAddFile={(n, b) => { void onAddFile(n, b); }}
            onRemoveFile={onRemoveFile}
            onClearSession={onClearSession}
          />
        )}
        {mode === 'ground-models' && (
          <GroundModelSidebar
            currentProject={currentProject}
            headCommit={headCommit}
            loadedFiles={loadedFiles}
            onFile={(n, b) => { void onFile(n, b); }}
            onAddFile={(n, b) => { void onAddFile(n, b); }}
            onRemoveFile={onRemoveFile}
            onClearSession={onClearSession}
          />
        )}

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <main
          style={{
            gridArea: 'main',
            overflow: 'auto',
            background: 'var(--bg)',
            position: 'relative',
          }}
        >
          {mode === 'ground-models' ? (
            <div style={{ padding: '20px 24px 32px' }}>
              <GroundModelMode
                fileBytes={fileBytes}
                fileName={fileName}
                projectId={currentProject?.id ?? null}
              />
            </div>
          ) : (!hasFile && TABS_NEED_FILE.has(tab)) ? welcomePane : (
            <div style={{ padding: '20px 24px 32px' }}>
              {tab === 'overview' && <OverviewTab fileBytes={fileBytes} fileName={fileName} />}
              {tab === 'inspect' && <InspectTab fileBytes={fileBytes} fileName={fileName} />}
              {tab === 'data' && <DataTab fileBytes={fileBytes} fileName={fileName} pendingHoleRef={pendingHoleRef} />}
              {tab === 'search' && <SearchTab fileBytes={fileBytes} />}
              {/* EditTab stays mounted to preserve edit session state across tab switches */}
              <div style={{ display: tab === 'edit' ? 'block' : 'none' }}>
                <EditTab
                  fileBytes={fileBytes}
                  fileName={fileName}
                  onAutoCommit={currentProject ? (b, n) => { void handleAutoCommit(b, n); } : undefined}
                />
              </div>
              {tab === 'map' && (
                <MapTab
                  fileBytes={fileBytes}
                  fileName={fileName}
                  onLocaClick={(id) => { pendingHoleRef.current = id; switchTab('data'); }}
                  locationGroups={locationGroups}
                />
              )}
              {tab === '3d' && <ThreeDTab fileBytes={fileBytes} fileName={fileName} />}
              {tab === 'voxel' && <VoxelTab fileBytes={fileBytes} fileName={fileName} />}
              {tab === 'plots' && <PlotsTab fileBytes={fileBytes} locationGroups={locationGroups} />}
              {tab === 'report' && <ReportTab fileBytes={fileBytes} fileName={fileName} />}
              {tab === 'diff' && <DiffTab />}
              {tab === 'convert' && <ConvertTab fileBytes={fileBytes} fileName={fileName} />}
              {tab === 'query' && <QueryTab fileBytes={fileBytes} />}
              {tab === 'rules' && <RulesTab fileBytes={fileBytes} />}
              {tab === 'describe' && <DescribeTab fileBytes={fileBytes} />}
              {tab === 'section' && <SectionTab fileBytes={fileBytes} fileName={fileName} locationGroups={locationGroups} />}
              {tab === 'cpt' && <CptTab fileBytes={fileBytes} fileName={fileName} />}
              {tab === 'correlations' && <CorrelationsTab fileBytes={fileBytes} />}
              {tab === 'transform' && <TransformTab fileBytes={fileBytes} currentProject={currentProject} />}
            </div>
          )}
        </main>

        {/* ── Status bar ───────────────────────────────────────────────────── */}
        <footer
          style={{
            gridArea: 'status',
            background: 'var(--navy)',
            color: '#e2e6ee',
            padding: '0 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            fontSize: 11,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            borderTop: '1px solid rgba(0,0,0,0.15)',
          }}
        >
          <StatusItem icon="●" color={hasFile ? '#a6e3bf' : '#a3b1c8'}>
            {hasFile ? 'Ready' : 'No file'}
          </StatusItem>
          {hasFile && fileSummary && (
            <>
              <StatusDivider />
              <StatusItem>AGS {fileSummary.agsVersion}</StatusItem>
              <StatusDivider />
              <StatusItem>{fileSummary.groupCount} group{fileSummary.groupCount !== 1 ? 's' : ''}</StatusItem>
              <StatusDivider />
              <StatusItem>{fileSummary.rowCount.toLocaleString()} row{fileSummary.rowCount !== 1 ? 's' : ''}</StatusItem>
              {fileSummary.locaCount > 0 && (
                <>
                  <StatusDivider />
                  <StatusItem>{fileSummary.locaCount} location{fileSummary.locaCount !== 1 ? 's' : ''}</StatusItem>
                </>
              )}
              <StatusDivider />
              <StatusItem>{formatBytes(totalBytes)}</StatusItem>
            </>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, color: '#a3b1c8' }}>
            <button
              onClick={() => setShowDisclaimer(true)}
              title="Read the disclaimer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '2px 8px', fontSize: 11, fontWeight: 600,
                background: 'transparent', color: '#f3d9a8',
                border: '1px solid rgba(255,255,255,0.18)', borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              <span aria-hidden="true">⚠</span>
              <span>Disclaimer</span>
            </button>
            <span style={{ color: 'rgba(255,255,255,0.25)' }}>│</span>
            <span>{tab}</span>
          </div>
        </footer>
      </div>

      {showProjectManager && (
        <ProjectManager
          onClose={() => setShowProjectManager(false)}
          onLoadCommit={onLoadFromProject}
          currentProjectId={currentProject?.id}
        />
      )}

      {pendingMerge && (
        <ConflictResolver
          result={pendingMerge.result}
          sourceName={pendingMerge.incomingName}
          onResolve={(resolved) => { void onResolveConflicts(resolved); }}
          onCancel={() => setPendingMerge(null)}
        />
      )}

      {showDisclaimer && (
        <DisclaimerModal onClose={() => setShowDisclaimer(false)} />
      )}
    </>
  );
}

// ── Mode toggle (segmented control in header) ────────────────────────────────

function ModeToggle({ mode, onChange }: { mode: AppMode; onChange: (m: AppMode) => void }) {
  const opts: Array<{ id: AppMode; label: string; icon: ReactNode }> = [
    { id: 'data',          label: 'Data',          icon: <Icon d="M3 5h18M3 12h18M3 19h18" size={14} /> },
    { id: 'ground-models', label: 'Ground Models', icon: <Icon d="M3 7l9-4 9 4 M3 12l9 4 9-4 M3 17l9 4 9-4" size={14} /> },
  ];
  return (
    <div
      role="tablist"
      aria-label="Mode"
      style={{
        display: 'inline-flex',
        padding: 3,
        gap: 2,
        marginLeft: 10,
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 8,
      }}
    >
      {opts.map((o) => {
        const isActive = o.id === mode;
        return (
          <button
            key={o.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(o.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 11px', fontSize: 12, fontWeight: 600,
              background: isActive ? '#ffffff' : 'transparent',
              color: isActive ? 'var(--navy)' : '#e2e6ee',
              border: 'none', borderRadius: 6, cursor: 'pointer',
              transition: 'background .15s, color .15s',
            }}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Minimal sidebar for Ground Models mode ──────────────────────────────────
// Keeps the file/project block so users can swap data without leaving the
// mode, but drops the per-tab nav — Ground Models has its own internal
// step navigation.

interface GroundModelSidebarProps {
  loadedFiles: LoadedFile[];
  currentProject: Project | null;
  headCommit: Commit | null;
  onFile: (name: string, bytes: Uint8Array) => void;
  onAddFile: (name: string, bytes: Uint8Array) => void;
  onRemoveFile: (index: number) => void;
  onClearSession: () => void;
}

function GroundModelSidebar(props: GroundModelSidebarProps) {
  const { loadedFiles, currentProject, headCommit, onFile, onAddFile, onRemoveFile, onClearSession } = props;
  const hasFile = loadedFiles.length > 0 || currentProject !== null;
  return (
    <aside
      style={{
        gridArea: 'sidebar',
        background: 'var(--sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        width: 'var(--sidebar-w)',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--sidebar-muted)', marginBottom: 8, paddingLeft: 4 }}>
          {currentProject ? 'Project' : 'Source'}
        </div>
        {currentProject && (
          <div style={{
            padding: '8px 10px', marginBottom: 8, background: 'var(--surface-muted)',
            borderRadius: 6, border: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, color: 'var(--navy)' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentProject.name}</span>
            </div>
            {headCommit && (
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontFamily: 'monospace' }}>
                HEAD · {headCommit.id.slice(0, 7)}
              </div>
            )}
          </div>
        )}
        {hasFile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {loadedFiles.map((f, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 8px', background: 'var(--surface-muted)',
                  border: '1px solid var(--border)', borderRadius: 6, fontSize: 12,
                }}
              >
                <span style={{ flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }} title={f.name}>{f.name}</span>
                {loadedFiles.length > 1 && (
                  <button
                    onClick={() => onRemoveFile(i)}
                    title="Remove"
                    style={{ padding: '1px 6px', fontSize: 11, background: 'transparent', color: 'var(--muted)', border: 'none', cursor: 'pointer', fontWeight: 700 }}
                  >✕</button>
                )}
              </div>
            ))}
            <DropZone onFile={onAddFile} label="+ Add another" compact />
            {!currentProject && (
              <button
                onClick={onClearSession}
                style={{
                  marginTop: 2, padding: '6px 10px', fontSize: 11, fontWeight: 600,
                  background: 'transparent', color: 'var(--muted)',
                  border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
                }}
              >Clear session</button>
            )}
          </div>
        ) : (
          <DropZone onFile={onFile} compact />
        )}
      </div>
      <div style={{ padding: 16, color: 'var(--muted)', fontSize: 12, lineHeight: 1.55 }}>
        Ground model mode reads from the file loaded above. Switch back to
        <strong style={{ color: 'var(--text)' }}> Data </strong>
        mode to inspect, edit, or transform the source data.
      </div>
    </aside>
  );
}

function StatusItem({ children, icon, color }: { children: ReactNode; icon?: string; color?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {icon && <span style={{ color: color ?? 'var(--border-strong)', fontSize: 9 }}>{icon}</span>}
      <span>{children}</span>
    </span>
  );
}

function StatusDivider() {
  return <span style={{ color: 'rgba(255,255,255,0.25)' }}>│</span>;
}
