import { useState } from 'react';
import { decodeBytes, parseStr, writeDiggs, readDiggs, serialize } from '../core.js';

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
}

function isDiggs(name: string | undefined): boolean {
  if (!name) return false;
  return name.endsWith('.diggs') || name.endsWith('.xml');
}

export function ConvertTab({ fileBytes, fileName }: Props) {
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [running, setRunning] = useState(false);

  const convertAgsToDiggs = () => {
    if (!fileBytes) return;
    setRunning(true);
    setStatus(null);
    try {
      const text = decodeBytes(fileBytes);
      const parsed = parseStr(text);
      const { xml, report } = writeDiggs(parsed.file);
      const blob = new Blob([xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const baseName = fileName?.replace(/\.[^.]+$/, '') ?? 'file';
      a.download = `${baseName}.diggs`;
      a.click();
      URL.revokeObjectURL(url);
      const generic = report.generic_groups.length;
      setStatus({
        ok: true,
        message: `Converted successfully.${generic > 0 ? ` ${generic} group(s) round-tripped as generic DataGroup.` : ''}`,
      });
    } catch (e) {
      setStatus({ ok: false, message: String(e) });
    } finally {
      setRunning(false);
    }
  };

  const convertDiggsToAgs = () => {
    if (!fileBytes) return;
    setRunning(true);
    setStatus(null);
    try {
      const text = decodeBytes(fileBytes);
      const agsFile = readDiggs(text);
      const ags = serialize(agsFile);
      const blob = new Blob([ags], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const baseName = fileName?.replace(/\.[^.]+$/, '') ?? 'file';
      a.download = `${baseName}.ags`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus({ ok: true, message: 'Converted DIGGS → AGS successfully.' });
    } catch (e) {
      setStatus({ ok: false, message: String(e) });
    } finally {
      setRunning(false);
    }
  };

  const asDiggs = isDiggs(fileName);

  return (
    <div>
      {!fileBytes && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
          <p>Drop an .ags or .diggs/.xml file above to convert it.</p>
        </div>
      )}

      {fileBytes && (
        <>
          <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--muted)' }}>
            Detected format: <strong style={{ color: 'var(--text)' }}>{asDiggs ? 'DIGGS / XML' : 'AGS'}</strong>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {!asDiggs && (
              <button
                onClick={convertAgsToDiggs}
                disabled={running}
                style={{ background: 'var(--navy)', color: '#fff', opacity: running ? 0.4 : 1 }}
              >
                {running ? 'Converting…' : 'AGS → DIGGS'}
              </button>
            )}
            {asDiggs && (
              <button
                onClick={convertDiggsToAgs}
                disabled={running}
                style={{ background: 'var(--navy)', color: '#fff', opacity: running ? 0.4 : 1 }}
              >
                {running ? 'Converting…' : 'DIGGS → AGS'}
              </button>
            )}
          </div>
        </>
      )}

      {status && (
        <div style={{
          marginTop: 16,
          background: status.ok ? '#f0fdf4' : '#fef2f2',
          border: `1px solid ${status.ok ? '#bbf7d0' : '#fecaca'}`,
          borderRadius: 'var(--radius)',
          padding: '12px 16px',
          color: status.ok ? 'var(--green)' : 'var(--red)',
          fontSize: 13,
        }}>
          {status.ok ? '✓ ' : '✗ '}{status.message}
        </div>
      )}
    </div>
  );
}
