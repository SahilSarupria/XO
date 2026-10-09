import type {
  EdgeGroup,
  EdgeId,
  GraphEdge,
  GraphNode,
  GroupId,
  NodeGroup,
  NodeId,
} from './types.js';

/**
 * GraphModel is immutable: every mutating method returns a new GraphModel
 * instance and never touches `this`. This makes it safe to diff, memoize,
 * and use for incremental/virtualized rendering upstream.
 */
export class GraphModel {
  private readonly nodesById: ReadonlyMap<NodeId, GraphNode>;
  private readonly edgesById: ReadonlyMap<EdgeId, GraphEdge>;
  private readonly nodeGroupsById: ReadonlyMap<GroupId, NodeGroup>;
  private readonly edgeGroupsById: ReadonlyMap<GroupId, EdgeGroup>;
  /** Deterministic insertion order, independent of Map iteration guarantees. */
  private readonly nodeOrder: readonly NodeId[];
  private readonly edgeOrder: readonly EdgeId[];

  constructor(init?: {
    nodes?: readonly GraphNode[];
    edges?: readonly GraphEdge[];
    nodeGroups?: readonly NodeGroup[];
    edgeGroups?: readonly EdgeGroup[];
  }) {
    const nodes = init?.nodes ?? [];
    const edges = init?.edges ?? [];
    this.nodesById = new Map(nodes.map((n) => [n.id, n]));
    this.edgesById = new Map(edges.map((e) => [e.id, e]));
    this.nodeGroupsById = new Map((init?.nodeGroups ?? []).map((g) => [g.id, g]));
    this.edgeGroupsById = new Map((init?.edgeGroups ?? []).map((g) => [g.id, g]));
    this.nodeOrder = nodes.map((n) => n.id);
    this.edgeOrder = edges.map((e) => e.id);
  }

  static empty(): GraphModel {
    return new GraphModel();
  }

  // ---- reads --------------------------------------------------------

  getNode(id: NodeId): GraphNode | undefined {
    return this.nodesById.get(id);
  }

  getEdge(id: EdgeId): GraphEdge | undefined {
    return this.edgesById.get(id);
  }

  getNodeGroup(id: GroupId): NodeGroup | undefined {
    return this.nodeGroupsById.get(id);
  }

  getEdgeGroup(id: GroupId): EdgeGroup | undefined {
    return this.edgeGroupsById.get(id);
  }

  /** Nodes in deterministic (insertion) order. */
  get nodes(): readonly GraphNode[] {
    return this.nodeOrder.map((id) => this.nodesById.get(id) as GraphNode);
  }

  /** Edges in deterministic (insertion) order. */
  get edges(): readonly GraphEdge[] {
    return this.edgeOrder.map((id) => this.edgesById.get(id) as GraphEdge);
  }

  get nodeGroups(): readonly NodeGroup[] {
    return [...this.nodeGroupsById.values()];
  }

  get edgeGroups(): readonly EdgeGroup[] {
    return [...this.edgeGroupsById.values()];
  }

  get nodeCount(): number {
    return this.nodesById.size;
  }

  get edgeCount(): number {
    return this.edgesById.size;
  }

  edgesOf(nodeId: NodeId): readonly GraphEdge[] {
    return this.edges.filter((e) => e.source === nodeId || e.target === nodeId);
  }

  neighborsOf(nodeId: NodeId): readonly NodeId[] {
    const out = new Set<NodeId>();
    for (const e of this.edges) {
      if (e.source === nodeId) out.add(e.target);
      if (e.target === nodeId) out.add(e.source);
    }
    return [...out];
  }

  // ---- immutable writes ----------------------------------------------

  upsertNode(node: GraphNode): GraphModel {
    const existed = this.nodesById.has(node.id);
    const nodesById = new Map(this.nodesById);
    nodesById.set(node.id, node);
    const nodeOrder = existed ? this.nodeOrder : [...this.nodeOrder, node.id];
    return this.withNodes(nodesById, nodeOrder);
  }

  /** Batched upsert: copies the underlying maps once regardless of how many
   * nodes are added, instead of once per node (avoids O(n^2) bulk loads). */
  upsertNodes(nodes: readonly GraphNode[]): GraphModel {
    if (nodes.length === 0) return this;
    const nodesById = new Map(this.nodesById);
    const nodeOrder = [...this.nodeOrder];
    for (const node of nodes) {
      if (!nodesById.has(node.id)) nodeOrder.push(node.id);
      nodesById.set(node.id, node);
    }
    return this.withNodes(nodesById, nodeOrder);
  }

