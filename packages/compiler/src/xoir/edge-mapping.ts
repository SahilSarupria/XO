import type { XoirEdgeKind } from '@xo/xoir';
import type { KnownKnowledgeEdgeType, KnowledgeEdgeType } from '../knowledge/types.js';
import type { CapabilityRelationType, KnownCapabilityRelationType } from '../capabilities/types.js';

/**
 * Stage 4's `KnownKnowledgeEdgeType` -> XOIR edge kind, per the
 * reconciliation report §6. Five of Stage 4's types (`requires`,
 * `supports`, `contradicts`, `derived_from`, `supersedes`) land on the
 * canonical *core* semantic vocabulary (`CoreXoirEdgeKind`) because they
 * already meant exactly what the core vocabulary means; the rest land on
 * `ExtendedXoirEdgeKind` because they describe structure
 * ("X defines Y", "X is part of Y") rather than expertise behavior — see
 * `@xo/xoir`'s `edge-kinds.ts` doc comments for the core/extended
 * distinction itself. This is a total, 1:1, uppercase-naming-convention
 * mapping — no Stage 4 edge type is dropped or collapsed into another.
 */
export const KNOWLEDGE_EDGE_TYPE_TO_XOIR: Readonly<Record<KnownKnowledgeEdgeType, XoirEdgeKind>> = {
  defines: 'DEFINES',
  references: 'REFERENCES',
  depends_on: 'DEPENDS_ON',
  implements: 'IMPLEMENTS',
  requires: 'REQUIRES',
  supports: 'SUPPORTS',
  contradicts: 'CONTRADICTS',
  belongs_to: 'BELONGS_TO',
  part_of: 'PART_OF',
  causes: 'CAUSES',
  mitigates: 'MITIGATES',
  measures: 'MEASURES',
  governs: 'GOVERNS',
  owned_by: 'OWNED_BY',
  uses: 'USES',
  produces: 'PRODUCES',
  consumes: 'CONSUMES',
  located_in: 'LOCATED_IN',
  derived_from: 'DERIVED_FROM',
  version_of: 'VERSION_OF',
  supersedes: 'SUPERSEDES',
};

function isKnownKnowledgeEdgeType(type: KnowledgeEdgeType): type is KnownKnowledgeEdgeType {
  return Object.prototype.hasOwnProperty.call(KNOWLEDGE_EDGE_TYPE_TO_XOIR, type);
}

/** Resolves a Stage 4 edge's `type` to a XOIR edge kind. `custom:<name>` types pass through unchanged — XOIR's own `CustomXoirEdgeKind` uses the identical `custom:<name>` convention, so no translation is needed or lossy. */
export function xoirEdgeKindForKnowledgeEdgeType(type: KnowledgeEdgeType): XoirEdgeKind {
  if (isKnownKnowledgeEdgeType(type)) return KNOWLEDGE_EDGE_TYPE_TO_XOIR[type];
  return type; // already `custom:${string}` in both type systems
}

/**
 * Stage 5's `KnownCapabilityRelationType` -> XOIR edge kind. `depends_on`
 * and `requires` map onto their identically-named XOIR counterparts (both
 * already existed pre-reconciliation). `conflicts_with` is deliberately
 * NOT folded into `CONTRADICTS`: a logical contradiction between two
 * claims (`CONTRADICTS`) and two capabilities that can't both run in the
 * same session (`CONFLICTS_WITH`, e.g. resource contention) are different
 * relationships that happen to share a superficial "these disagree" flavor
 * — collapsing them would lose that distinction, so `CONFLICTS_WITH` is
 * its own extended edge kind.
 */
export const CAPABILITY_RELATION_TYPE_TO_XOIR: Readonly<Record<KnownCapabilityRelationType, XoirEdgeKind>> = {
  depends_on: 'DEPENDS_ON',
  invokes: 'INVOKES',
  produces: 'PRODUCES',
  consumes: 'CONSUMES',
  extends: 'EXTENDS',
  requires: 'REQUIRES',
  enables: 'ENABLES',
  conflicts_with: 'CONFLICTS_WITH',
  complements: 'COMPLEMENTS',
};

function isKnownCapabilityRelationType(type: CapabilityRelationType): type is KnownCapabilityRelationType {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_RELATION_TYPE_TO_XOIR, type);
}

export function xoirEdgeKindForCapabilityRelationType(type: CapabilityRelationType): XoirEdgeKind {
  if (isKnownCapabilityRelationType(type)) return CAPABILITY_RELATION_TYPE_TO_XOIR[type];
  return type;
}
