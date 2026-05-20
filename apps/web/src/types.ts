export interface LoadedFile {
  name: string;
  bytes: Uint8Array;
}

export type TabId = 'overview' | 'inspect' | 'data' | 'search' | 'map' | '3d' | 'plots' | 'report' | 'diff' | 'convert' | 'query' | 'rules' | 'edit' | 'voxel' | 'describe' | 'section' | 'cpt' | 'correlations' | 'transform' | 'field-tests';

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
