import { AiError, ErrorCode } from '@xo/errors';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../provider-types.js';

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Every field Gemini may omit is optional here: a candidate blocked by a safety filter has no `content`, and
 * `usageMetadata` can be absent. The adapter must turn those into a typed result or a typed error, never a TypeError.
 */
interface GeminiGenerateContentResponse {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
    readonly finishReason?: string;
  }[];
  readonly promptFeedback?: { readonly blockReason?: string };
  readonly usageMetadata?: { readonly promptTokenCount?: number; readonly candidatesTokenCount?: number };
}

/**
 * Real Gemini `generateContent` integration. Gemini's API has no
 * `system` role — a system message is folded into `systemInstruction`
 * (its own top-level field), and everything else becomes `contents` with
 * Gemini's `user`/`model` role names (not `user`/`assistant`) — another
 * example of why each vendor gets its own adapter file rather than one
 * "OpenAI-compatible-ish" shim.
 *
 * NOT live-verified in this sandbox (no network/API key) — see this
 * package's README.
 */
export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: GeminiProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://generativelanguage.googleapis.com';
  }

  describeCapabilities(): ProviderCapabilityDescriptor {
    return {
      providerId: 'gemini',
      models: ['gemini-1.5-pro', 'gemini-1.5-flash'],
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      maxContextTokens: 1_000_000,
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const systemText = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    // The key travels in a header, not the query string: URLs end up in proxy and access logs, headers do not.
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.options.apiKey },
      body: JSON.stringify({
        contents,
        systemInstruction: systemText.length > 0 ? { parts: [{ text: systemText }] } : undefined,
        generationConfig: {
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature,
          responseMimeType: request.responseSchema ? 'application/json' : undefined,
          responseSchema: request.responseSchema,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, `Gemini API returned ${response.status}: ${body}`);
    }

    const data = (await response.json()) as GeminiGenerateContentResponse;
    const candidate = data.candidates?.[0];
    const usage = {
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    };
    if (!candidate) {
      // A prompt blocked before generation has no candidates at all — report it as a content-filter outcome so the
      // caller can fall back to another provider instead of treating it as a transport failure.
      if (data.promptFeedback?.blockReason !== undefined) {
        return { text: '', usage, modelUsed: request.model, finishReason: 'content_filter' };
      }
      throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, 'Gemini API returned no candidates');
    }
    const text = (candidate.content?.parts ?? []).map((p) => p.text ?? '').join('');

    return { text, usage, modelUsed: request.model, finishReason: mapFinishReason(candidate.finishReason ?? '') };
  }
}

function mapFinishReason(reason: string): ProviderResponse['finishReason'] {
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'RECITATION') return 'content_filter';
  return 'error';
}
