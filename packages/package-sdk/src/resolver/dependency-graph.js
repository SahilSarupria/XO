import { err, ok } from '@xo/types';
import { ErrorCode, DependencyError } from '@xo/errors';
import { compareSemVer, parseSemVer, satisfiesRange } from '../manifest/semver.js';
/** Picks the highest version in `pool` that satisfies `range`, or `undefined` if none does (including when `pool` is empty). Used only to choose *which* candidate to recurse into while walking the tree — final version selection across every requester is `solver.ts`'s job, so this is a local, single-requirement choice, not the resolver's answer. */
function pickHighestSatisfying(pool, range) {
    let best;
    let bestParsed;
    for (const candidate of pool) {
        const satisfied = satisfiesRange(candidate.version, range);
        if (!satisfied.ok || !satisfied.value)
            continue;
        const parsed = parseSemVer(candidate.version);
        if (!parsed.ok)
            continue;
        if (!best || !bestParsed || (bestParsed.ok && compareSemVer(parsed.value, bestParsed.value) > 0)) {
            best = candidate;
            bestParsed = parsed;
        }
    }
    return best;
}
/**
 * Walks `root`'s dependency tree via `lookup`, following `required` and
 * `optional` edges (a `peer` edge is recorded but never traversed
 * independently — see {@link DependencyEdge} and `solver.ts`'s peer
 * handling) and detecting name-level cycles as it goes.
 *
 * Known limitation (stated honestly, not smoothed over): to know a
 * candidate's own sub-dependencies before any version has been finally
 * selected, this traversal greedily recurses into the *highest version
 * satisfying the single edge that discovered it* — it does not
 * backtrack if a later-discovered constraint would have preferred a
 * different version whose sub-dependencies differ. This is the same
 * simplification `solver.ts`'s own selection makes (see its doc comment)
 * and is sufficient for well-behaved dependency trees (including
 * diamonds where sub-dependency sets agree across versions); a resolver
 * that needed full backtracking/SAT-style search would be a
 * substantially larger undertaking than this pass scoped.
 */
export async function buildDependencyGraph(root, lookup) {
    const edges = [];
    const candidates = new Map();
    async function candidatesFor(name) {
        const cached = candidates.get(name);
        if (cached)
            return cached;
        const found = await lookup(name);
        candidates.set(name, found);
        return found;
    }
    async function visit(manifest, pathStack) {
        for (const dependency of manifest.dependencies ?? []) {
            edges.push({
                requester: manifest.name,
                requesterVersion: manifest.version,
                dependencyName: dependency.name,
                versionRange: dependency.versionRange,
                kind: dependency.kind,
            });
            if (dependency.kind === 'peer')
                continue; // checked later against what's already resolved, never traversed independently
            if (pathStack.includes(dependency.name)) {
                return err(new DependencyError(ErrorCode.PACKAGE_DEPENDENCY_CYCLE, `Dependency cycle detected: ${[...pathStack, dependency.name].join(' -> ')}`));
            }
            const pool = await candidatesFor(dependency.name);
            const chosen = pickHighestSatisfying(pool, dependency.versionRange);
            if (!chosen)
                continue; // unresolvable here — solver.ts reports this (differently for required vs. optional) once it sees the full edge set
            const sub = await visit(chosen, [...pathStack, dependency.name]);
            if (!sub.ok)
                return sub;
        }
        return ok(undefined);
    }
    const result = await visit(root, [root.name]);
    if (!result.ok)
        return result;
    return ok({ root, edges, candidates });
}
//# sourceMappingURL=dependency-graph.js.map