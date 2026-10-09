import type { PackageId } from '@xo/types';
/**
 * How narrowly a permission grant/rule/request is bound. `global` is the
 * broadest (matches everything); every other kind narrows to a single
 * dimension. Extensible in the sense §5 asks for — a future kind is a new
 * union member plus one new `case` in {@link scopeContains} and
 * {@link scopeKey}, never a change to how existing kinds behave.
 */
export type PermissionScopeKind = 'global' | 'resource' | 'path' | 'host' | 'package' | 'capability';
export type PermissionScope = Readonly<{
    kind: 'global';
}> | Readonly<{
    kind: 'resource';
    resource: string;
}> | Readonly<{
    kind: 'path';
    path: string;
}> | Readonly<{
    kind: 'host';
    host: string;
}> | Readonly<{
    kind: 'package';
    packageId: PackageId;
}> | Readonly<{
    kind: 'capability';
    capabilityId: string;
}>;
export declare function globalScope(): PermissionScope;
export declare function resourceScope(resource: string): PermissionScope;
export declare function pathScope(path: string): PermissionScope;
export declare function hostScope(host: string): PermissionScope;
export declare function packageScope(packageId: PackageId): PermissionScope;
export declare function capabilityScope(capabilityId: string): PermissionScope;
/**
 * A stable, canonical string encoding of a scope — used as (part of) a
 * {@link import('./store.js').PermissionStore} grant key and for
 * deterministic sorting/deduping. Two scopes that are `deepEqual` produce
 * the same key; the reverse isn't guaranteed to matter (callers should
 * compare scopes structurally, not by string, for anything other than
 * storage keys).
 */
export declare function scopeKey(scope: PermissionScope): string;
/**
 * A rough specificity ranking used by the policy engine (see `policy.ts`)
 * to prefer the narrowest matching rule/grant. `global` is least specific;
 * `path` scales with how many segments it pins down, so
 * `/workspace/project` outranks `/workspace` — both are still `path`
 * scopes, but the deeper one says more.
 */
export declare function scopeSpecificity(scope: PermissionScope): number;
/**
 * The heart of §14/§18's explicit-scope-matching requirement: does the
 * `granted` scope (from a policy rule or a stored grant) authorize the
 * `requested` scope (from a `PermissionRequest`)?
 *
 * - `global` grants authorize any requested scope, including no scope at
 *   all (`requested === undefined`, treated as `global`).
 * - Every other kind requires the *same kind* on both sides — a
 *   `path`-scoped grant never authorizes a `host`-scoped request, even by
 *   accident of string overlap. This is what rules out wildcard escalation
 *   between unrelated scope dimensions.
 * - `path`: exact match, or `requested` is a true sub-path of `granted`
 *   (segment-boundary aware) — `/workspace` authorizes `/workspace/project`
 *   but never `/workspace-secret`, and `/workspace/project` never
 *   authorizes `/workspace/project-secret` (§14's own example).
 * - `host`: exact match, or `granted` is a `"*.suffix"` wildcard and
 *   `requested` ends with `.suffix` (or equals `suffix` itself is NOT
 *   matched by a `*.` wildcard — `*.example.com` matches `api.example.com`,
 *   not bare `example.com`, matching common DNS wildcard-cert semantics).
 * - `resource` / `package` / `capability`: exact match only — no partial or
 *   hierarchical matching, since there's no well-defined notion of "sub-
 *   resource" for these the way there is for filesystem paths.
 */
export declare function scopeContains(granted: PermissionScope, requested: PermissionScope | undefined): boolean;
/**
 * Runtime shape validator for a value that's supposed to be a
 * {@link PermissionScope} but may not have gone through TypeScript's type
 * checker to get here — e.g. a `PermissionConsentProvider` implemented by
 * an external host (Studio, a JS caller, something deserializing JSON
 * from IPC). `PermissionManager` uses this to fail closed on a
 * structurally malformed consent scope rather than trusting the branded
 * type blindly (§18's "no permission string spoofing" extends to scopes,
 * not just permission ids).
 */
export declare function isPermissionScope(value: unknown): value is PermissionScope;
/**
 * Whether `candidate` is the same as, or strictly narrower than, `requested`
 * — i.e. whether `requested` (or `global`, if `requested` is absent) would
 * itself authorize `candidate`. Built directly on {@link scopeContains}
 * rather than a second comparison (no duplicated matching logic): the
 * relation "does X authorize Y" is exactly "is Y within X's bound", just
 * named for this call site's direction of travel.
 *
 * This is the enforcement primitive behind "consent may narrow a
 * requested scope, but must never widen it" — see
 * `PermissionManager.request`'s consent-handling path in `manager.ts`,
 * which fails closed (denies) rather than granting when this returns
 * `false`.
 */
export declare function scopeWithinRequest(requested: PermissionScope | undefined, candidate: PermissionScope): boolean;
//# sourceMappingURL=scope.d.ts.map