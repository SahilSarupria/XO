import type { AuthenticatedPrincipal } from '@xo/permissions';
import { DiscoveryErrorCode, type DiscoveryError } from '../errors.js';
import type {
  ClaimOrigin,
  EntityKind,
  ItemConfidence,
  KnowledgeItem,
  KnowledgeKind,
  RelationshipType,
  Validity,
} from '../knowledge/types.js';
import type { KnowledgeQuery } from '../knowledge/service.js';

/**
 * C6 - Knowledge Agent SDK: the stable, developer-facing contract over the C5 intelligence model.
 *
 * What the SDK IS: a typed, read-mostly facade. Every operation runs as ONE authenticated principal, goes through the C5 service (so the
 * ledger-eligibility check, the per-resource access decision and the audit record all happen on every call), and returns STRUCTURED,
 * evidence-referenced statements, never bare text.
 *
 * What it is NOT: an agent, a model, a workflow executor, or permission to act. It calls no model and no network, and nothing it returns
 * (confidence included) authorizes any action. It adds no new way to read evidence: it cannot see anything C5 would not show the caller.
 *
 * Versioning: `SDK_CONTRACT_VERSION` changes only on a breaking change to the shapes below; additive fields do not bump it.
 */
export const SDK_CONTRACT_VERSION = '1' as const;

/** Stable, content-free error vocabulary. No internal detail, identifier, path or content ever appears in an SDK error. */
export type SdkErrorCode =
  | 'unauthenticated' // no genuine authenticated principal
  | 'denied' // the principal is not authorized for this operation
  | 'unavailable' // audit, state or authorization infrastructure is unavailable: the operation FAILED CLOSED (no partial data)
  | 'limit_exceeded' // a size / count / time / budget bound was hit
  | 'invalid_request' // malformed input
  | 'internal';

export interface SdkError {
  readonly code: SdkErrorCode;
  readonly message: string;
  /** True when retrying later can succeed (unavailable). Never true for denied / invalid. */
  readonly retryable: boolean;
}

export type SdkResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SdkError };

export function toSdkError(e: DiscoveryError): SdkError {
  switch (e.code) {
    case DiscoveryErrorCode.UNAUTHENTICATED:
      return { code: 'unauthenticated', message: 'an authenticated principal is required', retryable: false };
    case DiscoveryErrorCode.AUTHORIZATION_DENIED:
    case DiscoveryErrorCode.AUTHORIZATION_REQUIRED:
    case DiscoveryErrorCode.SCOPE_VIOLATION:
      return { code: 'denied', message: 'the principal is not authorized for this operation', retryable: false };
    case DiscoveryErrorCode.AUDIT_UNAVAILABLE:
    case DiscoveryErrorCode.STATE_UNAVAILABLE:
      return { code: 'unavailable', message: 'a required platform service is unavailable; nothing was returned', retryable: true };
    case DiscoveryErrorCode.LIMIT_EXCEEDED:
      return { code: 'limit_exceeded', message: 'a size, time or count limit was exceeded', retryable: false };
    case DiscoveryErrorCode.MALFORMED_INPUT:
      return { code: 'invalid_request', message: 'the request is not acceptable', retryable: false };
    default:
      return { code: 'internal', message: 'the operation could not be completed', retryable: false };
  }
}

/** Every request names the principal it runs as. Only a genuine, framework-established principal works: a plain object is refused. */
export interface PrincipalRequest {
  readonly principal: AuthenticatedPrincipal;
}

export interface EvidenceReference {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly contentHash: string;
  readonly observedAt: string;
  /** `journal_checkpoint`: batch digest matched the durable checkpoint when derived. `journal_index`: anchored by the durable resource index. */
  readonly anchoring: 'journal_checkpoint' | 'journal_index';
}

export type StatementStatus = 'known' | 'conflicted' | 'hypothesis' | 'unknown';

/**
 * One provenance-aware statement. `text` is a deterministic rendering for display; the STRUCTURE (status, confidence, evidence) is the
 * contract. A statement is never returned without its evidence, and uncertainty is a first-class field, not prose.
 */
