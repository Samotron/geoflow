/**
 * LineageModal — full-screen provenance view for a single voxel cell.
 *
 * Three-column layout:
 *   LEFT  — summary card: coordinates, value, geology, certainty meter
 *   CENTRE — plan-view SVG: cell + contributing boreholes in 2-D, sized by weight
 *   RIGHT  — weight chart + explicit computation formula + depth-window note
 *
 * Triggered by "Full Lineage" button in the VoxelTab right panel.
 */

import { useMemo, useCallback } from 'react';
import type { VoxelCellLineage, VoxelGrid, Geo3DModel } from '../core.js';
import { geolColor } from '../core.js';

// ── Borehole colour palette (matches the plan-view circles) ───────────────────

const BH_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6',
  '#6366f1', '#a855f7', '#e11d48', '#0ea5e9',
];

// ── Plan-view SVG builder ─────────────────────────────────────────────────────

function buildPlanSvg(lineage: VoxelCellLineage, model: Geo3DModel): string {
  const W = 300, H = 300;
  const CX = W / 2, CY = H / 2;
  const PAD = 32;

  const bhMap = new Map(model.boreholes.map(bh => [bh.id, bh]));

  type BhPoint = {
    id: string; relX: number; relY: number;
    distH: number; weight: number;
    value: number | null; category: string | null;
    color: string;
  };

  const bhs: BhPoint[] = lineage.contributors
    .map((c, i) => {
      const bh = bhMap.get(c.boreholeId);
      if (!bh) return null;
      return {
        id: c.boreholeId,
        relX: bh.x - lineage.cx,
        relY: bh.y - lineage.cy,
        distH: c.distH,
        weight: c.weight,
        value: c.value,
        category: c.category,
        color: BH_COLORS[i % BH_COLORS.length]!,
      };
    })
    .filter((b): b is BhPoint => b !== null);

  const maxDist = Math.max(...bhs.map(b => b.distH), 1) * 1.2;
  const scale   = (Math.min(W, H) / 2 - PAD) / maxDist;

  const L: string[] = [];
  L.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`);
  L.push(`<rect width="${W}" height="${H}" fill="#0f172a" rx="8"/>`);

  // Distance rings
  for (let i = 1; i <= 3; i++) {
    const d = (maxDist / 3) * i;
    const r = d * scale;
    L.push(`<circle cx="${CX}" cy="${CY}" r="${r.toFixed(1)}" fill="none" stroke="#1e3a5f" stroke-width="0.8" stroke-dasharray="4,3"/>`);
    if (i < 3) {
      L.push(`<text x="${(CX + r + 3).toFixed(1)}" y="${(CY - 2).toFixed(1)}" font-size="8" fill="#334155">${d.toFixed(0)}m</text>`);
    }
  }

  // Axis lines
  L.push(`<line x1="10" y1="${CY}" x2="${W - 10}" y2="${CY}" stroke="#1e293b" stroke-width="0.6"/>`);
  L.push(`<line x1="${CX}" y1="10" x2="${CX}" y2="${H - 10}" stroke="#1e293b" stroke-width="0.6"/>`);

  // Dotted lines from cell to each borehole
  for (const bh of bhs) {
    const sx = CX + bh.relX * scale;
    const sy = CY - bh.relY * scale;
    L.push(`<line x1="${CX}" y1="${CY}" x2="${sx.toFixed(1)}" y2="${sy.toFixed(1)}" stroke="${bh.color}" stroke-width="0.7" stroke-dasharray="3,2" opacity="0.45"/>`);
  }

  // Boreholes (circles, sized by weight)
  for (const bh of bhs) {
    const sx = CX + bh.relX * scale;
    const sy = CY - bh.relY * scale;
    const r  = Math.max(6, Math.min(20, bh.weight * 50));
    L.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${r.toFixed(1)}" fill="${bh.color}" opacity="0.82" stroke="${bh.color}" stroke-width="1"/>`);
    // Weight % inside circle if large enough
    if (r > 10) {
      L.push(`<text x="${sx.toFixed(1)}" y="${(sy + 3).toFixed(1)}" font-size="8" fill="#fff" text-anchor="middle" font-weight="700">${Math.round(bh.weight * 100)}%</text>`);
    }
    // BH ID label above
    L.push(`<text x="${sx.toFixed(1)}" y="${(sy - r - 4).toFixed(1)}" font-size="9" fill="${bh.color}" text-anchor="middle" font-weight="600">${bh.id}</text>`);
  }

  // Cell position: bright diamond
  const S = 9;
  L.push(`<polygon points="${CX},${CY - S} ${CX + S * 0.65},${CY} ${CX},${CY + S} ${CX - S * 0.65},${CY}" fill="#facc15" stroke="#0f172a" stroke-width="1.8"/>`);
  L.push(`<text x="${CX}" y="${(CY + S + 13).toFixed(1)}" font-size="8" fill="#facc15" text-anchor="middle">(${lineage.ix},${lineage.iy},${lineage.iz})</text>`);

  // North indicator
  const nx = W - 18, ny = H - 12;
  L.push(`<line x1="${nx}" y1="${ny - 2}" x2="${nx}" y2="${ny - 16}" stroke="#64748b" stroke-width="1.5"/>`);
  L.push(`<polygon points="${nx},${ny - 18} ${nx - 3},${ny - 13} ${nx + 3},${ny - 13}" fill="#64748b"/>`);
  L.push(`<text x="${nx}" y="${ny + 2}" font-size="8" fill="#64748b" text-anchor="middle">N</text>`);

  // Scale bar (bottom left)
  const sbDist = (maxDist / 3).toFixed(0);
  const sbPx   = (maxDist / 3) * scale;
  L.push(`<line x1="10" y1="${H - 12}" x2="${(10 + sbPx).toFixed(1)}" y2="${H - 12}" stroke="#475569" stroke-width="1.5"/>`);
  L.push(`<text x="${(10 + sbPx / 2).toFixed(1)}" y="${H - 2}" font-size="8" fill="#475569" text-anchor="middle">${sbDist}m</text>`);

  L.push(`</svg>`);
  return L.join('\n');
}

