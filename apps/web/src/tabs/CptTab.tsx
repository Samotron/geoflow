import { useMemo, useState, useCallback } from 'react';
import {
  parseCptCsv,
  parseCptGef,
  deriveCpt,
  summariseSbtBands,
  renderCptSvg,
  sbtColor,
  sbtName,
  DEFAULT_NKT,
} from '../core.js';
import type {
  CptSounding,
  CptDerived,
  SbtZone,
} from '../core.js';

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
  background: '#fff',
};

const BUTTON_STYLE: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  fontWeight: 600,
  background: 'var(--card)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  cursor: 'pointer',
};

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  ...BUTTON_STYLE,
  background: 'var(--accent)',
  color: '#fff',
  border: '1px solid var(--accent)',
};

const SAMPLE_CSV = `depth,qc,fs,u2
0.5,0.8,0.020,0.060
1.0,0.9,0.025,0.065
1.5,1.0,0.030,0.075
2.0,1.1,0.030,0.085
2.5,1.0,0.028,0.095
3.0,0.9,0.025,0.105
3.5,0.8,0.022,0.115
4.0,4.0,0.040,0.110
4.5,8.0,0.060,0.110
5.0,12.0,0.080,0.110
5.5,14.0,0.090,0.110
6.0,15.0,0.095,0.115
6.5,16.0,0.100,0.115
7.0,17.0,0.105,0.115
7.5,18.0,0.110,0.115
8.0,18.5,0.110,0.115
8.5,18.0,0.108,0.115
9.0,17.5,0.105,0.115
9.5,17.0,0.100,0.115
10.0,16.5,0.098,0.115
`;

interface Props {
  fileBytes: Uint8Array | null;  // unused — kept for tab-prop signature parity
  fileName?: string | undefined;
}

