import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import type {
  FileGroupMeta,
  FileNode as PipelineFileNode,
  NotebookCell,
  NotebookNode as PipelineNotebookNode,
  OutputFormat,
  OutputNode,
  Pipeline,
  PipelineEdge,
  PipelineNode,
  SeedFormat,
  SeedNode,
  SourceNode,
  SqlNode,
} from '@geoflow/transform';
import { emptyPipeline, fileRelationName, isValidRelationName } from '@geoflow/transform';

import { decodeBytes, parseStr } from '../core.js';
import { listMainSchemaTables, registerAgsFile, getExtensionStatus, type TableMeta } from '../query/duckdb.js';
import { EXAMPLES, type PipelineExample } from '../transform/examples.js';
import type { Project } from '../storage/types.js';
import {
  exportPipeline,
  importPipelineFromFile,
  loadPipelinesForProject,
  deletePipelineById,
  savePipelineForProject,
} from '../transform/persistence.js';
import {
  fetchLineageRow,
  runPipeline,
  type LineageEntry,
  type NodeRunResult,
  type ResolvedColumnLineage,
} from '../transform/executor.js';
import { NODE_TYPES, OUTPUT_FORMATS, SEED_FORMATS, type FlowNodeData } from '../transform/nodes.js';
import { SqlNodeEditor } from '../transform/SqlNodeEditor.js';

interface Props {
  fileBytes: Uint8Array | null;
  currentProject: Project | null;
}

const DEFAULT_SQL = `-- Reference upstream nodes with {{ ref('node_name') }}
-- Sources can also be referenced directly by table name.
SELECT *
FROM {{ ref('source_name') }}
LIMIT 100`;

export function TransformTab({ fileBytes, currentProject }: Props) {
  return (
    <ReactFlowProvider>
      <TransformTabInner fileBytes={fileBytes} currentProject={currentProject} />
    </ReactFlowProvider>
  );
}

interface SelectedCell {
  nodeId: string;
  rowIdx: number;
  colIdx: number;
}

