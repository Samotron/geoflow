import { useState, useEffect, useCallback, type DragEvent } from 'react';
import type { Project, Commit } from '../storage/types.js';
import {
  getProjects,
  getProjectCommits,
  saveProject,
  deleteProject,
  saveCommit,
} from '../storage/db.js';
import { exportProjectGeoPackage, importProjectGeoPackage } from '../export/geopackage.js';

interface ProjectManagerProps {
  onClose: () => void;
  onLoadCommit: (commitId: string, displayName: string, project: Project) => void;
  currentProjectId?: string | undefined;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function commitIcon(msg: string): string {
  if (msg.startsWith('Import')) return '↓';
  if (msg.startsWith('Merge')) return '⑃';
  if (msg.startsWith('Edit')) return '✎';
  if (msg.startsWith('Restore')) return '↩';
  return '●';
}

export function ProjectManager({ onClose, onLoadCommit, currentProjectId }: ProjectManagerProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [commitCounts, setCommitCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(currentProjectId ?? null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => { void loadProjects(); }, []);
  useEffect(() => { if (selectedId) void loadCommits(selectedId); else setCommits([]); }, [selectedId]);

  async function loadProjects() {
    const ps = await getProjects();
    setProjects(ps);
    const counts: Record<string, number> = {};
    await Promise.all(ps.map(async (p) => { counts[p.id] = (await getProjectCommits(p.id)).length; }));
    setCommitCounts(counts);
  }

  async function loadCommits(projectId: string) {
    setCommits(await getProjectCommits(projectId));
  }

  async function createProject() {
    const name = newName.trim();
    if (!name) return;
    const project: Project = { id: crypto.randomUUID(), name, createdAt: Date.now(), updatedAt: Date.now(), headCommitId: null };
    await saveProject(project);
    setNewName(''); setCreating(false);
    await loadProjects();
    setSelectedId(project.id);
  }

  async function handleRename(project: Project) {
    const name = prompt('New project name:', project.name);
    if (!name || name === project.name) return;
    await saveProject({ ...project, name, updatedAt: Date.now() });
    await loadProjects();
  }

  async function handleDeleteProject(id: string) {
    if (!confirm('Delete this project and all its history? This cannot be undone.')) return;
    await deleteProject(id);
    if (selectedId === id) setSelectedId(null);
    await loadProjects();
  }

  async function handleRestoreCommit(commit: Commit, project: Project) {
    const restoreCommit: Commit = {
      id: crypto.randomUUID(),
      projectId: project.id,
      parentId: project.headCommitId,
      message: `Restore to: ${commit.message}`,
      storage: commit.storage,
      timestamp: Date.now(),
      conflictCount: 0,
    };
    await saveCommit(restoreCommit);
    const updated = { ...project, headCommitId: restoreCommit.id, updatedAt: Date.now() };
    await saveProject(updated);
    await loadProjects();
    await loadCommits(project.id);
    // Load the restored commit
    onLoadCommit(restoreCommit.id, commit.message.replace(/^Import /, ''), updated);
    onClose();
  }

  async function handleOpenHead(project: Project) {
    if (!project.headCommitId) return;
    const commit = commits.find((c) => c.id === project.headCommitId);
    if (!commit) return;
    onLoadCommit(commit.id, commit.message.replace(/^Import /, ''), project);
    onClose();
  }

  async function handleExport(project: Project) {
    setExportingId(project.id);
    try {
      const allCommits = await getProjectCommits(project.id);
      await exportProjectGeoPackage(project, allCommits);
    } catch (err) {
      alert(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExportingId(null);
    }
  }

  async function handleImportBytes(bytes: Uint8Array) {
    setImporting(true);
    try {
      const result = await importProjectGeoPackage(bytes);
      if (!result) {
        alert('This GeoPackage does not contain a GeoFlow project.');
        return;
      }
      const newProjectId = crypto.randomUUID();
      const newProject: Project = { ...result.project, id: newProjectId, updatedAt: Date.now() };
      await saveProject(newProject);
      for (const commit of result.commits) {
        await saveCommit({ ...commit, id: crypto.randomUUID(), projectId: newProjectId });
      }
      // Find the HEAD commit (last in the list) and set it
      const lastCommit = result.commits[result.commits.length - 1];
      if (lastCommit) {
        await saveProject({ ...newProject, headCommitId: lastCommit.id });
      }
      await loadProjects();
      setSelectedId(newProjectId);
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  }

  const onDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buf = ev.target?.result;
      if (buf instanceof ArrayBuffer) void handleImportBytes(new Uint8Array(buf));
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const selectedProject = projects.find((p) => p.id === selectedId);

  // ── Styles ────────────────────────────────────────────────────────────────
  const btn = (variant: 'primary' | 'ghost' | 'danger' | 'small'): React.CSSProperties => {
    const base: React.CSSProperties = { padding: variant === 'small' ? '4px 10px' : '8px 14px', fontSize: variant === 'small' ? 11 : 12, fontWeight: 600, borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit', transition: 'opacity .15s' };
    if (variant === 'primary') return { ...base, background: 'var(--blue)', color: '#fff' };
    if (variant === 'danger') return { ...base, background: '#fee2e2', color: 'var(--red)' };
    return { ...base, background: '#f1f5f9', color: 'var(--muted)' };
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 12, width: 'min(960px, 96vw)', height: 'min(680px, 92vh)', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 24px', borderBottom: '1px solid var(--border)', background: 'var(--navy)', color: '#fff' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
          </svg>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Projects</span>
          <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 12 }}>Data stored locally in your browser</span>
          <button onClick={onClose} style={{ ...btn('ghost'), padding: '4px 8px', marginLeft: 8 }}>✕</button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Sidebar — project list */}
          <div style={{ width: 260, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', flex: 1 }}>
                {projects.length} Project{projects.length !== 1 ? 's' : ''}
              </span>
              <button style={btn('primary')} onClick={() => setCreating(true)}>+ New</button>
            </div>

            {creating && (
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: '#eff6ff' }}>
                <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void createProject(); if (e.key === 'Escape') { setCreating(false); setNewName(''); } }}
                  placeholder="Project name…"
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--blue)', fontSize: 13, fontFamily: 'inherit', outline: 'none', marginBottom: 8 }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={btn('primary')} onClick={() => void createProject()}>Create</button>
                  <button style={btn('ghost')} onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
                </div>
              </div>
            )}

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {projects.length === 0 && !creating && (
                <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  No projects yet.<br />Click <strong>+ New</strong> to create one.
                </div>
              )}
              {projects.map((p) => (
                <div key={p.id}
                  style={{ padding: '10px 16px', cursor: 'pointer', background: p.id === selectedId ? '#eff6ff' : 'transparent', borderLeft: `3px solid ${p.id === selectedId ? 'var(--blue)' : 'transparent'}`, transition: 'background .1s' }}
                  onClick={() => setSelectedId(p.id)}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 2 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {commitCounts[p.id] ?? 0} commit{(commitCounts[p.id] ?? 0) !== 1 ? 's' : ''} · {formatDate(p.updatedAt)}
                  </div>
                </div>
              ))}
            </div>

