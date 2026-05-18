import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  decodeBytes,
  parseStr,
  buildGeo3DModel,
  buildSectionData,
  renderCrossSectionSvg,
} from '../core.js';
import type { AgsFile, Geo3DModel, CrossSectionOptions } from '../core.js';

interface Props {
  fileBytes: Uint8Array | null;
  fileName?: string | undefined;
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

const CHECK_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 8,
  fontSize: 12,
  cursor: 'pointer',
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

export function SectionTab({ fileBytes, fileName }: Props) {
  const agsFile = useMemo<AgsFile | null>(() => {
    if (!fileBytes) return null;
    try { return parseStr(decodeBytes(fileBytes)).file; } catch { return null; }
  }, [fileBytes]);

  const model = useMemo<Geo3DModel | null>(() => {
    if (!agsFile) return null;
    return buildGeo3DModel(agsFile);
  }, [agsFile]);

  const allHoleIds = useMemo(() => model?.boreholes.map(b => b.id) ?? [], [model]);

  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    if (selected.length === 0 && allHoleIds.length >= 2) {
      setSelected(allHoleIds.slice(0, Math.min(4, allHoleIds.length)));
    }
  }, [allHoleIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Style controls
  const [vexag, setVexag] = useState(1);
  const [title, setTitle] = useState<string>('');
  const [subtitle, setSubtitle] = useState<string>('');
  const [startLabel, setStartLabel] = useState<string>('A');
  const [endLabel, setEndLabel] = useState<string>("A′");
  const [showLegend, setShowLegend] = useState(true);
  const [showHatch, setShowHatch] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showDirectionLabels, setShowDirectionLabels] = useState(true);
  const [showUnitLabels, setShowUnitLabels] = useState(true);
  const [showScaleBar, setShowScaleBar] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [smooth, setSmooth] = useState(true);

  // Container size — drives auto-fit SVG dimensions
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(1100);
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const update = () => {
      const w = Math.max(640, Math.min(1800, el.clientWidth - 24));
      setContainerWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [model]);

  const sectionData = useMemo(() => {
    if (!model || selected.length < 2) return null;
    return buildSectionData(model, selected);
  }, [model, selected]);

  const svg = useMemo(() => {
    if (!model || selected.length < 2) return null;
    const w = containerWidth;
    const h = Math.max(420, Math.min(720, Math.round(w * 0.55)));
    const opts: CrossSectionOptions = {
      width: w,
      height: h,
      verticalExaggeration: vexag,
      showLegend,
      showHatch,
      showGrid,
      showDirectionLabels,
      showUnitLabels,
      showScaleBar,
      showLabels,
      interpolation: smooth ? 'smooth' : 'linear-chainage',
      startLabel: startLabel || 'A',
      endLabel: endLabel || "A′",
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(subtitle.trim() ? { subtitle: subtitle.trim() } : {}),
    };
    return renderCrossSectionSvg(model, selected, opts);
  }, [
    model, selected, containerWidth, vexag, title, subtitle,
    showLegend, showHatch, showGrid, showDirectionLabels,
    showUnitLabels, showScaleBar, showLabels, smooth, startLabel, endLabel,
  ]);

