import { randomUUID } from 'node:crypto';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../provider-types.js';
import { resolveTransportOptions, postJsonWithRetry, type TransportRetryOptions } from './http-transport.js';
import { buildChatCompletionBody, normalizeChatCompletion } from './openai-chat-shared.js';

export interface AzureOpenAiProviderOptions {
  readonly apiKey: string;
  /** e.g. "https://my-resource.openai.azure.com" — Azure's per-resource endpoint, distinct from OpenAI's shared api.openai.com. */
  readonly endpoint: string;
  /** Azure deployment name — Azure routes by deployment, not by the `model` field OpenAI/Anthropic use directly, so `ProviderRequest.model` is treated as the deployment name here. */
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
  /** Per-HTTP-attempt timeout (default 30s, same as Gemini). */
  readonly timeoutMs?: number;
  /** Bounded transport retry (default 2 retries, same as Gemini). `maxRetries: 0` disables retries. */
  readonly retry?: Partial<TransportRetryOptions>;
}

/**
 * Real Azure OpenAI integration. Same request/response *shape* as
 * `openai-provider.ts` (Azure OpenAI mirrors the OpenAI Chat Completions
 * API; the shared mapping lives in `openai-chat-shared.ts`), but a distinct
 * adapter because the URL structure, auth header, and deployment-vs-model
 * addressing all differ — collapsing the two into one class with a flag
 * would blur exactly the kind of vendor-specific detail this package
 * exists to keep out of everything above `ModelProvider`.
 *
 * Azure's content filter surfaces as HTTP 400 `content_filter` (classified
 * `content_blocked`) or as `finish_reason: "content_filter"` on a 200.
 *
 * NOT live-verified in this sandbox (no network/API key) — see this
 * package's README.
 */
export class AzureOpenAiProvider implements ModelProvider {
  readonly id = 'azure-openai' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly retry: TransportRetryOptions;

  constructor(private readonly options: AzureOpenAiProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiVersion = options.apiVersion ?? '2024-06-01';
    const resolved = resolveTransportOptions('azure-openai', options);
    this.timeoutMs = resolved.timeoutMs;
    this.retry = resolved.retry;
  }

  describeCapabilities(): ProviderCapabilityDescriptor {
    return {
      providerId: 'azure-openai',
      models: ['gpt-4o'],
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      maxContextTokens: 128_000,
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const requestId = request.requestId ?? randomUUID();
    const startedAt = performance.now();
    const url = `${this.options.endpoint}/openai/deployments/${encodeURIComponent(request.model)}/chat/completions?api-version=${this.apiVersion}`;
    const result = await postJsonWithRetry<unknown>(
      {
        providerId: this.id,
        displayName: 'Azure OpenAI',
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        retry: this.retry,
        secrets: [this.options.apiKey],
      },
      {
        url,
        headers: { 'content-type': 'application/json', 'api-key': this.options.apiKey },
        body: buildChatCompletionBody(request, false),
        model: request.model,
        requestId,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    return normalizeChatCompletion(result.data, {
      providerId: this.id,
      displayName: 'Azure OpenAI',
      request,
      requestId,
      attempts: result.attempts,
      durationMs: Math.round(performance.now() - startedAt),
      useResponseModel: false,
    });
  }
}
