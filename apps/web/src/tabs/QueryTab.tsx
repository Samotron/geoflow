import { useState, useEffect, useCallback, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoNS from 'monaco-editor';
import { decodeBytes, parseStr } from '../core.js';
import { registerAgsFile, runQuery } from '../query/duckdb.js';
import { PRESET_QUERIES, type PresetQuery } from '../query/presets.js';
import type { TableMeta, QueryResult } from '../query/duckdb.js';

interface Props {
  fileBytes: Uint8Array | null;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function SchemaPanel({
  tables,
  onTableClick,
}: {
  tables: TableMeta[];
  onTableClick: (name: string) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (name: string) => setOpen((p) => ({ ...p, [name]: !p[name] }));

  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6 }}>
        Tables ({tables.length})
      </div>
      {tables.map((t) => (
        <div key={t.name} style={{ marginBottom: 2 }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '4px 6px', borderRadius: 4, background: open[t.name] ? '#f1f5f9' : undefined }}
            onClick={() => toggle(t.name)}
          >
            <span style={{ fontSize: 10, color: 'var(--muted)', userSelect: 'none' }}>{open[t.name] ? '▾' : '▸'}</span>
            <span
              style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600, color: 'var(--navy)', cursor: 'pointer', flex: 1 }}
              onClick={(e) => { e.stopPropagation(); onTableClick(t.name); }}
            >
              {t.name}
            </span>
            <span style={{ fontSize: 10, color: 'var(--muted)', background: '#e2e8f0', padding: '1px 5px', borderRadius: 99 }}>
              {t.rowCount}
            </span>
          </div>
          {open[t.name] && (
            <div style={{ marginLeft: 20, marginTop: 2, marginBottom: 4 }}>
              {t.columns.map((col) => (
                <div key={col} style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)', padding: '1px 0' }}>
                  {col}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PresetsPanel({
  onSelect,
  activeTables,
}: {
  onSelect: (q: PresetQuery) => void;
  activeTables: Set<string>;
}) {
  const categories = [...new Set(PRESET_QUERIES.map((q) => q.category))];
  const [openCats, setOpenCats] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(categories.map((c) => [c, true])),
  );

  const toggleCat = (cat: string) =>
    setOpenCats((p) => ({ ...p, [cat]: !p[cat] }));

  // Grey out queries that reference tables not currently loaded
  const tableRefs = (sql: string): string[] => {
    return [
      ...(sql.match(/\bFROM\s+(\w+)/gi) ?? []),
      ...(sql.match(/\bJOIN\s+(\w+)/gi) ?? []),
    ].map((m) => m.replace(/^(FROM|JOIN)\s+/i, '').toLowerCase());
  };

  const isAvailable = (q: PresetQuery) => {
    if (activeTables.size === 0) return true;
    const refs = tableRefs(q.sql).filter((t) => t !== 'duckdb_tables()');
    return refs.every((t) => activeTables.has(t));
  };

  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 6 }}>
        Presets
      </div>
      {categories.map((cat) => (
        <div key={cat} style={{ marginBottom: 4 }}>
          <div
            onClick={() => toggleCat(cat)}
            style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', padding: '4px 6px', borderRadius: 4 }}
          >
            <span style={{ fontSize: 10, color: 'var(--muted)' }}>{openCats[cat] ? '▾' : '▸'}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>{cat}</span>
          </div>
          {openCats[cat] && (
            <div style={{ marginLeft: 14 }}>
              {PRESET_QUERIES.filter((q) => q.category === cat).map((q) => {
                const avail = isAvailable(q);
                return (
                  <button
                    key={q.label}
                    onClick={() => onSelect(q)}
                    title={q.description}
                    disabled={!avail}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      background: 'none',
                      border: 'none',
                      padding: '4px 6px',
                      borderRadius: 4,
                      cursor: avail ? 'pointer' : 'default',
                      fontSize: 12,
                      color: avail ? 'var(--text)' : '#cbd5e1',
                      marginBottom: 1,
                    }}
                    onMouseEnter={(e) => { if (avail) (e.target as HTMLElement).style.background = '#f1f5f9'; }}
                    onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none'; }}
                  >
                    {q.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Results table ─────────────────────────────────────────────────────────────

function ResultsTable({ result }: { result: QueryResult }) {
  const ms = result.durationMs < 1 ? '<1' : result.durationMs.toFixed(0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{
        padding: '7px 12px',
        background: '#f8fafc',
        borderBottom: '1px solid var(--border)',
        fontSize: 12,
        color: 'var(--muted)',
        display: 'flex',
        gap: 12,
        flexShrink: 0,
      }}>
        <span><strong style={{ color: 'var(--text)' }}>{result.rowCount}</strong> row{result.rowCount !== 1 ? 's' : ''}</span>
        <span>{result.columns.length} column{result.columns.length !== 1 ? 's' : ''}</span>
        <span style={{ marginLeft: 'auto' }}>{ms} ms</span>
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        <table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
            <tr>
              {result.columns.map((col) => (
                <th key={col} style={{
                  background: '#f8fafc',
                  padding: '6px 12px',
                  textAlign: 'left',
                  fontWeight: 700,
                  fontFamily: 'monospace',
                  fontSize: 11,
                  borderBottom: '2px solid var(--border)',
                  borderRight: '1px solid #e2e8f0',
                  whiteSpace: 'nowrap',
                }}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i} style={{ background: i % 2 === 1 ? '#fafafa' : undefined }}>
                {row.map((cell, j) => {
                  const isNull = cell === null;
                  const isNum = typeof cell === 'number';
                  return (
                    <td key={j} style={{
                      padding: '5px 12px',
                      borderBottom: '1px solid #f1f5f9',
                      borderRight: '1px solid #f8fafc',
                      fontFamily: 'monospace',
                      fontSize: 12,
                      whiteSpace: 'nowrap',
                      textAlign: isNum ? 'right' : undefined,
                      color: isNull ? '#cbd5e1' : isNum ? '#334155' : undefined,
                    }}>
                      {isNull ? 'NULL' : String(cell)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {result.rowCount === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            Query returned no rows.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main QueryTab ─────────────────────────────────────────────────────────────

export function QueryTab({ fileBytes }: Props) {
  const [initState, setInitState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [initMsg, setInitMsg] = useState('');
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [sql, setSql] = useState('SELECT * FROM loca LIMIT 20;');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<MonacoNS.editor.IStandaloneCodeEditor | null>(null);

  // ── Load file into DuckDB ──────────────────────────────────────────────────
  useEffect(() => {
    if (!fileBytes) {
      setInitState('idle');
      setTables([]);
      setResult(null);
      return;
    }
    let cancelled = false;
    setInitState('loading');
    setError(null);
    setResult(null);

    (async () => {
      try {
        const text = decodeBytes(fileBytes);
        const agsFile = parseStr(text).file;
        const metas = await registerAgsFile(agsFile, (msg) => {
          if (!cancelled) setInitMsg(msg);
        });
        if (!cancelled) {
          setTables(metas);
          setInitState('ready');
          // Default query to first loaded table
          if (metas.length > 0) setSql(`SELECT * FROM ${metas[0]!.name} LIMIT 20;`);
        }
      } catch (e) {
        if (!cancelled) {
          setInitState('error');
          setInitMsg(String(e));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [fileBytes]);

  // ── Run query ──────────────────────────────────────────────────────────────
  const executeQuery = useCallback(async (overrideSql?: string) => {
    const query = (overrideSql ?? sql).trim();
    if (!query) return;
    setRunning(true);
    setError(null);
    try {
      const res = await runQuery(query);
      setResult(res);
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [sql]);

  // ── Monaco mount — wire Ctrl+Enter ────────────────────────────────────────
  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addAction({
      id: 'run-query',
      label: 'Run Query',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => executeQuery(editor.getValue()),
    });
  };

  // ── Preset selected ────────────────────────────────────────────────────────
  const handlePreset = (q: PresetQuery) => {
    setSql(q.sql);
    editorRef.current?.setValue(q.sql);
  };

  // ── Table name clicked — insert SELECT ────────────────────────────────────
  const handleTableClick = (name: string) => {
    const s = `SELECT * FROM ${name} LIMIT 50;`;
    setSql(s);
    editorRef.current?.setValue(s);
  };

  const activeTables = new Set(tables.map((t) => t.name));

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
        <p>Drop an AGS file above to query it with SQL.</p>
      </div>
    );
  }

  if (initState === 'loading') {
    return (
      <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>
        <div style={{ marginBottom: 8, fontStyle: 'italic' }}>{initMsg || 'Loading…'}</div>
        <div style={{ width: 200, height: 4, background: '#e2e8f0', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', background: 'var(--navy)', animation: 'pulse 1.5s ease-in-out infinite', width: '60%' }} />
        </div>
      </div>
    );
  }

  if (initState === 'error') {
    return (
      <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--radius)', padding: '12px 16px', color: 'var(--red)' }}>
        Failed to initialise DuckDB: {initMsg}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 12, height: 'calc(100vh - 120px)', alignItems: 'start' }}>

      {/* ── Left sidebar ──────────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        overflow: 'auto',
        maxHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', background: '#f8fafc' }}>
          <SchemaPanel tables={tables} onTableClick={handleTableClick} />
        </div>
        <div style={{ padding: '10px 12px' }}>
          <PresetsPanel onSelect={handlePreset} activeTables={activeTables} />
        </div>
      </div>

      {/* ── Right panel: editor + results ─────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, height: '100%' }}>

        {/* Editor card */}
        <div style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
          flexShrink: 0,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            borderBottom: '1px solid var(--border)',
            background: '#f8fafc',
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>
              SQL Editor
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>Ctrl+Enter to run</span>
            <button
              onClick={() => executeQuery()}
              disabled={running || initState !== 'ready'}
              style={{
                marginLeft: 'auto',
                background: running ? '#e2e8f0' : 'var(--navy)',
                color: running ? 'var(--muted)' : '#fff',
                fontSize: 12,
                padding: '5px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {running ? 'Running…' : '▶ Run'}
            </button>
          </div>
          <Editor
            height="220px"
            defaultLanguage="sql"
            value={sql}
            onChange={(v) => setSql(v ?? '')}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
              renderLineHighlight: 'line',
              scrollbar: { vertical: 'auto', horizontal: 'auto' },
              padding: { top: 10, bottom: 10 },
              fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
            }}
            theme="vs"
          />
        </div>

        {/* Error banner */}
        {error && (
          <div style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 'var(--radius)',
            padding: '10px 14px',
            color: 'var(--red)',
            fontSize: 13,
            fontFamily: 'monospace',
            flexShrink: 0,
          }}>
            {error}
          </div>
        )}

        {/* Results card */}
        {result && (
          <div style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}>
            <ResultsTable result={result} />
          </div>
        )}

        {/* Idle hint */}
        {!result && !error && initState === 'ready' && (
          <div style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '32px 24px',
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 13,
          }}>
            Press <strong>▶ Run</strong> or <strong>Ctrl+Enter</strong> to execute the query.
          </div>
        )}
      </div>
    </div>
  );
}
