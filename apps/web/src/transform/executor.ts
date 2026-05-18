import type { ColumnRef, OutputColumn, Pipeline, PipelineNode } from '@geoflow/transform';
import {
  LINEAGE_COLUMN,
  compile,
  extractColumnLineage,
  fileRelationName,
  lineageViewName,
  quoteIdent,
  resolveRefs,
  rewriteForLineage,
  type CompiledStep,
} from '@geoflow/transform';
import { decodeBytes, parseStr } from '../core.js';
import {
  fetchLineageRow,
  listMainSchemaTables,
  registerAgsGroupsWithPrefix,
  registerLineageView,
  registerSeed,
  runQuery,
  type QueryResult,
} from '../query/duckdb.js';

export interface LineageEntry {
  node: string;
  row: number;
}

export interface NodeRunResult {
  nodeId: string;
  nodeName: string;
  status: 'ok' | 'error' | 'skipped';
  error: string | null;
  durationMs: number;
  preview: QueryResult | null;
  /**
   * Per-output-row provenance, in the same order as `preview.rows`. Each
   * entry lists the upstream (relation, rowid) pairs that contributed.
   * `null` when lineage is unavailable for this node (parser bail-out,
   * external relation, etc.).
   */
  lineage: LineageEntry[][] | null;
  /**
   * Per-output-column lineage, in `preview.columns` order. Each entry
   * lists the **base-relation** `(relation, column)` pairs the output
   * column ultimately depends on (transitively resolved through any
   * intermediate SQL nodes). `null` when column lineage isn't available.
   */
  columnLineage: ResolvedColumnLineage[] | null;
  /** Warnings raised during lineage rewriting (e.g. window function bail). */
  lineageWarnings: string[];
}

export interface ResolvedColumnLineage {
  name: string;
  sources: ColumnRef[];
  derivation: OutputColumn['derivation'];
  starOf?: string;
}

export interface RunResult {
  ok: boolean;
  steps: NodeRunResult[];
  compileErrors: string[];
}

export interface RunOptions {
  onProgress?: (msg: string) => void;
}

/**
 * Compiles a pipeline, registers per-relation lineage views, materialises
 * each SQL node twice (the real model plus a `_lin_<name>` variant that
 * carries provenance), and returns per-row lineage for every preview.
 */
