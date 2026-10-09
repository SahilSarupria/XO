import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
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
export class Ed25519Signer {
    generateKeyPair() {
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        return {
            publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
            privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        };
    }
    sign(data, privateKeyPem) {
        const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
        return nodeSign(null, buffer, privateKeyPem).toString('base64');
    }
    verify(data, signatureBase64, publicKeyPem) {
        const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
        return nodeVerify(null, buffer, publicKeyPem, Buffer.from(signatureBase64, 'base64'));
    }
}
//# sourceMappingURL=ed25519-signer.js.map