import type { ContentHash } from '@xo/types';
import type { XoirEdgeId, XoirNodeId } from './ids.js';
import type { XoirPropertyBag } from './values.js';
import type { XoirConfidence } from './confidence.js';
import type { XoirSourceRef } from './node-kinds.js';

/**
 * The canonical core semantic edge vocabulary (reconciliation report §6):
 * relationships that express how expertise behaves, depends, conflicts,
 * derives, or composes. `REQUIRES`, `CONTRADICTS`, `SUPPORTS`,
 * `SUPERSEDES`, and `DERIVED_FROM` already existed pre-reconciliation and
 * needed no rename; the other five (`REFINES`, `ESCALATES_TO`,
 * `TRIGGERED_BY`, `CO_OCCURS_WITH`, `COMPOSES_INTO`) are new.
 */
export type CoreXoirEdgeKind =
  | 'REQUIRES'
  | 'CONTRADICTS'
  | 'SUPPORTS'
  | 'REFINES'
  | 'SUPERSEDES'
  | 'ESCALATES_TO'
  | 'TRIGGERED_BY'
  | 'CO_OCCURS_WITH'
  | 'DERIVED_FROM'
  | 'COMPOSES_INTO';

/**
 * Extended domain/structural relationship types (reconciliation report
 * §6): genuinely useful across the platform, but they describe structure
 * ("X defines Y", "X is part of Y") rather than expertise *behavior* the
 * way the core vocabulary does. `IMPLEMENTS`, `REFERENCES`, `VALIDATES`,
 * `USES`, `LINKS_TO`, `INHERITS`, and `GENERATED_BY` predate the
 * reconciliation and are unchanged. `DEPENDS_ON` also predates it and is
 * kept as a general-purpose dependency edge distinct from the narrower
 * semantic `REQUIRES` — new code should prefer `REQUIRES` for expertise
 * dependencies (a `Capability` requiring a `RiskPolicy`, e.g.) and reserve
 * `DEPENDS_ON` for structural/build-order dependencies, but both remain
 * fully supported.
 *
 * The rest of this union is the direct migration target for Stage 4's
 * `KnownKnowledgeEdgeType` and Stage 5's `KnownCapabilityRelationType`
 * (`packages/compiler/src/knowledge/types.ts`,
 * `packages/compiler/src/capabilities/types.ts`) — see
 * `packages/compiler/src/xoir/edge-mapping.ts` for the exact table.
 */
export type ExtendedXoirEdgeKind =
  | 'DEPENDS_ON'
  | 'IMPLEMENTS'
  | 'REFERENCES'
  | 'VALIDATES'
  | 'USES'
  | 'LINKS_TO'
  | 'INHERITS'
  | 'GENERATED_BY'
  | 'DEFINES'
  | 'PART_OF'
  | 'PRODUCES'
  | 'CONSUMES'
  | 'EXTENDS'
  | 'COMPLEMENTS'
  | 'INVOKES'
  | 'ENABLES'
  | 'CONFLICTS_WITH'
  | 'GOVERNS'
  | 'CAUSES'
  | 'MITIGATES'
  | 'MEASURES'
  | 'OWNED_BY'
  | 'LOCATED_IN'
  | 'BELONGS_TO'
  | 'VERSION_OF'
  /**
   * Stage 7's one genuine XOIR taxonomy addition (reasoning/decision
   * extraction — see `@xo/compiler`'s `src/xoir/reasoning-to-xoir.ts`).
   * "Option A is preferred when X, otherwise Option B" needs to say A and
   * B are mutually-exclusive choices in the same decision — no existing
   * edge kind covers that without a semantic stretch:
   * `COMPOSES_INTO`/`COMPLEMENTS` both mean "combines with," the opposite
   * of "instead of"; `CONTRADICTS` is for two claims that logically
   * disagree, not two options a decision-maker is choosing between (both
   * can be independently true statements — only one gets *chosen*).
   * Symmetric by convention: an `ALTERNATIVE_TO` edge from A to B implies
   * the reverse holds too, so producers only need to emit one direction.
   */
  | 'ALTERNATIVE_TO';

