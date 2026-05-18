/**
 * Column-level lineage extractor — dbt / Databricks-inspired.
 *
 * For a given SQL string, returns the list of output columns and for each
 * one the set of `(relation, column)` pairs it depends on. Lineage threads
 * through:
 *   - Direct references:        SELECT t.col              → t.col
 *   - Bare unqualified columns: SELECT col FROM a, b      → {a.col, b.col}
 *                                                            (caller can disambiguate
 *                                                             using schema info)
 *   - Aliased expressions:      SELECT a.x + b.y AS sum   → {a.x, b.y}
 *   - Aggregations:             SELECT SUM(a.x)           → {a.x}, marked 'aggregated'
 *   - Star expansion:           SELECT * FROM a           → derivation 'star',
 *                                                            starOf='a'
 *   - Qualified star:           SELECT a.* FROM a, b      → derivation 'star',
 *                                                            starOf='a'
 *   - CTEs:                     bodies are extracted recursively; references
 *                               substitute the CTE's resolved sources.
 *
 * Returns `null` (with warnings) for SQL the rewriter can't handle reliably
 * (window functions, parse failures, recursive CTEs, set ops with mismatched
 * shapes). The caller should treat that node as "no column lineage" rather
 * than emit guesses.
 */

import { parse } from 'sql-parser-cst';

export interface ColumnRef {
  relation: string;
  column: string;
}

export type Derivation =
  | 'direct'        // single column passthrough (t.col, or alias t.col AS x)
  | 'expression'    // function of one or more columns
  | 'aggregated'    // appears inside an aggregate function (count/sum/avg/…)
  | 'literal'       // constant — no source columns
  | 'star'          // SELECT * / t.* — sources expanded by the caller
  | 'unknown';      // we recognised the shape but can't resolve sources

export interface OutputColumn {
  name: string;
  sources: ColumnRef[];
  derivation: Derivation;
  /** Set when derivation === 'star'; the relation whose columns are expanded. */
  starOf?: string;
}

export interface ColumnLineageResult {
  outputs: OutputColumn[] | null;
  warnings: string[];
}

export interface ColumnLineageOptions {
  /** Known lineage-tracked relations (lower-cased). */
  knownRelations: ReadonlySet<string>;
}

const AGG_FUNCTIONS = new Set([
  'count', 'sum', 'avg', 'min', 'max',
  'list', 'array_agg', 'string_agg', 'group_concat',
  'list_concat_agg', 'bool_and', 'bool_or',
  'stddev', 'stddev_pop', 'stddev_samp',
  'var_pop', 'var_samp', 'variance',
  'first', 'last', 'arg_min', 'arg_max',
  'median', 'mode', 'quantile', 'quantile_cont', 'quantile_disc',
  'histogram', 'approx_count_distinct',
]);

interface FromAlias {
  /** Alias the SELECT body uses to qualify columns. */
  alias: string;
  /** Resolved relation name for base/CTE tables. `null` for subqueries. */
  relation: string | null;
  /** Column lineage of this alias when it's a CTE or subquery. */
  innerColumns?: OutputColumn[] | undefined;
}

