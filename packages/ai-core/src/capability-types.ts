import type { ProviderId, TokenUsage } from './provider-types.js';

/**
 * The public capability surface — `AiCapabilityLayer` (router.ts) exposes
 * exactly these, and a caller (the compiler's Stage 4-9 extractors) never
 * sees a `ProviderRequest`/`ModelProvider` at all. Each capability has its
 * own typed input/output shape (see capabilities/*.ts) rather than a
 * shared "give me some JSON back" — that typing is what "expose semantic
 * capabilities, not provider-specific APIs" means in practice.
 */
export type CapabilityId =
  'extractEntities' | 'extractKnowledge' | 'extractReasoning' | 'extractCapabilities' | 'extractDecisionGraph' | 'extractConstraints';

/**
 * Tasks served by `ConversationLayer` (conversation.ts) — the conversational counterpart to the six document
 * extraction capabilities above. They exist so a deployment can route, say, cheap intent routing to a small model and
 * grounded answering to a larger one through the same `ModelSelectionPolicy`, without any caller naming a vendor.
 */
export type ConversationTaskId =
  'conversation.route' | 'conversation.answer' | 'conversation.decide' | 'conversation.propose' | 'conversation.learn';

/** Anything `ModelSelectionPolicy` can route: an extraction capability or a conversation task. */
export type SelectableTaskId = CapabilityId | ConversationTaskId;

export interface SourceExcerpt {
  readonly text: string;
  readonly documentPath: string;
  readonly page?: number;
  readonly section?: string;
}

/** Every capability request carries the same envelope (source text + a caller-supplied trace id for telemetry/cache correlation) around its capability-specific typed input. */
export interface CapabilityRequest<TInput> {
  readonly input: TInput;
  readonly excerpt: SourceExcerpt;
  readonly traceId: string;
  /** Cancels the compile step: checked before every attempt and forwarded to the provider. Aborting stops local waiting only; remote work may still be billed. */
  readonly signal?: AbortSignal;
}

export interface CapabilityResponseMeta {
  readonly capability: CapabilityId;
  readonly providerUsed: ProviderId;
  readonly modelUsed: string;
  readonly promptVersion: string;
  readonly usage: TokenUsage;
  /** `false` when the provider did not report token usage (then `usage` is a `{0,0}` placeholder and `costUsd` is NOT a measurement). Absent = known. */
  readonly usageKnown?: boolean;
  readonly costUsd: number;
  readonly cacheHit: boolean;
  readonly latencyMs: number;
  readonly attempts: number;
  /** Where this output came from. Always present on responses from `AiCapabilityLayer`. */
  readonly provenance?: CapabilityProvenance;
}

/**
 * Honest origin record. `source: 'cache'` means NO provider call happened for this request: the output was generated earlier
 * (see `generation`) and replayed. On such a hit the top-level `usage`/`costUsd`/`attempts` are zero (nothing was spent now);
 * the original generation's figures are preserved under `generation` for audit, never presented as current spend.
 */
export interface CapabilityProvenance {
  readonly origin: 'llm';
  readonly source: 'generated' | 'cache';
  readonly cacheKey: string;
  readonly generation: {
    readonly generatedAtMs: number;
    readonly traceId: string;
    readonly providerUsed: ProviderId;
    readonly modelUsed: string;
    readonly promptVersion: string;
    readonly schemaHash: string;
    readonly usage: TokenUsage;
    readonly usageKnown?: boolean;
    readonly costUsd: number;
  };
}

export interface CapabilityResponse<TOutput> {
  readonly output: TOutput;
  readonly meta: CapabilityResponseMeta;
}
