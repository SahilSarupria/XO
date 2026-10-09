import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
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
export class Ed25519Signer implements Signer, Verifier {
  generateKeyPair(): KeyPair {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
  }

  sign(data: Uint8Array | string, privateKeyPem: string): string {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    return nodeSign(null, buffer, privateKeyPem).toString('base64');
  }

  verify(data: Uint8Array | string, signatureBase64: string, publicKeyPem: string): boolean {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    return nodeVerify(null, buffer, publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  }
}
