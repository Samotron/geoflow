import type { Pipeline } from './model.js';

export interface PipelineExport {
  format: 'geoflow-pipeline';
  schemaVersion: 1;
  exportedAt: number;
  pipeline: Pipeline;
}

export function toExport(pipeline: Pipeline): PipelineExport {
  return {
    format: 'geoflow-pipeline',
    schemaVersion: 1,
    exportedAt: Date.now(),
    pipeline,
  };
}

export function fromExport(json: unknown): Pipeline {
  if (!json || typeof json !== 'object') {
    throw new Error('Invalid pipeline export: not an object');
  }
  const obj = json as Record<string, unknown>;
  if (obj['format'] !== 'geoflow-pipeline') {
    throw new Error(`Unknown pipeline format: ${String(obj['format'])}`);
  }
  if (obj['schemaVersion'] !== 1) {
    throw new Error(`Unsupported pipeline schema version: ${String(obj['schemaVersion'])}`);
  }
  const pipeline = obj['pipeline'];
  if (!pipeline || typeof pipeline !== 'object') {
    throw new Error('Invalid pipeline export: missing pipeline');
  }
  return pipeline as Pipeline;
}

export function exportToString(pipeline: Pipeline): string {
  return JSON.stringify(toExport(pipeline), null, 2);
}

export function parseExport(source: string): Pipeline {
  return fromExport(JSON.parse(source));
}
