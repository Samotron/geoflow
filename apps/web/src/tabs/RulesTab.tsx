import { useMemo, useState } from 'react';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile } from '../core.js';
import { DiagnosticsPanel } from '../App.js';
import type { PackDiagnostic } from '../types.js';

interface Props {
  fileBytes: Uint8Array | null;
}

// ── Plain-language catalog ──────────────────────────────────────────────────

type CheckKind =
  | 'required' | 'unique' | 'foreign_key' | 'one_of' | 'compare' | 'range'
  | 'monotonic' | 'pattern' | 'group_exists' | 'group_size' | 'heading_present'
  | 'depth_unit' | 'expr';

interface KindMeta {
  kind: CheckKind;
  label: string;
  blurb: string;
  example: string;
  scope: 'row' | 'group' | 'file';
  needsGroup: boolean;
}

const KINDS: KindMeta[] = [
  { kind: 'required',        label: 'Required columns',           blurb: 'Make sure these columns are filled in for every row.',         example: 'In LOCA, every row must have LOCA_ID filled in.',                          scope: 'row',   needsGroup: true  },
  { kind: 'unique',          label: 'No duplicates',              blurb: 'These columns together must be unique across the group.',      example: 'In LOCA, LOCA_ID must be unique (no duplicate boreholes).',                scope: 'group', needsGroup: true  },
  { kind: 'foreign_key',     label: 'Must exist in another group',blurb: 'Values must match a record in another group.',                  example: 'Every SAMP.LOCA_ID must already exist in LOCA.',                           scope: 'row',   needsGroup: true  },
  { kind: 'one_of',          label: 'Must be one of these values',blurb: 'Value must be in a fixed list or named codelist.',              example: 'SAMP_TYPE must be one of B, U, D.',                                        scope: 'row',   needsGroup: true  },
  { kind: 'compare',         label: 'Compare two columns',        blurb: 'Compare two columns (or a column vs. a number).',               example: 'GEOL_BASE must be greater than GEOL_TOP.',                                 scope: 'row',   needsGroup: true  },
  { kind: 'range',           label: 'Number in range',            blurb: 'A number must be within a min/max range.',                     example: 'GEOL_TOP must be between 0 and 1000.',                                     scope: 'row',   needsGroup: true  },
  { kind: 'monotonic',       label: 'Must be in order',           blurb: 'Values must increase from one row to the next.',               example: 'GEOL_TOP must increase down each borehole.',                               scope: 'group', needsGroup: true  },
  { kind: 'pattern',         label: 'Must match a format',        blurb: 'Value must match a regular-expression pattern.',                example: 'LOCA_ID must look like "BH" followed by digits.',                          scope: 'row',   needsGroup: true  },
  { kind: 'group_exists',    label: 'Group must exist',           blurb: 'A named group must be present in the file.',                   example: 'The PROJ group must be present.',                                          scope: 'file',  needsGroup: false },
  { kind: 'group_size',      label: 'Group must have N rows',     blurb: 'A named group must have a specific number of rows.',           example: 'PROJ must have exactly 1 row.',                                            scope: 'file',  needsGroup: false },
  { kind: 'heading_present', label: 'Column must exist',          blurb: 'A specific column must be declared in a group.',                example: 'TRAN must declare a TRAN_AGS column.',                                     scope: 'file',  needsGroup: false },
  { kind: 'depth_unit',      label: 'Depth columns use a unit',   blurb: 'Listed depth columns must all carry the same unit (e.g. m).',  example: 'GEOL_TOP and GEOL_BASE must be in metres.',                                scope: 'file',  needsGroup: false },
  { kind: 'expr',            label: 'Advanced (JEXL)',            blurb: 'Escape hatch: write a JEXL expression that must be true.',     example: 'row.GEOL_TOP >= 0 && row.GEOL_BASE <= 100',                                scope: 'row',   needsGroup: true  },
];

const COMPARE_OPS = [
  { op: '>',  label: 'greater than' },
  { op: '>=', label: 'greater than or equal to' },
  { op: '<',  label: 'less than' },
  { op: '<=', label: 'less than or equal to' },
  { op: '==', label: 'equal to' },
  { op: '!=', label: 'not equal to' },
] as const;

const SEVERITY_BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  error:   { bg: 'var(--red-soft)',    fg: 'var(--red)',    label: 'error'   },
  warning: { bg: 'var(--orange-soft)', fg: 'var(--orange)', label: 'warning' },
  info:    { bg: 'var(--surface-muted)', fg: 'var(--muted)', label: 'info'   },
};

// ── State types ─────────────────────────────────────────────────────────────

type EvalStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; diagnostics: PackDiagnostic[] };

