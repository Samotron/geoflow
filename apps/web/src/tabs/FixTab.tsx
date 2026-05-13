import { useState } from 'react';
import { fixBytes } from '../core.js';

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
}

export function FixTab({ fileBytes, fileName }: Props) {
  const [applied, setApplied] = useState<string[] | null>(null);
  const [fixedOutput, setFixedOutput] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    if (!fileBytes) return;
    setRunning(true);
    setError(null);
    try {
      const result = fixBytes(fileBytes);
      setApplied(result.applied);
      setFixedOutput(result.output);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const download = () => {
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

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <button
          onClick={run}
          disabled={!fileBytes || running}
          style={{ background: 'var(--navy)', color: '#fff', opacity: !fileBytes || running ? 0.4 : 1 }}
        >
          {running ? 'Fixing…' : 'Apply Fixes'}
        </button>
        {fixedOutput && applied && applied.length > 0 && (
          <button onClick={download} style={{ background: 'var(--green)', color: '#fff' }}>
            Download Fixed File
          </button>
        )}
      </div>

      {!fileBytes && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
          <p>Drop an AGS file above to apply auto-fixes.</p>
        </div>
      )}

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)', marginBottom: 16 }}>
          {error}
        </div>
      )}

      {applied !== null && (
        <>
          {applied.length === 0 ? (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 'var(--radius)', padding: '16px 20px', color: 'var(--green)', fontWeight: 600 }}>
              ✓ No fixes needed — file is already clean
            </div>
          ) : (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: '#f8fafc', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)' }}>
                {applied.length} fix{applied.length !== 1 ? 'es' : ''} applied
              </div>
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {applied.map((fix, i) => (
                  <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
                    <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓</span>
                    <code style={{ fontFamily: 'monospace', fontSize: 12, background: '#f1f5f9', padding: '2px 8px', borderRadius: 4 }}>{fix}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
