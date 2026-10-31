import { fromWireToolCalls, toWireMessages, toWireTools, type WireToolCall } from './openai-tools.js';
import { AiError, ErrorCode } from '@xo/errors';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../provider-types.js';

export interface AzureOpenAiProviderOptions {
  readonly apiKey: string;
  /** e.g. "https://my-resource.openai.azure.com" — Azure's per-resource endpoint, distinct from OpenAI's shared api.openai.com. */
  readonly endpoint: string;
  /** Azure deployment name — Azure routes by deployment, not by the `model` field OpenAI/Anthropic use directly, so `ProviderRequest.model` is treated as the deployment name here. */
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
}

interface AzureChatCompletionResponse {
  readonly choices: readonly {
    readonly message: { readonly content: string | null; readonly tool_calls?: readonly WireToolCall[] };
    readonly finish_reason: string;
  }[];
  readonly usage: { readonly prompt_tokens: number; readonly completion_tokens: number };
  readonly model: string;
}

/**
 * Real Azure OpenAI integration. Same request/response *shape* as
 * `openai-provider.ts` (Azure OpenAI mirrors the OpenAI Chat Completions
 * API), but a distinct adapter because the URL structure, auth header,
 * and deployment-vs-model addressing all differ — collapsing the two
 * into one class with a flag would blur exactly the kind of
 * vendor-specific detail this package exists to keep out of everything
 * above `ModelProvider`.
 *
 * NOT live-verified in this sandbox (no network/API key) — see this
 * package's README.
 */
export class AzureOpenAiProvider implements ModelProvider {
  readonly id = 'azure-openai' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;

  constructor(private readonly options: AzureOpenAiProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiVersion = options.apiVersion ?? '2024-06-01';
  }

  describeCapabilities(): ProviderCapabilityDescriptor {
    return {
      providerId: 'azure-openai',
      models: ['gpt-4o'],
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsToolCalling: true,
      maxContextTokens: 128_000,
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const url = `${this.options.endpoint}/openai/deployments/${encodeURIComponent(request.model)}/chat/completions?api-version=${this.apiVersion}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': this.options.apiKey,
      },
      body: JSON.stringify({
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        messages: toWireMessages(request.messages),
        tools: toWireTools(request),
        response_format: request.responseSchema
          ? { type: 'json_schema', json_schema: { name: 'capability_output', schema: request.responseSchema, strict: true } }
          : undefined,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, `Azure OpenAI API returned ${response.status}: ${body}`);
    }

    const data = (await response.json()) as AzureChatCompletionResponse;
    const choice = data.choices[0];
    if (!choice) {
      throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, 'Azure OpenAI API returned no choices');
    }

    const toolCalls = fromWireToolCalls(choice.message.tool_calls, 'azure_call');
    if (toolCalls.length > 0 && choice.finish_reason !== 'tool_calls' && choice.finish_reason !== 'stop')
      throw new AiError(
        ErrorCode.AI_PROVIDER_REQUEST_FAILED,
        `Azure OpenAI returned tool calls with finish_reason "${choice.finish_reason}"; refusing to run them`,
      );
    return {
      text: choice.message.content ?? '',
      usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens },
      modelUsed: request.model,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason:
        toolCalls.length > 0
          ? 'tool_use'
          : choice.finish_reason === 'stop'
            ? 'stop'
            : choice.finish_reason === 'length'
              ? 'length'
              : choice.finish_reason === 'content_filter'
                ? 'content_filter'
                : 'error',
    };
  }
}
