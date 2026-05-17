import { useState, useCallback, useEffect, useRef, useMemo, type DragEvent } from 'react';
import { Option } from 'effect';
import type { TabId, PackDiagnostic } from './types.js';
import { parseStr, decodeBytes, serialize } from './core.js';
import type { AgsFile, AgsGroup } from './core.js';
import { InspectTab } from './tabs/InspectTab.js';
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
import { ProjectManager } from './components/ProjectManager.js';
import { ConflictResolver } from './components/ConflictResolver.js';
import type { Project, Commit } from './storage/types.js';
import { saveProject, saveCommit, getCommit } from './storage/db.js';
import { mergeAgsFiles, applyConflictResolutions } from './merge.js';
import type { MergeResult, MergeConflict } from './merge.js';

// ── Global styles ─────────────────────────────────────────────────────────────

const GLOBAL_STYLE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --navy: #0f2644; --blue: #1a4080; --amber: #d97706; --red: #dc2626;
    --orange: #ea580c; --green: #16a34a; --bg: #f1f5f9; --card: #ffffff;
    --border: #cbd5e1; --text: #0f172a; --muted: #64748b; --radius: 8px;
  }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  button {
    padding: 9px 18px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity .15s, background .15s;
    font-family: inherit;
  }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  pre { white-space: pre-wrap; word-break: break-word; }
