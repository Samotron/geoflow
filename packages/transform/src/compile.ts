import { topoSort } from './dag.js';
import type { OutputNode, Pipeline, PipelineNode, SqlNode } from './model.js';
import { isValidRelationName } from './model.js';
import { extractRefs, quoteIdent, resolveRefs } from './refs.js';

export interface CompiledStep {
  nodeId: string;
  nodeName: string;
  kind: PipelineNode['kind'];
  /**
   * SQL to execute that creates/refreshes the relation for this step.
   * `null` for source nodes (already exist) and for output nodes
   * (handled by the executor as a SELECT against the upstream).
   */
  sql: string | null;
  /**
   * SQL the executor should run to surface results for this step
   * (used by output nodes and preview pulls).
   */
  preview: string | null;
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
   * tables registered by the host app). Source nodes must reference one
   * of these — when omitted, source nodes are accepted as-is.
   */
  existingTables?: ReadonlySet<string>;
}

export function compile(pipeline: Pipeline, opts: CompileOptions = {}): CompileResult {
  const errors: CompileError[] = [];
  const nodesById = new Map(pipeline.nodes.map((n) => [n.id, n]));
  const nodesByName = new Map<string, PipelineNode>();

  for (const node of pipeline.nodes) {
    if (!isValidRelationName(node.name)) {
      errors.push({ nodeId: node.id, message: `Invalid relation name: "${node.name}"` });
      continue;
    }
    const lower = node.name.toLowerCase();
    if (nodesByName.has(lower)) {
      errors.push({ nodeId: node.id, message: `Duplicate node name: "${node.name}"` });
      continue;
    }
    nodesByName.set(lower, node);
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
      case 'sql': {
        const compiled = compileSqlNode(node, nodesByName, errors);
        if (compiled !== null) steps.push(compiled);
        break;
      }
      case 'output': {
        const compiled = compileOutputNode(node, pipeline, nodesById, errors);
        if (compiled !== null) steps.push(compiled);
        break;
      }
    }
  }

  return { steps, errors };
}

function compileSqlNode(
  node: SqlNode,
  nodesByName: Map<string, PipelineNode>,
  errors: CompileError[],
): CompiledStep | null {
  const refs = extractRefs(node.sql);
  for (const ref of refs) {
    if (!nodesByName.has(ref.toLowerCase())) {
      errors.push({ nodeId: node.id, message: `Unknown ref: "${ref}"` });
    }
  }
  const resolved = resolveRefs(node.sql, (name) => {
    const target = nodesByName.get(name.toLowerCase());
    if (!target) return quoteIdent(name);
    return relationFor(target);
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
  const preview = `SELECT * FROM ${relationFor(upstream)} LIMIT ${limit}`;
  return {
    nodeId: node.id,
    nodeName: node.name,
    kind: 'output',
    sql: null,
    preview,
  };
}

function relationFor(node: PipelineNode): string {
  if (node.kind === 'source') return quoteIdent(node.table);
  return quoteIdent(node.name.toLowerCase());
}
