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
import { availableUnitKeyFields } from '../core.js';
import type { AgsFile } from '../core.js';
import {
  buildSkeleton,
  defaultParameterValues,
  extractChannel,
} from '@geoflow/ground-model';
import type {
  GroundModel,
  Layer,
  PerBoreholeContacts,
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
  const unitKeyOptions = useMemo(
    () => availableUnitKeyFields(file, model.group.locaIds),
    [file, model.group.locaIds],
  );

  const skeleton = useMemo(
    () => buildSkeleton(file, model.group.locaIds, {
      sampleStep: model.sampleStep,
      unitKeyField: model.unitKeyField,
    }),
    [file, model.group.locaIds, model.sampleStep, model.unitKeyField],
  );

  // If the user has not yet built layers, seed from the skeleton.
  const layers = model.layers.length > 0 ? model.layers : skeleton.layers;

  const sptSamples = useMemo(
    () => extractChannel(file, 'spt_n', model.group.locaIds),
    [file, model.group.locaIds],
  );
  const cuSamples = useMemo(
    () => extractChannel(file, 'cu', model.group.locaIds),
    [file, model.group.locaIds],
  );
  const bulkDensitySamples = useMemo(
    () => extractChannel(file, 'bulk_density', model.group.locaIds),
    [file, model.group.locaIds],
  );
  const mcSamples = useMemo(
    () => extractChannel(file, 'mc', model.group.locaIds),
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
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8,
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ fontWeight: 600 }}>Infer from</span>
            <select
              value={model.unitKeyField ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                void onChange({
                  ...model,
                  unitKeyField: v === '' ? undefined : v,
                  // Drop the existing layer stack so the skeleton re-runs from
                  // the new column on the next render.
                  layers: [],
                });
              }}
              style={{
                padding: '4px 8px', fontSize: 12, color: 'var(--text)',
                background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 4,
                outline: 'none',
              }}
            >
              <option value="">Auto (GEOL_GEOL → LEG → DESC)</option>
              {unitKeyOptions.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>
              column used as the unit key for majority-voting
            </span>
          </label>
        </div>
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

      {/* ── Per-borehole comparison: model vs interpreted contacts ──── */}
      <Card title="Interpreted contacts — model vs borehole interpretations">
        <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.55 }}>
          The leftmost column is the consolidated model. Each subsequent
          ribbon is one borehole's interpretation drawn at its own RL, with
          the geology coloured in and overlaid by sample data (SPT N · cu ·
          bulk density). Contacts that fall inside the model's RL range are
          highlighted in red so you can spot boundaries the consolidated
          model is missing.
        </p>
        <BoreholeComparison
          layers={layers}
          contacts={skeleton.perBoreholeContacts}
          rlRange={rlRange}
          file={file}
          locaIds={model.group.locaIds}
          unitKeyField={model.unitKeyField}
          sptSamples={sptSamples}
          cuSamples={cuSamples}
          bulkDensitySamples={bulkDensitySamples}
          onInsertBoundary={(rl) => insertBoundary(layers, rl, (next) => onChange({ ...model, layers: next }))}
        />
      </Card>

      <Card title="Levels summary — what's at every RL across the group">
        <LevelsSummaryTable
          contacts={skeleton.perBoreholeContacts}
          layers={layers}
          sptSamples={sptSamples}
          cuSamples={cuSamples}
          bulkDensitySamples={bulkDensitySamples}
          mcSamples={mcSamples}
          rlRange={rlRange}
          onInsertBoundary={(rl) => insertBoundary(layers, rl, (next) => onChange({ ...model, layers: next }))}
        />
      </Card>

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

// ── Borehole comparison ribbon ─────────────────────────────────────────────

interface BoreholeComparisonProps {
  layers: ReadonlyArray<Layer>;
  contacts: ReadonlyArray<PerBoreholeContacts>;
  rlRange: { top: number; base: number };
  file: AgsFile;
  locaIds: ReadonlyArray<string>;
  unitKeyField?: string | undefined;
  sptSamples: ReadonlyArray<{ value: number; rl: number; ref: { locaId: string } }>;
  cuSamples: ReadonlyArray<{ value: number; rl: number; ref: { locaId: string } }>;
  bulkDensitySamples: ReadonlyArray<{ value: number; rl: number; ref: { locaId: string } }>;
  onInsertBoundary: (rl: number) => void;
}

