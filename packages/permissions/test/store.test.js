import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageId } from '@xo/types';
import { Permissions } from '../src/permission-id.js';
import { globalScope, pathScope } from '../src/scope.js';
import { InMemoryPermissionStore } from '../src/store.js';
import { computeGrantId } from '../src/grant.js';
const pkg = PackageId('acme.widgets');
function makeGrant(overrides = {}) {
    const permission = overrides.permission ?? Permissions.filesystem.read;
    const scope = overrides.scope ?? globalScope();
    return {
        id: computeGrantId(pkg, permission, scope),
        permission,
        scope,
        packageId: pkg,
        lifetime: 'persistent',
        consentInvolved: false,
        grantedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}
test('store: set then get round-trips', async () => {
    const store = new InMemoryPermissionStore();
    const grant = makeGrant();
    await store.set(grant);
    const result = await store.get(grant.id);
    assert.equal(result.ok, true);
    if (result.ok)
        assert.deepEqual(result.value, grant);
});
test('store: get on a missing id returns ok(undefined), not an error', async () => {
    const store = new InMemoryPermissionStore();
    const result = await store.get('does-not-exist');
    assert.equal(result.ok, true);
    if (result.ok)
        assert.equal(result.value, undefined);
});
test('store: delete removes the grant', async () => {
    const store = new InMemoryPermissionStore();
    const grant = makeGrant();
    await store.set(grant);
    await store.delete(grant.id);
    const result = await store.get(grant.id);
    assert.equal(result.ok, true);
    if (result.ok)
        assert.equal(result.value, undefined);
});
test('store: re-setting the same (package, permission, scope) upserts rather than duplicating', async () => {
    const store = new InMemoryPermissionStore();
    await store.set(makeGrant({ grantedAt: '2026-01-01T00:00:00.000Z' }));
    await store.set(makeGrant({ grantedAt: '2026-06-01T00:00:00.000Z' }));
    assert.equal(store.size(), 1);
    const list = await store.list();
    assert.equal(list.ok, true);
    if (list.ok)
        assert.equal(list.value[0]?.grantedAt, '2026-06-01T00:00:00.000Z');
});
test('store: list filters by packageId and permission', async () => {
    const store = new InMemoryPermissionStore();
    const otherPkg = PackageId('other.pkg');
    await store.set(makeGrant({ permission: Permissions.filesystem.read }));
    await store.set(makeGrant({ permission: Permissions.network.connect, id: computeGrantId(pkg, Permissions.network.connect, globalScope()) }));
    await store.set(makeGrant({ packageId: otherPkg, id: computeGrantId(otherPkg, Permissions.filesystem.read, globalScope()) }));
    const byPackage = await store.list({ packageId: pkg });
    assert.equal(byPackage.ok, true);
    if (byPackage.ok)
        assert.equal(byPackage.value.length, 2);
    const byPermission = await store.list({ packageId: pkg, permission: Permissions.filesystem.read });
    assert.equal(byPermission.ok, true);
    if (byPermission.ok)
        assert.equal(byPermission.value.length, 1);
});
test('store: list filters by capabilityId and lifetime', async () => {
    const store = new InMemoryPermissionStore();
    await store.set(makeGrant({ requesterCapabilityId: 'financial.document.read', lifetime: 'session', id: 'a' }));
    await store.set(makeGrant({ scope: pathScope('/other'), lifetime: 'persistent', id: 'b' }));
    const byCapability = await store.list({ capabilityId: 'financial.document.read' });
    assert.equal(byCapability.ok, true);
    if (byCapability.ok)
        assert.equal(byCapability.value.length, 1);
    const byLifetime = await store.list({ lifetime: 'session' });
    assert.equal(byLifetime.ok, true);
    if (byLifetime.ok)
        assert.equal(byLifetime.value.length, 1);
});
test('computeGrantId: deterministic and distinguishes scope', () => {
    const idA = computeGrantId(pkg, Permissions.filesystem.read, pathScope('/workspace'));
    const idB = computeGrantId(pkg, Permissions.filesystem.read, pathScope('/workspace'));
    const idC = computeGrantId(pkg, Permissions.filesystem.read, pathScope('/other'));
    assert.equal(idA, idB);
    assert.notEqual(idA, idC);
});
//# sourceMappingURL=store.test.js.map