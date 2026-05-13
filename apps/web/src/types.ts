export interface LoadedFile {
  name: string;
  bytes: Uint8Array;
}

export type TabId = 'validate' | 'fix' | 'convert' | 'info' | 'data' | 'diff' | 'rules';

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
