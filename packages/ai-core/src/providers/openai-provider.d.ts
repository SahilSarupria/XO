import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../provider-types.js';
export interface OpenAiProviderOptions {
    readonly apiKey: string;
    readonly baseUrl?: string;
    readonly fetchImpl?: typeof fetch;
}
/**
 * Real OpenAI Chat Completions integration (`POST /v1/chat/completions`).
 * Uses `response_format: { type: "json_schema", ... }` when the request
 * carries a `responseSchema` — OpenAI's actual structured-output
 * mechanism, unlike Anthropic's (see anthropic-provider.ts), which is why
 * `ProviderCapabilityDescriptor.supportsStructuredOutput` differs
 * meaningfully per provider rather than being a decoration.
 *
 * NOT live-verified in this sandbox (no network/API key) — see this
 * package's README.
 */
export declare class OpenAiProvider implements ModelProvider {
    private readonly options;
    readonly id: "openai";
    private readonly fetchImpl;
    private readonly baseUrl;
    constructor(options: OpenAiProviderOptions);
    describeCapabilities(): ProviderCapabilityDescriptor;
    complete(request: ProviderRequest): Promise<ProviderResponse>;
}
//# sourceMappingURL=openai-provider.d.ts.map