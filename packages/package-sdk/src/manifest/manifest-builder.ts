import type { CapabilityDeclaration, CompatibilityDeclaration, ComponentEntry, ComponentKind, DependencyDeclaration, ManifestPermissionDeclaration, XoManifest, XoMetadata } from '@xo/types';
import { ContentHash, err, ok, type Result } from '@xo/types';
import { ErrorCode, PackageError } from '@xo/errors';
import type { Hasher } from '@xo/crypto';
import { Sha256Hasher, buildMerkleRoot } from '@xo/crypto';
import { isValidSemVer } from './semver.js';
import type { ComponentInput, PackageBundle, SignatureEntry } from '../types.js';

interface BuilderState {
  readonly formatVersion?: string;
  readonly name?: string;
  readonly version?: string;
  readonly creatorDid?: string;
  readonly compatibility?: CompatibilityDeclaration;
  readonly capabilities: readonly CapabilityDeclaration[];
  readonly dependencies: readonly DependencyDeclaration[];
  readonly permissions: readonly ManifestPermissionDeclaration[];
  readonly metadata?: XoMetadata;
  readonly changelogMd?: Uint8Array;
  readonly components: ReadonlyMap<ComponentKind, ComponentInput>;
  readonly signatures: readonly SignatureEntry[];
}

const REQUIRED_STATE_FIELDS = ['formatVersion', 'name', 'version', 'creatorDid', 'compatibility', 'metadata'] as const;

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
export class ManifestBuilder {
  private constructor(
    private readonly state: BuilderState,
    private readonly hasher: Hasher,
  ) {}

  static create(hasher: Hasher = new Sha256Hasher()): ManifestBuilder {
    return new ManifestBuilder({
      components: new Map(),
      signatures: [],
      capabilities: [],
      dependencies: [],
      permissions: [],
    }, hasher);
  }

  setIdentity(fields: { readonly formatVersion: string; readonly name: string; readonly version: string; readonly creatorDid: string }): ManifestBuilder {
    return new ManifestBuilder({ ...this.state, ...fields }, this.hasher);
  }

  setCompatibility(compatibility: CompatibilityDeclaration): ManifestBuilder {
    return new ManifestBuilder({ ...this.state, compatibility }, this.hasher);
  }

  /** Sets the package's `metadata.json` content (SPECIFICATION.md §1.1) — domain description, scope, and limitations. Distinct from manifest identity fields. */
  setMetadata(metadata: XoMetadata): ManifestBuilder {
    return new ManifestBuilder({ ...this.state, metadata }, this.hasher);
  }

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
  setCapabilities(capabilities: readonly CapabilityDeclaration[]): ManifestBuilder {
    return new ManifestBuilder({ ...this.state, capabilities }, this.hasher);
  }

  setDependencies(dependencies: readonly DependencyDeclaration[]): ManifestBuilder {
    return new ManifestBuilder({ ...this.state, dependencies }, this.hasher);
  }

    /**
   * Declares the permissions this package's capabilities need at runtime
   * (`@xo/permissions`' authorization model — see that package's README).
   * Replaces the entire set on each call, mirroring `setCapabilities`.
   * Never inferred from `capabilities`: a package that doesn't call this
   * declares zero permission requirements, which — under
   * `@xo/permissions`' default-deny model — means its capabilities are
   * permissionless, not "may do anything".
   */
  setPermissions(permissions: readonly ManifestPermissionDeclaration[]): ManifestBuilder {
    return new ManifestBuilder({ ...this.state, permissions }, this.hasher);
  }

  setChangelog(changelogMd: Uint8Array): ManifestBuilder {
    return new ManifestBuilder({ ...this.state, changelogMd }, this.hasher);
  }

  /** Adds (or replaces) a component. The component's hash is computed here, from `input.data`, so a caller can never hand-supply a mismatched hash. */
  addComponent(input: ComponentInput): ManifestBuilder {
    const next = new Map(this.state.components);
    next.set(input.kind, input);
    return new ManifestBuilder({ ...this.state, components: next }, this.hasher);
  }

  removeComponent(kind: ComponentKind): ManifestBuilder {
    const next = new Map(this.state.components);
    next.delete(kind);
    return new ManifestBuilder({ ...this.state, components: next }, this.hasher);
  }

  addSignature(signature: SignatureEntry): ManifestBuilder {
    return new ManifestBuilder({ ...this.state, signatures: [...this.state.signatures, signature] }, this.hasher);
  }

  /**
   * Validates the accumulated state and, if it's complete and consistent,
   * produces an immutable {@link PackageBundle}. This does NOT compute the
   * Merkle root over the *packed* archive bytes — that's `archive/`'s job,
   * since the Merkle root SPECIFICATION.md §1.1 describes is over
   * component file hashes, and this method already has those from
   * `addComponent`. It fills `merkleRoot` in here so a bundle is always
   * internally consistent even before it's ever packed to disk.
   */
  build(): Result<PackageBundle, PackageError> {
    const missing = REQUIRED_STATE_FIELDS.filter((f) => this.state[f] === undefined);
    if (missing.length > 0) {
      return err(new PackageError(ErrorCode.PACKAGE_MANIFEST_INVALID, `Manifest is missing required field(s): ${missing.join(', ')}`));
    }
    const { formatVersion, name, version, creatorDid, compatibility, metadata } = this.state as Required<
      Pick<BuilderState, 'formatVersion' | 'name' | 'version' | 'creatorDid' | 'compatibility' | 'metadata'>
    >;
    if (!isValidSemVer(version)) {
      return err(new PackageError(ErrorCode.PACKAGE_VERSION_INVALID, `Manifest version "${version}" is not a valid semantic version`));
    }
    if (this.state.components.size === 0) {
      return err(new PackageError(ErrorCode.PACKAGE_MANIFEST_INVALID, 'A package must declare at least one component'));
    }

    const components: Record<string, ComponentEntry> = {};
    const leafHashes: string[] = [];
    for (const [kind, input] of [...this.state.components].sort(([a], [b]) => a.localeCompare(b))) {
      const hash = this.hasher.hash(input.data);
      components[kind] = { path: input.path, hash: hash as ComponentEntry['hash'], required: input.required };
      leafHashes.push(hash);
    }

    const manifest: XoManifest = {
      formatVersion,
      name,
      version,
      creatorDid,
      compatibility,
      components: components as XoManifest['components'],
      ...(this.state.capabilities.length > 0 ? { capabilities: this.state.capabilities } : {}),
      ...(this.state.dependencies.length > 0 ? { dependencies: this.state.dependencies } : {}),
      ...(this.state.permissions.length > 0 ? { permissions: this.state.permissions } : {}),
      merkleRoot: ContentHash(buildMerkleRoot(leafHashes, this.hasher)),
      ...(this.state.signatures.length > 0 ? { signatures: this.state.signatures.map(({ signerDid, role, signature }) => ({ signerDid, role, signature })) } : {}),
    };

    const bundle: PackageBundle = Object.freeze({
      manifest: Object.freeze(manifest),
      components: Object.freeze([...this.state.components.values()].sort((a, b) => a.kind.localeCompare(b.kind))),
      ancillary: Object.freeze({
        metadataJson: new TextEncoder().encode(JSON.stringify(metadata, null, 2)),
        ...(this.state.changelogMd ? { changelogMd: this.state.changelogMd } : {}),
      }),
    });
    return ok(bundle);
  }
}
