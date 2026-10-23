import { err, ok, type Result } from '@xo/types';
import { AiError, ErrorCode, assertNotAuditData } from '@xo/errors';
import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import type { Tracer, Meter } from '@xo/observability';
import { noopTracer, noopMeter } from '@xo/observability';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
import { TokenBucketRateLimiter, type TokenBucketOptions } from './rate-limiter.js';
import { RetryPolicy, type RetryPolicyOptions } from './retry.js';
import { getProviderFailure } from './provider-errors.js';
import { CACHE_FORMAT_VERSION, computeCacheKey, computeSchemaHash, InMemoryCapabilityCache, type CapabilityCache } from './cache.js';
import { CostAccountant, DEFAULT_PRICING_TABLE, type PricingTable } from './cost.js';
import { selectCandidates, type ModelSelectionPolicy } from './model-selection.js';
import { createDefaultPromptRegistry, type PromptRegistry } from './prompt/index.js';
import { validateJsonSchema } from './json-schema.js';
import { CAPABILITY_OUTPUT_SCHEMAS } from './capability-schemas.js';
import type { CapabilityId, CapabilityRequest, CapabilityResponse } from './capability-types.js';
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

const DEFAULT_RETRY_OPTIONS: Omit<RetryPolicyOptions, 'isRetryable'> = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 2000,
  backoffMultiplier: 2,
};
const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = { failureThreshold: 5, cooldownMs: 30_000 };
const DEFAULT_RATE_LIMIT_OPTIONS: TokenBucketOptions = { capacity: 60, refillPerSecond: 1 };

/**
 * The AI Capability Layer — the sole interface between callers (the
 * compiler's Stage 4-9 extractors, or anything else) and every AI
 * provider. A caller only ever sees `extractEntities`/`extractKnowledge`/
 * etc.; everything provider-specific (which vendor, which model, retry/
 * circuit-breaking/rate-limiting per vendor, cost accounting, caching) is
 * internal routing this class owns.
 */
export class AiCapabilityLayer {
  private readonly providersById = new Map<ProviderId, ModelProvider>();
  private readonly descriptorsById = new Map<ProviderId, ProviderCapabilityDescriptor>();
  private readonly circuitBreakers = new Map<ProviderId, CircuitBreaker>();
  private readonly rateLimiters = new Map<ProviderId, TokenBucketRateLimiter>();
  private readonly promptRegistry: PromptRegistry;
  private readonly cache: CapabilityCache;
  private readonly costAccountant: CostAccountant;
  private readonly logger: Logger;
  private readonly tracer: Tracer;
  private readonly meter: Meter;
  private readonly retryOptions: Omit<RetryPolicyOptions, 'isRetryable'>;
  private readonly circuitBreakerOptions: CircuitBreakerOptions;
  private readonly rateLimiterOptions: TokenBucketOptions;

