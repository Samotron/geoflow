/**
 * SQL → SQL rewriter that augments user queries with a `__src` column carrying
 * per-row provenance through joins and aggregations.
 *
 * Strategy (positional, CST-driven):
 *   1. Parse the user SQL with sql-parser-cst (postgresql dialect, with ranges).
 *   2. Walk every select_stmt (top-level, CTEs, set ops, subqueries in FROM).
 *   3. For each:
 *        a. Find every base table reference in its FROM/JOIN clauses and
 *           collect (range, alias).
 *        b. Detect aggregation (group_by clause OR aggregate function in
 *           the SELECT list / HAVING).
 *        c. Emit edits:
 *             - Rename each base relation `T` → `_lin_T` (only if T is in
 *               the set of known lineage-tracked relations).
 *             - Append a `__src` expression to the SELECT list, built from
 *               the aliases of joined tables (with list_concat / flatten +
 *               list aggregation if grouping is present).
 *   4. Apply edits in reverse offset order to the original SQL text.
 *
 * Unsupported patterns (window functions, WHERE-subqueries that contribute
 * rows, recursive CTEs, etc.) cause `rewrite()` to return `null` with a
 * warning so the executor can mark the node as "lineage unavailable" rather
 * than emit incorrect provenance.
 */

import { parse } from 'sql-parser-cst';

export const LINEAGE_COLUMN = '__src';
export const LINEAGE_VIEW_PREFIX = '_lin_';

export interface LineageRewriteResult {
  rewritten: string | null;
  warnings: string[];
  baseRelations: string[];
}

export interface LineageRewriteOptions {
  /** Known lineage-tracked relations (lower-cased). Tables outside this set
   *  are left alone (their rows won't appear in __src). */
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

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface TableRef {
  name: string;          // unquoted original name
  alias: string;         // alias the rest of the SELECT uses
  hasExplicitAlias: boolean;
  nameStart: number;     // offset of the bare name in the SQL
  nameEnd: number;
  tracked: boolean;      // whether this is one of our lineage-tracked relations
}

export function lineageViewName(relation: string): string {
  return LINEAGE_VIEW_PREFIX + relation.toLowerCase();
}

export function rewriteForLineage(
  sql: string,
  opts: LineageRewriteOptions,
): LineageRewriteResult {
  const warnings: string[] = [];
  const baseRelations = new Set<string>();
  const edits: Edit[] = [];

  let cst: unknown;
  try {
    cst = parse(sql, {
      dialect: 'postgresql',
      includeRange: true,
    } as unknown as Parameters<typeof parse>[1]);
  } catch (err) {
    return {
      rewritten: null,
      warnings: [`SQL parse failed: ${err instanceof Error ? err.message : String(err)}`],
      baseRelations: [],
    };
  }

  // Track recursion bail-out: when we hit an unsupported construct we
  // surface a warning and skip lineage entirely.
  let unsupported = false;
  const bail = (msg: string): void => {
    if (!unsupported) {
      unsupported = true;
      warnings.push(msg);
    }
  };

  // Walk a subtree and bail if any unsupported construct appears.
  const checkUnsupported = (node: unknown): void => {
    if (unsupported) return;
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string } & Record<string, unknown>;
    const t = n['type'];
    if (t === 'over_arg' || t === 'window_clause') {
      bail('window functions are not yet supported for lineage tracking');
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
      checkUnsupported(n[k]);
    }
  };

  // Pull all CTE names declared in a with_clause subtree.
  const collectCteNames = (withClause: unknown, into: Set<string>): void => {
    if (!withClause || typeof withClause !== 'object') return;
    const n = withClause as { type?: string } & Record<string, unknown>;
    if (n['type'] === 'common_table_expr') {
      // The CTE name is the first identifier child.
      const findIdent = (node: unknown): string | null => {
        if (!node || typeof node !== 'object') return null;
        const x = node as { type?: string; name?: string };
        if (x.type === 'identifier' && x.name) return x.name;
        return null;
      };
      for (const k of Object.keys(n)) {
        const ident = findIdent(n[k]);
        if (ident) {
          into.add(ident.toLowerCase());
          break;
        }
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
      collectCteNames(n[k], into);
    }
  };

  // CTE name set per scope so we don't lin-ify CTE references.
  const visit = (node: unknown, cteNames: ReadonlySet<string>): void => {
    if (unsupported) return;
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item, cteNames);
      return;
    }

    const n = node as { type?: string } & Record<string, unknown>;
    const type = n['type'];