// Internal structured rule representation. We synthesize YAML from this when
// running, and round-trip from YAML via the same engine. Keeping the rules as
// state lets us render plain-English cards and delete/edit without parsing.
interface SimpleRule {
  id: string;
  description?: string;
  severity: 'error' | 'warning' | 'info';
  group?: string;
  kind: CheckKind;
  // Per-kind state. Only the fields relevant to `kind` are used.
  fields?: string[];
  refGroup?: string;
  field?: string;
  field2?: string;
  op?: typeof COMPARE_OPS[number]['op'];
  rhs?: string;
  rhsIsField?: boolean;
  values?: string[];
  codelistName?: string;
  codelistInline?: string[];
  min?: string;
  max?: string;
  partitionBy?: string;
  regex?: string;
  unit?: string;
  heading?: string;
  groupName?: string;
  sizeMode?: 'equals' | 'range';
  equals?: string;
  expr?: string;
  message?: string;
}

// ── Quick-start templates ───────────────────────────────────────────────────

interface Template {
  title: string;
  emoji: string;
  rule: SimpleRule;
}

const TEMPLATES: Template[] = [
  {
    title: 'Every borehole must have an ID',
    emoji: '🪪',
    rule: { id: 'LOCA-ID-REQUIRED', severity: 'error', group: 'LOCA', kind: 'required', fields: ['LOCA_ID'] },
  },
  {
    title: 'No duplicate boreholes',
    emoji: '👯',
    rule: { id: 'LOCA-ID-UNIQUE', severity: 'error', group: 'LOCA', kind: 'unique', fields: ['LOCA_ID'] },
  },
  {
    title: 'Boreholes must have coordinates',
    emoji: '📍',
    rule: { id: 'LOCA-COORDS', severity: 'error', group: 'LOCA', kind: 'required', fields: ['LOCA_NATE', 'LOCA_NATN'] },
  },
  {
    title: 'Samples must reference a borehole',
    emoji: '🔗',
    rule: { id: 'SAMP-PARENT', severity: 'error', group: 'SAMP', kind: 'foreign_key', fields: ['LOCA_ID'], refGroup: 'LOCA' },
  },
  {
    title: 'Geology depths must go down (not up)',
    emoji: '⬇️',
    rule: { id: 'GEOL-ORDER', severity: 'error', group: 'GEOL', kind: 'monotonic', field: 'GEOL_TOP', partitionBy: 'LOCA_ID' },
  },
  {
    title: 'Layer base must be below layer top',
    emoji: '↕️',
    rule: { id: 'GEOL-DEPTHS', severity: 'error', group: 'GEOL', kind: 'compare', field: 'GEOL_BASE', op: '>', field2: 'GEOL_TOP', rhsIsField: true },
  },
];

// ── YAML serialization ──────────────────────────────────────────────────────

function quote(s: string): string {
  if (s === '') return '""';
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;
  return JSON.stringify(s);
}

function listYaml(items: string[]): string {
  return `[${items.map(quote).join(', ')}]`;
}

function ruleToYaml(r: SimpleRule): string {
  const lines: string[] = [`  - id: ${r.id}`];
  if (r.description?.trim()) lines.push(`    description: ${JSON.stringify(r.description)}`);
  lines.push(`    severity: ${r.severity}`);
  const meta = KINDS.find(k => k.kind === r.kind)!;
  if (meta.needsGroup && r.group?.trim()) lines.push(`    in: ${r.group.trim()}`);

  const fields = r.fields ?? [];

  switch (r.kind) {
    case 'required': lines.push(`    check: { required: ${listYaml(fields)} }`); break;
    case 'unique':   lines.push(`    check: { unique: ${listYaml(fields)} }`); break;
    case 'foreign_key':
      lines.push(`    check:`);
      lines.push(`      foreign_key:`);
      lines.push(`        fields: ${listYaml(fields)}`);
      lines.push(`        references: ${r.refGroup ?? 'LOCA'}`);
      break;
    case 'one_of':
      if (r.codelistInline && r.codelistInline.length > 0) {
        lines.push(`    check: { one_of: { field: ${quote(r.field ?? '')}, values: ${listYaml(r.codelistInline)} } }`);
      } else {
        lines.push(`    check: { one_of: { field: ${quote(r.field ?? '')}, codelist: ${quote(r.codelistName ?? 'codes')} } }`);
      }
      break;
    case 'compare': {
      const right = r.rhsIsField ? quote(r.field2 ?? '') : (
        Number.isFinite(Number(r.rhs)) && (r.rhs ?? '').trim() !== '' ? r.rhs! : JSON.stringify(r.rhs ?? '')
      );
      lines.push(`    check: { compare: { left: ${quote(r.field ?? '')}, op: ${JSON.stringify(r.op ?? '>')}, right: ${right} } }`);
      break;
    }
    case 'range': {
      const parts: string[] = [`field: ${quote(r.field ?? '')}`];
      if ((r.min ?? '').trim() !== '') parts.push(`min: ${r.min!.trim()}`);
      if ((r.max ?? '').trim() !== '') parts.push(`max: ${r.max!.trim()}`);
      lines.push(`    check: { range: { ${parts.join(', ')} } }`);
      break;
    }
    case 'monotonic': {
      const parts: string[] = [`field: ${quote(r.field ?? '')}`];
      if ((r.partitionBy ?? '').trim() !== '') parts.push(`partition_by: ${quote(r.partitionBy!)}`);
      lines.push(`    check: { monotonic: { ${parts.join(', ')} } }`);
      break;
    }
    case 'pattern':
      lines.push(`    check: { pattern: { field: ${quote(r.field ?? '')}, regex: ${JSON.stringify(r.regex ?? '')} } }`);
      break;
    case 'group_exists':
      lines.push(`    check: { group_exists: ${quote(r.groupName ?? '')} }`);
      break;
    case 'group_size': {
      const parts: string[] = [`group: ${quote(r.groupName ?? '')}`];
      if (r.sizeMode === 'equals' && (r.equals ?? '').trim() !== '') parts.push(`equals: ${r.equals!.trim()}`);
      if (r.sizeMode === 'range') {
        if ((r.min ?? '').trim() !== '') parts.push(`min: ${r.min!.trim()}`);
        if ((r.max ?? '').trim() !== '') parts.push(`max: ${r.max!.trim()}`);
      }
      lines.push(`    check: { group_size: { ${parts.join(', ')} } }`);
      break;
    }
    case 'heading_present':
      lines.push(`    check: { heading_present: { group: ${quote(r.groupName ?? '')}, heading: ${quote(r.heading ?? '')} } }`);
      break;
    case 'depth_unit': {
      const parts: string[] = [];
      if (fields.length) parts.push(`headings: ${listYaml(fields)}`);
      parts.push(`unit: ${quote(r.unit ?? 'm')}`);
      lines.push(`    check: { depth_unit: { ${parts.join(', ')} } }`);
      break;
    }
    case 'expr':
      lines.push(`    check: { expr: ${JSON.stringify(r.expr ?? '')} }`);
      break;
  }

  if (r.message?.trim()) lines.push(`    message: ${JSON.stringify(r.message)}`);
  return lines.join('\n');
}

