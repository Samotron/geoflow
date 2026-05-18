import { describe, it, expect } from 'vitest';
import { extractRefs, extractSources, quoteIdent, resolveRefs } from './refs.js';

describe('extractRefs', () => {
  it('returns unique ref names', () => {
    const sql = "SELECT * FROM {{ ref('foo') }} JOIN {{ ref('bar') }} USING (id) JOIN {{ ref('foo') }} x USING (id)";
    expect(extractRefs(sql).sort()).toEqual(['bar', 'foo']);
  });

  it('handles both quote styles', () => {
    expect(extractRefs(`SELECT * FROM {{ ref("baz") }}`)).toEqual(['baz']);
  });

  it('returns empty when no refs', () => {
    expect(extractRefs('SELECT 1')).toEqual([]);
  });

  it('ignores malformed ref syntax', () => {
    expect(extractRefs("SELECT {{ ref(foo) }}")).toEqual([]);
    expect(extractRefs("SELECT {{ ref('a' }}")).toEqual([]);
  });
});

describe('extractSources', () => {
  it('finds source() references', () => {
    const sql = "SELECT * FROM {{ source('loca') }}";
    expect(extractSources(sql)).toEqual(['loca']);
  });
});

describe('resolveRefs', () => {
  it('substitutes resolved relation names', () => {
    const sql = "SELECT * FROM {{ ref('upstream') }}";
    const out = resolveRefs(sql, (name) => quoteIdent(name.toLowerCase()));
    expect(out).toBe('SELECT * FROM "upstream"');
  });

  it('substitutes multiple distinct refs', () => {
    const sql = "SELECT * FROM {{ ref('a') }} JOIN {{ ref('b') }} USING (id)";
    const out = resolveRefs(sql, (name) => quoteIdent(name));
    expect(out).toBe('SELECT * FROM "a" JOIN "b" USING (id)');
  });

  it('uses source resolver for source()', () => {
    const sql = "SELECT * FROM {{ source('loca') }}";
    const out = resolveRefs(sql, (n) => `R(${n})`, (n) => `S(${n})`);
    expect(out).toBe('SELECT * FROM S(loca)');
  });
});

describe('quoteIdent', () => {
  it('quotes plain identifier', () => {
    expect(quoteIdent('foo')).toBe('"foo"');
  });

  it('escapes embedded quotes', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});
