/**
 * The provider abstraction — the ONE boundary in this package that knows
 * anything about "OpenAI" vs "Anthropic" vs "Gemini" vs "Ollama" vs
 * "Azure OpenAI". Everything above `ModelProvider` (capabilities.ts,
 * router.ts) talks only in these vendor-neutral request/response shapes;
 * everything below it (providers/*.ts) is one file per vendor translating
 * this shape into that vendor's actual HTTP contract. A caller of
 * `AiCapabilityLayer` never sees any of this directly — see
 * capability-types.ts for the layer callers actually interact with.
 */

export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'azure-openai' | 'ollama' | 'deterministic-replay' | (string & {});

/** A tool the model may call. `inputSchema` is a JSON Schema object (`type: 'object'`). */
export interface ProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** One tool invocation requested by the model. `id` is provider-assigned and must be echoed back on the matching `tool` message. */
export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ProviderMessage {
  /** `'tool'` carries the result of one `ProviderToolCall` back to the model (`toolCallId` required). */
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** Only on `role: 'assistant'` — the tool calls that turn requested (alongside any `content` text). */
  readonly toolCalls?: readonly ProviderToolCall[];
  /** Only on `role: 'tool'` — which call this answers. */
  readonly toolCallId?: string;
  /** Only on `role: 'tool'` — the tool failed; `content` is the error text. */
  readonly isError?: boolean;
}

export interface ProviderRequest {
  readonly model: string;
  readonly messages: readonly ProviderMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /** When set, the provider must return output conforming to this JSON Schema-shaped object (mapped to each vendor's own "structured output" / "JSON mode" / "tool forcing" mechanism in that provider's adapter). */
  readonly responseSchema?: Readonly<Record<string, unknown>>;
  /** Tools the model may call this turn. A provider that does not support tool calling MUST reject a request that sets this (never silently drop it — the caller's behavior depends on tools being available). */
  readonly tools?: readonly ProviderToolDefinition[];
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ProviderResponse {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly modelUsed: string;
  readonly finishReason: 'stop' | 'length' | 'content_filter' | 'error' | 'tool_use';
  /** Present (non-empty) iff `finishReason === 'tool_use'`. */
  readonly toolCalls?: readonly ProviderToolCall[];
}

export type ProviderStreamEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'done'; readonly usage: TokenUsage; readonly finishReason: ProviderResponse['finishReason'] };

/**
 * What a provider can do — consulted by `model-selection.ts` when
 * choosing (and ordering) candidate providers for a capability request,
 * and by callers doing their own capability discovery
 * (`AiCapabilityLayer#describeProviders()`). A provider that can't do
 * structured output, for instance, is either skipped for a capability
 * that requires it or has its request degraded to "ask nicely in the
 * prompt and validate after the fact" — that policy lives in
 * `router.ts`, not here; this is pure description.
 */
export interface ProviderCapabilityDescriptor {
  readonly providerId: ProviderId;
  readonly models: readonly string[];
  readonly supportsStreaming: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsVision: boolean;
  /** Optional for backward compatibility — absent means `false`. */
  readonly supportsToolCalling?: boolean;
  readonly maxContextTokens: number;
}

export interface ModelProvider {
  readonly id: ProviderId;
  describeCapabilities(): ProviderCapabilityDescriptor;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  /** Optional — a provider that can't stream simply omits this; `router.ts` falls back to a single non-streaming `complete()` call and emits it as one `text_delta` + `done`. */
  completeStream?(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}
