import type { PackageId } from '@xo/types';

/**
 * How narrowly a permission grant/rule/request is bound. `global` is the
 * broadest (matches everything); every other kind narrows to a single
 * dimension. Extensible in the sense §5 asks for — a future kind is a new
 * union member plus one new `case` in {@link scopeContains} and
 * {@link scopeKey}, never a change to how existing kinds behave.
 */
export type PermissionScopeKind = 'global' | 'resource' | 'path' | 'host' | 'package' | 'capability';

export type PermissionScope =
  | Readonly<{ kind: 'global' }>
  | Readonly<{ kind: 'resource'; resource: string }>
  | Readonly<{ kind: 'path'; path: string }>
  | Readonly<{ kind: 'host'; host: string }>
  | Readonly<{ kind: 'package'; packageId: PackageId }>
  | Readonly<{ kind: 'capability'; capabilityId: string }>;

export function globalScope(): PermissionScope {
  return { kind: 'global' };
}
export function resourceScope(resource: string): PermissionScope {
  return { kind: 'resource', resource };
}
export function pathScope(path: string): PermissionScope {
  return { kind: 'path', path: normalizePath(path) };
}
export function hostScope(host: string): PermissionScope {
  return { kind: 'host', host: host.toLowerCase() };
}
export function packageScope(packageId: PackageId): PermissionScope {
  return { kind: 'package', packageId };
}
export function capabilityScope(capabilityId: string): PermissionScope {
  return { kind: 'capability', capabilityId };
}

function normalizePath(path: string): string {
  // Strip a single trailing slash (but keep root "/") so "/a/b" and "/a/b/"
  // are treated as the same scope — a purely cosmetic normalization, not a
  // semantic one; no ".." collapsing or symlink resolution happens here,
  // that's a filesystem-layer concern for whatever eventually implements
  // `filesystem.*` against a real disk.
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

/**
 * A stable, canonical string encoding of a scope — used as (part of) a
 * {@link import('./store.js').PermissionStore} grant key and for
 * deterministic sorting/deduping. Two scopes that are `deepEqual` produce
 * the same key; the reverse isn't guaranteed to matter (callers should
 * compare scopes structurally, not by string, for anything other than
 * storage keys).
 */
export function scopeKey(scope: PermissionScope): string {
  switch (scope.kind) {
    case 'global':
      return 'global';
    case 'resource':
      return `resource:${scope.resource}`;
    case 'path':
      return `path:${scope.path}`;
    case 'host':
      return `host:${scope.host}`;
    case 'package':
      return `package:${scope.packageId}`;
    case 'capability':
      return `capability:${scope.capabilityId}`;
  }
}

/**
 * A rough specificity ranking used by the policy engine (see `policy.ts`)
 * to prefer the narrowest matching rule/grant. `global` is least specific;
 * `path` scales with how many segments it pins down, so
 * `/workspace/project` outranks `/workspace` — both are still `path`
 * scopes, but the deeper one says more.
 */
export function scopeSpecificity(scope: PermissionScope): number {
  switch (scope.kind) {
    case 'global':
      return 0;
    case 'host':
      // A "*.example.com" wildcard host is less specific than a
      // fully-pinned host — see scopeContains's host case.
      return scope.host.startsWith('*.') ? 1 : 2;
    case 'resource':
    case 'package':
    case 'capability':
      return 2;
    case 'path':
      return 2 + scope.path.split('/').filter(Boolean).length;
  }
}

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
export function scopeContains(granted: PermissionScope, requested: PermissionScope | undefined): boolean {
  const effectiveRequested: PermissionScope = requested ?? globalScope();

  if (granted.kind === 'global') return true;
  if (effectiveRequested.kind === 'global') {
    // A non-global grant never authorizes an unscoped ("give me this
    // permission everywhere") request — that would be exactly the
    // wildcard escalation §18 forbids.
    return false;
  }
  if (granted.kind !== effectiveRequested.kind) return false;

  const narrowedGranted = granted as Exclude<PermissionScope, { kind: 'global' }>;

  switch (narrowedGranted.kind) {
    case 'path': {
      const requestedPath = (effectiveRequested as Extract<PermissionScope, { kind: 'path' }>).path;
      if (requestedPath === narrowedGranted.path) return true;
      return requestedPath.startsWith(narrowedGranted.path.endsWith('/') ? narrowedGranted.path : `${narrowedGranted.path}/`);
    }
    case 'host': {
      const requestedHost = (effectiveRequested as Extract<PermissionScope, { kind: 'host' }>).host;
      if (requestedHost === narrowedGranted.host) return true;
      if (narrowedGranted.host.startsWith('*.')) {
        const suffix = narrowedGranted.host.slice(1); // ".example.com"
        return requestedHost.endsWith(suffix) && requestedHost.length > suffix.length;
      }
      return false;
    }
    case 'resource':
      return narrowedGranted.resource === (effectiveRequested as Extract<PermissionScope, { kind: 'resource' }>).resource;
    case 'package':
      return narrowedGranted.packageId === (effectiveRequested as Extract<PermissionScope, { kind: 'package' }>).packageId;
    case 'capability':
      return narrowedGranted.capabilityId === (effectiveRequested as Extract<PermissionScope, { kind: 'capability' }>).capabilityId;
  }
}

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
export function isPermissionScope(value: unknown): value is PermissionScope {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  switch (kind) {
    case 'global':
      return true;
    case 'resource':
      return typeof (value as { resource?: unknown }).resource === 'string';
    case 'path':
      return typeof (value as { path?: unknown }).path === 'string';
    case 'host':
      return typeof (value as { host?: unknown }).host === 'string';
    case 'package':
      return typeof (value as { packageId?: unknown }).packageId === 'string';
    case 'capability':
      return typeof (value as { capabilityId?: unknown }).capabilityId === 'string';
    default:
      return false;
  }
}

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
export function scopeWithinRequest(requested: PermissionScope | undefined, candidate: PermissionScope): boolean {
  return scopeContains(requested ?? globalScope(), candidate);
}
