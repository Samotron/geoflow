import { useState, useEffect } from 'react';
import { validateFileBytes, fixBytes, summarizeInfoBytes, renderInfo, Format, Severity } from '../core.js';
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

export function InspectTab({ fileBytes, fileName }: Props) {
  const [infoText, setInfoText] = useState<string | null>(null);
  const [validateOutput, setValidateOutput] = useState<string | null>(null);
  const [validateExitCode, setValidateExitCode] = useState<number | null>(null);
  const [validateRunning, setValidateRunning] = useState(false);
  const [fixApplied, setFixApplied] = useState<string[] | null>(null);
  const [fixedOutput, setFixedOutput] = useState<string | null>(null);
  const [fixRunning, setFixRunning] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  useEffect(() => {
    if (!fileBytes) {
      setInfoText(null);
      setValidateOutput(null);
      setValidateExitCode(null);
      setFixApplied(null);
      setFixedOutput(null);
      setInfoError(null);
      setFixError(null);
      return;
    }
    try {
      const summary = summarizeInfoBytes(fileBytes, fileName ?? 'file.ags');
      setInfoText(renderInfo(summary));
      setInfoError(null);
    } catch (e) {
      setInfoError(String(e));
      setInfoText(null);
    }
    setValidateOutput(null);
    setValidateExitCode(null);
    setFixApplied(null);
    setFixedOutput(null);
    setFixError(null);
  }, [fileBytes, fileName]);

  const runValidate = () => {
    if (!fileBytes) return;
    setValidateRunning(true);
    try {
      const result = validateFileBytes(fileBytes, fileName ?? 'file.ags', {
        format: Format.Text,
        failOn: Severity.Info,
      });
      setValidateOutput(result.output);
      setValidateExitCode(result.exitCode);
    } catch (e) {
      setValidateOutput(String(e));
      setValidateExitCode(2);
    } finally {
      setValidateRunning(false);
    }
  };

  const runFix = () => {
    if (!fileBytes) return;
    setFixRunning(true);
    setFixError(null);
    try {
      const result = fixBytes(fileBytes);
      setFixApplied(result.applied);
      setFixedOutput(result.output);
    } catch (e) {
      setFixError(String(e));
    } finally {
      setFixRunning(false);
    }
  };

  const downloadFixed = () => {
    if (!fixedOutput) return;
    const blob = new Blob([fixedOutput], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseName = fileName?.replace(/\.[^.]+$/, '') ?? 'file';
    a.download = `${baseName}.fixed.ags`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
        <p>Drop an AGS file above to inspect it.</p>
      </div>
    );
  }

  const diags = validateOutput ? parseDiagnostics(validateOutput) : [];
  const counts = {
    error: diags.filter((d) => d.severity === 'error').length,
    warning: diags.filter((d) => d.severity === 'warning').length,
    info: diags.filter((d) => d.severity === 'info').length,
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    color: 'var(--muted)',
    marginBottom: 10,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* Info section */}
      <div>
        <div style={sectionLabel}>File Info</div>
        {infoError ? (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)' }}>
            {infoError}
          </div>
        ) : (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <pre style={{ padding: 16, fontSize: 13, lineHeight: 1.7, fontFamily: 'monospace', background: 'var(--card)', color: 'var(--text)', margin: 0 }}>
              {infoText ?? '—'}
            </pre>
          </div>
        )}
      </div>

      {/* Validate section */}
      <div>
        <div style={sectionLabel}>Validate</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <button
            onClick={runValidate}
            disabled={validateRunning}
            style={{ background: 'var(--navy)', color: '#fff', opacity: validateRunning ? 0.4 : 1 }}
          >
            {validateRunning ? 'Validating…' : 'Run Validation'}
          </button>
        </div>

        {validateOutput !== null && validateExitCode === 0 && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 'var(--radius)', padding: '14px 18px', color: 'var(--green)', fontWeight: 600, marginBottom: 12 }}>
            ✓ No issues found
          </div>
        )}

        {validateOutput !== null && (
          <>
            {(counts.error > 0 || counts.warning > 0 || counts.info > 0) && (
              <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                {counts.error > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 99, fontSize: 13, fontWeight: 600, background: '#fef2f2', color: 'var(--red)', border: '1px solid #fecaca' }}>
                    {counts.error} error{counts.error !== 1 ? 's' : ''}
                  </span>
                )}
                {counts.warning > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 99, fontSize: 13, fontWeight: 600, background: '#fff7ed', color: 'var(--orange)', border: '1px solid #fed7aa' }}>
                    {counts.warning} warning{counts.warning !== 1 ? 's' : ''}
                  </span>
                )}
                {counts.info > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 99, fontSize: 13, fontWeight: 600, background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe' }}>
                    {counts.info} info
                  </span>
                )}
              </div>
            )}
            {diags.length > 0 && (
              <DiagnosticsPanel
                items={diags.map((d) => ({ rule_id: d.rule_id, severity: d.severity, message: d.message, group: d.group, row_index: d.row_index }))}
              />
            )}
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)', userSelect: 'none', marginBottom: 8 }}>Raw output</summary>
              <pre style={{ background: '#0f172a', color: '#e2e8f0', padding: 16, borderRadius: 'var(--radius)', fontSize: 12, lineHeight: 1.5, overflowX: 'auto', marginTop: 8 }}>{validateOutput}</pre>
            </details>
          </>
        )}
      </div>

      {/* Fix section */}
      <div>
        <div style={sectionLabel}>Auto-Fix</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <button
            onClick={runFix}
            disabled={fixRunning}
            style={{ background: 'var(--navy)', color: '#fff', opacity: fixRunning ? 0.4 : 1 }}
          >
            {fixRunning ? 'Fixing…' : 'Apply Fixes'}
          </button>
          {fixedOutput && fixApplied && fixApplied.length > 0 && (
            <button onClick={downloadFixed} style={{ background: 'var(--green)', color: '#fff' }}>
              Download Fixed File
            </button>
          )}
        </div>

        {fixError && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)', marginBottom: 12 }}>
            {fixError}
          </div>
        )}

        {fixApplied !== null && (
          fixApplied.length === 0 ? (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 'var(--radius)', padding: '14px 18px', color: 'var(--green)', fontWeight: 600 }}>
              ✓ No fixes needed — file is already clean
            </div>
          ) : (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: '#f8fafc', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)' }}>
                {fixApplied.length} fix{fixApplied.length !== 1 ? 'es' : ''} applied
              </div>
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {fixApplied.map((fix, i) => (
                  <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
                    <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓</span>
                    <code style={{ fontFamily: 'monospace', fontSize: 12, background: '#f1f5f9', padding: '2px 8px', borderRadius: 4 }}>{fix}</code>
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
      </div>
    </div>
  );
}
