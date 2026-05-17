import { useState, useEffect, useCallback, type DragEvent } from 'react';
import type { Project, ProjectFile } from '../storage/types.js';
import {
  getProjects,
  getProjectFiles,
  saveProject,
  deleteProject,
  saveProjectFile,
  deleteProjectFile,
} from '../storage/db.js';
import { exportProjectGeoPackage, importProjectGeoPackage } from '../export/geopackage.js';

interface ProjectManagerProps {
  onClose: () => void;
  onLoadFile: (name: string, bytes: Uint8Array, project: Project) => void;
  currentProjectId?: string;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ProjectManager({ onClose, onLoadFile, currentProjectId }: ProjectManagerProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [fileCounts, setFileCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(currentProjectId ?? null);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => { void loadProjects(); }, []);

  useEffect(() => {
    if (selectedId) void loadFiles(selectedId);
    else setProjectFiles([]);
  }, [selectedId]);

  async function loadProjects() {
    const ps = await getProjects();
    setProjects(ps);
    const counts: Record<string, number> = {};
    await Promise.all(
      ps.map(async (p) => {
        const files = await getProjectFiles(p.id);
        counts[p.id] = files.length;
      }),
    );
    setFileCounts(counts);
  }

  async function loadFiles(projectId: string) {
    setProjectFiles(await getProjectFiles(projectId));
  }

  async function createProject() {
    const name = newName.trim();
    if (!name) return;
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveProject(project);
    setNewName('');
    setCreating(false);
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
    if (!confirm('Delete this project and all its files? This cannot be undone.')) return;
    await deleteProject(id);
    if (selectedId === id) setSelectedId(null);
    await loadProjects();
  }

  async function handleDeleteFile(fileId: string) {
    await deleteProjectFile(fileId);
    if (selectedId) await loadFiles(selectedId);
    await loadProjects();
  }

  async function handleExport(project: Project) {
    setExportingId(project.id);
    try {
      const files = await getProjectFiles(project.id);
      await exportProjectGeoPackage(project, files);
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
        alert('This GeoPackage does not contain a GeoFlow project. Use the main drop zone to open .gpkg files for inspection.');
        return;
      }
      // Assign fresh IDs to avoid collisions on re-import
      const newProjectId = crypto.randomUUID();
      const newProject: Project = { ...result.project, id: newProjectId, updatedAt: Date.now() };
      await saveProject(newProject);
      for (const file of result.files) {
        await saveProjectFile({ ...file, id: crypto.randomUUID(), projectId: newProjectId });
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

  // ── Styles ──────────────────────────────────────────────────────────────────

  const S = {
    overlay: {
      position: 'fixed' as const,
      inset: 0,
      background: 'rgba(0,0,0,0.55)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    modal: {
      background: 'var(--card)',
      borderRadius: 12,
      width: 'min(960px, 96vw)',
      height: 'min(680px, 92vh)',
      display: 'flex',
      flexDirection: 'column' as const,
      overflow: 'hidden',
      boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '16px 24px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--navy)',
      color: '#fff',
    },
    body: {
      display: 'flex',
      flex: 1,
      minHeight: 0,
    },
    sidebar: {
      width: 260,
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column' as const,
      overflow: 'hidden',
    },
    sidebarHeader: {
      padding: '12px 16px',
      borderBottom: '1px solid var(--border)',
      background: '#f8fafc',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    projectItem: (active: boolean): React.CSSProperties => ({
      padding: '10px 16px',
      cursor: 'pointer',
      background: active ? '#eff6ff' : 'transparent',
      borderLeft: `3px solid ${active ? 'var(--blue)' : 'transparent'}`,
      transition: 'background .1s',
    }),
    detail: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column' as const,
      overflow: 'hidden',
    },
    detailHeader: {
      padding: '14px 20px',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      background: '#f8fafc',
    },
    fileItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 20px',
      borderBottom: '1px solid #f1f5f9',
      transition: 'background .1s',
    },
    btn: (variant: 'primary' | 'ghost' | 'danger' | 'small'): React.CSSProperties => {
      const base: React.CSSProperties = {
        padding: variant === 'small' ? '4px 10px' : '8px 14px',
        fontSize: variant === 'small' ? 11 : 12,
        fontWeight: 600,
        borderRadius: 6,
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'opacity .15s',
      };
      if (variant === 'primary') return { ...base, background: 'var(--blue)', color: '#fff' };
      if (variant === 'danger') return { ...base, background: '#fee2e2', color: 'var(--red)' };
      return { ...base, background: '#f1f5f9', color: 'var(--muted)' };
    },
  };

  return (
    <div style={S.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        {/* Header */}
        <div style={S.header}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
          </svg>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Projects</span>
          <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 12 }}>
            Data is stored locally in your browser
          </span>
          <button onClick={onClose} style={{ ...S.btn('ghost'), padding: '4px 8px', marginLeft: 8 }}>✕</button>
        </div>

        <div style={S.body}>
          {/* Sidebar — project list */}
          <div style={S.sidebar}>
            <div style={S.sidebarHeader}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', flex: 1 }}>
                {projects.length} Project{projects.length !== 1 ? 's' : ''}
              </span>
              <button style={S.btn('primary')} onClick={() => setCreating(true)}>+ New</button>
            </div>

            {/* Create new project form */}
            {creating && (
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: '#eff6ff' }}>
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createProject();
                    if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                  }}
                  placeholder="Project name…"
                  style={{
                    width: '100%', padding: '6px 10px', borderRadius: 6,
                    border: '1px solid var(--blue)', fontSize: 13, fontFamily: 'inherit',
                    outline: 'none', marginBottom: 8,
                  }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={S.btn('primary')} onClick={() => void createProject()}>Create</button>
                  <button style={S.btn('ghost')} onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Project list */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {projects.length === 0 && !creating && (
                <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  No projects yet.<br />Click <strong>+ New</strong> to create one.
                </div>
              )}
              {projects.map((p) => (
                <div
                  key={p.id}
                  style={S.projectItem(p.id === selectedId)}
                  onClick={() => setSelectedId(p.id)}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 2 }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {fileCounts[p.id] ?? 0} file{(fileCounts[p.id] ?? 0) !== 1 ? 's' : ''} · {formatDate(p.updatedAt)}
                  </div>
                </div>
              ))}
            </div>

