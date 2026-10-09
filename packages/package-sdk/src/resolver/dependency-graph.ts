import type { DependencyKind, XoManifest } from '@xo/types';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, DependencyError } from '@xo/errors';
import { compareSemVer, parseSemVer, satisfiesRange } from '../manifest/semver.js';

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

/** Picks the highest version in `pool` that satisfies `range`, or `undefined` if none does (including when `pool` is empty). Used only to choose *which* candidate to recurse into while walking the tree — final version selection across every requester is `solver.ts`'s job, so this is a local, single-requirement choice, not the resolver's answer. */
function pickHighestSatisfying(pool: readonly XoManifest[], range: string): XoManifest | undefined {
  let best: XoManifest | undefined;
  let bestParsed: ReturnType<typeof parseSemVer> | undefined;
  for (const candidate of pool) {
    const satisfied = satisfiesRange(candidate.version, range);
    if (!satisfied.ok || !satisfied.value) continue;
    const parsed = parseSemVer(candidate.version);
    if (!parsed.ok) continue;
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
export async function buildDependencyGraph(root: XoManifest, lookup: ManifestLookup): Promise<Result<DependencyGraph, DependencyError>> {
  const edges: DependencyEdge[] = [];
  const candidates = new Map<string, readonly XoManifest[]>();

  async function candidatesFor(name: string): Promise<readonly XoManifest[]> {
    const cached = candidates.get(name);
    if (cached) return cached;
    const found = await lookup(name);
    candidates.set(name, found);
    return found;
  }

  async function visit(manifest: XoManifest, pathStack: readonly string[]): Promise<Result<void, DependencyError>> {
    for (const dependency of manifest.dependencies ?? []) {
      edges.push({
        requester: manifest.name,
        requesterVersion: manifest.version,
        dependencyName: dependency.name,
        versionRange: dependency.versionRange,
        kind: dependency.kind,
      });

      if (dependency.kind === 'peer') continue; // checked later against what's already resolved, never traversed independently

      if (pathStack.includes(dependency.name)) {
        return err(
          new DependencyError(
            ErrorCode.PACKAGE_DEPENDENCY_CYCLE,
            `Dependency cycle detected: ${[...pathStack, dependency.name].join(' -> ')}`,
          ),
        );
      }

      const pool = await candidatesFor(dependency.name);
      const chosen = pickHighestSatisfying(pool, dependency.versionRange);
      if (!chosen) continue; // unresolvable here — solver.ts reports this (differently for required vs. optional) once it sees the full edge set

      const sub = await visit(chosen, [...pathStack, dependency.name]);
      if (!sub.ok) return sub;
    }
    return ok(undefined);
  }

  const result = await visit(root, [root.name]);
  if (!result.ok) return result;
  return ok({ root, edges, candidates });
}
