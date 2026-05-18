import type { AgsHeading, AgsRow } from '../core.js';

export interface AgsGroupDelta {
  headings?: AgsHeading[];
  upserted?: AgsRow[];
  deleted?: string[];   // '\0'-joined primary key values
  replace?: boolean;    // clear all rows first (for no-pk groups)
}

export interface AgsFileDelta {
  groups: Record<string, AgsGroupDelta>;
  removedGroups?: string[];
}

export type CommitStorage =
  | { kind: 'snapshot'; gz: Uint8Array }    // gzip-compressed AGS text
  | { kind: 'delta'; delta: AgsFileDelta }  // row-level diff from parent
  | { kind: 'raw'; bytes: Uint8Array };     // legacy uncompressed (pre-migration)

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  headCommitId: string | null;
}

export interface Commit {
  id: string;
  projectId: string;
  parentId: string | null;
  message: string;
  storage: CommitStorage;
  timestamp: number;
  conflictCount: number;
}

/**
 * Wrapper for storing transform pipelines in IndexedDB. The pipeline JSON
 * is opaque to the storage layer — shape is defined in `@geoflow/transform`.
 */
export interface StoredPipeline {
  id: string;
  projectId: string;
  name: string;
  json: string;
  createdAt: number;
  updatedAt: number;
}
