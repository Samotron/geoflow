import { useMemo, useState, useDeferredValue } from 'react';
import { decodeBytes, enhanceGeol, parseDescription, parseStr } from '../core.js';
import type {
  AgsFile,
  EnhancedGeolRow,
  ParsedToken,
  ParsedTokenKind,
  SoilDescription,
} from '../core.js';

interface Props {
  fileBytes: Uint8Array | null;
}

// ── Token kind → colour mapping ──────────────────────────────────────────────

const TOKEN_COLORS: Record<ParsedTokenKind, { bg: string; fg: string; label: string }> = {
  consistency:     { bg: '#fff4d6', fg: '#7d5b1a', label: 'consistency' },
  density:         { bg: '#fff4d6', fg: '#7d5b1a', label: 'density' },
  moisture:        { bg: '#dff0f8', fg: '#1f5d72', label: 'moisture' },
  particle_size:   { bg: '#ecdcf5', fg: '#5a2882', label: 'particle' },
  colour:          { bg: '#e9efff', fg: '#3f4f8b', label: 'colour' },
  soil_type:       { bg: '#d9f0df', fg: '#1e6e3c', label: 'soil' },
  rock_type:       { bg: '#fadbd0', fg: '#7a3010', label: 'rock' },
  weathering:      { bg: '#f5e1d6', fg: '#7a3a14', label: 'weath' },
  rock_strength:   { bg: '#fadbd0', fg: '#7a3010', label: 'strength' },
  spacing:         { bg: '#dfecdf', fg: '#2e6131', label: 'spacing' },
  plasticity:      { bg: '#f5e0ef', fg: '#7a2a64', label: 'plast' },
  structure:       { bg: '#e0eedf', fg: '#225a2a', label: 'struct' },
  inclusion:       { bg: '#fbeed4', fg: '#7d551a', label: 'incl' },
  made_ground:     { bg: '#ddc9b8', fg: '#5a3d1d', label: 'made' },
  proportion:      { bg: '#eee', fg: '#555', label: 'prop' },
  roundness:       { bg: '#e1dff5', fg: '#3f2882', label: 'round' },
  sorting:         { bg: '#e1dff5', fg: '#3f2882', label: 'sort' },
  cementation:     { bg: '#fadbd0', fg: '#7a3010', label: 'cem' },
  hcl_reaction:    { bg: '#dff0f8', fg: '#1f5d72', label: 'HCl' },
  odour:           { bg: '#f7dada', fg: '#7d2020', label: 'odour' },
  origin:          { bg: '#dff5ef', fg: '#1a624f', label: 'origin' },
  age:             { bg: '#f3e6c8', fg: '#6d4a14', label: 'age' },
  joint_aperture:  { bg: '#e0eedf', fg: '#225a2a', label: 'aperture' },
  joint_roughness: { bg: '#e0eedf', fg: '#225a2a', label: 'roughness' },
  formation:       { bg: '#f3e6c8', fg: '#6d4a14', label: 'form' },
};

// ── Build a non-overlapping coloured rendition of the normalised text ────────

function HighlightedText({ desc }: { desc: SoilDescription }) {
  const text = desc.normalised;
  // Sort tokens by start, then prefer the longer span on conflict.
  const sorted = [...desc.tokens].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : (b.end - b.start) - (a.end - a.start)
  );
  const segments: Array<{ start: number; end: number; tok?: ParsedToken }> = [];
  let cursor = 0;
  for (const tok of sorted) {
    if (tok.start < cursor) continue; // overlap, skip
    if (tok.start > cursor) segments.push({ start: cursor, end: tok.start });
    segments.push({ start: tok.start, end: tok.end, tok });
    cursor = tok.end;
  }
  if (cursor < text.length) segments.push({ start: cursor, end: text.length });

  return (
    <div style={{
      fontFamily: '"Menlo", "Consolas", monospace',
      fontSize: 13,
      lineHeight: 2.2,
      background: 'var(--surface-muted)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '12px 14px',
      wordBreak: 'break-word',
    }}>
      {segments.map((seg, i) => {
        const slice = text.slice(seg.start, seg.end);
        if (!seg.tok) return <span key={i}>{slice}</span>;
        const c = TOKEN_COLORS[seg.tok.kind];
        return (
          <span
            key={i}
            title={`${seg.tok.kind} → ${seg.tok.value}`}
            style={{
              background: c.bg,
              color: c.fg,
              padding: '2px 5px',
              margin: '0 1px',
              borderRadius: 4,
              fontWeight: 600,
              whiteSpace: 'pre',
            }}
          >
            {slice}
          </span>
        );
      })}
    </div>
  );
}

