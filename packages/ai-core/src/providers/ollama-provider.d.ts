import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../provider-types.js';
export interface OllamaProviderOptions {
    /** Ollama runs locally (or on a self-hosted server) — no API key by default, just a base URL. */
    readonly baseUrl?: string;
    readonly fetchImpl?: typeof fetch;
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
export declare class OllamaProvider implements ModelProvider {
    private readonly options;
    readonly id: "ollama";
    private readonly fetchImpl;
    private readonly baseUrl;
    constructor(options?: OllamaProviderOptions);
    describeCapabilities(): ProviderCapabilityDescriptor;
    complete(request: ProviderRequest): Promise<ProviderResponse>;
}
//# sourceMappingURL=ollama-provider.d.ts.map