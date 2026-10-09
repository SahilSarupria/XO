import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../provider-types.js';
export interface GeminiProviderOptions {
    readonly apiKey: string;
    readonly baseUrl?: string;
    readonly fetchImpl?: typeof fetch;
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
export declare class GeminiProvider implements ModelProvider {
    private readonly options;
    readonly id: "gemini";
    private readonly fetchImpl;
    private readonly baseUrl;
    constructor(options: GeminiProviderOptions);
    describeCapabilities(): ProviderCapabilityDescriptor;
    complete(request: ProviderRequest): Promise<ProviderResponse>;
}
//# sourceMappingURL=gemini-provider.d.ts.map