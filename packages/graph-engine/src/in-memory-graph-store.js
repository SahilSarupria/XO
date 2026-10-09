import { err, ok } from '@xo/types';
import { NotFoundError } from '@xo/errors';
/** A real, working in-memory {@link GraphStore}. O(1) node lookup, O(degree) neighbor traversal via an adjacency index kept in sync on every `addEdge`. */
export class InMemoryGraphStore {
    nodes = new Map();
    edges = [];
    outgoing = new Map();
    addNode(node) {
        this.nodes.set(node.id, node);
    }
    addEdge(edge) {
        if (!this.nodes.has(edge.fromId))
            return err(new NotFoundError(`GraphNode(${edge.fromId})`));
        if (!this.nodes.has(edge.toId))
            return err(new NotFoundError(`GraphNode(${edge.toId})`));
        this.edges.push(edge);
        const list = this.outgoing.get(edge.fromId) ?? [];
        list.push(edge);
        this.outgoing.set(edge.fromId, list);
        return ok(undefined);
    }
    getNode(id) {
        const node = this.nodes.get(id);
        return node ? ok(node) : err(new NotFoundError(`GraphNode(${id})`));
    }
    neighbors(nodeId, edgeType) {
        const edges = this.outgoing.get(nodeId) ?? [];
        return edges
            .filter((e) => edgeType === undefined || e.type === edgeType)
            .map((e) => this.nodes.get(e.toId))
            .filter((n) => n !== undefined);
    }
    query(query) {
        let results = [...this.nodes.values()];
        if (query.nodeType !== undefined)
            results = results.filter((n) => n.type === query.nodeType);
        if (query.edgeType !== undefined) {
            const connectedIds = new Set(this.edges.filter((e) => e.type === query.edgeType).flatMap((e) => [e.fromId, e.toId]));
            results = results.filter((n) => connectedIds.has(n.id));
        }
        return results;
    }
    nodeCount() {
        return this.nodes.size;
    }
    edgeCount() {
        return this.edges.length;
    }
}
//# sourceMappingURL=in-memory-graph-store.js.map