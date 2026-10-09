import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../src/capability/capability-registry.js';
import { PackageRegistry } from '../src/registry/mounted-package.js';
import { MountId } from '../src/ids.js';
import { contractAnalysisCapability, clauseLookupCapability, fraudDetectionCapability, contractCompatibility } from './fixtures.js';
function mountWithCapabilities(name, version, declarations) {
    return Object.freeze({
        mountId: MountId(`${name}@${version}#0`),
        name,
        version,
        manifest: {
            formatVersion: '1.0',
            name,
            version,
            creatorDid: 'did:xo:test',
            compatibility: contractCompatibility,
            components: {},
            capabilities: declarations,
        },
        capabilities: declarations.map((declaration) => ({ declaration, packageName: name, packageVersion: version })),
        mountedAt: '2026-01-01T00:00:00.000Z',
        manifestHash: 'sha256:fake',
    });
}
test('capabilities are read from manifest.capabilities, never inferred from metadata', () => {
    const registry = CapabilityRegistry.fromPackages([mountWithCapabilities('xo_lawyer', '1.0.0', [contractAnalysisCapability, clauseLookupCapability])]);
    assert.equal(registry.size, 2);
    assert.equal(registry.find('contract_analysis').length, 1);
    assert.equal(registry.find('clause_lookup').length, 1);
});
test('a package with no declared capabilities contributes nothing to the index', () => {
    const registry = CapabilityRegistry.fromPackages([mountWithCapabilities('xo_empty', '1.0.0', [])]);
    assert.equal(registry.size, 0);
});
test('find() returns every package offering an exact capability id, across packages', () => {
    const registry = CapabilityRegistry.fromPackages([
        mountWithCapabilities('xo_lawyer_a', '1.0.0', [contractAnalysisCapability]),
        mountWithCapabilities('xo_lawyer_b', '1.0.0', [contractAnalysisCapability]),
    ]);
    const matches = registry.find('contract_analysis');
    assert.equal(matches.length, 2);
    assert.deepEqual(matches.map((m) => m.packageName).sort(), ['xo_lawyer_a', 'xo_lawyer_b']);
});
test('find() returns an empty array (never throws) for an unknown capability id', () => {
    const registry = CapabilityRegistry.fromPackages([mountWithCapabilities('xo_lawyer', '1.0.0', [contractAnalysisCapability])]);
    assert.deepEqual(registry.find('does_not_exist'), []);
});
test('search() matches case-insensitively across id, name, and description', () => {
    const registry = CapabilityRegistry.fromPackages([mountWithCapabilities('xo_lawyer', '1.0.0', [contractAnalysisCapability, fraudDetectionCapability])]);
    assert.equal(registry.search('CONTRACT').length, 1);
    assert.equal(registry.search('anomalous').length, 1); // matches fraudDetectionCapability's description
    assert.equal(registry.search('nonexistent-term').length, 0);
});
test('search() with an empty/whitespace query returns nothing rather than everything', () => {
    const registry = CapabilityRegistry.fromPackages([mountWithCapabilities('xo_lawyer', '1.0.0', [contractAnalysisCapability])]);
    assert.deepEqual(registry.search('   '), []);
    assert.deepEqual(registry.search(''), []);
});
test('search() is deterministic: repeated calls with the same query return the same order', () => {
    const registry = CapabilityRegistry.fromPackages([mountWithCapabilities('xo_lawyer', '1.0.0', [contractAnalysisCapability, clauseLookupCapability])]);
    const first = registry.search('contract').map((d) => d.declaration.id);
    const second = registry.search('contract').map((d) => d.declaration.id);
    assert.deepEqual(first, second);
});
test('CapabilityRegistry built from PackageRegistry.all() reflects a real, sorted, multi-package registry', () => {
    const packageRegistry = PackageRegistry.empty()
        .withMounted(mountWithCapabilities('xo_lawyer', '1.0.0', [contractAnalysisCapability]))
        .withMounted(mountWithCapabilities('xo_fraud', '1.0.0', [fraudDetectionCapability]));
    const capabilities = CapabilityRegistry.fromPackages(packageRegistry.all());
    assert.equal(capabilities.size, 2);
    assert.equal(capabilities.all()[0]?.packageName, 'xo_fraud'); // 'xo_fraud' sorts before 'xo_lawyer'
});
//# sourceMappingURL=capability-registry.test.js.map