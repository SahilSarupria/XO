import { type Result } from '@xo/types';
import { XoError } from '@xo/errors';
import { XoirGraph } from './graph.js';
import type { XoirGraphId, XoirNodeId } from './ids.js';
import type { XoirNode } from './node-kinds.js';
export type MergeStrategy = 'prefer_first' | 'prefer_last' | 'prefer_higher_confidence' | 'error_on_conflict';
export interface MergeConflict {
    readonly nodeId: XoirNodeId;
    readonly reason: 'duplicate_id_different_content' | 'version_conflict';
    readonly candidates: readonly XoirNode[];
    readonly resolution: XoirNode | undefined;
}
export interface MergeResult {
    readonly graph: XoirGraph;
    readonly conflicts: readonly MergeConflict[];
}
export declare function resolveConflict(candidates: readonly XoirNode[], strategy: MergeStrategy): XoirNode | undefined;
/**
 * Merges multiple XOIR graphs into one, preserving node/edge identity by
 * `id` (SPECIFICATION.md's "Identity preservation"). Two nodes sharing an
 * id are a *conflict* to resolve (via `strategy`), never silently
 * overwritten and never silently kept-both (that would violate id
 * uniqueness within a single graph) — every conflict is reported in
 * `MergeResult.conflicts` regardless of strategy, so a caller can audit
 * what the merge actually decided ("explainable merge results").
 *
 * Edges are unioned by id the same way node ids are; an edge id conflict
 * with differing endpoints is treated as a node-shaped conflict via the
 * same `resolveConflict` policy, keyed by edge id instead of node id (not
 * modeled as a separate type here to keep the conflict-reporting shape
 * uniform — see the package README's "Extension points" section for how a
 * future module might split this out if edge-specific strategies are
 * needed).
 */
export declare function mergeGraphs(graphs: readonly XoirGraph[], newGraphId: XoirGraphId, strategy?: MergeStrategy): Result<MergeResult, XoError>;
//# sourceMappingURL=merge.d.ts.map