/**
 * BKB core primitives (spec §4.6, ADR 0029 decisions 4–6). Domain-agnostic: every type is a namespaced type id
 * (`<namespace>:<name>`), never an industry enum. The core knows how to store, govern, version and retrieve typed records;
 * what a `logistics:Shipment` or a `legal:Clause` MEANS comes from a Domain Knowledge Pack, and a record whose namespace no
 * installed pack defines is still stored, governed and retrievable — it is only marked as not semantically interpreted.
 *
 * Three independent dimensions on every claim, never collapsed into one score:
 *   - `confidence`  how sure the extraction was (a model or rule's own estimate);
 *   - `authority`   who stands behind it (the source document, a reviewer, an authoritative register);
 *   - `lifecycle`   where it is in governance (proposed → active → superseded / expired / rejected).
 * A high-confidence extraction is not authoritative, and an active claim is not fit for every purpose.
 */
import type { Digest, JsonValue } from './canonical.js';

/** `<namespace>:<name>`; the namespace `xo` is the core vocabulary (generic: concept, rule, capability, relation kinds). */
export type TypeId = string;

export const TYPE_ID = /^[a-z][a-z0-9-]*:[A-Za-z][A-Za-z0-9_.-]*$/;

export function namespaceOf(type: TypeId): string {
  return type.slice(0, type.indexOf(':'));
}

/** Where a record's evidence is: a source version and a precise locator inside it. */
export interface EvidenceRef {
  /** SHA-256 (hex) of the source bytes the evidence is in. */
  readonly sourceDigestSha256: string;
  readonly sourceName: string;
  readonly locator: {
    readonly pages?: readonly number[];
    readonly section?: readonly string[];
    readonly charRange?: readonly [number, number];
    readonly sheet?: string;
    readonly row?: number;
    readonly cell?: string;
    readonly messagePart?: string;
    /** The XOIR node the evidence came through (cross-reference to the compilation). */
    readonly xoirNodeId?: string;
    /**
     * UW-11b (ADR 0050 part 2): the evidence is something that happened in a run. `sourceDigestSha256` then holds the hex part of the
     * run manifest's stored digest and `sourceName` is `run <runId>`. The evidence resolves while the manifest is intact.
     */
    readonly run?: { readonly runId: string; readonly step?: string; readonly item?: number };
  };
  /** A short quote of the evidence, when one was recorded. */
  readonly quote?: string;
  /**
   * UW-4 (ADR 0012 decision 2): `sha256:` over the NORMALISED quoted words (see `normaliseQuote`). The words themselves are the
   * record's own text (a claim's `text`, an entity's name) or `quote`; the hash lets the evidence resolver prove they are found
   * in the stored source without copying customer text into the evidence.
   */
  readonly quoteHash?: string;
  /** When the source was read (EI evidence carries it; compiled evidence uses the compilation time). */
  readonly observedAt?: string;
  readonly method: { readonly kind: Derivation; readonly name: string; readonly version: string };
}

export type Derivation = 'source' | 'model' | 'human' | 'system';

/**
 * UW-4 (ADR 0012 decision 1): how the claim is known, apart from who stands behind it (`authority`) and how it was produced
 * (`derivation`): `observed` in a source as written, `stated` by a person, `inferred` from other facts. An inferred claim is
 * corroborated only with at least two independent evidence entries (decision 7).
 */
export type ClaimOrigin = 'observed' | 'stated' | 'inferred';

export type Lifecycle = 'proposed' | 'needs_review' | 'active' | 'rejected' | 'superseded' | 'expired';

export interface Authority {
  readonly level: 'source' | 'reviewed' | 'authoritative';
  /** Why: "stated in <source>", "approved in change set <id> by <actor>", "register <name>". */
  readonly basis: string;
}

export interface ValidityInterval {
  /** ISO dates; absent bounds are open. */
  readonly from?: string;
  readonly to?: string;
}

