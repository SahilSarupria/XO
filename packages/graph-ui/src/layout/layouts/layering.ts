import type { GraphModel } from '../../model/GraphModel.js';
import type { GraphLayoutOptions, GraphLayoutResult, LayoutPosition, NodeId } from '../../model/types.js';

/**
 * Shared layered-layout algorithm used by both the hierarchical and DAG
 * layouts: assign each node a layer via longest-path-from-root (falling
 * back to BFS depth for cyclic input), then space nodes within a layer
 * evenly. Deterministic given deterministic node/edge order.
 */
export function computeLayeredPositions(
  model: GraphModel,
  options: GraphLayoutOptions | undefined,
  kind: GraphLayoutResult['kind'],
): GraphLayoutResult {
  const spacingX = options?.spacingX ?? 200;
  const spacingY = options?.spacingY ?? 120;
  const direction = options?.direction ?? 'TB';

  const nodeIds = model.nodes.map((n) => n.id);
  const indegree = new Map<NodeId, number>(nodeIds.map((id) => [id, 0]));
  const outEdges = new Map<NodeId, NodeId[]>(nodeIds.map((id) => [id, []]));
  for (const edge of model.edges) {
    if (!outEdges.has(edge.source) || !indegree.has(edge.target)) continue;
    outEdges.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const layer = new Map<NodeId, number>();
  const queue: NodeId[] = options?.seed
    ? [options.seed]
    : nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  if (queue.length === 0 && nodeIds.length > 0) queue.push(nodeIds[0] as NodeId);
  for (const id of queue) layer.set(id, 0);

  // BFS layering (visits every reachable node exactly once — safe on cycles).
  const visited = new Set<NodeId>(queue);
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++] as NodeId;
    const currentLayer = layer.get(current) ?? 0;
    for (const next of outEdges.get(current) ?? []) {
      const candidate = currentLayer + 1;
      if (!visited.has(next)) {
        visited.add(next);
        layer.set(next, candidate);
        queue.push(next);
      } else {
        layer.set(next, Math.max(layer.get(next) ?? 0, candidate));
      }
    }
  }
  // Any node unreachable from a root (disconnected component) gets its own layer 0.
  for (const id of nodeIds) if (!layer.has(id)) layer.set(id, 0);

  const byLayer = new Map<number, NodeId[]>();
  for (const id of nodeIds) {
    const l = layer.get(id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(id);
  }

  const positions: LayoutPosition[] = [];
  for (const [l, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, i) => {
      const across = (i - (ids.length - 1) / 2) * spacingX;
      const along = l * spacingY;
      positions.push({
        id,
        position: direction === 'TB' ? { x: across, y: along } : { x: along, y: across },
      });
    });
  }

  return { kind, positions };
}
