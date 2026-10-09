import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifestPermission, resolveManifestCapabilityPermissions, resolveManifestPermissions } from '../src/manifest.js';
test('manifest: parses a filesystem permission scope as a path scope', () => {
    const result = parseManifestPermission({ permission: 'filesystem.read', scope: '/workspace' });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.permission, 'filesystem.read');
        assert.deepEqual(result.value.scope, { kind: 'path', path: '/workspace' });
    }
});
test('manifest: parses a network permission scope as a host scope', () => {
    const result = parseManifestPermission({ permission: 'network.connect', scope: 'api.example.com' });
    assert.equal(result.ok, true);
    if (result.ok)
        assert.deepEqual(result.value.scope, { kind: 'host', host: 'api.example.com' });
});
test('manifest: parses a secrets permission scope as a resource scope', () => {
    const result = parseManifestPermission({ permission: 'secrets.read', scope: 'OPENAI_API_KEY' });
    assert.equal(result.ok, true);
    if (result.ok)
        assert.deepEqual(result.value.scope, { kind: 'resource', resource: 'OPENAI_API_KEY' });
});
test('manifest: an omitted scope stays omitted (not coerced to global)', () => {
    const result = parseManifestPermission({ permission: 'ai.inference' });
    assert.equal(result.ok, true);
    if (result.ok)
        assert.equal(result.value.scope, undefined);
});
test('manifest: an invalid permission string is rejected, not silently dropped', () => {
    const result = parseManifestPermission({ permission: 'not-a-permission' });
    assert.equal(result.ok, false);
});
test('resolveManifestPermissions: an absent permissions field resolves to an empty list', () => {
    const result = resolveManifestPermissions({});
    assert.equal(result.ok, true);
    if (result.ok)
        assert.deepEqual(result.value, []);
});
test('resolveManifestPermissions: parses every declaration and preserves order', () => {
    const result = resolveManifestPermissions({
        permissions: [
            { permission: 'filesystem.read', scope: '/workspace' },
            { permission: 'network.connect', scope: 'api.example.com' },
        ],
    });
    assert.equal(result.ok, true);
    if (result.ok)
        assert.equal(result.value.length, 2);
});
test('resolveManifestPermissions: collects every parse error rather than stopping at the first', () => {
    const result = resolveManifestPermissions({
        permissions: [{ permission: 'bogus.one' }, { permission: 'bogus.two' }, { permission: 'filesystem.read' }],
    });
    assert.equal(result.ok, false);
    if (!result.ok)
        assert.equal(result.error.length, 2);
});
// --- resolveManifestCapabilityPermissions (Stage 2, §4) --------------------
test('resolveManifestCapabilityPermissions: groups declarations by capabilityId', () => {
    const result = resolveManifestCapabilityPermissions({
        permissions: [
            { permission: 'filesystem.read', scope: '/documents', capabilityId: 'financial.document.read' },
            { permission: 'network.connect', scope: 'api.example.com', capabilityId: 'web.research' },
        ],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.get('financial.document.read')?.length, 1);
        assert.equal(result.value.get('web.research')?.length, 1);
        assert.equal(result.value.get('unrelated.capability'), undefined);
    }
});
test('resolveManifestCapabilityPermissions: a declaration with no capabilityId is excluded (package-level notice only)', () => {
    const result = resolveManifestCapabilityPermissions({
        permissions: [{ permission: 'secrets.read', scope: 'API_KEY' }],
    });
    assert.equal(result.ok, true);
    if (result.ok)
        assert.equal(result.value.size, 0);
});
test('resolveManifestCapabilityPermissions: a capability can require multiple permissions', () => {
    const result = resolveManifestCapabilityPermissions({
        permissions: [
            { permission: 'filesystem.read', capabilityId: 'financial.document.read' },
            { permission: 'data.read', capabilityId: 'financial.document.read' },
        ],
    });
    assert.equal(result.ok, true);
    if (result.ok)
        assert.equal(result.value.get('financial.document.read')?.length, 2);
});
test('resolveManifestCapabilityPermissions: an absent permissions field resolves to an empty map, not an error', () => {
    const result = resolveManifestCapabilityPermissions({});
    assert.equal(result.ok, true);
    if (result.ok)
        assert.equal(result.value.size, 0);
});
test('resolveManifestCapabilityPermissions: a malformed permission for a named capability fails closed with an error, not silent omission', () => {
    const result = resolveManifestCapabilityPermissions({
        permissions: [{ permission: 'not-a-real-permission', capabilityId: 'financial.document.read' }],
    });
    assert.equal(result.ok, false);
    if (!result.ok)
        assert.match(result.error[0] ?? '', /financial\.document\.read/);
});
test('resolveManifestCapabilityPermissions: an unknown permission domain fails closed', () => {
    const result = resolveManifestCapabilityPermissions({
        permissions: [{ permission: 'bogus_domain.action', capabilityId: 'some.capability' }],
    });
    assert.equal(result.ok, false);
});
test('resolveManifestCapabilityPermissions: collects errors across multiple capabilities in one pass', () => {
    const result = resolveManifestCapabilityPermissions({
        permissions: [
            { permission: 'bad.one', capabilityId: 'cap.a' },
            { permission: 'bad.two', capabilityId: 'cap.b' },
            { permission: 'filesystem.read', capabilityId: 'cap.c' },
        ],
    });
    assert.equal(result.ok, false);
    if (!result.ok)
        assert.equal(result.error.length, 2);
});
//# sourceMappingURL=manifest.test.js.map