`;

// ── Severity helpers ──────────────────────────────────────────────────────────

export type SevFilter = 'all' | 'error' | 'warning' | 'info';

function sevColor(sev: string): string {
  if (sev === 'error') return 'var(--red)';
  if (sev === 'warning') return 'var(--orange)';
  return '#2563eb';
}

// ── DiagnosticsPanel ─────────────────────────────────────────────────────────

interface DiagnosticsItem {
  rule_id: string;
  severity: string;
  message: string;
  group?: string | null;
  row_index?: number | null;
}

interface DiagnosticsPanelProps {
  items: DiagnosticsItem[];
  title?: string;
}

export function DiagnosticsPanel({ items, title = 'Diagnostics' }: DiagnosticsPanelProps) {
  const [filter, setFilter] = useState<SevFilter>('all');

  const counts = {
    error: items.filter((d) => d.severity === 'error').length,
    warning: items.filter((d) => d.severity === 'warning').length,
    info: items.filter((d) => d.severity === 'info').length,
  };

  const visible = filter === 'all' ? items : items.filter((d) => d.severity === filter);

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

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--border)', background: '#f8fafc', position: 'sticky', top: 0, zIndex: 1 }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)' }}>{title}</h2>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
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
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '44px 100px 120px 1fr', alignItems: 'baseline', gap: '0 10px', padding: '7px 16px', borderBottom: '1px solid #f1f5f9', fontFamily: "'Menlo', 'Consolas', monospace", fontSize: 12, lineHeight: 1.5 }}>
            <span style={{ fontWeight: 700, fontSize: 10, letterSpacing: '0.5px', textTransform: 'uppercase', color: sevColor(d.severity) }}>
              {d.severity === 'error' ? 'ERR' : d.severity === 'warning' ? 'WARN' : 'INFO'}
            </span>
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
}

export function DropZone({ onFile, fileName, fileSize, accept = '.ags,.xml,.diggs', label }: DropZoneProps) {
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

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      style={{
        border: `2px dashed ${dragging ? 'var(--blue)' : loaded ? 'var(--green)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        background: dragging ? '#eff6ff' : loaded ? '#f0fdf4' : 'var(--card)',
        padding: '32px 24px',
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
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 10px', display: 'block', color: 'var(--muted)' }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
      {label && <p style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6 }}>{label}</p>}
      {fileName ? (
        <p style={{ fontWeight: 600, color: 'var(--blue)', fontSize: 13 }}>
          {fileName}
          {fileSize !== undefined && <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 8 }}>({formatBytes(fileSize)})</span>}
        </p>
      ) : (
        <p style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>Drop a file</strong> or click to browse
          <br />
          <span style={{ fontSize: 12 }}>Accepts .ags, .xml, .diggs</span>
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

// ── App ───────────────────────────────────────────────────────────────────────

const TABS: { id: TabId; label: string }[] = [
  { id: 'inspect', label: 'Inspect' },
  { id: 'data', label: 'Data' },
  { id: 'edit', label: 'Edit' },
  { id: 'map', label: 'Map' },
  { id: '3d', label: '3D View' },
  { id: 'voxel', label: 'Voxels' },
  { id: 'plots', label: 'Plots' },
  { id: 'report', label: 'Report' },
  { id: 'diff', label: 'Diff' },
  { id: 'convert', label: 'Convert' },
  { id: 'query', label: 'Query' },
  { id: 'rules', label: 'Rules' },
];

function hashTab(): TabId {
  const hash = window.location.hash.replace('#', '') as TabId;
  return TABS.some((t) => t.id === hash) ? hash : 'inspect';
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

export default function App() {
  const [tab, setTab] = useState<TabId>(hashTab);

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
  const pendingHoleRef = useRef<string | null>(null);

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

  useEffect(() => {
    const onHash = () => setTab(hashTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const switchTab = (id: TabId) => {
    window.location.hash = id;
    setTab(id);
  };

  // ── Project commit helpers ────────────────────────────────────────────────

  async function createCommit(
    project: Project,
    parent: Commit | null,
    message: string,
    bytes: Uint8Array,
    conflictCount = 0,
  ): Promise<Commit> {
    const commit: Commit = {
      id: crypto.randomUUID(),
      projectId: project.id,
      parentId: parent?.id ?? null,
      message,
      agsBytes: bytes,
      timestamp: Date.now(),
      conflictCount,
    };
    await saveCommit(commit);
    const updated = { ...project, headCommitId: commit.id, updatedAt: Date.now() };
    await saveProject(updated);
    setCurrentProject(updated);
    setHeadCommit(commit);
    return commit;
  }

  // Handles any file dropped/added when a project is active.
  // First drop → initial import commit. Subsequent drops → git merge.
  async function handleProjectFile(name: string, bytes: Uint8Array) {
    if (!currentProject) return;
    if (!headCommit) {
      // Initial import
      await createCommit(currentProject, null, `Import ${name}`, bytes);
      setProjectBytes(bytes);
      setSessionFileName(name);
    } else {
      // Merge into HEAD
      const currentAgs = parseStr(decodeBytes(headCommit.agsBytes)).file;
      const incomingAgs = parseStr(decodeBytes(bytes)).file;
      if (!currentAgs || !incomingAgs) return;
      const result = mergeAgsFiles(currentAgs, incomingAgs);
      if (result.conflicts.length === 0) {
        const mergedBytes = new TextEncoder().encode(serialize(result.merged));
        await createCommit(currentProject, headCommit, `Merge ${name}`, mergedBytes);
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
    await createCommit(currentProject, headCommit, msg, bytes, n);
    setProjectBytes(bytes);
    setSessionFileName(pendingMerge.incomingName);
    setPendingMerge(null);
  }

  // Called by EditTab after 30 s of idle: creates a commit but does NOT
  // update projectBytes, so the editing session continues uninterrupted.
  async function handleAutoCommit(bytes: Uint8Array, editCount: number) {
    if (!currentProject) return;
    const msg = `Edit: ${editCount} cell${editCount !== 1 ? 's' : ''} changed`;
    await createCommit(currentProject, headCommit, msg, bytes);
    // Intentionally do NOT call setProjectBytes — EditTab keeps its in-memory state.
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

  // Called from ProjectManager when user opens a commit
  const onLoadFromProject = useCallback(async (commitId: string, name: string, project: Project) => {
    const commit = await getCommit(commitId);
    if (!commit) return;
    setProjectBytes(commit.agsBytes);
    setSessionFileName(name);
    setHeadCommit(commit);
    setCurrentProject(project);
  }, []);

  return (
    <>
      <style>{GLOBAL_STYLE}</style>
      <header style={{ background: 'var(--navy)', color: '#fff', padding: '0 24px', height: 56, display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px' }}>GeoFlow</h1>
        {currentProject && (
          <span style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
            </svg>
            {currentProject.name}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={() => setShowProjectManager(true)}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 600,
              background: 'rgba(255,255,255,0.12)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6,
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
            </svg>
            Projects
          </button>
          <span style={{ fontSize: 12, opacity: 0.45 }}>AGS Validator &amp; Converter</span>
        </div>
      </header>

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

      <main style={{ maxWidth: 1600, margin: '0 auto', padding: '24px 24px 60px' }}>
        {/* Primary drop zone — replaces all loaded files */}
        <DropZone
          onFile={(n, b) => { void onFile(n, b); }}
          fileName={loadedFiles.length === 1 ? loadedFiles[0]!.name : fileName}
          fileSize={loadedFiles.length === 1 ? loadedFiles[0]!.bytes.length : undefined}
        />

        {/* Loaded-file list + add-file row */}
        {loadedFiles.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {loadedFiles.length > 1 && loadedFiles.map((f, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 12px', background: 'var(--card)',
                  border: '1px solid var(--border)', borderRadius: 6, fontSize: 13,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
                </svg>
                <span style={{ flex: 1, fontWeight: 500 }}>{f.name}</span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatBytes(f.bytes.length)}</span>
                <button
                  onClick={() => onRemoveFile(i)}
                  title="Remove this file"
                  style={{ padding: '2px 8px', fontSize: 12, background: '#fee2e2', color: 'var(--red)', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}
                >✕</button>
              </div>
            ))}
            <DropZone
              onFile={(n, b) => { void onAddFile(n, b); }}
              label={`Add another AGS file${loadedFiles.length > 1 ? ` (${loadedFiles.length} loaded)` : ''}`}
            />
          </div>
        )}

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 2, borderBottom: '2px solid var(--border)', marginBottom: 24, marginTop: 20 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => switchTab(t.id)}
              style={{
                padding: '10px 20px',
                fontSize: 13,
                fontWeight: 600,
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                color: tab === t.id ? 'var(--navy)' : 'var(--muted)',
                borderBottom: `2px solid ${tab === t.id ? 'var(--navy)' : 'transparent'}`,
                marginBottom: -2,
                transition: 'color .12s, border-color .12s',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'inspect' && <InspectTab fileBytes={fileBytes} fileName={fileName} />}
        {tab === 'data' && <DataTab fileBytes={fileBytes} fileName={fileName} pendingHoleRef={pendingHoleRef} />}
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
          />
        )}
        {tab === '3d' && <ThreeDTab fileBytes={fileBytes} fileName={fileName} />}
        {tab === 'voxel' && <VoxelTab fileBytes={fileBytes} fileName={fileName} />}
        {tab === 'plots' && <PlotsTab fileBytes={fileBytes} />}
        {tab === 'report' && <ReportTab fileBytes={fileBytes} fileName={fileName} />}
        {tab === 'diff' && <DiffTab />}
        {tab === 'convert' && <ConvertTab fileBytes={fileBytes} fileName={fileName} />}
        {tab === 'query' && <QueryTab fileBytes={fileBytes} />}
        {tab === 'rules' && <RulesTab fileBytes={fileBytes} />}
      </main>
    </>
  );
}
