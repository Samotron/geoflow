import { useState } from 'react';
import { validateFileBytes, Format, Severity } from '../core.js';
import { DiagnosticsPanel } from '../App.js';

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
}

interface ParsedDiag {
  severity: string;
  rule_id: string;
  message: string;
  group: string | null;
  row_index: number | null;
}

function parseDiagnostics(output: string): ParsedDiag[] {
  const diags: ParsedDiag[] = [];
  const lineRe = /^(error|warning|info): \[([^\]]+)\] (.+?)(?:\s+\(([^)]+)\))?(?:\s+\[auto-fixable:[^\]]+\])?$/;
  for (const line of output.split('\n')) {
    const m = lineRe.exec(line.trim());
    if (!m) continue;
    const [, severity, rule_id, message, loc] = m;
    let group: string | null = null;
    let row_index: number | null = null;
    if (loc) {
      const gm = /group=([^,)]+)/.exec(loc);
      if (gm?.[1]) group = gm[1];
      const rm = /row_index=(\d+)/.exec(loc);
      if (rm?.[1]) row_index = parseInt(rm[1], 10);
    }
    diags.push({ severity: severity ?? '', rule_id: rule_id ?? '', message: message ?? '', group, row_index });
  }
  return diags;
}

export function ValidateTab({ fileBytes, fileName }: Props) {
  const [output, setOutput] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  const run = () => {
    if (!fileBytes) return;
    setRunning(true);
    try {
      const result = validateFileBytes(fileBytes, fileName ?? 'file.ags', {
        format: Format.Text,
        failOn: Severity.Info,
      });
      setOutput(result.output);
      setExitCode(result.exitCode);
    } catch (e) {
      setOutput(String(e));
      setExitCode(2);
    } finally {
      setRunning(false);
    }
  };

  const diags = output ? parseDiagnostics(output) : [];

  const counts = {
    error: diags.filter((d) => d.severity === 'error').length,
    warning: diags.filter((d) => d.severity === 'warning').length,
    info: diags.filter((d) => d.severity === 'info').length,
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <button
          onClick={run}
          disabled={!fileBytes || running}
          style={{ background: 'var(--navy)', color: '#fff', opacity: !fileBytes || running ? 0.4 : 1 }}
        >
          {running ? 'Validating…' : 'Validate'}
        </button>
      </div>

      {!fileBytes && (
        <EmptyState message="Drop an AGS file above to validate it." />
      )}

      {output !== null && exitCode === 0 && (
        <div style={{ background: 'var(--green-soft)', border: '1px solid var(--green-border)', borderRadius: 'var(--radius)', padding: '16px 20px', color: 'var(--green)', fontWeight: 600, marginBottom: 16 }}>
          ✓ No issues found
        </div>
      )}

      {output !== null && (
        <>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            {counts.error > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 99, fontSize: 13, fontWeight: 600, background: 'var(--red-soft)', color: 'var(--red)', border: '1px solid var(--red-border)' }}>
                {counts.error} error{counts.error !== 1 ? 's' : ''}
              </span>
            )}
            {counts.warning > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 99, fontSize: 13, fontWeight: 600, background: 'var(--orange-soft)', color: 'var(--orange)', border: '1px solid var(--orange-border)' }}>
                {counts.warning} warning{counts.warning !== 1 ? 's' : ''}
              </span>
            )}
            {counts.info > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 99, fontSize: 13, fontWeight: 600, background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent-border)' }}>
                {counts.info} info
              </span>
            )}
          </div>

          {diags.length > 0 && (
            <DiagnosticsPanel
              items={diags.map((d) => ({ rule_id: d.rule_id, severity: d.severity, message: d.message, group: d.group, row_index: d.row_index }))}
            />
          )}

          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)', userSelect: 'none', marginBottom: 8 }}>Raw output</summary>
            <pre style={{ background: 'var(--text)', color: 'var(--border)', padding: 16, borderRadius: 'var(--radius)', fontSize: 12, lineHeight: 1.5, overflowX: 'auto', marginTop: 8 }}>{output}</pre>
          </details>
        </>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 14px', display: 'block' }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
      </svg>
      <p style={{ lineHeight: 1.6 }}>{message}</p>
    </div>
  );
}
