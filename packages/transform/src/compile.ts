import { topoSort } from './dag.js';
import type {
  FileNode,
  NotebookCell,
  NotebookNode,
  OutputNode,
  Pipeline,
  PipelineNode,
  SqlNode,
} from './model.js';
import { isValidRelationName } from './model.js';
import { extractRefs, quoteIdent, resolveRefs } from './refs.js';

export interface CompiledStep {
  nodeId: string;
  nodeName: string;
  kind: PipelineNode['kind'];
  /**
   * SQL to execute that creates/refreshes the relation for this step.
   * `null` for sources, file nodes and outputs (handled at runtime).
   */
  sql: string | null;
  /**
   * SQL the executor should run to surface results for this step.
   */
  preview: string | null;
  /**
   * For SQL and notebook-cell steps: the resolved SELECT body (refs
   * substituted), without the `CREATE OR REPLACE VIEW … AS` wrapper.
   * Used by the executor's lineage and column-lineage passes so they
   * don't have to strip the DDL prefix back off.
   */
  selectSql?: string | null;
  /**
   * For notebook-cell steps: the name of the relation this cell creates
   * (= cell name lower-cased). Lets the executor track per-cell
   * column lineage in the resolution map.
   */
  cellRelation?: string | null;
}

export interface CompileError {
  nodeId: string | null;
  message: string;
}

export interface CompileResult {
  steps: CompiledStep[];
  errors: CompileError[];
}

export interface CompileOptions {
  /**
   * Names of relations that already exist in DuckDB (typically AGS group
   * tables registered by the host app, plus any tables that file nodes
   * have registered for this run).
   */
  existingTables?: ReadonlySet<string>;
}

export function fileRelationName(file: FileNode, group: string): string {
  return `${file.name}_${group}`.toLowerCase();
}

interface RelationTarget {
  kind: 'node';
  node: PipelineNode;
}
interface FileRelationTarget {
  kind: 'file-group';
  node: FileNode;
  groupName: string;
}
interface NotebookCellTarget {
  kind: 'notebook-cell';
  node: NotebookNode;
  cell: NotebookCell;
}
type ResolvedRelation = RelationTarget | FileRelationTarget | NotebookCellTarget;