  constructor(private readonly options: AiCapabilityLayerOptions) {
    for (const provider of options.providers) {
      this.providersById.set(provider.id, provider);
      this.descriptorsById.set(provider.id, provider.describeCapabilities());
    }
    this.promptRegistry = options.promptRegistry ?? createDefaultPromptRegistry();
    this.cache = options.cache ?? new InMemoryCapabilityCache();
    this.costAccountant = new CostAccountant(options.pricingTable ?? DEFAULT_PRICING_TABLE);
    this.logger = options.logger ?? noopLogger;
    this.tracer = options.tracer ?? noopTracer;
    this.meter = options.meter ?? noopMeter;
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retryOptions };
    this.circuitBreakerOptions = { ...DEFAULT_CIRCUIT_OPTIONS, ...options.circuitBreakerOptions };
    this.rateLimiterOptions = { ...DEFAULT_RATE_LIMIT_OPTIONS, ...options.rateLimiterOptions };
  }

  /** Real capability discovery: what's actually registered and what each can do — a caller can use this to decide, e.g., whether to even attempt a capability requiring vision. */
  describeProviders(): readonly ProviderCapabilityDescriptor[] {
    return [...this.descriptorsById.values()];
  }

  totalCostUsd(): number {
    return this.costAccountant.totalCostUsd();
  }

  extractEntities(request: CapabilityRequest<EntityExtractionInput>): Promise<Result<CapabilityResponse<EntityExtractionOutput>, AiError>> {
    return this.callCapability('extractEntities', request);
  }
  extractKnowledge(
    request: CapabilityRequest<KnowledgeExtractionInput>,
  ): Promise<Result<CapabilityResponse<KnowledgeExtractionOutput>, AiError>> {
    return this.callCapability('extractKnowledge', request);
  }
  extractReasoning(
    request: CapabilityRequest<ReasoningExtractionInput>,
  ): Promise<Result<CapabilityResponse<ReasoningExtractionOutput>, AiError>> {
    return this.callCapability('extractReasoning', request);
  }
  extractCapabilities(
    request: CapabilityRequest<CapabilityExtractionInput>,
  ): Promise<Result<CapabilityResponse<CapabilityExtractionOutput>, AiError>> {
    return this.callCapability('extractCapabilities', request);
  }
  extractDecisionGraph(
    request: CapabilityRequest<DecisionGraphExtractionInput>,
  ): Promise<Result<CapabilityResponse<DecisionGraphExtractionOutput>, AiError>> {
    return this.callCapability('extractDecisionGraph', request);
  }
  extractConstraints(
    request: CapabilityRequest<ConstraintExtractionInput>,
  ): Promise<Result<CapabilityResponse<ConstraintExtractionOutput>, AiError>> {
    return this.callCapability('extractConstraints', request);
  }

  private getOrCreateCircuitBreaker(providerId: ProviderId): CircuitBreaker {
    let breaker = this.circuitBreakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker(this.circuitBreakerOptions);
      this.circuitBreakers.set(providerId, breaker);
    }
    return breaker;
  }

  private getOrCreateRateLimiter(providerId: ProviderId): TokenBucketRateLimiter {
    let limiter = this.rateLimiters.get(providerId);
    if (!limiter) {
      const perProviderOverride = this.options.rateLimiterOptionsByProvider?.[providerId];
      limiter = new TokenBucketRateLimiter({ ...this.rateLimiterOptions, ...perProviderOverride });
      this.rateLimiters.set(providerId, limiter);
    }
    return limiter;
  }

  private async callCapability<TInput, TOutput>(
    capability: CapabilityId,
    request: CapabilityRequest<TInput>,
  ): Promise<Result<CapabilityResponse<TOutput>, AiError>> {
    return this.tracer.withSpan(`ai_core.${capability}`, async (span) => {
      const startedAt = performance.now();
      span.setAttribute('capability', capability);
      span.setAttribute('trace_id', request.traceId);

      // P1.0 M4 model exclusion: restricted audit data is never sent to a model provider (input or excerpt).
      try {
        assertNotAuditData(request.input, 'an AI provider request');
        assertNotAuditData(request.excerpt, 'an AI provider request');
      } catch (error) {
        return err(error as AiError);
      }

      let template;
      try {
        template = this.promptRegistry.resolve<TInput>(capability);
      } catch (error) {
        return err(error as AiError);
      }

      const candidates = selectCandidates(this.options.policy, capability, new Set(this.providersById.keys()), this.descriptorsById, true);
      if (candidates.length === 0) {
        return err(new AiError(ErrorCode.AI_NO_ELIGIBLE_PROVIDER, `No eligible provider registered for capability "${capability}"`));
      }

      // Identity of everything that determines the answer: prompt version, input, the ordered model candidates that would serve
      // it, the output schema, and generation settings. Changing any of them yields a different key (never a stale hit).
      const schema = CAPABILITY_OUTPUT_SCHEMAS[capability];
      const schemaHash = computeSchemaHash(schema);
      const cacheKey = computeCacheKey({
        capability,
        promptVersion: template.version,
        input: request.input,
        excerptText: request.excerpt.text,
        modelIdentity: candidates.map((c) => `${c.providerId}/${c.model}`),
        schemaHash,
        generation: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        formatVersion: CACHE_FORMAT_VERSION,
      });
      const cached = await this.readCache<TOutput>(cacheKey, schema);
      if (cached) {
        this.logger.debug('ai_core cache hit', { capability, traceId: request.traceId });
        this.meter.createCounter('ai_core_cache_hits_total').add(1, { capability });
        return ok(replayedFromCache(cached, cacheKey, performance.now() - startedAt));
      }

      const messages = template.render(request.input, request.excerpt.text);
      let totalAttempts = 0;
      const failures: unknown[] = [];

      for (const candidate of candidates) {
        const provider = this.providersById.get(candidate.providerId);
        if (!provider) continue;

        const circuitBreaker = this.getOrCreateCircuitBreaker(candidate.providerId);
        const rateLimiter = this.getOrCreateRateLimiter(candidate.providerId);
        if (!rateLimiter.tryAcquire()) {
          this.logger.warn('ai_core rate limited, skipping provider', { provider: candidate.providerId, capability });
          failures.push(new AiError(ErrorCode.AI_RATE_LIMITED, `Provider "${candidate.providerId}" is rate limited`));
          continue;
        }

        const retryPolicy = new RetryPolicy({
          ...this.retryOptions,
          isRetryable: (error) => {
            if (error instanceof AiError && error.code === ErrorCode.AI_CIRCUIT_OPEN) return false;
            // Provider adapters that classify their failures already applied their own bounded transport retry
            // (honouring Retry-After); retrying again here would multiply attempts and risk retry storms. The one
            // exception is a malformed/schema-invalid body, where a fresh sample can legitimately succeed.
            // Auth, invalid-request, content-blocked, unsupported-model and quota failures are never retried.
            const failure = getProviderFailure(error);
            if (failure) return failure.category === 'malformed_response';
            return true;
          },
        });

        try {
          const outcome = await retryPolicy.execute(async (attempt) => {
            totalAttempts = attempt;
            return circuitBreaker.execute(async () => {
              const response = await provider.complete({
                model: candidate.model,
                requestId: request.traceId,
                messages,
                maxOutputTokens: MAX_OUTPUT_TOKENS,
                responseSchema: schema as unknown as Record<string, unknown>,
              });
              let parsed: unknown;
              try {
                parsed = JSON.parse(response.text);
              } catch (cause) {
                throw new AiError(ErrorCode.AI_SCHEMA_VALIDATION_FAILED, `Provider "${candidate.providerId}" did not return valid JSON`, {
                  cause,
                });
              }
              const issues = validateJsonSchema(schema, parsed);
              if (issues.length > 0) {
                throw new AiError(
                  ErrorCode.AI_SCHEMA_VALIDATION_FAILED,
                  `Provider "${candidate.providerId}" response failed schema validation: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
                );
              }
              return { response, output: parsed as TOutput };
            });
          });

          const costRecord = this.costAccountant.record(
            candidate.providerId,
            outcome.value.response.modelUsed,
            outcome.value.response.usage,
          );
          const result: CapabilityResponse<TOutput> = {
            output: outcome.value.output,
            meta: {
              capability,
              providerUsed: candidate.providerId,
              modelUsed: outcome.value.response.modelUsed,
              promptVersion: template.version,
              usage: outcome.value.response.usage,
              ...(outcome.value.response.usageKnown === false ? { usageKnown: false } : {}),
              costUsd: costRecord.costUsd,
              cacheHit: false,
              latencyMs: performance.now() - startedAt,
              attempts: outcome.attempts,
              provenance: {
                origin: 'llm',
                source: 'generated',
                cacheKey,
                generation: {
                  generatedAtMs: Date.now(),
                  traceId: request.traceId,
                  providerUsed: candidate.providerId,
                  modelUsed: outcome.value.response.modelUsed,
                  promptVersion: template.version,
                  schemaHash,
                  usage: outcome.value.response.usage,
                  ...(outcome.value.response.usageKnown === false ? { usageKnown: false } : {}),
                  costUsd: costRecord.costUsd,
                },
              },
            },
          };
          await this.writeCache(cacheKey, result);
          this.meter.createCounter('ai_core_requests_total').add(1, { capability, provider: candidate.providerId, status: 'success' });
          span.setStatus('ok');
          return ok(result);
        } catch (error) {
          this.logger.warn('ai_core provider attempt failed, trying next candidate', {
            provider: candidate.providerId,
            capability,
            error: error instanceof Error ? error.message : String(error),
          });
          this.meter.createCounter('ai_core_requests_total').add(1, { capability, provider: candidate.providerId, status: 'failure' });
          failures.push(error);
        }
      }

      span.setStatus('error', 'all providers failed');
      return err(
        new AiError(
          ErrorCode.AI_ALL_PROVIDERS_FAILED,
          `All ${candidates.length} candidate provider(s) failed for capability "${capability}" after ${totalAttempts} attempt(s) on the last one`,
          { context: { failureCount: failures.length } },
        ),
      );
    });
  }

  /** A cache must never break a request: backing-store failures are misses; hits are re-validated against the CURRENT schema. */
  private async readCache<TOutput>(
    key: string,
    schema: Parameters<typeof validateJsonSchema>[0],
  ): Promise<CapabilityResponse<TOutput> | undefined> {
    try {
      const entry = await this.cache.get<CapabilityResponse<TOutput>>(key);
      if (!entry) return undefined;
      const value = entry.value;
      if (
        !value ||
        typeof value !== 'object' ||
        !('output' in value) ||
        !('meta' in value) ||
        validateJsonSchema(schema, value.output).length > 0
      ) {
        this.logger.warn('ai_core cache entry failed revalidation; treating as miss');
        return undefined;
      }
      return value;
    } catch (error) {
      this.logger.warn('ai_core cache read failed; treating as miss', {
        error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      });
      return undefined;
    }
  }

  private async writeCache<TOutput>(key: string, value: CapabilityResponse<TOutput>): Promise<void> {
    try {
      await this.cache.set(key, value);
    } catch (error) {
      this.logger.warn('ai_core cache write failed; continuing without caching', {
        error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      });
    }
  }
}

const MAX_OUTPUT_TOKENS = 4096;

/** A hit spends nothing now: zero usage/cost/attempts at the top level; the original generation stays visible under `provenance`. */
function replayedFromCache<TOutput>(cached: CapabilityResponse<TOutput>, cacheKey: string, latencyMs: number): CapabilityResponse<TOutput> {
  const original = cached.meta.provenance;
  return {
    output: cached.output,
    meta: {
      ...cached.meta,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      attempts: 0,
      cacheHit: true,
      latencyMs,
      ...(original
        ? { provenance: { ...original, source: 'cache' as const, cacheKey } }
        : {
            // Entry written before provenance existed: say so by carrying what we know, without inventing a generation time.
            provenance: {
              origin: 'llm' as const,
              source: 'cache' as const,
              cacheKey,
              generation: {
                generatedAtMs: 0,
                traceId: 'unknown',
                providerUsed: cached.meta.providerUsed,
                modelUsed: cached.meta.modelUsed,
                promptVersion: cached.meta.promptVersion,
                schemaHash: 'unknown',
                usage: cached.meta.usage,
                costUsd: cached.meta.costUsd,
              },
            },
          }),
    },
  };
}
