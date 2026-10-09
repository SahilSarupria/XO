import type { ComponentKind, CompatibilityDeclaration, XoManifest } from '@xo/types';
/**
 * A component's bytes plus enough metadata for {@link ManifestBuilder} and
 * the archive writer to place it in the package layout (SPECIFICATION.md
 * §1.1) and index it in the manifest (§1.2). `path` is the archive-relative
 * path (e.g. `knowledge/graph.json`), never an absolute filesystem path —
 * the SDK never assumes its caller's files live on disk (see streaming
 * APIs in `archive/`).
 */
export interface ComponentInput {
    readonly kind: ComponentKind;
    readonly path: string;
    readonly data: Uint8Array;
    readonly required: boolean;
}
/** A resolved component paired with the manifest entry describing it, as produced by the builder/reader and consumed by the installer/inspector. */
export interface ResolvedComponent {
    readonly kind: ComponentKind;
    readonly path: string;
    readonly hash: string;
    readonly required: boolean;
    readonly size: number;
}
/** Non-component top-level files every package carries: `metadata.json` and `CHANGELOG.md` (SPECIFICATION.md §1.1). */
export interface PackageAncillaryFiles {
    readonly metadataJson: Uint8Array;
    readonly changelogMd?: Uint8Array;
}
/** A fully assembled, in-memory package prior to (or resulting from) archiving. Immutable — every mutation method on the builder returns a new value. */
export interface PackageBundle {
    readonly manifest: XoManifest;
    readonly components: readonly ComponentInput[];
    readonly ancillary: PackageAncillaryFiles;
}
/** One signer's detached signature over a manifest's signable bytes (§1.1's `signatures/signatures.json`). */
export interface SignatureEntry {
    readonly signerDid: string;
    readonly role: 'creator' | 'reviewer' | 'co_signer';
    readonly signature: string;
    readonly publicKeyPem: string;
}
/** A single component-level or manifest-level problem found during validation. Validation always collects every issue rather than stopping at the first — see `validation/package-validator.ts`. */
export interface ValidationIssue {
    readonly severity: 'error' | 'warning';
    readonly code: string;
    readonly message: string;
    readonly path?: string;
}
export interface ValidationReport {
    readonly valid: boolean;
    readonly issues: readonly ValidationIssue[];
}
/** A host's declared runtime capabilities, matched against `manifest.compatibility` per SPECIFICATION.md §2.1 steps 3-5. */
export interface HostProfile {
    readonly family: CompatibilityDeclaration['modelFamilies'][number]['family'];
    readonly capabilities: readonly CompatibilityDeclaration['modelFamilies'][number]['minCapability'][number][];
}
/** The outcome of intersecting a {@link HostProfile} against a manifest's compatibility declaration. */
export interface CompatibilityResolution {
    readonly reachedLevel: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
    readonly resolvedComponents: readonly ComponentKind[];
    readonly skippedComponents: readonly ComponentKind[];
}
/** A record the installer persists per installed package (installer-local concern, not part of the .xo format itself). */
export interface InstalledPackageRecord {
    readonly name: string;
    readonly version: string;
    readonly installedAt: string;
    readonly manifestHash: string;
    readonly componentPaths: readonly string[];
}
export interface ComponentDiffEntry {
    readonly kind: ComponentKind;
    readonly change: 'added' | 'removed' | 'modified' | 'unchanged';
    readonly fromHash?: string;
    readonly toHash?: string;
}
export interface ManifestDiff {
    readonly nameChanged: boolean;
    readonly fromVersion: string;
    readonly toVersion: string;
    readonly versionBump: 'major' | 'minor' | 'patch' | 'none' | 'invalid';
    readonly compatibilityChanged: boolean;
}
export interface PackageDiff {
    readonly manifest: ManifestDiff;
    readonly components: readonly ComponentDiffEntry[];
}
export type UpgradeStepKind = 'install_component' | 'remove_component' | 'replace_component' | 'update_manifest';
export interface UpgradeStep {
    readonly kind: UpgradeStepKind;
    readonly componentKind?: ComponentKind;
    readonly description: string;
}
export interface UpgradePlan {
    readonly fromVersion: string;
    readonly toVersion: string;
    readonly steps: readonly UpgradeStep[];
    readonly safe: boolean;
    readonly reasons: readonly string[];
}
//# sourceMappingURL=types.d.ts.map