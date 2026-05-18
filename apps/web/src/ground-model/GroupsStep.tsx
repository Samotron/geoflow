/**
 * GroupsStep — pick the boreholes that will inform this ground model.
 *
 * Three input methods:
 *   - DBSCAN suggestion (auto-clusters on LOCA_NATE/NATN)
 *   - Spatial preview with click-to-toggle on a simple SVG scatter
 *   - Plain checklist of LOCA_IDs
 */

import { useMemo } from 'react';
import type { AgsFile } from '../core.js';
import type { GroundModel } from '@geoflow/ground-model';
import { clusterLocations } from '@geoflow/ground-model';
import type { LocaPoint } from '@geoflow/ground-model';

interface GroupsStepProps {
  file: AgsFile;
  model: GroundModel;
  onChange: (next: GroundModel) => Promise<void> | void;
  onNext: () => void;
}

function extractLocaPoints(file: AgsFile): LocaPoint[] {
  const out: LocaPoint[] = [];
  for (const r of file.groups['LOCA']?.rows ?? []) {
    const id = String(r['LOCA_ID'] ?? '').trim();
    const e = Number(r['LOCA_NATE']);
    const n = Number(r['LOCA_NATN']);
    if (!id || !Number.isFinite(e) || !Number.isFinite(n)) continue;
    out.push({ locaId: id, east: e, north: n });
  }
  return out;
}

