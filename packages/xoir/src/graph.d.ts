import { type Result } from '@xo/types';
import { XoError } from '@xo/errors';
import type { XoirEdge, XoirEdgeKind } from './edge-kinds.js';
import type { XoirGraphId, XoirNodeId } from './ids.js';
import type { CreateEdgeInput } from './edge-kinds.js';
import { type CreateNodeInput, type XoirNode, type XoirNodeKind } from './node-kinds.js';
import type { XoirPropertyBag } from './values.js';
import type { XoirManifest } from './manifest.js';
export interface GraphStats {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly nodesByKind: Readonly<Record<string, number>>;
    readonly edgesByKind: Readonly<Record<string, number>>;
}
export interface NeighborOptions {
    readonly edgeKind?: XoirEdgeKind;
    readonly direction?: 'outgoing' | 'incoming' | 'both';
}
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
export declare class XoirGraph {
    readonly id: XoirGraphId;
    readonly schemaVersion: number;
    private readonly nodes;
    private readonly edges;
    private readonly outgoing;
    private readonly incoming;
    /** Package/compilation-level bookkeeping — see `manifest.ts`. Optional: absent for graphs that never set one (all schema-version-1 graphs, historically). */
    private manifestValue;
    constructor(id: XoirGraphId, schemaVersion?: number, manifest?: XoirManifest);
    static create(id: XoirGraphId, schemaVersion?: number, manifest?: XoirManifest): XoirGraph;
    /** The graph's manifest, if one has been set — see `manifest.ts#XoirManifest`. */
    get manifest(): XoirManifest | undefined;
    /** Replaces the graph's manifest (e.g. after a pass appends a `PassHistoryEntry` via `manifest.ts#appendPassHistory`). Manifests never affect any content hash — see `hashing.ts` and `manifest.ts`'s doc comment on `PassHistoryEntry`. */
    setManifest(manifest: XoirManifest | undefined): void;
    /** Builds, hashes, and inserts a node in one step — the only supported way to add a node, so a node can never exist in the graph without a valid, freshly-computed hash. */
    createAndAddNode<K extends XoirNodeKind, P extends XoirPropertyBag>(input: CreateNodeInput<K, P>): Result<XoirNode<K, P>, XoError>;
    addNode(node: XoirNode): Result<void, XoError>;
    /** Removes a node and cascades to every edge touching it (an edge referencing a removed node would otherwise dangle — see validation.ts's dangling-edge check). */
    removeNode(id: XoirNodeId): Result<void, XoError>;
    getNode(id: XoirNodeId): Result<XoirNode, XoError>;
    hasNode(id: XoirNodeId): boolean;
    allNodes(): readonly XoirNode[];
    createAndAddEdge<K extends XoirEdgeKind, P extends XoirPropertyBag>(input: CreateEdgeInput<K, P>): Result<XoirEdge<K, P>, XoError>;
    addEdge(edge: XoirEdge): Result<void, XoError>;
    removeEdge(id: string): Result<void, XoError>;
    private removeEdgeByKey;
    private edgeKey;
    getEdge(id: string): Result<XoirEdge, XoError>;
    allEdges(): readonly XoirEdge[];
    neighbors(id: XoirNodeId, options?: NeighborOptions): readonly XoirNode[];
    /** Direct `DEPENDS_ON`-style dependencies: nodes this node has an outgoing edge of `edgeKind` toward. Defaults to `DEPENDS_ON`. */
    dependenciesOf(id: XoirNodeId, edgeKind?: XoirEdgeKind): readonly XoirNode[];
    /** Extracts an induced subgraph: every requested node plus every edge whose endpoints are both in the set. */
    subgraph(nodeIds: readonly XoirNodeId[], newGraphId: XoirGraphId): Result<XoirGraph, XoError>;
    /** Depth-first cycle detection over every edge, regardless of kind — a `CONTRADICTS` cycle and a `DEPENDS_ON` cycle are both structurally a cycle. Callers that care only about a specific edge kind's DAG-ness should use {@link topologicalOrder} with that kind instead. */
    hasCycle(): boolean;
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
    topologicalOrder(edgeKinds?: readonly XoirEdgeKind[]): Result<readonly XoirNodeId[], XoError>;
    stats(): GraphStats;
    /** The graph's content-addressable identity — see hashing.ts#hashGraphContents. */
    contentHash(): string;
}
//# sourceMappingURL=graph.d.ts.map