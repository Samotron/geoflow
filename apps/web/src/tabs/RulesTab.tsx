import { useState } from 'react';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile } from '../core.js';
import { DiagnosticsPanel } from '../App.js';
import type { PackDiagnostic } from '../types.js';

interface Props {
  fileBytes: Uint8Array | null;
}

const STARTER_YAML = `version: 1
name: my-rules
pack_version: "0.1"

codelists:
  sample_types:
    inline: ["B", "U", "D", "ES", "WS", "PS"]

rules:
  - id: LOCA-001
    description: "Locations must have coordinates."
    severity: error
    when: "group == 'LOCA'"
    expr: "row.LOCA_NATE != null && row.LOCA_NATN != null"
    message: "LOCA {row.LOCA_ID} is missing coordinates"

  - id: SAMP-001
    description: "Samples must reference an existing location."
    severity: error
    when: "group == 'SAMP'"
    expr: "exists_in('LOCA', 'LOCA_ID', row.LOCA_ID)"
    message: "Sample {row.SAMP_ID} references unknown location {row.LOCA_ID}"

  - id: SAMP-002
    description: "Sample type must be in permitted list."
    severity: warning
    when: "group == 'SAMP'"
    expr: "row.SAMP_TYPE in codelist('sample_types')"
    message: "Sample {row.SAMP_ID} has unusual type {row.SAMP_TYPE}"

  - id: GEOL-001
    description: "Geology depths must be monotonic per location."
    severity: error
    scope: "group:LOCA_ID"
    when: "group == 'GEOL'"
    expr: "is_monotonic(pluck(rows, 'GEOL_TOP'))"
    message: "Non-monotonic GEOL layers under LOCA {key.LOCA_ID}"
`;

type EvalStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; diagnostics: PackDiagnostic[] };

export function RulesTab({ fileBytes }: Props) {
  const [yaml, setYaml] = useState(STARTER_YAML);
  const [status, setStatus] = useState<EvalStatus>({ kind: 'idle' });

  const run = async () => {
    if (!fileBytes) return;
    setStatus({ kind: 'running' });

    let agsFile: AgsFile;
    try {
      const text = decodeBytes(fileBytes);
      const parsed = parseStr(text);
      agsFile = parsed.file;
    } catch (e) {
      setStatus({ kind: 'error', message: `Failed to parse AGS file: ${String(e)}` });
      return;
    }

    try {
      // Dynamic import so a stub/missing package doesn't break the whole app
      const mod = await import('@geoflow/rules-engine');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const evaluatePackYaml = (mod as any).evaluatePackYaml as
        | ((yaml: string, file: AgsFile) => PackDiagnostic[])
        | undefined;

      if (typeof evaluatePackYaml !== 'function') {
        setStatus({ kind: 'unavailable' });
        return;
      }

      const diagnostics = evaluatePackYaml(yaml, agsFile);
      setStatus({ kind: 'done', diagnostics });
    } catch (e) {
      // If import fails entirely, treat as unavailable
      const msg = String(e);
      if (msg.includes('not found') || msg.includes('Cannot find') || msg.includes('MODULE_NOT_FOUND') || msg.includes('PACKAGE_NAME')) {
        setStatus({ kind: 'unavailable' });
      } else {
        setStatus({ kind: 'error', message: msg });
      }
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
        Write CEL-based validation rules in YAML and run them against the loaded file.
      </div>

      <textarea
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
        style={{
          width: '100%',
          height: 360,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.5,
          padding: 12,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          background: '#0f172a',
          color: '#e2e8f0',
          resize: 'vertical',
          outline: 'none',
          marginBottom: 12,
        }}
      />

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <button
          onClick={() => { void run(); }}
          disabled={!fileBytes || status.kind === 'running'}
          style={{ background: 'var(--navy)', color: '#fff', opacity: !fileBytes || status.kind === 'running' ? 0.4 : 1 }}
        >
          {status.kind === 'running' ? 'Running…' : 'Validate with Rules'}
        </button>
      </div>

      {!fileBytes && (
        <div style={{ textAlign: 'center', padding: '24px', color: 'var(--muted)', fontSize: 13 }}>
          Drop an AGS file above to run custom rules against it.
        </div>
      )}

      {status.kind === 'unavailable' && (
        <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--orange)', fontSize: 13 }}>
          Rules engine not available — <code>@geoflow/rules-engine</code> is not yet implemented (Milestone 3).
        </div>
      )}

      {status.kind === 'error' && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)', fontSize: 13, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          {status.message}
        </div>
      )}

      {status.kind === 'done' && (
        <DiagnosticsPanel
          title="Rule Pack Results"
          items={status.diagnostics.map((d) => ({
            rule_id: d.rule_id,
            severity: d.severity,
            message: d.message,
            group: d.location.group,
            row_index: d.location.row_index,
          }))}
        />
      )}
    </div>
  );
}