function TransformTabInner({ fileBytes, currentProject }: Props) {
  const [pipeline, setPipeline] = useState<Pipeline>(() => emptyPipeline(crypto.randomUUID(), 'Untitled pipeline'));
  const [pipelineList, setPipelineList] = useState<Pipeline[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [runResults, setRunResults] = useState<NodeRunResult[]>([]);
  const [running, setRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Register AGS tables and refresh schema whenever the loaded file changes.
  useEffect(() => {
    if (!fileBytes) {
      setTables([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { file } = parseStr(decodeBytes(fileBytes));
        await registerAgsFile(file);
        if (cancelled) return;
        const live = await listMainSchemaTables();
        if (!cancelled) setTables(live);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [fileBytes]);

  // Load existing pipelines for the current project.
  useEffect(() => {
    if (!currentProject) {
      setPipelineList([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const list = await loadPipelinesForProject(currentProject.id);
      if (cancelled) return;
      setPipelineList(list);
      if (list.length > 0 && list[0]) {
        setPipeline(list[0]);
      }
    })();
    return () => { cancelled = true; };
  }, [currentProject]);

  // Debounced autosave to the active project's pipeline store.
  const saveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!currentProject) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    setSaveState('saving');
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        await savePipelineForProject(currentProject.id, pipeline);
        setSaveState('saved');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSaveState('idle');
      }
    }, 700);
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, [pipeline, currentProject]);

  // ── React Flow state derived from the pipeline model ────────────────────
  const flowNodes: Node<FlowNodeData>[] = useMemo(() => {
    const resultsById = new Map(runResults.map((r) => [r.nodeId, r]));
    return pipeline.nodes.map((n) => {
      const res = resultsById.get(n.id);
      const status: FlowNodeData['status'] = running && !res
        ? 'idle'
        : res?.status ?? 'idle';
      return {
        id: n.id,
        type: n.kind,
        position: n.position,
        data: {
          kind: n.kind,
          label: n.name,
          detail: nodeDetail(n),
          status,
          error: res?.error ?? undefined,
        },
      };
    });
  }, [pipeline.nodes, runResults, running]);

  const flowEdges: Edge[] = useMemo(
    () => pipeline.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: false })),
    [pipeline.edges],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setPipeline((p) => {
      const updated = applyNodeChanges(changes, flowNodesFromPipeline(p));
      const positionById = new Map(updated.map((n) => [n.id, n.position]));
      const removed = new Set(
        changes.filter((c): c is NodeChange & { type: 'remove' } => c.type === 'remove').map((c) => c.id),
      );
      const nextNodes = p.nodes
        .filter((n) => !removed.has(n.id))
        .map((n) => ({ ...n, position: positionById.get(n.id) ?? n.position }));
      const nextEdges = removed.size === 0
        ? p.edges
        : p.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target));
      return { ...p, nodes: nextNodes, edges: nextEdges, updatedAt: Date.now() };
    });
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setPipeline((p) => {
      const next = applyEdgeChanges(changes, p.edges.map((e) => ({ ...e })));
      return { ...p, edges: next as PipelineEdge[], updatedAt: Date.now() };
    });
  }, []);

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    setPipeline((p) => {
      const id = `${conn.source}->${conn.target}`;
      if (p.edges.some((e) => e.id === id)) return p;
      const next = addEdge({ ...conn, id }, p.edges as unknown as Edge[]) as unknown as PipelineEdge[];
      return { ...p, edges: next, updatedAt: Date.now() };
    });
  }, []);

  const selectedNode = useMemo(
    () => pipeline.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [pipeline.nodes, selectedNodeId],
  );

  const upstreamRefs = useMemo(() => {
    if (!selectedNode) return [] as string[];
    const refs: string[] = [];
    for (const n of pipeline.nodes) {
      if (n.id === selectedNode.id) continue;
      if (n.kind === 'file') {
        for (const g of n.groups) refs.push(fileRelationName(n, g.name));
      } else {
        refs.push(n.name);
      }
    }
    return refs;
  }, [pipeline.nodes, selectedNode]);

  // ── Mutations ──────────────────────────────────────────────────────────
  const updateNode = useCallback((id: string, patch: Partial<PipelineNode>) => {
    setPipeline((p) => ({
      ...p,
      nodes: p.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as PipelineNode) : n)),
      updatedAt: Date.now(),
    }));
  }, []);

  const addNode = useCallback((kind: PipelineNode['kind']) => {
    setPipeline((p) => {
      const baseName = uniqueName(kind, p.nodes);
      const position = { x: 120 + (p.nodes.length % 5) * 220, y: 80 + Math.floor(p.nodes.length / 5) * 140 };
      const node = createNode(kind, baseName, position);
      return { ...p, nodes: [...p.nodes, node], updatedAt: Date.now() };
    });
  }, []);

  const newPipeline = useCallback(() => {
    setPipeline(emptyPipeline(crypto.randomUUID(), 'Untitled pipeline'));
    setRunResults([]);
    setSelectedNodeId(null);
  }, []);

  const renamePipeline = useCallback((name: string) => {
    setPipeline((p) => ({ ...p, name, updatedAt: Date.now() }));
  }, []);

  const onLoadExample = useCallback((ex: PipelineExample) => {
    const built = ex.build();
    // Re-stamp the id so loading the same example twice doesn't collide
    // with a previously-saved copy.
    setPipeline({ ...built, id: crypto.randomUUID(), updatedAt: Date.now() });
    setRunResults([]);
    setSelectedNodeId(null);
    setError(null);
  }, []);

  // ── Execution ──────────────────────────────────────────────────────────
  const onRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    setStatusMsg('Compiling…');
    setRunResults([]);
    try {
      const result = await runPipeline(pipeline, { onProgress: (m) => setStatusMsg(m) });
      setRunResults(result.steps);
      if (result.compileErrors.length > 0) {
        setError(result.compileErrors.join('\n'));
      } else {
        setError(null);
      }
      setStatusMsg(result.ok ? 'Done' : 'Completed with errors');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatusMsg(null);
    } finally {
      setRunning(false);
    }
  }, [pipeline]);

  // ── Import / export ────────────────────────────────────────────────────
  const onExport = useCallback(() => {
    const blob = exportPipeline(pipeline);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pipeline.name.replace(/[^\w.-]+/g, '_') || 'pipeline'}.geoflow-pipeline.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [pipeline]);

  const onImport = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imported = await importPipelineFromFile(file);
      setPipeline(imported);
      setRunResults([]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onSelectPipeline = useCallback((p: Pipeline) => {
    setPipeline(p);
    setRunResults([]);
    setSelectedNodeId(null);
  }, []);

  const onDeletePipeline = useCallback(async (p: Pipeline) => {
    if (!currentProject) return;
    if (!confirm(`Delete pipeline "${p.name}"?`)) return;
    await deletePipelineById(p.id);
    const next = await loadPipelinesForProject(currentProject.id);
    setPipelineList(next);
    if (pipeline.id === p.id) newPipeline();
  }, [currentProject, pipeline.id, newPipeline]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - var(--header-h) - var(--status-h) - 40px)', gap: 8 }}>
      <Toolbar
        pipeline={pipeline}
        onRename={renamePipeline}
        onRun={onRun}
        running={running}
        onNew={newPipeline}
        onExport={onExport}
        onImport={onImport}
        onLoadExample={onLoadExample}
        saveState={saveState}
        hasProject={currentProject !== null}
        statusMsg={statusMsg}
      />

      {error && (
        <div style={{ padding: 8, background: 'var(--red-soft)', border: '1px solid var(--red-border)', borderRadius: 6, color: 'var(--red)', fontSize: 12, whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 320px', gap: 8, flex: 1, minHeight: 0 }}>
        <SidePalette
          onAdd={addNode}
          pipelineList={pipelineList}
          activeId={pipeline.id}
          onSelectPipeline={onSelectPipeline}
          onDeletePipeline={onDeletePipeline}
        />

        <div style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 8, background: 'white', overflow: 'hidden' }}>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, n) => setSelectedNodeId(n.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
            fitViewOptions={{ padding: 0.2 }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        <Inspector
          node={selectedNode}
          tables={tables}
          availableRefs={upstreamRefs}
          onChange={(patch) => selectedNode && updateNode(selectedNode.id, patch)}
          runResult={selectedNode ? runResults.find((r) => r.nodeId === selectedNode.id) ?? null : null}
          selectedCell={selectedCell && selectedNode && selectedCell.nodeId === selectedNode.id ? selectedCell : null}
          onCellClick={(rowIdx, colIdx) => {
            if (!selectedNode) return;
            setSelectedCell({ nodeId: selectedNode.id, rowIdx, colIdx });
          }}
          pipelineNodes={pipeline.nodes}
        />
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function flowNodesFromPipeline(p: Pipeline): Node<FlowNodeData>[] {
  return p.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: n.position,
    data: { kind: n.kind, label: n.name, detail: '', status: 'idle' },
  }));
}

function nodeDetail(n: PipelineNode): string {
  switch (n.kind) {
    case 'source': return `table: ${n.table}`;
    case 'seed': return `${n.format.toUpperCase()} · ${n.content.length} chars`;
    case 'sql': return `${n.materialization} · ${n.sql.split('\n').length} lines`;
    case 'output': return n.format;
    case 'file': return n.groups.length === 0
      ? (n.fileName || 'no file loaded')
      : `${n.fileName || n.format} · ${n.groups.length} groups`;
    case 'notebook': {
      const sql = n.cells.filter((c) => c.kind === 'sql').length;
      const md = n.cells.filter((c) => c.kind === 'markdown').length;
      return `${sql} SQL · ${md} MD`;
    }
  }
}

function createNode(kind: PipelineNode['kind'], name: string, position: { x: number; y: number }): PipelineNode {
  const id = crypto.randomUUID();
  switch (kind) {
    case 'source':
      return { id, kind, name, table: '', position } as SourceNode;
    case 'seed':
      return { id, kind, name, format: 'csv', content: '', position } as SeedNode;
    case 'sql':
      return { id, kind, name, sql: DEFAULT_SQL, materialization: 'view', position } as SqlNode;
    case 'output':
      return { id, kind, name, format: 'preview', rowLimit: 100, position } as OutputNode;
    case 'file':
      return { id, kind, name, format: 'ags', fileName: '', content: '', groups: [], position } as PipelineFileNode;
    case 'notebook':
      return defaultNotebookNode(id, name, position);
  }
}

function defaultNotebookNode(id: string, name: string, position: { x: number; y: number }): PipelineNotebookNode {
  return {
    id, kind: 'notebook', name, position,
    cells: [
      {
        id: crypto.randomUUID(), kind: 'markdown', name: 'intro',
        content: `# ${name}\n\nA notebook of SQL + Markdown cells. The **last SQL cell** is what other nodes see when they ref this notebook.`,
      },
      {
        id: crypto.randomUUID(), kind: 'sql', name: 'cell_1', materialization: 'view',
        content: "-- Each SQL cell becomes its own relation, reusable downstream\n-- with {{ ref('cell_name') }}.\nSELECT 1 AS placeholder",
      },
    ],
  };
}

/**
 * Parse an AGS file's text and return per-group metadata for the inspector.
 * Returns empty list on parse failure — caller surfaces a friendlier message.
 */
function parseAgsGroups(text: string): FileGroupMeta[] {
  if (!text.trim()) return [];
  try {
    const { file } = parseStr(decodeBytes(new TextEncoder().encode(text)));
    return Object.entries(file.groups)
      .filter(([, g]) => g && g.rows.length > 0)
      .map(([name, g]) => ({
        name,
        rowCount: g!.rows.length,
        columns: g!.headings.map((h) => h.name),
      }));
  } catch {
    return [];
  }
}

function uniqueName(kind: PipelineNode['kind'], existing: readonly PipelineNode[]): string {
  const taken = new Set(existing.map((n) => n.name.toLowerCase()));
  const base = kind;
  let i = 1;
  let name = `${base}_${i}`;
  while (taken.has(name.toLowerCase())) {
    i += 1;
    name = `${base}_${i}`;
  }
  return name;
}

// ── Sub-components ───────────────────────────────────────────────────────

interface ToolbarProps {
  pipeline: Pipeline;
  onRename: (name: string) => void;
  onRun: () => void;
  running: boolean;
  onNew: () => void;
  onExport: () => void;
  onImport: (e: ChangeEvent<HTMLInputElement>) => void;
  onLoadExample: (ex: PipelineExample) => void;
  saveState: 'idle' | 'saving' | 'saved';
  hasProject: boolean;
  statusMsg: string | null;
}

function Toolbar(props: ToolbarProps) {
  const { pipeline, onRename, onRun, running, onNew, onExport, onImport, onLoadExample, saveState, hasProject, statusMsg } = props;
  const [exMenuOpen, setExMenuOpen] = useState(false);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'white',
    }}>
      <input
        value={pipeline.name}
        onChange={(e) => onRename(e.target.value)}
        style={{
          flex: '0 0 240px', padding: '6px 10px', border: '1px solid var(--border)',
          borderRadius: 6, fontSize: 13, fontWeight: 600, color: 'var(--navy)',
        }}
      />
      <button
        onClick={onRun}
        disabled={running}
        style={{
          padding: '6px 14px', fontSize: 12, fontWeight: 700,
          background: running ? 'var(--surface-muted)' : 'var(--accent)', color: running ? 'var(--muted)' : 'white',
          border: 'none', borderRadius: 6, cursor: running ? 'wait' : 'pointer',
        }}
      >
        {running ? 'Running…' : '▶ Run pipeline'}
      </button>
      <button onClick={onNew} style={toolbarBtnStyle}>New</button>
      <div style={{ position: 'relative' }}>
        <button onClick={() => setExMenuOpen((o) => !o)} style={toolbarBtnStyle}>Examples ▾</button>
        {exMenuOpen && (
          <>
            <div
              onClick={() => setExMenuOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 9 }}
            />
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 10,
              background: 'white', border: '1px solid var(--border)', borderRadius: 6,
              boxShadow: '0 4px 14px rgba(0,0,0,0.08)', minWidth: 320, padding: 4,
            }}>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.id}
                  onClick={() => { setExMenuOpen(false); onLoadExample(ex); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '8px 10px', background: 'transparent', border: 'none',
                    borderRadius: 4, cursor: 'pointer', fontSize: 12,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-muted)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ fontWeight: 700, color: 'var(--navy)' }}>{ex.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{ex.description}</div>
                  {ex.requiresFile && (
                    <div style={{ fontSize: 10, color: 'var(--amber)', marginTop: 2 }}>Requires an AGS file loaded.</div>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <button onClick={onExport} style={toolbarBtnStyle}>Export</button>
      <label style={{ ...toolbarBtnStyle, cursor: 'pointer' }}>
        Import
        <input type="file" accept=".json,.geoflow-pipeline.json" onChange={onImport} style={{ display: 'none' }} />
      </label>
      <div style={{ flex: 1 }} />
      {hasProject && (
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {saveState === 'saving' ? '· Saving…' : saveState === 'saved' ? '· Saved' : ''}
        </span>
      )}
      {!hasProject && (
        <span style={{ fontSize: 11, color: 'var(--amber)' }}>
          No project open · changes are not persisted
        </span>
      )}
      {statusMsg && (
        <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>{statusMsg}</span>
      )}
    </div>
  );
}

const toolbarBtnStyle: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 600,
  background: 'var(--surface-muted)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
};

