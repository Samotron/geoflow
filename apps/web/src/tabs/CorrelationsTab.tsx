import { useMemo, useState } from 'react';
import { decodeBytes, parseStr, correlateIspt } from '../core.js';
import type { AgsFile, IsptCorrelationOptions, IsptCorrelationRow } from '../core.js';

interface Props {
  fileBytes: Uint8Array | null;
}

const PANEL_STYLE: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: 14,
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: 'var(--muted)',
  marginBottom: 6,
  display: 'block',
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 13,
  background: 'var(--card)',
  color: 'var(--text)',
  boxSizing: 'border-box',
};

const TH_STYLE: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.4px',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

const TD_STYLE: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  borderBottom: '1px solid var(--surface-muted)',
};

const FAMILY_BADGE: Record<string, React.CSSProperties> = {
  granular: { background: '#fef3c7', color: '#92400e' },
  cohesive: { background: '#dbeafe', color: '#1e40af' },
  unknown: { background: '#f1f5f9', color: '#475569' },
};

function fmt(n: number | undefined, digits = 1): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtRange(min: number | undefined, max: number | undefined, digits = 0): string {
  if (min === undefined || max === undefined) return '—';
  return `${min.toFixed(digits)}–${max.toFixed(digits)}`;
}

export function CorrelationsTab({ fileBytes }: Props) {
  const [energyRatio, setEnergyRatio] = useState(1.0);
  const [waterTable, setWaterTable] = useState<number | ''>('');
  const [gammaDry, setGammaDry] = useState(18);
  const [gammaWet, setGammaWet] = useState(19);
  const [familyFilter, setFamilyFilter] = useState<'all' | 'granular' | 'cohesive' | 'unknown'>('all');

  const agsFile = useMemo<AgsFile | null>(() => {
    if (!fileBytes) return null;
    try { return parseStr(decodeBytes(fileBytes)).file; } catch { return null; }
  }, [fileBytes]);

  const opts: IsptCorrelationOptions = useMemo(() => ({
    energyRatio,
    gammaDry,
    gammaWet,
    waterTableDepth: typeof waterTable === 'number' ? waterTable : Number.POSITIVE_INFINITY,
  }), [energyRatio, gammaDry, gammaWet, waterTable]);

  const allRows = useMemo<IsptCorrelationRow[]>(() => {
    if (!agsFile) return [];
    return correlateIspt(agsFile, opts);
  }, [agsFile, opts]);

  const rows = useMemo(() => {
    if (familyFilter === 'all') return allRows;
    return allRows.filter(r => r.family === familyFilter);
  }, [allRows, familyFilter]);

  const summary = useMemo(() => {
    const families = { granular: 0, cohesive: 0, unknown: 0 };
    for (const r of allRows) families[r.family]++;
    return families;
  }, [allRows]);

  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
        Drop an AGS file with an ISPT group to compute SPT parameter correlations.
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
  if (allRows.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
        No usable ISPT rows found. The Correlations panel needs ISPT with non-zero ISPT_NVAL and a depth value.
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={PANEL_STYLE}>
          <label style={LABEL_STYLE}>Energy ratio (ER/60)</label>
          <input
            type="number"
            min={0.5} max={1.4} step={0.05}
            value={energyRatio}
            onChange={(e) => setEnergyRatio(parseFloat(e.target.value) || 1)}
            style={INPUT_STYLE}
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            1.0 = ISPT_NVAL already at 60% energy. UK donut ≈ 1.0–1.3, US safety ≈ 1.0.
          </div>
        </div>

        <div style={PANEL_STYLE}>
          <label style={LABEL_STYLE}>Water table depth (m bgl)</label>
          <input
            type="number"
            min={0} step={0.5}
            placeholder="dry"
            value={waterTable}
            onChange={(e) => {
              const v = e.target.value;
              setWaterTable(v === '' ? '' : parseFloat(v));
            }}
            style={INPUT_STYLE}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
            <div>
              <label style={LABEL_STYLE}>γ dry (kN/m³)</label>
              <input
                type="number"
                min={14} max={22} step={0.5}
                value={gammaDry}
                onChange={(e) => setGammaDry(parseFloat(e.target.value) || 18)}
                style={INPUT_STYLE}
              />
            </div>
            <div>
              <label style={LABEL_STYLE}>γ wet (kN/m³)</label>
              <input
                type="number"
                min={14} max={22} step={0.5}
                value={gammaWet}
                onChange={(e) => setGammaWet(parseFloat(e.target.value) || 19)}
                style={INPUT_STYLE}
              />
            </div>
          </div>
        </div>

        <div style={PANEL_STYLE}>
          <label style={LABEL_STYLE}>Soil family filter</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(['all', 'granular', 'cohesive', 'unknown'] as const).map((f) => (
              <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="family"
                  checked={familyFilter === f}
                  onChange={() => setFamilyFilter(f)}
                />
                <span style={{ textTransform: 'capitalize' }}>{f}</span>
                {f !== 'all' && (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {summary[f]}
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>

        <div style={PANEL_STYLE}>
          <label style={LABEL_STYLE}>Correlations applied</label>
          <ul style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6, paddingLeft: 14, margin: 0 }}>
            <li>N₁,₆₀ — Liao &amp; Whitman (1986)</li>
            <li>ϕ′ — Hatanaka &amp; Uchida (1996)</li>
            <li>D<sub>r</sub> — Skempton (1986)</li>
            <li>c<sub>u</sub> — Stroud (1974) f₁ = 4–6</li>
            <li>E<sub>s</sub> — Bowles (1996)</li>
            <li>V<sub>s</sub> — Imai (1981), Ohta–Goto (1978)</li>
          </ul>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8, fontStyle: 'italic' }}>
            All values are estimates from empirical correlations. Not a substitute for in-situ or laboratory testing.
          </div>
        </div>
      </div>

      <div style={{ ...PANEL_STYLE, padding: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={TH_STYLE}>LOCA</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>Depth (m)</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>N</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>N₁,₆₀</th>
              <th style={TH_STYLE}>Family</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>ϕ′ (°)</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>D<sub>r</sub> (%)</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>c<sub>u</sub> (kPa)</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>E<sub>s</sub> (MPa)</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>V<sub>s</sub> Imai (m/s)</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>V<sub>s</sub> O-G (m/s)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const c = r.correlations;
              return (
                <tr key={i}>
                  <td style={{ ...TD_STYLE, fontFamily: 'monospace', fontWeight: 600 }}>{r.loca_id}</td>
                  <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.depth.toFixed(2)}</td>
                  <td style={{ ...TD_STYLE, textAlign: 'right' }}>{r.N}</td>
                  <td style={{ ...TD_STYLE, textAlign: 'right' }}>{fmt(c.N1_60, 1)}</td>
                  <td style={TD_STYLE}>
                    <span style={{
                      ...FAMILY_BADGE[r.family],
                      padding: '2px 7px', borderRadius: 3, fontSize: 11, fontWeight: 600,
                    }}>
                      {r.family}
                    </span>
                  </td>
                  <td style={{ ...TD_STYLE, textAlign: 'right' }}>{fmt(c.phiPrime, 1)}</td>
                  <td style={{ ...TD_STYLE, textAlign: 'right' }}>{fmt(c.Dr, 0)}</td>
                  <td style={{ ...TD_STYLE, textAlign: 'right' }}>{fmtRange(c.cuMin, c.cuMax)}</td>
                  <td style={{ ...TD_STYLE, textAlign: 'right' }}>{fmtRange(c.EsMin, c.EsMax)}</td>
                  <td style={{ ...TD_STYLE, textAlign: 'right' }}>{fmt(c.VsImai, 0)}</td>
                  <td style={{ ...TD_STYLE, textAlign: 'right' }}>{fmt(c.VsOhtaGoto, 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No rows match the current filter.
          </div>
        )}
      </div>
    </div>
  );
}
