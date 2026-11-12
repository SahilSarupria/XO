/**
 * Vocabulary of the XO Intelligence layer.
 *
 * The experience is a single loop — ASK -> DECIDE -> DO -> LEARN — and the user never picks a mode. The orchestrator
 * works out which part of the loop a message belongs to (`Route`) and handles it accordingly:
 *
 *   ASK     answer from the organization's own, authorized knowledge, with sources
 *   DECIDE  weigh options and risks, recommend, and say how sure it is
 *   DO      propose an action through XO's approved capabilities (never an unrestricted tool call)
 *   LEARN   record corrections, outcomes and feedback for authorized review
 *
 * `converse` is not part of the loop: greetings, thanks and "what can you do?". It touches no organizational data.
 */
export type Intent = 'ask' | 'decide' | 'do' | 'learn';
export type Route = Intent | 'converse';

/**
 * Who is asking. Opaque to the orchestrator: it is handed to every port so the port (C6, the capability runtime, the
 * learning queue) can enforce authorization. The orchestrator never decides what a principal may see.
 */
export interface Principal {
  readonly identityId: string;
  readonly workspaceId: string;
  readonly role: string;
}

export interface HistoryTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** Assistant turns: the id of the turn, so a later LEARN message can point at the answer it corrects. */
  readonly turnId?: string;
  /** Assistant turns: ids (as issued by the knowledge port) of the evidence that answer cited. */
  readonly citedEvidenceIds?: readonly string[];
}

/** One authorized piece of organizational knowledge, as returned by the knowledge port (C6). */
export interface Evidence {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly sourceType?: string;
  readonly uri?: string;
  readonly excerpt: string;
  /** ISO timestamp of when the underlying source was last changed — what lets the answer prefer the latest information. */
  readonly asOf?: string;
  /** Retrieval relevance, 0..1, if the port provides one. */
  readonly score?: number;
}

/** What the user sees as a footnote. `index` is the number used in the answer text, e.g. "[2]". */
export interface Citation {
  readonly index: number;
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly sourceType?: string;
  readonly uri?: string;
  readonly asOf?: string;
  readonly excerpt: string;
}

export type Confidence = 'high' | 'medium' | 'low' | 'none';

export type NoticeCode =
  | 'knowledge_unavailable'
  | 'no_sources_found'
  | 'ungrounded_answer'
  | 'contradiction_detected'
  | 'citations_removed'
  | 'recommendation_dropped'
  | 'action_unavailable'
  | 'action_needs_input'
  | 'learning_unavailable'
  | 'routing_low_confidence'
  | 'keyword_search_only'
  | 'sources_unsearched';

/** A machine-readable reason the answer is weaker or different than the user might assume. */
export interface Notice {
  readonly code: NoticeCode;
  readonly message: string;
}

export interface Contradiction {
  readonly summary: string;
  /** Citation indexes of the conflicting sources. */
  readonly citations: readonly number[];
}

export interface AskPayload {
  /** Do the retrieved sources actually answer the question? */
  readonly answerable: boolean;
  readonly confidence: Confidence;
  readonly confidenceReason: string;
  readonly contradictions: readonly Contradiction[];
  /** What the sources do not say that the question needed. */
  readonly gaps: readonly string[];
  readonly followUps: readonly string[];
}

export interface DecideOption {
  readonly title: string;
  readonly description: string;
  readonly pros: readonly string[];
  readonly cons: readonly string[];
  readonly consequences: readonly string[];
  readonly dependencies: readonly string[];
  readonly citations: readonly number[];
}

export interface DecidePayload {
  /** Always true: DECIDE informs a human decision, it never takes one. */
  readonly advisory: true;
  readonly summary: string;
  readonly problems: readonly { readonly description: string; readonly citations: readonly number[] }[];
  readonly options: readonly DecideOption[];
  readonly recommendation?: { readonly optionTitle: string; readonly rationale: string };
  readonly risks: readonly { readonly description: string; readonly severity: 'low' | 'medium' | 'high' }[];
  readonly assumptions: readonly string[];
  readonly confidence: Confidence;
  readonly confidenceReason: string;
  readonly contradictions: readonly Contradiction[];
  readonly gaps: readonly string[];
}

export type InputValue = string | number | boolean;

/**
 * DO output. A proposal is NOT an execution: the orchestrator has no way to run anything. `requiresApproval` is
 * always true in this version because XO's approval and authorization path for chat-initiated execution is the
 * experience layer's job (see docs/intelligence/CUSTOMER_CHAT.md, "DO").
 */
export interface ActionProposal {
  readonly capabilityId: string;
  readonly capabilityName: string;
  readonly inputs: Readonly<Record<string, InputValue>>;
  readonly rationale: string;
  readonly requiresApproval: true;
  readonly status: 'proposed';
}

export type LearningKind = 'correction' | 'outcome' | 'feedback';

export interface LearningOutcome {
  readonly kind: LearningKind;
  readonly recorded: boolean;
  readonly eventId?: string;
  /** True when the record waits for an authorized human before it can influence any answer. */
  readonly reviewRequired: boolean;
}

export interface ModelCallRecord {
  readonly task: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  /** True if a fallback provider answered. */
  readonly fellBack: boolean;
}

export interface TurnResult {
  /** `clarify` means the orchestrator needs more from the user before it can act; nothing was retrieved or run. */
  readonly route: Route | 'clarify';
  readonly routing: { readonly confidence: number; readonly reasoning: string; readonly standaloneQuery: string };
  /** Display text, self-sufficient for a simple client. Citation markers are "[n]" and match `citations[].index`. */
  readonly text: string;
  readonly confidence: Confidence;
  /** True only when the answer is backed by at least one verified citation. */
  readonly grounded: boolean;
  readonly citations: readonly Citation[];
  readonly clarifyingQuestion?: string;
  readonly ask?: AskPayload;
  readonly decide?: DecidePayload;
  readonly proposal?: ActionProposal;
  readonly learning?: LearningOutcome;
  readonly notices: readonly Notice[];
  /** How many authorized evidence items were put in front of the model (0 when none or not applicable). */
  readonly evidenceConsidered: number;
  readonly usage: { readonly calls: readonly ModelCallRecord[]; readonly totalCostUsd: number };
}

export interface TurnInput {
  readonly principal: Principal;
  readonly message: string;
  readonly history?: readonly HistoryTurn[];
  /** The id this turn will be stored under; recorded on LEARN events about it. */
  readonly turnId?: string;
  /** Restrict knowledge retrieval to these source names (forwarded to the knowledge port as a hint). */
  readonly scope?: readonly string[];
  /** Ordered model candidates (primary first). Omit to use the ConversationLayer's own policy. */
  readonly modelCandidates?: readonly { readonly providerId: string; readonly model: string }[];
  readonly traceId?: string;
}
