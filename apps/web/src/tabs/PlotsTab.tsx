import { useState, useMemo, useEffect } from 'react';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile } from '../core.js';
import {
  type ColorField, type PlotId,
  ALL_PLOTS, OPlot, PlotCard,
  getGeolLayers, getGeolFields, extractLocaMap, extractAllLocaIds,
  extractSptDepth, extractSptElev, extractAtterberg, extractPsd,
  extractDepth, extractUu, extractDensity, extractShear,
  extractCompaction, extractLlplDepth, extractCong,
  extractStressProfile, extractActivity, extractPermeability,
  extractDerivedSpt, extractStressPath,
  sptDepthSpec, sptElevSpec, plasticitySpec, psdSpec,
  depthScatterSpec, densitySpec, shearBoxSpec, compactionSpec,
  congSpec, atterbergDepthSpec,
  stressProfileSpec, activitySpec, permeabilitySpec,
  derivedSptSpec, stressPathSpec,
} from '../plots/shared.js';
import type { useLocationGroups } from '../location-groups.js';

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  fileBytes: Uint8Array | null;
  fileName?: string;
  locationGroups?: ReturnType<typeof useLocationGroups>;
}

// ── Main component ────────────────────────────────────────────────────────────

export function PlotsTab({ fileBytes, locationGroups }: Props) {
  const [colorField, setColorField] = useState<ColorField>('LOCA_ID');
  const [boreholeFilter, setBoreholeFilter] = useState<Set<string>>(new Set());
  const [activePlots, setActivePlots] = useState<Set<PlotId>>(new Set(ALL_PLOTS.map(p => p.id)));

  const agsFile = useMemo<AgsFile | null>(() => {
    if (!fileBytes) return null;
    try { return parseStr(decodeBytes(fileBytes)).file; } catch { return null; }
  }, [fileBytes]);

  const locaMap    = useMemo(() => agsFile ? extractLocaMap(agsFile) : new Map(), [agsFile]);
  const allLocas   = useMemo(() => agsFile ? extractAllLocaIds(agsFile) : [], [agsFile]);
  const layers     = useMemo(() => agsFile ? getGeolLayers(agsFile) : [], [agsFile]);
  const geolFields = useMemo(() => agsFile ? getGeolFields(agsFile) : ['LOCA_ID' as ColorField], [agsFile]);

  // When a location group is active, restrict every extractor to its members.
  // Manual borehole-filter checkboxes still narrow further within that set.
  const activeGroupId = locationGroups?.activeGroupId ?? null;
  const activeGroupSet = locationGroups?.activeLocaSet ?? new Set<string>();
  const bh = useMemo<Set<string>>(() => {
    if (activeGroupSet.size === 0) return boreholeFilter;
    if (boreholeFilter.size === 0) return activeGroupSet;
    const out = new Set<string>();
    for (const id of boreholeFilter) if (activeGroupSet.has(id)) out.add(id);
    return out;
  }, [boreholeFilter, activeGroupSet]);

  // Reset the per-tab manual filter whenever the active group switches —
  // otherwise prior selections may make no sense in the new group's context.
  useEffect(() => { setBoreholeFilter(new Set()); }, [activeGroupId]);

  const sptDepth   = useMemo(() => agsFile ? extractSptDepth(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);
  const sptElev    = useMemo(() => agsFile ? extractSptElev(agsFile, locaMap, layers, colorField, bh) : [], [agsFile, locaMap, layers, colorField, bh]);
  const atterberg  = useMemo(() => agsFile ? extractAtterberg(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);
  const psd        = useMemo(() => agsFile ? extractPsd(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);
  const llplDepth  = useMemo(() => agsFile ? extractLlplDepth(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);
  const moisture   = useMemo(() => agsFile ? extractDepth(agsFile, 'LNMC', 'LNMC_MC', 'SAMP_TOP', layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);
  const cu         = useMemo(() => agsFile ? extractUu(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);
  const density    = useMemo(() => agsFile ? extractDensity(agsFile, layers, colorField, bh) : { bulk: [], dry: [] }, [agsFile, layers, colorField, bh]);
  const shear      = useMemo(() => agsFile ? extractShear(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);
  const compaction = useMemo(() => agsFile ? extractCompaction(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);
  const cong       = useMemo(() => agsFile ? extractCong(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);

  // Advanced extractors
  const stressProf = useMemo(() => agsFile ? extractStressProfile(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);
  const activity   = useMemo(() => agsFile ? extractActivity(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);
  const perm       = useMemo(() => agsFile ? extractPermeability(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);
  const phiDepth   = useMemo(() => agsFile ? extractDerivedSpt(agsFile, layers, colorField, bh, 'phiPrime') : [], [agsFile, layers, colorField, bh]);
  const vsDepth    = useMemo(() => agsFile ? extractDerivedSpt(agsFile, layers, colorField, bh, 'VsImai')  : [], [agsFile, layers, colorField, bh]);
  const n1Depth    = useMemo(() => agsFile ? extractDerivedSpt(agsFile, layers, colorField, bh, 'N1_60')   : [], [agsFile, layers, colorField, bh]);
  const stressPath = useMemo(() => agsFile ? extractStressPath(agsFile, layers, colorField, bh) : [], [agsFile, layers, colorField, bh]);

  const specSptDepth    = useMemo(() => sptDepth.length   ? sptDepthSpec(sptDepth)                 : null, [sptDepth]);
  const specSptElev     = useMemo(() => sptElev.length    ? sptElevSpec(sptElev)                   : null, [sptElev]);
  const specAtterberg   = useMemo(() => atterberg.length  ? plasticitySpec(atterberg)              : null, [atterberg]);
  const specPsd         = useMemo(() => psd.length        ? psdSpec(psd)                           : null, [psd]);
  const specLimitsDepth = useMemo(() => llplDepth.length  ? atterbergDepthSpec(llplDepth, moisture) : null, [llplDepth, moisture]);
  const specMoisture    = useMemo(() => moisture.length   ? depthScatterSpec(moisture, 'Moisture content w (%)', [0, 100]) : null, [moisture]);
  const specCu          = useMemo(() => cu.length         ? depthScatterSpec(cu, 'Undrained shear strength Cu (kPa)') : null, [cu]);
  const specDensity     = useMemo(() => (density.bulk.length + density.dry.length) ? densitySpec(density.bulk, density.dry) : null, [density]);
  const specShear       = useMemo(() => shear.length      ? shearBoxSpec(shear)                    : null, [shear]);
  const specCompaction  = useMemo(() => compaction.length ? compactionSpec(compaction)             : null, [compaction]);
  const specCong        = useMemo(() => cong.length       ? congSpec(cong)                         : null, [cong]);

  const specStressProf  = useMemo(() => stressProf.length ? stressProfileSpec(stressProf)          : null, [stressProf]);
  const specActivity    = useMemo(() => activity.length   ? activitySpec(activity)                 : null, [activity]);
  const specPerm        = useMemo(() => perm.length       ? permeabilitySpec(perm)                 : null, [perm]);
  const specPhiDepth    = useMemo(() => phiDepth.length   ? derivedSptSpec(phiDepth, 'phiPrime')   : null, [phiDepth]);
  const specVsDepth     = useMemo(() => vsDepth.length    ? derivedSptSpec(vsDepth, 'VsImai')      : null, [vsDepth]);
  const specN1Depth     = useMemo(() => n1Depth.length    ? derivedSptSpec(n1Depth, 'N1_60')       : null, [n1Depth]);
  const specStressPath  = useMemo(() => stressPath.length ? stressPathSpec(stressPath)             : null, [stressPath]);

  const dataN: Record<PlotId, number> = {
    spt_depth: sptDepth.length, spt_elev: sptElev.length, plasticity: atterberg.length,
    psd: psd.length, limits_depth: llplDepth.length, moisture: moisture.length, cu: cu.length,
    density: density.bulk.length + density.dry.length,
    shear: shear.length, compaction: compaction.length, cong: cong.length,
    stress_prof: stressProf.length, activity: activity.length, permeability: perm.length,
    phi_depth: phiDepth.length, vs_depth: vsDepth.length, n1_depth: n1Depth.length,
    stress_path: stressPath.length,
  };

  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
        Drop an AGS file above to generate engineering plots.
      </div>
    );
  }

  if (!agsFile) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--red)' }}>
        Failed to parse the AGS file.
      </div>
    );
  }

  const LABEL_STYLE: React.CSSProperties = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6, display: 'block' };

  const toggleBorehole = (id: string) => {
    setBoreholeFilter(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const togglePlot = (id: PlotId) => {
    setActivePlots(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ display: 'flex', gap: 0, minHeight: '70vh' }}>

      {/* ── Sidebar ── */}
      <aside style={{ width: 230, flexShrink: 0, borderRight: '1px solid var(--border)', padding: '16px 14px', overflowY: 'auto', background: 'var(--surface-muted)', display: 'flex', flexDirection: 'column', gap: 20 }}>

        <div>
          <span style={LABEL_STYLE}>Colour by</span>
          <select
            value={colorField}
            onChange={e => setColorField(e.target.value as ColorField)}
            style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}
          >
            <option value="LOCA_ID">Borehole (LOCA_ID)</option>
            {geolFields.includes('GEOL_GEOL') && <option value="GEOL_GEOL">Geology code (GEOL_GEOL)</option>}
            {geolFields.includes('GEOL_DESC') && <option value="GEOL_DESC">Description (GEOL_DESC)</option>}
            {geolFields.includes('GEOL_LEG')  && <option value="GEOL_LEG">Legend (GEOL_LEG)</option>}
          </select>
        </div>

        {locationGroups && locationGroups.groups.length > 0 && (
          <div>
            <span style={LABEL_STYLE}>Location group</span>
            <select
              value={activeGroupId ?? ''}
              onChange={e => locationGroups.setActiveGroupId(e.target.value || null)}
              style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}
            >
              <option value="">— All boreholes —</option>
              {locationGroups.groups.map(g => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.locaIds.length})
                </option>
              ))}
            </select>
            {locationGroups.activeGroup && (
              <div style={{ marginTop: 4, fontSize: 10, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: locationGroups.activeGroup.color, display: 'inline-block' }} />
                Filtering to {locationGroups.activeGroup.locaIds.length} borehole{locationGroups.activeGroup.locaIds.length === 1 ? '' : 's'}
              </div>
            )}
          </div>
        )}

        {(() => {
          const visibleLocas = activeGroupSet.size > 0
            ? allLocas.filter((id) => activeGroupSet.has(id))
            : allLocas;
          if (visibleLocas.length === 0 || visibleLocas.length > 30) return null;
          return (
            <div>
              <span style={LABEL_STYLE}>Filter boreholes</span>
              <button
                onClick={() => setBoreholeFilter(new Set())}
                style={{ width: '100%', marginBottom: 6, padding: '5px 8px', background: 'var(--border)', color: 'var(--text)', fontSize: 11, borderRadius: 5, cursor: 'pointer', border: 'none' }}
              >
                Show all ({visibleLocas.length})
              </button>
              <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {visibleLocas.map(id => (
                  <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0', cursor: 'pointer', fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={boreholeFilter.size === 0 || boreholeFilter.has(id)}
                      onChange={() => toggleBorehole(id)}
                      style={{ flexShrink: 0 }}
                    />
                    <span style={{ fontFamily: 'monospace', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{id}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })()}

        <div>
          <span style={LABEL_STYLE}>Visible plots</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {ALL_PLOTS.map(p => {
              const n = dataN[p.id];
              return (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0', cursor: n > 0 ? 'pointer' : 'default', fontSize: 12, opacity: n === 0 ? 0.4 : 1 }}>
                  <input
                    type="checkbox"
                    checked={activePlots.has(p.id)}
                    onChange={() => n > 0 && togglePlot(p.id)}
                    disabled={n === 0}
                    style={{ flexShrink: 0 }}
                  />
                  <span>{p.label}</span>
                  {n > 0 && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{n}</span>}
                </label>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: 'auto', fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
          <div style={{ fontWeight: 700, marginBottom: 3 }}>Colour legend</div>
          Geology colours follow BS&nbsp;5930. Hash-based colours are used for unknown codes.
        </div>
      </aside>

      {/* ── Chart grid ── */}
      <main style={{ flex: 1, padding: '16px 20px', overflowY: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(480px, 1fr))', gap: 18 }}>

          {activePlots.has('spt_depth') && (
            <PlotCard title="SPT N-value vs Depth" n={dataN.spt_depth}>
              {specSptDepth && <OPlot key="spt_depth" spec={specSptDepth} />}
            </PlotCard>
          )}

          {activePlots.has('spt_elev') && (
            <PlotCard title="SPT N-value vs Level (mOD)" n={dataN.spt_elev}>
              {dataN.spt_elev === 0
                ? null
                : specSptElev
                  ? <OPlot key="spt_elev" spec={specSptElev} />
                  : <div style={{ padding: '20px 16px', color: 'var(--muted)', fontSize: 13 }}>Ground level (LOCA_GL) not present — cannot compute elevation.</div>
              }
            </PlotCard>
          )}

          {activePlots.has('plasticity') && (
            <PlotCard title="Plasticity Chart — A-line" n={dataN.plasticity}>
              {specAtterberg && <OPlot key="plasticity" spec={specAtterberg} />}
            </PlotCard>
          )}

          {activePlots.has('psd') && (
            <PlotCard title="Grading / Particle Size Distribution" n={dataN.psd}>
              {specPsd && <OPlot key="psd" spec={specPsd} />}
            </PlotCard>
          )}

          {activePlots.has('limits_depth') && (
            <PlotCard title="PL / LL / MC vs Depth  (□ PL — ■ LL  ● MC)" n={dataN.limits_depth}>
              {specLimitsDepth && <OPlot key="limits_depth" spec={specLimitsDepth} />}
            </PlotCard>
          )}

          {activePlots.has('moisture') && (
            <PlotCard title="Moisture Content vs Depth" n={dataN.moisture}>
              {specMoisture && <OPlot key="moisture" spec={specMoisture} />}
            </PlotCard>
          )}

          {activePlots.has('cu') && (
            <PlotCard title="Undrained Shear Strength vs Depth" n={dataN.cu}>
              {specCu && <OPlot key="cu" spec={specCu} />}
            </PlotCard>
          )}

          {activePlots.has('density') && (
            <PlotCard title="Density vs Depth (bulk ● / dry ◆)" n={dataN.density}>
              {specDensity && <OPlot key="density" spec={specDensity} />}
            </PlotCard>
          )}

          {activePlots.has('shear') && (
            <PlotCard title="Shear Box — Mohr-Coulomb Envelope" n={dataN.shear}>
              {specShear && <OPlot key="shear" spec={specShear} />}
            </PlotCard>
          )}

          {activePlots.has('compaction') && (
            <PlotCard title="Compaction Curves" n={dataN.compaction}>
              {specCompaction && <OPlot key="compaction" spec={specCompaction} />}
            </PlotCard>
          )}

          {activePlots.has('cong') && (
            <PlotCard title="Consolidation — e–log σ'v" n={dataN.cong}>
              {specCong && <OPlot key="cong" spec={specCong} />}
            </PlotCard>
          )}

          {activePlots.has('stress_prof') && (
            <PlotCard title="Effective Stress Profile  (σv solid, u₀ dashed, σ'v coloured)" n={dataN.stress_prof}>
              {specStressProf && <OPlot key="stress_prof" spec={specStressProf} />}
            </PlotCard>
          )}

          {activePlots.has('activity') && (
            <PlotCard title="Activity Chart — Skempton (PI vs clay fraction)" n={dataN.activity}>
              {dataN.activity === 0
                ? null
                : specActivity
                  ? <OPlot key="activity" spec={specActivity} />
                  : <div style={{ padding: '20px 16px', color: 'var(--muted)', fontSize: 13 }}>Needs LLPL + PSD with a 2 μm fraction.</div>
              }
            </PlotCard>
          )}

          {activePlots.has('permeability') && (
            <PlotCard title="Permeability vs Depth (log scale)" n={dataN.permeability}>
              {specPerm && <OPlot key="permeability" spec={specPerm} />}
            </PlotCard>
          )}

          {activePlots.has('phi_depth') && (
            <PlotCard title="Derived ϕ′ vs Depth  (Hatanaka–Uchida 1996)" n={dataN.phi_depth}>
              {specPhiDepth && <OPlot key="phi_depth" spec={specPhiDepth} />}
            </PlotCard>
          )}

          {activePlots.has('vs_depth') && (
            <PlotCard title="Derived Vs vs Depth  (Imai 1981)" n={dataN.vs_depth}>
              {specVsDepth && <OPlot key="vs_depth" spec={specVsDepth} />}
            </PlotCard>
          )}

          {activePlots.has('n1_depth') && (
            <PlotCard title="N₁,₆₀ vs Depth  (Liao–Whitman 1986)" n={dataN.n1_depth}>
              {specN1Depth && <OPlot key="n1_depth" spec={specN1Depth} />}
            </PlotCard>
          )}

          {activePlots.has('stress_path') && (
            <PlotCard title="Triaxial Stress Paths — p′ vs q (with Kf-lines)" n={dataN.stress_path}>
              {specStressPath && <OPlot key="stress_path" spec={specStressPath} />}
            </PlotCard>
          )}

        </div>

        {ALL_PLOTS.every(p => dataN[p.id] === 0) && (
          <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
            <p style={{ fontWeight: 600, marginBottom: 8 }}>No plottable data found</p>
            <p style={{ fontSize: 13 }}>This file does not contain any of the supported groups:<br />ISPT, LLPL, GRAG, SIEV, LNMC, TCON, VANE, TNPC, RDEN, SHBX, CMPN, CONG, PERM, IRDX, IPRM, TRIG, GEOL, WSTK</p>
          </div>
        )}
      </main>
    </div>
  );
}
