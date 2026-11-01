import type { ConfidenceBasis, EvidenceStrength, XoirEdgeKind } from '@xo/xoir';
import type { EpistemicStatus } from '../epistemic.js';
import type { IngestedItem } from '../ingestion.js';

/**
 * C5 - organizational knowledge model: vocabulary.
 *
 * Everything here is DERIVED. Knowledge is never authoritative: it is a deterministic function of (evidence the ledger currently
 * reports eligible, the deriver, the explicit review decisions). Nothing in this module grants permission to act.
 */

export const ENTITY_KINDS = ['person', 'team', 'organization', 'project', 'customer', 'asset'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** What a knowledge claim is ABOUT (C5.3). A claim is never conflated with the document it came from (see `DocumentItem`). */
export const KNOWLEDGE_KINDS = ['fact', 'policy', 'procedure', 'decision', 'event', 'responsibility', 'dependency'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/**
 * How the claim came to be (rule 4). `observed`: the source system itself records it. `stated`: a document or person asserts it.
 * `inferred`: a deriver concluded it. These are DISTINCT and never collapse into one another.
 */
export type ClaimOrigin = 'observed' | 'stated' | 'inferred';

/** C5.2 vocabulary. `xoir` records the existing XOIR edge kind it maps onto (reuse), or `null` where XOIR has no equivalent (a documented gap). */
export const RELATIONSHIP_TYPES = ['manages', 'belongs_to', 'owns', 'depends_on', 'governs', 'associated_with'] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const XOIR_EDGE_FOR: Readonly<Record<RelationshipType, { readonly edge: XoirEdgeKind | null; readonly inverse: boolean }>> =
  Object.freeze({
    manages: { edge: null, inverse: false },
    belongs_to: { edge: 'BELONGS_TO', inverse: false },
    owns: { edge: 'OWNED_BY', inverse: true },
    depends_on: { edge: 'DEPENDS_ON', inverse: false },
    governs: { edge: 'GOVERNS', inverse: false },
    associated_with: { edge: null, inverse: false },
  });

export interface Identifier {
  readonly scheme: string;
  readonly value: string;
}

/** A reference to an entity as one record mentions it: kind plus every identifier the record lists for it. */
export interface EntityRef {
  readonly kind: EntityKind;
  readonly identifiers: readonly Identifier[];
}

export type Scalar = string | number | boolean;

// ── what a deriver emits ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface EntityCandidate {
  readonly type: 'entity';
  readonly ref: EntityRef;
}
export interface RelationshipCandidate {
  readonly type: 'relationship';
  readonly relation: RelationshipType;
  readonly from: EntityRef;
  readonly to: EntityRef;
  readonly origin: ClaimOrigin;
  readonly validFrom?: string;
  readonly validTo?: string;
}
export interface ClaimCandidate {
  readonly type: 'claim';
  readonly kind: KnowledgeKind;
  readonly subject: EntityRef;
  readonly predicate: string;
  readonly value: Scalar;
  readonly origin: ClaimOrigin;
  readonly validFrom?: string;
  readonly validTo?: string;
}
export type Candidate = EntityCandidate | RelationshipCandidate | ClaimCandidate;

// ── what the model stores ────────────────────────────────────────────────────────────────────────────────────────────────

/** The evidence one assertion rests on. Digests, ids and times only: never content, locators or resource keys. */
export interface EvidenceSupport {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly resourceDigest: string;
  readonly contentHash: string;
  readonly observedAt: string;
  /** Audit operation id of the ingestion batch that committed it (absent when re-hydrated without an ingestion result). */
  readonly batchOperationId?: string;
  /** `journal_checkpoint`: the batch's provenance digest equals the durable checkpoint's. `journal_index`: the durable resource index lists this evidence. */
  readonly anchoring: 'journal_checkpoint' | 'journal_index';
}

export interface DerivationInfo {
  readonly deriverId: string;
  readonly deriverVersion: string;
  /** Deterministic: digest of deriver id + version + evidence id. The same evidence derived twice has the same id. */
  readonly derivationId: string;
  readonly principalId: string;
  readonly derivedAt: string;
}

/** One atomic derived statement resting on ONE evidence item. The model's only primitive store; everything else is a view over eligible assertions. */
export interface Assertion {
  readonly id: string;
  readonly candidate: Candidate;
  readonly support: EvidenceSupport;
  readonly derivation: DerivationInfo;
}

/** The ingestion batch a support belongs to; kept so provenance can be re-verified against the durable checkpoint. */
export interface BatchRecord {
  readonly operationId: string;
  readonly binding: string;
  readonly items: readonly IngestedItem[];
  readonly digest: string;
}

export type ReviewDecisionKind = 'approve_merge' | 'block_merge' | 'resolve_conflict';
export interface ReviewDecision {
  readonly id: string;
  readonly kind: ReviewDecisionKind;
  /** approve/block merge: the two identifier keys. resolve_conflict: the conflict id and the digest of the winning value. Digests/keys only. */
  readonly subject: readonly string[];
  readonly principalId: string;
  readonly decidedAt: string;
  readonly operationId: string;
}

// ── what a query returns ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ItemConfidence {
  readonly status: EpistemicStatus;
  readonly strength: EvidenceStrength;
  readonly basis: ConfidenceBasis;
  /** Number of INDEPENDENT sources (distinct source ids) currently supporting the item. */
  readonly corroboration: number;
  /** Always false: nothing here is a calibrated probability, and confidence is never authorization. */
  readonly calibrated: false;
  /**
   * True when the item may be treated as a fact: always for `observed` / `stated` claims, and for an INFERENCE only when >= 2
   * independent sources corroborate it. An uncorroborated inference stays flagged (`false`) and is never reported as current knowledge.
   */
  readonly promotedToFact: boolean;
}