interface SidePaletteProps {
  onAdd: (kind: PipelineNode['kind']) => void;
  pipelineList: Pipeline[];
  activeId: string;
  onSelectPipeline: (p: Pipeline) => void;
  onDeletePipeline: (p: Pipeline) => void;
}

function SidePalette({ onAdd, pipelineList, activeId, onSelectPipeline, onDeletePipeline }: SidePaletteProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden', minHeight: 0 }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'white', padding: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 8 }}>
          Add node
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <PaletteBtn onClick={() => onAdd('source')} label="Source" color="#54678a" bg="#eef2fb" />
          <PaletteBtn onClick={() => onAdd('file')} label="File" color="#6b4e85" bg="#f3edf7" />
          <PaletteBtn onClick={() => onAdd('seed')} label="Seed" color="#7a5a30" bg="#fbf3e2" />
          <PaletteBtn onClick={() => onAdd('sql')} label="SQL" color="#3f6d4a" bg="#ecf4ee" />
          <PaletteBtn onClick={() => onAdd('notebook')} label="Notebook" color="#a8466b" bg="#faecf2" />
          <PaletteBtn onClick={() => onAdd('output')} label="Output" color="#86472a" bg="#fbeee0" />
        </div>
      </div>

      <div style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 8, background: 'white', padding: 10, minHeight: 0, overflow: 'auto' }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 8 }}>
          Saved pipelines
        </div>
        {pipelineList.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>None yet. Open a project to enable autosave.</div>
        ) : pipelineList.map((p) => (
          <div
            key={p.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 7px', marginBottom: 4, borderRadius: 4,
              background: p.id === activeId ? 'var(--surface-muted)' : 'transparent',
              cursor: 'pointer', fontSize: 12,
            }}
            onClick={() => onSelectPipeline(p)}
          >
            <span style={{ flex: 1, fontWeight: 600, color: 'var(--navy)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.name}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onDeletePipeline(p); }}
              title="Delete"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontWeight: 700 }}
            >✕</button>
          </div>
        ))}
      </div>

      <ExtensionStatus />
    </div>
  );
}

