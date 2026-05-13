import { useState } from 'react';
import { decodeBytes, parseStr, diffFiles, renderDiffText, isIdentical } from '../core.js';
import type { AgsFile } from '../core.js';
import { DropZone } from '../App.js';

interface FileSlot {
  name: string;
  bytes: Uint8Array;
  parsed: AgsFile;
}

export function DiffTab() {
  const [fileA, setFileA] = useState<FileSlot | null>(null);
  const [fileB, setFileB] = useState<FileSlot | null>(null);
  const [diffOutput, setDiffOutput] = useState<string | null>(null);
  const [identical, setIdentical] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const loadFile = (slot: 'a' | 'b') => (name: string, bytes: Uint8Array) => {
    try {
      const text = decodeBytes(bytes);
      const parsed = parseStr(text);
      const entry = { name, bytes, parsed: parsed.file };
      if (slot === 'a') setFileA(entry);
      else setFileB(entry);
      setDiffOutput(null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const runDiff = () => {
    if (!fileA || !fileB) return;
    setRunning(true);
    setError(null);
    try {
      const result = diffFiles(fileA.parsed, fileB.parsed);
      setIdentical(isIdentical(result));
      setDiffOutput(renderDiffText(result));
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>File A</div>
          <DropZone
            onFile={loadFile('a')}
            fileName={fileA?.name}
            fileSize={fileA?.bytes.length}
            label="File A"
          />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>File B</div>
          <DropZone
            onFile={loadFile('b')}
            fileName={fileB?.name}
            fileSize={fileB?.bytes.length}
            label="File B"
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <button
          onClick={runDiff}
          disabled={!fileA || !fileB || running}
          style={{ background: 'var(--navy)', color: '#fff', opacity: !fileA || !fileB || running ? 0.4 : 1 }}
        >
          {running ? 'Diffing…' : 'Diff Files'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)', marginBottom: 16 }}>
          {error}
        </div>
      )}

      {diffOutput !== null && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {identical ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--green)', fontWeight: 600 }}>
              ✓ Files are identical
            </div>
          ) : (
            <pre style={{ margin: 0, padding: 16, background: '#0f172a', color: '#e2e8f0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.45, overflowX: 'auto' }}>
              {diffOutput}
            </pre>
          )}
        </div>
      )}

      {!fileA && !fileB && (
        <div style={{ textAlign: 'center', padding: '24px 24px', color: 'var(--muted)', fontSize: 13 }}>
          Drop two AGS files above to compare them.
        </div>
      )}
    </div>
  );
}
