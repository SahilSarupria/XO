import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, fingerprintManifest, signableManifestBytes } from '../src/hashing/fingerprint.js';
import { hashComponent, hashComponents } from '../src/hashing/component-hasher.js';
import { buildSampleBundle } from './fixtures.js';
test('canonicalJson sorts object keys but preserves array order', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
});
test('fingerprintManifest is independent of signatures', () => {
    const bundle = buildSampleBundle();
    const unsigned = fingerprintManifest(bundle.manifest);
    const signed = fingerprintManifest({
        ...bundle.manifest,
        signatures: [{ signerDid: 'did:xo:someone', role: 'creator', signature: 'deadbeef' }],
    });
    assert.equal(unsigned, signed);
});
test('signableManifestBytes excludes the signatures field', () => {
    const bundle = buildSampleBundle();
    const bytes = signableManifestBytes({ ...bundle.manifest, signatures: [{ signerDid: 'x', role: 'creator', signature: 'y' }] });
    const text = new TextDecoder().decode(bytes);
    assert.equal(text.includes('signatures'), false);
});
test('fingerprintManifest changes when any component hash changes', () => {
    const a = buildSampleBundle();
    const differentGraph = {
        ...a.manifest,
        components: { ...a.manifest.components, knowledge_graph: { ...a.manifest.components.knowledge_graph, hash: 'sha256:' + '0'.repeat(64) } },
    };
    assert.notEqual(fingerprintManifest(a.manifest), fingerprintManifest(differentGraph));
});
test('signableManifestBytes and fingerprintManifest pick up the dependencies field automatically (canonicalJson sorts keys generically, no hashing/fingerprint.ts change needed)', () => {
    const withoutDeps = buildSampleBundle().manifest;
    const withDeps = buildSampleBundle({ dependencies: [{ name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' }] }).manifest;
    const bytesWithout = new TextDecoder().decode(signableManifestBytes(withoutDeps));
    const bytesWith = new TextDecoder().decode(signableManifestBytes(withDeps));
    assert.equal(bytesWithout.includes('dependencies'), false);
    assert.equal(bytesWith.includes('"dependencies"'), true);
    assert.equal(bytesWith.includes('xo_core_math'), true);
    assert.equal(bytesWith.includes('^1.0.0'), true);
    assert.notEqual(fingerprintManifest(withoutDeps), fingerprintManifest(withDeps));
});
test('fingerprintManifest changes when a dependency\'s version range changes, even with everything else identical', () => {
    const a = buildSampleBundle({ dependencies: [{ name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' }] }).manifest;
    const b = buildSampleBundle({ dependencies: [{ name: 'xo_core_math', versionRange: '^2.0.0', kind: 'required' }] }).manifest;
    assert.notEqual(fingerprintManifest(a), fingerprintManifest(b));
});
test('hashComponent produces a sha256:<hex> hash', () => {
    const hash = hashComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode('x'), required: true });
    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
});
test('hashComponents is sorted by kind regardless of input order', () => {
    const a = { kind: 'safety_rules', path: 'a', data: new Uint8Array([1]), required: true };
    const b = { kind: 'knowledge_graph', path: 'b', data: new Uint8Array([2]), required: false };
    const first = hashComponents([a, b]);
    const second = hashComponents([b, a]);
    assert.deepEqual(first, second);
    assert.equal(first[0]?.[0], 'knowledge_graph');
});
//# sourceMappingURL=fingerprint.test.js.map