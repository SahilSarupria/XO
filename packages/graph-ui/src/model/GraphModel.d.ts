import type { EdgeGroup, EdgeId, GraphEdge, GraphNode, GroupId, NodeGroup, NodeId } from './types.js';
/**
 * GraphModel is immutable: every mutating method returns a new GraphModel
 * instance and never touches `this`. This makes it safe to diff, memoize,
 * and use for incremental/virtualized rendering upstream.
 */
export declare class GraphModel {
    private readonly nodesById;
    private readonly edgesById;
    private readonly nodeGroupsById;
    private readonly edgeGroupsById;
    /** Deterministic insertion order, independent of Map iteration guarantees. */
    private readonly nodeOrder;
    private readonly edgeOrder;
    constructor(init?: {
        nodes?: readonly GraphNode[];
        edges?: readonly GraphEdge[];
        nodeGroups?: readonly NodeGroup[];
        edgeGroups?: readonly EdgeGroup[];
    });
    static empty(): GraphModel;
    getNode(id: NodeId): GraphNode | undefined;
    getEdge(id: EdgeId): GraphEdge | undefined;
    getNodeGroup(id: GroupId): NodeGroup | undefined;
    getEdgeGroup(id: GroupId): EdgeGroup | undefined;
    /** Nodes in deterministic (insertion) order. */
    get nodes(): readonly GraphNode[];
    /** Edges in deterministic (insertion) order. */
    get edges(): readonly GraphEdge[];
    get nodeGroups(): readonly NodeGroup[];
    get edgeGroups(): readonly EdgeGroup[];
    get nodeCount(): number;
    get edgeCount(): number;
    edgesOf(nodeId: NodeId): readonly GraphEdge[];
    neighborsOf(nodeId: NodeId): readonly NodeId[];
    upsertNode(node: GraphNode): GraphModel;
    /** Batched upsert: copies the underlying maps once regardless of how many
     * nodes are added, instead of once per node (avoids O(n^2) bulk loads). */
    upsertNodes(nodes: readonly GraphNode[]): GraphModel;
    removeNode(id: NodeId): GraphModel;
    upsertEdge(edge: GraphEdge): GraphModel;
    /** Batched upsert — see upsertNodes for why this isn't a loop over upsertEdge. */
    upsertEdges(edges: readonly GraphEdge[]): GraphModel;
    removeEdge(id: EdgeId): GraphModel;
    upsertNodeGroup(group: NodeGroup): GraphModel;
    upsertEdgeGroup(group: EdgeGroup): GraphModel;
    /** Merge another model's nodes/edges/groups into this one (upsert semantics). */
    merge(other: GraphModel): GraphModel;
    private withGroups;
    private withNodes;
    private withEdges;
}
//# sourceMappingURL=GraphModel.d.ts.map