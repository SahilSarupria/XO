import type { XoirEdge, XoirEdgeKind } from './edge-kinds.js';
import type { XoirGraph } from './graph.js';
import type { XoirNodeId } from './ids.js';
import type { XoirNode, XoirNodeKind } from './node-kinds.js';

/**
 * A purely in-memory query engine over a {@link XoirGraph} — no external
 * database. Every function here takes a graph and returns a plain array;
 * none of them mutate the graph or hold onto state between calls, which is
 * exactly what would let a future implementation swap this module for one
 * that compiles the same query shapes into Cypher against a real Neo4j
 * instance (`filterNodes({ kind })` -> `MATCH (n:Kind)`, `findPaths` ->
 * `MATCH path = (a)-[*]->(b)`, `byTag` -> a label/property index lookup)
 * without changing any call site — `packages/graph-engine`'s
 * `GraphStore` interface took the same approach for the same reason (see
 * that package's doc comments). XOIR does not depend on `graph-engine`
 * (different graph model, see docs/architecture note in this package's
 * README), but the design principle carries over.
 */

export interface NodeFilter {
  readonly kind?: XoirNodeKind;
  readonly tag?: string;
  readonly minConfidence?: number;
  readonly predicate?: (node: XoirNode) => boolean;
}

export function filterNodes(graph: XoirGraph, filter: NodeFilter = {}): readonly XoirNode[] {
  return graph.allNodes().filter((node) => {
    if (filter.kind !== undefined && node.kind !== filter.kind) return false;
    if (filter.tag !== undefined && !node.metadata.tags.includes(filter.tag)) return false;
    if (filter.minConfidence !== undefined && node.metadata.confidence < filter.minConfidence) return false;
    if (filter.predicate && !filter.predicate(node)) return false;
    return true;
  });
}

export interface EdgeFilter {
  readonly kind?: XoirEdgeKind;
  readonly tag?: string;
  readonly predicate?: (edge: XoirEdge) => boolean;
}

export function filterEdges(graph: XoirGraph, filter: EdgeFilter = {}): readonly XoirEdge[] {
  return graph.allEdges().filter((edge) => {
    if (filter.kind !== undefined && edge.kind !== filter.kind) return false;
    if (filter.tag !== undefined && !edge.metadata.tags.includes(filter.tag)) return false;
    if (filter.predicate && !filter.predicate(edge)) return false;
    return true;
  });
}

/** Convenience wrapper over {@link filterNodes} for the module spec's named lookups ("Capability lookup", "Knowledge lookup", "Reasoning lookup"). */
export function nodesOfKind(graph: XoirGraph, kind: XoirNodeKind): readonly XoirNode[] {
  return filterNodes(graph, { kind });
}

export function byTag(graph: XoirGraph, tag: string): readonly XoirNode[] {
  return filterNodes(graph, { tag });
}

export function relationshipsOfKind(graph: XoirGraph, kind: XoirEdgeKind): readonly XoirEdge[] {
  return filterEdges(graph, { kind });
}

export interface PathOptions {
  readonly edgeKind?: XoirEdgeKind;
  readonly maxDepth?: number;
}

/** Breadth-first shortest-path search (by hop count) from `fromId` to `toId`, optionally restricted to one edge kind. Returns `[]` if there is no path within `maxDepth`. */
export function findPath(graph: XoirGraph, fromId: XoirNodeId, toId: XoirNodeId, options: PathOptions = {}): readonly XoirNodeId[] {
  const maxDepth = options.maxDepth ?? Infinity;
  if (fromId === toId) return [fromId];

  const visited = new Set<XoirNodeId>([fromId]);
  const queue: { id: XoirNodeId; path: readonly XoirNodeId[] }[] = [{ id: fromId, path: [fromId] }];

  while (queue.length > 0) {
    const { id, path } = queue.shift()!;
    if (path.length - 1 >= maxDepth) continue;
    const neighborOpts = options.edgeKind !== undefined ? { edgeKind: options.edgeKind, direction: 'outgoing' as const } : { direction: 'outgoing' as const };
    for (const neighbor of graph.neighbors(id, neighborOpts)) {
      if (visited.has(neighbor.id)) continue;
      const nextPath = [...path, neighbor.id];
      if (neighbor.id === toId) return nextPath;
      visited.add(neighbor.id);
      queue.push({ id: neighbor.id, path: nextPath });
    }
  }
  return [];
}