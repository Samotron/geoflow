/**
 * LayersStep — edit the layer boundaries in RL.
 *
 * On entry we build a GEOL-primary skeleton via `buildSkeleton` and apply
 * it if the model has no layers yet (or if the user clicks "Re-suggest").
 * Boundary suggestions from GEOL contacts and SPT change-points are shown
 * as faint tick marks beside the strip log; clicking one inserts a new
 * boundary at that RL.
 *
 * A small SPT scatter is rendered next to the strip so the user can see
 * the evidence inline. Lab/CPT signal overlays are deferred to v2 — SPT
 * + GEOL is enough to validate the workflow end-to-end.
 */

import { useMemo } from 'react';
import type { AgsFile } from '../core.js';
import {
  buildSkeleton,
  defaultParameterValues,
  extractChannel,
} from '@geoflow/ground-model';
import type {
  GroundModel,
  Layer,
} from '@geoflow/ground-model';

interface LayersStepProps {
  file: AgsFile;
  model: GroundModel;
  onChange: (next: GroundModel) => Promise<void> | void;
  onNext: () => void;
}

const STRIP_WIDTH = 140;
const STRIP_LEFT = 60;

export function LayersStep({ file, model, onChange, onNext }: LayersStepProps) {
  const skeleton = useMemo(
    () => buildSkeleton(file, model.group.locaIds, { sampleStep: model.sampleStep }),
    [file, model.group.locaIds, model.sampleStep],
  );

  // If the user has not yet built layers, seed from the skeleton.
  const layers = model.layers.length > 0 ? model.layers : skeleton.layers;

  const sptSamples = useMemo(
    () => extractChannel(file, 'spt_n', model.group.locaIds),
    [file, model.group.locaIds],
  );

  const rlRange = useMemo(() => {
    if (layers.length === 0) {
      if (sptSamples.length === 0) return { top: skeleton.meanGL, base: skeleton.meanGL - 10 };
      const rls = sptSamples.map((s) => s.rl);
      return { top: Math.max(...rls, skeleton.meanGL), base: Math.min(...rls) };
    }
    const top = Math.max(...layers.map((l) => l.topRL));
    const base = Math.min(...layers.map((l) => l.baseRL));
    return { top, base };
  }, [layers, sptSamples, skeleton.meanGL]);

  const stripHeight = 480;
  const rlToY = (rl: number) => {
    const span = rlRange.top - rlRange.base || 1;
    return ((rlRange.top - rl) / span) * stripHeight;
  };

  const applySkeleton = () => {
    void onChange({ ...model, layers: skeleton.layers });
  };

  const updateLayer = (idx: number, patch: Partial<Layer>) => {
    const next = [...layers];
    const target = { ...next[idx]!, ...patch };
    // Maintain top > base invariant after edit
    if (target.topRL <= target.baseRL) return;
    next[idx] = target;
    // Cascade: keep adjacent layers consistent (base of i = top of i+1)
    if (patch.baseRL !== undefined && idx < next.length - 1) {
      next[idx + 1] = { ...next[idx + 1]!, topRL: patch.baseRL };
    }
    if (patch.topRL !== undefined && idx > 0) {
      next[idx - 1] = { ...next[idx - 1]!, baseRL: patch.topRL };
    }
    void onChange({ ...model, layers: next });
  };

  const splitLayer = (idx: number, atRL: number) => {
    const target = layers[idx]!;
    if (atRL >= target.topRL || atRL <= target.baseRL) return;
    const next = [...layers];
    const upper: Layer = { ...target, id: crypto.randomUUID(), baseRL: atRL };
    const lower: Layer = { ...target, id: crypto.randomUUID(), topRL: atRL, parameters: defaultParameterValues() };
    next.splice(idx, 1, upper, lower);
    void onChange({ ...model, layers: next });
  };

  const removeLayer = (idx: number) => {
    if (layers.length <= 1) return;
    const next = [...layers];
    const removed = next.splice(idx, 1)[0]!;
    // Merge into neighbour: extend predecessor down, or successor up
    if (idx > 0 && next[idx - 1]) {
      next[idx - 1] = { ...next[idx - 1]!, baseRL: removed.baseRL };
    } else if (next[idx]) {
      next[idx] = { ...next[idx]!, topRL: removed.topRL };
    }
    void onChange({ ...model, layers: next });
  };

  const mergeWithBelow = (idx: number) => {
    if (idx >= layers.length - 1) return;
    const a = layers[idx]!;
    const b = layers[idx + 1]!;
    const next = [...layers];
    next.splice(idx, 2, { ...a, baseRL: b.baseRL });
    void onChange({ ...model, layers: next });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title="Skeleton from GEOL" right={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>mean GL = {skeleton.meanGL.toFixed(2)} mAOD</span>
          <button onClick={applySkeleton} style={btnSubtle}>Re-suggest from GEOL</button>
        </div>
      }>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4, lineHeight: 1.55 }}>
          Boundaries are stored in RL (mAOD). Edit numbers below, drag boundaries on
          the strip, or click any tick suggestion to insert a new boundary at that level.
        </p>
        {layers === skeleton.layers && (
          <p style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>
            Showing the initial GEOL skeleton — your edits will persist once you make them.
          </p>
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, alignItems: 'flex-start' }}>
        {/* ── Strip log ──────────────────────────────────────────── */}
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: 12,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 8 }}>
            1D column
          </div>
          <svg width="100%" viewBox={`0 0 300 ${stripHeight + 20}`} style={{ display: 'block' }}>
            {/* Axis ticks */}
            {tickRLs(rlRange.top, rlRange.base).map((rl) => (
              <g key={rl}>
                <line x1={STRIP_LEFT - 6} x2={STRIP_LEFT} y1={rlToY(rl)} y2={rlToY(rl)} stroke="#94a3b8" strokeWidth={0.7} />
                <text x={STRIP_LEFT - 9} y={rlToY(rl) + 4} fontSize="9" fill="var(--muted)" textAnchor="end">{rl.toFixed(1)}</text>
              </g>
            ))}
            {/* Boundary suggestions as tick marks */}
            {skeleton.boundaries.filter((b) => b.rl <= rlRange.top && b.rl >= rlRange.base).map((b, i) => (
              <g
                key={i}
                style={{ cursor: 'pointer' }}
                onClick={() => insertBoundary(layers, b.rl, (next) => onChange({ ...model, layers: next }))}
              >
                <line
                  x1={STRIP_LEFT - 14}
                  x2={STRIP_LEFT - 2}
                  y1={rlToY(b.rl)} y2={rlToY(b.rl)}
                  stroke={b.source === 'GEOL' ? '#16a34a' : '#dc2626'}
                  strokeWidth={1.3}
                  opacity={0.55}
                />
                <title>{b.source}: {b.note ?? 'boundary'} (RL {b.rl.toFixed(2)})</title>
              </g>
            ))}
            {/* Layer rectangles */}
            {layers.map((l, i) => {
              const y1 = rlToY(l.topRL);
              const y2 = rlToY(l.baseRL);
              return (
                <g key={l.id}>
                  <rect
                    x={STRIP_LEFT} y={y1}
                    width={STRIP_WIDTH} height={Math.max(2, y2 - y1)}
                    fill={l.color} stroke="#334155" strokeWidth={0.6}
                  />
                  <text
                    x={STRIP_LEFT + STRIP_WIDTH / 2}
                    y={(y1 + y2) / 2 + 4}
                    fontSize="10" fill="#0f172a"
                    textAnchor="middle"
                    style={{ pointerEvents: 'none', fontFamily: 'monospace' }}
                  >{l.unitKey || `L${i + 1}`}</text>
                </g>
              );
            })}
            {/* SPT scatter — to right of strip */}
            {sptSamples
              .filter((s) => s.rl <= rlRange.top && s.rl >= rlRange.base)
              .map((s, i) => {
                const x = STRIP_LEFT + STRIP_WIDTH + 18 + Math.min(s.value, 60) * 1.1;
                return (
                  <circle key={i} cx={x} cy={rlToY(s.rl)} r={2.5} fill="#0f172a" opacity={0.55}>
                    <title>{s.ref.locaId}: N = {s.value} @ RL {s.rl.toFixed(2)}</title>
                  </circle>
                );
              })}
            <text x={STRIP_LEFT + STRIP_WIDTH + 18} y={stripHeight + 14} fontSize="9" fill="var(--muted)">SPT N →</text>
          </svg>
        </div>

        {/* ── Layer table ────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {layers.length === 0 && (
            <div style={{
              background: 'var(--card)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: 18, color: 'var(--muted)', fontSize: 13,
            }}>
              No layers yet — click <strong>Re-suggest from GEOL</strong> above to build the skeleton.
            </div>
          )}
          {layers.map((l, i) => (
            <div key={l.id} style={{
              display: 'grid',
              gridTemplateColumns: '24px 1fr 80px 80px auto',
              gap: 8, alignItems: 'center',
              padding: '8px 10px',
              background: 'var(--card)',
              border: '1px solid var(--border)', borderRadius: 6,
            }}>
              <div title={l.unitKey} style={{
                width: 18, height: 18, borderRadius: 4,
                background: l.color, border: '1px solid #334155',
              }} />
              <input
                type="text"
                value={l.name}
                onChange={(e) => updateLayer(i, { name: e.target.value })}
                style={inputCompact}
              />
              <input
                type="number"
                step={0.1}
                value={l.topRL}
                onChange={(e) => updateLayer(i, { topRL: Number(e.target.value) })}
                style={inputCompact}
                title="Top RL (mAOD)"
              />
              <input
                type="number"
                step={0.1}
                value={l.baseRL}
                onChange={(e) => updateLayer(i, { baseRL: Number(e.target.value) })}
                style={inputCompact}
                title="Base RL (mAOD)"
              />
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  title="Split at midpoint"
                  onClick={() => splitLayer(i, (l.topRL + l.baseRL) / 2)}
                  style={btnIconSm}
                >⎯</button>
                <button
                  title="Merge with layer below"
                  onClick={() => mergeWithBelow(i)}
                  disabled={i >= layers.length - 1}
                  style={btnIconSm}
                >⇩</button>
                <button title="Remove" onClick={() => removeLayer(i)} style={btnIconSm}>✕</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={onNext}
          disabled={layers.length === 0}
          style={{
            padding: '8px 18px', fontSize: 13, fontWeight: 600,
            background: layers.length === 0 ? 'var(--surface-muted)' : 'var(--accent)',
            color: layers.length === 0 ? 'var(--muted)' : '#fff',
            border: 'none', borderRadius: 6,
            cursor: layers.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          Continue to parameters →
        </button>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function tickRLs(top: number, base: number): number[] {
  const span = top - base;
  if (span <= 0) return [top];
  const step = niceStep(span / 8);
  const out: number[] = [];
  const start = Math.ceil(base / step) * step;
  for (let r = start; r <= top + 1e-6; r += step) out.push(round(r, 2));
  return out;
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  if (m < 1.5) return p;
  if (m < 3.5) return 2 * p;
  if (m < 7.5) return 5 * p;
  return 10 * p;
}

function round(v: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

function insertBoundary(
  layers: ReadonlyArray<Layer>,
  rl: number,
  onChange: (next: Layer[]) => void,
) {
  const idx = layers.findIndex((l) => rl < l.topRL && rl > l.baseRL);
  if (idx === -1) return;
  const target = layers[idx]!;
  const next = [...layers];
  const upper: Layer = { ...target, id: crypto.randomUUID(), baseRL: rl };
  const lower: Layer = { ...target, id: crypto.randomUUID(), topRL: rl, parameters: defaultParameterValues() };
  next.splice(idx, 1, upper, lower);
  onChange(next);
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
  padding: '5px 10px', fontSize: 11, fontWeight: 600,
  background: 'transparent', color: 'var(--muted)',
  border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
};

const btnIconSm: React.CSSProperties = {
  padding: '3px 7px', fontSize: 11, fontWeight: 600,
  background: 'transparent', color: 'var(--muted)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
};

const inputCompact: React.CSSProperties = {
  padding: '5px 8px', fontSize: 12, color: 'var(--text)',
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 4,
  outline: 'none', width: '100%',
};
