import { useState, useEffect, useRef } from 'react';
import { validateFileBytes, fixBytes, summarizeInfoBytes, renderInfo, decodeBytes, Format, Severity } from '../core.js';
import type { Diagnostic } from '../core.js';
import { DiagnosticsPanel } from '../App.js';

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
}

type ValidateView = 'diagnostics' | 'source';

// ── Source editor ─────────────────────────────────────────────────────────────

function sevColor(sev: string) {
  if (sev === 'error') return { bg: 'var(--red-soft)', border: 'var(--red-border)', text: 'var(--red)', gutter: 'var(--red-soft)' };
  if (sev === 'warning') return { bg: 'var(--orange-soft)', border: 'var(--orange-border)', text: 'var(--orange)', gutter: 'var(--orange-soft)' };
  return { bg: 'var(--accent-soft)', border: 'var(--accent-border)', text: 'var(--accent)', gutter: 'var(--accent-soft)' };
}

function SourceEditor({ sourceText, diagnostics }: { sourceText: string; diagnostics: Diagnostic[] }) {
  const lineRef = useRef<HTMLDivElement>(null);

  // Build a map from 1-based line number → list of diagnostics on that line
  const lineMap = new Map<number, Diagnostic[]>();
  for (const d of diagnostics) {
    const opt = d.location.line;
    if (opt._tag === 'Some') {
      const n = (opt as { _tag: 'Some'; value: number }).value;
      if (!lineMap.has(n)) lineMap.set(n, []);
      lineMap.get(n)!.push(d);
    }
  }

  const lines = sourceText.split(/\r?\n/);
  // Strip trailing empty line from split
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const lineNumWidth = String(lines.length).length;

  return (
    <div
      ref={lineRef}
      style={{ background: 'var(--text)', borderRadius: 'var(--radius)', overflow: 'auto', maxHeight: 'calc(100vh - 260px)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: '1.6' }}
    >
      {lines.map((line, i) => {
        const lineNo = i + 1;
        const diags = lineMap.get(lineNo) ?? [];
        const worstSev = diags.some(d => d.severity === 'error') ? 'error'
          : diags.some(d => d.severity === 'warning') ? 'warning'
          : diags.length > 0 ? 'info' : null;
        const colors = worstSev ? sevColor(worstSev) : null;

        return (
          <div key={i} style={{ background: colors ? 'rgba(239,68,68,0.08)' : undefined }}>
            {/* Code line */}
            <div style={{ display: 'flex', minHeight: '1.6em' }}>
              <span
                style={{
                  display: 'inline-block',
                  minWidth: `${lineNumWidth + 2}ch`,
                  padding: '0 10px',
                  textAlign: 'right',
                  userSelect: 'none',
                  color: worstSev === 'error' ? 'var(--red-border)' : worstSev === 'warning' ? 'var(--amber)' : 'var(--text-dim)',
                  background: worstSev === 'error' ? 'rgba(239,68,68,0.15)' : worstSev === 'warning' ? 'rgba(234,179,8,0.12)' : 'var(--text)',
                  borderRight: `2px solid ${worstSev === 'error' ? 'var(--red)' : worstSev === 'warning' ? 'var(--amber)' : 'var(--text)'}`,
                  flexShrink: 0,
                }}
              >
                {lineNo}
              </span>
              <span style={{ padding: '0 16px', color: 'var(--border)', whiteSpace: 'pre', flexGrow: 1 }}>
                {line || ' '}
              </span>
            </div>
            {/* Inline diagnostics */}
            {diags.map((d, j) => {
              const c = sevColor(d.severity);
              return (
                <div key={j} style={{ display: 'flex', gap: 0 }}>
                  <span style={{ minWidth: `${lineNumWidth + 2}ch`, background: c.gutter + '22', borderRight: `2px solid ${worstSev === 'error' ? 'var(--red)' : 'var(--amber)'}`, flexShrink: 0 }} />
                  <div style={{ padding: '2px 16px 4px', color: c.text, fontSize: 11, background: c.bg + '15', flexGrow: 1 }}>
                    <span style={{ fontWeight: 700 }}>{d.severity.toUpperCase()}</span>
                    {' '}
                    <span style={{ opacity: 0.7 }}>[{d.rule_id}]</span>
                    {' '}
                    {d.message}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ── InspectTab ────────────────────────────────────────────────────────────────

export function InspectTab({ fileBytes, fileName }: Props) {
  const [infoText, setInfoText] = useState<string | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  const [validateDiags, setValidateDiags] = useState<Diagnostic[] | null>(null);
  const [validateExitCode, setValidateExitCode] = useState<number | null>(null);
  const [validateRunning, setValidateRunning] = useState(false);
  const [validateView, setValidateView] = useState<ValidateView>('diagnostics');
  const [sourceText, setSourceText] = useState<string | null>(null);

  const [fixApplied, setFixApplied] = useState<string[] | null>(null);
  const [fixedOutput, setFixedOutput] = useState<string | null>(null);
  const [fixRunning, setFixRunning] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);

  useEffect(() => {
    if (!fileBytes) {
      setInfoText(null); setInfoError(null);
      setValidateDiags(null); setValidateExitCode(null);
      setFixApplied(null); setFixedOutput(null); setFixError(null);
      setSourceText(null);
      return;
    }
    try {
      setInfoText(renderInfo(summarizeInfoBytes(fileBytes, fileName ?? 'file.ags')));
      setInfoError(null);
    } catch (e) {
      setInfoError(String(e));
      setInfoText(null);
    }
    setValidateDiags(null); setValidateExitCode(null);
    setFixApplied(null); setFixedOutput(null); setFixError(null);
  }, [fileBytes, fileName]);

  const runValidate = () => {
    if (!fileBytes) return;
    setValidateRunning(true);
    try {
      const text = decodeBytes(fileBytes);
      setSourceText(text);
      const result = validateFileBytes(fileBytes, fileName ?? 'file.ags', {
        format: Format.Text,
        failOn: Severity.Info,
      });
      setValidateDiags(result.diagnostics);
      setValidateExitCode(result.exitCode);
    } catch {
      setValidateDiags([]);
      setValidateExitCode(2);
    } finally {
      setValidateRunning(false);
    }
  };

  const runFix = () => {
    if (!fileBytes) return;
    setFixRunning(true); setFixError(null);
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
    a.download = `${(fileName ?? 'file').replace(/\.[^.]+$/, '')}.fixed.ags`;
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

  const counts = validateDiags ? {
    error: validateDiags.filter(d => d.severity === 'error').length,
    warning: validateDiags.filter(d => d.severity === 'warning').length,
    info: validateDiags.filter(d => d.severity === 'info').length,
  } : null;

  const sectionLabel: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 10,
  };

  const pillStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px', fontSize: 11, fontWeight: 600, borderRadius: 6,
    border: '1px solid var(--border)',
    background: active ? 'var(--navy)' : 'var(--card)',
    color: active ? '#fff' : 'var(--muted)',
    cursor: 'pointer',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── Info ── */}
      <div>
        <div style={sectionLabel}>File Info</div>
        {infoError ? (
          <div style={{ background: 'var(--red-soft)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)' }}>{infoError}</div>
        ) : (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <pre style={{ padding: 16, fontSize: 13, lineHeight: 1.7, fontFamily: 'monospace', background: 'var(--card)', color: 'var(--text)', margin: 0 }}>
              {infoText ?? '—'}
            </pre>
          </div>
        )}
      </div>

      {/* ── Validate ── */}
      <div>
        <div style={sectionLabel}>Validate</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={runValidate}
            disabled={validateRunning}
            style={{ background: 'var(--navy)', color: '#fff', opacity: validateRunning ? 0.4 : 1 }}
          >
            {validateRunning ? 'Validating…' : 'Run Validation'}
          </button>

          {validateDiags !== null && (
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
              <button style={pillStyle(validateView === 'diagnostics')} onClick={() => setValidateView('diagnostics')}>
                Diagnostics
              </button>
              <button style={pillStyle(validateView === 'source')} onClick={() => setValidateView('source')}>
                Source
              </button>
            </div>
          )}
        </div>

        {validateDiags !== null && validateExitCode === 0 && validateView === 'diagnostics' && (
          <div style={{ background: 'var(--green-soft)', border: '1px solid var(--green-border)', borderRadius: 'var(--radius)', padding: '14px 18px', color: 'var(--green)', fontWeight: 600, marginBottom: 12 }}>
            ✓ No issues found
          </div>
        )}

        {validateDiags !== null && counts && validateView === 'diagnostics' && (
          <>
            {(counts.error > 0 || counts.warning > 0 || counts.info > 0) && (
              <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
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
            )}
            {validateDiags.length > 0 && (
              <DiagnosticsPanel
                items={validateDiags.map(d => ({
                  rule_id: d.rule_id,
                  severity: d.severity,
                  message: d.message,
                  group: d.location.group._tag === 'Some' ? (d.location.group as { _tag: 'Some'; value: string }).value : null,
                  row_index: d.location.row_index._tag === 'Some' ? (d.location.row_index as { _tag: 'Some'; value: number }).value : null,
                }))}
              />
            )}
          </>
        )}

        {validateDiags !== null && validateView === 'source' && sourceText && (
          <SourceEditor sourceText={sourceText} diagnostics={validateDiags} />
        )}
      </div>

      {/* ── Auto-Fix ── */}
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
          <div style={{ background: 'var(--red-soft)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)', marginBottom: 12 }}>{fixError}</div>
        )}

        {fixApplied !== null && (
          fixApplied.length === 0 ? (
            <div style={{ background: 'var(--green-soft)', border: '1px solid var(--green-border)', borderRadius: 'var(--radius)', padding: '14px 18px', color: 'var(--green)', fontWeight: 600 }}>
              ✓ No fixes needed — file is already clean
            </div>
          ) : (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)' }}>
                {fixApplied.length} fix{fixApplied.length !== 1 ? 'es' : ''} applied
              </div>
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {fixApplied.map((fix, i) => (
                  <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--surface-muted)', fontSize: 13 }}>
                    <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓</span>
                    <code style={{ fontFamily: 'monospace', fontSize: 12, background: 'var(--surface-muted)', padding: '2px 8px', borderRadius: 4 }}>{fix}</code>
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
