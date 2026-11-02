import { err, ok, type Result } from '@xo/types';
import { AiError, ErrorCode } from '@xo/errors';
import { noopLogger, type Logger } from '@xo/logger';
import { noopMeter, noopTracer, type Meter, type Tracer } from '@xo/observability';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
import { TokenBucketRateLimiter, type TokenBucketOptions } from './rate-limiter.js';
import { RetryPolicy, type RetryPolicyOptions } from './retry.js';
import { CostAccountant, DEFAULT_PRICING_TABLE, type PricingTable } from './cost.js';
import { selectCandidates, type ModelSelectionPolicy } from './model-selection.js';
import { validateJsonSchema, type JsonSchema } from './json-schema.js';
import type { ConversationTaskId } from './capability-types.js';
import type {
  ModelProvider,
  ProviderCapabilityDescriptor,
  ProviderId,
  ProviderMessage,
  ProviderResponse,
  TokenUsage,
} from './provider-types.js';

/**
 * The conversational half of the AI Capability Layer.
 *
 * `AiCapabilityLayer` (router.ts) exposes six fixed, document-extraction-shaped capabilities. Anything that is a
 * *conversation* — the customer-facing XO chat, an in-product assistant — needs the same guarantees (provider
 * neutrality, retry, circuit breaking, rate limiting, fallback, cost accounting, schema-checked output) but over
 * arbitrary messages. This class provides exactly that and nothing else: it knows nothing about organizations,
 * knowledge, permissions or what a "turn" means. Those belong to the layers above it (`@xo/intelligence`), which is
 * how the ASK -> DECIDE -> DO -> LEARN experience stays independent of any one model vendor.
 *
 * It reuses, unchanged, the building blocks `AiCapabilityLayer` uses: `RetryPolicy`, `CircuitBreaker`,
 * `TokenBucketRateLimiter`, `CostAccountant`, `selectCandidates` and `validateJsonSchema`.
 *
 * Failure policy: provider error text is logged (at warn) but never placed in the returned error, because vendor
 * error bodies can carry request ids or echoed credentials and the caller may relay errors to end users.
 */

export interface ConversationCandidate {
  readonly providerId: ProviderId;
  readonly model: string;
}

export interface ConversationRequest {
  readonly task: ConversationTaskId;
  readonly messages: readonly ProviderMessage[];
  /** Caller-supplied correlation id for logs and traces. */
  readonly traceId: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /**
   * An explicit, ordered candidate list (primary first, then fallbacks) — typically a workspace's selected models.
   * When omitted, the layer's `ModelSelectionPolicy` decides. Candidates whose provider is unknown to the layer are
   * skipped, never errored on, so a policy can list providers that are only configured in some deployments.
   */
  readonly candidates?: readonly ConversationCandidate[];
}

export interface StructuredConversationRequest extends ConversationRequest {
  /** The model's reply must be JSON satisfying this schema; anything else counts as a failed attempt. */
  readonly responseSchema: JsonSchema;
}

export interface ConversationResponseMeta {
  readonly task: ConversationTaskId;
  readonly providerUsed: ProviderId;
  readonly modelUsed: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly latencyMs: number;
  /** Attempts made on the provider that finally answered. */
  readonly attempts: number;
  /** Candidates tried in total, including the one that answered (>1 means a fallback happened). */
  readonly candidatesTried: number;
  readonly finishReason: ProviderResponse['finishReason'];
}

export interface ConversationResponse<T> {
  readonly output: T;
  readonly meta: ConversationResponseMeta;
}

export interface ConversationLayerOptions {
  /** Providers registered up front. */
  readonly providers?: readonly ModelProvider[];
  /** Lazily resolves a provider by id (e.g. from server environment). Resolved providers are cached by id. */
  readonly resolveProvider?: (providerId: ProviderId) => ModelProvider | undefined;
  /** Used when a request carries no explicit `candidates`. */
  readonly policy?: ModelSelectionPolicy;
  readonly pricingTable?: PricingTable;
  readonly logger?: Logger;
  readonly tracer?: Tracer;
  readonly meter?: Meter;
  readonly retryOptions?: Partial<Omit<RetryPolicyOptions, 'isRetryable'>>;
  readonly circuitBreakerOptions?: Partial<CircuitBreakerOptions>;
  readonly rateLimiterOptions?: Partial<TokenBucketOptions>;
}