export function compile(pipeline: Pipeline, opts: CompileOptions = {}): CompileResult {
  const errors: CompileError[] = [];
  const nodesById = new Map(pipeline.nodes.map((n) => [n.id, n]));
  const relationsByName = new Map<string, ResolvedRelation>();
  const nodeNamesSeen = new Map<string, string>();

  for (const node of pipeline.nodes) {
    if (!isValidRelationName(node.name)) {
      errors.push({ nodeId: node.id, message: `Invalid relation name: "${node.name}"` });
      continue;
    }
    const lower = node.name.toLowerCase();
    if (nodeNamesSeen.has(lower)) {
      errors.push({ nodeId: node.id, message: `Duplicate node name: "${node.name}"` });
      continue;
    }
    nodeNamesSeen.set(lower, node.id);

    if (node.kind === 'file') {
      for (const g of node.groups) {
        const rel = fileRelationName(node, g.name);
        if (relationsByName.has(rel)) {
          errors.push({
            nodeId: node.id,
            message: `Relation "${rel}" collides with another node`,
          });
          continue;
        }
        relationsByName.set(rel, { kind: 'file-group', node, groupName: g.name });
      }
    } else if (node.kind === 'notebook') {
      // Reserve the notebook's public name (passthrough of last SQL cell).
      if (relationsByName.has(lower)) {
        errors.push({
          nodeId: node.id,
          message: `Relation "${lower}" collides with another node`,
        });
        continue;
      }
      relationsByName.set(lower, { kind: 'node', node });
      // Register each SQL cell as its own relation. Cells reference each
      // other (and outer nodes) via the same {{ ref('name') }} machinery.
      const seenInside = new Set<string>();
      for (const cell of node.cells) {
        if (cell.kind !== 'sql') continue;
        if (!isValidRelationName(cell.name)) {
          errors.push({ nodeId: node.id, message: `Notebook ${node.name}: invalid cell name "${cell.name}"` });
          continue;
        }
        const cellLower = cell.name.toLowerCase();
        if (cellLower === lower) {
          errors.push({ nodeId: node.id, message: `Notebook cell "${cell.name}" collides with the notebook's own name` });
          continue;
        }
        if (seenInside.has(cellLower)) {
          errors.push({ nodeId: node.id, message: `Notebook ${node.name}: duplicate cell name "${cell.name}"` });
          continue;
        }
        if (relationsByName.has(cellLower)) {
          errors.push({ nodeId: node.id, message: `Notebook cell "${cell.name}" collides with another node` });
          continue;
        }
        seenInside.add(cellLower);
        relationsByName.set(cellLower, { kind: 'notebook-cell', node, cell });
      }
    } else {
      if (relationsByName.has(lower)) {
        errors.push({
          nodeId: node.id,
          message: `Relation "${lower}" collides with another node`,
        });
        continue;
      }
      relationsByName.set(lower, { kind: 'node', node });
    }
  }

  if (opts.existingTables) {
    for (const node of pipeline.nodes) {
      if (node.kind !== 'source') continue;
      if (!opts.existingTables.has(node.table.toLowerCase())) {
        errors.push({
          nodeId: node.id,
          message: `Source table "${node.table}" is not registered in DuckDB`,
        });
      }
    }
  }

  for (const node of pipeline.nodes) {
    if (node.kind !== 'file') continue;
    if (!node.content.trim()) {
      errors.push({ nodeId: node.id, message: `File node "${node.name}" has no content loaded` });
    }
    if (node.groups.length === 0 && node.content.trim()) {
      errors.push({ nodeId: node.id, message: `File node "${node.name}" parsed zero groups` });
    }
  }

  for (const edge of pipeline.edges) {
    if (!nodesById.has(edge.source)) {
      errors.push({ nodeId: null, message: `Edge ${edge.id} references missing source node ${edge.source}` });
    }
    if (!nodesById.has(edge.target)) {
      errors.push({ nodeId: null, message: `Edge ${edge.id} references missing target node ${edge.target}` });
    }
  }

  const { order, cycles } = topoSort(pipeline.nodes, pipeline.edges);
  if (cycles.length > 0) {
    for (const cycle of cycles) {
      const names = cycle.map((id) => nodesById.get(id)?.name ?? id).join(' → ');
      errors.push({ nodeId: cycle[0] ?? null, message: `Cycle detected: ${names}` });
    }
  }

  const steps: CompiledStep[] = [];

  for (const id of order) {
    const node = nodesById.get(id);
    if (!node) continue;

    switch (node.kind) {
      case 'source': {
        steps.push({
          nodeId: node.id,
          nodeName: node.name,
          kind: 'source',
          sql: null,
          preview: `SELECT * FROM ${quoteIdent(node.table)} LIMIT 100`,
        });
        break;
      }
      case 'seed': {
        steps.push({
          nodeId: node.id,
          nodeName: node.name,
          kind: 'seed',
          sql: null,
          preview: `SELECT * FROM ${quoteIdent(node.name.toLowerCase())} LIMIT 100`,
        });
        break;
      }
      case 'file': {
        const first = node.groups[0];
        steps.push({
          nodeId: node.id,
          nodeName: node.name,
          kind: 'file',
          sql: null,
          preview: first
            ? `SELECT * FROM ${quoteIdent(fileRelationName(node, first.name))} LIMIT 100`
            : null,
        });
        break;
      }
      case 'sql': {
        const compiled = compileSqlNode(node, relationsByName, errors);
        if (compiled !== null) steps.push(compiled);
        break;
      }
      case 'output': {
        const compiled = compileOutputNode(node, pipeline, nodesById, errors);
        if (compiled !== null) steps.push(compiled);
        break;
      }
      case 'notebook': {
        for (const cellStep of compileNotebookNode(node, relationsByName, errors)) {
          steps.push(cellStep);
        }
        break;
      }
    }
  }

  return { steps, errors };
}

function compileSqlNode(
  node: SqlNode,
  relationsByName: Map<string, ResolvedRelation>,
  errors: CompileError[],
): CompiledStep | null {
  const refs = extractRefs(node.sql);
  for (const ref of refs) {
    if (!relationsByName.has(ref.toLowerCase())) {
      errors.push({ nodeId: node.id, message: `Unknown ref: "${ref}"` });
    }
  }
  const resolved = resolveRefs(node.sql, (name) => {
    const target = relationsByName.get(name.toLowerCase());
    if (!target) return quoteIdent(name);
    return relationForTarget(target);
  });

  const kind = node.materialization === 'table' ? 'TABLE' : 'VIEW';
  const relation = quoteIdent(node.name.toLowerCase());
  const sql = `CREATE OR REPLACE ${kind} ${relation} AS\n${resolved.trim()}`;
  return {
    nodeId: node.id,
    nodeName: node.name,
    kind: 'sql',
    sql,
    preview: `SELECT * FROM ${relation} LIMIT 100`,
    selectSql: resolved.trim(),
  };
}

