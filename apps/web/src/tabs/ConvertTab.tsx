import { useState } from 'react';
import { decodeBytes, parseStr, writeDiggs, readDiggs, serialize } from '../core.js';
import { exportExcel } from '../export/excel.js';
import { exportGeopackage } from '../export/geopackage.js';
import { exportAsDuckDb } from '../query/duckdb.js';
import { downloadBlob, exportBaseName, exportDatePrefix, toCsvRow } from '../export/utils.js';
import type { AgsFile } from '../core.js';

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
}

interface Status {
  ok: boolean;
  message: string;
}

function isDiggs(name: string | undefined): boolean {
  if (!name) return false;
  return name.endsWith('.diggs') || name.endsWith('.xml');
}

// ── Section wrapper ────────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      overflow: 'hidden',
      marginBottom: 16,
    }}>
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        background: '#f8fafc',
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        color: 'var(--muted)',
      }}>
        {title}
      </div>
      <div style={{ padding: '16px' }}>
        {children}
      </div>
    </div>
  );
}

// ── Export button with label + description ─────────────────────────────────────

function ExportButton({
  label,
  ext,
  description,
  color,
  onClick,
  disabled,
}: {
  label: string;
  ext: string;
  description: string;
  color: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
        padding: '12px 16px',
        background: disabled ? '#f1f5f9' : color,
        color: disabled ? 'var(--muted)' : '#fff',
        border: 'none',
        borderRadius: 'var(--radius)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        minWidth: 160,
        opacity: disabled ? 0.6 : 1,
        transition: 'opacity .15s',
        textAlign: 'left',
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 11, opacity: 0.85 }}>{ext} · {description}</span>
    </button>
  );
}

// ── CSV all-groups export ──────────────────────────────────────────────────────