export interface ItemProvenance {
  readonly support: readonly EvidenceSupport[];
  readonly derivations: readonly DerivationInfo[];
  /** Re-verified against the ledger in THIS call. */
  readonly lastVerifiedAt: string;
}

export interface Validity {
  readonly validFrom: string;
  readonly validTo?: string;
  /** Which evidence established the validity start (its observation time when the source gave none). */
  readonly establishedBy: string;
}

export interface MergeBasis {
  readonly kind: 'shared_identifier' | 'co_listed_identifiers' | 'human_approved';
  readonly identifierKeys: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface EntityItem {
  readonly type: 'entity';
  readonly id: string;
  readonly kind: EntityKind;
  readonly identifiers: readonly string[];
  /** Ids this entity answered to before merges (resolved by `entity.id`). */
  readonly aliases: readonly string[];
  readonly merges: readonly MergeBasis[];
  readonly confidence: ItemConfidence;
  readonly provenance: ItemProvenance;
  /** Weak, refused merges that would join this entity to another (never applied; a human may approve). */
  readonly mergeCandidates: readonly string[];
}

export interface RelationshipItem {
  readonly type: 'relationship';
  readonly id: string;
  readonly relation: RelationshipType;
  readonly xoirEdge: XoirEdgeKind | null;
  readonly from: string;
  readonly to: string;
  readonly origin: ClaimOrigin;
  readonly validity: Validity;
  readonly confidence: ItemConfidence;
  readonly provenance: ItemProvenance;
}

export interface ClaimValue {
  readonly value: Scalar;
  readonly origin: ClaimOrigin;
  readonly validity: Validity;
  readonly confidence: ItemConfidence;
  readonly provenance: ItemProvenance;
  /** Documents (not facts) the value was read from. */
  readonly documents: readonly string[];
}

export interface ClaimItem {
  readonly type: 'claim';
  readonly id: string;
  readonly kind: KnowledgeKind;
  readonly subject: string;
  readonly predicate: string;
  /** The value true at the query time, or absent when the claim is conflicted without a resolution (see `conflict`). */
  readonly current?: ClaimValue;
  /** Every value ever established by still-eligible evidence, oldest first (history; `current` is the one valid at `asOf`). */
  readonly history: readonly ClaimValue[];
  /** Inferences not (yet) corroborated by >= 2 independent sources: flagged, never presented as `current`. */
  readonly hypotheses: readonly ClaimValue[];
  readonly status: 'known' | 'conflicted' | 'unknown';
  readonly conflict?: string;
}

export interface ConflictItem {
  readonly type: 'conflict';
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly kind: KnowledgeKind;
  /** The `contradicts` edge: every competing claim is preserved with its evidence and timestamps. */
  readonly claims: readonly ClaimValue[];
  readonly state: 'open' | 'resolved';
  /** `human_review` until an explicit policy rule or human decision resolves it. Never an arbitrary pick. */
  readonly resolution:
    | { readonly by: 'none'; readonly route: 'human_review' }
    | { readonly by: 'policy'; readonly policy: string; readonly rule: string; readonly winner: Scalar }
    | { readonly by: 'human'; readonly decisionId: string; readonly winner: Scalar };
}

export interface DocumentItem {
  readonly type: 'document';
  /** Digest-derived; the source document is distinct from every fact extracted from it. */
  readonly id: string;
  readonly sourceId: string;
  readonly observedAt: string;
  readonly contentHash: string;
  readonly evidenceId: string;
}

export type KnowledgeItem = EntityItem | RelationshipItem | ClaimItem | ConflictItem | DocumentItem;
