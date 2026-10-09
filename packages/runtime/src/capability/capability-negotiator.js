import { resolveCompatibility } from '@xo/package-sdk';
import { PlanId } from '../ids.js';
import { compareVersionStrings } from '../util/version-order.js';
const LEVEL_ORDER = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
/**
 * Turns an {@link ExecutionRequest} into an {@link ExecutionPlan} — "pure
 * deterministic planning", no AI reasoning anywhere in this class. Every
 * step SPECIFICATION.md's Runtime Stage 1 goal calls for is a distinct,
 * separately-testable method: {@link discoverCandidates},
 * {@link filterIncompatible}, {@link resolveDuplicates}, and
 * {@link rank}, composed by {@link plan}.
 */
export class CapabilityNegotiator {
    now;
    instrumentation;
    constructor(options = {}) {
        this.now = options.now ?? (() => new Date());
        this.instrumentation = options.instrumentation;
    }
    /** Exact `capabilityId` match if the request gave one, else a `query` substring match, else nothing. Never combines both — an exact id is authoritative when present. */
    discoverCandidates(request, context) {
        if (request.capabilityId !== undefined)
            return context.capabilities.find(request.capabilityId);
        if (request.query !== undefined)
            return context.capabilities.search(request.query);
        return [];
    }
    /**
     * Resolves each candidate's compatibility against the request's
     * `HostProfile` (`resolveCompatibility`, `@xo/package-sdk`) and drops
     * any whose package reached only `L0` *and* declares `fallbackPolicy:
     * 'reject'` for that case — a package that instead declares
     * `degrade_gracefully` is kept even at `L0`, since its creator
     * explicitly opted into being usable in a degraded form rather than
     * excluded outright.
     */
    filterIncompatible(candidates, request, context) {
        const resolved = [];
        for (const capability of candidates) {
            const mounted = context.registry.get(capability.packageName, capability.packageVersion);
            if (!mounted)
                continue; // defensive: registry and capability index are built together, so this should be unreachable
            const compatibility = resolveCompatibility(mounted.manifest, request.environment.hostProfile);
            const rejectedAtL0 = compatibility.reachedLevel === 'L0' && mounted.manifest.compatibility.fallbackPolicy === 'reject';
            if (!rejectedAtL0)
                resolved.push({ capability, compatibility });
        }
        return resolved;
    }
    /**
     * Collapses multiple mounted *versions of the same package* offering
     * the same capability id down to the single highest version — a
     * package doesn't get to occupy more than one slot in the ranking just
     * because several of its versions happen to be mounted simultaneously.
     * Distinct *packages* that happen to declare the same capability id are
     * never deduplicated against each other; that's genuine competition
     * for {@link rank} to order, not a duplicate to resolve.
     */
    resolveDuplicates(resolved) {
        const bestByPackageAndCapability = new Map();
        for (const candidate of resolved) {
            const key = `${candidate.capability.packageName}::${candidate.capability.declaration.id}`;
            const existing = bestByPackageAndCapability.get(key);
            if (!existing || compareVersionStrings(candidate.capability.packageVersion, existing.capability.packageVersion) > 0) {
                bestByPackageAndCapability.set(key, candidate);
            }
        }
        return [...bestByPackageAndCapability.values()];
    }
    /**
     * Orders candidates deterministically: reached compatibility level
     * (higher first), then declared confidence score (higher first), then
     * estimated latency (lower first), then estimated cost (lower first),
     * with package name then version as a final, fully deterministic
     * tiebreaker so two runs over the same `RuntimeContext` always produce
     * the exact same order.
     */
    rank(resolved) {
        const sorted = [...resolved].sort((a, b) => {
            const levelDiff = LEVEL_ORDER[b.compatibility.reachedLevel] - LEVEL_ORDER[a.compatibility.reachedLevel];
            if (levelDiff !== 0)
                return levelDiff;
            const confidenceDiff = b.capability.declaration.confidence.score - a.capability.declaration.confidence.score;
            if (confidenceDiff !== 0)
                return confidenceDiff;
            const latencyDiff = a.capability.declaration.estimatedLatencyMs - b.capability.declaration.estimatedLatencyMs;
            if (latencyDiff !== 0)
                return latencyDiff;
            const costDiff = a.capability.declaration.estimatedCost.amount - b.capability.declaration.estimatedCost.amount;
            if (costDiff !== 0)
                return costDiff;
            const nameDiff = a.capability.packageName.localeCompare(b.capability.packageName);
            if (nameDiff !== 0)
                return nameDiff;
            return compareVersionStrings(a.capability.packageVersion, b.capability.packageVersion);
        });
        return sorted.map((candidate, index) => ({ ...candidate, rank: index }));
    }
    /** Runs discovery, incompatibility filtering, duplicate resolution, and ranking in sequence, producing the final immutable {@link ExecutionPlan}. */
    plan(request, context) {
        const startedAt = this.now().getTime();
        const discovered = this.discoverCandidates(request, context);
        const compatible = this.filterIncompatible(discovered, request, context);
        const deduplicated = this.resolveDuplicates(compatible);
        const ranked = this.rank(deduplicated);
        const status = ranked.length > 0 ? 'planned' : discovered.length === 0 ? 'no_candidates' : 'no_compatible_candidate';
        const plan = Object.freeze({
            planId: PlanId(`plan_${request.requestId}`),
            requestId: request.requestId,
            status,
            candidates: ranked,
            ...(ranked[0] ? { selected: ranked[0] } : {}),
            plannedAt: this.now().toISOString(),
        });
        this.instrumentation?.recordPlanningLatency(this.now().getTime() - startedAt, {
            status,
            candidateCount: discovered.length,
        });
        return plan;
    }
}
//# sourceMappingURL=capability-negotiator.js.map