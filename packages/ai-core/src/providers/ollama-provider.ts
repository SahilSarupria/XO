import { randomUUID } from 'node:crypto';
import { providerFailure } from '../provider-errors.js';
import { truncate } from '../redaction.js';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse, TokenUsage } from '../provider-types.js';
import { asRecord, isCount, postJsonWithRetry, resolveTransportOptions, type TransportRetryOptions } from './http-transport.js';

export interface OllamaProviderOptions {
  /** Ollama runs locally (or on a self-hosted server) — no API key by default, just a base URL. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Per-HTTP-attempt timeout (default 30s, same as the other adapters). A local model generating a long answer on modest
   * hardware can exceed this: raise it for the models you actually run.
   */
  readonly timeoutMs?: number;
  /** Bounded transport retry (default 2 retries, same as Gemini). `maxRetries: 0` disables retries. */
  readonly retry?: Partial<TransportRetryOptions>;
}

/**
 * Real Ollama `/api/chat` integration — the odd one out among these
 * adapters in a useful way: no API key, a local/self-hosted `baseUrl`,
 * and (as of Ollama's current API) no distinct concept of "model I asked
 * for" vs. "model that answered," so `modelUsed` echoes back
 * `request.model`. Also the one provider descriptor here whose
 * `models` list is intentionally empty — which models are actually
 * available depends entirely on what the operator has pulled locally,
 * not on anything this adapter can know statically; `model-selection.ts`
 * would need an explicit `modelByProvider` entry for whatever's been
 * pulled, same as any other provider.
 *
 * It does NOT support structured output (`supportsStructuredOutput: false`),
 * so the router never selects it for capability calls; it is hardened here so
 * that direct users get the same classified failures, timeout and abort
 * handling as every other adapter.
 *
 * NOT live-verified in this sandbox (no local Ollama server reachable
 * from a no-network sandbox) — see this package's README.
 */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: TransportRetryOptions;

  constructor(private readonly options: OllamaProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'http://localhost:11434';
    const resolved = resolveTransportOptions('ollama', options);
    this.timeoutMs = resolved.timeoutMs;
    this.retry = resolved.retry;
  }

  describeCapabilities(): ProviderCapabilityDescriptor {
    return {
      providerId: 'ollama',
      models: [],
      supportsStreaming: true,
      supportsStructuredOutput: false,
      supportsVision: false,
      maxContextTokens: 8_192,
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const requestId = request.requestId ?? randomUUID();
    const startedAt = performance.now();
    const result = await postJsonWithRetry<unknown>(
      {
        providerId: this.id,
        displayName: 'Ollama',
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        retry: this.retry,
        secrets: [],
      },
      {
        url: `${this.baseUrl}/api/chat`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          stream: false,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          options: { temperature: request.temperature, num_predict: request.maxOutputTokens },
        }),
        model: request.model,
        requestId,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    const failCtx = { model: request.model, requestId, attempts: result.attempts };
    const data = asRecord(result.data);
    if (!data) throw providerFailure('malformed_response', this.id, 'Ollama returned an unexpected response shape', failCtx);
    // Ollama can report an error inside a 200 body.
    if (typeof data['error'] === 'string') {
      throw providerFailure('malformed_response', this.id, 'Ollama reported an error in the response body', failCtx);
    }
    const message = asRecord(data['message']);
    const text = typeof message?.['content'] === 'string' ? message['content'] : '';
    const doneReason = typeof data['done_reason'] === 'string' ? data['done_reason'] : undefined;
    if (text.trim().length === 0) {
      throw providerFailure(
        'empty_response',
        this.id,
        `Ollama returned empty output (done_reason: ${truncate(doneReason ?? 'none', 40)})`,
        failCtx,
      );
    }

    const { usage, known } = extractUsage(data);
    return {
      text,
      usage,
      usageKnown: known,
      modelUsed: request.model,
      finishReason: doneReason === 'length' ? 'length' : doneReason === undefined || doneReason === 'stop' ? 'stop' : 'error',
      meta: {
        providerId: this.id,
        requestId,
        durationMs: Math.round(performance.now() - startedAt),
        attempts: result.attempts,
        ...(doneReason !== undefined ? { rawFinishReason: truncate(doneReason, 60) } : {}),
      },
    };
  }
}

/** Never fabricates: if either count is missing/invalid the usage is a `{0,0}` placeholder flagged `known: false`. */
function extractUsage(data: Record<string, unknown>): { usage: TokenUsage; known: boolean } {
  if (!isCount(data['prompt_eval_count']) || !isCount(data['eval_count']))
    return { usage: { inputTokens: 0, outputTokens: 0 }, known: false };
  return { usage: { inputTokens: data['prompt_eval_count'], outputTokens: data['eval_count'] }, known: true };
}