const CLUSTER_PALETTE = ['#dc2626', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#c026d3', '#ca8a04'];

export function GroupsStep({ file, model, onChange, onNext }: GroupsStepProps) {
  const points = useMemo(() => extractLocaPoints(file), [file]);
  const allIds = useMemo(() => {
    const ids = new Set<string>(points.map((p) => p.locaId));
    for (const r of file.groups['LOCA']?.rows ?? []) {
      const id = String(r['LOCA_ID'] ?? '').trim();
      if (id) ids.add(id);
    }
    return [...ids].sort();
  }, [file, points]);

  const clusters = useMemo(() => clusterLocations(points), [points]);
  const selected = useMemo(() => new Set(model.group.locaIds), [model.group.locaIds]);

  const setSelection = (next: string[], extras: Partial<GroundModel['group']> = {}) => {
    void onChange({
      ...model,
      group: { ...model.group, ...extras, locaIds: [...new Set(next)].sort() },
    });
  };

  const toggleLoca = (id: string) => {
    const cur = new Set(selected);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    setSelection([...cur]);
  };

  const acceptCluster = (clusterIdx: number) => {
    const ids = clusters.clusters[clusterIdx] ?? [];
    setSelection(ids, {
      name: `Cluster ${clusterIdx + 1} (${ids.length} loca${ids.length === 1 ? '' : 's'})`,
      centroid: clusters.centroids[clusterIdx],
    });
  };

  // Plot extents
  const bbox = useMemo(() => {
    if (points.length === 0) return null;
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const p of points) {
      if (p.east < minE) minE = p.east;
      if (p.east > maxE) maxE = p.east;
      if (p.north < minN) minN = p.north;
      if (p.north > maxN) maxN = p.north;
    }
    const padE = Math.max(20, (maxE - minE) * 0.06);
    const padN = Math.max(20, (maxN - minN) * 0.06);
    return { minE: minE - padE, maxE: maxE + padE, minN: minN - padN, maxN: maxN + padN };
  }, [points]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title="Group name & description">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Model name">
            <input
              type="text"
              value={model.name}
              onChange={(e) => onChange({ ...model, name: e.target.value })}
              style={input}
            />
          </Field>
          <Field label="Group name">
            <input
              type="text"
              value={model.group.name}
              onChange={(e) => onChange({ ...model, group: { ...model.group, name: e.target.value } })}
              style={input}
            />
          </Field>
        </div>
        <Field label="Description">
          <textarea
            value={model.description}
            onChange={(e) => onChange({ ...model, description: e.target.value })}
            rows={2}
            style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </Field>
      </Card>

      <Card title="Suggested clusters (DBSCAN)" right={
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {clusters.clusters.length} cluster{clusters.clusters.length === 1 ? '' : 's'} · {clusters.noise.length} ungrouped
        </span>
      }>
        {clusters.clusters.length === 0 ? (
          <div style={{ padding: '14px 4px', color: 'var(--muted)', fontSize: 13 }}>
            No clusters found — boreholes are too sparse or LOCA_NATE/LOCA_NATN are missing.
            Use the checklist below to pick boreholes manually.
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {clusters.clusters.map((ids, i) => (
              <button
                key={i}
                onClick={() => acceptCluster(i)}
                style={{
                  padding: '6px 10px', fontSize: 12, fontWeight: 600,
                  background: 'var(--card)', color: 'var(--text)',
                  border: `1px solid ${CLUSTER_PALETTE[i % CLUSTER_PALETTE.length]}`,
                  borderLeft: `4px solid ${CLUSTER_PALETTE[i % CLUSTER_PALETTE.length]}`,
                  borderRadius: 6, cursor: 'pointer',
                }}
              >
                Cluster {i + 1} · {ids.length} loca{ids.length === 1 ? '' : 's'}
              </button>
            ))}
          </div>
        )}
      </Card>

      {bbox && (
        <Card title="Spatial preview" right={
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>click to toggle</span>
        }>
          <svg
            viewBox="0 0 600 340"
            width="100%"
            style={{ display: 'block', background: 'var(--surface-muted)', borderRadius: 6 }}
          >
            {points.map((p) => {
              const x = ((p.east - bbox.minE) / (bbox.maxE - bbox.minE)) * 580 + 10;
              const y = 330 - ((p.north - bbox.minN) / (bbox.maxN - bbox.minN)) * 320;
              const clusterIdx = clusters.clusters.findIndex((arr) => arr.includes(p.locaId));
              const colour = clusterIdx >= 0
                ? CLUSTER_PALETTE[clusterIdx % CLUSTER_PALETTE.length]!
                : '#94a3b8';
              const isSel = selected.has(p.locaId);
              return (
                <g key={p.locaId} style={{ cursor: 'pointer' }} onClick={() => toggleLoca(p.locaId)}>
                  <circle cx={x} cy={y} r={isSel ? 8 : 5} fill={isSel ? colour : 'transparent'} stroke={colour} strokeWidth={isSel ? 2 : 1.5} />
                  <title>{p.locaId} ({p.east.toFixed(0)}, {p.north.toFixed(0)})</title>
                  {isSel && (
                    <text x={x + 9} y={y + 3} fontSize="10" fill="var(--text)">{p.locaId}</text>
                  )}
                </g>
              );
            })}
          </svg>
        </Card>
      )}

      <Card title="Borehole checklist" right={
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {selected.size} of {allIds.length} selected
        </span>
      }>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button onClick={() => setSelection(allIds)} style={btnSubtle}>Select all</button>
          <button onClick={() => setSelection([])} style={btnSubtle}>Clear</button>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: 4, maxHeight: 280, overflowY: 'auto',
        }}>
          {allIds.map((id) => {
            const isSel = selected.has(id);
            return (
              <label key={id} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 8px', borderRadius: 4, cursor: 'pointer',
                background: isSel ? 'var(--accent-soft)' : 'transparent',
                fontSize: 12, fontFamily: "'Menlo', 'Consolas', monospace",
              }}>
                <input
                  type="checkbox"
                  checked={isSel}
                  onChange={() => toggleLoca(id)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {id}
              </label>
            );
          })}
        </div>
      </Card>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={onNext}
          disabled={selected.size < 2}
          style={{
            padding: '8px 18px', fontSize: 13, fontWeight: 600,
            background: selected.size < 2 ? 'var(--surface-muted)' : 'var(--accent)',
            color: selected.size < 2 ? 'var(--muted)' : '#fff',
            border: 'none', borderRadius: 6,
            cursor: selected.size < 2 ? 'not-allowed' : 'pointer',
          }}
        >
          Continue to layers →
        </button>
      </div>
    </div>
  );
}

// ── shared bits ─────────────────────────────────────────────────────────────

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}

const input: React.CSSProperties = {
  padding: '7px 10px', fontSize: 13, color: 'var(--text)',
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6,
  outline: 'none', width: '100%',
};

const btnSubtle: React.CSSProperties = {
  padding: '5px 10px', fontSize: 11, fontWeight: 600,
  background: 'transparent', color: 'var(--muted)',
  border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
};