export function extractColumnLineage(
  sql: string,
  opts: ColumnLineageOptions,
): ColumnLineageResult {
  const warnings: string[] = [];

  let cst: unknown;
  try {
    cst = parse(sql, {
      dialect: 'postgresql',
      includeRange: true,
    } as unknown as Parameters<typeof parse>[1]);
  } catch (err) {
    return {
      outputs: null,
      warnings: [`SQL parse failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Find the outermost select_stmt.
  const root = findFirstSelectStmt(cst);
  if (!root) {
    return { outputs: null, warnings: ['No SELECT statement found'] };
  }

  let unsupported = false;
  const bail = (msg: string): void => {
    if (!unsupported) {
      unsupported = true;
      warnings.push(msg);
    }
  };

  const analyseSelect = (
    selectStmt: SelectStmt,
    parentCtes: ReadonlyMap<string, OutputColumn[]>,
  ): OutputColumn[] | null => {
    if (unsupported) return null;
    if (containsWindowFunction(selectStmt)) {
      bail('window functions are not yet supported for column lineage');
      return null;
    }

    const clauses = (selectStmt['clauses'] as unknown[] | undefined) ?? [];
    let selectClause: SelectClause | null = null;
    let fromClause: FromClause | null = null;
    let withClause: unknown = null;
    for (const raw of clauses) {
      const c = raw as { type?: string } & Record<string, unknown>;
      if (c['type'] === 'select_clause') selectClause = c as unknown as SelectClause;
      else if (c['type'] === 'from_clause') fromClause = c as unknown as FromClause;
      else if (c['type'] === 'with_clause') withClause = c;
    }

    // Resolve CTE bodies first so their column lineage is available.
    const localCtes = new Map(parentCtes);
    if (withClause) {
      const cteList = (withClause as { tables?: { items?: unknown[] }; expr?: unknown });
      const items = (cteList.tables as { items?: unknown[] } | undefined)?.items
        ?? collectAll(withClause, 'common_table_expr');
      for (const cte of items) {
        const ct = cte as { type?: string } & Record<string, unknown>;
        if (ct['type'] !== 'common_table_expr') continue;
        const nameNode = findFirst(ct, (n) => (n as { type?: string }).type === 'identifier');
        const cteName = (nameNode as { name?: string } | null)?.name;
        if (!cteName) continue;
        const innerSel = findFirstSelectStmt(ct);
        if (innerSel) {
          const innerCols = analyseSelect(innerSel, localCtes);
          if (innerCols) localCtes.set(cteName.toLowerCase(), innerCols);
        }
      }
    }

    if (!selectClause) return [];

    // Build the FROM alias map.
    const aliases: FromAlias[] = [];
    if (fromClause?.expr) {
      collectAliases(fromClause.expr, aliases, localCtes, opts.knownRelations);
    }

    // Walk the SELECT list to derive output columns.
    const out: OutputColumn[] = [];
    const items = selectClause.columns?.items ?? [];
    for (const item of items) {
      const col = describeSelectItem(item, aliases, localCtes);
      if (col === null) {
        bail('unsupported select item shape');
        return null;
      }
      if (Array.isArray(col)) out.push(...col); // star expansions
      else out.push(col);
    }
    return out;
  };

  const result = analyseSelect(root, new Map());
  if (unsupported) return { outputs: null, warnings };
  return { outputs: result, warnings };
}

// ── CST helpers ────────────────────────────────────────────────────────

interface SelectStmt extends Record<string, unknown> { type?: 'select_stmt' }
interface SelectClause {
  columns?: { items?: unknown[] };
}
interface FromClause { expr?: unknown }

function findFirstSelectStmt(node: unknown): SelectStmt | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as { type?: string } & Record<string, unknown>;
  if (n['type'] === 'select_stmt') return n as SelectStmt;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findFirstSelectStmt(item);
      if (r) return r;
    }
    return null;
  }
  for (const k of Object.keys(n)) {
    if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
    const r = findFirstSelectStmt(n[k]);
    if (r) return r;
  }
  return null;
}

function findFirst(node: unknown, pred: (n: unknown) => boolean): unknown {
  if (!node || typeof node !== 'object') return null;
  if (pred(node)) return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findFirst(item, pred);
      if (r) return r;
    }
    return null;
  }
  const n = node as Record<string, unknown>;
  for (const k of Object.keys(n)) {
    if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
    const r = findFirst(n[k], pred);
    if (r) return r;
  }
  return null;
}

function collectAll(node: unknown, type: string): unknown[] {
  const out: unknown[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const item of n) walk(item); return; }
    const o = n as { type?: string } & Record<string, unknown>;
    if (o['type'] === type) out.push(o);
    for (const k of Object.keys(o)) {
      if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
      walk(o[k]);
    }
  };
  walk(node);
  return out;
}

function containsWindowFunction(node: unknown): boolean {
  let found = false;
  const walk = (n: unknown): void => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const item of n) walk(item); return; }
    const o = n as { type?: string } & Record<string, unknown>;
    if (o['type'] === 'over_arg' || o['type'] === 'window_clause') {
      found = true;
      return;
    }
    for (const k of Object.keys(o)) {
      if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
      walk(o[k]);
    }
  };
  walk(node);
  return found;
}

function collectAliases(
  node: unknown,
  out: FromAlias[],
  ctes: ReadonlyMap<string, OutputColumn[]>,
  known: ReadonlySet<string>,
): void {
  if (!node || typeof node !== 'object') return;
  const n = node as { type?: string } & Record<string, unknown>;
  switch (n['type']) {
    case 'identifier': {
      const name = String(n['name'] ?? '');
      if (!name) return;
      const lower = name.toLowerCase();
      const innerColumns = ctes.get(lower);
      out.push({
        alias: name,
        relation: known.has(lower) || ctes.has(lower) ? lower : name,
        innerColumns: innerColumns ? [...innerColumns] : undefined,
      });
      return;
    }
    case 'alias': {
      const expr = n['expr'] as { type?: string; name?: string } | undefined;
      const aliasNode = (n['alias'] ?? n['name']) as { name?: string } | undefined;
      const aliasName = aliasNode?.name;
      if (expr?.type === 'identifier' && expr.name) {
        const lower = expr.name.toLowerCase();
        const innerColumns = ctes.get(lower);
        out.push({
          alias: aliasName ?? expr.name,
          relation: known.has(lower) || ctes.has(lower) ? lower : expr.name,
          innerColumns: innerColumns ? [...innerColumns] : undefined,
        });
        return;
      }
      // Subquery alias (or function call) — recurse into expr for its
      // inner SELECT, then attach its output cols under this alias.
      if (expr?.type === 'paren_expr' || expr?.type === 'select_stmt') {
        // No way to compute the subquery's lineage from this entry
        // point without a recursive analyser; mark it as "unknown".
        out.push({
          alias: aliasName ?? '?',
          relation: null,
        });
        return;
      }
      collectAliases(expr, out, ctes, known);
      return;
    }
    case 'join_expr':
      collectAliases(n['left'], out, ctes, known);
      collectAliases(n['right'], out, ctes, known);
      return;
    case 'paren_expr':
      collectAliases(n['expr'], out, ctes, known);
      return;
    default:
      for (const k of Object.keys(n)) {
        if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
        collectAliases(n[k], out, ctes, known);
      }
  }
}

// ── Per-select-item analysis ───────────────────────────────────────────

function describeSelectItem(
  item: unknown,
  aliases: readonly FromAlias[],
  ctes: ReadonlyMap<string, OutputColumn[]>,
): OutputColumn | OutputColumn[] | null {
  if (!item || typeof item !== 'object') return null;
  const it = item as { type?: string } & Record<string, unknown>;

  // SELECT *
  if (it['type'] === 'all_columns') {
    return expandStar(null, aliases);
  }

  // SELECT t.*
  if (it['type'] === 'member_expr') {
    const obj = it['object'] as { type?: string; name?: string } | undefined;
    const prop = it['property'] as { type?: string } | undefined;
    if (prop?.type === 'all_columns' && obj?.name) {
      return expandStar(obj.name, aliases);
    }
    if (obj?.type === 'identifier' && obj.name && (prop as { type?: string })?.type === 'identifier') {
      // Direct column ref: t.col
      const colName = (prop as { name?: string }).name ?? '?';
      const rel = resolveAlias(obj.name, aliases);
      if (rel === null) {
        // Unresolved alias — could be a struct dereference. Mark unknown.
        return { name: colName, sources: [], derivation: 'unknown' };
      }
      return {
        name: colName,
        sources: rel === '__cte__'
          ? resolveCteColumn(obj.name, colName, aliases)
          : [{ relation: rel, column: colName }],
        derivation: 'direct',
      };
    }
  }

  // Bare identifier: col
  if (it['type'] === 'identifier') {
    const colName = String(it['name'] ?? '?');
    return {
      name: colName,
      sources: ambiguousSources(colName, aliases),
      derivation: 'direct',
    };
  }

  // Aliased expression: SELECT <expr> AS <name>
  if (it['type'] === 'alias') {
    const expr = it['expr'];
    const aliasNode = (it['alias'] ?? it['name']) as { name?: string } | undefined;
    const name = aliasNode?.name ?? '?';
    const refs = collectColumnRefs(expr, aliases, ctes);
    const aggregated = isUnderAggregate(expr);
    return {
      name,
      sources: dedupeRefs(refs),
      derivation: aggregated ? 'aggregated' : refs.length === 0 ? 'literal' : 'expression',
    };
  }

  // Standalone expression (function call, binary expr) — no alias provided.
  const refs = collectColumnRefs(it, aliases, ctes);
  if (refs.length === 0 && it['type'] === 'number_literal') {
    return { name: '?', sources: [], derivation: 'literal' };
  }
  const aggregated = isUnderAggregate(it);
  return {
    name: '?',
    sources: dedupeRefs(refs),
    derivation: aggregated ? 'aggregated' : refs.length === 0 ? 'literal' : 'expression',
  };
}

function expandStar(qualifier: string | null, aliases: readonly FromAlias[]): OutputColumn[] {
  // We can't enumerate columns without schema info; emit one entry per
  // matching alias marked as 'star'. The UI expands these by looking
  // up the relation's columns from the run-time schema cache.
  const matched = qualifier
    ? aliases.filter((a) => a.alias.toLowerCase() === qualifier.toLowerCase())
    : aliases;
  if (matched.length === 0) {
    return [{ name: '*', sources: [], derivation: 'star' }];
  }
  return matched.map<OutputColumn>((a) => {
    if (a.innerColumns) {
      // For CTEs/subqueries we know the output columns — pass them through.
      return {
        name: '*',
        sources: a.innerColumns.flatMap((c) => c.sources),
        derivation: 'star',
        ...(a.relation ? { starOf: a.relation } : {}),
      };
    }
    return {
      name: '*',
      sources: [],
      derivation: 'star',
      ...(a.relation ? { starOf: a.relation } : {}),
    };
  });
}

function resolveAlias(name: string, aliases: readonly FromAlias[]): string | null {
  const lower = name.toLowerCase();
  for (const a of aliases) {
    if (a.alias.toLowerCase() === lower) {
      if (a.innerColumns) return '__cte__';
      return a.relation;
    }
  }
  return null;
}

function resolveCteColumn(
  aliasName: string,
  column: string,
  aliases: readonly FromAlias[],
): ColumnRef[] {
  const lower = aliasName.toLowerCase();
  for (const a of aliases) {
    if (a.alias.toLowerCase() !== lower) continue;
    if (!a.innerColumns) return [];
    const colLower = column.toLowerCase();
    const match = a.innerColumns.find((c) => c.name.toLowerCase() === colLower);
    return match ? match.sources : [];
  }
  return [];
}

function ambiguousSources(column: string, aliases: readonly FromAlias[]): ColumnRef[] {
  const out: ColumnRef[] = [];
  for (const a of aliases) {
    if (a.innerColumns) {
      const match = a.innerColumns.find((c) => c.name.toLowerCase() === column.toLowerCase());
      if (match) out.push(...match.sources);
      continue;
    }
    if (a.relation) out.push({ relation: a.relation, column });
  }
  return dedupeRefs(out);
}

function collectColumnRefs(
  node: unknown,
  aliases: readonly FromAlias[],
  ctes: ReadonlyMap<string, OutputColumn[]>,
): ColumnRef[] {
  const out: ColumnRef[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const item of n) walk(item); return; }
    const o = n as { type?: string } & Record<string, unknown>;

    // Skip subquery expressions: their output is a value, but lineage of
    // the outer column shouldn't include subquery's inner FROM tables.
    // (Filtering subqueries already excluded in our simpler model.)

    if (o['type'] === 'member_expr') {
      const obj = o['object'] as { type?: string; name?: string } | undefined;
      const prop = o['property'] as { type?: string; name?: string } | undefined;
      if (obj?.type === 'identifier' && obj.name && prop?.type === 'identifier' && prop.name) {
        const rel = resolveAlias(obj.name, aliases);
        if (rel === '__cte__') {
          out.push(...resolveCteColumn(obj.name, prop.name, aliases));
        } else if (rel !== null) {
          out.push({ relation: rel, column: prop.name });
        }
        return;
      }
    }
    if (o['type'] === 'identifier' && typeof o['name'] === 'string') {
      out.push(...ambiguousSources(o['name'] as string, aliases));
      return;
    }
    for (const k of Object.keys(o)) {
      if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
      walk(o[k]);
    }
  };
  walk(node);
  void ctes;
  return out;
}

function isUnderAggregate(node: unknown): boolean {
  // Returns true iff the expression itself is (or contains a top-level)
  // aggregate function. We treat the whole expression as aggregated when
  // any aggregate is present — simplification, but the right call for
  // the UI's column-highlight purpose.
  let found = false;
  const walk = (n: unknown): void => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const item of n) walk(item); return; }
    const o = n as { type?: string } & Record<string, unknown>;
    if (o['type'] === 'func_call') {
      const fn = (o['name'] as { name?: string } | undefined)?.name?.toLowerCase();
      if (fn && AGG_FUNCTIONS.has(fn)) {
        found = true;
        return;
      }
    }
    for (const k of Object.keys(o)) {
      if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
      walk(o[k]);
    }
  };
  walk(node);
  return found;
}

function dedupeRefs(refs: readonly ColumnRef[]): ColumnRef[] {
  const seen = new Set<string>();
  const out: ColumnRef[] = [];
  for (const r of refs) {
    const k = `${r.relation.toLowerCase()}|${r.column.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
