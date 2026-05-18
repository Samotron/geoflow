import { describe, it, expect } from 'vitest';
import { topoSort, validateNoCycles } from './dag.js';
import type { PipelineEdge, PipelineNode } from './model.js';

function n(id: string): PipelineNode {
  return {
    id,
    kind: 'sql',
    name: id,
    sql: '',
    materialization: 'view',
    position: { x: 0, y: 0 },
  };
}

function e(source: string, target: string): PipelineEdge {
  return { id: `${source}->${target}`, source, target };
}

describe('topoSort', () => {
  it('orders a simple chain', () => {
    const nodes = [n('a'), n('b'), n('c')];
    const edges = [e('a', 'b'), e('b', 'c')];
    const { order, cycles } = topoSort(nodes, edges);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(cycles).toEqual([]);
  });

  it('handles a diamond', () => {
    const nodes = [n('a'), n('b'), n('c'), n('d')];
    const edges = [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')];
    const { order, cycles } = topoSort(nodes, edges);
    expect(cycles).toEqual([]);
    expect(order[0]).toBe('a');
    expect(order[3]).toBe('d');
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('orders disconnected nodes', () => {
    const nodes = [n('x'), n('y')];
    const { order, cycles } = topoSort(nodes, []);
    expect(order.sort()).toEqual(['x', 'y']);
    expect(cycles).toEqual([]);
  });

  it('detects a self-loop cycle', () => {
    const nodes = [n('a')];
    const edges = [e('a', 'a')];
    const { order, cycles } = topoSort(nodes, edges);
    expect(order).toEqual([]);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it('detects a two-node cycle', () => {
    const nodes = [n('a'), n('b')];
    const edges = [e('a', 'b'), e('b', 'a')];
    const { cycles } = topoSort(nodes, edges);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]!.sort()).toEqual(['a', 'b']);
  });

  it('ignores edges that reference unknown nodes', () => {
    const nodes = [n('a')];
    const edges = [e('a', 'ghost')];
    const { order } = topoSort(nodes, edges);
    expect(order).toEqual(['a']);
  });
});

describe('validateNoCycles', () => {
  it('returns ok for a DAG', () => {
    expect(validateNoCycles([n('a'), n('b')], [e('a', 'b')])).toEqual({ ok: true });
  });

  it('returns cycles when present', () => {
    const result = validateNoCycles([n('a'), n('b')], [e('a', 'b'), e('b', 'a')]);
    expect(result.ok).toBe(false);
  });
});
