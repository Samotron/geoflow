/**
 * Overview tab — first-look project dashboard.
 *
 * Surfaces the high-value summary metrics computed by `buildProjectSummary`
 * in `@geoflow/core/summary.ts`:
 *   - Project metadata block (PROJ_*)
 *   - Headline counts and depth distribution
 *   - Hole schedule (sortable LOCA table)
 *   - Geological unit ranking by total thickness
 *   - Data quality grade A–F (from `assessQuality`)
 */

import { useMemo, useState } from 'react';
import { buildProjectSummary, parseStr, decodeBytes, assessQuality, toAgsiJson } from '../core.js';
import type { ProjectSummary, AgsFile, QualityReport, HoleScheduleEntry } from '../core.js';
import { downloadBlob, exportBaseName, exportDatePrefix } from '../export/utils.js';

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
}

type ScheduleSort = 'id' | 'depth' | 'type' | 'gl';

export function OverviewTab({ fileBytes, fileName }: Props) {
  const parsed = useMemo<{ file: AgsFile | null; error: string | null }>(() => {
    if (!fileBytes) return { file: null, error: null };
    try {
      const { file } = parseStr(decodeBytes(fileBytes));
      return { file, error: null };
    } catch (e) {
      return { file: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [fileBytes]);

  const summary = useMemo<ProjectSummary | null>(
    () => (parsed.file ? buildProjectSummary(parsed.file) : null),
    [parsed.file],
  );

  const quality = useMemo<QualityReport | null>(
    () => (parsed.file ? assessQuality(parsed.file) : null),
    [parsed.file],
  );

  const [sortBy, setSortBy] = useState<ScheduleSort>('id');
  const [showAllUnits, setShowAllUnits] = useState(false);

  const downloadAgsi = () => {
    if (!parsed.file) return;
    const json = toAgsiJson(parsed.file);
    const base = exportBaseName(fileName);
    const date = exportDatePrefix();
    downloadBlob(json, `${date}-${base}.agsi.json`, 'application/json');
  };

  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
        <p>Drop an AGS file above to see the project overview.</p>
      </div>
    );
  }

  if (parsed.error) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--red)' }}>
        Failed to parse the AGS file: {parsed.error}
      </div>
    );
  }

  if (!summary) return null;

  const sortedSchedule = sortSchedule(summary.schedule, sortBy);
  const visibleUnits = showAllUnits ? summary.units : summary.units.slice(0, 8);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Header row ─────────────────────────────────────────────────── */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>
              Project
            </div>
            <h2 style={{ margin: '4px 0 0 0', fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>
              {summary.project.projName || '(unnamed project)'}
            </h2>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 6, fontSize: 12, color: 'var(--text-dim)' }}>
              {summary.project.projId &&  <span><strong>ID:</strong> {summary.project.projId}</span>}
              {summary.project.projLoc && <span><strong>Location:</strong> {summary.project.projLoc}</span>}
              {summary.project.projClnt && <span><strong>Client:</strong> {summary.project.projClnt}</span>}
              {summary.project.projEng && <span><strong>Engineer:</strong> {summary.project.projEng}</span>}
              {summary.agsVersion && <span><strong>AGS:</strong> {summary.agsVersion}</span>}
              {fileName && <span><strong>File:</strong> {fileName}</span>}
            </div>
          </div>
          {quality && <QualityBadge quality={quality} />}
        </div>
      </Card>

      {/* ── Headline metrics ──────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
        <Metric label="Boreholes" value={summary.totals.boreholes} />
        <Metric label="Total metres" value={formatNum(summary.depth.totalMetres)} hint="m drilled" />
        <Metric label="Mean depth" value={formatNum(summary.depth.meanDepthM)} hint={`max ${formatNum(summary.depth.maxDepthM)} m`} />
        <Metric label="Strata logged" value={summary.totals.strata} />
        <Metric label="Samples" value={summary.totals.samples} />
        <Metric label="SPT tests" value={summary.totals.sptTests} />
        <Metric label="Water strikes" value={summary.totals.waterStrikes} />
        <Metric label="Groups" value={summary.totals.groups} hint={`${summary.groupRowCounts.length} populated`} />
      </div>

      {/* ── Two-column row: hole types + group inventory ───────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="Hole types">
          {Object.keys(summary.holeTypes).length === 0
            ? <div style={{ color: 'var(--muted)', fontSize: 12 }}>No LOCA_TYPE values found.</div>
            : (
              <table style={tableStyle}>
                <tbody>
                  {Object.entries(summary.holeTypes).map(([code, count]) => (
                    <tr key={code}>
                      <td style={tdLabel}>{code}</td>
                      <td style={tdValue}>{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Card>

        <Card title="Group inventory" subtitle={`${summary.groupRowCounts.length} groups`}>
          <div style={{ maxHeight: 180, overflowY: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Group</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Rows</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Headings</th>
                </tr>
              </thead>
              <tbody>
                {summary.groupRowCounts.map((g) => (
                  <tr key={g.group}>
                    <td style={tdLabel}><code style={codeStyle}>{g.group}</code></td>
                    <td style={tdValue}>{g.rows}</td>
                    <td style={tdValue}>{g.headings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* ── Borehole schedule ──────────────────────────────────────────── */}
      <Card title="Borehole schedule" subtitle={`${summary.schedule.length} locations`}
        right={
          <div style={{ display: 'flex', gap: 4 }}>
            <SortButton label="ID" active={sortBy === 'id'} onClick={() => setSortBy('id')} />
            <SortButton label="Depth" active={sortBy === 'depth'} onClick={() => setSortBy('depth')} />
            <SortButton label="Type" active={sortBy === 'type'} onClick={() => setSortBy('type')} />
            <SortButton label="GL" active={sortBy === 'gl'} onClick={() => setSortBy('gl')} />
          </div>
        }>
        {sortedSchedule.length === 0
          ? <div style={{ color: 'var(--muted)', fontSize: 12 }}>No LOCA rows.</div>
          : (
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>LOCA_ID</th>
                    <th style={thStyle}>Type</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Depth (m)</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>GL (m)</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Easting</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Northing</th>
                    <th style={thStyle}>Started</th>
                    <th style={thStyle}>Ended</th>
                    <th style={thStyle}>Method</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSchedule.map((h) => (
                    <tr key={h.locaId}>
                      <td style={tdLabel}><code style={codeStyle}>{h.locaId}</code></td>
                      <td style={tdValue}>{h.type || '—'}</td>
                      <td style={tdValue}>{formatNum(h.depthM)}</td>
                      <td style={tdValue}>{h.groundLevel === null ? '—' : formatNum(h.groundLevel)}</td>
                      <td style={tdValue}>{h.easting === null ? '—' : formatNum(h.easting)}</td>
                      <td style={tdValue}>{h.northing === null ? '—' : formatNum(h.northing)}</td>
                      <td style={tdValue}>{h.startDate || '—'}</td>
                      <td style={tdValue}>{h.endDate || '—'}</td>
                      <td style={tdValue}>{h.method || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>

      {/* ── Geological unit summary ────────────────────────────────────── */}
      <Card title="Geological units"
        subtitle={`${summary.units.length} unique codes · ranked by total thickness`}
        right={(
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={downloadAgsi}
              title="Download an AGSi-aligned JSON document with units + per-borehole layers"
              style={agsiButtonStyle}
            >
              Export AGSi JSON
            </button>
            {summary.units.length > 8 && (
              <button onClick={() => setShowAllUnits((v) => !v)} style={linkButtonStyle}>
                {showAllUnits ? 'Show top 8' : `Show all ${summary.units.length}`}
              </button>
            )}
          </div>
        )}>
        {summary.units.length === 0
          ? <div style={{ color: 'var(--muted)', fontSize: 12 }}>No GEOL rows with GEOL_GEOL/GEOL_LEG codes.</div>
          : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Code</th>
                  <th style={thStyle}>First description</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Layers</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Total (m)</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Mean (m)</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Range (m)</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Holes</th>
                </tr>
              </thead>
              <tbody>
                {visibleUnits.map((u) => (
                  <tr key={u.code}>
                    <td style={tdLabel}><code style={codeStyle}>{u.code}</code></td>
                    <td style={{ ...tdValue, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.description}>
                      {u.description || '—'}
                    </td>
                    <td style={tdValue}>{u.occurrences}</td>
                    <td style={tdValue}>{formatNum(u.totalThicknessM)}</td>
                    <td style={tdValue}>{formatNum(u.meanThicknessM)}</td>
                    <td style={tdValue}>{formatNum(u.minThicknessM)}–{formatNum(u.maxThicknessM)}</td>
                    <td style={tdValue}>{u.inHoles}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sortSchedule(rows: HoleScheduleEntry[], by: ScheduleSort): HoleScheduleEntry[] {
  const copy = [...rows];
  switch (by) {
    case 'id':    return copy.sort((a, b) => a.locaId.localeCompare(b.locaId, undefined, { numeric: true }));
    case 'depth': return copy.sort((a, b) => b.depthM - a.depthM);
    case 'type':  return copy.sort((a, b) => a.type.localeCompare(b.type) || a.locaId.localeCompare(b.locaId));
    case 'gl':    return copy.sort((a, b) => (b.groundLevel ?? -Infinity) - (a.groundLevel ?? -Infinity));
  }
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  return n.toFixed(2).replace(/\.?0+$/, '');
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Card({ title, subtitle, right, children }: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: 16,
    }}>
      {(title || right) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            {title && <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{title}</div>}
            {subtitle && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: 14,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text)', marginTop: 4, lineHeight: 1 }}>
        {value}
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function QualityBadge({ quality }: { quality: QualityReport }) {
  const gradeColors: Record<string, { bg: string; fg: string }> = {
    A: { bg: 'var(--green-soft)', fg: 'var(--green)' },
    B: { bg: 'var(--green-soft)', fg: 'var(--green)' },
    C: { bg: 'var(--amber-soft)', fg: 'var(--amber)' },
    D: { bg: 'var(--orange-soft)', fg: 'var(--orange)' },
    F: { bg: 'var(--red-soft)', fg: 'var(--red)' },
  };
  const c = gradeColors[quality.grade] ?? gradeColors.C!;
  return (
    <div style={{
      background: c.bg, border: `1px solid ${c.fg}`, borderRadius: 'var(--radius)',
      padding: '8px 16px', textAlign: 'center', minWidth: 100,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: c.fg }}>
        Data quality
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: c.fg, lineHeight: 1, marginTop: 2 }}>
        {quality.grade}
      </div>
      <div style={{ fontSize: 11, color: c.fg, marginTop: 2 }}>
        {quality.overall_score.toFixed(0)}/100
      </div>
    </div>
  );
}

function SortButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px', fontSize: 11, fontWeight: 600,
        background: active ? 'var(--accent-soft)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent-border)' : 'var(--border)'}`,
        color: active ? 'var(--accent)' : 'var(--text-dim)',
        borderRadius: 4,
      }}
    >
      {label}
    </button>
  );
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  borderBottom: '1px solid var(--border)',
  fontWeight: 700,
  color: 'var(--text-dim)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.3px',
  position: 'sticky',
  top: 0,
  background: 'var(--surface-muted)',
};
const tdLabel: React.CSSProperties = {
  padding: '6px 8px',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text)',
};
const tdValue: React.CSSProperties = {
  ...tdLabel,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};
const codeStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11,
  background: 'var(--surface-muted)',
  padding: '1px 5px',
  borderRadius: 3,
};
const linkButtonStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 11,
  fontWeight: 600,
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--accent)',
  borderRadius: 4,
};
const agsiButtonStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 11,
  fontWeight: 600,
  background: 'var(--accent-soft)',
  border: '1px solid var(--accent-border)',
  color: 'var(--accent)',
  borderRadius: 4,
};