// ── Weight chart SVG ──────────────────────────────────────────────────────────

function buildWeightChart(lineage: VoxelCellLineage, grid: VoxelGrid): string {
  const W = 280;
  const ROW_H = 28;
  const LABEL_W = 64;
  const BAR_W   = 140;
  const VAL_X   = LABEL_W + BAR_W + 6;
  const PAD_X   = 8;
  const PAD_Y   = 4;
  const n = lineage.contributors.length;
  if (n === 0) return '';

  const H = PAD_Y * 2 + ROW_H * n;
  const unit = grid.property.unit;

  const L: string[] = [];
  L.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`);
  L.push(`<rect width="${W}" height="${H}" fill="transparent"/>`);

  for (let i = 0; i < n; i++) {
    const c = lineage.contributors[i]!;
    const y = PAD_Y + i * ROW_H;
    const bw = c.weight * BAR_W;
    const col = BH_COLORS[i % BH_COLORS.length]!;
    const valTxt = c.value !== null
      ? `${c.value.toFixed(2)}${unit ? ' ' + unit : ''}`
      : (c.category ?? '—');

    // BH label
    L.push(`<text x="${PAD_X}" y="${y + 18}" font-size="11" fill="#e2e8f0" font-weight="700">${c.boreholeId}</text>`);

    // Bar background
    L.push(`<rect x="${LABEL_W}" y="${y + 4}" width="${BAR_W}" height="18" rx="3" fill="#1e293b"/>`);
    // Weight bar
    L.push(`<rect x="${LABEL_W}" y="${y + 4}" width="${bw.toFixed(1)}" height="18" rx="3" fill="${col}" opacity="0.85"/>`);
    // Weight % inside bar
    if (bw > 24) {
      L.push(`<text x="${(LABEL_W + bw / 2).toFixed(1)}" y="${y + 17}" font-size="9" fill="#fff" text-anchor="middle" font-weight="700">${Math.round(c.weight * 100)}%</text>`);
    }

    // Value + dist
    L.push(`<text x="${VAL_X}" y="${y + 13}" font-size="10" fill="#94a3b8">${valTxt}</text>`);
    L.push(`<text x="${VAL_X}" y="${y + 24}" font-size="9" fill="#475569">${c.distH.toFixed(0)}m</text>`);
  }

  L.push(`</svg>`);
  return L.join('\n');
}

// ── Computation formula (IDW) ──────────────────────────────────────────────────

function buildFormula(lineage: VoxelCellLineage, grid: VoxelGrid): React.ReactNode {
  const unit = grid.property.unit ? ` ${grid.property.unit}` : '';

  if (lineage.method === 'rbf') {
    return (
      <div style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 1.7, color: '#94a3b8' }}>
        <div style={{ color: '#7dd3fc', fontWeight: 700, marginBottom: 6 }}>3-D RBF (polyharmonic r³)</div>
        <div>f(x,y,z) = a₀ + a₁x + a₂y + a₃z</div>
        <div style={{ paddingLeft: 12 }}>+ Σ wᵢ · r³(‖p − pᵢ‖)</div>
        <div style={{ marginTop: 8, borderTop: '1px solid #1e3a5f', paddingTop: 6 }}>
          <div>Regularisation λ = <span style={{ color: '#e2e8f0' }}>{(grid as { lambda?: number }).lambda ?? 0}</span></div>
          <div>Nearest obs. = <span style={{ color: '#e2e8f0' }}>{lineage.nearestObsDistH?.toFixed(1) ?? '—'} m</span></div>
          <div>Certainty = <span style={{ color: '#e2e8f0' }}>{Math.round(lineage.confidence * 100)}%</span></div>
        </div>
        <div style={{ marginTop: 8, color: '#64748b', fontSize: 10 }}>
          RBF is a global solve — all observations contribute everywhere.
          Confidence = 1 − (dist_to_nearest / 1.5 × char_spacing)
        </div>
      </div>
    );
  }

  // IDW: explicit weighted sum
  const contribs = lineage.contributors.filter(c => c.value !== null);
  if (contribs.length === 0) {
    return <span style={{ color: '#64748b', fontSize: 12 }}>No contributing observations in depth window.</span>;
  }
  const sum = contribs.reduce((s, c) => s + (c.value ?? 0) * c.weight, 0);

  return (
    <div style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 1.8, color: '#94a3b8' }}>
      <div style={{ color: '#7dd3fc', fontWeight: 700, marginBottom: 6 }}>IDW weighted sum</div>
      <div style={{ borderTop: '1px solid #1e3a5f', paddingTop: 6 }}>
        {contribs.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
            <span style={{ color: BH_COLORS[i % BH_COLORS.length], width: 52, flexShrink: 0 }}>{c.boreholeId}</span>
            <span style={{ color: '#e2e8f0', width: 56, textAlign: 'right', flexShrink: 0 }}>{c.value!.toFixed(3)}</span>
            <span style={{ color: '#475569' }}> × </span>
            <span style={{ color: '#e2e8f0', width: 48, flexShrink: 0 }}>{c.weight.toFixed(3)}</span>
            <span style={{ color: '#475569' }}>=</span>
            <span style={{ color: '#cbd5e1' }}>{(c.value! * c.weight).toFixed(3)}{unit}</span>
          </div>
        ))}
      </div>
      <div style={{
        borderTop: '1px solid #334155', marginTop: 4, paddingTop: 6,
        display: 'flex', gap: 6, alignItems: 'baseline',
      }}>
        <span style={{ width: 52 + 56 + 12, flexShrink: 0 }}></span>
        <span style={{ color: '#7dd3fc', fontWeight: 700, fontSize: 12 }}>
          Result = {sum.toFixed(3)}{unit}
        </span>
      </div>
      {lineage.value !== null && Math.abs(lineage.value - sum) > 0.001 && (
        <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
          (stored: {lineage.value.toFixed(3)}{unit} — rounding differs)
        </div>
      )}
    </div>
  );
}

// ── Style helpers ─────────────────────────────────────────────────────────────

const CARD: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid #1e3a5f',
  borderRadius: 8,
  padding: '14px 16px',
  marginBottom: 10,
};

const KV: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  fontSize: 12, borderBottom: '1px solid #1e3a5f', padding: '4px 0',
};

const HEAD: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.5px', color: '#475569', display: 'block', marginBottom: 8,
};

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  lineage: VoxelCellLineage;
  model: Geo3DModel;
  grid: VoxelGrid;
  onClose: () => void;
}

export function LineageModal({ lineage, model, grid, onClose }: Props) {
  const planSvg    = useMemo(() => buildPlanSvg(lineage, model), [lineage, model]);
  const weightSvg  = useMemo(() => buildWeightChart(lineage, grid), [lineage, grid]);
  const formula    = useMemo(() => buildFormula(lineage, grid), [lineage, grid]);

  const geoColor   = lineage.geolUnit ? geolColor(lineage.geolUnit) : '#64748b';
  const unit       = grid.property.unit ? ` ${grid.property.unit}` : '';
  const displayVal = lineage.value !== null
    ? `${lineage.value.toFixed(3)}${unit}`
    : (lineage.category ?? '—');

  const copyJson = useCallback(() => {
    navigator.clipboard.writeText(JSON.stringify(lineage, null, 2)).catch(() => {});
  }, [lineage]);

  // Close on backdrop click
  const onBackdrop = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  return (
    <div
      onClick={onBackdrop}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.72)',
        zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div style={{
        background: '#0d1627',
        border: '1px solid #1e3a5f',
        borderRadius: 14,
        width: 'min(96vw, 980px)',
        maxHeight: '92vh',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
      }}>

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px 12px',
          borderBottom: '1px solid #1e3a5f',
          flexShrink: 0,
        }}>
          <div>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9' }}>
              Cell Lineage
            </span>
            <span style={{ fontSize: 13, color: '#64748b', marginLeft: 10 }}>
              {grid.property.id}{unit ? ` (${grid.property.unit})` : ''} ·{' '}
              cell ({lineage.ix},{lineage.iy},{lineage.iz}) ·{' '}
              {lineage.method.toUpperCase()} · {lineage.cz.toFixed(1)} m OD
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={copyJson}
              title="Copy lineage data as JSON"
              style={{
                fontSize: 11, padding: '5px 12px', borderRadius: 6,
                border: '1px solid #1e3a5f', background: '#1e3a5f',
                color: '#94a3b8', cursor: 'pointer',
              }}
            >
              Copy JSON
            </button>
            <button
              onClick={onClose}
              style={{
                fontSize: 18, lineHeight: 1, padding: '4px 8px',
                border: 'none', background: 'none',
                color: '#64748b', cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Body: 3 columns ─────────────────────────────────────────── */}
        <div style={{
          display: 'flex', gap: 0, flex: 1, overflow: 'hidden',
        }}>

          {/* ── Left: Summary ────────────────────────────────────── */}
          <div style={{
            width: 230, flexShrink: 0, padding: '16px 14px',
            borderRight: '1px solid #1e3a5f', overflowY: 'auto',
          }}>
            <div style={CARD}>
              <span style={HEAD}>Position</span>
              {([
                ['Grid index', `(${lineage.ix}, ${lineage.iy}, ${lineage.iz})`],
                ['Elevation', `${lineage.cz.toFixed(2)} m OD`],
                ['Depth below GL', lineage.depthBelowGround !== null ? `${lineage.depthBelowGround.toFixed(1)} m` : '—'],
                ['Local X', `${lineage.cx.toFixed(1)} m`],
                ['Local Y', `${lineage.cy.toFixed(1)} m`],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} style={KV}>
                  <span style={{ color: '#64748b' }}>{k}</span>
                  <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{v}</span>
                </div>
              ))}
            </div>

            <div style={CARD}>
              <span style={HEAD}>Value</span>
              <div style={{ ...KV, borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                <span style={{ fontSize: 24, fontWeight: 800, color: '#f1f5f9', fontFamily: 'monospace' }}>
                  {displayVal}
                </span>
                <span style={{ fontSize: 11, color: '#64748b' }}>
                  {grid.property.type === 'numeric' ? 'interpolated' : 'nearest-class'}
                </span>
              </div>
              <div style={{ ...KV, marginTop: 6 }}>
                <span style={{ color: '#64748b' }}>Method</span>
                <span style={{ fontWeight: 600, color: '#7dd3fc' }}>
                  {lineage.method === 'rbf' ? '3-D RBF' : 'IDW'}
                </span>
              </div>
              <div style={{ ...KV }}>
                <span style={{ color: '#64748b' }}>Nearest obs.</span>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>
                  {lineage.nearestObsDistH !== null ? `${lineage.nearestObsDistH.toFixed(0)} m` : '—'}
                </span>
              </div>
            </div>

            <div style={CARD}>
              <span style={HEAD}>Geology</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ width: 18, height: 18, borderRadius: 4, background: geoColor, flexShrink: 0, border: '1px solid #334155' }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>
                  {lineage.geolUnit ?? '(unknown)'}
                </span>
              </div>
            </div>

            <div style={CARD}>
              <span style={HEAD}>Certainty</span>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#f1f5f9', fontFamily: 'monospace', marginBottom: 8 }}>
                {Math.round(lineage.confidence * 100)}%
              </div>
              {/* Certainty bar */}
              <div style={{ height: 8, borderRadius: 4, background: '#1e293b', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.round(lineage.confidence * 100)}%`,
                  background: lineage.confidence > 0.66
                    ? '#22c55e'
                    : lineage.confidence > 0.33
                    ? '#f59e0b'
                    : '#ef4444',
                  borderRadius: 4,
                  transition: 'width 0.3s ease',
                }} />
              </div>
              <p style={{ fontSize: 10, color: '#475569', marginTop: 6, lineHeight: 1.5 }}>
                {lineage.confidence > 0.66
                  ? 'High — cell is well-constrained by nearby observations.'
                  : lineage.confidence > 0.33
                  ? 'Moderate — some extrapolation beyond the data hull.'
                  : 'Low — significant extrapolation; treat value with caution.'}
              </p>
            </div>
          </div>

          {/* ── Centre: Plan view ─────────────────────────────────── */}
          <div style={{
            width: 320, flexShrink: 0, padding: '16px 14px',
            borderRight: '1px solid #1e3a5f',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
          }}>
            <span style={{ ...HEAD, alignSelf: 'flex-start' }}>Spatial context (plan view)</span>

            <div
              style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid #1e3a5f' }}
              dangerouslySetInnerHTML={{ __html: planSvg }}
            />

            <p style={{ fontSize: 10, color: '#475569', marginTop: 10, lineHeight: 1.5, textAlign: 'center', maxWidth: 280 }}>
              ◆ Yellow diamond = this cell. Coloured circles = contributing boreholes.
              Circle size and ring position reflect relative contribution weight.
              Dashed line shows horizontal distance.
            </p>

            {/* Borehole legend */}
            {lineage.contributors.length > 0 && (
              <div style={{ width: '100%', marginTop: 8 }}>
                <span style={HEAD}>Legend</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {lineage.contributors.map((c, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: BH_COLORS[i % BH_COLORS.length], flexShrink: 0 }} />
                      <span style={{ color: '#94a3b8', flex: 1 }}>{c.boreholeId}</span>
                      <span style={{ color: '#64748b' }}>{c.distH.toFixed(0)} m</span>
                      <span style={{ color: '#94a3b8', fontWeight: 600 }}>{Math.round(c.weight * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Right: Weight chart + formula ────────────────────── */}
          <div style={{
            flex: 1, padding: '16px 16px', overflowY: 'auto',
            minWidth: 0,
          }}>
            {/* Weight chart */}
            {weightSvg && (
              <div style={{ marginBottom: 16 }}>
                <span style={HEAD}>Contribution weights</span>
                <div
                  style={{ border: '1px solid #1e3a5f', borderRadius: 8, padding: '10px 8px', background: '#0a0f1e' }}
                  dangerouslySetInnerHTML={{ __html: weightSvg }}
                />
              </div>
            )}

            {/* Computation formula */}
            <div style={{ marginBottom: 16 }}>
              <span style={HEAD}>Computation</span>
              <div style={{ border: '1px solid #1e3a5f', borderRadius: 8, padding: '14px', background: '#0a0f1e' }}>
                {formula}
              </div>
            </div>

            {/* Observation depth window */}
            <div style={CARD}>
              <span style={HEAD}>Depth window</span>
              <div style={KV}>
                <span style={{ color: '#64748b' }}>Cell elevation</span>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{lineage.cz.toFixed(2)} m OD</span>
              </div>
              <div style={KV}>
                <span style={{ color: '#64748b' }}>Window (±)</span>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{(grid.cellSize.dz * 0.55).toFixed(2)} m</span>
              </div>
              <div style={{ ...KV, borderBottom: 'none' }}>
                <span style={{ color: '#64748b' }}>Observations matched</span>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{lineage.contributors.length}</span>
              </div>
              <p style={{ fontSize: 10, color: '#475569', marginTop: 8, lineHeight: 1.5 }}>
                An observation at depth <em>d</em> in a borehole is included when the
                borehole's collar elevation minus <em>d</em> falls within ±½ cell height
                of this cell's elevation.{' '}
                {lineage.method === 'rbf'
                  ? 'For RBF the solve uses all observations without a depth window — the window only applies to this display.'
                  : 'IDW combines only the matched observations using horizontal 1/distance weights.'}
              </p>
            </div>

            {/* Raw observation table */}
            {lineage.contributors.length > 0 && (
              <div style={CARD}>
                <span style={HEAD}>Raw observations</span>
                <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['BH', 'Depth top', 'Depth base', 'Value', 'Dist (m)', 'IDW wt'].map(h => (
                        <th key={h} style={{
                          textAlign: 'left', color: '#475569', fontWeight: 600,
                          paddingBottom: 5, borderBottom: '1px solid #1e3a5f',
                          paddingRight: 8,
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lineage.contributors.map((c, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '4px 8px 4px 0', fontWeight: 700, color: BH_COLORS[i % BH_COLORS.length] }}>
                          {c.boreholeId}
                        </td>
                        <td style={{ padding: '4px 8px', color: '#94a3b8' }}>{c.depthTop.toFixed(2)} m</td>
                        <td style={{ padding: '4px 8px', color: '#94a3b8' }}>{c.depthBase.toFixed(2)} m</td>
                        <td style={{ padding: '4px 8px', color: '#e2e8f0', fontWeight: 600 }}>
                          {c.value !== null ? `${c.value.toFixed(3)}${unit}` : (c.category ?? '—')}
                        </td>
                        <td style={{ padding: '4px 8px', color: '#94a3b8' }}>{c.distH.toFixed(1)}</td>
                        <td style={{ padding: '4px 0', color: '#94a3b8' }}>{(c.weight * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
