import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../provider-types.js';
export interface AzureOpenAiProviderOptions {
    readonly apiKey: string;
    /** e.g. "https://my-resource.openai.azure.com" — Azure's per-resource endpoint, distinct from OpenAI's shared api.openai.com. */
    readonly endpoint: string;
    /** Azure deployment name — Azure routes by deployment, not by the `model` field OpenAI/Anthropic use directly, so `ProviderRequest.model` is treated as the deployment name here. */
    readonly apiVersion?: string;
    readonly fetchImpl?: typeof fetch;
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
export declare class AzureOpenAiProvider implements ModelProvider {
    private readonly options;
    readonly id: "azure-openai";
    private readonly fetchImpl;
    private readonly apiVersion;
    constructor(options: AzureOpenAiProviderOptions);
    describeCapabilities(): ProviderCapabilityDescriptor;
    complete(request: ProviderRequest): Promise<ProviderResponse>;
}
//# sourceMappingURL=azure-openai-provider.d.ts.map