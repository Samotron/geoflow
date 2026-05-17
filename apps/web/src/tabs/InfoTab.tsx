import { useState, useEffect } from 'react';
import { summarizeInfoBytes, renderInfo } from '../core.js';

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
}

export function InfoTab({ fileBytes, fileName }: Props) {
  const [infoText, setInfoText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fileBytes) {
      setInfoText(null);
      setError(null);
      return;
    }
    try {
      const summary = summarizeInfoBytes(fileBytes, fileName ?? 'file.ags');
      setInfoText(renderInfo(summary));
      setError(null);
    } catch (e) {
      setError(String(e));
      setInfoText(null);
    }
  }, [fileBytes, fileName]);

  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
        <p>Drop an AGS file above to see file info.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ background: 'var(--red-soft)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)' }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)' }}>
        File Info
      </div>
      <pre style={{ padding: 16, fontSize: 13, lineHeight: 1.7, fontFamily: 'monospace', background: 'var(--card)', color: 'var(--text)' }}>
        {infoText}
      </pre>
    </div>
  );
}
