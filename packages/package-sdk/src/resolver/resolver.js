import { err, ok } from '@xo/types';
import { buildDependencyGraph } from './dependency-graph.js';
import { solveDependencyGraph } from './solver.js';
/**
 * The public entry point for `@xo/package-sdk`'s dependency resolver:
 * given a root manifest and a `lookup` function for discovering other
 * manifests, produces either every dependency `root` needs (required,
 * satisfiable optional, and peer-checked) or a specific, actionable
 * error — which package, which conflicting ranges, or where a cycle
 * closed. Ties together `dependency-graph.ts` (discover requirements) and
 * `solver.ts` (pick versions / detect conflicts); callers that want to
 * inspect the two phases separately can call those modules directly
 * instead.
 *
 * Deliberately out of scope here (per the brief this was built against):
 * fetching packages over a network, writing a lockfile (see
 * `lockfile.ts`), and installing anything — this function only answers
 * "what would resolve", exactly like `PackageValidator` only answers
 * "is this bundle valid" without ever installing it.
 */
export async function resolveDependencies(root, lookup) {
    const graphResult = await buildDependencyGraph(root, lookup);
    if (!graphResult.ok)
        return err(graphResult.error);
    const solveResult = solveDependencyGraph(graphResult.value);
    if (!solveResult.ok)
        return err(solveResult.error);
    return ok({ root, resolved: solveResult.value.resolved, skippedOptional: solveResult.value.skippedOptional });
}
//# sourceMappingURL=resolver.js.map