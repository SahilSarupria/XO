import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Permissions } from '../src/permission-id.js';
import { pathScope } from '../src/scope.js';
import { CapabilityPermissionRegistry } from '../src/capability-mapping.js';
test('capability mapping: resolves requirements registered for a capability', () => {
    const registry = new CapabilityPermissionRegistry();
    registry.register('financial.document.read', [{ permission: Permissions.filesystem.read, scope: pathScope('/documents') }]);
    const resolved = registry.resolve('financial.document.read');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.permission, Permissions.filesystem.read);
});
test('capability mapping: unregistered capability resolves to an empty list, not an error', () => {
    const registry = new CapabilityPermissionRegistry();
    assert.deepEqual(registry.resolve('unknown.capability'), []);
    assert.equal(registry.has('unknown.capability'), false);
});
test('capability mapping: re-registering the same capability merges rather than overwrites', () => {
    const registry = new CapabilityPermissionRegistry();
    registry.register('web.research', [{ permission: Permissions.network.connect }]);
    registry.register('web.research', [{ permission: Permissions.ai.inference }]);
    const resolved = registry.resolve('web.research');
    assert.equal(resolved.length, 2);
});
test('capability mapping: registering an identical requirement twice does not duplicate it', () => {
    const registry = new CapabilityPermissionRegistry();
    registry.register('web.research', [{ permission: Permissions.network.connect }]);
    registry.register('web.research', [{ permission: Permissions.network.connect }]);
    assert.equal(registry.resolve('web.research').length, 1);
});
test('capability mapping: rejects an empty capability id', () => {
    const registry = new CapabilityPermissionRegistry();
    const result = registry.register('', [{ permission: Permissions.network.connect }]);
    assert.equal(result.ok, false);
});
test('capability mapping: registeredCapabilities lists every registered id', () => {
    const registry = new CapabilityPermissionRegistry();
    registry.register('web.research', [{ permission: Permissions.network.connect }]);
    registry.register('shell.execution', [{ permission: Permissions.process.execute }]);
    assert.deepEqual([...registry.registeredCapabilities()].sort(), ['shell.execution', 'web.research']);
});
//# sourceMappingURL=capability-mapping.test.js.map