// ── Legend ───────────────────────────────────────────────────────────────────

function Legend({ tokens }: { tokens: ParsedToken[] }) {
  const present = new Set<ParsedTokenKind>();
  for (const t of tokens) present.add(t.kind);
  const kinds = (Object.keys(TOKEN_COLORS) as ParsedTokenKind[]).filter((k) => present.has(k));
  if (kinds.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {kinds.map((k) => {
        const c = TOKEN_COLORS[k];
        return (
          <span key={k} style={{
            padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600,
            background: c.bg, color: c.fg,
          }}>{c.label}</span>
        );
      })}
    </div>
  );
}

// ── Field list ───────────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return null;
  const display = Array.isArray(value) ? value.join(', ') : value;
  if (display === '' || display === false) return null;
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 }}>
      <span style={{ minWidth: 130, color: 'var(--muted)', fontSize: 12, fontWeight: 600 }}>{label}</span>
      <span style={{ color: 'var(--text)', fontFamily: '"Menlo", "Consolas", monospace', fontSize: 12 }}>{display}</span>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const colour = value >= 0.8 ? 'var(--green)' : value >= 0.5 ? 'var(--amber)' : 'var(--red)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 8, background: 'var(--surface-muted)', borderRadius: 4, overflow: 'hidden', maxWidth: 240 }}>
        <div style={{ width: `${Math.round(value * 100)}%`, height: '100%', background: colour }} />
      </div>
      <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--muted)' }}>{(value * 100).toFixed(0)}%</span>
    </div>
  );
}