function PaletteBtn({ onClick, label, color, bg }: { onClick: () => void; label: string; color: string; bg: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '7px 8px', fontSize: 11, fontWeight: 700,
        background: bg, color, border: `1px solid ${color}33`, borderRadius: 6, cursor: 'pointer',
      }}
    >+ {label}</button>
  );
}

function ExtensionStatus() {
  const [status, setStatus] = useState(() => getExtensionStatus());
  useEffect(() => {
    const t = window.setInterval(() => setStatus(getExtensionStatus()), 2000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'white', padding: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6 }}>
        DuckDB extensions
      </div>
      {status.map((s) => (
        <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 3 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: s.loaded ? 'var(--green)' : s.error ? 'var(--red)' : 'var(--border-strong)',
          }} />
          <span style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{s.name}</span>
          {s.error && (
            <span title={s.error} style={{ color: 'var(--red)', marginLeft: 'auto', fontSize: 10 }}>error</span>
          )}
        </div>
      ))}
    </div>
  );
}

interface InspectorProps {
  node: PipelineNode | null;
  tables: TableMeta[];
  availableRefs: string[];
  onChange: (patch: Partial<PipelineNode>) => void;
  runResult: NodeRunResult | null;
  selectedCell: SelectedCell | null;
  onCellClick: (rowIdx: number, colIdx: number) => void;
  pipelineNodes: readonly PipelineNode[];
}

