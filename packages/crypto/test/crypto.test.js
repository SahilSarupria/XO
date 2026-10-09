import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sha256Hasher, buildMerkleRoot } from '../src/sha256-hasher.js';
import { Ed25519Signer } from '../src/ed25519-signer.js';
test('Sha256Hasher produces a stable, correctly-shaped digest', () => {
    const hasher = new Sha256Hasher();
    const h1 = hasher.hash('hello world');
    const h2 = hasher.hash('hello world');
    assert.equal(h1, h2);
    assert.match(h1, /^sha256:[0-9a-f]{64}$/);
});
test('Sha256Hasher produces different digests for different input', () => {
    const hasher = new Sha256Hasher();
    assert.notEqual(hasher.hash('a'), hasher.hash('b'));
});
test('buildMerkleRoot is deterministic for the same leaf order', () => {
    const hasher = new Sha256Hasher();
    const leaves = [hasher.hash('a'), hasher.hash('b'), hasher.hash('c')];
    assert.equal(buildMerkleRoot(leaves), buildMerkleRoot(leaves));
});
test('buildMerkleRoot is sensitive to leaf order', () => {
    const hasher = new Sha256Hasher();
    const leaves = [hasher.hash('a'), hasher.hash('b'), hasher.hash('c')];
    const reordered = [leaves[1], leaves[0], leaves[2]];
    assert.notEqual(buildMerkleRoot(leaves), buildMerkleRoot(reordered));
});
test('buildMerkleRoot rejects an empty leaf list', () => {
    assert.throws(() => buildMerkleRoot([]));
});
test('Ed25519Signer: a signature verifies against the matching public key', () => {
    const signer = new Ed25519Signer();
    const { publicKey, privateKey } = signer.generateKeyPair();
    const signature = signer.sign('manifest-bytes', privateKey);
    assert.equal(signer.verify('manifest-bytes', signature, publicKey), true);
});
test('Ed25519Signer: verification fails for tampered data', () => {
    const signer = new Ed25519Signer();
    const { publicKey, privateKey } = signer.generateKeyPair();
    const signature = signer.sign('manifest-bytes', privateKey);
    assert.equal(signer.verify('tampered-bytes', signature, publicKey), false);
});
test('Ed25519Signer: verification fails against a different keypair', () => {
    const signer = new Ed25519Signer();
    const { privateKey } = signer.generateKeyPair();
    const { publicKey: otherPublicKey } = signer.generateKeyPair();
    const signature = signer.sign('manifest-bytes', privateKey);
    assert.equal(signer.verify('manifest-bytes', signature, otherPublicKey), false);
});
//# sourceMappingURL=crypto.test.js.map