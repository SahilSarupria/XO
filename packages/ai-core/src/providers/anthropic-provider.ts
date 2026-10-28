import { randomUUID } from 'node:crypto';
import { providerFailure } from '../provider-errors.js';
import { truncate } from '../redaction.js';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse, TokenUsage } from '../provider-types.js';
import { asRecord, isCount, postJsonWithRetry, resolveTransportOptions, type TransportRetryOptions } from './http-transport.js';

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
  /** Per-HTTP-attempt timeout (default 30s, same as Gemini). */
  readonly timeoutMs?: number;
  /** Bounded transport retry (default 2 retries, same as Gemini). `maxRetries: 0` disables retries. */
  readonly retry?: Partial<TransportRetryOptions>;
}

/**
 * Real Anthropic `/v1/messages` integration — genuine request/response
 * mapping to the documented API shape, built on the global `fetch`
 * (no HTTP client dependency). Structured output is requested by
 * embedding the JSON Schema into the system prompt (Anthropic's Messages
 * API has no dedicated `response_format` parameter as of this writing);
 * `router.ts`'s post-hoc schema validation is what actually enforces
 * conformance regardless.
 *
 * Transport (timeout, caller abort, status classification incl. 529
 * "overloaded" → transient, bounded retry, secret redaction) is the shared
 * `http-transport.ts`; every failure is a classified `providerFailure(...)`.
 * Response parsing is defensive: a missing `content` / `usage` never throws
 * a `TypeError`. `stop_reason: "refusal"` → `content_blocked`;
 * `max_tokens` → `finishReason: 'length'`.
 *
 * NOT live-verified: the sandbox this was written in has no network
 * access and no API key. This is real, reviewable code written to the
 * documented contract, not a placeholder — see this package's README.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly retry: TransportRetryOptions;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
    this.apiVersion = options.apiVersion ?? '2023-06-01';
    const resolved = resolveTransportOptions('anthropic', options);
    this.timeoutMs = resolved.timeoutMs;
    this.retry = resolved.retry;
  }

  describeCapabilities(): ProviderCapabilityDescriptor {
    return {
      providerId: 'anthropic',
      models: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-8'],
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      maxContextTokens: 200_000,
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const requestId = request.requestId ?? randomUUID();
    const startedAt = performance.now();
    const systemMessages = request.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');
    const system = [
      ...systemMessages,
      request.responseSchema ? `Respond with JSON matching this schema exactly:\n${JSON.stringify(request.responseSchema)}` : undefined,
    ]
      .filter((s): s is string => s !== undefined)
      .join('\n\n');

    const result = await postJsonWithRetry<unknown>(
      {
        providerId: this.id,
        displayName: 'Anthropic',
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        retry: this.retry,
        secrets: [this.options.apiKey],
      },
      {
        url: `${this.baseUrl}/v1/messages`,
        headers: { 'content-type': 'application/json', 'x-api-key': this.options.apiKey, 'anthropic-version': this.apiVersion },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxOutputTokens,
          system: system.length > 0 ? system : undefined,
          messages: nonSystemMessages.map((m) => ({ role: m.role, content: m.content })),
          temperature: request.temperature,
        }),
        model: request.model,
        requestId,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    return this.normalize(result.data, request, requestId, result.attempts, Math.round(performance.now() - startedAt));
  }

  private normalize(raw: unknown, request: ProviderRequest, requestId: string, attempts: number, durationMs: number): ProviderResponse {
    const failCtx = { model: request.model, requestId, attempts };
    const data = asRecord(raw);
    if (!data) throw providerFailure('malformed_response', this.id, 'Anthropic returned an unexpected response shape', failCtx);

    const rawStop = typeof data['stop_reason'] === 'string' ? data['stop_reason'] : undefined;
    if (rawStop === 'refusal') {
      throw providerFailure('content_blocked', this.id, 'Anthropic declined the request (stop_reason: refusal)', failCtx);
    }

    const blocks = Array.isArray(data['content']) ? (data['content'] as unknown[]) : [];
    const text = blocks
      .map((b) => asRecord(b))
      .filter((b): b is Record<string, unknown> => b !== undefined && b['type'] === 'text')
      .map((b) => (typeof b['text'] === 'string' ? b['text'] : ''))
      .join('');
    if (text.trim().length === 0) {
      throw providerFailure(
        'empty_response',
        this.id,
        `Anthropic returned empty output (stop_reason: ${truncate(rawStop ?? 'none', 40)})`,
        failCtx,
      );
    }

    const { usage, known } = extractUsage(data['usage']);
    return {
      text,
      usage,
      usageKnown: known,
      modelUsed: request.model,
      finishReason: mapStopReason(rawStop),
      meta: {
        providerId: this.id,
        requestId,
        durationMs,
        attempts,
        ...(rawStop !== undefined ? { rawFinishReason: truncate(rawStop, 60) } : {}),
      },
    };
  }
}

function mapStopReason(reason: string | undefined): ProviderResponse['finishReason'] {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'max_tokens') return 'length';
  return 'error';
}

/** Never fabricates: if either count is missing/invalid the usage is a `{0,0}` placeholder flagged `known: false`. */
function extractUsage(usage: unknown): { usage: TokenUsage; known: boolean } {
  const u = asRecord(usage);
  if (!u || !isCount(u['input_tokens']) || !isCount(u['output_tokens']))
    return { usage: { inputTokens: 0, outputTokens: 0 }, known: false };
  return { usage: { inputTokens: u['input_tokens'], outputTokens: u['output_tokens'] }, known: true };
}