function Inspector({ node, tables, availableRefs, onChange, runResult, selectedCell, onCellClick, pipelineNodes }: InspectorProps) {
  if (!node) {
    return (
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'white', padding: 14, fontSize: 12, color: 'var(--muted)' }}>
        Select a node to edit it. Click an empty area of the canvas to deselect.
      </div>
    );
  }
  const nameInvalid = !isValidRelationName(node.name);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden', minHeight: 0 }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'white', padding: 12, overflowY: 'auto' }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 8 }}>
          {node.kind} node
        </div>

        <Field label="Name">
          <input
            value={node.name}
            onChange={(e) => onChange({ name: e.target.value } as Partial<PipelineNode>)}
            style={{
              width: '100%', padding: '5px 8px', border: `1px solid ${nameInvalid ? 'var(--red)' : 'var(--border)'}`,
              borderRadius: 4, fontFamily: 'monospace', fontSize: 12,
            }}
          />
          {nameInvalid && <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 2 }}>Must start with a letter or _ and contain only letters, digits, _.</div>}
        </Field>

        {node.kind === 'source' && (
          <Field label="Source table">
            <select
              value={node.table}
              onChange={(e) => onChange({ table: e.target.value } as Partial<PipelineNode>)}
              style={selectStyle}
            >
              <option value="">— select —</option>
              {tables.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.rowCount.toLocaleString()} rows)</option>)}
            </select>
          </Field>
        )}

        {node.kind === 'seed' && (
          <>
            <Field label="Format">
              <select value={node.format} onChange={(e) => onChange({ format: e.target.value as SeedFormat } as Partial<PipelineNode>)} style={selectStyle}>
                {SEED_FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
            </Field>
            <Field label="Content">
              <textarea
                value={node.content}
                onChange={(e) => onChange({ content: e.target.value } as Partial<PipelineNode>)}
                rows={8}
                placeholder={node.format === 'csv' ? 'id,name\n1,foo\n2,bar' : '[{"id":1,"name":"foo"}]'}
                style={{ ...selectStyle, fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
              />
            </Field>
            <FileLoader
              accept={node.format === 'csv' ? '.csv,text/csv' : '.json,application/json'}
              onLoad={(text) => onChange({ content: text } as Partial<PipelineNode>)}
            />
          </>
        )}

        {node.kind === 'sql' && (
          <>
            <Field label="Materialization">
              <select
                value={node.materialization}
                onChange={(e) => onChange({ materialization: e.target.value as 'view' | 'table' } as Partial<PipelineNode>)}
                style={selectStyle}
              >
                <option value="view">VIEW (lazy)</option>
                <option value="table">TABLE (materialized)</option>
              </select>
            </Field>
            <Field label="SQL">
              <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                <SqlNodeEditor
                  value={node.sql}
                  onChange={(v) => onChange({ sql: v } as Partial<PipelineNode>)}
                  availableRefs={availableRefs}
                  availableTables={tables}
                />
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
                Use <code style={codeStyle}>{'{{ ref(\'node_name\') }}'}</code> to depend on another node.
              </div>
            </Field>
          </>
        )}

        {node.kind === 'output' && (
          <>
            <Field label="Format">
              <select value={node.format} onChange={(e) => onChange({ format: e.target.value as OutputFormat } as Partial<PipelineNode>)} style={selectStyle}>
                {OUTPUT_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
            <Field label="Preview row limit">
              <input
                type="number" min={1} max={100000} value={node.rowLimit}
                onChange={(e) => onChange({ rowLimit: Number(e.target.value) } as Partial<PipelineNode>)}
                style={selectStyle}
              />
            </Field>
            {runResult?.preview && node.format !== 'preview' && (
              <DownloadFromPreview node={node} preview={runResult.preview} />
            )}
          </>
        )}

        {node.kind === 'file' && (
          <FileNodeInspector
            node={node}
            onChange={onChange}
          />
        )}

        {node.kind === 'notebook' && (
          <NotebookInspector
            node={node}
            tables={tables}
            availableRefs={availableRefs}
            onChange={onChange}
          />
        )}
      </div>

      {runResult && (
        <ResultPanel
          result={runResult}
          onCellClick={onCellClick}
          selectedCell={selectedCell}
        />
      )}

      {runResult && selectedCell && runResult.lineage && (
        <LineagePanel
          result={runResult}
          selectedCell={selectedCell}
          pipelineNodes={pipelineNodes}
        />
      )}
    </div>
  );
}

// ── Notebook inspector ──────────────────────────────────────────────────

function NotebookInspector({
  node,
  tables,
  availableRefs,
  onChange,
}: {
  node: PipelineNotebookNode;
  tables: TableMeta[];
  availableRefs: string[];
  onChange: (patch: Partial<PipelineNode>) => void;
}) {
  const updateCell = (idx: number, patch: Partial<NotebookCell>) => {
    const next = node.cells.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    onChange({ cells: next } as Partial<PipelineNode>);
  };
  const addCell = (kind: NotebookCell['kind']) => {
    const taken = new Set(node.cells.map((c) => c.name.toLowerCase()));
    let n = node.cells.length + 1;
    let name = `cell_${n}`;
    while (taken.has(name.toLowerCase())) { n += 1; name = `cell_${n}`; }
    const fresh: NotebookCell = kind === 'sql'
      ? { id: crypto.randomUUID(), kind, name, materialization: 'view', content: '-- new cell\nSELECT 1' }
      : { id: crypto.randomUUID(), kind, name: `note_${n}`, content: '## ' };
    onChange({ cells: [...node.cells, fresh] } as Partial<PipelineNode>);
  };
  const removeCell = (idx: number) => {
    if (!confirm(`Delete cell "${node.cells[idx]?.name ?? ''}"?`)) return;
    onChange({ cells: node.cells.filter((_, i) => i !== idx) } as Partial<PipelineNode>);
  };
  const moveCell = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= node.cells.length) return;
    const next = [...node.cells];
    const [item] = next.splice(idx, 1);
    if (item) next.splice(target, 0, item);
    onChange({ cells: next } as Partial<PipelineNode>);
  };

  // Cells higher up in the notebook are valid refs for cells lower down.
  const cellRefs = (currentIdx: number): string[] =>
    node.cells.slice(0, currentIdx).filter((c) => c.kind === 'sql').map((c) => c.name);

  return (
    <>
      <Field label={`Cells (${node.cells.length})`}>
        <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 6 }}>
          The last SQL cell becomes the notebook's public output. Earlier cells are
          materialised as their own views, referenceable by other cells and pipeline nodes
          via <code style={codeStyle}>{'{{ ref(\'cell_name\') }}'}</code>.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {node.cells.map((cell, idx) => (
            <NotebookCellEditor
              key={cell.id}
              cell={cell}
              index={idx}
              total={node.cells.length}
              onChange={(patch) => updateCell(idx, patch)}
              onRemove={() => removeCell(idx)}
              onMove={(dir) => moveCell(idx, dir)}
              availableRefs={[...cellRefs(idx), ...availableRefs]}
              tables={tables}
            />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button
            onClick={() => addCell('sql')}
            style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, background: 'var(--accent-soft)', color: 'var(--navy)', border: '1px solid var(--accent-border)', borderRadius: 4, cursor: 'pointer' }}
          >+ SQL cell</button>
          <button
            onClick={() => addCell('markdown')}
            style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, background: 'var(--surface-muted)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}
          >+ Markdown</button>
        </div>
      </Field>
    </>
  );
}

