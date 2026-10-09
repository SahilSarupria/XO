import { err, ok, type Result } from '@xo/types';
import { NotFoundError } from '@xo/errors';
import type { GraphEdge } from './edge.js';
import type { GraphNode } from './node.js';
import type { GraphQuery, GraphStore } from './graph-store.interface.js';

/** A real, working in-memory {@link GraphStore}. O(1) node lookup, O(degree) neighbor traversal via an adjacency index kept in sync on every `addEdge`. */
export class InMemoryGraphStore implements GraphStore {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges: GraphEdge[] = [];
  private readonly outgoing = new Map<string, GraphEdge[]>();

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: GraphEdge): Result<void, NotFoundError> {
    if (!this.nodes.has(edge.fromId)) return err(new NotFoundError(`GraphNode(${edge.fromId})`));
    if (!this.nodes.has(edge.toId)) return err(new NotFoundError(`GraphNode(${edge.toId})`));
    this.edges.push(edge);
    const list = this.outgoing.get(edge.fromId) ?? [];
    list.push(edge);
    this.outgoing.set(edge.fromId, list);
    return ok(undefined);
  }

  getNode(id: string): Result<GraphNode, NotFoundError> {
    const node = this.nodes.get(id);
    return node ? ok(node) : err(new NotFoundError(`GraphNode(${id})`));
  }

  neighbors(nodeId: string, edgeType?: string): readonly GraphNode[] {
    const edges = this.outgoing.get(nodeId) ?? [];
    return edges
      .filter((e) => edgeType === undefined || e.type === edgeType)
      .map((e) => this.nodes.get(e.toId))
      .filter((n): n is GraphNode => n !== undefined);
  }

  query(query: GraphQuery): readonly GraphNode[] {
    let results = [...this.nodes.values()];
    if (query.nodeType !== undefined) results = results.filter((n) => n.type === query.nodeType);
    if (query.edgeType !== undefined) {
      const connectedIds = new Set(this.edges.filter((e) => e.type === query.edgeType).flatMap((e) => [e.fromId, e.toId]));
      results = results.filter((n) => connectedIds.has(n.id));
    }
    return results;
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.length;
  }
}