export function CptTab(_props: Props) {
  const [text, setText] = useState<string>('');
  const [soundingId, setSoundingId] = useState<string>('CPT-01');
  const [nkt, setNkt] = useState<number>(DEFAULT_NKT);
  const [netArea, setNetArea] = useState<number>(0.8);
  const [waterTable, setWaterTable] = useState<number>(2.0);
  const [unitWeight, setUnitWeight] = useState<number>(19);
  const [format, setFormat] = useState<'csv' | 'gef'>('csv');

  // ── Parse + derive ────────────────────────────────────────────────────────
  const parseResult = useMemo(() => {
    if (!text.trim()) return null;
    const parser = format === 'gef' ? parseCptGef : parseCptCsv;
    return parser(text, {
      id: soundingId,
      netAreaRatio: netArea,
      waterTableDepth: waterTable,
    });
  }, [text, soundingId, netArea, waterTable, format]);

  const sounding: CptSounding | null = useMemo(() => {
    if (!parseResult?.sounding) return null;
    return {
      ...parseResult.sounding,
      unitWeightProfile: { kind: 'constant', gamma: unitWeight },
    };
  }, [parseResult, unitWeight]);

  const derived: CptDerived[] = useMemo(() => {
    if (!sounding) return [];
    return deriveCpt(sounding, { nkt });
  }, [sounding, nkt]);

  const bands = useMemo(() => summariseSbtBands(derived), [derived]);

  const svg = useMemo(() => {
    if (!sounding || derived.length === 0) return null;
    return renderCptSvg(sounding, derived, { width: 720, height: 640 });
  }, [sounding, derived]);

  // ── Summary stats by SBT zone ────────────────────────────────────────────
  const zoneSummary = useMemo(() => {
    const map = new Map<SbtZone, { count: number; meanQt: number; meanSu: number; suN: number; meanPhi: number; phiN: number; meanDr: number; drN: number; }>();
    for (const d of derived) {
      const z = d.sbt;
      const entry = map.get(z) ?? { count: 0, meanQt: 0, meanSu: 0, suN: 0, meanPhi: 0, phiN: 0, meanDr: 0, drN: 0 };
      entry.count += 1;
      entry.meanQt += d.qt;
      if (d.Su !== undefined) { entry.meanSu += d.Su; entry.suN += 1; }
      if (d.phiPrime !== undefined) { entry.meanPhi += d.phiPrime; entry.phiN += 1; }
      if (d.Dr !== undefined) { entry.meanDr += d.Dr; entry.drN += 1; }
      map.set(z, entry);
    }
    return [...map.entries()]
      .map(([z, s]) => ({
        zone: z,
        count: s.count,
        meanQt: s.meanQt / s.count,
        meanSu: s.suN > 0 ? s.meanSu / s.suN : null,
        meanPhi: s.phiN > 0 ? s.meanPhi / s.phiN : null,
        meanDr: s.drN > 0 ? s.meanDr / s.drN : null,
      }))
      .sort((a, b) => a.zone - b.zone);
  }, [derived]);

  // ── File upload ──────────────────────────────────────────────────────────
  const onUpload = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        setText(result);
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.gef')) setFormat('gef');
        else setFormat('csv');
        // Strip extension for id
        const base = file.name.replace(/\.[^.]+$/, '');
        setSoundingId(base || 'CPT-01');
      }
    };
    reader.readAsText(file);
  }, []);

  const downloadSvg = useCallback(() => {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${soundingId || 'cpt'}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [svg, soundingId]);

  const downloadCsv = useCallback(() => {
    if (derived.length === 0) return;
    const rows: string[] = [
      'depth_m,qt_kPa,fs_kPa,Rf_%,sigmaV0_kPa,sigmaV0_eff_kPa,Qt,Fr_%,Bq,Ic,SBT,SBT_name,Su_kPa,phi_deg,Dr_%',
    ];
    for (const d of derived) {
      rows.push([
        d.depth.toFixed(2),
        d.qt.toFixed(1),
        d.fs.toFixed(1),
        d.Rf.toFixed(2),
        d.sigmaV0.toFixed(1),
        d.sigmaV0Eff.toFixed(1),
        d.Qt.toFixed(2),
        d.Fr.toFixed(2),
        d.Bq === null ? '' : d.Bq.toFixed(3),
        d.Ic.toFixed(2),
        String(d.sbt),
        d.sbtName,
        d.Su !== undefined ? d.Su.toFixed(1) : '',
        d.phiPrime !== undefined ? d.phiPrime.toFixed(1) : '',
        d.Dr !== undefined ? d.Dr.toFixed(1) : '',
      ].map(csvCell).join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${soundingId || 'cpt'}_derived.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [derived, soundingId]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16 }}>
      {/* ── Left rail ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={PANEL_STYLE}>
          <label style={LABEL_STYLE}>Input format</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => setFormat('csv')}
              style={format === 'csv' ? PRIMARY_BUTTON_STYLE : BUTTON_STYLE}
            >CSV</button>
            <button
              onClick={() => setFormat('gef')}
              style={format === 'gef' ? PRIMARY_BUTTON_STYLE : BUTTON_STYLE}
            >GEF</button>
          </div>

          <label style={{ ...LABEL_STYLE, marginTop: 12 }}>Upload file</label>
          <input
            type="file"
            accept=".csv,.txt,.gef,.cpt,.asc"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
            }}
            style={{ fontSize: 12 }}
          />

          <button
            onClick={() => { setText(SAMPLE_CSV); setFormat('csv'); setSoundingId('CPT-DEMO'); }}
            style={{ ...BUTTON_STYLE, marginTop: 8, width: '100%' }}
          >Load demo sounding</button>
        </div>

        <div style={PANEL_STYLE}>
          <label style={LABEL_STYLE}>Sounding ID</label>
          <input
            type="text"
            value={soundingId}
            onChange={(e) => setSoundingId(e.target.value)}
            style={INPUT_STYLE}
          />

          <label style={{ ...LABEL_STYLE, marginTop: 10 }}>Cone bearing factor N<sub>kt</sub></label>
          <input
            type="number"
            value={nkt}
            onChange={(e) => setNkt(parseFloat(e.target.value) || DEFAULT_NKT)}
            step="0.5"
            min="8"
            max="25"
            style={INPUT_STYLE}
          />
          <small style={{ color: 'var(--muted)', fontSize: 11 }}>Used in S<sub>u</sub> = (q<sub>t</sub> − σ<sub>v0</sub>) / N<sub>kt</sub>. Typical range 10–20.</small>

          <label style={{ ...LABEL_STYLE, marginTop: 10 }}>Net area ratio (a)</label>
          <input
            type="number"
            value={netArea}
            onChange={(e) => setNetArea(parseFloat(e.target.value) || 0.8)}
            step="0.05"
            min="0.5"
            max="1.0"
            style={INPUT_STYLE}
          />

          <label style={{ ...LABEL_STYLE, marginTop: 10 }}>Water table depth (m)</label>
          <input
            type="number"
            value={waterTable}
            onChange={(e) => setWaterTable(parseFloat(e.target.value) || 0)}
            step="0.5"
            style={INPUT_STYLE}
          />

          <label style={{ ...LABEL_STYLE, marginTop: 10 }}>Unit weight γ (kN/m³)</label>
          <input
            type="number"
            value={unitWeight}
            onChange={(e) => setUnitWeight(parseFloat(e.target.value) || 19)}
            step="0.5"
            min="14"
            max="24"
            style={INPUT_STYLE}
          />
        </div>

        <div style={PANEL_STYLE}>
          <label style={LABEL_STYLE}>Export</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={downloadSvg} disabled={!svg} style={{ ...BUTTON_STYLE, flex: 1 }}>SVG plot</button>
            <button onClick={downloadCsv} disabled={derived.length === 0} style={{ ...BUTTON_STYLE, flex: 1 }}>Derived CSV</button>
          </div>
        </div>
      </div>

      {/* ── Main panel ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={PANEL_STYLE}>
          <label style={LABEL_STYLE}>CPT data ({format.toUpperCase()})</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={format === 'csv'
              ? 'depth,qc,fs,u2\n0.5,1.2,0.030,0.080\n...'
              : '#GEFID= 1, 1, 0\n#COLUMNINFO= 1, m, length, 11\n...\n#EOH=\n...'}
            style={{
              width: '100%',
              minHeight: 120,
              padding: 8,
              fontFamily: 'Menlo, Consolas, monospace',
              fontSize: 12,
              border: '1px solid var(--border)',
              borderRadius: 4,
              resize: 'vertical',
            }}
          />
          {parseResult && (
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {parseResult.errors.map((e, i) => (
                <span key={`e${i}`} style={statusBadge('error')}>{e}</span>
              ))}
              {parseResult.warnings.map((w, i) => (
                <span key={`w${i}`} style={statusBadge('warn')}>{w}</span>
              ))}
              {parseResult.sounding && (
                <span style={statusBadge('ok')}>{parseResult.sounding.readings.length} readings parsed</span>
              )}
            </div>
          )}
        </div>

        {svg && (
          <div style={{ ...PANEL_STYLE, overflow: 'auto' }}>
            <div dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        )}

        {derived.length > 0 && (
          <div style={PANEL_STYLE}>
            <label style={LABEL_STYLE}>SBT zones (Robertson 1990)</label>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11 }}>
                  <th style={th}>Zone</th>
                  <th style={th}>Name</th>
                  <th style={th}># readings</th>
                  <th style={th}>Mean q<sub>t</sub> (kPa)</th>
                  <th style={th}>Mean S<sub>u</sub> (kPa)</th>
                  <th style={th}>Mean φ′ (°)</th>
                  <th style={th}>Mean D<sub>r</sub> (%)</th>
                </tr>
              </thead>
              <tbody>
                {zoneSummary.map(z => (
                  <tr key={z.zone} style={{ borderTop: '1px solid var(--surface-muted)' }}>
                    <td style={td}>
                      <span style={{ display: 'inline-block', width: 14, height: 14, background: sbtColor(z.zone), marginRight: 6, verticalAlign: 'middle', border: '1px solid #475569' }} />
                      {z.zone}
                    </td>
                    <td style={td}>{sbtName(z.zone)}</td>
                    <td style={td}>{z.count}</td>
                    <td style={td}>{z.meanQt.toFixed(0)}</td>
                    <td style={td}>{z.meanSu !== null ? z.meanSu.toFixed(0) : '—'}</td>
                    <td style={td}>{z.meanPhi !== null ? z.meanPhi.toFixed(1) : '—'}</td>
                    <td style={td}>{z.meanDr !== null ? z.meanDr.toFixed(0) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {bands.length > 0 && (
          <div style={PANEL_STYLE}>
            <label style={LABEL_STYLE}>Contiguous SBT bands</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {bands.map((b, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '110px 60px 1fr', alignItems: 'center', fontSize: 12, padding: '3px 0' }}>
                  <span style={{ fontFamily: 'monospace', color: 'var(--muted)' }}>
                    {b.topDepth.toFixed(2)}–{b.baseDepth.toFixed(2)} m
                  </span>
                  <span style={{
                    background: sbtColor(b.sbt),
                    color: '#0f172a',
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontWeight: 600,
                    fontSize: 11,
                    textAlign: 'center',
                    border: '1px solid #475569',
                  }}>Zone {b.sbt}</span>
                  <span style={{ marginLeft: 8 }}>{b.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── tiny style helpers ───────────────────────────────────────────────────────

const th: React.CSSProperties = { padding: '6px 8px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px' };
const td: React.CSSProperties = { padding: '6px 8px' };

function statusBadge(kind: 'ok' | 'warn' | 'error'): React.CSSProperties {
  const palette = {
    ok:    { bg: 'var(--green-soft)',  fg: '#1f6f3a', bd: 'var(--green-border)' },
    warn:  { bg: 'var(--amber-soft)',  fg: '#7a5012', bd: 'var(--amber-border)' },
    error: { bg: 'var(--red-soft)',    fg: '#7a1f1f', bd: 'var(--red-border)' },
  } as const;
  const c = palette[kind];
  return {
    background: c.bg,
    color: c.fg,
    border: `1px solid ${c.bd}`,
    padding: '3px 8px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
  };
}

function csvCell(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
