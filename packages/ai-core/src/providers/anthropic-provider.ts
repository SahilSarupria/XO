import { AiError, ErrorCode } from '@xo/errors';
import type {
  ModelProvider,
  ProviderCapabilityDescriptor,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderToolCall,
} from '../provider-types.js';

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
}

interface AnthropicContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

interface AnthropicMessagesResponse {
  readonly content: readonly AnthropicContentBlock[];
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
      models: [
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-8',
        'claude-sonnet-5-5',
        'claude-opus-5-5',
        'claude-haiku-5-5',
      ],
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsToolCalling: true,
      maxContextTokens: 200_000,
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const systemMessages = request.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');
    const system = [
      ...systemMessages,
      request.responseSchema ? `Respond with JSON matching this schema exactly:\n${JSON.stringify(request.responseSchema)}` : undefined,
    ]
      .filter((s): s is string => s !== undefined)
      .join('\n\n');

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
        messages: toAnthropicMessages(nonSystemMessages),
        temperature: request.temperature,
        tools:
          request.tools !== undefined && request.tools.length > 0
            ? request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
            : undefined,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, `Anthropic API returned ${response.status}: ${body}`);
    }

    const data = (await response.json()) as AnthropicMessagesResponse;
    const text = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    const toolCalls: ProviderToolCall[] = data.content
      .filter((block) => block.type === 'tool_use' && block.id !== undefined && block.name !== undefined)
      .map((block) => ({ id: block.id as string, name: block.name as string, input: block.input ?? {} }));

    return {
      text,
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
      modelUsed: request.model,
      finishReason: toolCalls.length > 0 ? 'tool_use' : mapStopReason(data.stop_reason),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}

type AnthropicWireMessage = { role: 'user' | 'assistant'; content: string | readonly Record<string, unknown>[] };

/**
 * Maps vendor-neutral messages onto Anthropic's wire shape. Tool use is
 * block-structured there: an assistant turn that calls tools carries
 * `tool_use` blocks, and the results go back as `tool_result` blocks inside a
 * single `user` message — consecutive `tool` messages (parallel tool calls)
 * are merged into that one message, which the API requires.
 */
export function toAnthropicMessages(messages: readonly ProviderMessage[]): AnthropicWireMessage[] {
  const out: AnthropicWireMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError === true ? { is_error: true } : {}),
      };
      const last = out[out.length - 1];
      if (
        last !== undefined &&
        last.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.every((b) => b['type'] === 'tool_result')
      ) {
        out[out.length - 1] = { role: 'user', content: [...last.content, block] };
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: [
          ...(m.content.length > 0 ? [{ type: 'text', text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
        ],
      });
      continue;
    }
    out.push({ role: m.role as 'user' | 'assistant', content: m.content });
  }
  return out;
}

function mapStopReason(reason: string): ProviderResponse['finishReason'] {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_use';
  return 'error';
}
