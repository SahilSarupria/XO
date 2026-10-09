import type { ManifestPermissionDeclaration } from '@xo/types';
import { type Result } from '@xo/types';
import type { PermissionRequirement } from './capability-mapping.js';
/**
 * Parses one `@xo/types` `ManifestPermissionDeclaration` (plain strings, as
 * they appear in a manifest read off disk) into a typed
 * {@link PermissionRequirement}, or an error string if the declaration is
 * malformed — never throws, since manifest content is untrusted input
 * (§18's "fail closed" applies to parsing too: a malformed declaration
 * must be rejected, never silently coerced into `global` scope).
 *
 * A manifest declares a scope as a single string (`"/workspace"`,
 * `"api.example.com"`) with no explicit `scopeKind` — see
 * `ManifestPermissionDeclaration`'s doc comment in `@xo/types` for why.
 * This resolves the kind from the permission's *domain*, since in
 * practice the domain determines what a scope string means for that
 * permission: `filesystem.*` scopes are paths, `network.*` scopes are
 * hosts, everything else is an opaque named resource. This is a
 * deliberate, documented heuristic, not a general-purpose scope grammar —
 * a permission that needs a different scope shape than its domain's
 * default should be requested with an explicit `PermissionScope` via the
 * programmatic API (`request.ts`) rather than through a manifest string.
 */
export declare function parseManifestPermission(declaration: ManifestPermissionDeclaration): Result<PermissionRequirement, string>;
/**
 * Parses every permission declaration on a manifest. Collects all parse
 * errors rather than stopping at the first, so a manifest author (or a
 * host validating a package before install) sees every problem at once —
 * matching `@xo/package-sdk`'s `PackageValidator` convention of returning
 * every issue in one pass.
 */
export declare function resolveManifestPermissions(manifest: {
    readonly permissions?: readonly ManifestPermissionDeclaration[];
}): Result<readonly PermissionRequirement[], readonly string[]>;
/**
 * Groups every manifest permission declaration that names a
 * `capabilityId` into a per-capability requirement list — the mechanism
 * `@xo/runtime`'s `PermissionGate` uses to resolve what a specific
 * capability needs directly from `MountedPackage.manifest`, with no
 * separate manual registration step (Stage 2 §4: "permission registration
 * [must not be] something every host developer must remember to do
 * manually"). Declarations with no `capabilityId` are intentionally
 * excluded from the returned map — they're package-level notices, never
 * enforced against a specific capability (see
 * `ManifestPermissionDeclaration`'s doc comment in `@xo/types`).
 *
 * Reuses {@link parseManifestPermission} rather than re-implementing
 * parsing (no duplicated manifest-parsing logic). Collects every error
 * across every declaration, same as {@link resolveManifestPermissions} —
 * a caller enforcing this (e.g. `@xo/runtime`'s `PackageLoader.mount` or
 * `PermissionGate`) is expected to fail closed on any error rather than
 * silently treating the affected capability as permissionless: a
 * capability whose author *wrote* a permission declaration for it, that
 * declaration turning out to be unparseable, is a "privileged capability
 * whose requirements couldn't be represented" — not "no requirements".
 */
export declare function resolveManifestCapabilityPermissions(manifest: {
    readonly permissions?: readonly ManifestPermissionDeclaration[];
}): Result<ReadonlyMap<string, readonly PermissionRequirement[]>, readonly string[]>;
//# sourceMappingURL=manifest.d.ts.map