function BoreholeComparison({
  layers,
  contacts,
  rlRange,
  file,
  unitKeyField,
  sptSamples,
  cuSamples,
  bulkDensitySamples,
  onInsertBoundary,
}: BoreholeComparisonProps) {
  // Build a per-borehole stratigraphic layer stack in RL so we can colour
  // each ribbon by geology, not just draw contact ticks.
  const stacksByLoca = useMemo(
    () => buildPerBoreholeStacks(file, contacts.map((c) => c.locaId), unitKeyField),
    [file, contacts, unitKeyField],
  );

  if (contacts.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>
        No GEOL contacts found for the selected boreholes.
      </div>
    );
  }
  const COL_W = 76;
  const COL_GAP = 8;
  const LABEL_H = 26;
  const HEIGHT = 360;
  const modelTop = rlRange.top;
  const modelBase = rlRange.base;
  const modelSpan = modelTop - modelBase || 1;
  const modelRLToY = (rl: number) => ((modelTop - rl) / modelSpan) * HEIGHT;

  const GUTTER = 44;
  const totalW = GUTTER + (COL_W + COL_GAP) * (1 + contacts.length);

  // Pre-bucket samples by LOCA_ID for fast per-column lookup.
  const sptByLoca = bucketByLoca(sptSamples);
  const cuByLoca = bucketByLoca(cuSamples);
  const bdByLoca = bucketByLoca(bulkDensitySamples);

  const sptMax = Math.max(60, ...sptSamples.map((s) => s.value));
  const cuMax = Math.max(50, ...cuSamples.map((s) => s.value));
  const bdMax = Math.max(2.4, ...bulkDensitySamples.map((s) => s.value));

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={totalW} height={HEIGHT + LABEL_H + 28} style={{ display: 'block' }}>
        {/* Y-axis ticks anchored to the model's RL range */}
        {tickRLs(modelTop, modelBase).map((rl) => {
          const y = modelRLToY(rl) + LABEL_H;
          return (
            <g key={`ax-${rl}`}>
              <line x1={GUTTER - 4} x2={GUTTER} y1={y} y2={y} stroke="#94a3b8" strokeWidth={0.7} />
              <text x={GUTTER - 6} y={y + 3} fontSize="10" fill="var(--muted)" textAnchor="end">{rl.toFixed(1)}</text>
            </g>
          );
        })}
        <text x={GUTTER - 6} y={LABEL_H - 4} fontSize="9" fill="var(--muted)" textAnchor="end">RL mAOD</text>

        {/* Model column */}
        <g transform={`translate(${GUTTER}, 0)`}>
          <text x={COL_W / 2} y={LABEL_H - 12} fontSize="11" fill="var(--text)" textAnchor="middle" style={{ fontWeight: 700 }}>
            model
          </text>
          <text x={COL_W / 2} y={LABEL_H - 2} fontSize="9" fill="var(--muted)" textAnchor="middle">
            {layers.length} layer{layers.length === 1 ? '' : 's'}
          </text>
          {layers.map((l) => {
            const y1 = modelRLToY(l.topRL) + LABEL_H;
            const y2 = modelRLToY(l.baseRL) + LABEL_H;
            return (
              <g key={l.id}>
                <rect
                  x={0} y={y1}
                  width={COL_W} height={Math.max(2, y2 - y1)}
                  fill={l.color} stroke="#334155" strokeWidth={0.6}
                />
                {y2 - y1 > 14 && (
                  <text
                    x={COL_W / 2} y={(y1 + y2) / 2 + 3}
                    fontSize="10" fill="#0f172a" textAnchor="middle"
                    style={{ pointerEvents: 'none', fontFamily: 'monospace' }}
                  >{(l.unitKey || l.name).slice(0, 10)}</text>
                )}
              </g>
            );
          })}
        </g>

        {/* Per-borehole ribbons */}
        {contacts.map((bh, bi) => {
          const x = GUTTER + (COL_W + COL_GAP) * (1 + bi);
          const stack = stacksByLoca.get(bh.locaId) ?? [];
          const spt = sptByLoca.get(bh.locaId) ?? [];
          const cu = cuByLoca.get(bh.locaId) ?? [];
          const bd = bdByLoca.get(bh.locaId) ?? [];
          // Match the model's RL range so the y axis is consistent across columns
          const rlToY = (rl: number) => ((modelTop - rl) / modelSpan) * HEIGHT;

          // Track widths reserved for sample overlay scatter (to the right of
          // the geology block). Allocate ~ COL_W * 0.5 for sample plots.
          const geolW = Math.round(COL_W * 0.45);
          const overlayX0 = geolW + 2;
          const overlayW = COL_W - overlayX0;

          return (
            <g key={bh.locaId} transform={`translate(${x}, 0)`}>
              <text x={COL_W / 2} y={LABEL_H - 12} fontSize="10" fill="var(--text)" textAnchor="middle" style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                {bh.locaId.length > 9 ? bh.locaId.slice(0, 9) + '…' : bh.locaId}
                <title>{bh.locaId} (GL {bh.groundLevel?.toFixed(2) ?? '?'} mAOD)</title>
              </text>
              <text x={COL_W / 2} y={LABEL_H - 2} fontSize="9" fill="var(--muted)" textAnchor="middle">
                GL {bh.groundLevel?.toFixed(1) ?? '?'}
              </text>
              {/* Pale background covering full column height */}
              <rect
                x={0} y={LABEL_H} width={COL_W} height={HEIGHT}
                fill="var(--surface-muted)" stroke="var(--border)" strokeWidth={0.5}
              />
              {/* Stratigraphic blocks (only within model window) */}
              {stack.map((l, li) => {
                const top = Math.min(modelTop, l.topRL);
                const base = Math.max(modelBase, l.baseRL);
                if (base >= top) return null;
                const y1 = rlToY(top) + LABEL_H;
                const y2 = rlToY(base) + LABEL_H;
                return (
                  <g key={li}>
                    <rect
                      x={0} y={y1}
                      width={geolW} height={Math.max(2, y2 - y1)}
                      fill={colorForUnitLocal(l.unitKey)}
                      stroke="#334155" strokeWidth={0.5}
                    />
                    {y2 - y1 > 12 && (
                      <text
                        x={geolW / 2} y={(y1 + y2) / 2 + 3}
                        fontSize="8" fill="#0f172a" textAnchor="middle"
                        style={{ pointerEvents: 'none', fontFamily: 'monospace' }}
                      >{l.unitKey.slice(0, 6)}</text>
                    )}
                    <title>
                      {l.unitKey}: {l.desc || '—'}{'\n'}
                      RL {l.topRL.toFixed(2)} → {l.baseRL.toFixed(2)}
                    </title>
                  </g>
                );
              })}
              {/* Sample overlays (SPT N · cu · bulk density) */}
              {spt.filter((s) => s.rl <= modelTop && s.rl >= modelBase).map((s, i) => (
                <circle
                  key={`spt-${i}`}
                  cx={overlayX0 + (Math.min(s.value, sptMax) / sptMax) * (overlayW - 4) + 2}
                  cy={rlToY(s.rl) + LABEL_H}
                  r={2} fill="#0f172a" opacity={0.7}
                >
                  <title>SPT N = {s.value} @ RL {s.rl.toFixed(2)}</title>
                </circle>
              ))}
              {cu.filter((s) => s.rl <= modelTop && s.rl >= modelBase).map((s, i) => (
                <rect
                  key={`cu-${i}`}
                  x={overlayX0 + (Math.min(s.value, cuMax) / cuMax) * (overlayW - 4)}
                  y={rlToY(s.rl) + LABEL_H - 1.5}
                  width={3} height={3}
                  fill="#dc2626" opacity={0.85}
                >
                  <title>cu = {s.value} kPa @ RL {s.rl.toFixed(2)}</title>
                </rect>
              ))}
              {bd.filter((s) => s.rl <= modelTop && s.rl >= modelBase).map((s, i) => (
                <polygon
                  key={`bd-${i}`}
                  points={(() => {
                    const px = overlayX0 + (Math.min(s.value, bdMax) / bdMax) * (overlayW - 4) + 2;
                    const py = rlToY(s.rl) + LABEL_H;
                    return `${px},${py - 2} ${px + 2},${py + 2} ${px - 2},${py + 2}`;
                  })()}
                  fill="#a855f7" opacity={0.8}
                >
                  <title>ρb = {s.value} Mg/m³ @ RL {s.rl.toFixed(2)}</title>
                </polygon>
              ))}
              {/* Interpreted contacts — clickable to insert a model boundary */}
              {bh.contacts.map((c, i) => {
                const inWindow = c.rl <= modelTop && c.rl >= modelBase;
                if (!inWindow) return null;
                const y = rlToY(c.rl) + LABEL_H;
                return (
                  <g key={i} style={{ cursor: 'pointer' }} onClick={() => onInsertBoundary(c.rl)}>
                    <line
                      x1={-2} x2={COL_W + 2}
                      y1={y} y2={y}
                      stroke="#dc2626" strokeWidth={1.3}
                      opacity={0.85}
                    />
                    <title>
                      {c.unitAbove} → {c.unitBelow}
                      {'\n'}RL {c.rl.toFixed(2)} mAOD (depth {c.depth.toFixed(2)} m)
                      {'\n'}click to insert a model boundary here
                    </title>
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Faint horizontal guides at every model layer boundary so the eye
            can sweep across all columns at a glance. */}
        {layers.flatMap((l) => [l.topRL, l.baseRL])
          .filter((rl, i, a) => a.indexOf(rl) === i)
          .map((rl, i) => {
            const y = modelRLToY(rl) + LABEL_H;
            return (
              <line
                key={`g-${i}`}
                x1={GUTTER} x2={totalW}
                y1={y} y2={y}
                stroke="#1a4080" strokeWidth={0.4}
                strokeDasharray="2,3"
                opacity={0.35}
              />
            );
          })}

        {/* Footer scale legend */}
        <text x={GUTTER} y={HEIGHT + LABEL_H + 14} fontSize="9" fill="var(--muted)">
          sample scale ranges →  SPT 0–{Math.round(sptMax)}  |  cu 0–{Math.round(cuMax)} kPa  |  ρb 0–{bdMax.toFixed(1)} Mg/m³
        </text>
        <text x={GUTTER} y={HEIGHT + LABEL_H + 26} fontSize="9" fill="var(--muted)">
          click any red contact line to insert a model boundary at its RL
        </text>
      </svg>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 10, color: 'var(--muted)', flexWrap: 'wrap' }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#0f172a', borderRadius: '50%', verticalAlign: 'middle', marginRight: 4 }} /> SPT N</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#dc2626', verticalAlign: 'middle', marginRight: 4 }} /> cu</span>
        <span><span style={{ display: 'inline-block', width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderBottom: '7px solid #a855f7', verticalAlign: 'middle', marginRight: 4 }} /> bulk density</span>
        <span><span style={{ display: 'inline-block', width: 16, height: 2, background: '#dc2626', verticalAlign: 'middle', marginRight: 4 }} /> interpreted contact (click)</span>
        <span><span style={{ display: 'inline-block', width: 16, height: 0, borderTop: '1px dashed #1a4080', verticalAlign: 'middle', marginRight: 4 }} /> model boundary</span>
      </div>
    </div>
  );
}

function bucketByLoca<T extends { ref: { locaId: string } }>(samples: ReadonlyArray<T>): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const s of samples) {
    const arr = m.get(s.ref.locaId) ?? [];
    arr.push(s);
    m.set(s.ref.locaId, arr);
  }
  return m;
}

interface PerBoreholeLayer {
  topRL: number;
  baseRL: number;
  unitKey: string;
  desc: string;
}

function buildPerBoreholeStacks(
  file: AgsFile,
  locaIds: ReadonlyArray<string>,
  unitKeyField: string | undefined,
): Map<string, PerBoreholeLayer[]> {
  const gls = new Map<string, number>();
  for (const r of file.groups['LOCA']?.rows ?? []) {
    const id = String(r['LOCA_ID'] ?? '').trim();
    const gl = Number(r['LOCA_GL']);
    if (id && Number.isFinite(gl)) gls.set(id, gl);
  }
  const out = new Map<string, PerBoreholeLayer[]>();
  for (const row of file.groups['GEOL']?.rows ?? []) {
    const id = String(row['LOCA_ID'] ?? '').trim();
    if (!id || !locaIds.includes(id)) continue;
    const gl = gls.get(id);
    if (gl == null) continue;
    const top = Number(row['GEOL_TOP']);
    const base = Number(row['GEOL_BASE']);
    if (!Number.isFinite(top) || !Number.isFinite(base)) continue;
    const unitKey = pickUnitKeyLocal(row, unitKeyField);
    if (!unitKey) continue;
    const desc = String(row['GEOL_DESC'] ?? '').trim();
    const arr = out.get(id) ?? [];
    arr.push({ topRL: gl - top, baseRL: gl - base, unitKey, desc });
    out.set(id, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => b.topRL - a.topRL);
  return out;
}

function pickUnitKeyLocal(row: Record<string, unknown>, field?: string): string {
  if (field) {
    const v = row[field];
    if (v !== null && v !== undefined) {
      const s = String(v).trim();
      if (s) return s.toUpperCase().slice(0, 32);
    }
  }
  for (const c of ['GEOL_GEOL', 'GEOL_LEG', 'GEOL_DESC']) {
    const v = row[c];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s.toUpperCase().slice(0, 32);
  }
  return '';
}

function colorForUnitLocal(unitKey: string): string {
  const u = unitKey.toUpperCase();
  if (u.includes('MADE') || u.includes('FILL') || u.includes('TS')) return '#A0785A';
  if (u.includes('PEAT')) return '#3D2B1F';
  if (u.includes('CHALK') || u === 'CK') return '#E8E4A0';
  if (u.includes('CLAY') || u === 'CL' || u === 'LC') return '#7B9EC5';
  if (u.includes('SILT') || u === 'ML' || u === 'MH') return '#C4A87C';
  if (u.includes('GRAVEL') || u === 'GR' || u === 'GP' || u === 'GW') return '#C87A45';
  if (u.includes('SAND') || u === 'SA' || u === 'SP' || u === 'SW') return '#E8C840';
  if (u.includes('ROCK') || u === 'RX' || u.includes('STONE')) return '#9090A0';
  // Hash fallback
  let h = 0;
  for (let i = 0; i < unitKey.length; i++) h = (h * 31 + unitKey.charCodeAt(i)) & 0xffff;
  const ring = ['#A8C5A1', '#C5A8B5', '#A1B5C5', '#C5C0A1', '#B5A1C5', '#A1C5C0'];
  return ring[h % ring.length]!;
}

// ── Levels summary table ───────────────────────────────────────────────────

interface LevelsSummaryProps {
  contacts: ReadonlyArray<PerBoreholeContacts>;
  layers: ReadonlyArray<Layer>;
  sptSamples: ReadonlyArray<{ value: number; rl: number; ref: { locaId: string } }>;
  cuSamples: ReadonlyArray<{ value: number; rl: number; ref: { locaId: string } }>;
  bulkDensitySamples: ReadonlyArray<{ value: number; rl: number; ref: { locaId: string } }>;
  mcSamples: ReadonlyArray<{ value: number; rl: number; ref: { locaId: string } }>;
  rlRange: { top: number; base: number };
  onInsertBoundary: (rl: number) => void;
}

/**
 * Bucket every interpreted contact by RL (rounded to 0.25 m) and summarise
 * what's happening at that level across the whole group. The user gets a
 * dense, tabular view that complements the visual ribbons.
 */
function LevelsSummaryTable({
  contacts, layers, sptSamples, cuSamples, bulkDensitySamples, mcSamples, rlRange, onInsertBoundary,
}: LevelsSummaryProps) {
  const BIN = 0.25;
  interface Bin {
    rlTop: number;
    rlBase: number;
    contacts: Array<{ locaId: string; above: string; below: string; rl: number }>;
    sptN: number[];
    cu: number[];
    bd: number[];
    mc: number[];
  }
  const bins = new Map<number, Bin>();
  const binKey = (rl: number) => Math.round(rl / BIN) * BIN;
  const ensure = (rl: number): Bin => {
    const key = binKey(rl);
    let b = bins.get(key);
    if (!b) {
      b = {
        rlTop: round(key + BIN / 2, 2),
        rlBase: round(key - BIN / 2, 2),
        contacts: [],
        sptN: [], cu: [], bd: [], mc: [],
      };
      bins.set(key, b);
    }
    return b;
  };
  for (const bh of contacts) {
    for (const c of bh.contacts) {
      if (c.rl > rlRange.top || c.rl < rlRange.base) continue;
      ensure(c.rl).contacts.push({ locaId: bh.locaId, above: c.unitAbove, below: c.unitBelow, rl: c.rl });
    }
  }
  for (const s of sptSamples) if (s.rl <= rlRange.top && s.rl >= rlRange.base) ensure(s.rl).sptN.push(s.value);
  for (const s of cuSamples) if (s.rl <= rlRange.top && s.rl >= rlRange.base) ensure(s.rl).cu.push(s.value);
  for (const s of bulkDensitySamples) if (s.rl <= rlRange.top && s.rl >= rlRange.base) ensure(s.rl).bd.push(s.value);
  for (const s of mcSamples) if (s.rl <= rlRange.top && s.rl >= rlRange.base) ensure(s.rl).mc.push(s.value);

  const sorted = [...bins.values()].sort((a, b) => b.rlTop - a.rlTop);
  if (sorted.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>
        No contacts or samples to summarise in the current RL window.
      </div>
    );
  }
  const layerAt = (rl: number) => {
    for (const l of layers) if (rl <= l.topRL && rl >= l.baseRL) return l;
    return null;
  };
  const fmtMean = (xs: number[]) => xs.length === 0 ? '—' : `${(xs.reduce((a, x) => a + x, 0) / xs.length).toFixed(1)} (n=${xs.length})`;

  return (
    <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead style={{ position: 'sticky', top: 0, background: 'var(--surface-muted)', zIndex: 1 }}>
          <tr>
            <th style={summaryTh}>RL (mAOD)</th>
            <th style={summaryTh}>Model layer</th>
            <th style={summaryTh}>Contacts</th>
            <th style={{ ...summaryTh, textAlign: 'right' }}>SPT N̄</th>
            <th style={{ ...summaryTh, textAlign: 'right' }}>c̄u (kPa)</th>
            <th style={{ ...summaryTh, textAlign: 'right' }}>ρ̄b (Mg/m³)</th>
            <th style={{ ...summaryTh, textAlign: 'right' }}>w̄ (%)</th>
            <th style={summaryTh}></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((b, i) => {
            const rlMid = round((b.rlTop + b.rlBase) / 2, 2);
            const ml = layerAt(rlMid);
            const hasContact = b.contacts.length > 0;
            return (
              <tr key={i} style={{
                background: hasContact ? 'rgba(220, 38, 38, 0.06)' : i % 2 ? 'transparent' : 'var(--surface-muted)',
              }}>
                <td style={{ ...summaryTd, fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>
                  {b.rlBase.toFixed(2)} – {b.rlTop.toFixed(2)}
                </td>
                <td style={summaryTd}>
                  {ml ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: ml.color, border: '1px solid #334155' }} />
                      <span>{ml.name}</span>
                    </span>
                  ) : '—'}
                </td>
                <td style={{ ...summaryTd, fontFamily: 'monospace' }}>
                  {hasContact ? (
                    <span title={b.contacts.map((c) => `${c.locaId}: ${c.above}→${c.below} @ RL ${c.rl.toFixed(2)}`).join('\n')}>
                      {b.contacts.length} ({uniq(b.contacts.map((c) => `${c.above}→${c.below}`)).join(', ')})
                    </span>
                  ) : '—'}
                </td>
                <td style={{ ...summaryTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMean(b.sptN)}</td>
                <td style={{ ...summaryTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMean(b.cu)}</td>
                <td style={{ ...summaryTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {b.bd.length === 0 ? '—' : `${(b.bd.reduce((a, x) => a + x, 0) / b.bd.length).toFixed(2)} (n=${b.bd.length})`}
                </td>
                <td style={{ ...summaryTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMean(b.mc)}</td>
                <td style={summaryTd}>
                  {hasContact && (
                    <button
                      onClick={() => onInsertBoundary(rlMid)}
                      style={{
                        padding: '2px 6px', fontSize: 10, fontWeight: 600,
                        background: 'transparent', color: 'var(--accent)',
                        border: '1px solid var(--accent-border)', borderRadius: 4, cursor: 'pointer',
                      }}
                      title={`Insert a model boundary at RL ${rlMid.toFixed(2)}`}
                    >+ boundary</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

const summaryTh: React.CSSProperties = {
  padding: '6px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const summaryTd: React.CSSProperties = {
  padding: '5px 10px', borderBottom: '1px solid var(--surface-muted)',
  verticalAlign: 'top', fontSize: 12,
};

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
