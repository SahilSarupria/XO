import { type Result } from '@xo/types';
import { AiError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import type { Tracer, Meter } from '@xo/observability';
import { type CircuitBreakerOptions } from './circuit-breaker.js';
import { type TokenBucketOptions } from './rate-limiter.js';
import { type RetryPolicyOptions } from './retry.js';
import { type CapabilityCache } from './cache.js';
import { type PricingTable } from './cost.js';
import { type ModelSelectionPolicy } from './model-selection.js';
import { type PromptRegistry } from './prompt/index.js';
import type { CapabilityRequest, CapabilityResponse } from './capability-types.js';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderId } from './provider-types.js';
import type { EntityExtractionInput, EntityExtractionOutput } from './capabilities/entities.js';
import type { KnowledgeExtractionInput, KnowledgeExtractionOutput } from './capabilities/knowledge.js';
import type { ReasoningExtractionInput, ReasoningExtractionOutput } from './capabilities/reasoning.js';
import type { CapabilityExtractionInput, CapabilityExtractionOutput } from './capabilities/capabilities.js';
import type { DecisionGraphExtractionInput, DecisionGraphExtractionOutput } from './capabilities/decisions.js';
import type { ConstraintExtractionInput, ConstraintExtractionOutput } from './capabilities/constraints.js';
export interface AiCapabilityLayerOptions {
    readonly providers: readonly ModelProvider[];
    readonly policy: ModelSelectionPolicy;
    readonly promptRegistry?: PromptRegistry;
    readonly cache?: CapabilityCache;
    readonly pricingTable?: PricingTable;
    readonly logger?: Logger;
    readonly tracer?: Tracer;
    readonly meter?: Meter;
    readonly retryOptions?: Partial<Omit<RetryPolicyOptions, 'isRetryable'>>;
    readonly circuitBreakerOptions?: Partial<CircuitBreakerOptions>;
    readonly rateLimiterOptions?: Partial<TokenBucketOptions>;
    /** Per-provider overrides — different vendors have different quotas; falls back to `rateLimiterOptions` (then the built-in default) for any provider not listed here. */
    readonly rateLimiterOptionsByProvider?: Partial<Record<ProviderId, Partial<TokenBucketOptions>>>;
}
/**
 * The AI Capability Layer — the sole interface between callers (the
 * compiler's Stage 4-9 extractors, or anything else) and every AI
 * provider. A caller only ever sees `extractEntities`/`extractKnowledge`/
 * etc.; everything provider-specific (which vendor, which model, retry/
 * circuit-breaking/rate-limiting per vendor, cost accounting, caching) is
 * internal routing this class owns.
 */
export declare class AiCapabilityLayer {
    private readonly options;
    private readonly providersById;
    private readonly descriptorsById;
    private readonly circuitBreakers;
    private readonly rateLimiters;
    private readonly promptRegistry;
    private readonly cache;
    private readonly costAccountant;
    private readonly logger;
    private readonly tracer;
    private readonly meter;
    private readonly retryOptions;
    private readonly circuitBreakerOptions;
    private readonly rateLimiterOptions;
    constructor(options: AiCapabilityLayerOptions);
    /** Real capability discovery: what's actually registered and what each can do — a caller can use this to decide, e.g., whether to even attempt a capability requiring vision. */
    describeProviders(): readonly ProviderCapabilityDescriptor[];
    totalCostUsd(): number;
    extractEntities(request: CapabilityRequest<EntityExtractionInput>): Promise<Result<CapabilityResponse<EntityExtractionOutput>, AiError>>;
    extractKnowledge(request: CapabilityRequest<KnowledgeExtractionInput>): Promise<Result<CapabilityResponse<KnowledgeExtractionOutput>, AiError>>;
    extractReasoning(request: CapabilityRequest<ReasoningExtractionInput>): Promise<Result<CapabilityResponse<ReasoningExtractionOutput>, AiError>>;
    extractCapabilities(request: CapabilityRequest<CapabilityExtractionInput>): Promise<Result<CapabilityResponse<CapabilityExtractionOutput>, AiError>>;
    extractDecisionGraph(request: CapabilityRequest<DecisionGraphExtractionInput>): Promise<Result<CapabilityResponse<DecisionGraphExtractionOutput>, AiError>>;
    extractConstraints(request: CapabilityRequest<ConstraintExtractionInput>): Promise<Result<CapabilityResponse<ConstraintExtractionOutput>, AiError>>;
    private getOrCreateCircuitBreaker;
    private getOrCreateRateLimiter;
    private callCapability;
}
//# sourceMappingURL=router.d.ts.map