export async function runPipeline(pipeline: Pipeline, opts: RunOptions = {}): Promise<RunResult> {
  const onProgress = opts.onProgress ?? (() => {});

  onProgress('Inspecting DuckDB schema…');
  const existing = await listMainSchemaTables();
  const existingNames = new Set(existing.map((t) => t.name.toLowerCase()));

  // ── 1. Register seeds ────────────────────────────────────────────────
  for (const node of pipeline.nodes) {
    if (node.kind !== 'seed') continue;
    onProgress(`Seeding ${node.name}…`);
    try {
      await registerSeed(node.name, node.format, node.content);
      existingNames.add(node.name.toLowerCase());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return emptyRunResult(false, [`Seed "${node.name}" failed to load: ${msg}`]);
    }
  }

  // ── 2. Register file nodes (each group becomes a separate relation) ──
  for (const node of pipeline.nodes) {
    if (node.kind !== 'file') continue;
    if (!node.content.trim()) continue;
    onProgress(`Loading file ${node.name}…`);
    try {
      const bytes = new TextEncoder().encode(node.content);
      const { file } = parseStr(decodeBytes(bytes));
      await registerAgsGroupsWithPrefix(file, node.name);
      for (const g of node.groups) {
        existingNames.add(fileRelationName(node, g.name));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return emptyRunResult(false, [`File "${node.name}" failed to load: ${msg}`]);
    }
  }

  // ── 3. Compile (validates names, refs, DAG) ──────────────────────────
  const { steps, errors } = compile(pipeline, { existingTables: existingNames });
  if (errors.length > 0) {
    return emptyRunResult(false, errors.map((e) => e.message));
  }

  // ── 4. Determine which relations get lineage views ────────────────────
  const trackedRelations = new Set<string>();
  // SQL-derived relations whose lineage views are materialised by the
  // rewriter at step time (not up-front).
  const sqlDerived = new Set<string>();
  for (const node of pipeline.nodes) {
    if (node.kind === 'source') trackedRelations.add(node.table.toLowerCase());
    else if (node.kind === 'seed') trackedRelations.add(node.name.toLowerCase());
    else if (node.kind === 'file') {
      for (const g of node.groups) trackedRelations.add(fileRelationName(node, g.name));
    } else if (node.kind === 'sql') {
      trackedRelations.add(node.name.toLowerCase());
      sqlDerived.add(node.name.toLowerCase());
    } else if (node.kind === 'notebook') {
      // Each SQL cell, plus the notebook's public passthrough.
      trackedRelations.add(node.name.toLowerCase());
      sqlDerived.add(node.name.toLowerCase());
      for (const cell of node.cells) {
        if (cell.kind !== 'sql') continue;
        trackedRelations.add(cell.name.toLowerCase());
        sqlDerived.add(cell.name.toLowerCase());
      }
    }
  }

  // Register `_lin_` views for every base relation up front so SQL-node
  // rewrites can reference them. SQL-derived relations are handled per step.
  for (const rel of trackedRelations) {
    if (sqlDerived.has(rel)) continue;
    try {
      await registerLineageView(rel);
    } catch (err) {
      // Non-fatal: if a relation isn't registered yet (shouldn't happen),
      // its consumers will simply lose lineage.
      // eslint-disable-next-line no-console
      console.warn(`[lineage] failed to register view for "${rel}":`, err);
    }
  }

  // ── 5. Run each step (and build lineage variants for SQL nodes) ──────
  // We accumulate each SQL node's RESOLVED column lineage (base-relation
  // columns only) so downstream nodes can resolve refs transitively.
  const resolvedByRelation = new Map<string, ResolvedColumnLineage[]>();
  const results: NodeRunResult[] = [];
  let anyError = false;
  const nodesById = new Map(pipeline.nodes.map((n) => [n.id, n]));

  for (const step of steps) {
    if (anyError) {
      results.push(skippedResult(step));
      continue;
    }
    const node = nodesById.get(step.nodeId)!;
    const result = await runStep(step, node, trackedRelations, resolvedByRelation, onProgress);
    if (result.status === 'error') anyError = true;
    if (result.columnLineage) {
      // Notebook cell steps key column lineage on the cell's relation name;
      // SQL nodes (and the notebook passthrough) key on the node name.
      const key = (step.cellRelation ?? node.name).toLowerCase();
      resolvedByRelation.set(key, result.columnLineage);
    }
    results.push(result);
  }

  return { ok: !anyError, steps: results, compileErrors: [] };
}

async function runStep(
  step: CompiledStep,
  node: PipelineNode,
  trackedRelations: ReadonlySet<string>,
  resolvedByRelation: ReadonlyMap<string, ResolvedColumnLineage[]>,
  onProgress: (msg: string) => void,
): Promise<NodeRunResult> {
  const t0 = performance.now();
  const result: NodeRunResult = {
    nodeId: step.nodeId,
    nodeName: step.nodeName,
    status: 'ok',
    error: null,
    durationMs: 0,
    preview: null,
    lineage: null,
    columnLineage: null,
    lineageWarnings: [],
  };
  try {
    // 1. Materialise the user's model (if any).
    if (step.sql) {
      onProgress(`Running ${step.nodeName}…`);
      await runQuery(step.sql);
    }

    // 2. For SQL nodes and notebook cells, also build a lineage view via
    //    the rewriter. We use the compiler-provided resolved SELECT body
    //    (step.selectSql) so refs are already substituted.
    const resolvedSql = step.selectSql ?? null;
    const linTarget = step.cellRelation ?? (node.kind === 'sql' ? node.name.toLowerCase() : null);
    if (resolvedSql !== null && linTarget !== null && (node.kind === 'sql' || node.kind === 'notebook')) {
      const rewrite = rewriteForLineage(resolvedSql, { knownRelations: trackedRelations });
      result.lineageWarnings = rewrite.warnings;
      if (rewrite.rewritten !== null) {
        try {
          const linViewName = lineageViewName(linTarget);
          await runQuery(
            `CREATE OR REPLACE VIEW "${linViewName.replace(/"/g, '""')}" AS\n${rewrite.rewritten}`,
          );
        } catch (err) {
          // Lineage view failure is non-fatal — the main model still ran.
          result.lineageWarnings.push(
            `lineage view failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Compute column lineage and resolve transitively through upstream
      // SQL nodes so the surfaced sources are always base relations.
      const colLineage = extractColumnLineage(resolvedSql, { knownRelations: trackedRelations });
      if (colLineage.outputs) {
        result.columnLineage = colLineage.outputs.map((c) =>
          resolveColumnSources(c, resolvedByRelation),
        );
      }
      for (const w of colLineage.warnings) result.lineageWarnings.push(`column lineage: ${w}`);
    }

    // For non-SQL nodes (source / seed / file / output) we still want a
    // 1:1 column lineage so the UI can show "this comes from <rel>.<col>".
    if (node.kind === 'source') {
      result.columnLineage = null; // populated below once we have the preview columns.
    }

    // 3. Run the preview. For nodes whose lineage view exists, the preview
    //    pulls `__src` from the `_lin_` view so we can surface provenance.
    if (step.preview) {
      const lineageReady = await tryLineagePreview(node, step, result);
      if (!lineageReady) {
        result.preview = await runQuery(step.preview);
      }
    }

    // For source/seed/file previews, fabricate identity column lineage now
    // that we know the preview columns.
    if (result.preview && result.columnLineage === null) {
      const baseRel = baseRelationFor(node);
      if (baseRel) {
        result.columnLineage = result.preview.columns.map<ResolvedColumnLineage>((c) => ({
          name: c,
          sources: [{ relation: baseRel, column: c }],
          derivation: 'direct',
        }));
      }
    }

    // If the SQL-node column lineage and the preview columns differ in
    // order, reorder lineage to match (handles `SELECT *` and column
    // aliasing where the extractor's column-order may differ from
    // DuckDB's).
    if (node.kind === 'sql' && result.preview && result.columnLineage) {
      result.columnLineage = alignColumnLineage(result.preview.columns, result.columnLineage, node, resolvedByRelation);
    }
  } catch (err) {
    result.status = 'error';
    result.error = err instanceof Error ? err.message : String(err);
  }
  result.durationMs = performance.now() - t0;
  return result;
}

function baseRelationFor(node: PipelineNode): string | null {
  if (node.kind === 'source') return node.table.toLowerCase();
  if (node.kind === 'seed') return node.name.toLowerCase();
  if (node.kind === 'file') {
    const first = node.groups[0];
    return first ? fileRelationName(node, first.name) : null;
  }
  return null;
}

function resolveColumnSources(
  col: OutputColumn,
  resolvedByRelation: ReadonlyMap<string, ResolvedColumnLineage[]>,
): ResolvedColumnLineage {
  const seen = new Set<string>();
  const out: ColumnRef[] = [];
  const push = (refs: readonly ColumnRef[]): void => {
    for (const r of refs) {
      const k = `${r.relation.toLowerCase()}|${r.column.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  };
  for (const src of col.sources) {
    const upstream = resolvedByRelation.get(src.relation.toLowerCase());
    if (!upstream) {
      // Base relation — keep the ref as-is.
      push([src]);
      continue;
    }
    // Find the matching column in the upstream node's lineage; if found,
    // substitute its resolved sources.
    const match = upstream.find((u) => u.name.toLowerCase() === src.column.toLowerCase());
    if (match) push(match.sources);
    else push([src]); // fall back to the unresolved ref
  }
  return {
    name: col.name,
    sources: out,
    derivation: col.derivation,
    ...(col.starOf ? { starOf: col.starOf } : {}),
  };
}

/**
 * Aligns column lineage to the preview's actual column order. For star
 * expansions, fabricates per-column passthrough entries against the
 * star-of relation. Lineage entries that don't match a preview column
 * are dropped to keep the array shape correct.
 */
function alignColumnLineage(
  previewColumns: readonly string[],
  lineage: readonly ResolvedColumnLineage[],
  node: PipelineNode,
  resolvedByRelation: ReadonlyMap<string, ResolvedColumnLineage[]>,
): ResolvedColumnLineage[] {
  // Build a name-keyed index of explicit lineage entries.
  const named = new Map<string, ResolvedColumnLineage>();
  const stars: ResolvedColumnLineage[] = [];
  for (const c of lineage) {
    if (c.derivation === 'star') stars.push(c);
    else named.set(c.name.toLowerCase(), c);
  }
  const out: ResolvedColumnLineage[] = [];
  for (const colName of previewColumns) {
    const lower = colName.toLowerCase();
    const direct = named.get(lower);
    if (direct) { out.push({ ...direct, name: colName }); continue; }
    // Otherwise this column probably came from a star expansion.
    const star = stars[0];
    if (star && star.starOf) {
      const upstream = resolvedByRelation.get(star.starOf.toLowerCase());
      if (upstream) {
        const upCol = upstream.find((u) => u.name.toLowerCase() === lower);
        if (upCol) { out.push({ ...upCol, name: colName }); continue; }
      }
      out.push({
        name: colName,
        sources: [{ relation: star.starOf, column: colName }],
        derivation: 'direct',
      });
      continue;
    }
    // Unknown source.
    void node;
    out.push({ name: colName, sources: [], derivation: 'unknown' });
  }
  return out;
}

/**
 * Attempts to issue the preview against the lineage view so that __src is
 * captured alongside the data. Returns true if successful.
 */
async function tryLineagePreview(
  node: PipelineNode,
  step: CompiledStep,
  result: NodeRunResult,
): Promise<boolean> {
  if (!step.preview) return false;
  // For notebooks each cell-step carries its own cellRelation; for the
  // other kinds the relation is derived from the node.
  const previewedRelation = step.cellRelation ?? previewRelationFor(node);
  if (!previewedRelation) return false;
  const linView = lineageViewName(previewedRelation);
  // Replace the bare relation in the canned preview with its lineage view
  // and also surface __src. The preview SQL we generated is always of the
  // shape `SELECT * FROM "<rel>" LIMIT N`.
  const quoted = `"${previewedRelation.replace(/"/g, '""')}"`;
  if (!step.preview.includes(quoted)) return false;
  const linPreview = step.preview.replace(
    quoted,
    `"${linView.replace(/"/g, '""')}"`,
  );
  try {
    const qr = await runQuery(linPreview);
    const srcColIdx = qr.columns.indexOf(LINEAGE_COLUMN);
    if (srcColIdx < 0) {
      // Lineage column missing — fall back to plain preview.
      result.preview = await runQuery(step.preview);
      return true;
    }
    // Strip __src out of the visible preview and parse it into LineageEntry[].
    const columns = qr.columns.filter((_, i) => i !== srcColIdx);
    const rows = qr.rows.map((r) => r.filter((_, i) => i !== srcColIdx));
    const lineage: LineageEntry[][] = qr.rows.map((r) => parseLineageCell(r[srcColIdx]));
    result.preview = {
      columns,
      rows,
      rowCount: rows.length,
      durationMs: qr.durationMs,
    };
    result.lineage = lineage;
    return true;
  } catch {
    return false;
  }
}

function previewRelationFor(node: PipelineNode): string | null {
  switch (node.kind) {
    case 'source': return node.table.toLowerCase();
    case 'seed': return node.name.toLowerCase();
    case 'sql': return node.name.toLowerCase();
    case 'notebook': return node.name.toLowerCase();
    case 'file': {
      const first = node.groups[0];
      return first ? fileRelationName(node, first.name) : null;
    }
    case 'output': return null; // Output preview targets the upstream relation directly.
  }
}

function parseLineageCell(cell: unknown): LineageEntry[] {
  if (cell === null || cell === undefined) return [];
  // The lineage view encodes __src as VARCHAR[] of "relation|rowid" strings.
  // duckdb-wasm hands us an Array of strings; our runQuery may also
  // present it as a stringified array if it traversed the object branch.
  const entries: string[] = [];
  if (Array.isArray(cell)) {
    for (const v of cell) if (typeof v === 'string') entries.push(v);
  } else if (typeof cell === 'string') {
    // Best-effort parse of stringified array forms like "[a|1, b|2]" or
    // "[\"a|1\",\"b|2\"]". Strip brackets/quotes and split on commas.
    const inner = cell.replace(/^\[/, '').replace(/\]$/, '');
    for (const part of inner.split(',')) {
      const cleaned = part.trim().replace(/^['"]|['"]$/g, '');
      if (cleaned) entries.push(cleaned);
    }
  }
  const out: LineageEntry[] = [];
  for (const s of entries) {
    const idx = s.lastIndexOf('|');
    if (idx <= 0) continue;
    const node = s.slice(0, idx);
    const row = Number(s.slice(idx + 1));
    if (Number.isFinite(row)) out.push({ node, row });
  }
  return out;
}

/**
 * Rewrites `{{ ref('x') }}` and the lineage rewriter's references so they
 * point at `_lin_<relation>` views. The transform compiler has already
 * substituted refs in the user SQL we pass to the rewriter, so this stage
 * only needs to rewrite bare relation names — handled inside the rewriter
 * itself. No-op for now; kept as a hook for future expansion.
 */
function resolveRefsToLineageViews(sql: string, _known: ReadonlySet<string>): string {
  return sql;
}

function emptyRunResult(ok: boolean, errors: string[]): RunResult {
  return { ok, steps: [], compileErrors: errors };
}

function skippedResult(step: CompiledStep): NodeRunResult {
  return {
    nodeId: step.nodeId,
    nodeName: step.nodeName,
    status: 'skipped',
    error: null,
    durationMs: 0,
    preview: null,
    lineage: null,
    columnLineage: null,
    lineageWarnings: [],
  };
}

// Re-export for the UI to fetch contributing rows on demand.
export { fetchLineageRow };
