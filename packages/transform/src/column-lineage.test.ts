import { describe, it, expect } from 'vitest';
import { extractColumnLineage } from './column-lineage.js';

function lineage(sql: string, known: string[]) {
  return extractColumnLineage(sql, { knownRelations: new Set(known.map((s) => s.toLowerCase())) });
}

describe('extractColumnLineage', () => {
  it('resolves a qualified column reference', () => {
    const r = lineage('SELECT l.loca_id, l.loca_gl FROM loca l', ['loca']);
    expect(r.outputs).toEqual([
      { name: 'loca_id', sources: [{ relation: 'loca', column: 'loca_id' }], derivation: 'direct' },
      { name: 'loca_gl', sources: [{ relation: 'loca', column: 'loca_gl' }], derivation: 'direct' },
    ]);
  });

  it('handles an unaliased FROM', () => {
    const r = lineage('SELECT loca.loca_id FROM loca', ['loca']);
    expect(r.outputs?.[0]).toMatchObject({
      name: 'loca_id',
      sources: [{ relation: 'loca', column: 'loca_id' }],
      derivation: 'direct',
    });
  });

  it('returns all FROM candidates for ambiguous bare columns', () => {
    const r = lineage('SELECT loca_id FROM loca, geol', ['loca', 'geol']);
    const sources = r.outputs?.[0]?.sources ?? [];
    expect(sources).toContainEqual({ relation: 'loca', column: 'loca_id' });
    expect(sources).toContainEqual({ relation: 'geol', column: 'loca_id' });
  });

  it('expressions accumulate all referenced columns', () => {
    const r = lineage(
      'SELECT (a.x + b.y) AS sum FROM ta a JOIN tb b ON a.id = b.id',
      ['ta', 'tb'],
    );
    expect(r.outputs?.[0]).toEqual({
      name: 'sum',
      sources: [
        { relation: 'ta', column: 'x' },
        { relation: 'tb', column: 'y' },
      ],
      derivation: 'expression',
    });
  });

  it('aggregations tag the derivation but keep the inner sources', () => {
    const r = lineage('SELECT SUM(a.x) AS total FROM ta a', ['ta']);
    expect(r.outputs?.[0]).toEqual({
      name: 'total',
      sources: [{ relation: 'ta', column: 'x' }],
      derivation: 'aggregated',
    });
  });

  it('COUNT(*) is aggregated with no specific source columns', () => {
    const r = lineage('SELECT COUNT(*) AS n FROM ta a', ['ta']);
    const out = r.outputs?.[0];
    expect(out?.derivation).toBe('aggregated');
    expect(out?.sources).toEqual([]);
  });

  it('literals have no sources', () => {
    const r = lineage('SELECT 1 AS one, \'hello\' AS greeting FROM ta', ['ta']);
    expect(r.outputs?.[0]?.derivation).toBe('literal');
    expect(r.outputs?.[1]?.derivation).toBe('literal');
  });

  it('SELECT * yields a star output keyed to the source relation', () => {
    const r = lineage('SELECT * FROM loca', ['loca']);
    expect(r.outputs?.[0]).toMatchObject({ derivation: 'star', starOf: 'loca' });
  });

  it('SELECT t.* respects the qualifier', () => {
    const r = lineage('SELECT a.* FROM ta a JOIN tb b ON a.id = b.id', ['ta', 'tb']);
    expect(r.outputs).toHaveLength(1);
    expect(r.outputs?.[0]).toMatchObject({ derivation: 'star', starOf: 'ta' });
  });

  it('CTE references resolve to the CTE body sources', () => {
    const r = lineage(
      `WITH cleaned AS (SELECT l.loca_id AS id, l.loca_fdep AS depth FROM loca l)
       SELECT cleaned.id, cleaned.depth FROM cleaned`,
      ['loca'],
    );
    const idOut = r.outputs?.find((c) => c.name === 'id');
    const depthOut = r.outputs?.find((c) => c.name === 'depth');
    expect(idOut?.sources).toEqual([{ relation: 'loca', column: 'loca_id' }]);
    expect(depthOut?.sources).toEqual([{ relation: 'loca', column: 'loca_fdep' }]);
  });

  it('returns null and warns for window functions', () => {
    const r = lineage(
      'SELECT ROW_NUMBER() OVER (PARTITION BY g) AS rn FROM ta',
      ['ta'],
    );
    expect(r.outputs).toBeNull();
    expect(r.warnings.some((w) => /window/i.test(w))).toBe(true);
  });

  it('returns null when SQL fails to parse', () => {
    const r = lineage('NOT SQL', ['ta']);
    expect(r.outputs).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
