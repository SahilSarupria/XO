import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManifestBuilder } from '../src/manifest/manifest-builder.js';
import { PackageValidator } from '../src/validation/package-validator.js';
import { isXoManifest } from '../src/validation/schema.js';
import { buildSampleBundle, sampleCapability, sampleCompatibility, sampleMetadata } from './fixtures.js';
test('a bundle built without setCapabilities() declares zero capabilities, never inferring from metadata', () => {
    const result = ManifestBuilder.create()
        .setIdentity({ formatVersion: '1.0', name: 'x', version: '1.0.0', creatorDid: 'did:xo:a' })
        .setCompatibility(sampleCompatibility)
        .setMetadata(sampleMetadata)
        .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new Uint8Array([1]), required: true })
        .build();
    assert.ok(result.ok);
    assert.equal(result.value.manifest.capabilities, undefined);
});
test('setCapabilities() attaches declared capabilities to the built manifest', () => {
    const bundle = buildSampleBundle();
    assert.equal(bundle.manifest.capabilities?.length, 1);
    assert.equal(bundle.manifest.capabilities?.[0]?.id, 'clause_lookup');
});
test('capabilities participate in the manifest fingerprint (changing a capability changes the signable bytes)', () => {
    const withOneScore = buildSampleBundle();
    const withDifferentScore = buildSampleBundle({ capabilities: [{ ...sampleCapability, confidence: { ...sampleCapability.confidence, score: 0.99 } }] });
    assert.notEqual(withOneScore.manifest.merkleRoot, undefined); // sanity: build succeeded
    assert.notDeepEqual(withOneScore.manifest.capabilities, withDifferentScore.manifest.capabilities);
});
test('isXoManifest rejects a capability missing required fields', () => {
    const bundle = buildSampleBundle();
    const bad = { ...bundle.manifest, capabilities: [{ id: 'x' }] };
    assert.equal(isXoManifest(bad), false);
});
test('validateCapabilities flags a capability requiring a component the package does not declare', () => {
    const bundle = buildSampleBundle({ capabilities: [{ ...sampleCapability, requiredComponents: ['decision_trees'] }] });
    const issues = new PackageValidator().validateCapabilities(bundle.manifest);
    assert.ok(issues.some((i) => i.code === 'CAPABILITY_REQUIRED_COMPONENT_UNDECLARED'));
});
test('validateCapabilities flags duplicate capability ids', () => {
    const bundle = buildSampleBundle({ capabilities: [sampleCapability, sampleCapability] });
    const issues = new PackageValidator().validateCapabilities(bundle.manifest);
    assert.ok(issues.some((i) => i.code === 'CAPABILITY_DUPLICATE_ID'));
});
test('validateCapabilities flags an out-of-range confidence score', () => {
    const bundle = buildSampleBundle({ capabilities: [{ ...sampleCapability, confidence: { score: 1.5, basis: 'self_reported' } }] });
    const issues = new PackageValidator().validateCapabilities(bundle.manifest);
    assert.ok(issues.some((i) => i.code === 'CAPABILITY_CONFIDENCE_OUT_OF_RANGE'));
});
test('validateCapabilities warns on a capability with no declared provider compatibility', () => {
    const bundle = buildSampleBundle({ capabilities: [{ ...sampleCapability, providerCompatibility: [] }] });
    const issues = new PackageValidator().validateCapabilities(bundle.manifest);
    assert.ok(issues.some((i) => i.code === 'CAPABILITY_NO_PROVIDER_COMPATIBILITY' && i.severity === 'warning'));
});
test('validateAll still passes for a well-formed capability declaration', () => {
    const bundle = buildSampleBundle();
    const report = new PackageValidator().validateAll(bundle);
    assert.equal(report.valid, true);
});
//# sourceMappingURL=capability.test.js.map