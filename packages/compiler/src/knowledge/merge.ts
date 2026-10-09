import type { ExperienceUnit } from '../semantic/types.js';
import type { CandidateKnowledgeNode, ExtractionResult } from './extractor-types.js';
import { computeKnowledgeNodeId, computeMatchKey } from './node-id.js';
import type { KnowledgeNode, KnowledgeNodeId } from './types.js';

export interface PerUnitExtraction {
  readonly unit: ExperienceUnit;
  readonly extraction: ExtractionResult;
}

export interface MergeResult {
  readonly nodes: readonly KnowledgeNode[];
  /** Resolves a candidate's `(sourceUnitId, localId)` to the final node id it merged into — the seam `relationship-builder.ts` uses to turn `CandidateKnowledgeEdgeRef`s and Stage 3 projections into real `KnowledgeEdge`s. */
  readonly resolveLocalId: (sourceUnitId: string, localId: string) => KnowledgeNodeId | undefined;
}

function localIdKey(sourceUnitId: string, localId: string): string {
  return `${sourceUnitId}\u0000${localId}`;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Groups every candidate node — from every unit, from every extractor
 * that ran — by its match key (semantic type + normalized label, see
 * `node-id.ts`) and merges each group into one final `KnowledgeNode`:
 * "OpenAI", "Open AI", and "OpenAI Inc." all land in the same group and
 * become one node.
 *
 * - `canonicalLabel`: the surface form seen most often across the
 *   group; ties broken by whichever was seen first (stable, deterministic
 *   — candidates are processed in document order).
 * - `aliases`: every other distinct surface form, sorted.
 * - `confidence`: the group's average confidence, rounded to 3 decimals.
 * - `provenance`: every contributing candidate's provenance, concatenated
 *   in the same stable order.
 * - `id`: a hash of the match key alone (`node-id.ts`), so it never
 *   depends on which surface form won the canonical-label tie-break.
 *
 * The final `nodes` array is sorted by id — an output-ordering
 * normalization, independent of (and in addition to) the id computation's
 * own order-independence.
 */
export function mergeKnowledgeNodes(perUnit: readonly PerUnitExtraction[]): MergeResult {
  const allCandidates: CandidateKnowledgeNode[] = [];
  for (const { extraction } of perUnit) allCandidates.push(...extraction.nodes);

  const groups = new Map<string, CandidateKnowledgeNode[]>();
  for (const candidate of allCandidates) {
    const key = computeMatchKey(candidate.semanticType, candidate.label);
    const list = groups.get(key) ?? [];
    list.push(candidate);
    groups.set(key, list);
  }

  const nodes: KnowledgeNode[] = [];
  const localIdMap = new Map<string, KnowledgeNodeId>();

  for (const candidates of groups.values()) {
    const semanticType = candidates[0]!.semanticType;

    const labelCounts = new Map<string, number>();
    for (const c of candidates) labelCounts.set(c.label, (labelCounts.get(c.label) ?? 0) + 1);
    let canonicalLabel = candidates[0]!.label;
    let bestCount = 0;
    for (const c of candidates) {
      const count = labelCounts.get(c.label)!;
      if (count > bestCount) {
        bestCount = count;
        canonicalLabel = c.label;
      }
    }

    const aliases = [...new Set(candidates.map((c) => c.label))].filter((label) => label !== canonicalLabel).sort();
    const confidence = round3(candidates.reduce((sum, c) => sum + c.confidence, 0) / candidates.length);
    const provenance = candidates.map((c) => c.provenance);
    const metadata: Record<string, string> = {};
    for (const c of candidates) Object.assign(metadata, c.metadata);

    const id = computeKnowledgeNodeId(semanticType, canonicalLabel);
    // P0.9A area A: only attribute a single producer when every candidate
    // in this merge group actually came from the same extractor — a
    // group merging a rule-based candidate with an AI candidate (see
    // this file's own doc comment above) has no single honest producer,
    // so `producedBy` is correctly left absent rather than guessed.
    const extractorNames = new Set(candidates.map((c) => c.extractorName).filter((n): n is string => n !== undefined));
    const producedBy = extractorNames.size === 1 ? [...extractorNames][0] : undefined;
    nodes.push({ id, semanticType, canonicalLabel, aliases, confidence, provenance, metadata, ...(producedBy !== undefined ? { producedBy } : {}) });

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