function NotebookCellEditor({
  cell,
  index,
  total,
  onChange,
  onRemove,
  onMove,
  availableRefs,
  tables,
}: {
  cell: NotebookCell;
  index: number;
  total: number;
  onChange: (patch: Partial<NotebookCell>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  availableRefs: string[];
  tables: TableMeta[];
}) {
  const nameInvalid = cell.kind === 'sql' && !isValidRelationName(cell.name);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'white', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: 'var(--surface-muted)', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>[{index + 1}/{total}]</span>
        <select
          value={cell.kind}
          onChange={(e) => onChange({ kind: e.target.value as NotebookCell['kind'] })}
          style={{ ...selectStyle, width: 'auto', flex: '0 0 100px', fontSize: 11 }}
        >
          <option value="sql">SQL</option>
          <option value="markdown">Markdown</option>
        </select>
        <input
          value={cell.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={cell.kind === 'sql' ? 'cell_name' : 'note_name'}
          style={{
            flex: 1, padding: '3px 6px', border: `1px solid ${nameInvalid ? 'var(--red)' : 'var(--border)'}`,
            borderRadius: 4, fontFamily: 'monospace', fontSize: 11,
          }}
        />
        {cell.kind === 'sql' && (
          <select
            value={cell.materialization ?? 'view'}
            onChange={(e) => onChange({ materialization: e.target.value as 'view' | 'table' })}
            title="Materialization"
            style={{ ...selectStyle, width: 'auto', flex: '0 0 80px', fontSize: 11 }}
          >
            <option value="view">VIEW</option>
            <option value="table">TABLE</option>
          </select>
        )}
        <button
          onClick={() => onMove(-1)}
          disabled={index === 0}
          title="Move up"
          style={{ ...iconBtnStyle, opacity: index === 0 ? 0.4 : 1 }}
        >↑</button>
        <button
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          title="Move down"
          style={{ ...iconBtnStyle, opacity: index === total - 1 ? 0.4 : 1 }}
        >↓</button>
        <button
          onClick={onRemove}
          title="Delete cell"
          style={{ ...iconBtnStyle, color: 'var(--red)' }}
        >✕</button>
      </div>
      {cell.kind === 'sql' ? (
        <SqlNodeEditor
          value={cell.content}
          onChange={(v) => onChange({ content: v })}
          availableRefs={availableRefs}
          availableTables={tables}
          height={160}
        />
      ) : (
        <textarea
          value={cell.content}
          onChange={(e) => onChange({ content: e.target.value })}
          rows={4}
          placeholder="# Heading&#10;&#10;Narrative text in Markdown — not executed."
          style={{
            width: '100%', border: 'none', resize: 'vertical',
            padding: 8, fontSize: 12, fontFamily: 'system-ui, -apple-system, sans-serif',
            outline: 'none',
          }}
        />
      )}
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  width: 24, height: 24, padding: 0,
  background: 'transparent', border: '1px solid var(--border)', borderRadius: 4,
  cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)',
};

function FileNodeInspector({
  node,
  onChange,
}: {
  node: PipelineFileNode;
  onChange: (patch: Partial<PipelineNode>) => void;
}) {
  const onFile = async (file: File) => {
    const text = await file.text();
    const groups = parseAgsGroups(text);
    onChange({
      content: text,
      fileName: file.name,
      groups,
    } as Partial<PipelineNode>);
  };
  return (
    <>
      <Field label="AGS file">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{
            display: 'inline-block', padding: '4px 10px', fontSize: 11, fontWeight: 600,
            background: 'var(--surface-muted)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
          }}>
            {node.fileName ? 'Replace…' : 'Load file…'}
            <input
              type="file"
              accept=".ags,text/plain"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) await onFile(f);
              }}
              style={{ display: 'none' }}
            />
          </label>
          <span style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.fileName || 'no file loaded'}
          </span>
        </div>
      </Field>

      {node.groups.length > 0 && (
        <Field label={`Exposed relations (${node.groups.length})`}>
          <div style={{
            maxHeight: 180, overflowY: 'auto',
            border: '1px solid var(--border)', borderRadius: 4, padding: 6,
            background: 'var(--surface-muted)', fontSize: 11, fontFamily: 'monospace',
          }}>
            {node.groups.map((g) => (
              <div key={g.name} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ color: 'var(--navy)', fontWeight: 600 }}>
                  {`${node.name.toLowerCase()}_${g.name.toLowerCase()}`}
                </span>
                <span style={{ color: 'var(--muted)', fontSize: 10 }}>
                  · {g.rowCount.toLocaleString()} rows · {g.columns.length} cols
                </span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
            Reference in SQL via <code style={codeStyle}>{'{{ ref(\'name_group\') }}'}</code>.
          </div>
        </Field>
      )}

      {node.content && node.groups.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>
          Could not parse this file as AGS.
        </div>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '5px 8px', border: '1px solid var(--border)',
  borderRadius: 4, fontSize: 12, background: 'white',
};

const codeStyle: React.CSSProperties = {
  background: 'var(--surface-muted)', padding: '1px 4px', borderRadius: 3,
  fontFamily: 'monospace', fontSize: 10,
};

function FileLoader({ accept, onLoad }: { accept: string; onLoad: (text: string) => void }) {
  return (
    <label style={{ display: 'inline-block', padding: '4px 10px', fontSize: 11, fontWeight: 600, background: 'var(--surface-muted)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>
      Load file…
      <input
        type="file"
        accept={accept}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          onLoad(await f.text());
        }}
        style={{ display: 'none' }}
      />
    </label>
  );
}

function DownloadFromPreview({ node, preview }: { node: OutputNode; preview: NonNullable<NodeRunResult['preview']> }) {
  const onDownload = () => {
    const fmt = node.format;
    let blob: Blob;
    let ext: string;
    if (fmt === 'csv') {
      const header = preview.columns.join(',') + '\n';
      const body = preview.rows.map((r) => r.map(csvCell).join(',')).join('\n');
      blob = new Blob([header + body], { type: 'text/csv' });
      ext = 'csv';
    } else if (fmt === 'json' || fmt === 'geojson') {
      const objs = preview.rows.map((r) => Object.fromEntries(preview.columns.map((c, i) => [c, r[i]])));
      blob = new Blob([JSON.stringify(objs, null, 2)], { type: 'application/json' });
      ext = fmt === 'geojson' ? 'geojson' : 'json';
    } else {
      // Parquet requires a server-side conversion; surface a clear hint.
      blob = new Blob([
        `Parquet output is not yet supported in the browser preview.\n` +
        `Use the Query tab or duckdb CLI to write Parquet.\n`,
      ], { type: 'text/plain' });
      ext = 'txt';
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${node.name}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  return (
    <button onClick={onDownload} style={{ marginTop: 4, padding: '6px 10px', fontSize: 12, fontWeight: 600, background: 'var(--accent-soft)', color: 'var(--navy)', border: '1px solid var(--accent-border)', borderRadius: 4, cursor: 'pointer' }}>
      Download as {node.format.toUpperCase()}
    </button>
  );
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function ResultPanel({
  result,
  onCellClick,
  selectedCell,
}: {
  result: NodeRunResult;
  onCellClick: (rowIdx: number, colIdx: number) => void;
  selectedCell: { rowIdx: number; colIdx: number } | null;
}) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'white', padding: 10, minHeight: 0, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>
          Result
        </span>
        <LineageBadge result={result} />
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted)' }}>
          {result.durationMs.toFixed(1)}ms
        </span>
      </div>
      {result.status === 'error' ? (
        <div style={{ fontSize: 11, color: 'var(--red)', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{result.error}</div>
      ) : result.preview ? (
        <ResultTable
          preview={result.preview}
          lineage={result.lineage}
          onCellClick={onCellClick}
          selectedCell={selectedCell}
        />
      ) : (
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>No preview.</div>
      )}
      {result.lineageWarnings.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 10, color: 'var(--amber)' }}>
          {result.lineageWarnings.map((w, i) => <div key={i}>· {w}</div>)}
        </div>
      )}
    </div>
  );
}

