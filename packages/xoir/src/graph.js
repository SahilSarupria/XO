import { err, ok } from '@xo/types';
import { XoirError, ErrorCode, NotFoundError } from '@xo/errors';
import { hashEdge, hashGraphContents, hashNode } from './hashing.js';
import { createEdge } from './edge-kinds.js';
import { createNode } from './node-kinds.js';
import { XOIR_SCHEMA_VERSION } from './versioning.js';
/**
 * The canonical XOIR graph container. A `XoirGraph` instance is a mutable
 * *builder* (nodes/edges are added and removed incrementally, e.g. across
 * multiple compiler-frontend passes) even though every `XoirNode`/
 * `XoirEdge` value it holds is itself immutable — see node-kinds.ts's doc
 * comment on {@link XoirNode}. This mirrors how LLVM IR's `Module` is a
 * mutable container of otherwise-value-like instructions.
 *
 * This class has no compiler or runtime logic: it only maintains graph
 * structure and answers structural questions about it (adjacency,
 * ordering, cycles). Query/diff/merge/validation live in their own
 * modules and operate on a `XoirGraph` from the outside, through this
 * class's public API — consistent with the Visitor/Pass framework's
 * requirement that traversal never needs to reach into private state.
 */
export class XoirGraph {
    id;
    schemaVersion;
    nodes = new Map();
    edges = new Map();
    outgoing = new Map();
    incoming = new Map();
    /** Package/compilation-level bookkeeping — see `manifest.ts`. Optional: absent for graphs that never set one (all schema-version-1 graphs, historically). */
    manifestValue;
    constructor(id, schemaVersion = XOIR_SCHEMA_VERSION, manifest) {
        this.id = id;
        this.schemaVersion = schemaVersion;
        this.manifestValue = manifest;
    }
    static create(id, schemaVersion, manifest) {
        return new XoirGraph(id, schemaVersion, manifest);
    }
    /** The graph's manifest, if one has been set — see `manifest.ts#XoirManifest`. */
    get manifest() {
        return this.manifestValue;
    }
    /** Replaces the graph's manifest (e.g. after a pass appends a `PassHistoryEntry` via `manifest.ts#appendPassHistory`). Manifests never affect any content hash — see `hashing.ts` and `manifest.ts`'s doc comment on `PassHistoryEntry`. */
    setManifest(manifest) {
        this.manifestValue = manifest;
    }
    // --- Nodes -------------------------------------------------------------
    /** Builds, hashes, and inserts a node in one step — the only supported way to add a node, so a node can never exist in the graph without a valid, freshly-computed hash. */
    createAndAddNode(input) {
        const built = createNode(input);
        const node = { ...built, hash: hashNode(built) };
        const result = this.addNode(node);
        return result.ok ? ok(node) : err(result.error);
    }
    addNode(node) {
        if (this.nodes.has(node.id)) {
            return err(new XoirError(ErrorCode.XOIR_DUPLICATE_NODE, `Node "${node.id}" already exists in graph "${this.id}"`));
        }
        this.nodes.set(node.id, node);
        this.outgoing.set(node.id, new Set());
        this.incoming.set(node.id, new Set());
        return ok(undefined);
    }
    /** Removes a node and cascades to every edge touching it (an edge referencing a removed node would otherwise dangle — see validation.ts's dangling-edge check). */
    removeNode(id) {
        if (!this.nodes.has(id)) {
            return err(new NotFoundError(`XoirNode(${id})`));
        }
        for (const edgeKey of new Set([...(this.outgoing.get(id) ?? []), ...(this.incoming.get(id) ?? [])])) {
            this.removeEdgeByKey(edgeKey);
        }
        this.nodes.delete(id);
        this.outgoing.delete(id);
        this.incoming.delete(id);
        return ok(undefined);
    }
    getNode(id) {
        const node = this.nodes.get(id);
        return node ? ok(node) : err(new NotFoundError(`XoirNode(${id})`));
    }
    hasNode(id) {
        return this.nodes.has(id);
    }
    allNodes() {
        return [...this.nodes.values()];
    }
    // --- Edges ---------------------------------------------------------------
    createAndAddEdge(input) {
        const built = createEdge(input);
        const edge = { ...built, hash: hashEdge(built) };
        const result = this.addEdge(edge);
        return result.ok ? ok(edge) : err(result.error);
    }
    addEdge(edge) {
        const key = this.edgeKey(edge.id);
        if (this.edges.has(key)) {
            return err(new XoirError(ErrorCode.XOIR_DUPLICATE_EDGE, `Edge "${edge.id}" already exists in graph "${this.id}"`));
        }
        if (!this.nodes.has(edge.fromId)) {
            return err(new XoirError(ErrorCode.XOIR_DANGLING_EDGE, `Edge "${edge.id}" references unknown fromId "${edge.fromId}"`));
        }
        if (!this.nodes.has(edge.toId)) {
            return err(new XoirError(ErrorCode.XOIR_DANGLING_EDGE, `Edge "${edge.id}" references unknown toId "${edge.toId}"`));
        }
        this.edges.set(key, edge);
        this.outgoing.get(edge.fromId).add(key);
        this.incoming.get(edge.toId).add(key);
        return ok(undefined);
    }
    removeEdge(id) {
        const key = this.edgeKey(id);
        if (!this.edges.has(key)) {
            return err(new NotFoundError(`XoirEdge(${id})`));
        }
        this.removeEdgeByKey(key);
        return ok(undefined);
    }
    removeEdgeByKey(key) {
        const edge = this.edges.get(key);
        if (!edge)
            return;
        this.edges.delete(key);
        this.outgoing.get(edge.fromId)?.delete(key);
        this.incoming.get(edge.toId)?.delete(key);
    }
    edgeKey(id) {
        return id;
    }
    getEdge(id) {
        const edge = this.edges.get(this.edgeKey(id));
        return edge ? ok(edge) : err(new NotFoundError(`XoirEdge(${id})`));
    }
    allEdges() {
        return [...this.edges.values()];
    }
    // --- Traversal -------------------------------------------------------------
    neighbors(id, options = {}) {
        const direction = options.direction ?? 'outgoing';
        const keys = new Set();
        if (direction === 'outgoing' || direction === 'both') {
            for (const k of this.outgoing.get(id) ?? [])
                keys.add(k);
        }
        if (direction === 'incoming' || direction === 'both') {
            for (const k of this.incoming.get(id) ?? [])
                keys.add(k);
        }
        const result = [];
        for (const key of keys) {
            const edge = this.edges.get(key);
            if (!edge)
                continue;
            if (options.edgeKind !== undefined && edge.kind !== options.edgeKind)
                continue;
            const neighborId = edge.fromId === id ? edge.toId : edge.fromId;
            const neighbor = this.nodes.get(neighborId);
            if (neighbor)
                result.push(neighbor);
        }
        return result;
    }
    /** Direct `DEPENDS_ON`-style dependencies: nodes this node has an outgoing edge of `edgeKind` toward. Defaults to `DEPENDS_ON`. */
    dependenciesOf(id, edgeKind = 'DEPENDS_ON') {
        return this.neighbors(id, { edgeKind, direction: 'outgoing' });
    }
    /** Extracts an induced subgraph: every requested node plus every edge whose endpoints are both in the set. */
    subgraph(nodeIds, newGraphId) {
        const sub = new XoirGraph(newGraphId, this.schemaVersion);
        const idSet = new Set(nodeIds);
        for (const id of nodeIds) {
            const nodeResult = this.getNode(id);
            if (!nodeResult.ok)
                return err(nodeResult.error);
            const added = sub.addNode(nodeResult.value);
            if (!added.ok)
                return err(added.error);
        }
        for (const edge of this.edges.values()) {
            if (idSet.has(edge.fromId) && idSet.has(edge.toId)) {
                const added = sub.addEdge(edge);
                if (!added.ok)
                    return err(added.error);
            }
        }
        return ok(sub);
    }
    /** Depth-first cycle detection over every edge, regardless of kind — a `CONTRADICTS` cycle and a `DEPENDS_ON` cycle are both structurally a cycle. Callers that care only about a specific edge kind's DAG-ness should use {@link topologicalOrder} with that kind instead. */
    hasCycle() {
        const WHITE = 0;
        const GRAY = 1;
        const BLACK = 2;
        const state = new Map();
        for (const id of this.nodes.keys())
            state.set(id, WHITE);
        const visit = (id) => {
            state.set(id, GRAY);
            for (const key of this.outgoing.get(id) ?? []) {
                const edge = this.edges.get(key);
                const next = edge.toId;
                const nextState = state.get(next);
                if (nextState === GRAY)
                    return true;
                if (nextState === WHITE && visit(next))
                    return true;
            }
            state.set(id, BLACK);
            return false;
        };
        for (const id of this.nodes.keys()) {
            if (state.get(id) === WHITE && visit(id))
                return true;
        }
        return false;
    }
    /**
     * Kahn's-algorithm topological order. The whole semantic XOIR graph is
     * NOT required to be a DAG (e.g. `A CONTRADICTS B` and `B CONTRADICTS A`
     * are both individually legitimate) — see the module README's "Cycle
     * semantics" section. This method fails with `XOIR_CYCLE_DETECTED`
     * rather than returning a partial order whenever the *selected* edges
     * aren't acyclic; a caller that only cares whether some DAG-shaped
     * projection (an execution-dependency graph, a decision-dependency
     * graph, ...) is well-ordered should pass `edgeKinds` to restrict the
     * walk to just those edge kinds, rather than relying on the whole graph
     * happening to be acyclic.
     */
    topologicalOrder(edgeKinds) {
        const kindSet = edgeKinds ? new Set(edgeKinds) : undefined;
        const relevantEdges = kindSet ? [...this.edges.values()].filter((e) => kindSet.has(e.kind)) : [...this.edges.values()];
        const inDegree = new Map();
        for (const id of this.nodes.keys())
            inDegree.set(id, 0);
        for (const edge of relevantEdges) {
            inDegree.set(edge.toId, (inDegree.get(edge.toId) ?? 0) + 1);
        }
        const outgoingRelevant = new Map();
        for (const edge of relevantEdges) {
            const list = outgoingRelevant.get(edge.fromId) ?? [];
            list.push(edge);
            outgoingRelevant.set(edge.fromId, list);
        }
        const queue = [...this.nodes.keys()].filter((id) => inDegree.get(id) === 0);
        const order = [];
        while (queue.length > 0) {
            const id = queue.shift();
            order.push(id);
            for (const edge of outgoingRelevant.get(id) ?? []) {
                const remaining = (inDegree.get(edge.toId) ?? 0) - 1;
                inDegree.set(edge.toId, remaining);
                if (remaining === 0)
                    queue.push(edge.toId);
            }
        }
        if (order.length !== this.nodes.size) {
            return err(new XoirError(ErrorCode.XOIR_CYCLE_DETECTED, `Graph "${this.id}" contains a cycle${kindSet ? ` among edge kinds [${[...kindSet].join(', ')}]` : ''}; no total topological order exists`));
        }
        return ok(order);
    }
    stats() {
        const nodesByKind = {};
        for (const node of this.nodes.values()) {
            nodesByKind[node.kind] = (nodesByKind[node.kind] ?? 0) + 1;
        }
        const edgesByKind = {};
        for (const edge of this.edges.values()) {
            edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1;
        }
        return {
            nodeCount: this.nodes.size,
            edgeCount: this.edges.size,
            nodesByKind,
            edgesByKind,
        };
    }
    /** The graph's content-addressable identity — see hashing.ts#hashGraphContents. */
    contentHash() {
        return hashGraphContents(this.allNodes().map((n) => n.hash), this.allEdges().map((e) => e.hash));
    }
}
//# sourceMappingURL=graph.js.map