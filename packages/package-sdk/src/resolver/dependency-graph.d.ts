import type { DependencyKind, XoManifest } from '@xo/types';
import { type Result } from '@xo/types';
import { DependencyError } from '@xo/errors';
/**
 * Resolves every known manifest for a package name (e.g. every published
 * version a registry/local index currently has) — supplied by the
 * caller so this module never assumes a network call or invents a
 * registry client that doesn't exist yet. An unknown name resolves to an
 * empty array, not a rejected promise; "no such package" is a normal,
 * expected outcome the solver has to handle, not an exceptional one.
 */
export type ManifestLookup = (name: string) => Promise<readonly XoManifest[]>;
/** One `requester` -> `dependencyName` requirement discovered while walking the tree, before any version has been chosen for `dependencyName`. */
export interface DependencyEdge {
    readonly requester: string;
    readonly requesterVersion: string;
    readonly dependencyName: string;
    readonly versionRange: string;
    readonly kind: DependencyKind;
}
/**
 * The result of walking `root`'s dependency tree: every requirement edge
 * discovered, plus the candidate manifest pool `lookup` returned for
 * each distinct dependency name encountered (fetched at most once per
 * name). `solver.ts` consumes this to pick actual versions — this module
 * only discovers *what* is required, never *which* version wins.
 */
export interface DependencyGraph {
    readonly root: XoManifest;
    readonly edges: readonly DependencyEdge[];
    readonly candidates: ReadonlyMap<string, readonly XoManifest[]>;
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
export declare function buildDependencyGraph(root: XoManifest, lookup: ManifestLookup): Promise<Result<DependencyGraph, DependencyError>>;
//# sourceMappingURL=dependency-graph.d.ts.map