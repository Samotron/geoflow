export type NodeKind = 'source' | 'seed' | 'sql' | 'output';

export type Materialization = 'view' | 'table';

export type SeedFormat = 'csv' | 'json';

export type OutputFormat = 'preview' | 'csv' | 'json' | 'parquet' | 'geojson';

export interface NodePosition {
  x: number;
  y: number;
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

export type PipelineNode = SourceNode | SeedNode | SqlNode | OutputNode;

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
