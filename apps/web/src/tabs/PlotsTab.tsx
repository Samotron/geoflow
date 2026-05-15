import { useState, useMemo } from 'react';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile } from '../core.js';
import {
  type ColorField, type PlotId,
  ALL_PLOTS, OPlot, PlotCard,
  getGeolLayers, getGeolFields, extractLocaMap, extractAllLocaIds,
  extractSptDepth, extractSptElev, extractAtterberg, extractPsd,
  extractDepth, extractUu, extractDensity, extractShear,
  extractCompaction, extractLlplDepth, extractCong,
  sptDepthSpec, sptElevSpec, plasticitySpec, psdSpec,
  depthScatterSpec, densitySpec, shearBoxSpec, compactionSpec,
  congSpec, atterbergDepthSpec,
} from '../plots/shared.js';

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props { fileBytes: Uint8Array | null; fileName?: string; }

// ── Main component ────────────────────────────────────────────────────────────

export function PlotsTab({ fileBytes }: Props) {
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
  const bh = boreholeFilter;

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

  const specMap: Record<PlotId, ReturnType<typeof sptDepthSpec> | null> = {
    spt_depth: specSptDepth, spt_elev: specSptElev, plasticity: specAtterberg,
    psd: specPsd, limits_depth: specLimitsDepth, moisture: specMoisture,
    cu: specCu, density: specDensity, shear: specShear, compaction: specCompaction, cong: specCong,
  };

  const dataN: Record<PlotId, number> = {
    spt_depth: sptDepth.length, spt_elev: sptElev.length, plasticity: atterberg.length,
    psd: psd.length, limits_depth: llplDepth.length, moisture: moisture.length, cu: cu.length,
    density: density.bulk.length + density.dry.length,
    shear: shear.length, compaction: compaction.length, cong: cong.length,
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
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const togglePlot = (id: PlotId) => {
    setActivePlots(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div style={{ display: 'flex', gap: 0, minHeight: '70vh' }}>

      {/* ── Sidebar ── */}
      <aside style={{ width: 230, flexShrink: 0, borderRight: '1px solid var(--border)', padding: '16px 14px', overflowY: 'auto', background: '#fafbfc', display: 'flex', flexDirection: 'column', gap: 20 }}>

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

        {allLocas.length > 0 && allLocas.length <= 30 && (
          <div>
            <span style={LABEL_STYLE}>Filter boreholes</span>
            <button
              onClick={() => setBoreholeFilter(new Set())}
              style={{ width: '100%', marginBottom: 6, padding: '5px 8px', background: '#e2e8f0', color: 'var(--text)', fontSize: 11, borderRadius: 5, cursor: 'pointer', border: 'none' }}
            >
              Show all ({allLocas.length})
            </button>
            <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {allLocas.map(id => (
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
        )}

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

        </div>

        {ALL_PLOTS.every(p => dataN[p.id] === 0) && (
          <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
            <p style={{ fontWeight: 600, marginBottom: 8 }}>No plottable data found</p>
            <p style={{ fontSize: 13 }}>This file does not contain any of the supported groups:<br />ISPT, LLPL, GRAG, SIEV, LNMC, TCON, VANE, RDEN, SHBX, CMPN, CONG</p>
          </div>
        )}
      </main>
    </div>
  );
}