function LineageBadge({ result }: { result: NodeRunResult }) {
  if (result.lineage === null) {
    return (
      <span title="Lineage unavailable for this node" style={{ fontSize: 10, color: 'var(--muted)', padding: '1px 6px', border: '1px solid var(--border)', borderRadius: 3 }}>
        no lineage
      </span>
    );
  }
  return (
    <span title="Click any cell to see contributing source rows" style={{ fontSize: 10, color: 'var(--green)', padding: '1px 6px', background: 'var(--green-soft)', border: '1px solid var(--green-border)', borderRadius: 3 }}>
      ↩ lineage
    </span>
  );
}

function ResultTable({
  preview,
  lineage,
  onCellClick,
  selectedCell,
}: {
  preview: NonNullable<NodeRunResult['preview']>;
  lineage: NodeRunResult['lineage'];
  onCellClick: (rowIdx: number, colIdx: number) => void;
  selectedCell: { rowIdx: number; colIdx: number } | null;
}) {
  const canClick = lineage !== null;
  return (
    <div style={{ overflow: 'auto', maxHeight: 220 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
        <thead>
          <tr>
            {preview.columns.map((c) => (
              <th key={c} style={{ textAlign: 'left', padding: '3px 8px', borderBottom: '1px solid var(--border)', color: 'var(--navy)', background: 'var(--surface-muted)', position: 'sticky', top: 0 }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => {
                const isSelected = selectedCell?.rowIdx === i && selectedCell.colIdx === j;
                return (
                  <td
                    key={j}
                    onClick={canClick ? () => onCellClick(i, j) : undefined}
                    style={{
                      padding: '2px 8px',
                      borderBottom: '1px solid var(--border)',
                      cursor: canClick ? 'pointer' : 'default',
                      background: isSelected ? 'var(--accent-soft)' : undefined,
                      outline: isSelected ? '1.5px solid var(--accent)' : undefined,
                    }}
                  >
                    {v === null ? <span style={{ color: 'var(--muted)' }}>NULL</span> : String(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>{preview.rowCount.toLocaleString()} row{preview.rowCount !== 1 ? 's' : ''}</div>
    </div>
  );
}

// ── Cell lineage panel ──────────────────────────────────────────────────

interface ResolvedContributor {
  node: string;
  row: number;
  data: { columns: string[]; values: (string | number | boolean | null)[] } | null;
}

function LineagePanel({
  result,
  selectedCell,
  pipelineNodes,
}: {
  result: NodeRunResult;
  selectedCell: SelectedCell;
  pipelineNodes: readonly PipelineNode[];
}) {
  const entries: LineageEntry[] = result.lineage?.[selectedCell.rowIdx] ?? [];
  const columnName = result.preview?.columns[selectedCell.colIdx] ?? '';
  const cellValue = result.preview?.rows[selectedCell.rowIdx]?.[selectedCell.colIdx];
  const columnLineage: ResolvedColumnLineage | null =
    result.columnLineage?.[selectedCell.colIdx] ?? null;
  const [resolved, setResolved] = useState<ResolvedContributor[]>([]);
  const [loading, setLoading] = useState(false);

  // Friendly display name for a relation: file groups → "siteA · LOCA";
  // SQL/source/seed → original node name.
  const relationLabel = useCallback((relation: string): string => {
    for (const n of pipelineNodes) {
      if (n.kind === 'file') {
        for (const g of n.groups) {
          if (fileRelationName(n, g.name) === relation) return `${n.name} · ${g.name}`;
        }
      } else if (n.kind === 'source' && n.table.toLowerCase() === relation) {
        return `${n.name} → ${n.table}`;
      } else if (n.name.toLowerCase() === relation) {
        return n.name;
      }
    }
    return relation;
  }, [pipelineNodes]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const out: ResolvedContributor[] = [];
      // Cap fetch count so a huge aggregation doesn't lock the UI.
      const limit = Math.min(entries.length, 50);
      for (let i = 0; i < limit; i++) {
        const e = entries[i]!;
        try {
          const data = await fetchLineageRow(e.node, e.row);
          out.push({ node: e.node, row: e.row, data });
        } catch {
          out.push({ node: e.node, row: e.row, data: null });
        }
        if (cancelled) return;
      }
      if (!cancelled) {
        setResolved(out);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [entries]);

  // Group contributors by relation.
  const byRelation = useMemo(() => {
    const m = new Map<string, ResolvedContributor[]>();
    for (const r of resolved) {
      const list = m.get(r.node) ?? [];
      list.push(r);
      m.set(r.node, list);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [resolved]);

  // For the clicked output column, which source columns light up — keyed
  // by lowercase relation name.
  const highlightCols = useMemo(() => {
    const m = new Map<string, Set<string>>();
    if (!columnLineage) return m;
    for (const s of columnLineage.sources) {
      const rel = s.relation.toLowerCase();
      const set = m.get(rel) ?? new Set<string>();
      set.add(s.column.toLowerCase());
      m.set(rel, set);
    }
    return m;
  }, [columnLineage]);

  return (
    <div style={{ border: '1px solid var(--accent-border)', borderRadius: 8, background: 'var(--accent-soft)', padding: 10, minHeight: 0, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--navy)' }}>
          Cell lineage
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>
          row {selectedCell.rowIdx + 1} · {columnName} = {cellValue === null || cellValue === undefined ? 'NULL' : String(cellValue).slice(0, 40)}
        </span>
      </div>
      {columnLineage && (
        <div style={{ marginBottom: 8, padding: '4px 6px', background: 'white', border: '1px solid var(--accent-border)', borderRadius: 4 }}>
          <ColumnLineageSummary
            lineage={columnLineage}
            columnName={columnName}
            relationLabel={relationLabel}
          />
        </div>
      )}
      {entries.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>This row has no tracked contributors.</div>
      ) : loading ? (
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>Loading {entries.length} contributor{entries.length === 1 ? '' : 's'}…</div>
      ) : (
        <>
          {entries.length > resolved.length && (
            <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 6 }}>
              Showing first {resolved.length} of {entries.length} contributing rows.
            </div>
          )}
          {byRelation.map(([rel, contribs]) => {
            const cols = highlightCols.get(rel.toLowerCase()) ?? null;
            return (
              <div key={rel} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--navy)', marginBottom: 4 }}>
                  {relationLabel(rel)}
                  <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 400, color: 'var(--muted)' }}>
                    · {contribs.length} row{contribs.length === 1 ? '' : 's'}
                  </span>
                  {cols && cols.size > 0 && (
                    <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 600, color: 'var(--accent)' }}>
                      · column{cols.size === 1 ? '' : 's'}: {[...cols].join(', ')}
                    </span>
                  )}
                </div>
                <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 4, overflow: 'auto', maxHeight: 220 }}>
                  <ContributorTable contribs={contribs} highlightCols={cols} />
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function ColumnLineageSummary({
  lineage,
  columnName,
  relationLabel,
}: {
  lineage: ResolvedColumnLineage;
  columnName: string;
  relationLabel: (rel: string) => string;
}) {
  const tag =
    lineage.derivation === 'direct'      ? { label: 'direct',      color: 'var(--green)' }
    : lineage.derivation === 'expression' ? { label: 'expression', color: 'var(--accent)' }
    : lineage.derivation === 'aggregated' ? { label: 'aggregated', color: 'var(--amber)' }
    : lineage.derivation === 'star'       ? { label: 'star',       color: 'var(--muted)' }
    : lineage.derivation === 'literal'    ? { label: 'literal',    color: 'var(--muted)' }
    :                                        { label: 'unknown',   color: 'var(--red)' };
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
      <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--navy)' }}>{columnName || lineage.name}</span>
      <span style={{ fontSize: 10, color: tag.color, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
        ← {tag.label}
      </span>
      {lineage.sources.length === 0 && lineage.derivation === 'literal' && (
        <span style={{ color: 'var(--muted)' }}>(no source columns)</span>
      )}
      {lineage.sources.length === 0 && lineage.derivation === 'star' && lineage.starOf && (
        <span style={{ fontFamily: 'monospace', color: 'var(--muted)' }}>{relationLabel(lineage.starOf)}.*</span>
      )}
      {lineage.sources.map((s, i) => (
        <span key={i} style={{ fontFamily: 'monospace', color: 'var(--text-dim)' }}>
          {i > 0 && <span style={{ color: 'var(--muted)' }}>, </span>}
          {relationLabel(s.relation)}.<span style={{ color: 'var(--navy)' }}>{s.column}</span>
        </span>
      ))}
    </div>
  );
}

function ContributorTable({
  contribs,
  highlightCols,
}: {
  contribs: ResolvedContributor[];
  highlightCols: Set<string> | null;
}) {
  // Use the columns from the first contributor that resolved; if none did,
  // show a minimal "row id only" table.
  const firstWithData = contribs.find((c) => c.data !== null);
  if (!firstWithData) {
    return (
      <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace', width: '100%' }}>
        <tbody>
          {contribs.map((c, i) => (
            <tr key={i}>
              <td style={{ padding: '2px 8px', color: 'var(--muted)' }}>row #{c.row}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const columns = firstWithData.data!.columns;
  const isHighlighted = (col: string): boolean =>
    highlightCols !== null && highlightCols.size > 0 && highlightCols.has(col.toLowerCase());
  const anyHighlight = highlightCols !== null && highlightCols.size > 0;
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace', width: '100%' }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left', padding: '3px 8px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)', color: 'var(--muted)', position: 'sticky', top: 0 }}>#</th>
          {columns.map((c) => {
            const hl = isHighlighted(c);
            return (
              <th
                key={c}
                style={{
                  textAlign: 'left', padding: '3px 8px',
                  borderBottom: '1px solid var(--border)',
                  background: hl ? 'var(--accent-soft)' : 'var(--surface-muted)',
                  color: hl ? 'var(--accent)' : 'var(--navy)',
                  fontWeight: hl ? 800 : 600,
                  position: 'sticky', top: 0,
                }}
              >
                {c}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {contribs.map((c, i) => {
          const vals = c.data?.values;
          return (
            <tr key={i}>
              <td style={{ padding: '2px 8px', color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>{c.row}</td>
              {columns.map((col, j) => {
                const idx = c.data?.columns.indexOf(col) ?? -1;
                const v = idx >= 0 && vals ? vals[idx] : null;
                const hl = isHighlighted(col);
                return (
                  <td
                    key={j}
                    style={{
                      padding: '2px 8px',
                      borderBottom: '1px solid var(--border)',
                      background: hl ? 'var(--accent-soft)' : undefined,
                      color: hl ? 'var(--navy)' : (anyHighlight ? 'var(--muted)' : undefined),
                      fontWeight: hl ? 700 : 400,
                    }}
                  >
                    {v === null || v === undefined ? <span style={{ color: 'var(--muted)' }}>NULL</span> : String(v).slice(0, 80)}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