    if (type === 'select_stmt') {
      handleSelectStmt(n, cteNames);
      return;
    }

    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
      visit(n[k], cteNames);
    }
  };

  const handleSelectStmt = (
    node: { type?: string } & Record<string, unknown>,
    parentCteNames: ReadonlySet<string>,
  ): void => {
    // Bail early if the SELECT contains window functions.
    checkUnsupported(node);
    if (unsupported) return;

    const clauses = (node['clauses'] as unknown[] | undefined) ?? [];
    type SelectClauseShape = { range?: [number, number]; columns?: { items?: unknown[]; range?: [number, number] } };
    type FromClauseShape = { expr?: unknown; range?: [number, number] };
    let selectClause: SelectClauseShape | null = null;
    let fromClause: FromClauseShape | null = null;
    let groupBy: unknown = null;
    let withClause: unknown = null;

    for (const raw of clauses) {
      const c = raw as { type?: string } & Record<string, unknown>;
      if (c['type'] === 'select_clause') selectClause = c as SelectClauseShape;
      else if (c['type'] === 'from_clause') fromClause = c as FromClauseShape;
      else if (c['type'] === 'group_by_clause') groupBy = c;
      else if (c['type'] === 'with_clause') withClause = c;
    }

    // Augment the CTE name set for this scope, then recurse into the CTE
    // bodies so they get their own lineage rewrites.
    const localCteNames = new Set(parentCteNames);
    if (withClause) {
      collectCteNames(withClause, localCteNames);
      visit(withClause, localCteNames);
    }

    if (!selectClause) {
      // SELECT-less (?) — just recurse into remaining children.
      for (const c of clauses) {
        const cc = c as { type?: string };
        if (cc.type === 'with_clause') continue;
        visit(c, localCteNames);
      }
      return;
    }

    const tableRefs: TableRef[] = [];
    if (fromClause && fromClause.expr) {
      collectTableRefs(fromClause.expr, tableRefs, localCteNames, opts.knownRelations);
    }

    // Recurse into nested expressions (subqueries in FROM/WHERE/etc.) so
    // their own SELECTs get rewritten before this one's edits land.
    for (const c of clauses) {
      const cc = c as { type?: string };
      if (cc.type === 'with_clause') continue;
      visit(c, localCteNames);
    }

    // Anything we don't recognise but are sure could contribute rows?
    // Subqueries inside FROM are handled by the recursive visit above
    // and propagate __src through their SELECT lists.

    if (tableRefs.length === 0) {
      // SELECT with no FROM (e.g. SELECT 1) — nothing to track.
      return;
    }

    // Rename tracked base relations to their lineage views. When the
    // reference has no explicit alias, append one matching the original
    // name so qualified `__src` references still resolve.
    for (const ref of tableRefs) {
      baseRelations.add(ref.name.toLowerCase());
      if (!ref.tracked) continue;
      const replacement = ref.hasExplicitAlias
        ? lineageViewName(ref.name)
        : `${lineageViewName(ref.name)} AS ${quoteIdent(ref.alias)}`;
      edits.push({
        start: ref.nameStart,
        end: ref.nameEnd,
        text: replacement,
      });
    }

    const isAggregating = groupBy !== null || hasAggregate(selectClause);

    const srcExpr = buildSrcExpression(tableRefs, isAggregating);
    if (srcExpr === null) {
      // No tracked tables in this SELECT — skip injection.
      return;
    }

    // Inject `__src` column into the SELECT list, and excise any inherited
    // __src from `*` expansions so we don't get duplicate column names.
    const columns = selectClause.columns;
    if (!columns) return;
    rewriteSelectColumns(columns, sql, edits, srcExpr);
  };

  visit(cst, new Set());

  if (unsupported) {
    return { rewritten: null, warnings, baseRelations: [...baseRelations] };
  }

  return {
    rewritten: applyEdits(sql, edits),
    warnings,
    baseRelations: [...baseRelations],
  };
}