interface RecordBase {
  /** Content-derived: the same content in the same tenant is the same record (idempotent ingestion). */
  readonly id: string;
  readonly tenantId: string;
  readonly type: TypeId;
  readonly evidence: readonly EvidenceRef[];
  readonly derivation: Derivation;
  readonly confidence: number;
  /** When the record was first written (audit time), apart from validity (effective time). */
  readonly recordedAt: string;
}

export interface EntityRecord extends RecordBase {
  readonly kind: 'entity';
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  /** Strong identifiers (`{scheme, value}`), the only basis for automatic linking. */
  readonly identifiers: readonly { readonly scheme: string; readonly value: string }[];
  readonly attributes: { readonly [k: string]: JsonValue };
}

export interface ClaimRecord extends RecordBase {
  readonly kind: 'claim';
  /** The entity the claim is about, or a literal subject when no entity is resolved. */
  readonly subject: { readonly entityId: string } | { readonly literal: string };
  readonly predicate: TypeId;
  readonly object: { readonly entityId: string } | { readonly value: JsonValue };
  readonly polarity: 'positive' | 'negative';
  readonly modality?: 'obligation' | 'prohibition' | 'permission' | 'advisory' | 'fact';
  readonly scope?: string;
  readonly validity?: ValidityInterval;
  readonly authority: Authority;
  /** The claim's text as a person would read it (retrieval, review). */
  readonly text: string;
  /** UW-4: how the claim is known. Absent on records written before UW-4 (read as `observed` for source-derived claims). */
  readonly origin?: ClaimOrigin;
}

export interface RelationshipRecord extends RecordBase {
  readonly kind: 'relationship';
  readonly from: string;
  readonly to: string;
  readonly directed: boolean;
  readonly validity?: ValidityInterval;
}

export type KnowledgeRecord = EntityRecord | ClaimRecord | RelationshipRecord;

/** A record's place in one knowledge state: which content (digest) and which lifecycle stage. */
export interface StateEntry {
  readonly id: string;
  readonly kind: KnowledgeRecord['kind'];
  readonly recordDigest: Digest;
  readonly lifecycle: Lifecycle;
  /** For an entity merged into another: the surviving entity (old references stay resolvable). */
  readonly mergedInto?: string;
  /** Records that could not be interpreted because no installed pack defines their namespace. */
  readonly interpretation?: 'unsupported';
}

export interface Conflict {
  readonly id: string;
  readonly claims: readonly [string, string];
  readonly reason: string;
  readonly status: 'unresolved' | 'resolved-by-precedence' | 'resolved-by-ruling';
  readonly prevailing?: string;
  readonly resolution?: { readonly by: string; readonly at: string; readonly rationale: string };
}

export interface PackBinding {
  readonly packId: string;
  readonly namespace: string;
  readonly version: string;
  readonly digest: Digest;
}

/** A reproducible snapshot: exactly which record versions are in which lifecycle stage, under which packs and policy. */
export interface KnowledgeState {
  readonly schema: 'xo.knowledge-state.v1';
  readonly stateId: string;
  readonly tenantId: string;
  readonly parentStateId: string | null;
  readonly entries: readonly StateEntry[];
  readonly conflicts: readonly Conflict[];
  readonly packBindings: readonly PackBinding[];
  readonly precedencePolicy: PrecedencePolicy;
  /** The change set this state was made by (null for the empty root). */
  readonly changeSetId: string | null;
  readonly createdAt: string;
  /** Over everything above except `stateId`, `createdAt` and itself. */
  readonly digest: Digest;
}

/** Declared authority order used to resolve conflicts; without it conflicts stay unresolved until a person rules. */
export interface PrecedencePolicy {
  readonly version: string;
  /** Higher index wins: an authority level, or a source name. Empty: never resolve automatically. */
  readonly order: readonly string[];
}

