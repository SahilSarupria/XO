import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageRegistry } from '../src/registry/mounted-package.js';
import { MountId } from '../src/ids.js';
function fakeMount(name, version) {
    return Object.freeze({
        mountId: MountId(`${name}@${version}#0`),
        name,
        version,
        manifest: {
            formatVersion: '1.0',
            name,
            version,
            creatorDid: 'did:xo:test',
            compatibility: { modelFamilies: [], fallbackPolicy: 'reject' },
            components: {},
        },
        capabilities: [],
        mountedAt: '2026-01-01T00:00:00.000Z',
        manifestHash: 'sha256:fake',
    });
}
test('empty() registry has no mounted packages', () => {
    const registry = PackageRegistry.empty();
    assert.equal(registry.packageCount, 0);
    assert.equal(registry.mountCount, 0);
    assert.deepEqual(registry.all(), []);
});
test('withMounted() returns a new registry and leaves the original untouched', () => {
    const empty = PackageRegistry.empty();
    const withOne = empty.withMounted(fakeMount('xo_a', '1.0.0'));
    assert.equal(empty.mountCount, 0, 'original registry must not be mutated');
    assert.equal(withOne.mountCount, 1);
    assert.notEqual(empty, withOne);
});
test('multiple versions of the same package name are mounted simultaneously', () => {
    const registry = PackageRegistry.empty().withMounted(fakeMount('xo_a', '1.0.0')).withMounted(fakeMount('xo_a', '1.1.0')).withMounted(fakeMount('xo_a', '2.0.0'));
    assert.equal(registry.packageCount, 1, 'one distinct package name');
    assert.equal(registry.mountCount, 3, 'three distinct mounted versions');
    assert.equal(registry.versionsOf('xo_a').length, 3);
    assert.ok(registry.has('xo_a', '1.0.0'));
    assert.ok(registry.has('xo_a', '1.1.0'));
    assert.ok(registry.has('xo_a', '2.0.0'));
});
test('withoutMounted() removes only the targeted version, keeping others', () => {
    const registry = PackageRegistry.empty().withMounted(fakeMount('xo_a', '1.0.0')).withMounted(fakeMount('xo_a', '2.0.0'));
    const after = registry.withoutMounted('xo_a', '1.0.0');
    assert.equal(after.has('xo_a', '1.0.0'), false);
    assert.equal(after.has('xo_a', '2.0.0'), true);
    assert.equal(registry.has('xo_a', '1.0.0'), true, 'original registry unaffected');
});
test('withoutMounted() on an unmounted name@version is a no-op that returns the same instance', () => {
    const registry = PackageRegistry.empty().withMounted(fakeMount('xo_a', '1.0.0'));
    const after = registry.withoutMounted('xo_never_mounted', '9.9.9');
    assert.equal(after, registry);
});
test('all() is sorted deterministically by name then semantic version, not insertion order', () => {
    const registry = PackageRegistry.empty()
        .withMounted(fakeMount('xo_b', '1.0.0'))
        .withMounted(fakeMount('xo_a', '2.0.0'))
        .withMounted(fakeMount('xo_a', '10.0.0'))
        .withMounted(fakeMount('xo_a', '1.0.0'));
    const order = registry.all().map((p) => `${p.name}@${p.version}`);
    assert.deepEqual(order, ['xo_a@1.0.0', 'xo_a@2.0.0', 'xo_a@10.0.0', 'xo_b@1.0.0']);
});
test('a MountedPackage is frozen (immutable)', () => {
    const mount = fakeMount('xo_a', '1.0.0');
    assert.ok(Object.isFrozen(mount));
    assert.throws(() => {
        // @ts-expect-error intentional mutation attempt for the immutability test
        mount.version = '9.9.9';
    });
});
test('a MountedPackage round-trips through JSON without losing data (serialization)', () => {
    const mount = fakeMount('xo_a', '1.0.0');
    const roundTripped = JSON.parse(JSON.stringify(mount));
    assert.deepEqual(roundTripped, mount);
});
//# sourceMappingURL=mounted-package.test.js.map