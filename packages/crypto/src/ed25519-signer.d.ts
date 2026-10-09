import type { KeyPair, Signer, Verifier } from './signer.interface.js';
/**
 * Ed25519 signing/verification built on `node:crypto`. This is real,
 * working cryptography suitable for local development and CI key material
 * — it is deliberately NOT the production key-custody story. Production
 * signing keys (creator DID keys, reviewer co-signing keys referenced in
 * PACKAGE_README.md §4's `xo pack --sign-with`) must come from a KMS/HSM,
 * never from a PEM file on disk; see docs/adr — that integration is out of
 * scope for Module 1 and must not be inferred as "done" from this class
 * existing.
 */
export declare class Ed25519Signer implements Signer, Verifier {
    generateKeyPair(): KeyPair;
    sign(data: Uint8Array | string, privateKeyPem: string): string;
    verify(data: Uint8Array | string, signatureBase64: string, publicKeyPem: string): boolean;
}
//# sourceMappingURL=ed25519-signer.d.ts.map