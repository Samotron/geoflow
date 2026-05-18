import type { Pipeline } from '@geoflow/transform';
import { compile, type CompiledStep } from '@geoflow/transform';
import {
  listMainSchemaTables,
  registerSeed,
  runQuery,
  type QueryResult,
} from '../query/duckdb.js';

export interface NodeRunResult {
  nodeId: string;
  nodeName: string;
  status: 'ok' | 'error' | 'skipped';
  error: string | null;
  durationMs: number;
  preview: QueryResult | null;
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
 * Compiles a pipeline against the DuckDB schema, materialises every seed
 * and SQL node, and runs preview SELECTs for source / sql / output nodes.
 */
export async function runPipeline(pipeline: Pipeline, opts: RunOptions = {}): Promise<RunResult> {
  const onProgress = opts.onProgress ?? (() => {});

  onProgress('Inspecting DuckDB schema…');
  const existing = await listMainSchemaTables();
  const existingNames = new Set(existing.map((t) => t.name.toLowerCase()));

  // Register seeds before compilation so they appear in the schema set.
  for (const node of pipeline.nodes) {
    if (node.kind !== 'seed') continue;
    onProgress(`Seeding ${node.name}…`);
    try {
      await registerSeed(node.name, node.format, node.content);
      existingNames.add(node.name.toLowerCase());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        steps: [],
        compileErrors: [`Seed "${node.name}" failed to load: ${msg}`],
      };
    }
  }

  const { steps, errors } = compile(pipeline, { existingTables: existingNames });
  if (errors.length > 0) {
    return {
      ok: false,
      steps: [],
      compileErrors: errors.map((e) => e.message),
    };
  }

  const results: NodeRunResult[] = [];
  let anyError = false;

  for (const step of steps) {
    if (anyError) {
      results.push({
        nodeId: step.nodeId,
        nodeName: step.nodeName,
        status: 'skipped',
        error: null,
        durationMs: 0,
        preview: null,
      });
      continue;
    }
    const result = await runStep(step, onProgress);
    if (result.status === 'error') anyError = true;
    results.push(result);
  }

  return { ok: !anyError, steps: results, compileErrors: [] };
}

async function runStep(step: CompiledStep, onProgress: (msg: string) => void): Promise<NodeRunResult> {
  const t0 = performance.now();
  try {
    if (step.sql) {
      onProgress(`Running ${step.nodeName}…`);
      await runQuery(step.sql);
    }
    let preview: QueryResult | null = null;
    if (step.preview) {
      preview = await runQuery(step.preview);
    }
    return {
      nodeId: step.nodeId,
      nodeName: step.nodeName,
      status: 'ok',
      error: null,
      durationMs: performance.now() - t0,
      preview,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      nodeId: step.nodeId,
      nodeName: step.nodeName,
      status: 'error',
      error: msg,
      durationMs: performance.now() - t0,
      preview: null,
    };
  }
}
