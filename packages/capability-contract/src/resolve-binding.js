/**
 * Runs `resolvers` in order against `contract`, returning the first
 * outcome any resolver actually produces (a resolver returning `undefined`
 * means "not applicable," and is skipped, not treated as `unresolved`).
 *
 * If every resolver is silent, the result is `unresolved` with a reason
 * naming every resolver that was tried — never silently reported as
 * "no binding," which would be indistinguishable from a caller forgetting
 * to pass any resolvers at all.
 *
 * Deliberately does not attempt any tiebreak/scoring between multiple
 * `resolved` outcomes from different resolvers — v1 ships exactly one
 * resolver (`StructuredComparisonBindingResolver`), so that case cannot
 * occur yet. A future resolver set that *can* produce competing
 * `resolved` outcomes for the same contract must decide its own
 * tiebreak policy explicitly (or return `ambiguous` itself) rather than
 * this function silently picking "first resolver wins" for a case it
 * was never designed to arbitrate.
 */
export function resolveCapabilityBinding(contract, resolvers) {
    if (resolvers.length === 0) {
        return { status: 'unresolved', reason: 'No BindingResolvers were configured' };
    }
    const tried = [];
    const outcomes = [];
    for (const resolver of resolvers) {
        tried.push(resolver.name);
        const outcome = resolver.resolve(contract);
        if (outcome === undefined)
            continue;
        outcomes.push({ resolverName: resolver.name, outcome });
    }
    const resolved = outcomes.filter((o) => o.outcome.status === 'resolved');
    if (resolved.length === 1)
        return resolved[0].outcome;
    if (resolved.length > 1) {
        return { status: 'ambiguous', reason: `${resolved.length} resolvers (${resolved.map((o) => o.resolverName).join(', ')}) each produced a "resolved" binding for contract "${contract.id}" with no configured tiebreak`, candidateCount: resolved.length };
    }
    const denied = outcomes.find((o) => o.outcome.status === 'denied');
    if (denied)
        return denied.outcome;
    const unresolvedReasons = outcomes.filter((o) => o.outcome.status === 'unresolved').map((o) => `${o.resolverName}: ${o.outcome.reason}`);
    if (unresolvedReasons.length > 0) {
        return { status: 'unresolved', reason: unresolvedReasons.join(' | ') };
    }
    return { status: 'unresolved', reason: `No configured resolver (tried: ${tried.join(', ')}) had an opinion about contract "${contract.id}"` };
}
//# sourceMappingURL=resolve-binding.js.map