export interface LoadedFile {
  name: string;
  bytes: Uint8Array;
}

export type TabId = 'inspect' | 'data' | 'map' | 'diff' | 'convert' | 'rules' | 'edit' | 'query';

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
