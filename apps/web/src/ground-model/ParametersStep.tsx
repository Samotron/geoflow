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
  buildLayerInputs,
  correlationsForParameter,
  describe as describeStats,
  extractChannel,
  runCorrelations,
  samplesInRange,
} from '@geoflow/ground-model';
import type {
  ChannelKey,
  ChannelMeta,
  CorrelationResult,
  GroundModel,
  Layer,
  ParameterValue,
  Sample,
  SampleStats,
  UserDensityEntry,
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

  // Mean ground level — needed to convert layer RL → depth for correlations.
  const meanGL = useMemo(() => {
    const locaRows = file.groups['LOCA']?.rows ?? [];
    const idSet = new Set(model.group.locaIds);
    const gls: number[] = [];
    for (const r of locaRows) {
      const id = String(r['LOCA_ID'] ?? '').trim();
      if (!idSet.has(id)) continue;
      const gl = Number(r['LOCA_GL']);
      if (Number.isFinite(gl)) gls.push(gl);
    }
    if (gls.length === 0) return 0;
    return gls.reduce((a, x) => a + x, 0) / gls.length;
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

  const updateUserDensities = (next: UserDensityEntry[]) => {
    void onChange({ ...model, userDensities: next });
  };

  // Bundle channel samples filtered to the active layer's RL window so we
  // can compute correlations and surface them next to each parameter.
  const layerSamples = useMemo(() => {
    const inRange = (key: ChannelKey) => samplesInRange(allChannels.get(key) ?? [], layer.topRL, layer.baseRL);
    return {
      spt: inRange('spt_n'),
      mc: inRange('mc'),
      ll: inRange('ll'),
      pl: inRange('pl'),
      pi: inRange('pi'),
      bulkDensity: inRange('bulk_density'),
      dryDensity: inRange('dry_density'),
      cu: inRange('cu'),
    };
  }, [allChannels, layer.topRL, layer.baseRL]);

  // Fold user-entered density measurements that fall inside the layer into
  // the bulk density bundle so correlations pick them up.
  const userDensitiesInLayer = useMemo(() => {
    const list = model.userDensities ?? [];
    return list.filter((d) => d.rl <= Math.max(layer.topRL, layer.baseRL) && d.rl >= Math.min(layer.topRL, layer.baseRL));
  }, [model.userDensities, layer.topRL, layer.baseRL]);

  const correlations = useMemo<CorrelationResult[]>(() => {
    const family: 'granular' | 'cohesive' | 'unknown' = inferFamilyFromUnit(layer.unitKey, layer.description);
    // Fold user density entries into the bulkDensity / dryDensity arrays so
    // the inputs builder considers them.
    const augmentedBulk = [
      ...layerSamples.bulkDensity,
      ...userDensitiesInLayer
        .filter((d) => d.kind === 'bulk')
        .map((d) => ({ value: d.value, rl: d.rl, depth: 0, ref: { locaId: 'user', group: 'USER', rowIndex: -1 } as Sample['ref'] })),
    ];
    const augmentedDry = [
      ...layerSamples.dryDensity,
      ...userDensitiesInLayer
        .filter((d) => d.kind === 'dry')
        .map((d) => ({ value: d.value, rl: d.rl, depth: 0, ref: { locaId: 'user', group: 'USER', rowIndex: -1 } as Sample['ref'] })),
    ];
    const inputs = buildLayerInputs(
      {
        spt: layerSamples.spt,
        mc: layerSamples.mc,
        ll: layerSamples.ll,
        pl: layerSamples.pl,
        pi: layerSamples.pi,
        bulkDensity: augmentedBulk,
        dryDensity: augmentedDry,
        cu: layerSamples.cu,
      },
      {
        topRL: layer.topRL,
        baseRL: layer.baseRL,
        meanGL,
        family,
      },
    );
    return runCorrelations(inputs);
  }, [layer.topRL, layer.baseRL, layer.unitKey, layer.description, layerSamples, userDensitiesInLayer, meanGL]);

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

        <UserDensitiesCard
          layer={layer}
          entries={model.userDensities ?? []}
          onChange={updateUserDensities}
        />

        {layer.parameters.map((param) => {
          // Channels whose `parameterHint` matches this parameter come first;
          // every other channel is still selectable so the user has the full
          // evidence set if the AGS file uses non-standard groupings.
          const relevant = CHANNELS.filter((c) => c.parameterHint === param.key);
          const others = CHANNELS.filter((c) => c.parameterHint !== param.key);
          const channels = [...relevant, ...others];
          const paramCorrs = correlationsForParameter(correlations, param.key);
          return (
            <ParameterCard
              key={param.key}
              layer={layer}
              param={param}
              channels={channels}
              allSamples={allChannels}
              correlations={paramCorrs}
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
  correlations: ReadonlyArray<CorrelationResult>;
  onChange: (patch: Partial<ParameterValue>) => void;
}

function ParameterCard({ layer, param, channels, allSamples, correlations, onChange }: ParameterCardProps) {
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
      {correlations.length > 0 && (
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: 14, background: 'var(--surface-muted)',
        }}>
          <CorrelationsList correlations={correlations} onApply={(v) => onChange({ value: v })} />
        </div>
      )}
    </div>
  );
}

function CorrelationsList({ correlations, onApply }: {
  correlations: ReadonlyArray<CorrelationResult>;
  onApply: (value: number) => void;
}) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.5px', color: 'var(--muted)',
        }}>
          Correlations ({correlations.length})
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>
          click → adopt as chosen value
        </span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={corrTh}>Correlation</th>
            <th style={corrTh}>Source</th>
            <th style={{ ...corrTh, textAlign: 'right' }}>Min</th>
            <th style={{ ...corrTh, textAlign: 'right' }}>Estimate</th>
            <th style={{ ...corrTh, textAlign: 'right' }}>Max</th>
            <th style={corrTh}></th>
          </tr>
        </thead>
        <tbody>
          {correlations.map((c, i) => {
            const inputSummary = Object.entries(c.inputs)
              .filter(([, v]) => Number.isFinite(v) && v !== -1)
              .map(([k, v]) => `${k}=${Math.abs(v) < 0.01 ? v.toExponential(2) : Number(v).toPrecision(3)}`)
              .join(', ');
            return (
              <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={corrTd} title={c.caveat || inputSummary}>
                  <span style={{ fontWeight: 600 }}>{c.label}</span>
                  <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 11 }}>({c.units})</span>
                  {c.caveat && (
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontStyle: 'italic', marginTop: 2 }}>
                      {c.caveat}
                    </div>
                  )}
                  {inputSummary && (
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace', marginTop: 1 }}>
                      {inputSummary}
                    </div>
                  )}
                </td>
                <td style={{ ...corrTd, fontSize: 11, color: 'var(--muted)' }}>{c.source}</td>
                <td style={{ ...corrTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMaybe(c.min)}</td>
                <td style={{ ...corrTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtMaybe(c.representative)}</td>
                <td style={{ ...corrTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMaybe(c.max)}</td>
                <td style={corrTd}>
                  {c.representative !== undefined && (
                    <button
                      onClick={() => onApply(c.representative!)}
                      style={{
                        padding: '2px 8px', fontSize: 11, fontWeight: 600,
                        background: 'transparent', color: 'var(--accent)',
                        border: '1px solid var(--accent-border)', borderRadius: 4, cursor: 'pointer',
                      }}
                    >use</button>
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

function fmtMaybe(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs > 0 && (abs < 0.01 || abs >= 1e6)) return v.toExponential(2);
  return v.toFixed(abs < 10 ? 2 : 1);
}

const corrTh: React.CSSProperties = {
  padding: '5px 8px', textAlign: 'left', fontSize: 10, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--muted)',
  borderBottom: '1px solid var(--border)',
};
const corrTd: React.CSSProperties = {
  padding: '5px 8px', borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
};

function inferFamilyFromUnit(unitKey: string, desc: string): 'granular' | 'cohesive' | 'unknown' {
  const blob = `${unitKey} ${desc}`.toLowerCase();
  if (/clay|silt|peat|organic|ml|mh|ch|cl|lc|ck/.test(blob)) return 'cohesive';
  if (/sand|gravel|cobble|boulder|sa|sp|sw|gp|gr|gw|rx|rock/.test(blob)) return 'granular';
  return 'unknown';
}

// ── User-entered density values ─────────────────────────────────────────────

interface UserDensitiesCardProps {
  layer: Layer;
  entries: ReadonlyArray<UserDensityEntry>;
  onChange: (next: UserDensityEntry[]) => void;
}

function UserDensitiesCard({ layer, entries, onChange }: UserDensitiesCardProps) {
  const top = Math.max(layer.topRL, layer.baseRL);
  const base = Math.min(layer.topRL, layer.baseRL);
  const inLayer = entries.filter((e) => e.rl <= top && e.rl >= base);

  const update = (id: string, patch: Partial<UserDensityEntry>) => {
    onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };
  const remove = (id: string) => {
    onChange(entries.filter((e) => e.id !== id));
  };
  const add = () => {
    const mid = (top + base) / 2;
    onChange([
      ...entries,
      {
        id: crypto.randomUUID(),
        rl: Number(mid.toFixed(2)),
        value: 1.9,
        kind: 'bulk',
        units: 'Mg/m³',
        note: '',
      },
    ]);
  };

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface-muted)', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
          Densities — engineer input
        </span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          ({inLayer.length} in this layer · {entries.length} total)
        </span>
        <button
          onClick={add}
          style={{
            marginLeft: 'auto',
            padding: '4px 10px', fontSize: 11, fontWeight: 600,
            background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer',
          }}
        >+ Add density</button>
      </div>
      <div style={{ padding: 14 }}>
        {entries.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.55 }}>
            Add density measurements when the AGS file is missing RDEN rows,
            or to override a single dubious lab value. Entries feed into γ
            correlations alongside any RDEN samples.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={corrTh}>RL (mAOD)</th>
                <th style={corrTh}>Kind</th>
                <th style={{ ...corrTh, textAlign: 'right' }}>Value (Mg/m³)</th>
                <th style={corrTh}>Source / note</th>
                <th style={corrTh}>In layer?</th>
                <th style={corrTh}></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const within = e.rl <= top && e.rl >= base;
                return (
                  <tr key={e.id} style={{ background: within ? 'var(--accent-soft)' : 'transparent' }}>
                    <td style={corrTd}>
                      <input
                        type="number" step={0.1}
                        value={e.rl}
                        onChange={(ev) => update(e.id, { rl: Number(ev.target.value) })}
                        style={{ ...densityInput, width: 80 }}
                      />
                    </td>
                    <td style={corrTd}>
                      <select
                        value={e.kind}
                        onChange={(ev) => update(e.id, { kind: ev.target.value as 'bulk' | 'dry' })}
                        style={{ ...densityInput, width: 80 }}
                      >
                        <option value="bulk">bulk</option>
                        <option value="dry">dry</option>
                      </select>
                    </td>
                    <td style={{ ...corrTd, textAlign: 'right' }}>
                      <input
                        type="number" step={0.05}
                        value={e.value}
                        onChange={(ev) => update(e.id, { value: Number(ev.target.value) })}
                        style={{ ...densityInput, width: 90, textAlign: 'right' }}
                      />
                    </td>
                    <td style={corrTd}>
                      <input
                        type="text"
                        placeholder="e.g. Lab core 3, 2024-08"
                        value={e.note}
                        onChange={(ev) => update(e.id, { note: ev.target.value })}
                        style={{ ...densityInput, width: '100%' }}
                      />
                    </td>
                    <td style={corrTd}>
                      {within
                        ? <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent)' }}>yes</span>
                        : <span style={{ fontSize: 10, color: 'var(--muted)' }}>no</span>}
                    </td>
                    <td style={corrTd}>
                      <button
                        onClick={() => remove(e.id)}
                        style={{
                          padding: '2px 6px', fontSize: 11, fontWeight: 600,
                          background: 'transparent', color: 'var(--muted)',
                          border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
                        }}
                      >✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const densityInput: React.CSSProperties = {
  padding: '4px 8px', fontSize: 12, color: 'var(--text)',
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 4,
  outline: 'none',
};

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
