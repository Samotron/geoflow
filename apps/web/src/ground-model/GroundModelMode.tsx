/**
 * GroundModelMode — top-level shell for the Ground Models mode of GeoFlow.
 *
 * Drives the four-step workflow:
 *   1. Pick a model (or create one), defining a group of LOCA_IDs.
 *   2. Edit the layer skeleton in RL, accepting/refining suggestions.
 *   3. Per-layer parameter selection, with plots & stats per channel.
 *   4. Export the model as an AGSi JSON file.
 *
 * Renders a "no file loaded" pane when there's no AGS file, mirroring the
 * Data mode's behaviour. The mode is always informed by whatever Data
 * mode currently has loaded — it does not own its own ingest path.
 */

import { useMemo, useState, useCallback } from 'react';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile } from '../core.js';
import { useGroundModels } from './state.js';
import { GroupsStep } from './GroupsStep.js';
import { LayersStep } from './LayersStep.js';
import { ParametersStep } from './ParametersStep.js';
import { ExportStep } from './ExportStep.js';
import type { GroundModel } from '@geoflow/ground-model';

type StepId = 'groups' | 'layers' | 'parameters' | 'export';

const STEPS: ReadonlyArray<{ id: StepId; label: string; hint: string }> = [
  { id: 'groups',     label: 'Groups',     hint: 'Pick the boreholes that inform the model' },
  { id: 'layers',     label: 'Layers',     hint: 'Set layer boundaries in RL' },
  { id: 'parameters', label: 'Parameters', hint: 'Choose values per layer with plots & stats' },
  { id: 'export',     label: 'Export',     hint: 'Download the model as AGSi JSON' },
];

interface GroundModelModeProps {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
  projectId: string | null;
}

export function GroundModelMode({ fileBytes, fileName, projectId }: GroundModelModeProps) {
  const file: AgsFile | null = useMemo(() => {
    if (!fileBytes) return null;
    try {
      return parseStr(decodeBytes(fileBytes)).file;
    } catch {
      return null;
    }
  }, [fileBytes]);

  const { models, save, remove } = useGroundModels(projectId);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [step, setStep] = useState<StepId>('groups');

  const active = useMemo(() => models.find((m) => m.id === activeId) ?? null, [models, activeId]);

  const updateActive = useCallback(async (next: GroundModel) => {
    const stamped = { ...next, updatedAt: Date.now() };
    await save(stamped);
    setActiveId(stamped.id);
  }, [save]);

  if (!file) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
          Load an AGS file in Data mode first
        </h2>
        <p style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 480, margin: '0 auto' }}>
          Ground Models are derived from the borehole data currently loaded. Drop an
          AGS file in the sidebar, then switch back to Ground Models mode.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16, alignItems: 'start' }}>
      {/* ── Left rail: models list + step nav ─────────────────────────── */}
      <aside style={{
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', padding: 12, position: 'sticky', top: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--muted)' }}>
            Models
          </span>
          <button
            onClick={() => {
              const id = crypto.randomUUID();
              const now = Date.now();
              void updateActive({
                id,
                name: `Model ${models.length + 1}`,
                description: '',
                group: { id: crypto.randomUUID(), name: 'Untitled group', locaIds: [] },
                layers: [],
                sampleStep: 0.25,
                createdAt: now,
                updatedAt: now,
              });
              setStep('groups');
            }}
            style={btnPrimary}
          >+ New</button>
        </div>
        {models.length === 0 && (
          <div style={{ padding: '14px 8px', fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
            No ground models yet
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {models.map((m) => {
            const isActive = m.id === activeId;
            return (
              <div
                key={m.id}
                onClick={() => setActiveId(m.id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                  background: isActive ? 'var(--accent-soft)' : 'transparent',
                  border: isActive ? '1px solid var(--accent-border)' : '1px solid transparent',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: isActive ? 'var(--accent)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {m.group.locaIds.length} loca{m.group.locaIds.length === 1 ? '' : 's'} · {m.layers.length} layer{m.layers.length === 1 ? '' : 's'}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete "${m.name}"?`)) {
                      void remove(m.id);
                      if (activeId === m.id) setActiveId(null);
                    }
                  }}
                  title="Delete"
                  style={btnIconSubtle}
                >✕</button>
              </div>
            );
          })}
        </div>

        {active && (
          <>
            <div style={{ marginTop: 16, marginBottom: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--muted)' }}>
              Workflow
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {STEPS.map((s, i) => {
                const isStep = s.id === step;
                return (
                  <div
                    key={s.id}
                    onClick={() => setStep(s.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                      background: isStep ? 'var(--accent-soft)' : 'transparent',
                      border: isStep ? '1px solid var(--accent-border)' : '1px solid transparent',
                      color: isStep ? 'var(--accent)' : 'var(--text)',
                    }}
                  >
                    <span style={{
                      width: 18, height: 18, borderRadius: 9, fontSize: 11, fontWeight: 700,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background: isStep ? 'var(--accent)' : 'var(--surface-muted)',
                      color: isStep ? '#fff' : 'var(--muted)',
                    }}>{i + 1}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{s.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.hint}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </aside>

      {/* ── Right pane: active step ───────────────────────────────────── */}
      <section style={{ minWidth: 0 }}>
        {!active && (
          <div style={{
            background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '32px 24px', textAlign: 'center',
          }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8, color: 'var(--text)' }}>
              Build a 1D ground model
            </h2>
            <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 540, margin: '0 auto', lineHeight: 1.6 }}>
              Group a set of boreholes, refine the layer skeleton suggested from the GEOL
              data, then pick design parameters per layer using plots and statistics from
              the contributing samples. Models are exported as AGSi JSON ({fileName ?? 'file'}).
            </p>
          </div>
        )}
        {active && step === 'groups' && (
          <GroupsStep
            file={file}
            model={active}
            onChange={updateActive}
            onNext={() => setStep('layers')}
          />
        )}
        {active && step === 'layers' && (
          <LayersStep
            file={file}
            model={active}
            onChange={updateActive}
            onNext={() => setStep('parameters')}
          />
        )}
        {active && step === 'parameters' && (
          <ParametersStep
            file={file}
            model={active}
            onChange={updateActive}
            onNext={() => setStep('export')}
          />
        )}
        {active && step === 'export' && (
          <ExportStep model={active} />
        )}
      </section>
    </div>
  );
}

const btnPrimary: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 600,
  background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
};

const btnIconSubtle: React.CSSProperties = {
  padding: '2px 6px', fontSize: 12, fontWeight: 600,
  background: 'transparent', color: 'var(--muted)', border: 'none', cursor: 'pointer',
};
