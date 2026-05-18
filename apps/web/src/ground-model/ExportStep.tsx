/**
 * ExportStep — render an AGSi JSON preview and provide a download button.
 *
 * No external network calls; everything happens client-side.
 */

import { useMemo } from 'react';
import { toAgsi, toAgsiJson } from '@geoflow/ground-model';
import type { GroundModel } from '@geoflow/ground-model';

interface ExportStepProps {
  model: GroundModel;
}

export function ExportStep({ model }: ExportStepProps) {
  const json = useMemo(() => toAgsiJson(model), [model]);
  const doc = useMemo(() => toAgsi(model), [model]);

  const download = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = model.name.replace(/[^a-z0-9-_]+/gi, '_') || 'ground-model';
    a.href = url;
    a.download = `${safeName}.agsi.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const copy = () => {
    void navigator.clipboard.writeText(json);
  };

  const layersWithValues = model.layers.filter((l) =>
    l.parameters.some((p) => p.value !== null),
  ).length;
  const totalParams = model.layers.reduce((a, l) => a + l.parameters.length, 0);
  const assignedParams = model.layers.reduce(
    (a, l) => a + l.parameters.filter((p) => p.value !== null).length,
    0,
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title="Summary">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <Stat label="Model" value={model.name} />
          <Stat label="Boreholes" value={String(model.group.locaIds.length)} />
          <Stat label="Layers" value={String(model.layers.length)} />
          <Stat
            label="Parameters set"
            value={`${assignedParams} / ${totalParams}`}
            note={layersWithValues === 0 ? 'no values yet' : undefined}
          />
        </div>
      </Card>

      <Card title="AGSi document" right={
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={copy} style={btnSubtle}>Copy JSON</button>
          <button onClick={download} style={btnPrimary}>Download .agsi.json</button>
        </div>
      }>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
          Aligned with the AGS Industry Ground Model schema (v{doc.agsiVersion}).
          {' '}<a href="https://ags-data-format-wg.gitlab.io/agsi/" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
            AGSi reference →
          </a>
        </div>
        <pre style={{
          maxHeight: 460, overflow: 'auto', padding: 12,
          background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 6,
          fontSize: 11, fontFamily: "'Menlo', 'Consolas', monospace", color: 'var(--text)',
          margin: 0,
        }}>{json}</pre>
      </Card>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div style={{ padding: '8px 12px', background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      {note && <div style={{ fontSize: 10, color: 'var(--orange)' }}>{note}</div>}
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>{title}</span>
        {right}
      </div>
      <div style={{ padding: 14 }}>{children}</div>
    </div>
  );
}

const btnSubtle: React.CSSProperties = {
  padding: '5px 12px', fontSize: 12, fontWeight: 600,
  background: 'transparent', color: 'var(--muted)',
  border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
};

const btnPrimary: React.CSSProperties = {
  padding: '6px 14px', fontSize: 12, fontWeight: 600,
  background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer',
};
