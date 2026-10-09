import { computeReasoningEdgeId } from './node-id.js';
import type { PerUnitReasoningExtraction, ReasoningMergeResult } from './merge.js';
import type { ReasoningEdge, ReasoningEdgeType, ReasoningNodeId } from './types.js';
import type { KnowledgeProvenance } from '../knowledge/types.js';

/**
 * Resolves every extractor-supplied `CandidateReasoningEdgeRef` (local
 * id → local id, scoped to one unit) into a final `ReasoningEdge` between
 * merged node ids, deduplicating and averaging confidence for edges that
 * collapse onto the same `(type, fromNodeId, toNodeId)` triple — mirrors
 * `../knowledge/relationship-builder.ts`'s accumulator pattern, minus the
 * Stage-3-relationship-graph projection and content-mention steps that
 * file also does (Stage 7 has no equivalent of Stage 3's unit-level
 * relationship graph to project, and cross-domain content-mention linking
 * against Knowledge/Capability nodes happens at the XOIR layer instead —
 * see `../xoir/reasoning-to-xoir.ts`'s doc comment for why).
 */
export function buildReasoningEdges(perUnit: readonly PerUnitReasoningExtraction[], mergeResult: ReasoningMergeResult): readonly ReasoningEdge[] {
  interface EdgeAccumulator {
    readonly type: ReasoningEdgeType;
    readonly fromNodeId: ReasoningNodeId;
    readonly toNodeId: ReasoningNodeId;
    confidenceSum: number;
    count: number;
    readonly provenance: KnowledgeProvenance[];
  }
  const accumulators = new Map<string, EdgeAccumulator>();

  for (const { unit, extraction } of perUnit) {
    for (const ref of extraction.edges) {
      const fromNodeId = mergeResult.resolveLocalId(unit.id, ref.fromLocalId);
      const toNodeId = mergeResult.resolveLocalId(unit.id, ref.toLocalId);
      if (fromNodeId === undefined || toNodeId === undefined || fromNodeId === toNodeId) continue;
      const dedupeKey = `${ref.type}\u0000${fromNodeId}\u0000${toNodeId}`;
      const existing = accumulators.get(dedupeKey);
      if (existing) {
        existing.confidenceSum += ref.confidence;
        existing.count += 1;
        existing.provenance.push(ref.provenance);
      } else {
        accumulators.set(dedupeKey, { type: ref.type, fromNodeId, toNodeId, confidenceSum: ref.confidence, count: 1, provenance: [ref.provenance] });
      }
    }
  }

  const edges: ReasoningEdge[] = [...accumulators.values()].map((acc) => ({
    id: computeReasoningEdgeId(acc.type, acc.fromNodeId, acc.toNodeId),
    type: acc.type,
    fromNodeId: acc.fromNodeId,
    toNodeId: acc.toNodeId,
    confidence: Math.round((acc.confidenceSum / acc.count) * 1000) / 1000,
    provenance: acc.provenance,
  }));

  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return edges;
}
