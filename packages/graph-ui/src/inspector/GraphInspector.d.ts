import type { GraphEdge, GraphNode } from '../model/types.js';
import type { GraphBadge, GraphInspectorData } from './types.js';
/**
 * Pure builders that turn a GraphNode/GraphEdge into GraphInspectorData.
 * These only read what's already on the node/edge (id, type, label,
 * metadata) — no UI framework, no side effects.
 */
export declare class GraphInspector {
    static fromNode(node: GraphNode, options?: {
        badges?: readonly GraphBadge[];
    }): GraphInspectorData;
    static fromEdge(edge: GraphEdge, options?: {
        badges?: readonly GraphBadge[];
    }): GraphInspectorData;
}
//# sourceMappingURL=GraphInspector.d.ts.map