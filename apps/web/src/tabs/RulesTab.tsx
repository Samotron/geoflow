import { useState } from 'react';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile } from '../core.js';
import { DiagnosticsPanel } from '../App.js';
import type { PackDiagnostic } from '../types.js';

interface Props {
  fileBytes: Uint8Array | null;
}

const STARTER_YAML = `version: 1
name: my-rules
pack_version: "0.1"

codelists:
  sample_types:
    inline: ["B", "U", "D", "ES", "WS", "PS"]

rules:
  # Required fields per row
  - id: LOCA-001
    description: "Locations must have coordinates."
    severity: error
    in: LOCA
    check:
      required: [LOCA_NATE, LOCA_NATN]

  # Foreign-key reference
  - id: SAMP-001
    description: "Samples must reference an existing location."
    severity: error
    in: SAMP
    check:
      foreign_key: { fields: [LOCA_ID], references: LOCA }

  # Codelist membership
  - id: SAMP-002
    description: "Sample type must be in permitted list."
    severity: warning
    in: SAMP
    check:
      one_of: { field: SAMP_TYPE, codelist: sample_types }

  # Monotonic ordering, partitioned by borehole
  - id: GEOL-001
    description: "Geology depths must be monotonic per location."
    severity: error
    in: GEOL
    check:
      monotonic: { field: GEOL_TOP, partition_by: LOCA_ID }

  # Cross-field comparison
  - id: GEOL-002
    description: "GEOL_BASE must be deeper than GEOL_TOP."
    severity: error
    in: GEOL
    check:
      compare: { left: GEOL_BASE, op: ">", right: GEOL_TOP }
`;

type EvalStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; diagnostics: PackDiagnostic[] };

const COMMON_GROUPS = ['LOCA', 'GEOL', 'SAMP', 'CHEM', 'GRAT', 'ISPT', 'IVAN', 'MOND', 'HOLE', 'PROJ', 'TRAN', 'ABBR', 'UNIT', 'TYPE'];

// ── Check kind catalog ────────────────────────────────────────────────────

type CheckKind =
  | 'required' | 'unique' | 'foreign_key' | 'one_of' | 'compare' | 'range'
  | 'monotonic' | 'pattern' | 'group_exists' | 'group_size' | 'heading_present'
  | 'depth_unit' | 'expr';

interface KindMeta {
  kind: CheckKind;
  label: string;
  blurb: string;
  scope: 'row' | 'group' | 'file';
  needsGroup: boolean;
}

const KINDS: KindMeta[] = [
  { kind: 'required',        label: 'Required fields',         blurb: 'Each listed field must be non-null and non-empty in every row.', scope: 'row',   needsGroup: true  },
  { kind: 'unique',          label: 'Unique key',              blurb: 'Listed fields together form a unique key across the group.',     scope: 'group', needsGroup: true  },
  { kind: 'foreign_key',     label: 'Foreign key',             blurb: 'Each row must reference an existing row in another group.',      scope: 'row',   needsGroup: true  },
  { kind: 'one_of',          label: 'One of (codelist)',       blurb: 'Field value must be in a fixed list or named codelist.',         scope: 'row',   needsGroup: true  },
  { kind: 'compare',         label: 'Compare two fields',      blurb: 'Compare two fields (or a field vs. constant) in the same row.',  scope: 'row',   needsGroup: true  },
  { kind: 'range',           label: 'Numeric range',           blurb: 'A numeric field must be within [min, max].',                     scope: 'row',   needsGroup: true  },
  { kind: 'monotonic',       label: 'Monotonic increasing',    blurb: 'Field is strictly increasing, optionally per partition key.',    scope: 'group', needsGroup: true  },
  { kind: 'pattern',         label: 'Regex pattern',           blurb: 'Field value must match a regular expression.',                   scope: 'row',   needsGroup: true  },
  { kind: 'group_exists',    label: 'Group exists',            blurb: 'The named group must be present in the file.',                   scope: 'file',  needsGroup: false },
  { kind: 'group_size',      label: 'Group size',              blurb: 'The named group must have N rows (or be within [min, max]).',   scope: 'file',  needsGroup: false },
  { kind: 'heading_present', label: 'Heading present',         blurb: 'The named group must declare a specific heading column.',        scope: 'file',  needsGroup: false },
  { kind: 'depth_unit',      label: 'Depth unit',              blurb: 'Depth-bearing headings must all carry a given unit (e.g. m).',   scope: 'file',  needsGroup: false },
  { kind: 'expr',            label: 'Custom expression',       blurb: 'Escape hatch: arbitrary JEXL expression evaluated per row.',     scope: 'row',   needsGroup: true  },
];

