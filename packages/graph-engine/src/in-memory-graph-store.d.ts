import { type Result } from '@xo/types';
import { NotFoundError } from '@xo/errors';
import type { GraphEdge } from './edge.js';
import type { GraphNode } from './node.js';
import type { GraphQuery, GraphStore } from './graph-store.interface.js';
/** A real, working in-memory {@link GraphStore}. O(1) node lookup, O(degree) neighbor traversal via an adjacency index kept in sync on every `addEdge`. */
export declare class InMemoryGraphStore implements GraphStore {
    private readonly nodes;
    private readonly edges;
    private readonly outgoing;
    addNode(node: GraphNode): void;
    addEdge(edge: GraphEdge): Result<void, NotFoundError>;
    getNode(id: string): Result<GraphNode, NotFoundError>;
    neighbors(nodeId: string, edgeType?: string): readonly GraphNode[];
    query(query: GraphQuery): readonly GraphNode[];
    nodeCount(): number;
    edgeCount(): number;
}
//# sourceMappingURL=in-memory-graph-store.d.ts.map