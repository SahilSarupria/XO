import type { ModelProvider, ProviderCapabilityDescriptor, ProviderId, ProviderRequest, ProviderResponse } from '../provider-types.js';
export type ScriptedOutcome = {
    readonly kind: 'success';
    readonly response: ProviderResponse;
} | {
    readonly kind: 'failure';
    readonly error: unknown;
};
/**
 * A test double for `ModelProvider` whose outcomes are scripted call-by-
 * call (success, failure, success, ...) — used by this package's own
 * tests to exercise retry/circuit-breaker/fallback behavior in
 * `router.test.ts` without any real provider or network call. This is
 * the AI-layer equivalent of `@xo/testing`'s `MockLogger`: a real,
 * working implementation of the port, scoped as a test utility rather
 * than a production default.
 */
export declare class ScriptableTestProvider implements ModelProvider {
    readonly id: ProviderId;
    private readonly descriptor;
    private readonly script;
    private cursor;
    readonly callLog: ProviderRequest[];
    constructor(id: ProviderId, script: readonly ScriptedOutcome[], descriptor?: ProviderCapabilityDescriptor);
    describeCapabilities(): ProviderCapabilityDescriptor;
    complete(request: ProviderRequest): Promise<ProviderResponse>;
}
export declare function jsonResponse(value: unknown, usage?: {
    inputTokens: number;
    outputTokens: number;
}, modelUsed?: string): ProviderResponse;
//# sourceMappingURL=scriptable-test-provider.d.ts.map