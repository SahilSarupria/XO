import type { Evidence, InputValue, LearningKind, Principal } from './types.js';

/**
 * The three boundaries the orchestrator depends on. Everything an organization-specific system provides — knowledge
 * retrieval, executable capabilities, a place for feedback to land — enters through one of these, so the orchestrator
 * (and the AI provider behind it) never gains access to anything a port did not hand it.
 */

// ---------------------------------------------------------------------------------------------------------- ASK / DECIDE

export interface KnowledgeQuery {
  readonly principal: Principal;
  /** A self-contained question (follow-ups already resolved against the conversation). */
  readonly query: string;
  readonly limit: number;
  /** Optional hint: restrict retrieval to these source names (e.g. XOs the user attached with @name). */
  readonly scope?: readonly string[];
}

/**
 * `unavailable` reasons: `not_configured` (no knowledge system for this workspace), `error` (it failed or timed out —
 * nothing partial was used), `denied` (the knowledge system refused this caller for the whole operation; it is NOT used
 * to say that specific restricted material exists, which a knowledge system must never reveal).
 */
export type KnowledgeResult =
  | {
      readonly status: 'ok';
      readonly evidence: readonly Evidence[];
      /**
       * How the evidence was found. A `lexical` source matches words, not meaning, so related material that uses
       * different words can be missed; the orchestrator tells the user so. Omit only if genuinely unknown.
       */
      readonly method?: 'lexical' | 'semantic' | 'hybrid';
      /** Sources that exist for this principal but could not be searched right now (so the result may be incomplete). */
      readonly unsearchedSources?: readonly string[];
    }
  | { readonly status: 'unavailable'; readonly reason: 'not_configured' | 'error' | 'denied' };

/**
 * The C6 Knowledge SDK boundary.
 *
 * Contract: `retrieve` MUST return only evidence the principal is authorized to see — authorization is enforced by the
 * knowledge system, never by the model and never by the orchestrator. Evidence MUST carry a stable `id` and the
 * source's last-modified time (`asOf`) where known, so answers can cite and prefer the latest information.
 * Implementations SHOULD NOT throw for "nothing found" (return an empty list); a throw is treated as `unavailable`.
 */
export interface KnowledgePort {
  retrieve(query: KnowledgeQuery): Promise<KnowledgeResult>;
  /**
   * OPTIONAL. What this knowledge system holds for the principal, in human terms, so XO can answer "what do you have
   * access to?" truthfully instead of searching for it. Must list only what the principal may see. A system that cannot
   * enumerate its sources omits this, and XO then says it cannot list them rather than guessing.
   */
  describe?(principal: Principal): Promise<KnowledgeCatalog>;
}

export interface KnowledgeCatalog {
  readonly sources: readonly { readonly name: string; readonly kind: string; readonly detail?: string }[];
  /** How it searches, in plain words (e.g. "keyword matching"). */
  readonly searchMethod?: string;
}

/** The default until a knowledge system is connected: honest about it, never a guess. */
export class UnconfiguredKnowledgePort implements KnowledgePort {
  async retrieve(): Promise<KnowledgeResult> {
    return { status: 'unavailable', reason: 'not_configured' };
  }
}

// ---------------------------------------------------------------------------------------------------------------- DO

export interface CapabilityInputSpec {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean';
  readonly required: boolean;
  readonly description?: string;
}

export interface CapabilityDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputs: readonly CapabilityInputSpec[];
}

/**
 * The XO Runtime capability boundary. `listAuthorized` MUST return only capabilities this principal may invoke. There
 * is deliberately no `execute` here: the orchestrator proposes, it does not run. Execution belongs to the approval
 * flow behind the experience layer, which already enforces capability-level authorization.
 */
export interface CapabilityPort {
  listAuthorized(principal: Principal): Promise<readonly CapabilityDescriptor[]>;
}

// ------------------------------------------------------------------------------------------------------------- LEARN

export interface LearningEvent {
  readonly principal: Principal;
  readonly kind: LearningKind;
  /** What the user said, in their words (a correction, an outcome report, or feedback). */
  readonly statement: string;
  /** The assistant turn this is about, if it is about one. */
  readonly aboutTurnId?: string;
  /** Evidence ids that turn cited — so a reviewer sees what the correction contradicts. */
  readonly aboutEvidenceIds: readonly string[];
}

export interface LearningRecord {
  readonly eventId: string;
  /** True when the event is held for an authorized human before it can affect any answer. */
  readonly reviewRequired: boolean;
}

/**
 * Where corrections, outcomes and feedback land. Implementations MUST treat a user's statement as a claim awaiting
 * review, not as established knowledge: LEARN never edits organizational knowledge directly.
 */
export interface LearningPort {
  record(event: LearningEvent): Promise<LearningRecord>;
}

export type { InputValue };
