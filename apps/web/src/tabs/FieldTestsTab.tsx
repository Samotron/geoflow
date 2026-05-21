/**
 * Field Tests tab — consolidated view of all in-situ test groups in the file.
 *
 * Detects every group whose name matches a known in-situ test pattern
 * (ISPT, CPT/CPTU/CPTG, PMT*, DMT*, WSTK, I*) and shows for each:
 *   - count of records
 *   - depth or RL range
 *   - statistics for the group's principal value field
 *   - a sortable per-row table on demand
 */

import { useMemo, useState } from 'react';
import { parseStr, decodeBytes } from '../core.js';
import type { AgsFile, AgsGroup, AgsRow } from '../core.js';

interface Props {
  fileBytes: Uint8Array | null;
}

interface TestGroupDef {
  /** AGS group name. */
  name: string;
  /** Human-readable label. */
  label: string;
  /** Heading that holds the principal test depth (top of test). */
  depthField: string;
  /** Heading that holds the principal numeric value (or null when there isn't one obvious one). */
  valueField: string | null;
  valueLabel: string;
  valueUnits: string;
}

// Field test groups in AGS 4.x. The principal value field is the one most
// commonly used for plotting / engineering interpretation.
const KNOWN_FIELD_TESTS: TestGroupDef[] = [
  { name: 'ISPT', label: 'Standard Penetration Test',  depthField: 'ISPT_TOP', valueField: 'ISPT_NVAL', valueLabel: 'N',        valueUnits: 'blows/300mm' },
  { name: 'CPTU', label: 'CPT — cone resistance',      depthField: 'CPTU_DPTH', valueField: 'CPTU_QC',  valueLabel: 'qc',       valueUnits: 'MPa'        },
  { name: 'CPTG', label: 'CPT — general',              depthField: 'CPTG_DPTH', valueField: null,        valueLabel: '',         valueUnits: ''            },
  { name: 'PMTG', label: 'Pressuremeter — general',    depthField: 'PMTG_DPTH', valueField: null,        valueLabel: '',         valueUnits: ''            },
  { name: 'PMTU', label: 'Pressuremeter — limit press.',depthField: 'PMTU_DPTH', valueField: 'PMTU_PLM',  valueLabel: 'p_LM',     valueUnits: 'kPa'        },
  { name: 'PMTP', label: 'Pressuremeter — pressure',   depthField: 'PMTP_DPTH', valueField: 'PMTP_PRES', valueLabel: 'p',        valueUnits: 'kPa'        },
  { name: 'DMTG', label: 'Dilatometer — general',      depthField: 'DMTG_DPTH', valueField: null,        valueLabel: '',         valueUnits: ''            },
  { name: 'DMTU', label: 'Dilatometer — pressure',     depthField: 'DMTU_DPTH', valueField: 'DMTU_P0',   valueLabel: 'p0',       valueUnits: 'kPa'        },
  { name: 'WSTK', label: 'Water strike',               depthField: 'WSTK_DPTH', valueField: null,        valueLabel: '',         valueUnits: ''            },
  { name: 'IPRM', label: 'In-situ permeability',       depthField: 'IPRM_TOP',  valueField: 'IPRM_KVAL', valueLabel: 'k',        valueUnits: 'm/s'        },
  { name: 'IPRT', label: 'In-situ perm. (test detail)',depthField: 'IPRT_DPTH', valueField: 'IPRT_KVAL', valueLabel: 'k',        valueUnits: 'm/s'        },
  { name: 'ICBR', label: 'CBR (in-situ)',              depthField: 'ICBR_TOP',  valueField: 'ICBR_CBR',  valueLabel: 'CBR',      valueUnits: '%'          },
  { name: 'IDEN', label: 'In-situ density',            depthField: 'IDEN_TOP',  valueField: 'IDEN_BDEN', valueLabel: 'γ_bulk',   valueUnits: 'Mg/m³'      },
  { name: 'IRDX', label: 'In-situ redox potential',    depthField: 'IRDX_TOP',  valueField: 'IRDX_RDX',  valueLabel: 'Eh',       valueUnits: 'mV'         },
  { name: 'ISTX', label: 'In-situ triaxial',           depthField: 'ISTX_TOP',  valueField: 'ISTX_CU',   valueLabel: 'cu',       valueUnits: 'kPa'        },
  { name: 'INFO', label: 'Generic in-situ test info',  depthField: 'INFO_DPTH', valueField: null,        valueLabel: '',         valueUnits: ''            },
];

interface ValueStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
}

interface DepthStats {
  count: number;
  min: number;
  max: number;
}

interface FieldTestSummary {
  def: TestGroupDef;
  group: AgsGroup;
  totalRows: number;
  uniqueHoles: number;
  depthStats: DepthStats | null;
  valueStats: ValueStats | null;
  rows: AgsRow[];
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function statsOf(values: number[]): ValueStats {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
    median: sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!,
  };
}

