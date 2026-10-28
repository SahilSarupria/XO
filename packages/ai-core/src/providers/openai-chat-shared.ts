import { providerFailure } from '../provider-errors.js';
import { truncate } from '../redaction.js';
import type { ProviderId, ProviderRequest, ProviderResponse, TokenUsage } from '../provider-types.js';
import { asRecord, isCount } from './http-transport.js';

/**
 * Request/response mapping shared by the OpenAI and Azure OpenAI adapters (Azure mirrors the OpenAI Chat Completions
 * shape; the adapters still differ in URL, auth header and model-vs-deployment addressing, which stay in each adapter).
 */

/** The exact body both adapters have always sent (key order and undefined members preserved: wire format is unchanged). */
export function buildChatCompletionBody(request: ProviderRequest, includeModel: boolean): string {
  return JSON.stringify({
    ...(includeModel ? { model: request.model } : {}),
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    response_format: request.responseSchema
      ? { type: 'json_schema', json_schema: { name: 'capability_output', schema: request.responseSchema, strict: true } }
      : undefined,
  });
}

export interface ChatNormalizeContext {
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly request: ProviderRequest;
  readonly requestId: string;
  readonly attempts: number;
  readonly durationMs: number;
  /** OpenAI reports the model that answered; Azure addresses a deployment, so the request's value is echoed. */
  readonly useResponseModel: boolean;
}

/**
 * Defensive normalization of a Chat Completions body. Never throws anything but `providerFailure(...)`: a missing/odd
 * `choices`, `message`, `content` or `usage` becomes a classified failure (or `usageKnown: false`), never a `TypeError`.
 */
export function normalizeChatCompletion(raw: unknown, ctx: ChatNormalizeContext): ProviderResponse {
  const { providerId, displayName, request, requestId, attempts } = ctx;
  const failCtx = { model: request.model, requestId, attempts };
  const data = asRecord(raw);
  if (!data) throw providerFailure('malformed_response', providerId, `${displayName} returned an unexpected response shape`, failCtx);

  const choices = Array.isArray(data['choices']) ? (data['choices'] as unknown[]) : [];
  const choice = asRecord(choices[0]);
  if (!choice) throw providerFailure('empty_response', providerId, `${displayName} returned no choices`, failCtx);

  const rawFinish = typeof choice['finish_reason'] === 'string' ? choice['finish_reason'] : undefined;
  const message = asRecord(choice['message']);

  // A model refusal is reported either as `message.refusal` or as a content-filter finish: a vendor decision, never retried.
  const refusal = message?.['refusal'];
  if (typeof refusal === 'string' && refusal.trim().length > 0) {
    throw providerFailure('content_blocked', providerId, `${displayName} refused the request`, failCtx);
  }
  if (rawFinish === 'content_filter') {
    throw providerFailure('content_blocked', providerId, `${displayName} filtered the output (finish_reason: content_filter)`, failCtx);
  }

  const content = message?.['content'];
  const text = typeof content === 'string' ? content : '';
  if (text.trim().length === 0) {
    throw providerFailure(
      'empty_response',
      providerId,
      `${displayName} returned empty output (finish_reason: ${truncate(rawFinish ?? 'none', 40)})`,
      failCtx,
    );
  }

  const finishReason: ProviderResponse['finishReason'] = rawFinish === 'stop' ? 'stop' : rawFinish === 'length' ? 'length' : 'error';
  const { usage, known } = extractChatUsage(data['usage']);
  const responseModel = typeof data['model'] === 'string' && data['model'].length > 0 ? truncate(data['model'], 120) : undefined;

  return {
    text,
    usage,
    usageKnown: known,
    modelUsed: ctx.useResponseModel ? (responseModel ?? request.model) : request.model,
    finishReason,
    meta: {
      providerId,
      requestId,
      durationMs: ctx.durationMs,
      attempts,
      ...(rawFinish !== undefined ? { rawFinishReason: truncate(rawFinish, 60) } : {}),
    },
  };
}

/** Never fabricates: if either count is missing/invalid the usage is a `{0,0}` placeholder flagged `known: false`. */
function extractChatUsage(usage: unknown): { usage: TokenUsage; known: boolean } {
  const u = asRecord(usage);
  if (!u || !isCount(u['prompt_tokens']) || !isCount(u['completion_tokens']))
    return { usage: { inputTokens: 0, outputTokens: 0 }, known: false };
  return { usage: { inputTokens: u['prompt_tokens'], outputTokens: u['completion_tokens'] }, known: true };
}