const COMPARE_OPS = ['<', '<=', '==', '!=', '>=', '>'] as const;

interface BuilderForm {
  id: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  group: string;
  kind: CheckKind;
  message: string;

  // Per-kind state. Only the fields relevant to the selected kind are read.
  fields: string;            // comma-separated list (required, unique, foreign_key.fields)
  refGroup: string;          // foreign_key
  field: string;             // one_of, compare.left, range, pattern, monotonic
  field2: string;            // compare.right (field) or pattern regex
  op: typeof COMPARE_OPS[number]; // compare
  rhs: string;               // compare right (literal)
  rhsIsField: boolean;       // compare: right is field name vs literal
  values: string;            // one_of inline values, comma-separated
  codelist: string;          // one_of codelist id
  min: string;               // range
  max: string;               // range
  partitionBy: string;       // monotonic
  regex: string;             // pattern
  unit: string;              // depth_unit
  heading: string;           // heading_present
  groupName: string;         // group_exists / group_size / heading_present / depth_unit
  sizeMode: 'equals' | 'range';
  equals: string;            // group_size
  expr: string;              // expr
}

const BLANK_FORM: BuilderForm = {
  id: '', description: '', severity: 'error', group: 'LOCA', kind: 'required', message: '',
  fields: '', refGroup: 'LOCA', field: '', field2: '', op: '>', rhs: '', rhsIsField: true,
  values: '', codelist: '', min: '', max: '', partitionBy: '', regex: '',
  unit: 'm', heading: '', groupName: 'LOCA', sizeMode: 'equals', equals: '1', expr: '',
};

// ── YAML serializer (best-effort, indented blocks) ───────────────────────────

function quote(s: string): string {
  if (s === '') return '""';
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;
  return JSON.stringify(s);
}

function listToYaml(items: string[]): string {
  return `[${items.map(quote).join(', ')}]`;
}

