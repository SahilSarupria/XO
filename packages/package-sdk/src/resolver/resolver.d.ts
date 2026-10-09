import type { XoManifest } from '@xo/types';
import { type Result } from '@xo/types';
import type { DependencyError } from '@xo/errors';
import { type ManifestLookup } from './dependency-graph.js';
import { type ResolvedDependency, type SkippedOptionalDependency } from './solver.js';
export interface DependencyResolution {
    readonly root: XoManifest;
    readonly resolved: readonly ResolvedDependency[];
    readonly skippedOptional: readonly SkippedOptionalDependency[];
}
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
export declare function resolveDependencies(root: XoManifest, lookup: ManifestLookup): Promise<Result<DependencyResolution, DependencyError>>;
//# sourceMappingURL=resolver.d.ts.map