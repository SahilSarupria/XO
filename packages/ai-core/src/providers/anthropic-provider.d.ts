import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../provider-types.js';
export interface AnthropicProviderOptions {
    readonly apiKey: string;
    readonly baseUrl?: string;
    readonly apiVersion?: string;
    readonly fetchImpl?: typeof fetch;
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
export declare class AnthropicProvider implements ModelProvider {
    private readonly options;
    readonly id: "anthropic";
    private readonly fetchImpl;
    private readonly baseUrl;
    private readonly apiVersion;
    constructor(options: AnthropicProviderOptions);
    describeCapabilities(): ProviderCapabilityDescriptor;
    complete(request: ProviderRequest): Promise<ProviderResponse>;
}
//# sourceMappingURL=anthropic-provider.d.ts.map