            {/* Import from GeoPackage */}
            <div
              style={{
                borderTop: '1px solid var(--border)',
                padding: 12,
                background: dragOver ? '#eff6ff' : '#f8fafc',
                border: `2px dashed ${dragOver ? 'var(--blue)' : 'var(--border)'}`,
                borderRadius: 8,
                margin: 8,
                textAlign: 'center',
                cursor: importing ? 'wait' : 'pointer',
                transition: 'all .15s',
              }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              {importing ? (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>Importing…</span>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                    Drop a <strong>.gpkg</strong> here to import a GeoFlow project
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Detail panel */}
          <div style={S.detail}>
            {!selectedProject ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 14 }}>
                Select a project to view its files
              </div>
            ) : (
              <>
                <div style={S.detailHeader}>
                  <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{selectedProject.name}</span>
                  <button
                    style={S.btn('small')}
                    onClick={() => void handleRename(selectedProject)}
                    title="Rename project"
                  >Rename</button>
                  <button
                    style={S.btn('small')}
                    onClick={() => void handleExport(selectedProject)}
                    disabled={exportingId === selectedProject.id || projectFiles.length === 0}
                    title="Export all files as a GeoPackage"
                  >
                    {exportingId === selectedProject.id ? 'Exporting…' : 'Export .gpkgz'}
                  </button>
                  <button
                    style={S.btn('danger')}
                    onClick={() => void handleDeleteProject(selectedProject.id)}
                  >Delete</button>
                </div>

                <div style={{ flex: 1, overflowY: 'auto' }}>
                  {projectFiles.length === 0 ? (
                    <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                      No files yet. Drop an AGS file on the main page while this project is active to add files.
                    </div>
                  ) : (
                    projectFiles.map((f) => (
                      <div key={f.id} style={S.fileItem}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.5">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {f.name}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                            {formatBytes(f.bytes.length)} · Added {formatDate(f.addedAt)}
                          </div>
                        </div>
                        <button
                          style={S.btn('primary')}
                          onClick={() => { onLoadFile(f.name, f.bytes, selectedProject); onClose(); }}
                        >Open</button>
                        <button
                          style={S.btn('danger')}
                          onClick={() => void handleDeleteFile(f.id)}
                          title="Remove file from project"
                        >✕</button>
                      </div>
                    ))
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
