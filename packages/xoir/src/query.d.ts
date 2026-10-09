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
export declare function filterNodes(graph: XoirGraph, filter?: NodeFilter): readonly XoirNode[];
export interface EdgeFilter {
    readonly kind?: XoirEdgeKind;
    readonly tag?: string;
    readonly predicate?: (edge: XoirEdge) => boolean;
}
export declare function filterEdges(graph: XoirGraph, filter?: EdgeFilter): readonly XoirEdge[];
/** Convenience wrapper over {@link filterNodes} for the module spec's named lookups ("Capability lookup", "Knowledge lookup", "Reasoning lookup"). */
export declare function nodesOfKind(graph: XoirGraph, kind: XoirNodeKind): readonly XoirNode[];
export declare function byTag(graph: XoirGraph, tag: string): readonly XoirNode[];
export declare function relationshipsOfKind(graph: XoirGraph, kind: XoirEdgeKind): readonly XoirEdge[];
export interface PathOptions {
    readonly edgeKind?: XoirEdgeKind;
    readonly maxDepth?: number;
}
/** Breadth-first shortest-path search (by hop count) from `fromId` to `toId`, optionally restricted to one edge kind. Returns `[]` if there is no path within `maxDepth`. */
export declare function findPath(graph: XoirGraph, fromId: XoirNodeId, toId: XoirNodeId, options?: PathOptions): readonly XoirNodeId[];
//# sourceMappingURL=query.d.ts.map