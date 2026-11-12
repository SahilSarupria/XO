import type { AuthenticatedPrincipal } from '@xo/permissions';
import type { KnowledgeResponse, QueryData, ReviewQueueData, ReviewRequest, StructuredQuery } from '@xo/environment-intelligence';
import type { ConnectResult } from './contract.js';

/**
 * C7.3: read-only knowledge access. These are the C6 SDK's own types and results, passed through unchanged: Connect does not
 * reimplement retrieval, ranking, provenance, visibility or authorization. C6 decides what the principal may see
 * (`data.read` on the knowledge resource plus per-item visibility) and says so in every response (`access`).
 */
export type KnowledgeSearchResponse = KnowledgeResponse<QueryData>;
export type KnowledgeReviewResponse = KnowledgeResponse<ReviewQueueData>;

export interface KnowledgeSearchRequest {
  /** Keyword text (C6 does not interpret questions) or a structured selector. */
  readonly query: string | StructuredQuery;
  readonly limit?: number;
  readonly asOf?: string;
}

/**
 * What Connect needs from C6, as one port. Implemented over `createKnowledgeSdk` by the EI adapter; absent when the host has no
 * durable state (knowledge cannot exist without retained evidence).
 */
export interface KnowledgePort {
  search(principal: AuthenticatedPrincipal, request: KnowledgeSearchRequest): Promise<ConnectResult<KnowledgeSearchResponse>>;
  reviewQueue(principal: AuthenticatedPrincipal, asOf?: string): Promise<ConnectResult<KnowledgeReviewResponse>>;
  /**
   * Records a human review decision through C6 (human principals with review authority who can see what they decide about; audited).
   * The decision is made durable before it is reported: if it cannot be saved it is NOT applied.
   */
  submitReview(
    principal: AuthenticatedPrincipal,
    decision: ReviewRequest,
  ): Promise<ConnectResult<{ readonly decisionId: string; readonly operationId: string }>>;
  /** Decisions made so far, without their subjects. Callers must hold the review capability. */
  decisionHistory(): readonly DecisionSummary[];
  /** How many assertions the in-memory model currently holds (0 after a restart until a source is read again). Counts only. */
  assertionCount(): number;
}

export interface DecisionSummary {
  readonly id: string;
  readonly kind: 'approve_merge' | 'block_merge' | 'resolve_conflict';
  readonly principalId: string;
  readonly decidedAt: string;
}