// Chat is latency-sensitive: fewer, quicker retries than the batch extraction router.
const DEFAULT_RETRY: Omit<RetryPolicyOptions, 'isRetryable'> = {
  maxAttempts: 2,
  initialDelayMs: 150,
  maxDelayMs: 1000,
  backoffMultiplier: 2,
};
const DEFAULT_CIRCUIT: CircuitBreakerOptions = { failureThreshold: 5, cooldownMs: 30_000 };
const DEFAULT_RATE: TokenBucketOptions = { capacity: 120, refillPerSecond: 2 };
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/** Models sometimes wrap JSON in a Markdown fence even when asked not to; accept that and nothing looser. */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? (fenced[1] as string) : trimmed);
}

export class ConversationLayer {
  private readonly providers = new Map<ProviderId, ModelProvider>();
  private readonly breakers = new Map<ProviderId, CircuitBreaker>();
  private readonly limiters = new Map<ProviderId, TokenBucketRateLimiter>();
  private readonly cost: CostAccountant;
  private readonly logger: Logger;
  private readonly tracer: Tracer;
  private readonly meter: Meter;
  private readonly retry: Omit<RetryPolicyOptions, 'isRetryable'>;
  private readonly circuit: CircuitBreakerOptions;
  private readonly rate: TokenBucketOptions;

  constructor(private readonly options: ConversationLayerOptions) {
    for (const p of options.providers ?? []) this.providers.set(p.id, p);
    this.cost = new CostAccountant(options.pricingTable ?? DEFAULT_PRICING_TABLE);
    this.logger = options.logger ?? noopLogger;
    this.tracer = options.tracer ?? noopTracer;
    this.meter = options.meter ?? noopMeter;
    this.retry = { ...DEFAULT_RETRY, ...options.retryOptions };
    this.circuit = { ...DEFAULT_CIRCUIT, ...options.circuitBreakerOptions };
    this.rate = { ...DEFAULT_RATE, ...options.rateLimiterOptions };
  }

  describeProviders(): readonly ProviderCapabilityDescriptor[] {
    return [...this.providers.values()].map((p) => p.describeCapabilities());
  }

  totalCostUsd(): number {
    return this.cost.totalCostUsd();
  }

  /** Free-text reply. */
  converse(request: ConversationRequest): Promise<Result<ConversationResponse<string>, AiError>> {
    return this.run<string>(request, undefined);
  }

  /** JSON reply, parsed and validated against `request.responseSchema` before the caller ever sees it. */
  converseStructured<T>(request: StructuredConversationRequest): Promise<Result<ConversationResponse<T>, AiError>> {
    return this.run<T>(request, request.responseSchema);
  }

  private provider(id: ProviderId): ModelProvider | undefined {
    const known = this.providers.get(id);
    if (known) return known;
    const resolved = this.options.resolveProvider?.(id);
    if (resolved) this.providers.set(id, resolved);
    return resolved;
  }

  private candidatesFor(request: ConversationRequest, structured: boolean): readonly ConversationCandidate[] {
    if (request.candidates !== undefined) {
      return request.candidates.filter((c) => {
        const p = this.provider(c.providerId);
        return p !== undefined && (!structured || p.describeCapabilities().supportsStructuredOutput);
      });
    }
    if (!this.options.policy) return [];
    const descriptors = new Map<ProviderId, ProviderCapabilityDescriptor>();
    for (const [id, p] of this.providers) descriptors.set(id, p.describeCapabilities());
    return selectCandidates(this.options.policy, request.task, new Set(this.providers.keys()), descriptors, structured);
  }

  private breaker(id: ProviderId): CircuitBreaker {
    let b = this.breakers.get(id);
    if (!b) this.breakers.set(id, (b = new CircuitBreaker(this.circuit)));
    return b;
  }

