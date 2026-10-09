import type { XoirEdge } from './edge-kinds.js';
import type { XoirGraph } from './graph.js';
import type { XoirNodeId } from './ids.js';
import type { XoirNode } from './node-kinds.js';
import type { XoirValue } from './values.js';
export interface PropertyChange {
    readonly path: string;
    readonly before: XoirValue | undefined;
    readonly after: XoirValue | undefined;
}
export interface ModifiedNode {
    readonly id: XoirNodeId;
    readonly before: XoirNode;
    readonly after: XoirNode;
    readonly propertyChanges: readonly PropertyChange[];
    readonly versionDelta: number;
}
export interface GraphDiff {
    readonly addedNodes: readonly XoirNode[];
    readonly removedNodes: readonly XoirNode[];
    readonly modifiedNodes: readonly ModifiedNode[];
    readonly addedEdges: readonly XoirEdge[];
    readonly removedEdges: readonly XoirEdge[];
}
/**
 * Structural diff between two XOIR graphs, keyed by node/edge `id` — this
 * is an *identity-preserving* diff (SPECIFICATION.md's "Version
 * differences") in the same sense merge.ts's conflict detection is: a node
 * that changed content but kept its id is "modified", not "removed then
 * added". Two nodes with different ids are never matched to each other
 * even if their content is identical — that's a merge/dedup concern
 * (merge.ts), not a diff concern.
 */
export declare function diffGraphs(before: XoirGraph, after: XoirGraph): GraphDiff;
/** Renders a {@link GraphDiff} as a human-readable, git-diff-flavored report. */
export declare function formatDiff(diff: GraphDiff): string;
//# sourceMappingURL=diff.d.ts.map