function compileOutputNode(
  node: OutputNode,
  pipeline: Pipeline,
  nodesById: Map<string, PipelineNode>,
  errors: CompileError[],
): CompiledStep | null {
  const upstreamIds = pipeline.edges.filter((e) => e.target === node.id).map((e) => e.source);
  if (upstreamIds.length === 0) {
    errors.push({ nodeId: node.id, message: `Output "${node.name}" has no upstream node` });
    return null;
  }
  if (upstreamIds.length > 1) {
    errors.push({ nodeId: node.id, message: `Output "${node.name}" has multiple upstream nodes (only one supported)` });
  }
  const upstream = nodesById.get(upstreamIds[0]!);
  if (!upstream) return null;
  const limit = Number.isFinite(node.rowLimit) && node.rowLimit > 0 ? Math.floor(node.rowLimit) : 1000;
  const preview = `SELECT * FROM ${relationForNode(upstream)} LIMIT ${limit}`;
  return {
    nodeId: node.id,
    nodeName: node.name,
    kind: 'output',
    sql: null,
    preview,
  };
}

function relationForNode(node: PipelineNode): string {
  if (node.kind === 'source') return quoteIdent(node.table);
  if (node.kind === 'file') {
    const first = node.groups[0];
    return first ? quoteIdent(fileRelationName(node, first.name)) : quoteIdent(node.name);
  }
  return quoteIdent(node.name.toLowerCase());
}

function relationForTarget(target: ResolvedRelation): string {
  if (target.kind === 'node') return relationForNode(target.node);
  if (target.kind === 'file-group') return quoteIdent(fileRelationName(target.node, target.groupName));
  // notebook-cell: each SQL cell materialises under its own name.
  return quoteIdent(target.cell.name.toLowerCase());
}

function compileNotebookNode(
  node: NotebookNode,
  relationsByName: Map<string, ResolvedRelation>,
  errors: CompileError[],
): CompiledStep[] {
  const sqlCells = node.cells.filter((c) => c.kind === 'sql');
  if (sqlCells.length === 0) {
    errors.push({ nodeId: node.id, message: `Notebook "${node.name}" has no SQL cells` });
    return [];
  }
  const out: CompiledStep[] = [];
  for (const cell of sqlCells) {
    const refs = extractRefs(cell.content);
    for (const ref of refs) {
      if (!relationsByName.has(ref.toLowerCase())) {
        errors.push({
          nodeId: node.id,
          message: `Notebook "${node.name}" cell "${cell.name}": unknown ref "${ref}"`,
        });
      }
    }
    const resolved = resolveRefs(cell.content, (name) => {
      const target = relationsByName.get(name.toLowerCase());
      if (!target) return quoteIdent(name);
      return relationForTarget(target);
    });
    const kind = cell.materialization === 'table' ? 'TABLE' : 'VIEW';
    const relation = quoteIdent(cell.name.toLowerCase());
    const sql = `CREATE OR REPLACE ${kind} ${relation} AS\n${resolved.trim()}`;
    out.push({
      nodeId: node.id,
      nodeName: `${node.name}/${cell.name}`,
      kind: 'notebook',
      sql,
      preview: `SELECT * FROM ${relation} LIMIT 100`,
      selectSql: resolved.trim(),
      cellRelation: cell.name.toLowerCase(),
    });
  }
  // Last SQL cell also exposes the notebook's public relation as a
  // passthrough VIEW so other pipeline nodes can `{{ ref('<notebook>') }}`.
  const last = sqlCells[sqlCells.length - 1]!;
  const publicName = quoteIdent(node.name.toLowerCase());
  const lastName = quoteIdent(last.name.toLowerCase());
  out.push({
    nodeId: node.id,
    nodeName: node.name,
    kind: 'notebook',
    sql: `CREATE OR REPLACE VIEW ${publicName} AS SELECT * FROM ${lastName}`,
    preview: `SELECT * FROM ${publicName} LIMIT 100`,
    selectSql: `SELECT * FROM ${lastName}`,
    cellRelation: node.name.toLowerCase(),
  });
  return out;
}