function exportAllCsvZip(agsFile: AgsFile, fileName: string | undefined) {
  const date = exportDatePrefix();
  const base = exportBaseName(fileName);
  for (const [groupName, group] of Object.entries(agsFile.groups)) {
    if (!group) continue;
    const headings = group.headings.map((h) => h.name);
    const rows = group.rows.map((row) => toCsvRow(headings, row));
    downloadBlob(
      [headings.join(','), ...rows].join('\n'),
      `${date}-${base}-${groupName}.csv`,
      'text/csv',
    );
  }
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ConvertTab({ fileBytes, fileName }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const withStatus = async (fn: () => Promise<void> | void) => {
    setRunning(true);
    setStatus(null);
    setProgress(null);
    try {
      await fn();
      setStatus({ ok: true, message: 'Done.' });
    } catch (e) {
      setStatus({ ok: false, message: String(e) });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  // ── Parse once when we need it ─────────────────────────────────────────────
  const getAgsFile = (): AgsFile => {
    if (!fileBytes) throw new Error('No file loaded');
    return parseStr(decodeBytes(fileBytes)).file;
  };

  const asDiggs = isDiggs(fileName);
  const hasFile = !!fileBytes;

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleAgsToDiggs = () => withStatus(() => {
    const text = decodeBytes(fileBytes!);
    const { xml, report } = writeDiggs(parseStr(text).file);
    const base = exportBaseName(fileName);
    downloadBlob(xml, `${exportDatePrefix()}-${base}.diggs`, 'application/xml');
    const g = report.generic_groups.length;
    setStatus({
      ok: true,
      message: `Converted.${g > 0 ? ` ${g} group(s) written as generic DataGroup.` : ''}`,
    });
  });

  const handleDiggsToAgs = () => withStatus(() => {
    const text = decodeBytes(fileBytes!);
    const agsFile = readDiggs(text);
    const base = exportBaseName(fileName);
    downloadBlob(
      serialize(agsFile),
      `${exportDatePrefix()}-${base}.ags`,
      'text/plain',
    );
    setStatus({ ok: true, message: 'Converted DIGGS → AGS.' });
  });

  const handleCsv = () => withStatus(() => exportAllCsvZip(getAgsFile(), fileName));

  const handleExcel = () => withStatus(() => exportExcel(getAgsFile(), fileName));

  const handleGeopackage = () => withStatus(async () => {
    await exportGeopackage(getAgsFile(), fileName, (msg) => setProgress(msg));
  });

  const handleDuckDb = () => withStatus(async () => {
    await exportAsDuckDb(getAgsFile(), fileName, (msg) => setProgress(msg));
  });

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!hasFile) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
        <p>Drop an .ags or .diggs/.xml file above to convert or export it.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Format badge */}
      <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--muted)' }}>
        Detected format:{' '}
        <strong style={{ color: 'var(--text)' }}>{asDiggs ? 'DIGGS / XML' : 'AGS'}</strong>
      </div>

      {/* Convert section */}
      <Section title="Convert">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {!asDiggs && (
            <ExportButton
              label="AGS → DIGGS"
              ext=".diggs"
              description="DIGGS 2.6 XML"
              color="var(--navy)"
              onClick={handleAgsToDiggs}
              disabled={running}
            />
          )}
          {asDiggs && (
            <ExportButton
              label="DIGGS → AGS"
              ext=".ags"
              description="AGS 4 text"
              color="var(--navy)"
              onClick={handleDiggsToAgs}
              disabled={running}
            />
          )}
        </div>
      </Section>

      {/* Export section — AGS only */}
      {!asDiggs && (
        <Section title="Export">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <ExportButton
              label="CSV"
              ext=".csv"
              description="One file per group"
              color="#0f766e"
              onClick={handleCsv}
              disabled={running}
            />
            <ExportButton
              label="Excel"
              ext=".xlsx"
              description="All groups, one workbook"
              color="#15803d"
              onClick={handleExcel}
              disabled={running}
            />
            <ExportButton
              label="GeoPackage"
              ext=".gpkg"
              description="Spatial SQLite + styles"
              color="#b45309"
              onClick={handleGeopackage}
              disabled={running}
            />
            <ExportButton
              label="DuckDB"
              ext=".duckdb"
              description="Queryable analytics file"
              color="#7c3aed"
              onClick={handleDuckDb}
              disabled={running}
            />
          </div>

          {/* Format notes */}
          <div style={{
            marginTop: 14,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 10,
          }}>
            {[
              { label: 'CSV', detail: 'Heading + unit rows, one file per group. Named YYYY-MM-DD-{file}-{GROUP}.csv.' },
              { label: 'Excel', detail: 'Multi-sheet workbook. Header bold, units row, frozen panes, auto column widths.' },
              { label: 'GeoPackage', detail: 'LOCA as spatial point layer (WGS 84). All groups as attribute tables. LOCA↔group relationships via Related Tables Extension. QGIS point style included.' },
              { label: 'DuckDB', detail: 'Native DuckDB database file. Open directly in DuckDB CLI, DuckDB Desktop, or any DuckDB client. All groups as tables with full SQL support.' },
            ].map(({ label, detail }) => (
              <div key={label} style={{
                background: '#f8fafc',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '10px 12px',
                fontSize: 12,
              }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
                <div style={{ color: 'var(--muted)', lineHeight: 1.5 }}>{detail}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Progress indicator */}
      {progress && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
          {progress}
        </div>
      )}

      {/* Status banner */}
      {status && (
        <div style={{
          marginTop: 12,
          background: status.ok ? '#f0fdf4' : '#fef2f2',
          border: `1px solid ${status.ok ? '#bbf7d0' : '#fecaca'}`,
          borderRadius: 'var(--radius)',
          padding: '10px 14px',
          color: status.ok ? 'var(--green)' : 'var(--red)',
          fontSize: 13,
        }}>
          {status.ok ? '✓ ' : '✗ '}{status.message}
        </div>
      )}
    </div>
  );
}
