import { err, ok } from '@xo/types';
import { ErrorCode, DependencyError } from '@xo/errors';
import { compareSemVer, parseSemVer, satisfiesRange } from '../manifest/semver.js';
/**
 * Picks the highest version in `pool` that satisfies every range in
 * `ranges` simultaneously — the actual "does any real version satisfy
 * everyone who wants this package" check. Returns `undefined` if no
 * single version does (either because `pool` is empty, or because the
 * ranges themselves don't overlap on any available version).
 *
 * Known limitation: this is minimal/highest-version selection per
 * package name, evaluated independently per name — it does not attempt
 * global backtracking across packages (e.g. downgrading an already-
 * chosen package to unblock a different one). See `dependency-graph.ts`'s
 * doc comment for the matching limitation on the traversal side.
 */
function pickBestSatisfyingAll(pool, ranges) {
    let best;
    let bestParsed;
    for (const candidate of pool) {
        const parsed = parseSemVer(candidate.version);
        if (!parsed.ok)
            continue;
        const satisfiesEvery = ranges.every((range) => {
            const result = satisfiesRange(candidate.version, range);
            return result.ok && result.value;
        });
        if (!satisfiesEvery)
            continue;
        if (!best || !bestParsed || (bestParsed.ok && compareSemVer(parsed.value, bestParsed.value) > 0)) {
            best = candidate;
            bestParsed = parsed;
        }
    }
    return best;
}
function describeRequirements(name, edges) {
    return edges.map((e) => `"${e.requester}" requires "${name}@${e.versionRange}"`).join(' and ');
}
/**
 * Given a fully-walked {@link DependencyGraph}, selects a specific
 * version for every `required` dependency name, resolves `optional`
 * dependencies best-effort (never failing the overall resolve), and
 * checks every `peer` requirement against whatever was resolved through
 * the required/optional paths — never resolving a peer independently,
 * per the brief this module was built against.
 */
export function solveDependencyGraph(graph) {
    const requiredEdges = new Map();
    const optionalEdges = new Map();
    const peerEdges = new Map();
    for (const edge of graph.edges) {
        const bucket = edge.kind === 'peer' ? peerEdges : edge.kind === 'optional' ? optionalEdges : requiredEdges;
        const list = bucket.get(edge.dependencyName);
        if (list)
            list.push(edge);
        else
            bucket.set(edge.dependencyName, [edge]);
    }
    const resolved = new Map();
    for (const [name, edges] of requiredEdges) {
        const pool = graph.candidates.get(name) ?? [];
        const chosen = pickBestSatisfyingAll(pool, edges.map((e) => e.versionRange));
        if (chosen) {
            resolved.set(name, { name, version: chosen.version, manifest: chosen });
            continue;
        }
        if (pool.length === 0) {
            return err(new DependencyError(ErrorCode.PACKAGE_DEPENDENCY_UNRESOLVED, `No package named "${name}" could be found (requested by: ${describeRequirements(name, edges)})`));
        }
        return err(new DependencyError(ErrorCode.PACKAGE_DEPENDENCY_CONFLICT, `No available version of "${name}" satisfies every requirement: ${describeRequirements(name, edges)}`));
    }
    const skippedOptional = [];
    for (const [name, edges] of optionalEdges) {
        if (resolved.has(name))
            continue; // already satisfied via a required edge
        const pool = graph.candidates.get(name) ?? [];
        const chosen = pickBestSatisfyingAll(pool, edges.map((e) => e.versionRange));
        if (chosen) {
            resolved.set(name, { name, version: chosen.version, manifest: chosen });
            continue;
        }
        const reason = pool.length === 0 ? `no package named "${name}" is available` : `no available version of "${name}" satisfies every requested range`;
        for (const edge of edges) {
            skippedOptional.push({ name, versionRange: edge.versionRange, requestedBy: edge.requester, reason });
        }
    }
    for (const [name, edges] of peerEdges) {
        const already = resolved.get(name);
        for (const edge of edges) {
            if (!already) {
                return err(new DependencyError(ErrorCode.PACKAGE_DEPENDENCY_CONFLICT, `Peer dependency "${name}" (required by "${edge.requester}" at range "${edge.versionRange}") is not resolved by any required or optional dependency`));
            }
            const satisfied = satisfiesRange(already.version, edge.versionRange);
            if (!satisfied.ok || !satisfied.value) {
                return err(new DependencyError(ErrorCode.PACKAGE_DEPENDENCY_CONFLICT, `Peer dependency "${name}"@${already.version} (resolved via another dependency) does not satisfy "${edge.requester}"'s peer requirement "${edge.versionRange}"`));
            }
        }
    }
    return ok({
        resolved: [...resolved.values()].sort((a, b) => a.name.localeCompare(b.name)),
        skippedOptional: skippedOptional.sort((a, b) => a.name.localeCompare(b.name)),
    });
}
//# sourceMappingURL=solver.js.map