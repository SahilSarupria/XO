import { AiError, ErrorCode } from '@xo/errors';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../provider-types.js';

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
}

interface AnthropicMessagesResponse {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly stop_reason: string;
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
 * NOT live-verified: the sandbox this was written in has no network
 * access and no API key. This is real, reviewable code written to the
 * documented contract, not a placeholder — see this package's README.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly apiVersion: string;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
    this.apiVersion = options.apiVersion ?? '2023-06-01';
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
    const systemMessages = request.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');
    const system = [...systemMessages, request.responseSchema ? `Respond with JSON matching this schema exactly:\n${JSON.stringify(request.responseSchema)}` : undefined].filter((s): s is string => s !== undefined).join('\n\n');

    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version': this.apiVersion,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: system.length > 0 ? system : undefined,
        messages: nonSystemMessages.map((m) => ({ role: m.role, content: m.content })),
        temperature: request.temperature,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, `Anthropic API returned ${response.status}: ${body}`);
    }

    const data = (await response.json()) as AnthropicMessagesResponse;
    const text = data.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');

    return {
      text,
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
      modelUsed: request.model,
      finishReason: mapStopReason(data.stop_reason),
    };
  }
}

function mapStopReason(reason: string): ProviderResponse['finishReason'] {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'max_tokens') return 'length';
  return 'error';
}
