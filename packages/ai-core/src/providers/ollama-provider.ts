import { fromWireToolCalls, toWireMessages, toWireTools, type WireToolCall } from './openai-tools.js';
import { AiError, ErrorCode } from '@xo/errors';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../provider-types.js';

export interface OllamaProviderOptions {
  /** Ollama runs locally (or on a self-hosted server) — no API key by default, just a base URL. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface OllamaChatResponse {
  readonly message: { readonly content: string; readonly tool_calls?: readonly WireToolCall[] };
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
  readonly done_reason?: string;
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
 * NOT live-verified in this sandbox (no local Ollama server reachable
 * from a no-network sandbox) — see this package's README.
 */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: OllamaProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'http://localhost:11434';
  }

  describeCapabilities(): ProviderCapabilityDescriptor {
    return {
      providerId: 'ollama',
      models: [],
      supportsStreaming: true,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsToolCalling: true,
      maxContextTokens: 8_192,
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        stream: false,
        messages: toWireMessages(request.messages, { argsAsObject: true }),
        tools: toWireTools(request),
        options: { temperature: request.temperature, num_predict: request.maxOutputTokens },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, `Ollama API returned ${response.status}: ${body}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const toolCalls = fromWireToolCalls(data.message.tool_calls, 'ollama_call');
    if (toolCalls.length > 0 && data.done_reason === 'length')
      throw new AiError(
        ErrorCode.AI_PROVIDER_REQUEST_FAILED,
        'Ollama returned tool calls on a length-truncated reply; refusing to run them',
      );
    return {
      text: data.message.content,
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
      modelUsed: request.model,
      finishReason: toolCalls.length > 0 ? 'tool_use' : data.done_reason === 'length' ? 'length' : 'stop',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}
