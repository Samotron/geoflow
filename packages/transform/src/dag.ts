import type { PipelineEdge, PipelineNode } from './model.js';

export interface TopoResult {
  order: string[];
  cycles: string[][];
}

export function buildAdjacency(
  nodes: readonly PipelineNode[],
  edges: readonly PipelineEdge[],
): { outgoing: Map<string, string[]>; incoming: Map<string, string[]> } {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const n of nodes) {
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  }
  for (const e of edges) {
    if (!outgoing.has(e.source) || !incoming.has(e.target)) continue;
    outgoing.get(e.source)!.push(e.target);
    incoming.get(e.target)!.push(e.source);
  }
  return { outgoing, incoming };
}

export function topoSort(
  nodes: readonly PipelineNode[],
  edges: readonly PipelineEdge[],
): TopoResult {
  const { outgoing, incoming } = buildAdjacency(nodes, edges);
  const inDegree = new Map<string, number>();
  for (const [id, list] of incoming) inDegree.set(id, list.length);

  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  queue.sort();

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
    queue.sort();
  }

  const cycles: string[][] = [];
  if (order.length !== nodes.length) {
    const remaining = new Set(nodes.map((n) => n.id).filter((id) => !order.includes(id)));
    const visited = new Set<string>();
    for (const start of remaining) {
      if (visited.has(start)) continue;
      const stack: string[] = [];
      const onStack = new Set<string>();
      const dfs = (id: string): boolean => {
        stack.push(id);
        onStack.add(id);
        visited.add(id);
        for (const next of outgoing.get(id) ?? []) {
          if (!remaining.has(next)) continue;
          if (onStack.has(next)) {
            const idx = stack.indexOf(next);
            cycles.push(stack.slice(idx));
            return true;
          }
          if (!visited.has(next) && dfs(next)) return true;
        }
        stack.pop();
        onStack.delete(id);
        return false;
      };
      dfs(start);
    }
  }

  return { order, cycles };
}

export function validateNoCycles(
  nodes: readonly PipelineNode[],
  edges: readonly PipelineEdge[],
): { ok: true } | { ok: false; cycles: string[][] } {
  const { cycles } = topoSort(nodes, edges);
  return cycles.length === 0 ? { ok: true } : { ok: false, cycles };
}
