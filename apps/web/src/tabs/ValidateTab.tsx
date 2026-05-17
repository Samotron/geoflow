import { useState } from 'react';
import { validateFileBytes, Format, Severity, decodeBytes, parseStr } from '../core.js';
import type { AgsFile } from '../core.js';
import { DiagnosticsPanel } from '../App.js';
import { BUILTIN_PACKS, DEFAULT_ENABLED_PACK_IDS } from '../rulesets.js';
import type { BundledPack } from '../rulesets.js';
import type { PackDiagnostic } from '../types.js';

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
}

interface DiagItem {
  severity: string;
  rule_id: string;
  message: string;
  group: string | null;
  row_index: number | null;
  source: string;
}

interface CustomPack {
  id: string;
  label: string;
  yaml: string;
  error?: string;
}

interface RunState {
  diags: DiagItem[];
  ranSources: string[];
  builtInExit: number;
  hadError: boolean;
}

// ── Built-in diagnostics parser (text format from validateFileBytes) ────────

function parseBuiltinDiagnostics(output: string): Omit<DiagItem, 'source'>[] {
  const diags: Omit<DiagItem, 'source'>[] = [];
  const lineRe = /^(error|warning|info): \[([^\]]+)\] (.+?)(?:\s+\(([^)]+)\))?(?:\s+\[auto-fixable:[^\]]+\])?$/;
  for (const line of output.split('\n')) {
    const m = lineRe.exec(line.trim());
    if (!m) continue;
    const [, severity, rule_id, message, loc] = m;
    let group: string | null = null;
    let row_index: number | null = null;
    if (loc) {
      const gm = /group=([^,)]+)/.exec(loc);
      if (gm?.[1]) group = gm[1];
      const rm = /row_index=(\d+)/.exec(loc);
      if (rm?.[1]) row_index = parseInt(rm[1], 10);
    }
    diags.push({ severity: severity ?? '', rule_id: rule_id ?? '', message: message ?? '', group, row_index });
  }
  return diags;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ValidateTab({ fileBytes, fileName }: Props) {
  const [enabledBuiltIns, setEnabledBuiltIns] = useState<Set<string>>(() => new Set(DEFAULT_ENABLED_PACK_IDS));
  const [coreEnabled, setCoreEnabled] = useState(true);
  const [customPacks, setCustomPacks] = useState<CustomPack[]>([]);
  const [enabledCustom, setEnabledCustom] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftYaml, setDraftYaml] = useState('');
  const [previewing, setPreviewing] = useState<{ label: string; yaml: string } | null>(null);

  const [state, setState] = useState<RunState | null>(null);
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const toggleBuiltIn = (id: string) => {
    setEnabledBuiltIns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCustom = (id: string) => {
    setEnabledCustom((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addCustomPack = () => {
    const label = draftLabel.trim() || `custom-${customPacks.length + 1}`;
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const pack: CustomPack = { id, label, yaml: draftYaml };
    setCustomPacks((p) => [...p, pack]);
    setEnabledCustom((s) => { const n = new Set(s); n.add(id); return n; });
    setDraftLabel('');
    setDraftYaml('');
    setAddOpen(false);
  };

  const handleFileUpload = async (file: File) => {
    const text = await file.text();
    setDraftYaml(text);
    if (!draftLabel.trim()) setDraftLabel(file.name.replace(/\.ya?ml$/i, ''));
  };

  const removeCustom = (id: string) => {
    setCustomPacks((p) => p.filter((x) => x.id !== id));
    setEnabledCustom((s) => { const n = new Set(s); n.delete(id); return n; });
  };

  const run = async () => {
    if (!fileBytes) return;
    setRunning(true);
    setErrorMsg(null);

    try {
      const allDiags: DiagItem[] = [];
      const ranSources: string[] = [];
      let builtInExit = 0;

      // 1. Core / built-in checks
      if (coreEnabled) {
        ranSources.push('built-in');
        const result = validateFileBytes(fileBytes, fileName ?? 'file.ags', {
          format: Format.Text,
          failOn: Severity.Info,
        });
        builtInExit = result.exitCode;
        for (const d of parseBuiltinDiagnostics(result.output)) {
          allDiags.push({ ...d, source: 'built-in' });
        }
      }

      // 2. Pack-based checks. Need to parse the AGS file once.
      const enabledPacks: { label: string; yaml: string }[] = [];
      for (const p of BUILTIN_PACKS) {
        if (enabledBuiltIns.has(p.id)) enabledPacks.push({ label: p.label, yaml: p.yaml });
      }
      for (const c of customPacks) {
        if (enabledCustom.has(c.id)) enabledPacks.push({ label: c.label, yaml: c.yaml });
      }

      if (enabledPacks.length > 0) {
        let agsFile: AgsFile;
        try {
          agsFile = parseStr(decodeBytes(fileBytes)).file;
        } catch (e) {
          setErrorMsg(`Failed to parse AGS file for pack evaluation: ${String(e)}`);
          setRunning(false);
          return;
        }

        const mod = await import('@geoflow/rules-engine');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const evaluatePackYaml = (mod as any).evaluatePackYaml as
          | ((yaml: string, file: AgsFile) => PackDiagnostic[]) | undefined;

        if (typeof evaluatePackYaml !== 'function') {
          setErrorMsg('Rules engine is unavailable; built-in checks only.');
        } else {
          for (const p of enabledPacks) {
            ranSources.push(p.label);
            try {
              const diags = evaluatePackYaml(p.yaml, agsFile);
              for (const d of diags) {
                allDiags.push({
                  severity: d.severity,
                  rule_id: d.rule_id,
                  message: d.message,
                  group: d.location.group,
                  row_index: d.location.row_index,
                  source: p.label,
                });
              }
            } catch (e) {
              allDiags.push({
                severity: 'error',
                rule_id: 'PACK-LOAD-ERROR',
                message: `Pack "${p.label}" failed to evaluate: ${String(e)}`,
                group: null,
                row_index: null,
                source: p.label,
              });
            }
          }
        }
      }

      const hadError = allDiags.some((d) => d.severity === 'error') || builtInExit !== 0;
      setState({ diags: allDiags, ranSources, builtInExit, hadError });
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setRunning(false);
    }
  };

  const enabledCount =
    (coreEnabled ? 1 : 0) +
    BUILTIN_PACKS.filter((p) => enabledBuiltIns.has(p.id)).length +
    customPacks.filter((c) => enabledCustom.has(c.id)).length;

  return (
    <div>
      {/* Rulesets picker */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 12, background: 'var(--card)' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Rulesets to apply ({enabledCount})
          </span>
          <button
            onClick={() => setAddOpen((o) => !o)}
            style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--border)', fontSize: 11, padding: '3px 10px', color: 'var(--muted)' }}
          >
            {addOpen ? 'Cancel' : '+ Add custom ruleset'}
          </button>
        </div>

        <div style={{ padding: '8px 14px' }}>
          <RulesetRow
            label="Built-in AGS checks"
            description="Parser-level and standard rules from @geoflow/core (always-available)."
            checked={coreEnabled}
            onToggle={() => setCoreEnabled((c) => !c)}
          />
          {BUILTIN_PACKS.map((p) => (
            <RulesetRow
              key={p.id}
              label={p.label}
              description={p.description}
              checked={enabledBuiltIns.has(p.id)}
              onToggle={() => toggleBuiltIn(p.id)}
              onView={() => setPreviewing({ label: p.label, yaml: p.yaml })}
              bundled
            />
          ))}
          {customPacks.map((c) => (
            <RulesetRow
              key={c.id}
              label={c.label}
              description={c.yaml.split('\n').slice(0, 1).join('') || '(custom YAML)'}
              checked={enabledCustom.has(c.id)}
              onToggle={() => toggleCustom(c.id)}
              onView={() => setPreviewing({ label: c.label, yaml: c.yaml })}
              onRemove={() => removeCustom(c.id)}
            />
          ))}
        </div>

        {addOpen && (
          <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px', background: 'var(--surface-muted)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 3 }}>Name</label>
                <input
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  placeholder="my-pack"
                  style={{ width: '100%', padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 4, background: '#fff' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 3 }}>Or upload a .yml file</label>
                <input
                  type="file"
                  accept=".yml,.yaml"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFileUpload(f); }}
                  style={{ fontSize: 12, width: '100%' }}
                />
              </div>
            </div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 3 }}>YAML pack contents</label>
            <textarea
              value={draftYaml}
              onChange={(e) => setDraftYaml(e.target.value)}
              spellCheck={false}
              placeholder="version: 1\nrules:\n  - id: MY-001\n    severity: error\n    in: LOCA\n    check: { required: [LOCA_ID] }"
              style={{
                width: '100%', height: 180, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 12, lineHeight: 1.5, padding: 10, border: '1px solid var(--border)',
                borderRadius: 4, background: '#fff', color: 'var(--text)', resize: 'vertical', outline: 'none', marginBottom: 8,
              }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={addCustomPack}
                disabled={!draftYaml.trim()}
                style={{ background: 'var(--navy)', color: '#fff', fontSize: 12, padding: '6px 14px', opacity: !draftYaml.trim() ? 0.4 : 1 }}
              >
                Add ruleset
              </button>
              <button onClick={() => setAddOpen(false)} style={{ background: 'transparent', border: '1px solid var(--border)', fontSize: 12, padding: '6px 14px', color: 'var(--muted)' }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Pack preview modal */}
      {previewing && (
        <div style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', background: 'var(--surface-muted)', display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>Preview: {previewing.label}</span>
            <button onClick={() => setPreviewing(null)} style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--border)', fontSize: 11, padding: '3px 10px', color: 'var(--muted)' }}>Close</button>
          </div>
          <pre style={{
            background: 'var(--text)', color: 'var(--border)', padding: 12, maxHeight: 360, overflow: 'auto', margin: 0,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11, lineHeight: 1.5,
          }}>{previewing.yaml}</pre>
        </div>
      )}

      {/* Run button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button
          onClick={() => { void run(); }}
          disabled={!fileBytes || running || enabledCount === 0}
          style={{
            background: 'var(--navy)', color: '#fff',
            opacity: !fileBytes || running || enabledCount === 0 ? 0.4 : 1,
          }}
        >
          {running ? 'Validating…' : `Validate with ${enabledCount} ruleset${enabledCount === 1 ? '' : 's'}`}
        </button>
        {!fileBytes && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Drop an AGS file above first.</span>
        )}
      </div>

      {errorMsg && (
        <div style={{ background: 'var(--red-soft)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)', padding: '10px 14px', color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>
          {errorMsg}
        </div>
      )}

      {!fileBytes && !state && <EmptyState message="Drop an AGS file above to validate it." />}

      {state && state.diags.length === 0 && !state.hadError && (
        <div style={{ background: 'var(--green-soft)', border: '1px solid var(--green-border)', borderRadius: 'var(--radius)', padding: '16px 20px', color: 'var(--green)', fontWeight: 600, marginBottom: 16 }}>
          ✓ No issues found across {state.ranSources.length} ruleset{state.ranSources.length === 1 ? '' : 's'}: {state.ranSources.join(', ')}
        </div>
      )}

      {state && state.diags.length > 0 && (
        <>
          <SummaryByRuleset diags={state.diags} ranSources={state.ranSources} />
          <DiagnosticsPanel
            items={state.diags.map((d) => ({
              rule_id: d.rule_id,
              severity: d.severity,
              message: d.message,
              group: d.group,
              row_index: d.row_index,
              source: d.source,
            }))}
          />
        </>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

interface RulesetRowProps {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  onView?: () => void;
  onRemove?: () => void;
  bundled?: boolean;
}

function RulesetRow({ label, description, checked, onToggle, onView, onRemove, bundled }: RulesetRowProps) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
      borderBottom: '1px solid var(--surface-muted)', cursor: 'pointer',
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{ marginRight: 4 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          {label}
          {bundled && (
            <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'var(--accent-soft)', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              bundled
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{description}</div>
      </div>
      {onView && (
        <button
          onClick={(e) => { e.preventDefault(); onView(); }}
          style={{ background: 'transparent', border: '1px solid var(--border)', fontSize: 11, padding: '3px 8px', color: 'var(--muted)' }}
        >
          View
        </button>
      )}
      {onRemove && (
        <button
          onClick={(e) => { e.preventDefault(); onRemove(); }}
          style={{ background: 'transparent', border: '1px solid var(--border)', fontSize: 11, padding: '3px 8px', color: 'var(--red)' }}
        >
          Remove
        </button>
      )}
    </label>
  );
}

interface SummaryProps {
  diags: DiagItem[];
  ranSources: string[];
}

function SummaryByRuleset({ diags, ranSources }: SummaryProps) {
  const sourceStats = ranSources.map((s) => {
    const items = diags.filter((d) => d.source === s);
    return {
      source: s,
      err: items.filter((d) => d.severity === 'error').length,
      warn: items.filter((d) => d.severity === 'warning').length,
      info: items.filter((d) => d.severity === 'info').length,
      total: items.length,
    };
  });

  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      {sourceStats.map((s) => (
        <div
          key={s.source}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            padding: '8px 12px', background: 'var(--card)', fontSize: 12,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>{s.source}</span>
          {s.total === 0 ? (
            <span style={{ fontSize: 11, color: 'var(--green)' }}>✓ clean</span>
          ) : (
            <>
              {s.err > 0 && <span style={{ fontSize: 11, color: 'var(--red)' }}>{s.err} err</span>}
              {s.warn > 0 && <span style={{ fontSize: 11, color: 'var(--orange)' }}>{s.warn} warn</span>}
              {s.info > 0 && <span style={{ fontSize: 11, color: 'var(--accent)' }}>{s.info} info</span>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 14px', display: 'block' }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
      </svg>
      <p style={{ lineHeight: 1.6 }}>{message}</p>
    </div>
  );
}
