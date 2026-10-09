import { err, ok } from '@xo/types';
import { AiError, ErrorCode } from '@xo/errors';
import { noopLogger } from '@xo/logger';
import { noopTracer, noopMeter } from '@xo/observability';
import { CircuitBreaker } from './circuit-breaker.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { RetryPolicy } from './retry.js';
import { computeCacheKey, InMemoryCapabilityCache } from './cache.js';
import { CostAccountant, DEFAULT_PRICING_TABLE } from './cost.js';
import { selectCandidates } from './model-selection.js';
import { createDefaultPromptRegistry } from './prompt/index.js';
import { validateJsonSchema } from './json-schema.js';
import { CAPABILITY_OUTPUT_SCHEMAS } from './capability-schemas.js';
const DEFAULT_RETRY_OPTIONS = { maxAttempts: 3, initialDelayMs: 200, maxDelayMs: 2000, backoffMultiplier: 2 };
const DEFAULT_CIRCUIT_OPTIONS = { failureThreshold: 5, cooldownMs: 30_000 };
const DEFAULT_RATE_LIMIT_OPTIONS = { capacity: 60, refillPerSecond: 1 };
/**
 * The AI Capability Layer — the sole interface between callers (the
 * compiler's Stage 4-9 extractors, or anything else) and every AI
 * provider. A caller only ever sees `extractEntities`/`extractKnowledge`/
 * etc.; everything provider-specific (which vendor, which model, retry/
 * circuit-breaking/rate-limiting per vendor, cost accounting, caching) is
 * internal routing this class owns.
 */