export type ChangeOperation =
  | { readonly op: 'add'; readonly record: KnowledgeRecord }
  | { readonly op: 'supersede'; readonly recordId: string; readonly by: KnowledgeRecord }
  | { readonly op: 'retire'; readonly recordId: string; readonly lifecycle: 'expired' | 'rejected'; readonly reason: string }
  | { readonly op: 'merge-entities'; readonly from: readonly string[]; readonly into: string; readonly reason: string }
  | { readonly op: 'split-entity'; readonly entityId: string; readonly into: readonly EntityRecord[]; readonly reason: string }
  | { readonly op: 'resolve-conflict'; readonly conflictId: string; readonly prevailing: string; readonly rationale: string }
  /** UW-11a (ADR 0050): back to the lifecycle a rollback target had. Valid only in a change set of origin `rollback`. */
  | { readonly op: 'restore'; readonly recordId: string; readonly lifecycle: 'active' | 'needs_review'; readonly reason: string };

export interface ValidationFinding {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
  readonly ref?: string;
}

export interface ReconciliationReport {
  readonly accepted: readonly string[];
  readonly unchanged: readonly string[];
  readonly updated: readonly string[];
  readonly conflicting: readonly string[];
  readonly unresolved: readonly { readonly ref: string; readonly reason: string }[];
  readonly rejected: readonly { readonly ref: string; readonly reason: string }[];
  readonly unsupported: readonly string[];
}

export interface ChangeSet {
  readonly schema: 'xo.knowledge-change-set.v1';
  readonly changeSetId: string;
  readonly tenantId: string;
  /** The state the change set was computed against; approval refuses if the tenant's head has moved since. */
  readonly baseStateId: string | null;
  readonly operations: readonly ChangeOperation[];
  readonly origin: {
    /** `model-derivation` (UW-4c): claims a model read from a source's text, checked against it, for review. */
    readonly kind: 'xoir-reconciliation' | 'manual' | 'import' | 'model-derivation' | 'rollback' | 'run-outcome';
    /** What it came from: a compilation id, an import batch, a ticket. Display and audit only. */
    readonly ref?: string;
    readonly sourceSetId?: string;
    readonly compilationArtifactDigest?: string;
    readonly xoirGraphHash?: string;
  };
  readonly report?: ReconciliationReport;
  readonly findings: readonly ValidationFinding[];
  readonly status: 'proposed' | 'approved' | 'rejected';
  readonly proposedBy: { readonly id: string; readonly kind: string };
  readonly proposedAt: string;
  readonly decision?: {
    readonly by: { readonly id: string; readonly kind: string };
    readonly at: string;
    readonly reason: string;
    readonly resultingStateId?: string;
  };
  /** Over base, operations and origin: what is being proposed. */
  readonly digest: Digest;
}

/** One entry of the append-only, hash-chained event log. */
export interface KnowledgeEvent {
  readonly seq: number;
  readonly tenantId: string;
  readonly type: 'change-set.proposed' | 'change-set.approved' | 'change-set.rejected' | 'state.created' | 'pack.installed';
  readonly at: string;
  readonly actor: { readonly id: string; readonly kind: string };
  readonly subjectId: string;
  readonly subjectDigest: Digest;
  readonly prevDigest: Digest | null;
  readonly digest: Digest;
}

/** UW-11a: what approving a change set would do to the state, by record id. */
export interface StateDiff {
  readonly added: readonly string[];
  readonly superseded: readonly string[];
  readonly retired: readonly string[];
  readonly restored: readonly string[];
  readonly merged: readonly string[];
  readonly conflictsOpened: readonly string[];
  readonly conflictsResolved: readonly string[];
}

/** UW-11a: the state approval would create, computed and not stored. */
export interface ChangeSetPreview {
  readonly changeSetId: string;
  readonly baseStateId: string | null;
  readonly headStateId: string | null;
  /** The head moved since the change set was proposed: it must be proposed again. */
  readonly stale: boolean;
  readonly nextState: KnowledgeState;
  readonly contentRoot: string;
  readonly diff: StateDiff;
  readonly findings: readonly ValidationFinding[];
}