  const toggle = useCallback((id: string) => {
    setSelected(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }, []);

  const move = useCallback((id: string, dir: -1 | 1) => {
    setSelected(prev => {
      const i = prev.indexOf(id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const a = next[i]!;
      const b = next[j]!;
      next[i] = b;
      next[j] = a;
      return next;
    });
  }, []);

  const downloadSvg = useCallback(() => {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = (fileName ?? 'section').replace(/\.[^.]+$/, '');
    a.href = url;
    a.download = `${base}_section.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [svg, fileName]);

  const downloadPng = useCallback(async () => {
    if (!svg) return;
    try {
      const img = new Image();
      const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('image load failed'));
        img.src = url;
      });
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = (img.width || containerWidth) * scale;
      canvas.height = (img.height || 540) * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const pngBlob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/png'));
      if (!pngBlob) return;
      const dl = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      const base = (fileName ?? 'section').replace(/\.[^.]+$/, '');
      a.href = dl;
      a.download = `${base}_section.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(dl);
      URL.revokeObjectURL(url);
    } catch {
      // ignore — SVG download is the canonical option
    }
  }, [svg, fileName, containerWidth]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!agsFile) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
        Drop an AGS file with LOCA + GEOL groups to generate cross-sections.
      </div>
    );
  }
  if (!model || model.boreholes.length < 2) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
        At least two boreholes with valid coordinates are required to draw a section.
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16 }}>
      {/* ── Left rail: hole picker + controls ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={PANEL_STYLE}>
          <label style={LABEL_STYLE}>Boreholes (in section order)</label>
          <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
            {selected.map((id, i) => (
              <div key={id} style={rowStyle(true)}>
                <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--accent)', flex: 1 }}>
                  {i + 1}. {id}
                </span>
                <button
                  onClick={() => move(id, -1)}
                  disabled={i === 0}
                  title="Move up"
                  style={smallIconBtnStyle(i === 0)}
                >↑</button>
                <button
                  onClick={() => move(id, 1)}
                  disabled={i === selected.length - 1}
                  title="Move down"
                  style={smallIconBtnStyle(i === selected.length - 1)}
                >↓</button>
                <button
                  onClick={() => toggle(id)}
                  title="Remove"
                  style={{ ...smallIconBtnStyle(false), color: 'var(--red)' }}
                >✕</button>
              </div>
            ))}

            {selected.length > 0 && allHoleIds.length > selected.length && (
              <div style={{ borderTop: '1px solid var(--border)', padding: '4px 8px', fontSize: 10, color: 'var(--muted)', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                Available
              </div>
            )}

            {allHoleIds
              .filter(id => !selected.includes(id))
              .map(id => (
                <div key={id} style={rowStyle(false)} onClick={() => toggle(id)}>
                  <span style={{ flex: 1, fontFamily: 'monospace' }}>{id}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 11 }}>+ add</span>
                </div>
              ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button onClick={() => setSelected([])} style={BUTTON_STYLE}>Clear</button>
            <button onClick={() => setSelected(allHoleIds)} style={BUTTON_STYLE}>Select all</button>
          </div>
        </div>

        <div style={PANEL_STYLE}>
          <label style={LABEL_STYLE}>Section title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Section A–A'"
            style={INPUT_STYLE}
          />

          <label style={{ ...LABEL_STYLE, marginTop: 10 }}>Subtitle</label>
          <input
            type="text"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="e.g. Project name, date"
            style={INPUT_STYLE}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
            <div>
              <label style={LABEL_STYLE}>Start</label>
              <input type="text" value={startLabel} onChange={(e) => setStartLabel(e.target.value)} maxLength={3} style={INPUT_STYLE}/>
            </div>
            <div>
              <label style={LABEL_STYLE}>End</label>
              <input type="text" value={endLabel} onChange={(e) => setEndLabel(e.target.value)} maxLength={3} style={INPUT_STYLE}/>
            </div>
          </div>

          <label style={{ ...LABEL_STYLE, marginTop: 12 }}>Vertical exaggeration</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={vexag}
              onChange={(e) => setVexag(parseFloat(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ width: 44, textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
              ×{vexag.toFixed(1)}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            {[1, 2, 5, 10].map(v => (
              <button key={v} onClick={() => setVexag(v)} style={{ ...BUTTON_STYLE, flex: 1, padding: '4px 6px', fontSize: 11 }}>
                ×{v}
              </button>
            ))}
          </div>
        </div>

        <div style={PANEL_STYLE}>
          <label style={LABEL_STYLE}>Style</label>
          <label style={CHECK_STYLE}>
            <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} />
            Smooth contacts
          </label>
          <label style={CHECK_STYLE}>
            <input type="checkbox" checked={showHatch} onChange={(e) => setShowHatch(e.target.checked)} />
            Hatch patterns
          </label>
          <label style={CHECK_STYLE}>
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
            Grid lines
          </label>
          <label style={CHECK_STYLE}>
            <input type="checkbox" checked={showLegend} onChange={(e) => setShowLegend(e.target.checked)} />
            Legend
          </label>
          <label style={CHECK_STYLE}>
            <input type="checkbox" checked={showDirectionLabels} onChange={(e) => setShowDirectionLabels(e.target.checked)} />
            Direction labels
          </label>
          <label style={CHECK_STYLE}>
            <input type="checkbox" checked={showUnitLabels} onChange={(e) => setShowUnitLabels(e.target.checked)} />
            Unit labels on polygons
          </label>
          <label style={CHECK_STYLE}>
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
            Borehole labels
          </label>
          <label style={CHECK_STYLE}>
            <input type="checkbox" checked={showScaleBar} onChange={(e) => setShowScaleBar(e.target.checked)} />
            Scale bar
          </label>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={downloadSvg} disabled={!svg} style={{ ...PRIMARY_BUTTON_STYLE, flex: 1 }}>
            Download SVG
          </button>
          <button onClick={downloadPng} disabled={!svg} style={{ ...BUTTON_STYLE, flex: 1 }}>
            Download PNG
          </button>
        </div>

        {sectionData && (
          <div style={PANEL_STYLE}>
            <label style={LABEL_STYLE}>Section summary</label>
            <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
              <div>Holes: <strong>{sectionData.boreholes.length}</strong></div>
              <div>Length: <strong>{sectionData.totalLength.toFixed(1)} m</strong></div>
              <div>Elev range: <strong>{sectionData.elevMin.toFixed(1)} &rarr; {sectionData.elevMax.toFixed(1)} m OD</strong></div>
              {sectionData.boreholes.some(b => Math.abs(b.offset) > 0.5) && (
                <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 4 }}>
                  Some holes are projected from off-section (dashed outline).
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Section SVG ── */}
      <div ref={containerRef} style={{ ...PANEL_STYLE, overflow: 'auto', minHeight: 480 }}>
        {selected.length < 2 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
            Pick at least two boreholes from the list on the left.
          </div>
        ) : svg ? (
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        ) : null}
      </div>
    </div>
  );
}

// ── Small style helpers ──────────────────────────────────────────────────────

function rowStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 8px',
    background: active ? 'var(--accent-soft)' : 'transparent',
    borderBottom: '1px solid var(--surface-muted)',
    cursor: active ? 'default' : 'pointer',
    fontSize: 12,
  };
}

function smallIconBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 20,
    height: 20,
    padding: 0,
    fontSize: 11,
    background: 'transparent',
    color: disabled ? 'var(--border-strong)' : 'var(--muted)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}
