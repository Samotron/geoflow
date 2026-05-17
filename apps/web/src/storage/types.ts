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
  agsBytes: Uint8Array;
  timestamp: number;
  conflictCount: number;
}
