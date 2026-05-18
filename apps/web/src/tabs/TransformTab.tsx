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
import { emptyPipeline, isValidRelationName } from '@geoflow/transform';

import { decodeBytes, parseStr } from '../core.js';
import { listMainSchemaTables, registerAgsFile, getExtensionStatus, type TableMeta } from '../query/duckdb.js';
import type { Project } from '../storage/types.js';
import {
  exportPipeline,
  importPipelineFromFile,
  loadPipelinesForProject,
  deletePipelineById,
  savePipelineForProject,
} from '../transform/persistence.js';
import { runPipeline, type NodeRunResult } from '../transform/executor.js';
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

function TransformTabInner({ fileBytes, currentProject }: Props) {
  const [pipeline, setPipeline] = useState<Pipeline>(() => emptyPipeline(crypto.randomUUID(), 'Untitled pipeline'));
  const [pipelineList, setPipelineList] = useState<Pipeline[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [runResults, setRunResults] = useState<NodeRunResult[]>([]);
  const [running, setRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
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
    return pipeline.nodes.filter((n) => n.id !== selectedNode.id).map((n) => n.name);
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
  saveState: 'idle' | 'saving' | 'saved';
  hasProject: boolean;
  statusMsg: string | null;
}

function Toolbar(props: ToolbarProps) {
  const { pipeline, onRename, onRun, running, onNew, onExport, onImport, saveState, hasProject, statusMsg } = props;
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
          <PaletteBtn onClick={() => onAdd('seed')} label="Seed" color="#7a5a30" bg="#fbf3e2" />
          <PaletteBtn onClick={() => onAdd('sql')} label="SQL" color="#3f6d4a" bg="#ecf4ee" />
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
}

function Inspector({ node, tables, availableRefs, onChange, runResult }: InspectorProps) {
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
      </div>

      {runResult && (
        <ResultPanel result={runResult} />
      )}
    </div>
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

function ResultPanel({ result }: { result: NodeRunResult }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'white', padding: 10, minHeight: 0, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>
          Result
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted)' }}>
          {result.durationMs.toFixed(1)}ms
        </span>
      </div>
      {result.status === 'error' ? (
        <div style={{ fontSize: 11, color: 'var(--red)', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{result.error}</div>
      ) : result.preview ? (
        <ResultTable preview={result.preview} />
      ) : (
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>No preview.</div>
      )}
    </div>
  );
}

function ResultTable({ preview }: { preview: NonNullable<NodeRunResult['preview']> }) {
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
              {r.map((v, j) => (
                <td key={j} style={{ padding: '2px 8px', borderBottom: '1px solid var(--border)' }}>{v === null ? <span style={{ color: 'var(--muted)' }}>NULL</span> : String(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>{preview.rowCount.toLocaleString()} row{preview.rowCount !== 1 ? 's' : ''}</div>
    </div>
  );
}
