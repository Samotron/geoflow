import Editor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoNS from 'monaco-editor';
import { useEffect, useRef } from 'react';

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
  'CROSS JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'BETWEEN',
  'LIKE', 'ILIKE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'DISTINCT', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'WITH', 'CASE',
  'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'COALESCE', 'COUNT', 'SUM', 'AVG',
  'MIN', 'MAX', 'ROUND', 'ABS', 'PARTITION BY', 'OVER', 'ASC', 'DESC',
];

const DUCKDB_FUNCTIONS = [
  'list_aggregate', 'unnest', 'struct_extract', 'json_extract',
  'regexp_matches', 'string_split', 'string_agg',
];

const SPATIAL_FUNCTIONS = [
  'ST_Point', 'ST_MakePoint', 'ST_X', 'ST_Y', 'ST_AsText', 'ST_AsGeoJSON',
  'ST_GeomFromText', 'ST_GeomFromGeoJSON', 'ST_GeomFromWKB', 'ST_AsWKB',
  'ST_Buffer', 'ST_Distance', 'ST_Within', 'ST_Contains', 'ST_Intersects',
  'ST_Transform', 'ST_Area', 'ST_Length', 'ST_Centroid', 'ST_Envelope',
];

interface Props {
  value: string;
  onChange: (v: string) => void;
  availableRefs: string[];
  availableTables: { name: string; columns: string[] }[];
  height?: number | string;
}

export function SqlNodeEditor(props: Props) {
  const { value, onChange, availableRefs, availableTables, height = 220 } = props;
  const refsRef = useRef(availableRefs);
  const tablesRef = useRef(availableTables);
  useEffect(() => { refsRef.current = availableRefs; }, [availableRefs]);
  useEffect(() => { tablesRef.current = availableTables; }, [availableTables]);

  const handleMount: OnMount = (_editor, monaco) => {
    // Avoid registering the same provider twice across remounts.
    const flag = '__geoflow_transform_sql_completion__';
    type WithFlag = typeof monaco & Record<string, unknown>;
    const monacoWithFlag = monaco as WithFlag;
    if (monacoWithFlag[flag]) return;
    monacoWithFlag[flag] = true;

    monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', "'", '(', ' ', '{'],
      provideCompletionItems: (model: MonacoNS.editor.ITextModel, position: MonacoNS.Position) => {
        const word = model.getWordUntilPosition(position);
        const range: MonacoNS.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const suggestions: MonacoNS.languages.CompletionItem[] = [];

        // ref('…') snippet — pop a list of node names
        const refMatch = line.match(/\{\{\s*ref\s*\(\s*['"]?([\w]*)$/);
        if (refMatch) {
          for (const ref of refsRef.current) {
            suggestions.push({
              label: ref,
              kind: monaco.languages.CompletionItemKind.Reference,
              insertText: ref,
              range,
            });
          }
          return { suggestions };
        }

        // Dot-prefixed column completion: tableAlias.col
        const dotMatch = line.match(/([\w]+)\.$/);
        if (dotMatch) {
          const alias = dotMatch[1]!.toLowerCase();
          const table = tablesRef.current.find((t) => t.name.toLowerCase() === alias);
          if (table) {
            for (const col of table.columns) {
              suggestions.push({
                label: col,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: col,
                range,
              });
            }
            return { suggestions };
          }
        }

        // Default suggestions: keywords, functions, refs (as full snippet), tables
        for (const k of SQL_KEYWORDS) {
          suggestions.push({
            label: k,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: k,
            range,
          });
        }
        for (const f of [...DUCKDB_FUNCTIONS, ...SPATIAL_FUNCTIONS]) {
          suggestions.push({
            label: f,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: `${f}($1)`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRules.InsertAsSnippet,
            range,
          });
        }
        for (const ref of refsRef.current) {
          suggestions.push({
            label: `ref('${ref}')`,
            kind: monaco.languages.CompletionItemKind.Reference,
            insertText: `{{ ref('${ref}') }}`,
            range,
            detail: 'Upstream node',
          });
        }
        for (const t of tablesRef.current) {
          suggestions.push({
            label: t.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: t.name,
            range,
            detail: `${t.columns.length} columns`,
          });
        }
        return { suggestions };
      },
    });
  };

  return (
    <Editor
      height={height}
      language="sql"
      theme="vs"
      value={value}
      onMount={handleMount}
      onChange={(v) => onChange(v ?? '')}
      options={{
        fontSize: 12,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        lineNumbers: 'on',
        renderLineHighlight: 'all',
        suggest: { showInlineDetails: true },
        quickSuggestions: { other: true, comments: false, strings: true },
        automaticLayout: true,
      }}
    />
  );
}