function StrengthTable({ desc }: { desc: SoilDescription }) {
  const sp = desc.strength_params;
  if (!sp) return null;
  const rows: Array<[string, string]> = [];
  const range = (a?: number | null, b?: number | null, unit = '') =>
    `${a ?? '?'}–${b == null ? '∞' : b}${unit ? ' ' + unit : ''}`;
  if (sp.cu_min_kpa !== undefined) rows.push(['Undrained shear strength cᵤ', range(sp.cu_min_kpa, sp.cu_max_kpa, 'kPa')]);
  if (sp.spt_n_min !== undefined) rows.push(['SPT N₆₀', range(sp.spt_n_min, sp.spt_n_max, 'blows/300 mm')]);
  if (sp.phi_min_deg !== undefined) rows.push(['Effective friction angle ϕ′', range(sp.phi_min_deg, sp.phi_max_deg, '°')]);
  if (sp.ucs_min_mpa !== undefined) rows.push(['Uniaxial compressive strength', range(sp.ucs_min_mpa, sp.ucs_max_mpa, 'MPa')]);
  if (sp.unit_weight_min !== undefined) rows.push(['Unit weight γ', range(sp.unit_weight_min, sp.unit_weight_max, 'kN/m³')]);

  if (rows.length === 0) return null;
  return (
    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td style={{ padding: '4px 8px', color: 'var(--muted)', borderBottom: '1px solid var(--surface-muted)' }}>{k}</td>
            <td style={{ padding: '4px 8px', fontFamily: 'monospace', borderBottom: '1px solid var(--surface-muted)' }}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ClassificationCards({ desc }: { desc: SoilDescription }) {
  const c = desc.classifications;
  const items: Array<{ label: string; value: string | undefined; description: string }> = [
    { label: 'USCS',     value: c.uscs,     description: 'ASTM D2487 / D2488' },
    { label: 'AASHTO',   value: c.aashto,   description: 'M 145' },
    { label: 'BS 5930',  value: c.bs5930,   description: 'BS 5930:2015' },
    { label: 'ISO 14688',value: c.iso14688, description: 'EN ISO 14688' },
  ].filter((x) => x.value);
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
      {items.map((it) => (
        <div key={it.label} style={{ padding: '10px 12px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>{it.label}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', fontFamily: 'monospace', marginTop: 2 }}>{it.value}</div>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{it.description}</div>
        </div>
      ))}
    </div>
  );
}

// ── Card showing all parsed fields for a single description ──────────────────

function DescriptionCard({ desc }: { desc: SoilDescription }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <HighlightedText desc={desc} />
      <Legend tokens={desc.tokens} />

      <ClassificationCards desc={desc} />

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16,
      }}>
        <div>
          <h4 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6, fontWeight: 700 }}>Material</h4>
          <Field label="Material type" value={desc.material_type} />
          <Field label="Primary soil"  value={desc.primary_soil_type} />
          <Field label="Secondary"     value={desc.secondary_soil_type} />
          <Field label="Rock type"     value={desc.rock_type} />
          <Field label="Made ground"   value={desc.is_made_ground ? 'yes' : null} />
        </div>

        <div>
          <h4 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6, fontWeight: 700 }}>State</h4>
          <Field label="Consistency"   value={desc.consistency} />
          <Field label="Density"       value={desc.density} />
          <Field label="Moisture"      value={desc.moisture} />
          <Field label="Plasticity"    value={desc.plasticity} />
          <Field label="Cementation"   value={desc.cementation} />
          <Field label="HCl reaction"  value={desc.hcl_reaction} />
          <Field label="Odour"         value={desc.odour} />
        </div>

        <div>
          <h4 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6, fontWeight: 700 }}>Particles & Fabric</h4>
          <Field label="Particle size" value={desc.particle_size} />
          <Field label="Roundness"     value={desc.roundness} />
          <Field label="Sorting"       value={desc.sorting} />
          <Field label="Structures"    value={desc.structures} />
          <Field label="Colours"       value={desc.colours} />
          <Field label="Constituents"  value={desc.secondary_constituents.map((c) => `${c.proportion} ${c.soil_type}`)} />
          <Field label="Inclusions"    value={desc.inclusions} />
        </div>

        <div>
          <h4 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6, fontWeight: 700 }}>Rock & Geology</h4>
          <Field label="Weathering"    value={desc.weathering} />
          <Field label="Rock strength" value={desc.rock_strength} />
          <Field label="Bedding"       value={desc.bedding_spacing} />
          <Field label="Joint aperture" value={desc.joint_aperture} />
          <Field label="Joint roughness" value={desc.joint_roughness} />
          <Field label="Origin"        value={desc.origin} />
          <Field label="Age"           value={desc.age} />
          <Field label="Formations"    value={desc.formations.map((f) => f.name)} />
        </div>
      </div>

      <div>
        <h4 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6, fontWeight: 700 }}>
          Derived parameters
        </h4>
        <StrengthTable desc={desc} />
      </div>

      <div>
        <h4 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6, fontWeight: 700 }}>Confidence</h4>
        <ConfidenceBar value={desc.confidence} />
      </div>

      {desc.spelling_corrections.length > 0 && (
        <div>
          <h4 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6, fontWeight: 700 }}>
            Spelling corrections
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {desc.spelling_corrections.map((c, i) => (
              <div key={i} style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text)' }}>
                <span style={{ textDecoration: 'line-through', color: 'var(--muted)' }}>{c.original}</span>
                {' → '}
                <span style={{ fontWeight: 700, color: 'var(--accent)' }}>{c.corrected}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {desc.warnings.length > 0 && (
        <div style={{ padding: '8px 12px', background: 'var(--amber-soft)', border: '1px solid var(--amber-border)', borderRadius: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--amber)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Warnings</div>
          {desc.warnings.map((w, i) => (
            <div key={i} style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text)' }}>{w}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Playground sub-tab ───────────────────────────────────────────────────────

const PLAYGROUND_KEY = 'geoflow:describe-playground';
const PRESETS: Array<{ label: string; text: string }> = [
  { label: 'Soft grey CLAY',         text: 'Soft grey CLAY' },
  { label: 'Sandy CLAY (BS 5930)',   text: 'Stiff fissured laminated dark grey sandy CLAY with occasional sub-rounded fine gravel; calcareous; high plasticity' },
  { label: 'Made ground',            text: 'Made ground: brown sandy gravelly clayey FILL with brick rubble, concrete fragments and ash' },
  { label: 'Weathered limestone',    text: 'Moderately weathered, medium strong, medium bedded, close jointed, light grey fossiliferous LIMESTONE' },
  { label: 'W3 grade rock',          text: 'W3 strong fresh grey GRANITE with calcite veins, slickensided joints' },
  { label: 'ASTM-style sand',        text: 'Loose, moist, dark brown, fine to medium SAND, sub-angular, well-graded, no reaction with HCl' },
  { label: 'Typo torture test',      text: 'soff brwn snady CLYY with trase gravell, sligtly moist' },
  { label: 'Eocene London Clay',     text: 'Very stiff fissured dark grey-brown silty CLAY of high plasticity (London Clay)' },
  { label: 'Glacial till',           text: 'Very stiff brown gravelly sandy clayey glacial till (boulder clay) with frequent sub-angular cobbles' },
  { label: 'Hydrocarbon-impacted',   text: 'Soft black silty CLAY, saturated, strong hydrocarbon odour, hydrocarbon staining' },
];

function PlaygroundPanel() {
  const [text, setText] = useState<string>(() => {
    try { return localStorage.getItem(PLAYGROUND_KEY) ?? PRESETS[0]!.text; }
    catch { return PRESETS[0]!.text; }
  });
  const [spellCorrection, setSpellCorrection] = useState(true);
  const deferred = useDeferredValue(text);

  const desc = useMemo(() => parseDescription(deferred, { spellCorrection }), [deferred, spellCorrection]);

  const onChange = (v: string) => {
    setText(v);
    try { localStorage.setItem(PLAYGROUND_KEY, v); } catch { /* ignore */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{
          display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)',
          background: 'var(--surface-muted)', flexWrap: 'wrap', alignItems: 'center',
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginRight: 4 }}>Presets:</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => onChange(p.text)}
              style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                background: 'var(--card)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 99, cursor: 'pointer',
              }}
            >{p.label}</button>
          ))}
          <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={spellCorrection}
              onChange={(e) => setSpellCorrection(e.target.checked)}
            />
            Spell correction
          </label>
        </div>
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder='e.g. "Stiff fissured dark grey sandy CLAY with occasional fine gravel"'
          rows={3}
          style={{
            width: '100%', padding: 14, fontSize: 14,
            fontFamily: '"Menlo", "Consolas", monospace',
            border: 'none', outline: 'none', resize: 'vertical',
            background: 'var(--card)', color: 'var(--text)',
          }}
        />
      </div>

      {text.trim() === '' ? (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
          Type a description above — try one of the presets to see what's possible.
        </div>
      ) : (
        <DescriptionCard desc={desc} />
      )}
    </div>
  );
}