function depthStatsOf(values: number[]): DepthStats {
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function summarize(file: AgsFile): FieldTestSummary[] {
  const out: FieldTestSummary[] = [];

  // Use known definitions plus any group beginning with "I" we don't know.
  const known = new Map(KNOWN_FIELD_TESTS.map((d) => [d.name, d]));
  for (const [groupName, group] of Object.entries(file.groups)) {
    let def = known.get(groupName);
    if (!def) {
      // Heuristic: AGS in-situ groups generally start with "I".
      if (!groupName.startsWith('I')) continue;
      def = { name: groupName, label: `${groupName} (in-situ)`, depthField: `${groupName}_DPTH`, valueField: null, valueLabel: '', valueUnits: '' };
    }

    const rows = group.rows;
    if (rows.length === 0) continue;

    const depths: number[] = [];
    const values: number[] = [];
    const holes = new Set<string>();
    for (const r of rows) {
      const d = num(r[def.depthField]) ?? num(r[`${def.name}_TOP`]) ?? num(r[`${def.name}_DPTH`]);
      if (d !== null) depths.push(d);
      if (def.valueField) {
        const v = num(r[def.valueField]);
        if (v !== null) values.push(v);
      }
      const loca = String(r['LOCA_ID'] ?? '');
      if (loca) holes.add(loca);
    }

    out.push({
      def,
      group,
      totalRows: rows.length,
      uniqueHoles: holes.size,
      depthStats: depths.length > 0 ? depthStatsOf(depths) : null,
      valueStats: values.length > 0 ? statsOf(values) : null,
      rows,
    });
  }

  return out.sort((a, b) => b.totalRows - a.totalRows);
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(2).replace(/\.?0+$/, '');
  return n.toPrecision(3);
}

export function FieldTestsTab({ fileBytes }: Props) {
  const summaries = useMemo<FieldTestSummary[]>(() => {
    if (!fileBytes) return [];
    try {
      const { file } = parseStr(decodeBytes(fileBytes));
      return summarize(file);
    } catch {
      return [];
    }
  }, [fileBytes]);

  const [expanded, setExpanded] = useState<string | null>(null);

  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
        Drop an AGS file above to see all in-situ tests.
      </div>
    );
  }

  if (summaries.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
        No in-situ test groups detected in this file.
        <div style={{ fontSize: 12, marginTop: 8 }}>
          Looked for: ISPT, CPTU/G, PMT*, DMT*, WSTK, I*.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        Showing <strong>{summaries.length}</strong> in-situ test group{summaries.length !== 1 ? 's' : ''} with{' '}
        <strong>{summaries.reduce((a, b) => a + b.totalRows, 0)}</strong> total records.
      </div>

      {summaries.map((s) => (
        <div key={s.def.name} style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', overflow: 'hidden',
        }}>
          {/* Header strip */}
          <div
            onClick={() => setExpanded((cur) => (cur === s.def.name ? null : s.def.name))}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
              cursor: 'pointer', borderBottom: expanded === s.def.name ? '1px solid var(--border)' : 'none',
              background: expanded === s.def.name ? 'var(--surface-muted)' : 'transparent',
            }}
          >
            <code style={{
              fontFamily: 'ui-monospace, monospace', fontSize: 12,
              background: 'var(--accent-soft)', color: 'var(--accent)',
              padding: '3px 9px', borderRadius: 4, fontWeight: 700,
            }}>
              {s.def.name}
            </code>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{s.def.label}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                {s.totalRows} record{s.totalRows !== 1 ? 's' : ''} · {s.uniqueHoles} hole{s.uniqueHoles !== 1 ? 's' : ''}
                {s.depthStats && <> · depth {fmt(s.depthStats.min)}–{fmt(s.depthStats.max)} m</>}
              </div>
            </div>
            {s.valueStats && (
              <div style={{ display: 'flex', gap: 16, fontSize: 11 }}>
                <Stat label={`min ${s.def.valueLabel}`} value={fmt(s.valueStats.min)} units={s.def.valueUnits} />
                <Stat label="median"                   value={fmt(s.valueStats.median)} units={s.def.valueUnits} />
                <Stat label={`max ${s.def.valueLabel}`} value={fmt(s.valueStats.max)} units={s.def.valueUnits} />
              </div>
            )}
            <span style={{
              fontSize: 14, color: 'var(--muted)',
              transform: expanded === s.def.name ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s',
            }}>▶</span>
          </div>

          {/* Expanded row table */}
          {expanded === s.def.name && (
            <div style={{ maxHeight: 400, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-muted)' }}>
                    {s.group.headings.slice(0, 8).map((h) => (
                      <th key={h.name} style={{
                        padding: '6px 10px', textAlign: 'left',
                        fontSize: 11, fontWeight: 700, color: 'var(--text-dim)',
                        textTransform: 'uppercase', letterSpacing: '0.3px',
                        position: 'sticky', top: 0, background: 'var(--surface-muted)',
                        whiteSpace: 'nowrap',
                      }}>{h.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {s.rows.slice(0, 200).map((row, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                      {s.group.headings.slice(0, 8).map((h) => (
                        <td key={h.name} style={{
                          padding: '4px 10px', whiteSpace: 'nowrap',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {row[h.name] == null ? '—' : String(row[h.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {s.rows.length > 200 && (
                <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--muted)' }}>
                  Showing first 200 of {s.rows.length} records — open the Data tab to view all.
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, units }: { label: string; value: string; units: string }) {
  return (
    <div style={{ textAlign: 'right', minWidth: 60 }}>
      <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.3px', color: 'var(--muted)', fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
        {value}<span style={{ fontSize: 9, fontWeight: 400, color: 'var(--muted)', marginLeft: 2 }}>{units}</span>
      </div>
    </div>
  );
}
