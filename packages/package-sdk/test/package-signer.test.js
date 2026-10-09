import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ed25519Signer } from '@xo/crypto';
import { PackageSigner, PackageVerifier } from '../src/signing/package-signer.js';
import { buildSampleBundle } from './fixtures.js';
test('a signature produced by PackageSigner verifies with PackageVerifier', () => {
    const signer = new Ed25519Signer();
    const { publicKey, privateKey } = signer.generateKeyPair();
    const bundle = buildSampleBundle();
    const entry = new PackageSigner().sign(bundle.manifest, 'did:xo:creator', 'creator', privateKey, publicKey);
    const verified = new PackageVerifier().verifyOne(bundle.manifest, entry);
    assert.equal(verified, true);
});
test('a tampered manifest fails verification', () => {
    const signer = new Ed25519Signer();
    const { publicKey, privateKey } = signer.generateKeyPair();
    const bundle = buildSampleBundle();
    const entry = new PackageSigner().sign(bundle.manifest, 'did:xo:creator', 'creator', privateKey, publicKey);
    const tampered = { ...bundle.manifest, version: '9.9.9' };
    const verified = new PackageVerifier().verifyOne(tampered, entry);
    assert.equal(verified, false);
});
test('verifyAll resolves manifest.signatures through resolvePublicKey and reports failures', () => {
    const signer = new Ed25519Signer();
    const keys = signer.generateKeyPair();
    const bundle = buildSampleBundle();
    const entry = new PackageSigner().sign(bundle.manifest, 'did:xo:creator', 'creator', keys.privateKey, keys.publicKey);
    const signedManifest = { ...bundle.manifest, signatures: [{ signerDid: entry.signerDid, role: entry.role, signature: entry.signature }] };
    const verifier = new PackageVerifier();
    const ok = verifier.verifyAll(signedManifest, [], (did) => (did === 'did:xo:creator' ? keys.publicKey : undefined));
    assert.equal(ok.ok, true);
    const missingKey = verifier.verifyAll(signedManifest, [], () => undefined);
    assert.equal(missingKey.ok, false);
});
//# sourceMappingURL=package-signer.test.js.map