function packToYaml(name: string, rules: SimpleRule[], codelists: Record<string, string[]>): string {
  const lines: string[] = [`version: 1`, `name: ${quote(name)}`];
  const usedCodelists = Object.entries(codelists).filter(([_, vals]) => vals.length > 0);
  if (usedCodelists.length > 0) {
    lines.push('', 'codelists:');
    for (const [id, vals] of usedCodelists) {
      lines.push(`  ${id}:`, `    inline: ${listYaml(vals)}`);
    }
  }
  lines.push('', 'rules:');
  if (rules.length === 0) {
    lines.push('  []');
  } else {
    for (const r of rules) lines.push(ruleToYaml(r));
  }
  return lines.join('\n');
}

// ── Plain-English rule describer ────────────────────────────────────────────

function describeRule(r: SimpleRule): string {
  const where = r.group ? ` in ${r.group}` : '';
  const fields = r.fields ?? [];
  const fieldList = (sep = ', ') => fields.join(sep);

  switch (r.kind) {
    case 'required':
      return `Every row${where} must have ${fieldList(' and ')} filled in.`;
    case 'unique':
      return fields.length > 1
        ? `${fieldList(' + ')}${where} must be a unique combination (no duplicates).`
        : `${fieldList()}${where} must be unique (no duplicates).`;
    case 'foreign_key':
      return `Every ${fieldList(' / ')}${where} must already exist in ${r.refGroup ?? '?'}.`;
    case 'one_of': {
      const list = r.codelistInline && r.codelistInline.length > 0
        ? r.codelistInline.join(', ')
        : `the "${r.codelistName ?? 'codes'}" list`;
      return `${r.field ?? '?'}${where} must be one of: ${list}.`;
    }
    case 'compare': {
      const opLabel = COMPARE_OPS.find(o => o.op === r.op)?.label ?? r.op;
      const right = r.rhsIsField ? r.field2 ?? '?' : r.rhs ?? '?';
      return `${r.field ?? '?'}${where} must be ${opLabel} ${right}.`;
    }
    case 'range': {
      const minS = (r.min ?? '').trim();
      const maxS = (r.max ?? '').trim();
      if (minS && maxS) return `${r.field ?? '?'}${where} must be between ${minS} and ${maxS}.`;
      if (minS)         return `${r.field ?? '?'}${where} must be at least ${minS}.`;
      if (maxS)         return `${r.field ?? '?'}${where} must be at most ${maxS}.`;
      return `${r.field ?? '?'}${where} must be numeric.`;
    }
    case 'monotonic':
      return r.partitionBy
        ? `${r.field ?? '?'}${where} must increase from one row to the next, for each ${r.partitionBy}.`
        : `${r.field ?? '?'}${where} must increase from one row to the next.`;
    case 'pattern':
      return `${r.field ?? '?'}${where} must match the pattern \`${r.regex ?? ''}\`.`;
    case 'group_exists':
      return `The ${r.groupName ?? '?'} group must be present in the file.`;
    case 'group_size': {
      if (r.sizeMode === 'equals') return `The ${r.groupName ?? '?'} group must have exactly ${r.equals ?? '?'} row(s).`;
      const minS = (r.min ?? '').trim();
      const maxS = (r.max ?? '').trim();
      if (minS && maxS) return `The ${r.groupName ?? '?'} group must have between ${minS} and ${maxS} rows.`;
      if (minS)         return `The ${r.groupName ?? '?'} group must have at least ${minS} row(s).`;
      if (maxS)         return `The ${r.groupName ?? '?'} group must have at most ${maxS} row(s).`;
      return `The ${r.groupName ?? '?'} group has a size constraint.`;
    }
    case 'heading_present':
      return `The ${r.groupName ?? '?'} group must declare a ${r.heading ?? '?'} column.`;
    case 'depth_unit':
      return fields.length > 0
        ? `Depth columns ${fields.join(', ')} must use unit "${r.unit ?? 'm'}".`
        : `All depth columns must use unit "${r.unit ?? 'm'}".`;
    case 'expr':
      return `Advanced rule: ${r.expr ?? ''}`;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function autoId(rules: SimpleRule[], kind: CheckKind, group?: string): string {
  const stem = group ? `${group}-${kind.toUpperCase()}` : kind.toUpperCase();
  let n = 1;
   
  while (true) {
    const candidate = `${stem}-${String(n).padStart(3, '0')}`;
    if (!rules.some(r => r.id === candidate)) return candidate;
    n++;
  }
}

function parseList(input: string): string[] {
  return input.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

// ── Component ───────────────────────────────────────────────────────────────

export function RulesTab({ fileBytes }: Props) {
  const [rules, setRules] = useState<SimpleRule[]>([]);
  const [editing, setEditing] = useState<{ index: number | null; draft: SimpleRule } | null>(null);
  const [showYaml, setShowYaml] = useState(false);
  const [status, setStatus] = useState<EvalStatus>({ kind: 'idle' });

  // Parse the loaded file once and extract groups + headings for autocomplete.
  const parsedFile: AgsFile | null = useMemo(() => {
    if (!fileBytes) return null;
    try {
      const text = decodeBytes(fileBytes);
      return parseStr(text).file;
    } catch { return null; }
  }, [fileBytes]);

  const suggestedGroups = useMemo(() => {
    if (parsedFile) return Object.keys(parsedFile.groups);
    return ['LOCA', 'GEOL', 'SAMP', 'CHEM', 'PROJ', 'TRAN', 'ABBR', 'UNIT', 'TYPE'];
  }, [parsedFile]);

  const headingsFor = (group: string | undefined): string[] => {
    if (!parsedFile || !group) return [];
    return parsedFile.groups[group]?.headings.map(h => h.name) ?? [];
  };

  const allHeadings = useMemo(() => {
    if (!parsedFile) return [];
    const set = new Set<string>();
    for (const g of Object.values(parsedFile.groups)) for (const h of g.headings) set.add(h.name);
    return Array.from(set).sort();
  }, [parsedFile]);

  const yaml = useMemo(() => {
    const codelists: Record<string, string[]> = {};
    for (const r of rules) {
      if (r.kind === 'one_of' && r.codelistName && r.codelistInline && r.codelistInline.length > 0) {
        codelists[r.codelistName] = r.codelistInline;
      }
    }
    return packToYaml('my-rules', rules, codelists);
  }, [rules]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const addTemplate = (tpl: Template) => {
    const r = { ...tpl.rule };
    r.id = autoId(rules, r.kind, r.group);
    setRules([...rules, r]);
  };

  const startAdd = () => {
    const firstGroup = suggestedGroups[0] ?? 'LOCA';
    const draft: SimpleRule = { id: '', severity: 'error', kind: 'required', group: firstGroup, fields: [] };
    draft.id = autoId(rules, draft.kind, draft.group);
    setEditing({ index: null, draft });
  };

  const startEdit = (i: number) => setEditing({ index: i, draft: { ...rules[i]! } });

  const cancelEdit = () => setEditing(null);

  const saveEdit = () => {
    if (!editing) return;
    const next = [...rules];
    if (editing.index === null) next.push(editing.draft);
    else next[editing.index] = editing.draft;
    setRules(next);
    setEditing(null);
  };

  const deleteRule = (i: number) => {
    if (!confirm(`Delete rule ${rules[i]!.id}?`)) return;
    setRules(rules.filter((_, j) => j !== i));
  };

  const run = async () => {
    if (!fileBytes) return;
    setStatus({ kind: 'running' });

    let agsFile: AgsFile;
    try {
      const text = decodeBytes(fileBytes);
      agsFile = parseStr(text).file;
    } catch (e) {
      setStatus({ kind: 'error', message: `Failed to parse AGS file: ${String(e)}` });
      return;
    }

    try {
      const mod = await import('@geoflow/rules-engine');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const evaluatePackYaml = (mod as any).evaluatePackYaml as
        | ((yaml: string, file: AgsFile) => PackDiagnostic[])
        | undefined;
      if (typeof evaluatePackYaml !== 'function') { setStatus({ kind: 'unavailable' }); return; }
      const diagnostics = evaluatePackYaml(yaml, agsFile);
      setStatus({ kind: 'done', diagnostics });
    } catch (e) {
      const msg = String(e);
      if (msg.includes('not found') || msg.includes('Cannot find') || msg.includes('MODULE_NOT_FOUND') || msg.includes('PACKAGE_NAME')) {
        setStatus({ kind: 'unavailable' });
      } else {
        setStatus({ kind: 'error', message: msg });
      }
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <div style={{ marginBottom: 14, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
        Build validation rules in plain English. No coding needed — pick what to check, point at your columns,
        and the rule is described back to you as it will appear in the file.
      </div>

      {/* Quick-start strip */}
      {rules.length === 0 && !editing && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            Quick start — one-click common rules
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {TEMPLATES.map((t, i) => (
              <button
                key={i}
                onClick={() => addTemplate(t)}
                style={{
                  textAlign: 'left', padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'center',
                  background: 'var(--surface-muted)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 12, color: 'var(--text)',
                }}
              >
                <span style={{ fontSize: 18 }}>{t.emoji}</span>
                <span>{t.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Rule list */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Your rules ({rules.length})
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setShowYaml(s => !s)}
              style={{ background: 'transparent', border: '1px solid var(--border)', fontSize: 11, padding: '4px 10px', color: 'var(--muted)' }}
            >
              {showYaml ? 'Hide YAML' : 'Show YAML'}
            </button>
            {!editing && (
              <button
                onClick={startAdd}
                style={{ background: 'var(--navy)', color: '#fff', fontSize: 12, padding: '5px 12px' }}
              >
                + Add a rule
              </button>
            )}
          </div>
        </div>

        {rules.length === 0 && !editing && (
          <div style={{ padding: 16, textAlign: 'center', background: 'var(--surface-muted)', border: '1px dashed var(--border)', borderRadius: 'var(--radius)', fontSize: 13, color: 'var(--muted)' }}>
            No rules yet. Pick a quick-start above, or click <strong>+ Add a rule</strong>.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rules.map((r, i) => {
            const sev = SEVERITY_BADGE[r.severity] ?? SEVERITY_BADGE.error!;
            return (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                }}
              >
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 3,
                  background: sev.bg, color: sev.fg, textTransform: 'uppercase', letterSpacing: 0.3, minWidth: 50, textAlign: 'center',
                }}>{sev.label}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.4 }}>
                    {describeRule(r)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace', marginTop: 1 }}>{r.id}</div>
                </div>
                <button onClick={() => startEdit(i)} style={{ background: 'transparent', border: '1px solid var(--border)', fontSize: 11, padding: '4px 10px', color: 'var(--muted)' }}>Edit</button>
                <button onClick={() => deleteRule(i)} style={{ background: 'transparent', border: '1px solid var(--border)', fontSize: 11, padding: '4px 10px', color: 'var(--red)' }}>Delete</button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Builder panel */}
      {editing && (
        <RuleBuilder
          draft={editing.draft}
          isNew={editing.index === null}
          rules={rules}
          suggestedGroups={suggestedGroups}
          headingsFor={headingsFor}
          allHeadings={allHeadings}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onSave={saveEdit}
          onCancel={cancelEdit}
        />
      )}

      {/* YAML view (collapsed by default) */}
      {showYaml && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
            YAML (read-only preview — your rules expressed in the GeoFlow rule format)
          </div>
          <pre style={{
            background: 'var(--text)', color: 'var(--border)',
            padding: 12, borderRadius: 'var(--radius)', fontSize: 12, lineHeight: 1.5,
            overflow: 'auto', maxHeight: 400, margin: 0,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          }}>{yaml}</pre>
        </div>
      )}

      {/* Run */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, marginBottom: 16 }}>
        <button
          onClick={() => { void run(); }}
          disabled={!fileBytes || status.kind === 'running' || rules.length === 0}
          style={{
            background: 'var(--navy)', color: '#fff', fontSize: 13, padding: '8px 18px',
            opacity: !fileBytes || status.kind === 'running' || rules.length === 0 ? 0.4 : 1,
          }}
        >
          {status.kind === 'running' ? 'Checking…' : `Check ${rules.length} rule${rules.length === 1 ? '' : 's'} against the file`}
        </button>
        {!fileBytes && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Drop an AGS file above first.</span>}
      </div>

      {status.kind === 'unavailable' && (
        <div style={{ background: 'var(--orange-soft)', border: '1px solid var(--orange-border)', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--orange)', fontSize: 13 }}>
          Rules engine not available.
        </div>
      )}
      {status.kind === 'error' && (
        <div style={{ background: 'var(--red-soft)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)', fontSize: 13, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          {status.message}
        </div>
      )}
      {status.kind === 'done' && (
        <DiagnosticsPanel
          title="Results"
          items={status.diagnostics.map((d) => ({
            rule_id: d.rule_id, severity: d.severity, message: d.message,
            group: d.location.group, row_index: d.location.row_index,
          }))}
        />
      )}
    </div>
  );
}

// ── Rule builder panel ──────────────────────────────────────────────────────

interface BuilderProps {
  draft: SimpleRule;
  isNew: boolean;
  rules: SimpleRule[];
  suggestedGroups: string[];
  headingsFor: (group: string | undefined) => string[];
  allHeadings: string[];
  onChange: (next: SimpleRule) => void;
  onSave: () => void;
  onCancel: () => void;
}

function RuleBuilder(props: BuilderProps) {
  const { draft, isNew, rules, suggestedGroups, headingsFor, allHeadings, onChange, onSave, onCancel } = props;
  const meta = KINDS.find(k => k.kind === draft.kind)!;
  const groupHeadings = headingsFor(draft.group);
  const refHeadings = headingsFor(draft.refGroup);
  const sizeGroupHeadings = headingsFor(draft.groupName);

  // When user changes the kind or group, refresh the auto-ID (only if it wasn't manually edited away from the auto pattern).
  const setKind = (kind: CheckKind) => {
    const next: SimpleRule = { ...draft, kind };
    next.id = autoId(rules.filter(r => r.id !== draft.id), kind, next.group);
    onChange(next);
  };
  const setGroup = (group: string) => {
    onChange({ ...draft, group, id: autoId(rules.filter(r => r.id !== draft.id), draft.kind, group) });
  };

  const baseInput: React.CSSProperties = {
    padding: '6px 10px', fontSize: 13, border: '1px solid var(--border)',
    borderRadius: 4, background: '#fff', color: 'var(--text)', width: '100%',
    fontFamily: 'inherit',
  };
  const mono: React.CSSProperties = { ...baseInput, fontFamily: 'monospace', fontSize: 12 };

  const Label = ({ children, hint }: { children: React.ReactNode; hint?: string }) => (
    <div style={{ marginBottom: 4 }}>
      <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{children}</span>
      {hint && <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{hint}</span>}
    </div>
  );

  return (
    <div style={{
      border: '2px solid var(--navy)', borderRadius: 'var(--radius)',
      padding: 16, marginBottom: 14, background: 'var(--surface-muted)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
          {isNew ? 'Add a rule' : 'Edit rule'}
        </div>
        <button onClick={onCancel} style={{ background: 'transparent', border: '1px solid var(--border)', fontSize: 11, padding: '4px 10px', color: 'var(--muted)' }}>Cancel</button>
      </div>

      {/* Step 1: what kind of check */}
      <div style={{ marginBottom: 14 }}>
        <Label hint="Choose what kind of thing you want to enforce.">1. What do you want to check?</Label>
        <select value={draft.kind} onChange={e => setKind(e.target.value as CheckKind)} style={baseInput}>
          {KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          {meta.blurb} <em style={{ opacity: 0.8 }}>Example: {meta.example}</em>
        </div>
      </div>

      {/* Step 2: where (group) */}
      {meta.needsGroup && (
        <div style={{ marginBottom: 14 }}>
          <Label hint="Which group/table should this rule apply to?">2. Which group?</Label>
          <input
            list="rb-groups"
            value={draft.group ?? ''}
            onChange={e => setGroup(e.target.value)}
            placeholder="e.g. LOCA"
            style={baseInput}
          />
          <datalist id="rb-groups">
            {suggestedGroups.map(g => <option key={g} value={g} />)}
          </datalist>
        </div>
      )}

      {/* Step 3: kind-specific inputs */}
      <div style={{ marginBottom: 14 }}>
        <Label hint="Fill in the details for this check.">3. Details</Label>

        {(draft.kind === 'required' || draft.kind === 'unique') && (
          <TagInput
            value={draft.fields ?? []}
            onChange={(fields) => onChange({ ...draft, fields })}
            suggestions={groupHeadings}
            placeholder={draft.kind === 'required' ? 'LOCA_ID, LOCA_TYPE' : 'LOCA_ID'}
            label={draft.kind === 'required' ? 'Columns that must be filled in' : 'Columns that form the unique key'}
          />
        )}

        {draft.kind === 'foreign_key' && (
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <div>
              <Label hint="Columns in this group that contain the reference.">Local columns</Label>
              <TagInput
                value={draft.fields ?? []}
                onChange={(fields) => onChange({ ...draft, fields })}
                suggestions={groupHeadings}
                placeholder="LOCA_ID"
              />
            </div>
            <div>
              <Label hint="Group these values must exist in.">References group</Label>
              <input list="rb-groups" value={draft.refGroup ?? ''} onChange={e => onChange({ ...draft, refGroup: e.target.value })} placeholder="LOCA" style={baseInput} />
            </div>
          </div>
        )}

        {draft.kind === 'one_of' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <Label>Column to check</Label>
              <input list="rb-headings" value={draft.field ?? ''} onChange={e => onChange({ ...draft, field: e.target.value })} placeholder="SAMP_TYPE" style={baseInput} />
            </div>
            <div>
              <Label hint="Type the values, one per line or comma-separated.">Allowed values</Label>
              <TagInput
                value={draft.codelistInline ?? []}
                onChange={(vals) => onChange({ ...draft, codelistInline: vals, codelistName: draft.codelistName || `${(draft.field || 'codes').toLowerCase()}_codes` })}
                suggestions={[]}
                placeholder="B, U, D, ES, WS"
              />
            </div>
          </div>
        )}

        {draft.kind === 'compare' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, alignItems: 'end' }}>
            <div>
              <Label>Left column</Label>
              <input list="rb-headings" value={draft.field ?? ''} onChange={e => onChange({ ...draft, field: e.target.value })} placeholder="GEOL_BASE" style={baseInput} />
            </div>
            <div>
              <Label>must be</Label>
              <select value={draft.op ?? '>'} onChange={e => onChange({ ...draft, op: e.target.value as NonNullable<SimpleRule['op']> })} style={baseInput}>
                {COMPARE_OPS.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <Label>{draft.rhsIsField ? 'Right column' : 'Right value'}</Label>
              <div style={{ display: 'flex', gap: 4 }}>
                <input
                  list={draft.rhsIsField ? 'rb-headings' : undefined}
                  value={draft.rhsIsField ? (draft.field2 ?? '') : (draft.rhs ?? '')}
                  onChange={e => onChange(draft.rhsIsField ? { ...draft, field2: e.target.value } : { ...draft, rhs: e.target.value })}
                  placeholder={draft.rhsIsField ? 'GEOL_TOP' : '0'}
                  style={{ ...baseInput, flex: 1 }}
                />
                <button
                  onClick={() => onChange({ ...draft, rhsIsField: !draft.rhsIsField })}
                  title={draft.rhsIsField ? 'Switch to a fixed value' : 'Switch to another column'}
                  style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', fontSize: 11, padding: '4px 8px', color: 'var(--muted)' }}
                >
                  {draft.rhsIsField ? 'col' : '123'}
                </button>
              </div>
            </div>
          </div>
        )}

        {draft.kind === 'range' && (
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
            <div>
              <Label>Column</Label>
              <input list="rb-headings" value={draft.field ?? ''} onChange={e => onChange({ ...draft, field: e.target.value })} placeholder="GEOL_TOP" style={baseInput} />
            </div>
            <div>
              <Label hint="Leave blank for no minimum.">Minimum</Label>
              <input value={draft.min ?? ''} onChange={e => onChange({ ...draft, min: e.target.value })} placeholder="0" style={baseInput} />
            </div>
            <div>
              <Label hint="Leave blank for no maximum.">Maximum</Label>
              <input value={draft.max ?? ''} onChange={e => onChange({ ...draft, max: e.target.value })} placeholder="1000" style={baseInput} />
            </div>
          </div>
        )}

        {draft.kind === 'monotonic' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <Label hint="Values in this column must increase from one row to the next.">Column</Label>
              <input list="rb-headings" value={draft.field ?? ''} onChange={e => onChange({ ...draft, field: e.target.value })} placeholder="GEOL_TOP" style={baseInput} />
            </div>
            <div>
              <Label hint="Optional. If set, the check restarts for each value of this column (e.g. for each borehole).">For each (optional)</Label>
              <input list="rb-headings" value={draft.partitionBy ?? ''} onChange={e => onChange({ ...draft, partitionBy: e.target.value })} placeholder="LOCA_ID" style={baseInput} />
            </div>
          </div>
        )}

        {draft.kind === 'pattern' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
            <div>
              <Label>Column</Label>
              <input list="rb-headings" value={draft.field ?? ''} onChange={e => onChange({ ...draft, field: e.target.value })} placeholder="LOCA_ID" style={baseInput} />
            </div>
            <div>
              <Label hint='Regular expression. For "BH" followed by digits, use ^BH\d+$'>Pattern</Label>
              <input value={draft.regex ?? ''} onChange={e => onChange({ ...draft, regex: e.target.value })} placeholder="^BH\d+$" style={mono} />
            </div>
          </div>
        )}

        {draft.kind === 'group_exists' && (
          <div>
            <Label>Group name</Label>
            <input list="rb-groups" value={draft.groupName ?? ''} onChange={e => onChange({ ...draft, groupName: e.target.value })} placeholder="PROJ" style={baseInput} />
          </div>
        )}

        {draft.kind === 'group_size' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <div>
                <Label>Group name</Label>
                <input list="rb-groups" value={draft.groupName ?? ''} onChange={e => onChange({ ...draft, groupName: e.target.value })} placeholder="PROJ" style={baseInput} />
              </div>
              <div>
                <Label>How many rows?</Label>
                <select value={draft.sizeMode ?? 'equals'} onChange={e => onChange({ ...draft, sizeMode: e.target.value as 'equals' | 'range' })} style={baseInput}>
                  <option value="equals">exactly N</option>
                  <option value="range">in a range</option>
                </select>
              </div>
            </div>
            {(draft.sizeMode ?? 'equals') === 'equals' ? (
              <div>
                <Label>Exact row count</Label>
                <input value={draft.equals ?? ''} onChange={e => onChange({ ...draft, equals: e.target.value })} placeholder="1" style={baseInput} />
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <Label>Minimum</Label>
                  <input value={draft.min ?? ''} onChange={e => onChange({ ...draft, min: e.target.value })} placeholder="1" style={baseInput} />
                </div>
                <div>
                  <Label>Maximum</Label>
                  <input value={draft.max ?? ''} onChange={e => onChange({ ...draft, max: e.target.value })} placeholder="100" style={baseInput} />
                </div>
              </div>
            )}
          </>
        )}

        {draft.kind === 'heading_present' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <Label>Group</Label>
              <input list="rb-groups" value={draft.groupName ?? ''} onChange={e => onChange({ ...draft, groupName: e.target.value })} placeholder="TRAN" style={baseInput} />
            </div>
            <div>
              <Label>Column name</Label>
              <input
                list="rb-headings-for-group"
                value={draft.heading ?? ''}
                onChange={e => onChange({ ...draft, heading: e.target.value })}
                placeholder="TRAN_AGS"
                style={baseInput}
              />
              <datalist id="rb-headings-for-group">
                {sizeGroupHeadings.map(h => <option key={h} value={h} />)}
              </datalist>
            </div>
          </div>
        )}

        {draft.kind === 'depth_unit' && (
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <div>
              <Label hint="Which columns should use this unit?">Depth columns</Label>
              <TagInput
                value={draft.fields ?? []}
                onChange={(fields) => onChange({ ...draft, fields })}
                suggestions={allHeadings}
                placeholder="GEOL_TOP, GEOL_BASE"
              />
            </div>
            <div>
              <Label>Required unit</Label>
              <input value={draft.unit ?? 'm'} onChange={e => onChange({ ...draft, unit: e.target.value })} placeholder="m" style={baseInput} />
            </div>
          </div>
        )}

        {draft.kind === 'expr' && (
          <div>
            <Label hint='Available: row.X, group, rows, file. Example: row.A > 0 && row.B != null'>JEXL expression (advanced)</Label>
            <input value={draft.expr ?? ''} onChange={e => onChange({ ...draft, expr: e.target.value })} placeholder="row.X != null" style={mono} />
          </div>
        )}

        {/* Autocomplete datalists derived from the loaded file */}
        <datalist id="rb-headings">
          {(refHeadings.length > 0 || groupHeadings.length > 0 ? Array.from(new Set([...groupHeadings, ...refHeadings])) : allHeadings).map(h => (
            <option key={h} value={h} />
          ))}
        </datalist>
      </div>

      {/* Step 4: severity + ID */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <div>
          <Label hint="How serious is a violation? 'error' fails the file; 'warning' is informational.">How serious?</Label>
          <select value={draft.severity} onChange={e => onChange({ ...draft, severity: e.target.value as SimpleRule['severity'] })} style={baseInput}>
            <option value="error">error — must be fixed</option>
            <option value="warning">warning — worth checking</option>
            <option value="info">info — for your information</option>
          </select>
        </div>
        <div>
          <Label hint="A short code identifying this rule. We pick one automatically.">Rule ID</Label>
          <input value={draft.id} onChange={e => onChange({ ...draft, id: e.target.value })} style={mono} />
        </div>
      </div>

      {/* Preview */}
      <div style={{
        background: '#fff', border: '1px solid var(--border)', borderRadius: 4, padding: '10px 14px', marginBottom: 14,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
          What this rule will check
        </div>
        <div style={{ fontSize: 13, color: 'var(--text)' }}>{describeRule(draft)}</div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onSave}
          disabled={!draft.id.trim()}
          style={{
            background: 'var(--navy)', color: '#fff', fontSize: 13, padding: '8px 18px',
            opacity: !draft.id.trim() ? 0.4 : 1,
          }}
        >
          {isNew ? 'Add this rule' : 'Save changes'}
        </button>
        <button onClick={onCancel} style={{ background: 'transparent', border: '1px solid var(--border)', fontSize: 13, padding: '8px 14px', color: 'var(--muted)' }}>Cancel</button>
      </div>
    </div>
  );
}

// ── Tag-style input for comma-separated lists ───────────────────────────────

interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder: string;
  label?: string;
}

function TagInput({ value, onChange, suggestions, placeholder, label }: TagInputProps) {
  const [pending, setPending] = useState('');
  const dlId = `dl-${Math.random().toString(36).slice(2, 7)}`;

  const commit = (raw: string) => {
    const parts = parseList(raw);
    if (parts.length === 0) return;
    const merged = Array.from(new Set([...value, ...parts]));
    onChange(merged);
    setPending('');
  };

  return (
    <div>
      {label && (
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{label}</div>
      )}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 4, padding: 6,
        border: '1px solid var(--border)', borderRadius: 4, background: '#fff', minHeight: 36, alignItems: 'center',
      }}>
        {value.map((v, i) => (
          <span key={i} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
            background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 12,
            fontSize: 12, fontFamily: 'monospace', color: 'var(--text)',
          }}>
            {v}
            <button
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}
              aria-label={`Remove ${v}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          list={dlId}
          value={pending}
          onChange={e => setPending(e.target.value)}
          onKeyDown={e => {
            if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && pending.trim()) {
              e.preventDefault();
              commit(pending);
            } else if (e.key === 'Backspace' && pending === '' && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => { if (pending.trim()) commit(pending); }}
          placeholder={value.length === 0 ? placeholder : ''}
          style={{ flex: 1, minWidth: 100, border: 'none', outline: 'none', padding: '4px 6px', fontSize: 12, fontFamily: 'monospace', background: 'transparent' }}
        />
        <datalist id={dlId}>
          {suggestions.filter(s => !value.includes(s)).map(s => <option key={s} value={s} />)}
        </datalist>
      </div>
    </div>
  );
}
