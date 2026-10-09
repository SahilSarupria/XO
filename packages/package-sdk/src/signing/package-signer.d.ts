import type { XoManifest } from '@xo/types';
import { type Result } from '@xo/types';
import { PackageError } from '@xo/errors';
import type { Signer, Verifier } from '@xo/crypto';
import type { SignatureEntry } from '../types.js';
/**
 * Produces detached signatures over a manifest's signable bytes
 * (SPECIFICATION.md §1.1's `signatures/signatures.json`, over every
 * component's hash via the manifest that already indexes them). Wraps
 * `@xo/crypto`'s {@link Ed25519Signer} rather than re-implementing
 * signing — per the platform's own PACKAGE_README.md §4, the real
 * production signing story is KMS/HSM-backed key custody, which this
 * class deliberately does not attempt; it accepts whatever PEM key
 * material its caller supplies.
 */
export declare class PackageSigner {
    private readonly signer;
    constructor(signer?: Signer);
    sign(manifest: XoManifest, signerDid: string, role: SignatureEntry['role'], privateKeyPem: string, publicKeyPem: string): SignatureEntry;
}
/**
 * Verifies one or all of a manifest's signatures. Returns a `Result`
 * rather than throwing — an invalid signature on an untrusted package is
 * an expected outcome a caller must branch on (install anyway with a
 * warning? refuse?), never a programmer error (see docs/CODING_STANDARDS.md).
 */
export declare class PackageVerifier {
    private readonly verifier;
    constructor(verifier?: Verifier);
    verifyOne(manifest: XoManifest, entry: SignatureEntry): boolean;
    /** Verifies every signature attached to the manifest itself (`manifest.signatures`, which carry no public key — callers must resolve `signerDid` -> public key themselves via `resolvePublicKey`) plus any out-of-band {@link SignatureEntry} list supplied directly (which do carry their own key). */
    verifyAll(manifest: XoManifest, externalSignatures?: readonly SignatureEntry[], resolvePublicKey?: (signerDid: string) => string | undefined): Result<void, PackageError>;
}
//# sourceMappingURL=package-signer.d.ts.map