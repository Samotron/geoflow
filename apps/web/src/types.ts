export interface LoadedFile {
  name: string;
  bytes: Uint8Array;
}

export type TabId = 'inspect' | 'data' | 'map' | '3d' | 'plots' | 'report' | 'diff' | 'convert' | 'query' | 'rules' | 'edit' | 'voxel' | 'describe' | 'section' | 'cpt' | 'correlations' | 'transform';

export interface PackDiagnostic {
  rule_id: string;
  severity: string;
  message: string;
  location: {
    group: string | null;
    row_index: number | null;
    file: string | null;
    line: number | null;
    column: number | null;
  };
}