function buildRuleYaml(f: BuilderForm): string {
  const id = f.id.trim() || 'RULE-001';
  const lines: string[] = [`  - id: ${id}`];
  if (f.description.trim()) {
    lines.push(`    description: ${JSON.stringify(f.description)}`);
  }
  lines.push(`    severity: ${f.severity}`);
  const kindMeta = KINDS.find(k => k.kind === f.kind)!;
  if (kindMeta.needsGroup && f.group.trim()) {
    lines.push(`    in: ${f.group.trim()}`);
  }

  const fieldsList = f.fields.split(',').map(s => s.trim()).filter(Boolean);

  switch (f.kind) {
    case 'required':
      lines.push(`    check: { required: ${listToYaml(fieldsList)} }`);
      break;
    case 'unique':
      lines.push(`    check: { unique: ${listToYaml(fieldsList)} }`);
      break;
    case 'foreign_key':
      lines.push(`    check:`);
      lines.push(`      foreign_key:`);
      lines.push(`        fields: ${listToYaml(fieldsList)}`);
      lines.push(`        references: ${f.refGroup.trim() || 'LOCA'}`);
      break;
    case 'one_of': {
      const inline = f.values.split(',').map(s => s.trim()).filter(Boolean);
      if (inline.length > 0) {
        lines.push(`    check: { one_of: { field: ${quote(f.field)}, values: ${listToYaml(inline)} } }`);
      } else {
        lines.push(`    check: { one_of: { field: ${quote(f.field)}, codelist: ${quote(f.codelist || 'codes')} } }`);
      }
      break;
    }
    case 'compare':
      if (f.rhsIsField) {
        lines.push(`    check: { compare: { left: ${quote(f.field)}, op: ${JSON.stringify(f.op)}, right: ${quote(f.field2)} } }`);
      } else {
        const rhsNum = Number(f.rhs);
        const rhs = Number.isFinite(rhsNum) && f.rhs.trim() !== '' ? f.rhs : JSON.stringify(f.rhs);
        lines.push(`    check: { compare: { left: ${quote(f.field)}, op: ${JSON.stringify(f.op)}, right: ${rhs} } }`);
      }
      break;
    case 'range': {
      const parts: string[] = [`field: ${quote(f.field)}`];
      if (f.min.trim() !== '') parts.push(`min: ${f.min.trim()}`);
      if (f.max.trim() !== '') parts.push(`max: ${f.max.trim()}`);
      lines.push(`    check: { range: { ${parts.join(', ')} } }`);
      break;
    }
    case 'monotonic': {
      const parts: string[] = [`field: ${quote(f.field)}`];
      if (f.partitionBy.trim() !== '') parts.push(`partition_by: ${quote(f.partitionBy)}`);
      lines.push(`    check: { monotonic: { ${parts.join(', ')} } }`);
      break;
    }
    case 'pattern':
      lines.push(`    check: { pattern: { field: ${quote(f.field)}, regex: ${JSON.stringify(f.regex)} } }`);
      break;
    case 'group_exists':
      lines.push(`    check: { group_exists: ${quote(f.groupName)} }`);
      break;
    case 'group_size': {
      const parts: string[] = [`group: ${quote(f.groupName)}`];
      if (f.sizeMode === 'equals' && f.equals.trim() !== '') parts.push(`equals: ${f.equals.trim()}`);
      if (f.sizeMode === 'range') {
        if (f.min.trim() !== '') parts.push(`min: ${f.min.trim()}`);
        if (f.max.trim() !== '') parts.push(`max: ${f.max.trim()}`);
      }
      lines.push(`    check: { group_size: { ${parts.join(', ')} } }`);
      break;
    }
    case 'heading_present':
      lines.push(`    check: { heading_present: { group: ${quote(f.groupName)}, heading: ${quote(f.heading)} } }`);
      break;
    case 'depth_unit': {
      const parts: string[] = [];
      if (fieldsList.length) parts.push(`headings: ${listToYaml(fieldsList)}`);
      parts.push(`unit: ${quote(f.unit || 'm')}`);
      lines.push(`    check: { depth_unit: { ${parts.join(', ')} } }`);
      break;
    }
    case 'expr':
      lines.push(`    check: { expr: ${JSON.stringify(f.expr)} }`);
      break;
  }

  if (f.message.trim()) {
    lines.push(`    message: ${JSON.stringify(f.message)}`);
  }
  return lines.join('\n');
}

// ── Component ───────────────────────────────────────────────────────────────

