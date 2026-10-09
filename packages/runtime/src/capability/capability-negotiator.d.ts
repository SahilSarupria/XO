import { type CompatibilityResolution } from '@xo/package-sdk';
import type { CapabilityDescriptor } from './capability-descriptor.js';
import type { RuntimeContext } from '../runtime-context.js';
import type { ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionPlan, RankedCandidate } from '../execution/execution-plan.js';
import type { RuntimeInstrumentation } from '../observability/instrumentation.js';
export interface CapabilityNegotiatorOptions {
    readonly now?: () => Date;
    readonly instrumentation?: RuntimeInstrumentation;
}
interface ResolvedCandidate {
    readonly capability: CapabilityDescriptor;
    readonly compatibility: CompatibilityResolution;
}
/**
 * Turns an {@link ExecutionRequest} into an {@link ExecutionPlan} — "pure
 * deterministic planning", no AI reasoning anywhere in this class. Every
 * step SPECIFICATION.md's Runtime Stage 1 goal calls for is a distinct,
 * separately-testable method: {@link discoverCandidates},
 * {@link filterIncompatible}, {@link resolveDuplicates}, and
 * {@link rank}, composed by {@link plan}.
 */
export declare class CapabilityNegotiator {
    private readonly now;
    private readonly instrumentation;
    constructor(options?: CapabilityNegotiatorOptions);
    /** Exact `capabilityId` match if the request gave one, else a `query` substring match, else nothing. Never combines both — an exact id is authoritative when present. */
    discoverCandidates(request: ExecutionRequest, context: RuntimeContext): readonly CapabilityDescriptor[];
    /**
     * Resolves each candidate's compatibility against the request's
     * `HostProfile` (`resolveCompatibility`, `@xo/package-sdk`) and drops
     * any whose package reached only `L0` *and* declares `fallbackPolicy:
     * 'reject'` for that case — a package that instead declares
     * `degrade_gracefully` is kept even at `L0`, since its creator
     * explicitly opted into being usable in a degraded form rather than
     * excluded outright.
     */
    filterIncompatible(candidates: readonly CapabilityDescriptor[], request: ExecutionRequest, context: RuntimeContext): readonly ResolvedCandidate[];
    /**
     * Collapses multiple mounted *versions of the same package* offering
     * the same capability id down to the single highest version — a
     * package doesn't get to occupy more than one slot in the ranking just
     * because several of its versions happen to be mounted simultaneously.
     * Distinct *packages* that happen to declare the same capability id are
     * never deduplicated against each other; that's genuine competition
     * for {@link rank} to order, not a duplicate to resolve.
     */
    resolveDuplicates(resolved: readonly ResolvedCandidate[]): readonly ResolvedCandidate[];
    /**
     * Orders candidates deterministically: reached compatibility level
     * (higher first), then declared confidence score (higher first), then
     * estimated latency (lower first), then estimated cost (lower first),
     * with package name then version as a final, fully deterministic
     * tiebreaker so two runs over the same `RuntimeContext` always produce
     * the exact same order.
     */
    rank(resolved: readonly ResolvedCandidate[]): readonly RankedCandidate[];
    /** Runs discovery, incompatibility filtering, duplicate resolution, and ranking in sequence, producing the final immutable {@link ExecutionPlan}. */
    plan(request: ExecutionRequest, context: RuntimeContext): ExecutionPlan;
}
export {};
//# sourceMappingURL=capability-negotiator.d.ts.map