            {/* Import drop zone */}
            <div
              style={{ borderTop: '1px solid var(--border)', padding: 10, background: dragOver ? '#eff6ff' : '#f8fafc', border: `2px dashed ${dragOver ? 'var(--blue)' : 'var(--border)'}`, borderRadius: 8, margin: 8, textAlign: 'center', cursor: importing ? 'wait' : 'pointer', transition: 'all .15s' }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                {importing ? 'Importing…' : <>Drop a <strong>.gpkgz</strong> to import a project</>}
              </div>
            </div>
          </div>

          {/* Detail panel — commit log */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {!selectedProject ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 14 }}>
                Select a project to view its history
              </div>
            ) : (
              <>
                <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, background: '#f8fafc' }}>
                  <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{selectedProject.name}</span>
                  <button style={btn('small')} onClick={() => void handleRename(selectedProject)}>Rename</button>
                  <button style={btn('small')} disabled={exportingId === selectedProject.id || commits.length === 0} onClick={() => void handleExport(selectedProject)}>
                    {exportingId === selectedProject.id ? 'Exporting…' : 'Export .gpkgz'}
                  </button>
                  {selectedProject.headCommitId && (
                    <button style={btn('primary')} onClick={() => void handleOpenHead(selectedProject)}>Open</button>
                  )}
                  <button style={btn('danger')} onClick={() => void handleDeleteProject(selectedProject.id)}>Delete</button>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0' }}>
                  {commits.length === 0 ? (
                    <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                      No commits yet. Drop an AGS file on the main page while this project is active.
                    </div>
                  ) : (
                    <div style={{ position: 'relative' }}>
                      {/* Vertical timeline line */}
                      <div style={{ position: 'absolute', left: 35, top: 20, bottom: 20, width: 2, background: 'var(--border)' }} />
                      {commits.map((c, i) => {
                        const isHead = c.id === selectedProject.headCommitId;
                        return (
                          <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '8px 20px', position: 'relative' }}>
                            {/* Node */}
                            <div style={{ width: 32, height: 32, borderRadius: '50%', background: isHead ? 'var(--navy)' : 'var(--card)', border: `2px solid ${isHead ? 'var(--navy)' : 'var(--border)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0, zIndex: 1 }}>
                              <span style={{ color: isHead ? '#fff' : 'var(--muted)' }}>{commitIcon(c.message)}</span>
                            </div>

                            <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{c.message}</span>
                                {isHead && <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--navy)', color: '#fff', padding: '1px 6px', borderRadius: 4 }}>HEAD</span>}
                                {c.conflictCount > 0 && (
                                  <span style={{ fontSize: 10, fontWeight: 700, background: '#fff7ed', color: 'var(--amber)', padding: '1px 6px', borderRadius: 4, border: '1px solid #fed7aa' }}>
                                    ⚠ {c.conflictCount} conflict{c.conflictCount > 1 ? 's' : ''}
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                                {timeAgo(c.timestamp)}
                                <span style={{ margin: '0 6px' }}>·</span>
                                {c.storage.kind === 'delta' ? 'Δ delta' : c.storage.kind === 'snapshot' ? `~${(c.storage.gz.length * 3.5 / 1024).toFixed(0)} KB` : `${(c.storage.bytes.length / 1024).toFixed(1)} KB`}
                              </div>
                            </div>

                            {!isHead && i !== 0 && (
                              <button
                                style={{ ...btn('small'), flexShrink: 0, marginTop: 4 }}
                                onClick={() => void handleRestoreCommit(c, selectedProject)}
                                title="Create a new commit restoring this state"
                              >Restore</button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