// ── GEOL sub-tab: list / per-row preview ─────────────────────────────────────

function GeolBrowser({ file }: { file: AgsFile }) {
  const rows: EnhancedGeolRow[] = useMemo(() => enhanceGeol(file), [file]);
  const [selected, setSelected] = useState<number>(0);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) =>
      r.loca_id.toLowerCase().includes(s) ||
      r.geol_desc.toLowerCase().includes(s)
    );
  }, [rows, search]);

  if (rows.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 48, color: 'var(--muted)' }}>
        No GEOL_DESC rows in this file.
      </div>
    );
  }

  const current = filtered[Math.min(selected, filtered.length - 1)];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) 2fr', gap: 16, alignItems: 'start' }}>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6 }}>
            {filtered.length} of {rows.length} GEOL rows
          </div>
          <input
            type="text"
            placeholder="Filter by LOCA_ID or description…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelected(0); }}
            style={{
              width: '100%', padding: '6px 10px', fontSize: 12,
              border: '1px solid var(--border)', borderRadius: 4,
              background: 'var(--card)', color: 'var(--text)',
            }}
          />
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {filtered.map((row, i) => {
            const isSelected = i === selected;
            const d = row.parsed;
            const tag =
              d.material_type === 'rock' ? d.rock_type :
              d.material_type === 'made' ? 'MADE' :
              d.primary_soil_type;
            return (
              <div
                key={i}
                onClick={() => setSelected(i)}
                style={{
                  padding: '8px 12px', borderBottom: '1px solid var(--surface-muted)',
                  background: isSelected ? 'var(--accent-soft)' : 'transparent',
                  borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
                  cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ fontWeight: 700, color: 'var(--text)' }}>{row.loca_id || '(no LOCA_ID)'}</span>
                  <span style={{ color: 'var(--muted)', fontFamily: 'monospace' }}>
                    {row.geol_top?.toFixed(2) ?? '?'}–{row.geol_base?.toFixed(2) ?? '?'} m
                  </span>
                  {tag && (
                    <span style={{
                      marginLeft: 'auto', fontSize: 10, fontWeight: 700,
                      padding: '1px 6px', borderRadius: 99,
                      background: 'var(--surface-muted)', color: 'var(--muted)',
                    }}>{tag}</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.geol_desc}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        {current ? (
          <>
            <div style={{
              padding: '10px 14px', background: 'var(--card)', border: '1px solid var(--border)',
              borderRadius: 8, marginBottom: 14,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span style={{ fontWeight: 700 }}>{current.loca_id}</span>
                <span style={{ color: 'var(--muted)', fontFamily: 'monospace' }}>
                  {current.geol_top?.toFixed(2) ?? '?'}–{current.geol_base?.toFixed(2) ?? '?'} m
                </span>
              </div>
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text)', fontStyle: 'italic' }}>
                "{current.geol_desc}"
              </div>
            </div>
            <DescriptionCard desc={current.parsed} />
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
            No match.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Stats sub-tab: aggregate counts across the file ──────────────────────────

function StatsPanel({ file }: { file: AgsFile }) {
  const rows = useMemo(() => enhanceGeol(file), [file]);
  if (rows.length === 0) {
    return <div style={{ textAlign: 'center', padding: 48, color: 'var(--muted)' }}>No GEOL_DESC rows to analyse.</div>;
  }

  const totals = {
    soil: rows.filter((r) => r.parsed.material_type === 'soil').length,
    rock: rows.filter((r) => r.parsed.material_type === 'rock').length,
    made: rows.filter((r) => r.parsed.material_type === 'made').length,
    unknown: rows.filter((r) => r.parsed.material_type === 'unknown').length,
  };

  const counts = <T extends string>(getter: (r: EnhancedGeolRow) => T | undefined): Array<[T, number]> => {
    const m = new Map<T, number>();
    for (const r of rows) {
      const v = getter(r);
      if (v !== undefined) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  };

  const primarySoil = counts((r) => r.parsed.primary_soil_type);
  const rockTypes   = counts((r) => r.parsed.rock_type);
  const consistency = counts((r) => r.parsed.consistency);
  const density     = counts((r) => r.parsed.density);
  const uscs        = counts((r) => r.parsed.classifications.uscs);
  const aashto      = counts((r) => r.parsed.classifications.aashto);

  const avgConfidence = rows.reduce((s, r) => s + r.parsed.confidence, 0) / rows.length;
  const lowConfidenceRows = rows.filter((r) => r.parsed.confidence < 0.5);
  const warningRows = rows.filter((r) => r.parsed.warnings.length > 0);
  const corrections = rows.reduce((s, r) => s + r.parsed.spelling_corrections.length, 0);

  const CountBar = ({ data, total, title }: { data: Array<[string, number]>; total: number; title: string }) => {
    if (data.length === 0) return null;
    return (
      <div>
        <h4 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 8, fontWeight: 700 }}>{title}</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.map(([label, n]) => (
            <div key={label} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 50px', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--text)', fontFamily: 'monospace' }}>{label}</span>
              <div style={{ height: 10, background: 'var(--surface-muted)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${(n / total) * 100}%`, height: '100%', background: 'var(--accent)' }} />
              </div>
              <span style={{ color: 'var(--muted)', fontFamily: 'monospace', textAlign: 'right' }}>{n}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        {[
          { label: 'Soil rows',   value: totals.soil,   color: 'var(--green)' },
          { label: 'Rock rows',   value: totals.rock,   color: 'var(--amber)' },
          { label: 'Made ground', value: totals.made,   color: 'var(--orange)' },
          { label: 'Unknown',     value: totals.unknown, color: 'var(--muted)' },
          { label: 'Avg confidence', value: `${(avgConfidence * 100).toFixed(0)}%`, color: 'var(--accent)' },
          { label: 'Low conf rows',  value: lowConfidenceRows.length, color: 'var(--red)' },
          { label: 'Warnings',       value: warningRows.length,        color: 'var(--amber)' },
          { label: 'Spelling fixes', value: corrections,               color: 'var(--accent)' },
        ].map((s) => (
          <div key={s.label} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>{s.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: 'monospace' }}>{s.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24 }}>
        <CountBar data={primarySoil} total={rows.length} title="Primary soil type" />
        <CountBar data={rockTypes}   total={rows.length} title="Rock type" />
        <CountBar data={consistency} total={rows.length} title="Consistency (cohesive)" />
        <CountBar data={density}     total={rows.length} title="Density (granular)" />
        <CountBar data={uscs}        total={rows.length} title="USCS classification" />
        <CountBar data={aashto}      total={rows.length} title="AASHTO classification" />
      </div>
    </div>
  );
}

// ── Top-level ────────────────────────────────────────────────────────────────

type Mode = 'playground' | 'geol' | 'stats';

const MODE_STATE_KEY = 'geoflow:describe-mode';

export function DescribeTab({ fileBytes }: Props) {
  const [mode, setMode] = useState<Mode>(() => {
    try { return (localStorage.getItem(MODE_STATE_KEY) as Mode) || 'playground'; }
    catch { return 'playground'; }
  });

  const file: AgsFile | null = useMemo(() => {
    if (!fileBytes) return null;
    try { return parseStr(decodeBytes(fileBytes)).file; }
    catch { return null; }
  }, [fileBytes]);

  const switchMode = (m: Mode) => {
    setMode(m);
    try { localStorage.setItem(MODE_STATE_KEY, m); } catch { /* ignore */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700 }}>Description parser</h2>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          Extract structured data from free-text soil &amp; rock descriptions.
        </span>
      </div>

      <div style={{
        display: 'flex', gap: 4, padding: 4, background: 'var(--surface-muted)',
        borderRadius: 6, alignSelf: 'flex-start', border: '1px solid var(--border)',
      }}>
        {([
          { id: 'playground', label: 'Playground' },
          { id: 'geol',       label: 'GEOL rows', disabled: !file },
          { id: 'stats',      label: 'Statistics', disabled: !file },
        ] as Array<{ id: Mode; label: string; disabled?: boolean }>).map((m) => {
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => !m.disabled && switchMode(m.id)}
              disabled={m.disabled}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 600,
                background: active ? 'var(--card)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--muted)',
                border: active ? '1px solid var(--accent-border)' : '1px solid transparent',
                borderRadius: 4, cursor: m.disabled ? 'not-allowed' : 'pointer',
                opacity: m.disabled ? 0.45 : 1,
              }}
            >{m.label}</button>
          );
        })}
      </div>

      {mode === 'playground' && <PlaygroundPanel />}
      {mode === 'geol' && file && <GeolBrowser file={file} />}
      {mode === 'stats' && file && <StatsPanel file={file} />}
      {(mode === 'geol' || mode === 'stats') && !file && (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--muted)' }}>
          Load an AGS file to view parsed GEOL descriptions.
        </div>
      )}
    </div>
  );
}