export function RulesTab({ fileBytes }: Props) {
  const [yaml, setYaml] = useState(STARTER_YAML);
  const [status, setStatus] = useState<EvalStatus>({ kind: 'idle' });
  const [builderOpen, setBuilderOpen] = useState(true);
  const [form, setForm] = useState<BuilderForm>(BLANK_FORM);

  const run = async () => {
    if (!fileBytes) return;
    setStatus({ kind: 'running' });

    let agsFile: AgsFile;
    try {
      const text = decodeBytes(fileBytes);
      const parsed = parseStr(text);
      agsFile = parsed.file;
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

      if (typeof evaluatePackYaml !== 'function') {
        setStatus({ kind: 'unavailable' });
        return;
      }

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

  const appendRule = () => {
    const snippet = buildRuleYaml(form);
    setYaml(prev => {
      const rulesIdx = prev.indexOf('\nrules:');
      if (rulesIdx !== -1) return prev + '\n' + snippet;
      return prev + '\n\nrules:\n' + snippet;
    });
    setForm({ ...BLANK_FORM, group: form.group, kind: form.kind });
  };

  const inputStyle: React.CSSProperties = {
    padding: '5px 8px', fontSize: 12, border: '1px solid var(--border)',
    borderRadius: 4, background: '#fff', color: 'var(--text)', width: '100%',
    fontFamily: 'inherit',
  };
  const mono: React.CSSProperties = { ...inputStyle, fontFamily: 'monospace' };

  const kindMeta = KINDS.find(k => k.kind === form.kind)!;
  const preview = buildRuleYaml(form);

  const fieldLabel = (text: string) => (
    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 3 }}>{text}</label>
  );

  return (
    <div>
      <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
        Build validation rules from declarative primitives — required fields, unique keys, foreign keys, codelists,
        comparisons, monotonic ordering, regex, depth units. Drop down to a JEXL expression if needed.
      </div>

      {/* Rule builder */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 12, overflow: 'hidden' }}>
        <button
          onClick={() => setBuilderOpen(o => !o)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px 14px', background: 'var(--surface-muted)', border: 'none', cursor: 'pointer',
            fontSize: 12, fontWeight: 700, color: 'var(--text)', textAlign: 'left',
          }}
        >
          <span style={{ fontSize: 10, opacity: 0.6 }}>{builderOpen ? '▾' : '▸'}</span>
          Rule Builder
          <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)', marginLeft: 4 }}>
            — pick a check kind, fill the fields, append to YAML
          </span>
        </button>
        {builderOpen && (
          <div style={{ padding: 14, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <div>
                {fieldLabel('Rule ID *')}
                <input value={form.id} onChange={e => setForm(f => ({ ...f, id: e.target.value }))} placeholder="LOCA-001" style={inputStyle} />
              </div>
              <div>
                {fieldLabel('Severity')}
                <select value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value as BuilderForm['severity'] }))} style={inputStyle}>
                  <option value="error">error</option>
                  <option value="warning">warning</option>
                  <option value="info">info</option>
                </select>
              </div>
              <div>
                {fieldLabel('Check kind')}
                <select value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value as CheckKind }))} style={inputStyle}>
                  {KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </select>
              </div>
            </div>

            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, padding: '4px 0' }}>
              {kindMeta.blurb}{' '}
              <span style={{ background: 'var(--surface-muted)', padding: '1px 6px', borderRadius: 3, fontSize: 10 }}>
                {kindMeta.scope}-scope
              </span>
            </div>

            <div>
              {fieldLabel('Description')}
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Human-readable description" style={inputStyle} />
            </div>

            {kindMeta.needsGroup && (
              <div>
                {fieldLabel('Group (in:)')}
                <div style={{ display: 'flex', gap: 6 }}>
                  <select
                    value={COMMON_GROUPS.includes(form.group) ? form.group : '__custom__'}
                    onChange={e => { if (e.target.value !== '__custom__') setForm(f => ({ ...f, group: e.target.value })); }}
                    style={{ ...inputStyle, flex: 1 }}
                  >
                    {COMMON_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
                    {!COMMON_GROUPS.includes(form.group) && <option value="__custom__">{form.group}</option>}
                  </select>
                  <input value={form.group} onChange={e => setForm(f => ({ ...f, group: e.target.value }))} placeholder="Custom" style={{ ...inputStyle, width: 100 }} />
                </div>
              </div>
            )}

            {/* Kind-specific fields */}
            {(form.kind === 'required' || form.kind === 'unique') && (
              <div>
                {fieldLabel(form.kind === 'required' ? 'Required fields (comma-separated)' : 'Key fields (comma-separated)')}
                <input value={form.fields} onChange={e => setForm(f => ({ ...f, fields: e.target.value }))} placeholder="LOCA_ID, LOCA_TYPE" style={mono} />
              </div>
            )}

            {form.kind === 'foreign_key' && (
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                <div>
                  {fieldLabel('Local fields (comma-separated)')}
                  <input value={form.fields} onChange={e => setForm(f => ({ ...f, fields: e.target.value }))} placeholder="LOCA_ID" style={mono} />
                </div>
                <div>
                  {fieldLabel('Referenced group')}
                  <input value={form.refGroup} onChange={e => setForm(f => ({ ...f, refGroup: e.target.value }))} placeholder="LOCA" style={mono} />
                </div>
              </div>
            )}

            {form.kind === 'one_of' && (
              <>
                <div>
                  {fieldLabel('Field')}
                  <input value={form.field} onChange={e => setForm(f => ({ ...f, field: e.target.value }))} placeholder="SAMP_TYPE" style={mono} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    {fieldLabel('Inline values (comma-separated)')}
                    <input value={form.values} onChange={e => setForm(f => ({ ...f, values: e.target.value }))} placeholder="B, U, D" style={mono} />
                  </div>
                  <div>
                    {fieldLabel('— or — codelist ID')}
                    <input value={form.codelist} onChange={e => setForm(f => ({ ...f, codelist: e.target.value }))} placeholder="sample_types" style={mono} />
                  </div>
                </div>
              </>
            )}

            {form.kind === 'compare' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 1fr 90px', gap: 10, alignItems: 'end' }}>
                <div>
                  {fieldLabel('Left field')}
                  <input value={form.field} onChange={e => setForm(f => ({ ...f, field: e.target.value }))} placeholder="GEOL_BASE" style={mono} />
                </div>
                <div>
                  {fieldLabel('Operator')}
                  <select value={form.op} onChange={e => setForm(f => ({ ...f, op: e.target.value as BuilderForm['op'] }))} style={inputStyle}>
                    {COMPARE_OPS.map(op => <option key={op} value={op}>{op}</option>)}
                  </select>
                </div>
                <div>
                  {fieldLabel(form.rhsIsField ? 'Right field' : 'Right literal')}
                  <input
                    value={form.rhsIsField ? form.field2 : form.rhs}
                    onChange={e => setForm(f => form.rhsIsField ? { ...f, field2: e.target.value } : { ...f, rhs: e.target.value })}
                    placeholder={form.rhsIsField ? 'GEOL_TOP' : '0'}
                    style={mono}
                  />
                </div>
                <div>
                  {fieldLabel('Right is…')}
                  <select value={form.rhsIsField ? 'field' : 'literal'} onChange={e => setForm(f => ({ ...f, rhsIsField: e.target.value === 'field' }))} style={inputStyle}>
                    <option value="field">field</option>
                    <option value="literal">literal</option>
                  </select>
                </div>
              </div>
            )}

            {form.kind === 'range' && (
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
                <div>
                  {fieldLabel('Field')}
                  <input value={form.field} onChange={e => setForm(f => ({ ...f, field: e.target.value }))} placeholder="GEOL_TOP" style={mono} />
                </div>
                <div>
                  {fieldLabel('Min')}
                  <input value={form.min} onChange={e => setForm(f => ({ ...f, min: e.target.value }))} placeholder="0" style={mono} />
                </div>
                <div>
                  {fieldLabel('Max')}
                  <input value={form.max} onChange={e => setForm(f => ({ ...f, max: e.target.value }))} placeholder="1000" style={mono} />
                </div>
              </div>
            )}

            {form.kind === 'monotonic' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  {fieldLabel('Field')}
                  <input value={form.field} onChange={e => setForm(f => ({ ...f, field: e.target.value }))} placeholder="GEOL_TOP" style={mono} />
                </div>
                <div>
                  {fieldLabel('Partition by (optional)')}
                  <input value={form.partitionBy} onChange={e => setForm(f => ({ ...f, partitionBy: e.target.value }))} placeholder="LOCA_ID" style={mono} />
                </div>
              </div>
            )}

            {form.kind === 'pattern' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
                <div>
                  {fieldLabel('Field')}
                  <input value={form.field} onChange={e => setForm(f => ({ ...f, field: e.target.value }))} placeholder="LOCA_ID" style={mono} />
                </div>
                <div>
                  {fieldLabel('Regex')}
                  <input value={form.regex} onChange={e => setForm(f => ({ ...f, regex: e.target.value }))} placeholder="^BH\d+$" style={mono} />
                </div>
              </div>
            )}

            {form.kind === 'group_exists' && (
              <div>
                {fieldLabel('Group name')}
                <input value={form.groupName} onChange={e => setForm(f => ({ ...f, groupName: e.target.value }))} placeholder="PROJ" style={mono} />
              </div>
            )}

            {form.kind === 'group_size' && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    {fieldLabel('Group name')}
                    <input value={form.groupName} onChange={e => setForm(f => ({ ...f, groupName: e.target.value }))} placeholder="PROJ" style={mono} />
                  </div>
                  <div>
                    {fieldLabel('Constraint')}
                    <select value={form.sizeMode} onChange={e => setForm(f => ({ ...f, sizeMode: e.target.value as 'equals' | 'range' }))} style={inputStyle}>
                      <option value="equals">equals N</option>
                      <option value="range">in range [min, max]</option>
                    </select>
                  </div>
                </div>
                {form.sizeMode === 'equals' ? (
                  <div>
                    {fieldLabel('Exact rows (equals)')}
                    <input value={form.equals} onChange={e => setForm(f => ({ ...f, equals: e.target.value }))} placeholder="1" style={mono} />
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div>
                      {fieldLabel('Min rows')}
                      <input value={form.min} onChange={e => setForm(f => ({ ...f, min: e.target.value }))} placeholder="1" style={mono} />
                    </div>
                    <div>
                      {fieldLabel('Max rows')}
                      <input value={form.max} onChange={e => setForm(f => ({ ...f, max: e.target.value }))} placeholder="100" style={mono} />
                    </div>
                  </div>
                )}
              </>
            )}

            {form.kind === 'heading_present' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  {fieldLabel('Group')}
                  <input value={form.groupName} onChange={e => setForm(f => ({ ...f, groupName: e.target.value }))} placeholder="TRAN" style={mono} />
                </div>
                <div>
                  {fieldLabel('Heading')}
                  <input value={form.heading} onChange={e => setForm(f => ({ ...f, heading: e.target.value }))} placeholder="TRAN_AGS" style={mono} />
                </div>
              </div>
            )}

            {form.kind === 'depth_unit' && (
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                <div>
                  {fieldLabel('Depth headings (comma-separated, optional)')}
                  <input value={form.fields} onChange={e => setForm(f => ({ ...f, fields: e.target.value }))} placeholder="GEOL_TOP, GEOL_BASE" style={mono} />
                </div>
                <div>
                  {fieldLabel('Required unit')}
                  <input value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} placeholder="m" style={mono} />
                </div>
              </div>
            )}

            {form.kind === 'expr' && (
              <div>
                {fieldLabel('JEXL expression (must evaluate truthy)')}
                <input value={form.expr} onChange={e => setForm(f => ({ ...f, expr: e.target.value }))} placeholder="row.X != null && row.X > 0" style={mono} />
              </div>
            )}

            <div>
              {fieldLabel('Message template (optional — auto-generated if blank)')}
              <input value={form.message} onChange={e => setForm(f => ({ ...f, message: e.target.value }))} placeholder="e.g. Location {row.LOCA_ID} missing {field}" style={inputStyle} />
            </div>

            {/* Live preview */}
            <div>
              {fieldLabel('Preview YAML')}
              <pre style={{
                background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 4,
                padding: 10, fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text)',
              }}>{preview}</pre>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={appendRule}
                disabled={!form.id.trim()}
                style={{ background: 'var(--navy)', color: '#fff', fontSize: 12, padding: '6px 14px', opacity: !form.id.trim() ? 0.4 : 1 }}
              >
                + Append Rule to YAML
              </button>
              <button
                onClick={() => setForm(BLANK_FORM)}
                style={{ background: 'var(--surface-muted)', color: 'var(--text)', fontSize: 12, padding: '6px 14px', border: '1px solid var(--border)' }}
              >
                Reset
              </button>
            </div>
          </div>
        )}
      </div>

      <textarea
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
        style={{
          width: '100%',
          height: 360,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.5,
          padding: 12,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          background: 'var(--text)',
          color: 'var(--border)',
          resize: 'vertical',
          outline: 'none',
          marginBottom: 12,
        }}
      />

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <button
          onClick={() => { void run(); }}
          disabled={!fileBytes || status.kind === 'running'}
          style={{ background: 'var(--navy)', color: '#fff', opacity: !fileBytes || status.kind === 'running' ? 0.4 : 1 }}
        >
          {status.kind === 'running' ? 'Running…' : 'Validate with Rules'}
        </button>
      </div>

      {!fileBytes && (
        <div style={{ textAlign: 'center', padding: '24px', color: 'var(--muted)', fontSize: 13 }}>
          Drop an AGS file above to run custom rules against it.
        </div>
      )}

      {status.kind === 'unavailable' && (
        <div style={{ background: 'var(--orange-soft)', border: '1px solid var(--orange-border)', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--orange)', fontSize: 13 }}>
          Rules engine not available — <code>@geoflow/rules-engine</code> is not yet implemented (Milestone 3).
        </div>
      )}

      {status.kind === 'error' && (
        <div style={{ background: 'var(--red-soft)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)', fontSize: 13, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          {status.message}
        </div>
      )}

      {status.kind === 'done' && (
        <DiagnosticsPanel
          title="Rule Pack Results"
          items={status.diagnostics.map((d) => ({
            rule_id: d.rule_id,
            severity: d.severity,
            message: d.message,
            group: d.location.group,
            row_index: d.location.row_index,
          }))}
        />
      )}
    </div>
  );
}
