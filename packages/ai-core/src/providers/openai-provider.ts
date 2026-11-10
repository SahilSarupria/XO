import { randomUUID } from 'node:crypto';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../provider-types.js';
import { resolveTransportOptions, postJsonWithRetry, type TransportRetryOptions } from './http-transport.js';
import { buildChatCompletionBody, normalizeChatCompletion } from './openai-chat-shared.js';

export interface OpenAiProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Per-HTTP-attempt timeout (default 30s, same as Gemini). */
  readonly timeoutMs?: number;
  /** Bounded transport retry (default 2 retries, same as Gemini). `maxRetries: 0` disables retries. */
  readonly retry?: Partial<TransportRetryOptions>;
}

/**
 * Real OpenAI Chat Completions integration (`POST /v1/chat/completions`).
 * Uses `response_format: { type: "json_schema", ... }` when the request
 * carries a `responseSchema` — OpenAI's actual structured-output
 * mechanism, unlike Anthropic's (see anthropic-provider.ts), which is why
 * `ProviderCapabilityDescriptor.supportsStructuredOutput` differs
 * meaningfully per provider rather than being a decoration.
 *
 * Transport (timeout, caller abort, status classification, bounded retry,
 * secret redaction) is the shared `http-transport.ts`; every failure is a
 * classified `providerFailure(...)`. Response parsing is defensive: a missing
 * `choices` / `content` / `usage` never throws a `TypeError`.
 *
 * NOT live-verified in this sandbox (no network/API key) — see this
 * package's README.
 */
export class OpenAiProvider implements ModelProvider {
  readonly id = 'openai' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: TransportRetryOptions;

  constructor(private readonly options: OpenAiProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com';
    const resolved = resolveTransportOptions('openai', options);
    this.timeoutMs = resolved.timeoutMs;
    this.retry = resolved.retry;
  }

  describeCapabilities(): ProviderCapabilityDescriptor {
    return {
      providerId: 'openai',
      models: ['gpt-4o', 'gpt-4o-mini'],
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      maxContextTokens: 128_000,
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const requestId = request.requestId ?? randomUUID();
    const startedAt = performance.now();
    const result = await postJsonWithRetry<unknown>(
      {
        providerId: this.id,
        displayName: 'OpenAI',
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        retry: this.retry,
        secrets: [this.options.apiKey],
      },
      {
        url: `${this.baseUrl}/v1/chat/completions`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: buildChatCompletionBody(request, true),
        model: request.model,
        requestId,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    return normalizeChatCompletion(result.data, {
      providerId: this.id,
      displayName: 'OpenAI',
      request,
      requestId,
      attempts: result.attempts,
      durationMs: Math.round(performance.now() - startedAt),
      useResponseModel: true,
    });
  }
}