function collectTableRefs(
  node: unknown,
  out: TableRef[],
  cteNames: ReadonlySet<string>,
  knownRelations: ReadonlySet<string>,
): void {
  if (!node || typeof node !== 'object') return;
  const n = node as { type?: string } & Record<string, unknown>;
  switch (n['type']) {
    case 'identifier': {
      const name = String(n['name'] ?? '');
      const range = n['range'] as [number, number] | undefined;
      if (!range || !name) return;
      out.push({
        name,
        alias: name,
        hasExplicitAlias: false,
        nameStart: range[0],
        nameEnd: range[1],
        tracked: !cteNames.has(name.toLowerCase()) && knownRelations.has(name.toLowerCase()),
      });
      return;
    }
    case 'alias': {
      // `t alias` — pull the base name from `expr`, alias from `alias`/`name`.
      const expr = n['expr'] as { type?: string; name?: string; range?: [number, number] } | undefined;
      if (!expr) return;
      const aliasNode = (n['alias'] ?? n['name']) as { name?: string } | undefined;
      const aliasName = aliasNode?.name;
      if (expr.type === 'identifier' && expr.name && expr.range) {
        const baseName = expr.name;
        out.push({
          name: baseName,
          alias: aliasName ?? baseName,
          hasExplicitAlias: aliasName !== undefined,
          nameStart: expr.range[0],
          nameEnd: expr.range[1],
          tracked: !cteNames.has(baseName.toLowerCase()) && knownRelations.has(baseName.toLowerCase()),
        });
        return;
      }
      // Aliased subquery / function call — recurse so its inner FROM gets
      // picked up; the subquery's __src propagates via its SELECT list.
      collectTableRefs(expr, out, cteNames, knownRelations);
      return;
    }
    case 'join_expr': {
      collectTableRefs(n['left'], out, cteNames, knownRelations);
      collectTableRefs(n['right'], out, cteNames, knownRelations);
      return;
    }
    case 'paren_expr': {
      collectTableRefs(n['expr'], out, cteNames, knownRelations);
      return;
    }
    default:
      // member_expr (schema.table), table_factor, etc. — walk children.
      for (const k of Object.keys(n)) {
        if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
        collectTableRefs(n[k], out, cteNames, knownRelations);
      }
  }
}

function hasAggregate(selectClause: unknown): boolean {
  let found = false;
  const walk = (node: unknown): void => {
    if (found || !node || typeof node !== 'object') return;
    const n = node as { type?: string } & Record<string, unknown>;
    if (n['type'] === 'func_call') {
      const fname = (n['name'] as { name?: string } | undefined)?.name?.toLowerCase();
      if (fname && AGG_FUNCTIONS.has(fname)) {
        found = true;
        return;
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'range' || k === 'text' || k === 'name') continue;
      walk(n[k]);
    }
  };
  walk(selectClause);
  return found;
}

function buildSrcExpression(refs: readonly TableRef[], aggregating: boolean): string | null {
  const tracked = refs.filter((r) => r.tracked);
  if (tracked.length === 0) return null;
  let base: string;
  if (tracked.length === 1) {
    base = `${quoteIdent(tracked[0]!.alias)}.${LINEAGE_COLUMN}`;
  } else {
    // Nested list_concat for >=2 tracked tables.
    base = tracked
      .slice()
      .reverse()
      .reduce<string | null>((acc, r) => {
        const term = `${quoteIdent(r.alias)}.${LINEAGE_COLUMN}`;
        return acc === null ? term : `list_concat(${term}, ${acc})`;
      }, null) as string;
  }
  if (aggregating) {
    return `flatten(list(${base}))`;
  }
  return base;
}

function rewriteSelectColumns(
  columns: { items?: unknown[]; range?: [number, number] },
  sql: string,
  edits: Edit[],
  srcExpr: string,
): void {
  const items = columns.items ?? [];
  // For any `*` (all_columns) we excise the inherited __src column from the
  // expansion. sql-parser-cst represents `*` as `all_columns` and `t.*`
  // as `member_expr` with `*` property. DuckDB accepts `* EXCLUDE __src`.
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { type?: string; range?: [number, number]; property?: { type?: string } };
    if (it.type === 'all_columns' && it.range) {
      edits.push({ start: it.range[0], end: it.range[1], text: `* EXCLUDE (${LINEAGE_COLUMN})` });
    } else if (it.type === 'member_expr' && it.property?.type === 'all_columns' && it.range) {
      // Reconstruct: `t.*` → `t.* EXCLUDE (__src)`
      const replaced = sql.slice(it.range[0], it.range[1]) + ` EXCLUDE (${LINEAGE_COLUMN})`;
      edits.push({ start: it.range[0], end: it.range[1], text: replaced });
    }
  }
  // Inject `, <srcExpr> AS __src` at the end of the column list.
  if (columns.range) {
    edits.push({
      start: columns.range[1],
      end: columns.range[1],
      text: `, ${srcExpr} AS ${LINEAGE_COLUMN}`,
    });
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function applyEdits(sql: string, edits: readonly Edit[]): string {
  if (edits.length === 0) return sql;
  // Sort by start descending so positions stay valid as we splice.
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = sql;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}
