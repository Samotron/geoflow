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

const COMMON_GROUPS = ['LOCA', 'GEOL', 'SAMP', 'CHEM', 'GRAT', 'ISPT', 'IVAN', 'MOND', 'HOLE', 'PROJ'];

interface RuleForm {
  id: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  group: string;
  expr: string;
  message: string;
}

const BLANK_FORM: RuleForm = { id: '', description: '', severity: 'error', group: 'LOCA', expr: '', message: '' };

export function RulesTab({ fileBytes }: Props) {
  const [yaml, setYaml] = useState(STARTER_YAML);
  const [status, setStatus] = useState<EvalStatus>({ kind: 'idle' });
  const [builderOpen, setBuilderOpen] = useState(false);
  const [form, setForm] = useState<RuleForm>(BLANK_FORM);

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

  const addRule = () => {
    const id = form.id.trim() || 'RULE-001';
    const snippet = [
      `  - id: ${id}`,
      `    description: "${form.description.replace(/"/g, '\\"')}"`,
      `    severity: ${form.severity}`,
      `    when: "group == '${form.group}'"`,
      `    expr: "${form.expr.replace(/"/g, '\\"')}"`,
      `    message: "${form.message.replace(/"/g, '\\"')}"`,
    ].join('\n');
    setYaml(prev => {
      const rulesIdx = prev.indexOf('\nrules:');
      if (rulesIdx !== -1) return prev + '\n' + snippet;
      return prev + '\n\nrules:\n' + snippet;
    });
    setForm(BLANK_FORM);
  };

  const inputStyle: React.CSSProperties = {
    padding: '5px 8px', fontSize: 12, border: '1px solid var(--border)',
    borderRadius: 4, background: '#fff', color: 'var(--text)', width: '100%',
    fontFamily: 'inherit',
  };

  return (
    <div>
      <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
        Write JEXL-based validation rules in YAML and run them against the loaded file.
      </div>

      {/* Rule builder */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 12, overflow: 'hidden' }}>
        <button
          onClick={() => setBuilderOpen(o => !o)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px 14px', background: 'var(--surface-muted)', border: 'none', cursor: 'pointer',
            fontSize: 12, fontWeight: 700, color: 'var(--text)', textAlign: 'left',
          }}
        >
          <span style={{ fontSize: 10, opacity: 0.6 }}>{builderOpen ? '▾' : '▸'}</span>
          Rule Builder
          <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)', marginLeft: 4 }}>
            — fill in fields to append a new rule to the YAML
          </span>
        </button>
        {builderOpen && (
          <div style={{ padding: 14, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 3 }}>Rule ID *</label>
                <input
                  value={form.id}
                  onChange={e => setForm(f => ({ ...f, id: e.target.value }))}
                  placeholder="e.g. LOCA-001"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 3 }}>Severity</label>
                <select
                  value={form.severity}
                  onChange={e => setForm(f => ({ ...f, severity: e.target.value as RuleForm['severity'] }))}
                  style={inputStyle}
                >
                  <option value="error">error</option>
                  <option value="warning">warning</option>
                  <option value="info">info</option>
                </select>
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 3 }}>Description</label>
              <input
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Human-readable description"
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 3 }}>Group (when)</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <select
                    value={COMMON_GROUPS.includes(form.group) ? form.group : '__custom__'}
                    onChange={e => { if (e.target.value !== '__custom__') setForm(f => ({ ...f, group: e.target.value })); }}
                    style={{ ...inputStyle, width: 'auto', flex: 1 }}
                  >
                    {COMMON_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
                    {!COMMON_GROUPS.includes(form.group) && <option value="__custom__">{form.group}</option>}
                  </select>
                  <input
                    value={form.group}
                    onChange={e => setForm(f => ({ ...f, group: e.target.value }))}
                    placeholder="Custom"
                    style={{ ...inputStyle, width: 80 }}
                  />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 3 }}>Expression (expr)</label>
                <input
                  value={form.expr}
                  onChange={e => setForm(f => ({ ...f, expr: e.target.value }))}
                  placeholder="e.g. row.LOCA_ID != null"
                  style={{ ...inputStyle, fontFamily: 'monospace' }}
                />
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 3 }}>Message template</label>
              <input
                value={form.message}
                onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                placeholder="e.g. Location {row.LOCA_ID} is missing data"
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={addRule}
                disabled={!form.expr.trim()}
                style={{ background: 'var(--navy)', color: '#fff', fontSize: 12, padding: '6px 14px', opacity: !form.expr.trim() ? 0.4 : 1 }}
              >
                + Append Rule to YAML
              </button>
              <button
                onClick={() => setForm(BLANK_FORM)}
                style={{ background: 'var(--surface-muted)', color: 'var(--text)', fontSize: 12, padding: '6px 14px', border: '1px solid var(--border)' }}
              >
                Reset
              </button>
            </div>
          </div>
        )}
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
          background: 'var(--text)',
          color: 'var(--border)',
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
        <div style={{ background: 'var(--orange-soft)', border: '1px solid var(--orange-border)', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--orange)', fontSize: 13 }}>
          Rules engine not available — <code>@geoflow/rules-engine</code> is not yet implemented (Milestone 3).
        </div>
      )}

      {status.kind === 'error' && (
        <div style={{ background: 'var(--red-soft)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)', fontSize: 13, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
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
