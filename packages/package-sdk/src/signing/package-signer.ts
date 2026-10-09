import type { XoManifest } from '@xo/types';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, PackageError } from '@xo/errors';
import type { Signer, Verifier } from '@xo/crypto';
import { Ed25519Signer } from '@xo/crypto';
import { signableManifestBytes } from '../hashing/fingerprint.js';
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
export class PackageSigner {
  constructor(private readonly signer: Signer = new Ed25519Signer()) {}

  sign(manifest: XoManifest, signerDid: string, role: SignatureEntry['role'], privateKeyPem: string, publicKeyPem: string): SignatureEntry {
    const signature = this.signer.sign(signableManifestBytes(manifest), privateKeyPem);
    return { signerDid, role, signature, publicKeyPem };
  }
}

/**
 * Verifies one or all of a manifest's signatures. Returns a `Result`
 * rather than throwing — an invalid signature on an untrusted package is
 * an expected outcome a caller must branch on (install anyway with a
 * warning? refuse?), never a programmer error (see docs/CODING_STANDARDS.md).
 */
export class PackageVerifier {
  constructor(private readonly verifier: Verifier = new Ed25519Signer()) {}

  verifyOne(manifest: XoManifest, entry: SignatureEntry): boolean {
    return this.verifier.verify(signableManifestBytes(manifest), entry.signature, entry.publicKeyPem);
  }

  /** Verifies every signature attached to the manifest itself (`manifest.signatures`, which carry no public key — callers must resolve `signerDid` -> public key themselves via `resolvePublicKey`) plus any out-of-band {@link SignatureEntry} list supplied directly (which do carry their own key). */
  verifyAll(
    manifest: XoManifest,
    externalSignatures: readonly SignatureEntry[] = [],
    resolvePublicKey?: (signerDid: string) => string | undefined,
  ): Result<void, PackageError> {
    const failures: string[] = [];

    for (const sig of manifest.signatures ?? []) {
      const publicKeyPem = resolvePublicKey?.(sig.signerDid);
      if (publicKeyPem === undefined) {
        failures.push(`No public key available to verify signature from "${sig.signerDid}"`);
        continue;
      }
      const valid = this.verifier.verify(signableManifestBytes(manifest), sig.signature, publicKeyPem);
      if (!valid) failures.push(`Signature from "${sig.signerDid}" (${sig.role}) does not verify`);
    }

    for (const entry of externalSignatures) {
      if (!this.verifyOne(manifest, entry)) {
        failures.push(`Signature from "${entry.signerDid}" (${entry.role}) does not verify`);
      }
    }

    if (failures.length > 0) {
      return err(new PackageError(ErrorCode.CRYPTO_SIGNATURE_INVALID, `Signature verification failed: ${failures.join('; ')}`));
    }
    return ok(undefined);
  }
}
