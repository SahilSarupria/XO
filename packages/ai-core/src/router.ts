import { err, ok, type Result } from '@xo/types';
import { AiError, ConfigError, ErrorCode, assertNotAuditData } from '@xo/errors';
import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import type { Tracer, Meter } from '@xo/observability';
import { noopTracer, noopMeter } from '@xo/observability';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
import { TokenBucketRateLimiter, type TokenBucketOptions } from './rate-limiter.js';
import { RetryPolicy, type RetryPolicyOptions } from './retry.js';
import { getProviderFailure, providerFailure } from './provider-errors.js';
import {
  getInferenceDenial,
  inferenceDeniedError,
  type InferenceDenial,
  type InferenceGrant,
  type InferenceRunScope,
  estimateInputTokensUpperBound,
} from './inference-policy.js';
import { CACHE_FORMAT_VERSION, computeCacheKey, computeSchemaHash, InMemoryCapabilityCache, type CapabilityCache } from './cache.js';
import { CostAccountant, DEFAULT_PRICING_TABLE, type PricingTable } from './cost.js';
import { selectCandidates, type ModelSelectionPolicy } from './model-selection.js';
import { assertValidModelSelectionPolicy, type PolicyIssue } from './policy-validation.js';
import { CallScope, callCancellationError, isCallCancelled, type LateOutcome } from './call-scope.js';
import { createDefaultPromptRegistry, type PromptRegistry } from './prompt/index.js';
import { validateJsonSchema } from './json-schema.js';
import { CAPABILITY_OUTPUT_SCHEMAS } from './capability-schemas.js';
import type { CapabilityId, CapabilityRequest, CapabilityResponse } from './capability-types.js';
import type { TokenUsage } from './provider-types.js';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderId, ProviderResponse } from './provider-types.js';
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
  /**
   * COMPILE-TIME inference authority (spend limit + kill-switch). Create it from a dedicated `InferenceGuard(compilePolicy).beginRun()`
   * per compilation; it shares no state with, and grants nothing to, the runtime's guard. When set, EVERY billable provider call
   * (first attempts, retries, fallback candidates) reserves budget first and settles after; a denial is a typed
   * `XO_AI_INFERENCE_DENIED` that is never retried or failed over. Cache hits spend nothing and are not charged.
   * When omitted, calls are unlimited (the pre-existing behaviour) — supply it wherever spend must be bounded.
   */
  readonly inferenceScope?: InferenceRunScope;
  /**
   * Total wall-clock budget, in milliseconds, for the INFERENCE phase of one capability call: every retry, every fallback
   * candidate and every backoff sleep, measured from the cache miss. Absent (default) = no deadline (the pre-existing behaviour).
   * Cache hits are never subject to it. On expiry the router stops waiting at once (even if a provider ignores its abort signal)
   * and returns `AI_ALL_PROVIDERS_FAILED` whose context says `callCancellation: 'deadline'` (see `getCallCancellation`). A
   * response that arrives afterwards is discarded: never returned, never cached; its usage is still charged to the
   * `inferenceScope` and the cost total. Must be a positive integer.
   */
  readonly totalDeadlineMs?: number;
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
  private readonly denials: Partial<Record<InferenceDenial['reason'], number>>;
  private readonly logger: Logger;
  private readonly tracer: Tracer;
  private readonly meter: Meter;
  private readonly retryOptions: Omit<RetryPolicyOptions, 'isRetryable'>;
  private readonly circuitBreakerOptions: CircuitBreakerOptions;
  private readonly rateLimiterOptions: TokenBucketOptions;

  private readonly policyIssues: readonly PolicyIssue[];

  constructor(private readonly options: AiCapabilityLayerOptions) {
    if (
      options.totalDeadlineMs !== undefined &&
      !(Number.isInteger(options.totalDeadlineMs) && options.totalDeadlineMs >= 1 && options.totalDeadlineMs <= MAX_TIMER_MS)
    ) {
      throw new ConfigError(
        ErrorCode.CONFIG_INVALID_VALUE,
        `totalDeadlineMs must be a positive integer no greater than ${MAX_TIMER_MS} (omit it for no deadline)`,
      );
    }
    for (const provider of options.providers) {
      this.providersById.set(provider.id, provider);
      this.descriptorsById.set(provider.id, provider.describeCapabilities());
    }
    // Structural problems (typo'd keys, missing models, duplicate rules...) refuse construction; legal-but-suspicious ones
    // (unregistered providers, uncovered capabilities) are kept for `policyWarnings` and logged below.
    this.policyIssues = assertValidModelSelectionPolicy(options.policy, {
      providers: this.descriptorsById,
      requireStructuredOutput: true,
    }).result.warnings;
    this.promptRegistry = options.promptRegistry ?? createDefaultPromptRegistry();
    this.cache = options.cache ?? new InMemoryCapabilityCache();
    this.costAccountant = new CostAccountant(options.pricingTable ?? DEFAULT_PRICING_TABLE);
    this.denials = {};
    this.logger = options.logger ?? noopLogger;
    this.tracer = options.tracer ?? noopTracer;
    this.meter = options.meter ?? noopMeter;
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retryOptions };
    this.circuitBreakerOptions = { ...DEFAULT_CIRCUIT_OPTIONS, ...options.circuitBreakerOptions };
    this.rateLimiterOptions = { ...DEFAULT_RATE_LIMIT_OPTIONS, ...options.rateLimiterOptions };
    for (const issue of this.policyIssues)
      this.logger.warn('ai_core model selection policy warning', { code: issue.code, path: issue.path });
  }

  /** Legal-but-suspicious findings about the routing policy (e.g. a listed provider that is not registered). Errors never get this far: they refuse construction. */
  get policyWarnings(): readonly PolicyIssue[] {
    return this.policyIssues;
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
      // Count only provider-health failures; a caller-supplied `isFailure` wins over the router's default predicate.
      breaker = new CircuitBreaker({
        ...this.circuitBreakerOptions,
        isFailure: this.circuitBreakerOptions.isFailure ?? countsAgainstBreaker,
      });
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

      const eligible = selectCandidates(this.options.policy, capability, new Set(this.providersById.keys()), this.descriptorsById, true);
      // `allowFallback: false` pins the call to the first eligible candidate: no failover to another provider/model.
      const candidates = this.options.policy.allowFallback === false ? eligible.slice(0, 1) : eligible;
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
        generation: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: PINNED_TEMPERATURE },
        formatVersion: CACHE_FORMAT_VERSION,
      });
      // Policy (kill-switch / allow-list) applies even to cache hits; BUDGET does not (a hit spends nothing).
      const policyDenial = this.options.inferenceScope?.checkPolicy({
        requirement: 'required',
        nodeId: `compile:${capability}`,
        providerId: candidates[0]!.providerId,
      });
      if (policyDenial) {
        this.recordDenial(policyDenial);
        return err(inferenceDeniedError(policyDenial));
      }
      const cached = await this.readCache<TOutput>(cacheKey, schema);
      if (cached) {
        this.logger.debug('ai_core cache hit', { capability, traceId: request.traceId });
        this.meter.createCounter('ai_core_cache_hits_total').add(1, { capability });
        return ok(replayedFromCache(cached, cacheKey, performance.now() - startedAt));
      }

      const messages = template.render(request.input, request.excerpt.text);
      let totalAttempts = 0;
      const failures: unknown[] = [];

      // One scope per call: the total deadline (if any) and the caller's signal, covering every retry and fallback candidate.
      const scope = new CallScope({
        ...(this.options.totalDeadlineMs !== undefined ? { deadlineMs: this.options.totalDeadlineMs } : {}),
        ...(request.signal ? { callerSignal: request.signal } : {}),
      });
      const cancelledResult = (): Result<CapabilityResponse<TOutput>, AiError> | undefined => {
        const cancellation = scope.cancellation();
        if (!cancellation) return undefined;
        this.logger.warn('ai_core call cancelled; stopping retries and fallback', {
          capability,
          reason: cancellation.reason,
          traceId: request.traceId,
        });
        this.meter.createCounter('ai_core_call_cancelled_total').add(1, { capability, reason: cancellation.reason });
        span.setStatus('error', cancellation.reason === 'deadline' ? 'deadline exceeded' : 'cancelled by caller');
        return err(callCancellationError(cancellation, { attempts: totalAttempts, failureCount: failures.length }));
      };

      try {
        for (const candidate of candidates) {
          // Once cancelled (deadline or caller), no further candidate is tried and no rate-limit token is spent.
          const cancelledBefore = cancelledResult();
          if (cancelledBefore) return cancelledBefore;
          const provider = this.providersById.get(candidate.providerId);
          if (!provider) continue;

          const circuitBreaker = this.getOrCreateCircuitBreaker(candidate.providerId);
          const rateLimiter = this.getOrCreateRateLimiter(candidate.providerId);
          if (!rateLimiter.tryAcquire()) {
            this.logger.warn('ai_core rate limited, skipping provider', { provider: candidate.providerId, capability });
            failures.push(new AiError(ErrorCode.AI_RATE_LIMITED, `Provider "${candidate.providerId}" is rate limited`));
            continue;
          }

          // A vendor `finishReason: 'error'` is treated as transient and retried at most ONCE per candidate.
          let finishErrorRetried = false;
          const retryPolicy = new RetryPolicy({
            ...this.retryOptions,
            // Backoff ends the moment the call is cancelled, instead of sleeping past the deadline.
            sleep: (ms) => scope.sleep(ms, this.retryOptions.sleep),
            isRetryable: (error) => {
              if (isCallCancelled(error)) return false;
              if (error instanceof AiError && error.code === ErrorCode.AI_CIRCUIT_OPEN) return false;
              if (getInferenceDenial(error)) return false; // a denial is final: never retried
              // Provider adapters that classify their failures already applied their own bounded transport retry
              // (honouring Retry-After); retrying again here would multiply attempts and risk retry storms. The one
              // exception is a malformed/schema-invalid body, where a fresh sample can legitimately succeed.
              // Auth, invalid-request, content-blocked, unsupported-model and quota failures are never retried.
              const failure = getProviderFailure(error);
              if (failure) {
                if (failure.category === 'malformed_response') return true;
                if (routerFinishErrors.has(error as object) && !finishErrorRetried) {
                  finishErrorRetried = true;
                  return true;
                }
                return false;
              }
              return true;
            },
          });

          try {
            const outcome = await retryPolicy.execute(async (attempt) => {
              totalAttempts = attempt;
              scope.throwIfCancelled();
              // Authorize + reserve BEFORE the circuit breaker (a denial must not count as a provider failure) and before every
              // attempt, so retries and fallback candidates draw on the same budget as first attempts.
              const grant = this.authorizeCall(
                capability,
                candidate.providerId,
                candidate.model,
                estimateInputTokensUpperBound(messages, JSON.stringify(schema)),
              );
              // 'open': nothing completed yet. 'settled': charged. 'deferred': cancelled while the provider call was in flight, so
              // the reservation is held until that call's late outcome arrives (then charged for real usage, or released).
              let ledger: 'open' | 'settled' | 'deferred' = 'open';
              try {
                return await circuitBreaker.execute(async () => {
                  const pending = provider.complete({
                    model: candidate.model,
                    requestId: request.traceId,
                    messages,
                    maxOutputTokens: grant?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
                    temperature: PINNED_TEMPERATURE,
                    responseSchema: schema as unknown as Record<string, unknown>,
                    ...(scope.active ? { signal: scope.signal } : {}),
                  });
                  let response: ProviderResponse;
                  try {
                    response = await scope.race(pending, (late) =>
                      this.settleLateOutcome(grant, candidate.providerId, candidate.model, late),
                    );
                  } catch (error) {
                    if (isCallCancelled(error)) ledger = 'deferred';
                    throw error;
                  }
                  // The call completed and was billed whether or not the body turns out to be usable: settle now, with real usage
                  // when the provider reported it (unknown usage is charged at the reservation by the guard).
                  grant?.settle({
                    providerId: candidate.providerId,
                    model: response.modelUsed,
                    usage: response.usageKnown === false ? undefined : response.usage,
                  });
                  ledger = 'settled';
                  // An incomplete or filtered body is never parsed, however valid-looking: truncated JSON can be well-formed yet
                  // silently missing items. The call was billed, so it is still counted; none of these trip the breaker (see
                  // `countsAgainstBreaker`), and only a vendor `error` finish is retried (once).
                  const finishFailure = finishReasonFailure(candidate.providerId, candidate.model, request.traceId, response);
                  if (finishFailure) {
                    this.recordDiscardedAttempt(candidate.providerId, response);
                    throw finishFailure;
                  }
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(response.text);
                  } catch (cause) {
                    this.recordDiscardedAttempt(candidate.providerId, response);
                    throw new AiError(
                      ErrorCode.AI_SCHEMA_VALIDATION_FAILED,
                      `Provider "${candidate.providerId}" did not return valid JSON`,
                      {
                        cause,
                      },
                    );
                  }
                  const issues = validateJsonSchema(schema, parsed);
                  if (issues.length > 0) {
                    this.recordDiscardedAttempt(candidate.providerId, response);
                    throw new AiError(
                      ErrorCode.AI_SCHEMA_VALIDATION_FAILED,
                      `Provider "${candidate.providerId}" response failed schema validation: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
                    );
                  }
                  return { response, output: parsed as TOutput };
                });
              } finally {
                // No completed response (provider error, timeout, open circuit, cancellation): nothing measurable to charge.
                if (ledger === 'open') grant?.release();
              }
            });
            // The validated answer is accepted: a deadline or abort from here on can no longer turn it into a failure while it is
            // costed and cached.
            scope.commit();

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
            const denial = getInferenceDenial(error);
            if (denial) {
              // Budget/policy denial is final for the whole request: no retry (handled above), no failover to another candidate,
              // and not reported as an ordinary provider failure.
              this.logger.warn('ai_core inference denied; not retrying or failing over', {
                capability,
                reason: denial.reason,
                traceId: request.traceId,
              });
              this.meter.createCounter('ai_core_inference_denied_total').add(1, { capability, reason: denial.reason });
              return err(error as AiError);
            }
            // A deadline/abort ends the whole call: no retry, no failover. (Checked after denial: a denial is final and typed.)
            const cancelledAfter = cancelledResult();
            if (cancelledAfter) return cancelledAfter;
            this.logger.warn('ai_core provider attempt failed, trying next candidate', {
              provider: candidate.providerId,
              capability,
              error: error instanceof Error ? error.message : String(error),
            });
            this.meter.createCounter('ai_core_requests_total').add(1, { capability, provider: candidate.providerId, status: 'failure' });
            failures.push(error);
          }
        }

        // A cancellation that arrived after the last candidate was already handled above; anything left is an ordinary failure.
        const cancelledAtEnd = cancelledResult();
        if (cancelledAtEnd) return cancelledAtEnd;
        span.setStatus('error', 'all providers failed');
        return err(
          new AiError(
            ErrorCode.AI_ALL_PROVIDERS_FAILED,
            `All ${candidates.length} candidate provider(s) failed for capability "${capability}" after ${totalAttempts} attempt(s) on the last one`,
            { context: { failureCount: failures.length } },
          ),
        );
      } finally {
        scope.dispose();
      }
    });
  }

  private authorizeCall(
    capability: CapabilityId,
    providerId: ProviderId,
    model: string,
    inputTokensUpperBound: number,
  ): InferenceGrant | undefined {
    const scope = this.options.inferenceScope;
    if (!scope) return undefined;
    const authorization = scope.authorize({
      requirement: 'required',
      nodeId: `compile:${capability}`,
      providerId,
      requestedMaxOutputTokens: MAX_OUTPUT_TOKENS,
      model,
      inputTokensUpperBound,
    });
    if (!authorization.ok) {
      this.recordDenial(authorization.denial);
      throw inferenceDeniedError(authorization.denial);
    }
    return authorization.grant;
  }

  private recordDenial(denial: InferenceDenial): void {
    this.denials[denial.reason] = (this.denials[denial.reason] ?? 0) + 1;
  }

  /**
   * A provider call that finishes AFTER the call was cancelled (deadline / caller abort). The caller already got its error, so the
   * response is never returned or cached; but it may have been billed, so the reservation is settled with the real usage and the
   * cost total reflects it. A late failure has no measurable usage: the reservation is released (the same documented under-count
   * as any failed call). Never throws.
   */
  private settleLateOutcome(
    grant: InferenceGrant | undefined,
    providerId: ProviderId,
    model: string,
    late: LateOutcome<ProviderResponse>,
  ): void {
    if (late.ok) {
      const response = late.value;
      grant?.settle({ providerId, model: response.modelUsed, usage: response.usageKnown === false ? undefined : response.usage });
      this.recordDiscardedAttempt(providerId, response);
      this.logger.warn('ai_core late provider response discarded after cancellation', {
        provider: providerId,
        finishReason: response.finishReason,
      });
    } else {
      grant?.release();
    }
  }

  /** A billed call whose body was unusable still cost money: keep total cost reporting honest (the usable attempt is recorded separately). */
  private recordDiscardedAttempt(
    providerId: ProviderId,
    response: { readonly modelUsed: string; readonly usage: TokenUsage; readonly usageKnown?: boolean },
  ): void {
    if (response.usageKnown === false) return;
    this.costAccountant.record(providerId, response.modelUsed, response.usage);
  }

  /**
   * Compile-time inference report for this layer instance: what the budget scope has spent, and how many calls were denied (by
   * reason). Spend is `undefined` when no `inferenceScope` was supplied (nothing is being limited or measured by the guard).
   */
  /**
   * `true` only when an `inferenceScope` is attached AND it can actually limit something (see `InferenceRunScope.isBounded`).
   * Compiler entrypoints refuse a layer for which this is `false` unless the operator explicitly allowed unbounded inference.
   */
  inferenceBounded(): boolean {
    return this.options.inferenceScope?.isBounded() ?? false;
  }

  inferenceReport(): {
    readonly spend: { readonly tokensSpent: number; readonly costSpentUsd: number } | undefined;
    readonly denials: Readonly<Partial<Record<InferenceDenial['reason'], number>>>;
  } {
    const snap = this.options.inferenceScope?.snapshot();
    return { spend: snap ? { tokensSpent: snap.tokensSpent, costSpentUsd: snap.costSpentUsd } : undefined, denials: { ...this.denials } };
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

/** `setTimeout` clamps (and warns on) delays above 2^31-1 ms; a longer deadline is a configuration mistake, not "no deadline". */
const MAX_TIMER_MS = 2_147_483_647;

/** Extraction must be as repeatable as the vendor allows: every provider call is made at temperature 0 (part of the cache identity). */
const PINNED_TEMPERATURE = 0;

/** Errors the router itself raised for a vendor `finishReason: 'error'`, so the retry policy can tell them from adapter-classified transients (which already had their bounded transport retry). */
const routerFinishErrors = new WeakSet<object>();

function finishReasonFailure(providerId: ProviderId, model: string, requestId: string, response: ProviderResponse): AiError | undefined {
  const ctx = { model, requestId };
  switch (response.finishReason) {
    case 'length':
      return providerFailure(
        'output_truncated',
        providerId,
        `Provider "${providerId}" stopped at the output-token limit; the response is incomplete and was discarded`,
        ctx,
      );
    case 'content_filter':
      return providerFailure(
        'content_blocked',
        providerId,
        `Provider "${providerId}" filtered the output; the response was discarded`,
        ctx,
      );
    case 'error': {
      const failure = providerFailure(
        'transient',
        providerId,
        `Provider "${providerId}" ended generation abnormally (finishReason: error)`,
        ctx,
      );
      routerFinishErrors.add(failure);
      return failure;
    }
    default:
      return undefined;
  }
}

/**
 * Circuit-breaker predicate: only evidence about provider HEALTH counts — transient / timeout / rate-limited provider failures
 * and unclassified errors (e.g. a thrown `TypeError`). Everything the caller or the content caused — auth, invalid request,
 * quota, unsupported model/feature, content blocked, truncation, abort, malformed/schema-invalid output, and inference
 * denials — leaves the breaker untouched.
 */
function countsAgainstBreaker(error: unknown): boolean {
  if (getInferenceDenial(error)) return false;
  if (isCallCancelled(error)) return false; // the caller's own deadline/abort says nothing about provider health
  if (error instanceof AiError && error.code === ErrorCode.AI_SCHEMA_VALIDATION_FAILED) return false;
  const failure = getProviderFailure(error);
  if (failure) return failure.category === 'transient' || failure.category === 'timeout' || failure.category === 'rate_limited';
  return true;
}

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
