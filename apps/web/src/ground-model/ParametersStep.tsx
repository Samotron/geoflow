/**
 * ParametersStep — for each layer, show every sample of every channel that
 * falls inside the layer's RL range, plus descriptive stats. The user types
 * in the parameter value and a free-text justification.
 *
 * We don't compute or recommend a "design value" — the package is a
 * surface that informs the user, who makes the call.
 */

import { Fragment, useMemo, useState, useEffect, useRef } from 'react';
import * as OPlot from '@observablehq/plot';
import type { AgsFile } from '../core.js';
import {
  CHANNELS,
  describe as describeStats,
  extractChannel,
  samplesInRange,
} from '@geoflow/ground-model';
import type {
  ChannelKey,
  ChannelMeta,
  GroundModel,
  Layer,
  ParameterValue,
  Sample,
  SampleStats,
} from '@geoflow/ground-model';

interface ParametersStepProps {
  file: AgsFile;
  model: GroundModel;
  onChange: (next: GroundModel) => Promise<void> | void;
  onNext: () => void;
}

export function ParametersStep({ file, model, onChange, onNext }: ParametersStepProps) {
  const allChannels = useMemo(() => {
    const map = new Map<ChannelKey, Sample[]>();
    for (const meta of CHANNELS) {
      map.set(meta.key, extractChannel(file, meta.key, model.group.locaIds));
    }
    return map;
  }, [file, model.group.locaIds]);

  const [activeLayer, setActiveLayer] = useState<string | null>(model.layers[0]?.id ?? null);
  const layer = model.layers.find((l) => l.id === activeLayer) ?? model.layers[0] ?? null;

  if (!layer) {
    return (
      <div style={{ padding: 24, color: 'var(--muted)' }}>
        Add at least one layer in the Layers step before assigning parameters.
      </div>
    );
  }

  const updateParam = (key: string, patch: Partial<ParameterValue>) => {
    const layers = model.layers.map((l) => {
      if (l.id !== layer.id) return l;
      return {
        ...l,
        parameters: l.parameters.map((p) => (p.key === key ? { ...p, ...patch } : p)),
      };
    });
    void onChange({ ...model, layers });
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 16, alignItems: 'flex-start' }}>
      {/* ── Layer tabs ─────────────────────────────────────────── */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', padding: 8, position: 'sticky', top: 0,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', padding: '4px 8px 8px' }}>
          Layers
        </div>
        {model.layers.map((l) => {
          const isActive = l.id === layer.id;
          return (
            <div
              key={l.id}
              onClick={() => setActiveLayer(l.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
                background: isActive ? 'var(--accent-soft)' : 'transparent',
                border: isActive ? '1px solid var(--accent-border)' : '1px solid transparent',
                marginBottom: 2,
              }}
            >
              <div style={{ width: 14, height: 14, borderRadius: 3, background: l.color, border: '1px solid #334155' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: isActive ? 'var(--accent)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {l.name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                  RL {l.topRL.toFixed(1)} → {l.baseRL.toFixed(1)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Parameter cards for active layer ───────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Card title={`${layer.name} — RL ${layer.topRL.toFixed(2)} → ${layer.baseRL.toFixed(2)} mAOD`} right={
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            thickness {Math.abs(layer.topRL - layer.baseRL).toFixed(2)} m · {layer.description || layer.unitKey}
          </span>
        }>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            Choose values for each parameter using the plots and stats below as evidence.
            Add a short note recording what you based the value on.
          </div>
        </Card>

        {layer.parameters.map((param) => {
          // Channels whose `parameterHint` matches this parameter come first;
          // every other channel is still selectable so the user has the full
          // evidence set if the AGS file uses non-standard groupings.
          const relevant = CHANNELS.filter((c) => c.parameterHint === param.key);
          const others = CHANNELS.filter((c) => c.parameterHint !== param.key);
          const channels = [...relevant, ...others];
          return (
            <ParameterCard
              key={param.key}
              layer={layer}
              param={param}
              channels={channels}
              allSamples={allChannels}
              onChange={(patch) => updateParam(param.key, patch)}
            />
          );
        })}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onNext} style={{
            padding: '8px 18px', fontSize: 13, fontWeight: 600,
            background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
          }}>Continue to export →</button>
        </div>
      </div>
    </div>
  );
}

// ── Parameter card ──────────────────────────────────────────────────────────

interface ParameterCardProps {
  layer: Layer;
  param: ParameterValue;
  channels: ReadonlyArray<ChannelMeta>;
  allSamples: Map<ChannelKey, Sample[]>;
  onChange: (patch: Partial<ParameterValue>) => void;
}

function ParameterCard({ layer, param, channels, allSamples, onChange }: ParameterCardProps) {
  // Default to the first relevant channel
  const [activeChannel, setActiveChannel] = useState<ChannelKey>(channels[0]?.key ?? CHANNELS[0]!.key);
  const samples = allSamples.get(activeChannel) ?? [];
  const inRange = useMemo(
    () => samplesInRange(samples, layer.topRL, layer.baseRL),
    [samples, layer.topRL, layer.baseRL],
  );
  const stats = useMemo(() => describeStats(inRange.map((s) => s.value)), [inRange]);
  const meta = CHANNELS.find((c) => c.key === activeChannel)!;

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface-muted)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{param.label}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>({param.units})</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {channels.map((c) => (
            <button
              key={c.key}
              onClick={() => setActiveChannel(c.key)}
              style={{
                padding: '3px 8px', fontSize: 11, fontWeight: 600,
                background: c.key === activeChannel ? 'var(--accent)' : 'var(--card)',
                color: c.key === activeChannel ? '#fff' : 'var(--muted)',
                border: '1px solid var(--border)', borderRadius: 99, cursor: 'pointer',
              }}
            >{c.label}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 14, padding: 14 }}>
        <div>
          <Plot
            samples={inRange}
            xLabel={`${meta.label} (${meta.units})`}
            topRL={layer.topRL}
            baseRL={layer.baseRL}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <StatsTable stats={stats} units={meta.units} />
          <ValueInput param={param} onChange={onChange} />
          <NoteInput param={param} onChange={onChange} />
          <EvidenceLink count={inRange.length} onAttach={() => {
            const refs = inRange.map((s) => s.ref);
            onChange({ evidenceRefs: refs });
          }} attached={param.evidenceRefs.length} />
        </div>
      </div>
    </div>
  );
}

function StatsTable({ stats, units }: { stats: SampleStats; units: string }) {
  const rows: Array<[string, string]> = [
    ['n',      String(stats.count)],
    ['min',    fmt(stats.min)],
    ['max',    fmt(stats.max)],
    ['mean',   fmt(stats.mean)],
    ['median', fmt(stats.median)],
    ['std',    fmt(stats.stdev)],
    ['p5',     fmt(stats.p5)],
    ['p95',    fmt(stats.p95)],
  ];
  return (
    <div style={{
      background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 6,
      padding: '8px 10px',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 4 }}>
        Stats ({units})
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 12, fontFamily: "'Menlo', 'Consolas', monospace" }}>
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <span style={{ color: 'var(--muted)' }}>{k}</span>
            <span style={{ color: 'var(--text)', textAlign: 'right' }}>{v}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs > 0 && (abs < 0.01 || abs >= 1e6)) return v.toExponential(2);
  return v.toFixed(abs < 10 ? 3 : 2);
}

