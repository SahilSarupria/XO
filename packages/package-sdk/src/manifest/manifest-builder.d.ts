import type { CapabilityDeclaration, CompatibilityDeclaration, ComponentKind, DependencyDeclaration, ManifestPermissionDeclaration, XoMetadata } from '@xo/types';
import { type Result } from '@xo/types';
import { PackageError } from '@xo/errors';
import type { Hasher } from '@xo/crypto';
import type { ComponentInput, PackageBundle, SignatureEntry } from '../types.js';
/**
 * Builds a {@link PackageBundle} — a manifest, its ancillary `metadata.json`
 * / `CHANGELOG.md`, and its component set — matching SPECIFICATION.md §1.
 * Every mutator (`setIdentity`, `setMetadata`, `setCompatibility`,
 * `addComponent`, `addSignature`) returns a *new* `ManifestBuilder`; the
 * builder itself carries no exposed mutable state, and `build()` freezes
 * its output so nothing downstream can quietly mutate a manifest after
 * validation/hashing has already run against it.
 *
 * "Manifest Builder", "Component Builder", and "Package Builder" from the
 * SDK's feature list are one class here rather than three: a manifest is
 * never meaningfully built without its components (the manifest's own
 * `components` index and `merkleRoot` are *derived from* the component
 * set), so splitting them would just move required coupling into two
 * classes that always have to be used together.
 */
export declare class ManifestBuilder {
    private readonly state;
    private readonly hasher;
    private constructor();
    static create(hasher?: Hasher): ManifestBuilder;
    setIdentity(fields: {
        readonly formatVersion: string;
        readonly name: string;
        readonly version: string;
        readonly creatorDid: string;
    }): ManifestBuilder;
    setCompatibility(compatibility: CompatibilityDeclaration): ManifestBuilder;
    /** Sets the package's `metadata.json` content (SPECIFICATION.md §1.1) — domain description, scope, and limitations. Distinct from manifest identity fields. */
    setMetadata(metadata: XoMetadata): ManifestBuilder;
    /**
     * Declares this package's first-class capabilities (SPECIFICATION.md's
     * capability model, as extended for `@xo/runtime`'s capability
     * registry/negotiator) — replaces the entire set on each call, mirroring
     * `setCompatibility`/`setMetadata` rather than `addComponent`'s
     * accumulate-by-kind semantics, since capability ids aren't
     * pre-declared component kinds a caller adds to one at a time. Never
     * inferred from `metadata.json`: a package that doesn't call this
     * declares zero capabilities.
     */
    setCapabilities(capabilities: readonly CapabilityDeclaration[]): ManifestBuilder;
    setDependencies(dependencies: readonly DependencyDeclaration[]): ManifestBuilder;
    /**
   * Declares the permissions this package's capabilities need at runtime
   * (`@xo/permissions`' authorization model — see that package's README).
   * Replaces the entire set on each call, mirroring `setCapabilities`.
   * Never inferred from `capabilities`: a package that doesn't call this
   * declares zero permission requirements, which — under
   * `@xo/permissions`' default-deny model — means its capabilities are
   * permissionless, not "may do anything".
   */
    setPermissions(permissions: readonly ManifestPermissionDeclaration[]): ManifestBuilder;
    setChangelog(changelogMd: Uint8Array): ManifestBuilder;
    /** Adds (or replaces) a component. The component's hash is computed here, from `input.data`, so a caller can never hand-supply a mismatched hash. */
    addComponent(input: ComponentInput): ManifestBuilder;
    removeComponent(kind: ComponentKind): ManifestBuilder;
    addSignature(signature: SignatureEntry): ManifestBuilder;
    /**
     * Validates the accumulated state and, if it's complete and consistent,
     * produces an immutable {@link PackageBundle}. This does NOT compute the
     * Merkle root over the *packed* archive bytes — that's `archive/`'s job,
     * since the Merkle root SPECIFICATION.md §1.1 describes is over
     * component file hashes, and this method already has those from
     * `addComponent`. It fills `merkleRoot` in here so a bundle is always
     * internally consistent even before it's ever packed to disk.
     */
    build(): Result<PackageBundle, PackageError>;
}
//# sourceMappingURL=manifest-builder.d.ts.map