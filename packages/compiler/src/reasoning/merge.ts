import type { ExperienceUnit } from '../semantic/types.js';
import type { CandidateReasoningNode, ReasoningExtractionResult } from './extractor-types.js';
import { computeReasoningMatchKey, computeReasoningNodeId } from './node-id.js';
import type { ReasoningNode, ReasoningNodeId } from './types.js';
import { parseStructuredCondition, type StructuredExceptionCondition } from '@xo/capability-contract';

export interface PerUnitReasoningExtraction {
  readonly unit: ExperienceUnit;
  readonly extraction: ReasoningExtractionResult;
}

export interface ReasoningMergeResult {
  readonly nodes: readonly ReasoningNode[];
  readonly resolveLocalId: (sourceUnitId: string, localId: string) => ReasoningNodeId | undefined;
}

function localIdKey(sourceUnitId: string, localId: string): string {
  return `${sourceUnitId}\u0000${localId}`;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Phase 2: rebuilds `structuredExceptions` from the FINAL, merged
 * `exceptionConditions` list (unioned/deduped/sorted, per this file's own
 * doc comment) rather than picking any single candidate's own
 * `structuredExceptions` array — a candidate's raw `exceptionConditions`
 * order and the merged group's order are not guaranteed to match, so
 * indexing into a per-candidate array after the merge would risk pairing
 * a raw exception string with the wrong structured projection. Rebuilding
 * fresh from the same authoritative list this function already computes
 * is what keeps the two arrays provably in lockstep.
 */
function buildStructuredExceptionsForMergedList(exceptionConditions: readonly string[]): readonly StructuredExceptionCondition[] | undefined {
  if (exceptionConditions.length === 0) return undefined;
  return exceptionConditions.map((raw) => {
    const condition = parseStructuredCondition(raw);
    return condition !== undefined ? { raw, condition } : { raw };
  });
}

function pickField<K extends keyof CandidateReasoningNode>(candidates: readonly CandidateReasoningNode[], field: K): CandidateReasoningNode[K] | undefined {
  for (const c of candidates) {
    if (c[field] !== undefined) return c[field];
  }
  return undefined;
}

/**
 * Groups every candidate node — from every unit, from every extractor
 * that ran (rule-based always; AI, when configured) — by its match key
 * (node type + normalized canonical label, `node-id.ts`) and merges each
 * group into one final `ReasoningNode`: the same rule stated once by the
 * rule-based extractor and once (independently) by the AI extractor
 * converges on one node with higher corroboration, never a duplicate.
 * Mirrors `../knowledge/merge.ts#mergeKnowledgeNodes` exactly, with one
 * addition: `exceptionConditions` is *unioned* (deduplicated) across the
 * group rather than taken from a single winner — an UNLESS clause one
 * extractor found and another missed should never be dropped, per Stage
 * 7 §8's provenance-is-additive rule extended to this field.
 */
export function mergeReasoningNodes(perUnit: readonly PerUnitReasoningExtraction[]): ReasoningMergeResult {
  const allCandidates: CandidateReasoningNode[] = [];
  for (const { extraction } of perUnit) allCandidates.push(...extraction.nodes);

  const groups = new Map<string, CandidateReasoningNode[]>();
  for (const candidate of allCandidates) {
    const key = computeReasoningMatchKey(candidate.nodeType, candidate.canonicalLabel);
    const list = groups.get(key) ?? [];
    list.push(candidate);
    groups.set(key, list);
  }

  const nodes: ReasoningNode[] = [];
  const localIdMap = new Map<string, ReasoningNodeId>();

  for (const candidates of groups.values()) {
    const nodeType = candidates[0]!.nodeType;
    const canonicalLabel = candidates[0]!.canonicalLabel;
    const confidence = round3(candidates.reduce((sum, c) => sum + c.confidence, 0) / candidates.length);
    const provenance = candidates.map((c) => c.provenance);
    const exceptionConditions = [...new Set(candidates.flatMap((c) => c.exceptionConditions))].sort();
    const metadata: Record<string, string> = {};
    for (const c of candidates) Object.assign(metadata, c.metadata);

    const condition = pickField(candidates, 'condition');
    const action = pickField(candidates, 'action');
    const outcome = pickField(candidates, 'outcome');
    const rationale = pickField(candidates, 'rationale');
    const structuredCondition = pickField(candidates, 'structuredCondition');
    const structuredAction = pickField(candidates, 'structuredAction');
    const structuredExceptions = buildStructuredExceptionsForMergedList(exceptionConditions);

    const id = computeReasoningNodeId(nodeType, canonicalLabel);
    nodes.push({
      id,
      nodeType,
      canonicalLabel,
      ...(condition !== undefined ? { condition } : {}),
      ...(action !== undefined ? { action } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
      exceptionConditions,
      confidence,
      provenance,
      metadata,
      ...(structuredCondition !== undefined ? { structuredCondition } : {}),
      ...(structuredAction !== undefined ? { structuredAction } : {}),
      ...(structuredExceptions !== undefined ? { structuredExceptions } : {}),
    });

    for (const c of candidates) {
      localIdMap.set(localIdKey(c.sourceUnitId, c.localId), id);
    }
  }

  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    nodes,
    resolveLocalId: (sourceUnitId, localId) => localIdMap.get(localIdKey(sourceUnitId, localId)),
  };
}
