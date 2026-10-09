import type { XoManifest } from '@xo/types';
import type { Hasher } from '@xo/crypto';
import { PackageVerifier } from '../signing/package-signer.js';
import type { PackageBundle, ValidationIssue, ValidationReport } from '../types.js';
export interface PackageValidatorOptions {
    readonly hasher?: Hasher;
    readonly verifier?: PackageVerifier;
    /** Resolves a signer DID to its public key PEM, for manifest.signatures (which carry no key of their own). Signature validation is skipped (not failed) when omitted, since a bundle that hasn't been signed yet is still a valid *unsigned* package. */
    readonly resolvePublicKey?: (signerDid: string) => string | undefined;
}
/**
 * Runs every structural, cryptographic, and consistency check a
 * {@link PackageBundle} needs before it can be packed, published, or
 * installed. Each `validate*` method is independently callable (e.g. the
 * installer's `verifyInstallation()` only needs hash + Merkle, not
 * compatibility); `validateAll` runs the full suite and never short-circuits,
 * so a caller sees every problem in one pass instead of fixing issues
 * one validation run at a time.
 */
export declare class PackageValidator {
    private readonly hasher;
    private readonly verifier;
    private readonly resolvePublicKey?;
    constructor(options?: PackageValidatorOptions);
    validateSchema(manifest: unknown): readonly ValidationIssue[];
    validateVersion(manifest: XoManifest): readonly ValidationIssue[];
    /** Detects two components declaring the same archive path — an archive that would silently overwrite one component's file with another's on extraction. */
    validateNoDuplicatePaths(manifest: XoManifest): readonly ValidationIssue[];
    validateRequiredComponents(bundle: PackageBundle): readonly ValidationIssue[];
    /**
     * Checks internal consistency of each declared capability against the
     * rest of the manifest — not against reality (that's the benchmark/
     * challenge system SPECIFICATION.md §3 describes, a later concern).
     * A capability that claims a `requiredComponents` entry the package
     * doesn't actually carry is exactly the kind of inconsistency
     * `@xo/runtime`'s mounter needs caught here, before it ever tries to
     * mount the package and offer a capability it can't back.
     */
    validateCapabilities(manifest: XoManifest): readonly ValidationIssue[];
    validateDependencies(manifest: XoManifest): readonly ValidationIssue[];
    validateHashes(bundle: PackageBundle): readonly ValidationIssue[];
    validateMerkleRoot(bundle: PackageBundle): readonly ValidationIssue[];
    validateSignatures(manifest: XoManifest): readonly ValidationIssue[];
    validateAll(bundle: PackageBundle): ValidationReport;
}
//# sourceMappingURL=package-validator.d.ts.map