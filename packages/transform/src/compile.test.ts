import { describe, it, expect } from 'vitest';
import { compile } from './compile.js';
import type { Pipeline, PipelineNode } from './model.js';

function pipeline(nodes: PipelineNode[], edges: Pipeline['edges'] = []): Pipeline {
  return {
    schemaVersion: 1,
    id: 'p1',
    name: 'test',
    projectId: null,
    nodes,
    edges,
    createdAt: 0,
    updatedAt: 0,
  };
}

const POS = { x: 0, y: 0 };

describe('compile', () => {
  it('compiles a source → sql → output chain', () => {
    const p = pipeline(
      [
        { id: 's', kind: 'source', name: 'loca', table: 'loca', position: POS },
        {
          id: 'm', kind: 'sql', name: 'loca_filtered',
          sql: "SELECT * FROM {{ ref('loca') }} WHERE loca_id IS NOT NULL",
          materialization: 'view', position: POS,
        },
        { id: 'o', kind: 'output', name: 'out1', format: 'preview', rowLimit: 50, position: POS },
      ],
      [
        { id: 'e1', source: 's', target: 'm' },
        { id: 'e2', source: 'm', target: 'o' },
      ],
    );
    const { steps, errors } = compile(p);
    expect(errors).toEqual([]);
    expect(steps.map((s) => s.nodeId)).toEqual(['s', 'm', 'o']);
    expect(steps[1]!.sql).toContain('CREATE OR REPLACE VIEW "loca_filtered" AS');
    expect(steps[1]!.sql).toContain('FROM "loca"');
    expect(steps[2]!.preview).toBe('SELECT * FROM "loca_filtered" LIMIT 50');
  });

  it('respects the materialization option', () => {
    const p = pipeline([
      {
        id: 'm', kind: 'sql', name: 'tbl', sql: 'SELECT 1 AS x',
        materialization: 'table', position: POS,
      },
    ]);
    const { steps } = compile(p);
    expect(steps[0]!.sql).toContain('CREATE OR REPLACE TABLE "tbl"');
  });

  it('reports unknown refs', () => {
    const p = pipeline([
      {
        id: 'm', kind: 'sql', name: 'm', sql: "SELECT * FROM {{ ref('ghost') }}",
        materialization: 'view', position: POS,
      },
    ]);
    const { errors } = compile(p);
    expect(errors.some((e) => /Unknown ref/.test(e.message))).toBe(true);
  });

  it('rejects invalid node names', () => {
    const p = pipeline([
      {
        id: 'm', kind: 'sql', name: '1bad name', sql: 'SELECT 1',
        materialization: 'view', position: POS,
      },
    ]);
    const { errors } = compile(p);
    expect(errors.some((e) => /Invalid relation name/.test(e.message))).toBe(true);
  });

  it('rejects duplicate node names (case-insensitive)', () => {
    const p = pipeline([
      { id: 'a', kind: 'sql', name: 'foo', sql: 'SELECT 1', materialization: 'view', position: POS },
      { id: 'b', kind: 'sql', name: 'FOO', sql: 'SELECT 2', materialization: 'view', position: POS },
    ]);
    const { errors } = compile(p);
    expect(errors.some((e) => /Duplicate/.test(e.message))).toBe(true);
  });

  it('flags sources missing from the registered table set', () => {
    const p = pipeline([
      { id: 's', kind: 'source', name: 'loca', table: 'loca', position: POS },
    ]);
    const { errors } = compile(p, { existingTables: new Set(['samp']) });
    expect(errors.some((e) => /not registered/.test(e.message))).toBe(true);
  });

  it('reports outputs with no upstream', () => {
    const p = pipeline([
      { id: 'o', kind: 'output', name: 'out', format: 'preview', rowLimit: 100, position: POS },
    ]);
    const { errors } = compile(p);
    expect(errors.some((e) => /no upstream/.test(e.message))).toBe(true);
  });

  it('reports cycles', () => {
    const p = pipeline(
      [
        { id: 'a', kind: 'sql', name: 'a', sql: "SELECT * FROM {{ ref('b') }}", materialization: 'view', position: POS },
        { id: 'b', kind: 'sql', name: 'b', sql: "SELECT * FROM {{ ref('a') }}", materialization: 'view', position: POS },
      ],
      [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    );
    const { errors } = compile(p);
    expect(errors.some((e) => /Cycle/.test(e.message))).toBe(true);
  });
});
