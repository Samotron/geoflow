export type NodeKind = 'source' | 'seed' | 'sql' | 'output' | 'file';

export type Materialization = 'view' | 'table';

export type SeedFormat = 'csv' | 'json';

export type OutputFormat = 'preview' | 'csv' | 'json' | 'parquet' | 'geojson';

export type FileFormat = 'ags';

export interface NodePosition {
  x: number;
  y: number;
}

export interface FileGroupMeta {
  name: string;
  rowCount: number;
  columns: string[];
}

export interface SourceNode {
  id: string;
  kind: 'source';
  name: string;
  table: string;
  position: NodePosition;
}

export interface SeedNode {
  id: string;
  kind: 'seed';
  name: string;
  format: SeedFormat;
  content: string;
  position: NodePosition;
}

export interface SqlNode {
  id: string;
  kind: 'sql';
  name: string;
  sql: string;
  materialization: Materialization;
  position: NodePosition;
}

export interface OutputNode {
  id: string;
  kind: 'output';
  name: string;
  format: OutputFormat;
  rowLimit: number;
  position: NodePosition;
}

/**
 * A FileNode represents an external AGS file pulled into the pipeline.
 * On execution, every group in the file is registered as a DuckDB table
 * named `{node.name}_{group}` (lowercased). Downstream SQL nodes can
 * reference any group via `{{ ref('prefix_group') }}` or by raw relation
 * name. `groups` is cached metadata for the inspector and ref validation.
 */
export interface FileNode {
  id: string;
  kind: 'file';
  name: string;
  format: FileFormat;
  fileName: string;
  content: string;
  groups: FileGroupMeta[];
  position: NodePosition;
}

export type PipelineNode = SourceNode | SeedNode | SqlNode | OutputNode | FileNode;

export interface PipelineEdge {
  id: string;
  source: string;
  target: string;
}

export interface Pipeline {
  schemaVersion: 1;
  id: string;
  name: string;
  projectId: string | null;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  createdAt: number;
  updatedAt: number;
}

const RELATION_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/i;

export function isValidRelationName(name: string): boolean {
  return RELATION_NAME_PATTERN.test(name);
}

export function emptyPipeline(id: string, name: string, projectId: string | null = null): Pipeline {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id,
    name,
    projectId,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  };
}