function ValueInput({ param, onChange }: { param: ParameterValue; onChange: (patch: Partial<ParameterValue>) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
      <span style={{ fontWeight: 600 }}>Chosen value</span>
      <input
        type="number"
        value={param.value ?? ''}
        placeholder="—"
        onChange={(e) => {
          const v = e.target.value;
          onChange({ value: v === '' ? null : Number(v) });
        }}
        style={{
          padding: '7px 10px', fontSize: 14, fontWeight: 600, color: 'var(--text)',
          background: 'var(--card)', border: '1px solid var(--accent-border)',
          borderRadius: 6, outline: 'none', width: '100%',
        }}
      />
    </label>
  );
}

function NoteInput({ param, onChange }: { param: ParameterValue; onChange: (patch: Partial<ParameterValue>) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
      <span style={{ fontWeight: 600 }}>Justification</span>
      <textarea
        value={param.note}
        placeholder="What did you base this value on?"
        rows={2}
        onChange={(e) => onChange({ note: e.target.value })}
        style={{
          padding: '7px 10px', fontSize: 12, color: 'var(--text)',
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: 6, outline: 'none', resize: 'vertical', fontFamily: 'inherit',
        }}
      />
    </label>
  );
}

function EvidenceLink({ count, attached, onAttach }: { count: number; attached: number; onAttach: () => void }) {
  return (
    <button
      onClick={onAttach}
      disabled={count === 0}
      style={{
        padding: '6px 10px', fontSize: 11, fontWeight: 600,
        background: 'transparent',
        color: count === 0 ? 'var(--muted)' : 'var(--accent)',
        border: `1px solid ${attached > 0 ? 'var(--accent-border)' : 'var(--border)'}`,
        borderRadius: 6, cursor: count === 0 ? 'not-allowed' : 'pointer',
      }}
    >
      {attached > 0
        ? `${attached} evidence ref${attached === 1 ? '' : 's'} attached`
        : count > 0
          ? `Attach ${count} sample${count === 1 ? '' : 's'} as evidence`
          : 'No samples in range'}
    </button>
  );
}

