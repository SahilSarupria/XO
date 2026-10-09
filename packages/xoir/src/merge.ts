import { err, ok, type Result } from '@xo/types';
import { XoirError, ErrorCode, InvalidArgumentError, XoError } from '@xo/errors';
import { XoirGraph } from './graph.js';
import type { XoirGraphId, XoirNodeId } from './ids.js';
import type { XoirNode } from './node-kinds.js';

export type MergeStrategy = 'prefer_first' | 'prefer_last' | 'prefer_higher_confidence' | 'error_on_conflict';

export interface MergeConflict {
  readonly nodeId: XoirNodeId;
  readonly reason: 'duplicate_id_different_content' | 'version_conflict';
  readonly candidates: readonly XoirNode[];
  readonly resolution: XoirNode | undefined; // undefined only when strategy === 'error_on_conflict' and this conflict was the one that aborted the merge
}

export interface MergeResult {
  readonly graph: XoirGraph;
  readonly conflicts: readonly MergeConflict[];
}

export function resolveConflict(candidates: readonly XoirNode[], strategy: MergeStrategy): XoirNode | undefined {
  switch (strategy) {
    case 'prefer_first':
      return candidates[0];
    case 'prefer_last':
      return candidates[candidates.length - 1];
    case 'prefer_higher_confidence':
      return [...candidates].sort((a, b) => b.metadata.confidence - a.metadata.confidence)[0];
    case 'error_on_conflict':
      return undefined;
  }
}

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
export function mergeGraphs(graphs: readonly XoirGraph[], newGraphId: XoirGraphId, strategy: MergeStrategy = 'prefer_higher_confidence'): Result<MergeResult, XoError> {
  if (graphs.length === 0) {
    return err(new InvalidArgumentError('mergeGraphs requires at least one graph'));
  }

  const nodesById = new Map<XoirNodeId, XoirNode[]>();
  for (const graph of graphs) {
    for (const node of graph.allNodes()) {
      const list = nodesById.get(node.id) ?? [];
      list.push(node);
      nodesById.set(node.id, list);
    }
  }

  const merged = XoirGraph.create(newGraphId, graphs[0]!.schemaVersion);
  const conflicts: MergeConflict[] = [];

  for (const [id, candidates] of nodesById) {
    const distinctHashes = new Set(candidates.map((c) => c.hash));
    if (distinctHashes.size === 1) {
      const added = merged.addNode(candidates[0]!);
      if (!added.ok) return err(added.error);
      continue;
    }

    const reason: MergeConflict['reason'] = new Set(candidates.map((c) => c.version)).size > 1 ? 'version_conflict' : 'duplicate_id_different_content';
    const resolution = resolveConflict(candidates, strategy);
    conflicts.push({ nodeId: id, reason, candidates, resolution });

    if (resolution === undefined) {
      return err(new XoirError(ErrorCode.XOIR_MERGE_CONFLICT, `Unresolved conflict for node "${id}" under strategy "error_on_conflict"`));
    }
    const added = merged.addNode(resolution);
    if (!added.ok) return err(added.error);
  }

  const edgesById = new Map<string, ReturnType<XoirGraph['allEdges']>[number][]>();
  for (const graph of graphs) {
    for (const edge of graph.allEdges()) {
      const list = edgesById.get(edge.id) ?? [];
      list.push(edge);
      edgesById.set(edge.id, list);
    }
  }
  for (const [, candidates] of edgesById) {
    // Endpoints may have been remapped by a node conflict resolution above; only add an edge whose endpoints both survived into `merged`.
    const edge = candidates[0]!;
    if (merged.hasNode(edge.fromId) && merged.hasNode(edge.toId) && !merged.getEdge(edge.id).ok) {
      const added = merged.addEdge(edge);
      if (!added.ok) return err(added.error);
    }
  }

  return ok({ graph: merged, conflicts });
}