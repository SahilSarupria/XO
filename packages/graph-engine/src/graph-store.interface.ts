import type { Result } from '@xo/types';
import type { NotFoundError } from '@xo/errors';
import type { GraphNode } from './node.js';
import type { GraphEdge } from './edge.js';

export interface GraphQuery {
  readonly nodeType?: string;
  readonly edgeType?: string;
}

/**
 * Storage/query port for an XO's knowledge graph (`knowledge/graph.json`
 * per SPECIFICATION.md §1.1). A real deployment may back this with a
 * dedicated graph database for large graphs; {@link InMemoryGraphStore} is
 * the reference implementation used for small/medium graphs, tests, and
 * local dev — see docs/adr/0006-storage-and-databases.md.
 */
export interface GraphStore {
  addNode(node: GraphNode): void;
  addEdge(edge: GraphEdge): Result<void, NotFoundError>;
  getNode(id: string): Result<GraphNode, NotFoundError>;
  neighbors(nodeId: string, edgeType?: string): readonly GraphNode[];
  query(query: GraphQuery): readonly GraphNode[];
  nodeCount(): number;
  edgeCount(): number;
}