/**
 * Known edge kinds. Like {@link XoirNodeKind}, this is open-ended via
 * `custom:<name>` — the graph engine (graph.ts) never requires an
 * exhaustive switch over edge kinds.
 */
export type KnownXoirEdgeKind = CoreXoirEdgeKind | ExtendedXoirEdgeKind;

export type CustomXoirEdgeKind = `custom:${string}`;
export type XoirEdgeKind = KnownXoirEdgeKind | CustomXoirEdgeKind;

export function isCoreXoirEdgeKind(kind: string): kind is CoreXoirEdgeKind {
  return (
    kind === 'REQUIRES' ||
    kind === 'CONTRADICTS' ||
    kind === 'SUPPORTS' ||
    kind === 'REFINES' ||
    kind === 'SUPERSEDES' ||
    kind === 'ESCALATES_TO' ||
    kind === 'TRIGGERED_BY' ||
    kind === 'CO_OCCURS_WITH' ||
    kind === 'DERIVED_FROM' ||
    kind === 'COMPOSES_INTO'
  );
}

export interface XoirEdgeMetadata {
  readonly confidence: number;
  /** See `node-kinds.ts#XoirNodeMetadata.confidenceDetail` — same canonical confidence model, applied to edges. */
  readonly confidenceDetail?: XoirConfidence;
  /** A relationship is itself an extracted claim (e.g. "clause A requires clause B") and can have its own provenance, distinct from either endpoint's. Same shape as node provenance — see `node-kinds.ts#XoirSourceRef`. */
  readonly sourceRefs: readonly XoirSourceRef[];
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly custom: XoirPropertyBag;
}

/**
 * A directed, typed edge. `weight` is optional and kind-agnostic (e.g. a
 * `SUPPORTS` edge's strength, a `DEPENDS_ON` edge's criticality) — passes
 * that care about a more specific numeric semantic should use `properties`
 * instead of overloading `weight`'s meaning per kind.
 */
export interface XoirEdge<K extends XoirEdgeKind = XoirEdgeKind, P extends XoirPropertyBag = XoirPropertyBag> {
  readonly id: XoirEdgeId;
  readonly kind: K;
  readonly fromId: XoirNodeId;
  readonly toId: XoirNodeId;
  readonly properties: P;
  readonly metadata: XoirEdgeMetadata;
  readonly weight?: number;
  readonly hash: ContentHash;
}

export interface CreateEdgeInput<K extends XoirEdgeKind, P extends XoirPropertyBag> {
  readonly id: XoirEdgeId;
  readonly kind: K;
  readonly fromId: XoirNodeId;
  readonly toId: XoirNodeId;
  readonly properties?: P;
  readonly confidence?: number;
  readonly confidenceDetail?: XoirConfidence;
  readonly sourceRefs?: readonly XoirSourceRef[];
  readonly tags?: readonly string[];
  readonly custom?: XoirPropertyBag;
  readonly weight?: number;
  readonly now?: () => string;
}

/** Builds an edge with metadata defaults filled in. As with {@link createNode}, hashing happens separately (hashing.ts#hashEdge), applied by `graph.ts#XoirGraph.addEdge`. */
export function createEdge<K extends XoirEdgeKind, P extends XoirPropertyBag>(
  input: CreateEdgeInput<K, P>,
): Omit<XoirEdge<K, P>, 'hash'> {
  const now = input.now ?? (() => new Date().toISOString());
  const confidence = input.confidence ?? input.confidenceDetail?.score ?? 1;
  const base = {
    id: input.id,
    kind: input.kind,
    fromId: input.fromId,
    toId: input.toId,
    properties: (input.properties ?? ({} as P)) as P,
    metadata: {
      confidence,
      ...(input.confidenceDetail ? { confidenceDetail: input.confidenceDetail } : {}),
      sourceRefs: input.sourceRefs ?? [],
      tags: input.tags ?? [],
      createdAt: now(),
      custom: input.custom ?? {},
    },
  };
  return input.weight !== undefined ? { ...base, weight: input.weight } : base;
}