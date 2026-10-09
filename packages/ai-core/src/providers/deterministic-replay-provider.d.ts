import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse, ProviderStreamEvent } from '../provider-types.js';
export interface ReplayFixture {
    readonly response: ProviderResponse;
}
/**
 * A provider backed by a fixed map of `request hash -> recorded
 * response`, rather than a live vendor call. This is what makes this
 * package's own tests (and, until a networked environment with real API
 * credentials is available, any caller's tests) actually runnable and
 * deterministic — "deterministic replay for tests" and "mock providers"
 * from the module spec are the same mechanism here: recording mode turns
 * a real provider's responses into fixtures; replay mode serves them back
 * with zero network calls and zero nondeterminism.
 *
 * A request hash that has no matching fixture throws
 * `AI_REPLAY_FIXTURE_MISSING` rather than silently returning empty output
 * — a missing fixture in a test is a signal the test needs a fixture
 * added, never something to paper over.
 */
export declare class DeterministicReplayProvider implements ModelProvider {
    private readonly descriptor;
    readonly id: "deterministic-replay";
    private readonly fixtures;
    constructor(descriptor?: ProviderCapabilityDescriptor);
    /** Records a canned response for a specific request shape — call this in test setup before exercising code that calls `complete()`. */
    record(request: ProviderRequest, response: ProviderResponse): void;
    describeCapabilities(): ProviderCapabilityDescriptor;
    complete(request: ProviderRequest): Promise<ProviderResponse>;
    completeStream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}
//# sourceMappingURL=deterministic-replay-provider.d.ts.map