  private limiter(id: ProviderId): TokenBucketRateLimiter {
    let l = this.limiters.get(id);
    if (!l) this.limiters.set(id, (l = new TokenBucketRateLimiter(this.rate)));
    return l;
  }

  private run<T>(request: ConversationRequest, schema: JsonSchema | undefined): Promise<Result<ConversationResponse<T>, AiError>> {
    return this.tracer.withSpan(`ai_core.${request.task}`, async (span) => {
      const startedAt = performance.now();
      span.setAttribute('task', request.task);
      span.setAttribute('trace_id', request.traceId);

      const candidates = this.candidatesFor(request, schema !== undefined);
      if (candidates.length === 0) {
        span.setStatus('error', 'no eligible provider');
        return err(new AiError(ErrorCode.AI_NO_ELIGIBLE_PROVIDER, `No eligible provider is available for "${request.task}"`));
      }

      let tried = 0;
      let lastAttempts = 0;
      for (const candidate of candidates) {
        const provider = this.provider(candidate.providerId);
        if (!provider) continue;
        tried += 1;

        if (!this.limiter(candidate.providerId).tryAcquire()) {
          this.logger.warn('ai_core conversation rate limited, trying next candidate', {
            provider: candidate.providerId,
            task: request.task,
          });
          continue;
        }

        const policy = new RetryPolicy({
          ...this.retry,
          isRetryable: (error) => !(error instanceof AiError) || error.code !== ErrorCode.AI_CIRCUIT_OPEN,
        });

        try {
          const outcome = await policy.execute(async (attempt) => {
            lastAttempts = attempt;
            return this.breaker(candidate.providerId).execute(async () => {
              const response = await provider.complete({
                model: candidate.model,
                messages: request.messages,
                maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
                ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                ...(schema !== undefined ? { responseSchema: schema as unknown as Record<string, unknown> } : {}),
              });
              if (response.finishReason === 'content_filter' && response.text.trim().length === 0) {
                throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, 'The provider returned no content (blocked by its content filter)');
              }
              if (schema === undefined) {
                if (response.text.trim().length === 0) {
                  throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, 'The provider returned an empty reply');
                }
                return { response, output: response.text.trim() as unknown as T };
              }
              let parsed: unknown;
              try {
                parsed = parseJsonLoose(response.text);
              } catch (cause) {
                throw new AiError(ErrorCode.AI_SCHEMA_VALIDATION_FAILED, 'The provider did not return valid JSON', { cause });
              }
              const issues = validateJsonSchema(schema, parsed);
              if (issues.length > 0) {
                throw new AiError(
                  ErrorCode.AI_SCHEMA_VALIDATION_FAILED,
                  `The provider's reply failed schema validation: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
                );
              }
              return { response, output: parsed as T };
            });
          });

          const record = this.cost.record(candidate.providerId, outcome.value.response.modelUsed, outcome.value.response.usage);
          this.meter
            .createCounter('ai_core_conversation_requests_total')
            .add(1, { task: request.task, provider: candidate.providerId, status: 'success' });
          span.setStatus('ok');
          return ok({
            output: outcome.value.output,
            meta: {
              task: request.task,
              providerUsed: candidate.providerId,
              modelUsed: outcome.value.response.modelUsed,
              usage: outcome.value.response.usage,
              costUsd: record.costUsd,
              latencyMs: performance.now() - startedAt,
              attempts: outcome.attempts,
              candidatesTried: tried,
              finishReason: outcome.value.response.finishReason,
            },
          });
        } catch (error) {
          this.logger.warn('ai_core conversation attempt failed, trying next candidate', {
            provider: candidate.providerId,
            task: request.task,
            traceId: request.traceId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.meter
            .createCounter('ai_core_conversation_requests_total')
            .add(1, { task: request.task, provider: candidate.providerId, status: 'failure' });
        }
      }

      span.setStatus('error', 'all providers failed');
      return err(
        new AiError(
          ErrorCode.AI_ALL_PROVIDERS_FAILED,
          `All ${tried} candidate provider(s) failed for "${request.task}" (last one after ${lastAttempts} attempt(s))`,
          { context: { candidatesTried: tried } },
        ),
      );
    });
  }
}