  removeNode(id: NodeId): GraphModel {
    if (!this.nodesById.has(id)) return this;
    const nodesById = new Map(this.nodesById);
    nodesById.delete(id);
    const nodeOrder = this.nodeOrder.filter((n) => n !== id);
    // Cascade: drop edges touching the removed node, for referential integrity.
    const edgesById = new Map(
      [...this.edgesById].filter(([, e]) => e.source !== id && e.target !== id),
    );
    const edgeOrder = this.edgeOrder.filter((eid) => edgesById.has(eid));
    return new GraphModel({
      nodes: nodeOrder.map((n) => nodesById.get(n) as GraphNode),
      edges: edgeOrder.map((e) => edgesById.get(e) as GraphEdge),
      nodeGroups: this.nodeGroups,
      edgeGroups: this.edgeGroups,
    });
  }

  upsertEdge(edge: GraphEdge): GraphModel {
    const existed = this.edgesById.has(edge.id);
    const edgesById = new Map(this.edgesById);
    edgesById.set(edge.id, edge);
    const edgeOrder = existed ? this.edgeOrder : [...this.edgeOrder, edge.id];
    return this.withEdges(edgesById, edgeOrder);
  }

  /** Batched upsert — see upsertNodes for why this isn't a loop over upsertEdge. */
  upsertEdges(edges: readonly GraphEdge[]): GraphModel {
    if (edges.length === 0) return this;
    const edgesById = new Map(this.edgesById);
    const edgeOrder = [...this.edgeOrder];
    for (const edge of edges) {
      if (!edgesById.has(edge.id)) edgeOrder.push(edge.id);
      edgesById.set(edge.id, edge);
    }
    return this.withEdges(edgesById, edgeOrder);
  }

  removeEdge(id: EdgeId): GraphModel {
    if (!this.edgesById.has(id)) return this;
    const edgesById = new Map(this.edgesById);
    edgesById.delete(id);
    const edgeOrder = this.edgeOrder.filter((e) => e !== id);
    return this.withEdges(edgesById, edgeOrder);
  }

  upsertNodeGroup(group: NodeGroup): GraphModel {
    const nodeGroupsById = new Map(this.nodeGroupsById);
    nodeGroupsById.set(group.id, group);
    return new GraphModel({
      nodes: this.nodes,
      edges: this.edges,
      nodeGroups: [...nodeGroupsById.values()],
      edgeGroups: this.edgeGroups,
    });
  }

  upsertEdgeGroup(group: EdgeGroup): GraphModel {
    const edgeGroupsById = new Map(this.edgeGroupsById);
    edgeGroupsById.set(group.id, group);
    return new GraphModel({
      nodes: this.nodes,
      edges: this.edges,
      nodeGroups: this.nodeGroups,
      edgeGroups: [...edgeGroupsById.values()],
    });
  }

  /** Merge another model's nodes/edges/groups into this one (upsert semantics). */
  merge(other: GraphModel): GraphModel {
    return this.upsertNodes(other.nodes)
      .upsertEdges(other.edges)
      .withGroups(other.nodeGroups, other.edgeGroups);
  }

  private withGroups(nodeGroups: readonly NodeGroup[], edgeGroups: readonly EdgeGroup[]): GraphModel {
    let model: GraphModel = this;
    for (const g of nodeGroups) model = model.upsertNodeGroup(g);
    for (const g of edgeGroups) model = model.upsertEdgeGroup(g);
    return model;
  }

  private withNodes(nodesById: ReadonlyMap<NodeId, GraphNode>, nodeOrder: readonly NodeId[]): GraphModel {
    return new GraphModel({
      nodes: nodeOrder.map((id) => nodesById.get(id) as GraphNode),
      edges: this.edges,
      nodeGroups: this.nodeGroups,
      edgeGroups: this.edgeGroups,
    });
  }

  private withEdges(edgesById: ReadonlyMap<EdgeId, GraphEdge>, edgeOrder: readonly EdgeId[]): GraphModel {
    return new GraphModel({
      nodes: this.nodes,
      edges: edgeOrder.map((id) => edgesById.get(id) as GraphEdge),
      nodeGroups: this.nodeGroups,
      edgeGroups: this.edgeGroups,
    });
  }
}
