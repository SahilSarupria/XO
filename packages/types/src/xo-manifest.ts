import type { ComponentKind, CompatibilityDeclaration } from './compatibility.js';
import type { ContentHash } from './ids.js';
import type { CapabilityDeclaration } from './xo-capability.js';

export interface ComponentEntry {
  readonly path: string;
  readonly hash: ContentHash;
  readonly required: boolean;
}

/**
 * How strictly a declared dependency binds the resolver:
 * - `required` — must be resolved for the package to be usable at all.
 * - `optional` — nice-to-have; a resolution failure here must not fail
 *   the whole resolve.
 * - `peer` — the declaring package expects its host environment (or
 *   another package already being resolved) to provide this.
 */
export type DependencyKind = 'required' | 'optional' | 'peer';

export interface DependencyDeclaration {
  readonly name: string;
  readonly versionRange: string;
  readonly kind: DependencyKind;
}

/**
 * A single permission a package declares it may need at runtime (e.g.
 * `"filesystem.read"`, scoped to `"/workspace"`). Deliberately typed with
 * plain strings, not `@xo/permissions`' branded `PermissionId`/
 * `PermissionScope` — `@xo/types` sits below `@xo/permissions` in the
 * dependency graph (almost everything depends on `@xo/types`; it must not
 * depend back on a domain package), so this module only models the
 * manifest's on-disk shape. `@xo/permissions`' `resolveManifestPermissions`
 * is what parses/validates these strings into its own typed model.
 */
export interface ManifestPermissionDeclaration {
  readonly permission: string;
  readonly scope?: string;
  readonly reason?: string;
  /**
   * Attributes this declaration to one of `capabilities[].id` on the same
   * manifest — the mechanism that makes a permission requirement
   * *enforced* automatically at execution time (see `@xo/permissions`'
   * `resolveManifestCapabilityPermissions`, consumed by
   * `@xo/runtime`'s `PermissionGate`). Absent means this declaration is
   * package-level informational metadata only (e.g. "this package may
   * need X somewhere") and is never attributed to, or enforced against,
   * any specific capability — deliberately conservative, so adding this
   * optional field can never silently start denying a capability that
   * was previously unrestricted. A capability with no `capabilityId`-
   * matched declaration at all is permissionless, by design, not by
   * omission.
   */
  readonly capabilityId?: string;
}

/**
 * The typed shape of an XO package's `manifest.json` (SPECIFICATION.md §1).
 * This module only models the format — reading, writing, hashing, and
 * signing a manifest belong to @xo/compiler-core and @xo/registry-core
 * respectively, neither of which is implemented in this module.
 */
export interface XoManifest {
  readonly formatVersion: string;
  readonly name: string;
  readonly version: string;
  readonly creatorDid: string;
  readonly compatibility: CompatibilityDeclaration;
  readonly components: Readonly<Record<ComponentKind, ComponentEntry>>;
  /**
   * The package's first-class capability declarations (e.g.
   * `contract_analysis`, `fraud_detection`) — see {@link CapabilityDeclaration}.
   * Optional for backward compatibility with formatVersion "1.0" manifests
   * written before capabilities existed as a manifest concept; absent is
   * equivalent to declaring zero capabilities, never inferred from
   * `metadata.json`.
   */
  readonly capabilities?: readonly CapabilityDeclaration[];
  readonly dependencies?: readonly DependencyDeclaration[];
  /**
   * Permissions this package may request at runtime, evaluated by
   * `@xo/permissions` against the host's configured policy before any
   * capability executes. Optional for backward compatibility with
   * manifests written before the Permission System existed; absent is
   * equivalent to declaring zero permission requirements — under
   * `@xo/permissions`' default-deny model that means "requests nothing",
   * never "may do anything".
   */
  readonly permissions?: readonly ManifestPermissionDeclaration[];
  readonly merkleRoot?: ContentHash;
  readonly signatures?: readonly {
    readonly signerDid: string;
    readonly role: 'creator' | 'reviewer' | 'co_signer';
    readonly signature: string;
  }[];
}
