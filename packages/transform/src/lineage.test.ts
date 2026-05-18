import { describe, it, expect } from 'vitest';
import { rewriteForLineage, lineageViewName } from './lineage.js';

function rewrite(sql: string, known: string[]): { rewritten: string | null; warnings: string[] } {
  const out = rewriteForLineage(sql, { knownRelations: new Set(known.map((s) => s.toLowerCase())) });
  return { rewritten: out.rewritten, warnings: out.warnings };
}

describe('rewriteForLineage', () => {
  it('renames a single FROM table and appends __src', () => {
    const r = rewrite('SELECT id, name FROM loca', ['loca']);
    // No explicit alias → rewriter must add `AS "loca"` so qualified
    // references like `"loca".__src` still resolve after the rename.
    expect(r.rewritten).toContain(`FROM ${lineageViewName('loca')} AS "loca"`);
    expect(r.rewritten).toContain('"loca".__src AS __src');
    expect(r.warnings).toEqual([]);
  });

  it('preserves user-supplied aliases without injecting AS', () => {
    const r = rewrite('SELECT l.id FROM loca l', ['loca']);
    expect(r.rewritten).toContain(`FROM ${lineageViewName('loca')} l`);
    expect(r.rewritten).not.toContain(`AS "loca"`);
    expect(r.rewritten).toContain('"l".__src AS __src');
  });

  it('handles join of two tables without explicit aliases', () => {
    const r = rewrite('SELECT * FROM loca JOIN geol USING (loca_id)', ['loca', 'geol']);
    expect(r.rewritten).toContain(`FROM ${lineageViewName('loca')} AS "loca"`);
    expect(r.rewritten).toContain(`JOIN ${lineageViewName('geol')} AS "geol"`);
    expect(r.rewritten).toContain('list_concat("loca".__src, "geol".__src) AS __src');
  });

  it('joins concatenate per-side __src arrays', () => {
    const r = rewrite('SELECT a.id, b.x FROM loca a JOIN geol b ON a.id = b.id', ['loca', 'geol']);
    expect(r.rewritten).toContain(`FROM ${lineageViewName('loca')} a`);
    expect(r.rewritten).toContain(`JOIN ${lineageViewName('geol')} b`);
    expect(r.rewritten).toContain('list_concat("a".__src, "b".__src) AS __src');
  });

  it('aggregations wrap __src in flatten(list(...))', () => {
    const r = rewrite('SELECT id, COUNT(*) AS n FROM loca GROUP BY id', ['loca']);
    expect(r.rewritten).toContain('flatten(list("loca".__src)) AS __src');
  });

  it('aggregations with joins flatten the concatenation', () => {
    const r = rewrite(
      'SELECT a.id, COUNT(*) AS n FROM loca a JOIN geol b ON a.id = b.id GROUP BY a.id',
      ['loca', 'geol'],
    );
    expect(r.rewritten).toContain('flatten(list(list_concat("a".__src, "b".__src))) AS __src');
  });

  it('expands SELECT * with EXCLUDE to avoid duplicate __src in joins', () => {
    const r = rewrite('SELECT * FROM loca a JOIN geol b ON a.id = b.id', ['loca', 'geol']);
    expect(r.rewritten).toContain('* EXCLUDE (__src)');
    expect(r.rewritten).toContain('list_concat("a".__src, "b".__src) AS __src');
  });

  it('leaves untracked tables alone but warns nothing', () => {
    const r = rewrite('SELECT * FROM external_thing t', ['loca']);
    // Untracked → no rename, no __src injection.
    expect(r.rewritten).toBe('SELECT * FROM external_thing t');
    expect(r.warnings).toEqual([]);
  });

  it('returns null and warns for window functions', () => {
    const r = rewrite(
      'SELECT id, ROW_NUMBER() OVER (PARTITION BY g ORDER BY d) AS rn FROM loca',
      ['loca'],
    );
    expect(r.rewritten).toBeNull();
    expect(r.warnings.some((w) => /window/i.test(w))).toBe(true);
  });

  it('returns null when the SQL fails to parse', () => {
    const r = rewrite('SELEC frum nope', ['loca']);
    expect(r.rewritten).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('does not rewrite a CTE reference, only its definition body', () => {
    const r = rewrite(
      `WITH alive AS (SELECT * FROM loca WHERE LOCA_FDEP IS NOT NULL)
       SELECT id FROM alive`,
      ['loca'],
    );
    // CTE body should reference _lin_loca…
    expect(r.rewritten).toContain(`FROM ${lineageViewName('loca')}`);
    // …but the outer SELECT must keep `alive` (not `_lin_alive`).
    expect(r.rewritten).not.toContain('_lin_alive');
  });
});