// ── In-line depth scatter plot (RL on y axis) ──────────────────────────────

interface PlotProps {
  samples: ReadonlyArray<Sample>;
  xLabel: string;
  topRL: number;
  baseRL: number;
}

function Plot({ samples, xLabel, topRL, baseRL }: PlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren();
    if (samples.length === 0) {
      const blank = document.createElement('div');
      blank.style.padding = '32px 16px';
      blank.style.textAlign = 'center';
      blank.style.color = 'var(--muted)';
      blank.style.fontSize = '12px';
      blank.textContent = 'No samples in this layer for the selected channel.';
      el.appendChild(blank);
      return;
    }
    const data = samples.map((s) => ({ x: s.value, y: s.rl, locaId: s.ref.locaId }));
    const xMax = Math.max(...samples.map((s) => s.value));
    const xPad = xMax * 0.08 || 1;
    const node = PlotPlot({
      width: Math.max(260, el.clientWidth - 4),
      height: 260,
      marginLeft: 50, marginRight: 10,
      x: { label: xLabel, domain: [0, xMax + xPad], grid: true },
      y: { label: 'RL (mAOD)', domain: [baseRL, topRL], grid: true },
      marks: [
        // Layer band
        rect([{ x1: 0, x2: xMax + xPad, y1: baseRL, y2: topRL }], {
          x1: 'x1', x2: 'x2', y1: 'y1', y2: 'y2',
          fill: '#7a9ee0', fillOpacity: 0.06, stroke: '#7a9ee0', strokeOpacity: 0.4, strokeDasharray: '3,3',
        }),
        dot(data, {
          x: 'x', y: 'y', r: 4, fill: '#1a4080',
          stroke: 'white', strokeWidth: 0.8,
          tip: true, title: (d: { locaId: string; x: number; y: number }) => `${d.locaId}\n${d.x.toPrecision(4)} @ RL ${d.y.toFixed(2)}`,
        }),
      ],
    });
    el.appendChild(node);
    return () => { if (el) el.replaceChildren(); };
  }, [samples, xLabel, topRL, baseRL]);
  return <div ref={ref} style={{ width: '100%' }} />;
}

// ── Observable Plot wrappers (typed loosely to avoid leaking generics) ─────

function PlotPlot(spec: Parameters<typeof OPlot.plot>[0]) {
  return OPlot.plot(spec);
}
function dot<T>(data: ReadonlyArray<T>, opts: OPlot.DotOptions) {
  return OPlot.dot(data, opts);
}
function rect<T>(data: ReadonlyArray<T>, opts: OPlot.RectOptions) {
  return OPlot.rect(data, opts);
}

// ── Card shell ─────────────────────────────────────────────────────────────

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