export class AiCapabilityLayer {
    options;
    providersById = new Map();
    descriptorsById = new Map();
    circuitBreakers = new Map();
    rateLimiters = new Map();
    promptRegistry;
    cache;
    costAccountant;
    logger;
    tracer;
    meter;
    retryOptions;
    circuitBreakerOptions;
    rateLimiterOptions;
    constructor(options) {
        this.options = options;
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
    describeProviders() {
        return [...this.descriptorsById.values()];
    }
    totalCostUsd() {
        return this.costAccountant.totalCostUsd();
    }
    extractEntities(request) {
        return this.callCapability('extractEntities', request);
    }
    extractKnowledge(request) {
        return this.callCapability('extractKnowledge', request);
    }
    extractReasoning(request) {
        return this.callCapability('extractReasoning', request);
    }
    extractCapabilities(request) {
        return this.callCapability('extractCapabilities', request);
    }
    extractDecisionGraph(request) {
        return this.callCapability('extractDecisionGraph', request);
    }
    extractConstraints(request) {
        return this.callCapability('extractConstraints', request);
    }
    getOrCreateCircuitBreaker(providerId) {
        let breaker = this.circuitBreakers.get(providerId);
        if (!breaker) {
            breaker = new CircuitBreaker(this.circuitBreakerOptions);
            this.circuitBreakers.set(providerId, breaker);
        }
        return breaker;
    }
    getOrCreateRateLimiter(providerId) {
        let limiter = this.rateLimiters.get(providerId);
        if (!limiter) {
            const perProviderOverride = this.options.rateLimiterOptionsByProvider?.[providerId];
            limiter = new TokenBucketRateLimiter({ ...this.rateLimiterOptions, ...perProviderOverride });
            this.rateLimiters.set(providerId, limiter);
        }
        return limiter;
    }
    async callCapability(capability, request) {
        return this.tracer.withSpan(`ai_core.${capability}`, async (span) => {
            const startedAt = performance.now();
            span.setAttribute('capability', capability);
            span.setAttribute('trace_id', request.traceId);
            let template;
            try {
                template = this.promptRegistry.resolve(capability);
            }
            catch (error) {
                return err(error);
            }
            const cacheKey = computeCacheKey({ capability, promptVersion: template.version, input: request.input, excerptText: request.excerpt.text });
            const cached = this.cache.get(cacheKey);
            if (cached) {
                this.logger.debug('ai_core cache hit', { capability, traceId: request.traceId });
                this.meter.createCounter('ai_core_cache_hits_total').add(1, { capability });
                return ok({ ...cached.value, meta: { ...cached.value.meta, cacheHit: true, latencyMs: performance.now() - startedAt } });
            }
            const candidates = selectCandidates(this.options.policy, capability, new Set(this.providersById.keys()), this.descriptorsById, true);
            if (candidates.length === 0) {
                return err(new AiError(ErrorCode.AI_NO_ELIGIBLE_PROVIDER, `No eligible provider registered for capability "${capability}"`));
            }
            const messages = template.render(request.input, request.excerpt.text);
            const schema = CAPABILITY_OUTPUT_SCHEMAS[capability];
            let totalAttempts = 0;
            const failures = [];
            for (const candidate of candidates) {
                const provider = this.providersById.get(candidate.providerId);
                if (!provider)
                    continue;
                const circuitBreaker = this.getOrCreateCircuitBreaker(candidate.providerId);
                const rateLimiter = this.getOrCreateRateLimiter(candidate.providerId);
                if (!rateLimiter.tryAcquire()) {
                    this.logger.warn('ai_core rate limited, skipping provider', { provider: candidate.providerId, capability });
                    failures.push(new AiError(ErrorCode.AI_RATE_LIMITED, `Provider "${candidate.providerId}" is rate limited`));
                    continue;
                }
                const retryPolicy = new RetryPolicy({
                    ...this.retryOptions,
                    isRetryable: (error) => !(error instanceof AiError) || error.code !== ErrorCode.AI_CIRCUIT_OPEN,
                });
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const outcome = await retryPolicy.execute(async (attempt) => {
                        totalAttempts = attempt;
                        return circuitBreaker.execute(async () => {
                            const response = await provider.complete({ model: candidate.model, messages, maxOutputTokens: 4096, responseSchema: schema });
                            let parsed;
                            try {
                                parsed = JSON.parse(response.text);
                            }
                            catch (cause) {
                                throw new AiError(ErrorCode.AI_SCHEMA_VALIDATION_FAILED, `Provider "${candidate.providerId}" did not return valid JSON`, { cause });
                            }
                            const issues = validateJsonSchema(schema, parsed);
                            if (issues.length > 0) {
                                throw new AiError(ErrorCode.AI_SCHEMA_VALIDATION_FAILED, `Provider "${candidate.providerId}" response failed schema validation: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
                            }
                            return { response, output: parsed };
                        });
                    });
                    const costRecord = this.costAccountant.record(candidate.providerId, outcome.value.response.modelUsed, outcome.value.response.usage);
                    const result = {
                        output: outcome.value.output,
                        meta: {
                            capability,
                            providerUsed: candidate.providerId,
                            modelUsed: outcome.value.response.modelUsed,
                            promptVersion: template.version,
                            usage: outcome.value.response.usage,
                            costUsd: costRecord.costUsd,
                            cacheHit: false,
                            latencyMs: performance.now() - startedAt,
                            attempts: outcome.attempts,
                        },
                    };
                    this.cache.set(cacheKey, result);
                    this.meter.createCounter('ai_core_requests_total').add(1, { capability, provider: candidate.providerId, status: 'success' });
                    span.setStatus('ok');
                    return ok(result);
                }
                catch (error) {
                    this.logger.warn('ai_core provider attempt failed, trying next candidate', { provider: candidate.providerId, capability, error: error instanceof Error ? error.message : String(error) });
                    this.meter.createCounter('ai_core_requests_total').add(1, { capability, provider: candidate.providerId, status: 'failure' });
                    failures.push(error);
                }
            }
            span.setStatus('error', 'all providers failed');
            return err(new AiError(ErrorCode.AI_ALL_PROVIDERS_FAILED, `All ${candidates.length} candidate provider(s) failed for capability "${capability}" after ${totalAttempts} attempt(s) on the last one`, { context: { failureCount: failures.length } }));
        });
    }
}
//# sourceMappingURL=router.js.map