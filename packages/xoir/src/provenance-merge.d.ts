import { type Result } from '@xo/types';
import { type XoError } from '@xo/errors';
import { XoirGraph } from './graph.js';
import type { XoirGraphId, XoirNodeId, XoirEdgeId } from './ids.js';
import type { XoirEdge } from './edge-kinds.js';
import { type MergeConflict, type MergeStrategy } from './merge.js';
export interface ProvenanceAwareMergeResult {
    readonly graph: XoirGraph;
    readonly conflicts: readonly MergeConflict[];
    readonly edgeConflicts: readonly MergeEdgeConflict[];
    readonly reconciledNodeIds: readonly XoirNodeId[];
    readonly reconciledEdgeIds: readonly XoirEdgeId[];
}
export interface MergeEdgeConflict {
    readonly edgeId: XoirEdgeId;
    readonly candidates: readonly XoirEdge[];
    readonly resolution: XoirEdge | undefined;
}
export interface MergeGraphsPreservingProvenanceOptions {
    readonly strategy?: MergeStrategy;
    readonly now?: () => string;
}
/**
 * Combines multiple XOIR graphs the way `merge.ts#mergeGraphs` does
 * (identity-preserving by `id`, id conflicts reported and resolved by
 * `strategy`), but with one deliberate difference: before treating two
 * same-id candidates as a conflict, it checks whether they actually agree
 * on *core* content (`kind`, `metadata.subtype`, `properties`,
 * `metadata.custom` for nodes; `kind`/`fromId`/`toId`/`weight`/
 * `properties`/`metadata.custom` for edges). If they do, they are not a
 * conflict at all — they are the same claim corroborated by more than one
 * source, and are reconciled into a single node/edge whose `sourceRefs`/
 * `tags` are the union of every candidate's (deduplicated by content) and
 * whose `confidenceDetail` reflects the real, larger corroboration count.
 * Nothing is picked-and-discarded in that case, satisfying the Stage 5.5
 * rule that provenance is additive, never overwritten.
 *
 * Only candidates whose *core* content genuinely differs fall through to
 * `merge.ts#mergeGraphs`'s existing conflict-resolution policy
 * (`resolveConflict`, reused verbatim here, not reimplemented) — this
 * function does not invent new conflict-resolution semantics, only a
 * pre-step that shrinks how often "conflict" is the right word for what
 * is actually corroboration. Edge conflicts follow the identical
 * decide-then-resolve shape, reported separately (`edgeConflicts`) since
 * `MergeConflict` from `merge.ts` is node-shaped.
 *
 * Manifests are combined too — see `mergeManifests` — rather than the
 * "never looked at" behavior `merge.ts#mergeGraphs` has (it predates
 * manifests being something a merge needs to combine).
 */
export declare function mergeGraphsPreservingProvenance(graphs: readonly XoirGraph[], newGraphId: XoirGraphId, options?: MergeGraphsPreservingProvenanceOptions): Result<ProvenanceAwareMergeResult, XoError>;
//# sourceMappingURL=provenance-merge.d.ts.map