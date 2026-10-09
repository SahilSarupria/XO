import type { ExperienceDocument } from '../semantic/types.js';
import { computeKnowledgeEdgeId } from './node-id.js';
import type { PerUnitExtraction, MergeResult } from './merge.js';
import type { KnowledgeEdge, KnowledgeEdgeType, KnowledgeNodeId, KnowledgeProvenance } from './types.js';

const MIN_REFERENCE_LABEL_LENGTH = 3; // avoid spurious matches on very short labels

function unitProvenance(unit: ExperienceDocument['units'][number], confidence: number): KnowledgeProvenance {
  return {
    experienceUnitId: unit.id,
    documentPath: unit.provenance.documentPath,
    pages: unit.provenance.pages,
    sectionPath: unit.provenance.sectionPath,
    charOffsetRange: undefined,
    confidence,
  };
}

/** Stage 3's unit-level relationship types map onto knowledge-edge types with the same name where one already exists (`defines`, `supports`, `references`); `extends` (a subsection's idea extending its parent's) becomes `part_of` at the knowledge-graph level, since "this concept is part of that broader concept" is the more natural framing for a graph of ideas rather than of document sections. */
function mapUnitRelationType(type: ExperienceDocument['relationshipGraph']['relationships'][number]['type']): KnowledgeEdgeType | undefined {
  switch (type) {
    case 'extends':
      return 'part_of';
    case 'supports':
      return 'supports';
    case 'defines':
      return 'defines';
    case 'references':
      return 'references';
    default:
      return undefined; // a custom Stage 3 relation type has no default knowledge-graph mapping
  }
}

/**
 * Builds every final `KnowledgeEdge`, from three sources:
 *
 * 1. Each extractor's own `CandidateKnowledgeEdgeRef`s (today, only
 *    `AiKnowledgeExtractor` produces any), resolved from local ids to
 *    final node ids via `mergeResult.resolveLocalId`.
 * 2. Stage 3's unit-level relationship graph, projected onto each unit's
 *    primary knowledge node (see `mapUnitRelationType`).
 * 3. Content-mention `references` edges: a unit's primary node
 *    references any other node whose canonical label appears verbatim in
 *    that unit's own content (excluding a node the same unit already
 *    produced itself, to avoid a trivial self-reference).
 *
 * A `CandidateKnowledgeEdgeRef` or Stage 3 relationship whose endpoint(s)
 * didn't resolve to a merged node (e.g. a unit contributed no candidates
 * at all) is silently dropped rather than producing a dangling edge.
 */
export function buildKnowledgeEdges(experienceDocument: ExperienceDocument, perUnit: readonly PerUnitExtraction[], mergeResult: MergeResult): readonly KnowledgeEdge[] {
  interface EdgeAccumulator {
    readonly type: KnowledgeEdgeType;
    readonly fromNodeId: KnowledgeNodeId;
    readonly toNodeId: KnowledgeNodeId;
    confidenceSum: number;
    count: number;
    readonly provenance: KnowledgeProvenance[];
  }
  const accumulators = new Map<string, EdgeAccumulator>();

  const pushEdge = (type: KnowledgeEdgeType, fromNodeId: KnowledgeNodeId | undefined, toNodeId: KnowledgeNodeId | undefined, confidence: number, provenance: KnowledgeProvenance): void => {
    if (fromNodeId === undefined || toNodeId === undefined || fromNodeId === toNodeId) return;
    const dedupeKey = `${type}\u0000${fromNodeId}\u0000${toNodeId}`;
    const existing = accumulators.get(dedupeKey);
    if (existing) {
      existing.confidenceSum += confidence;
      existing.count += 1;
      existing.provenance.push(provenance);
    } else {
      accumulators.set(dedupeKey, { type, fromNodeId, toNodeId, confidenceSum: confidence, count: 1, provenance: [provenance] });
    }
  };

  // 1. Extractor-supplied edges (local id -> final id resolution)
  for (const { unit, extraction } of perUnit) {
    for (const ref of extraction.edges) {
      const fromId = mergeResult.resolveLocalId(unit.id, ref.fromLocalId);
      const toId = mergeResult.resolveLocalId(unit.id, ref.toLocalId);
      pushEdge(ref.type, fromId, toId, ref.confidence, ref.provenance);
    }
  }

  // 2. Stage 3 relationship-graph projection, onto each unit's primary node
  for (const rel of experienceDocument.relationshipGraph.relationships) {
    const mappedType = mapUnitRelationType(rel.type);
    if (!mappedType) continue;
    const fromId = mergeResult.resolveLocalId(rel.fromUnitId, 'primary');
    const toId = mergeResult.resolveLocalId(rel.toUnitId, 'primary');
    const fromUnit = experienceDocument.units.find((u) => u.id === rel.fromUnitId);
    if (!fromUnit) continue;
    pushEdge(mappedType, fromId, toId, rel.confidence, unitProvenance(fromUnit, rel.confidence));
  }

  // 3. Content-mention references
  for (const { unit } of perUnit) {
    const primaryId = mergeResult.resolveLocalId(unit.id, 'primary');
    if (primaryId === undefined) continue;
    for (const node of mergeResult.nodes) {
      if (node.id === primaryId) continue;
      if (node.canonicalLabel.length < MIN_REFERENCE_LABEL_LENGTH) continue;
      if (unit.content.includes(node.canonicalLabel)) {
        pushEdge('references', primaryId, node.id, 0.6, unitProvenance(unit, 0.6));
      }
    }
  }

  const edges: KnowledgeEdge[] = [...accumulators.values()].map((acc) => ({
    id: computeKnowledgeEdgeId(acc.type, acc.fromNodeId, acc.toNodeId),
    type: acc.type,
    fromNodeId: acc.fromNodeId,
    toNodeId: acc.toNodeId,
    confidence: Math.round((acc.confidenceSum / acc.count) * 1000) / 1000,
    provenance: acc.provenance,
  }));

  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return edges;
}