export interface Statement {
  /** Stable reference (the underlying C5 item id; for a hypothesis, the claim id + `#h`). */
  readonly ref: string;
  readonly kind: 'entity' | 'claim' | 'relationship' | 'conflict';
  readonly text: string;
  readonly status: StatementStatus;
  readonly origin?: ClaimOrigin;
  readonly confidence?: ItemConfidence;
  readonly validity?: Validity;
  readonly evidence: readonly EvidenceReference[];
  /** True when a human must decide (open conflict) or confirm (uncorroborated inference / weak merge candidate). */
  readonly reviewRequired: boolean;
  /** The underlying C5 item, for callers that want the full structure. */
  readonly item: KnowledgeItem;
}

export interface UncertaintySummary {
  readonly conflicted: number;
  readonly hypotheses: number;
  readonly unknown: number;
  readonly reviewRequired: number;
  /** Statements resting on a single independent source. */
  readonly singleSource: number;
}

export interface AccessNotice {
  readonly principalId: string;
  /**
   * Always `visible_scope_only`: results describe only what THIS principal may see. The SDK never reports what was withheld
   * (not even a count), so the absence of a statement is not proof that nothing is known.
   */
  readonly completeness: 'visible_scope_only';
}

export interface KnowledgeResponse<T> {
  readonly contractVersion: typeof SDK_CONTRACT_VERSION;
  readonly asOf: string;
  readonly data: T;
  readonly uncertainty: UncertaintySummary;
  readonly access: AccessNotice;
}

// ── C6.2 queries ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A structured selector (the C5 query shape without limits, which the SDK owns). */
export type StructuredQuery = Pick<KnowledgeQuery, 'select' | 'entity' | 'entityKind' | 'predicate' | 'claimKind' | 'relation'>;

export interface QueryRequest extends PrincipalRequest {
  /**
   * Free text is answered by DETERMINISTIC LEXICAL retrieval over what the principal can see (tokens of identifiers, predicates, values
   * and relation words). It is not semantic search and does not interpret questions: an unmatched question returns no statements.
   */
  readonly query: string | StructuredQuery;
  readonly asOf?: string;
  /** Default 20, at most 100. */
  readonly limit?: number;
}

export interface QueryData {
  readonly statements: readonly Statement[];
  readonly truncated: boolean;
  /** How the match was made, for transparency: the tokens that matched (text queries) or the selector (structured). */
  readonly matchedOn: readonly string[];
}

// ── C6.3 context ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ContextRequest extends PrincipalRequest {
  readonly query: string;
  readonly asOf?: string;
  /** Hard budget for the whole bundle (preamble included). Default 4000, minimum 300, maximum 32000. */
  readonly maxTokens?: number;
}

export interface ContextReference {
  /** The citation marker used in `text`, e.g. `R3`. */
  readonly marker: string;
  readonly statementRef: string;
  readonly status: StatementStatus;
  readonly evidence: readonly EvidenceReference[];
}

export interface ContextBundle {
  /** Ready to place in a prompt. Wraps untrusted data in an explicit, delimited section; see the preamble inside. */
  readonly text: string;
  readonly tokensEstimated: number;
  readonly maxTokens: number;
  /** The estimator is conservative and model-independent: ceil(characters / 3). Real tokenizers differ; the budget errs on the safe side. */
  readonly estimator: 'ceil(chars/3)';
  readonly references: readonly ContextReference[];
  /** Statements that matched but did not fit the budget (lowest priority dropped first; conflicts and unknowns are kept longest). */
  readonly omitted: number;
}

// ── C6.6 / C6.7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReviewItem {
  readonly kind: 'conflict' | 'unverified_inference' | 'merge_candidate';
  readonly ref: string;
  readonly summary: string;
  readonly route: 'human_review';
  readonly statement: Statement;
}

export interface ReviewQueueData {
  readonly items: readonly ReviewItem[];
  readonly truncated: boolean;
}

export type { EntityKind, KnowledgeKind, RelationshipType };
