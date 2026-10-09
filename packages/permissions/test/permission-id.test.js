import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionId, Permissions, parsePermissionId, permissionDomain } from '../src/permission-id.js';
test('permission id: valid ids parse and round-trip', () => {
    const id = PermissionId('filesystem.read');
    assert.equal(id, 'filesystem.read');
    assert.equal(permissionDomain(id), 'filesystem');
});
test('permission id: hyphenated actions are valid', () => {
    const id = PermissionId('ai.external-provider');
    assert.equal(permissionDomain(id), 'ai');
});
test('permission id: rejects unknown domain', () => {
    const result = parsePermissionId('bogus.read');
    assert.equal(result.ok, false);
    if (!result.ok)
        assert.match(result.error, /unrecognized domain/);
});
test('permission id: rejects malformed strings', () => {
    for (const bad of ['', 'filesystem', 'filesystem.', '.read', 'filesystem..read', 'Filesystem.Read', 'filesystem.read ', ' filesystem.read', 'filesystem.read.write', 'filesystem.re ad', 'filesystem.-read', 'filesystem.read-']) {
        const result = parsePermissionId(bad);
        assert.equal(result.ok, false, `expected "${bad}" to be rejected`);
    }
});
test('permission id: no spoofing via lookalike domains', () => {
    // A domain that merely *contains* a known domain as a substring must
    // still be rejected outright.
    const result = parsePermissionId('filesystemx.read');
    assert.equal(result.ok, false);
});
test('permission id: throwing constructor throws TypeError on invalid input', () => {
    assert.throws(() => PermissionId('not-a-permission'), TypeError);
});
test('permission id: canonical catalog matches the spec examples', () => {
    assert.equal(Permissions.filesystem.read, 'filesystem.read');
    assert.equal(Permissions.filesystem.write, 'filesystem.write');
    assert.equal(Permissions.filesystem.delete, 'filesystem.delete');
    assert.equal(Permissions.network.connect, 'network.connect');
    assert.equal(Permissions.network.listen, 'network.listen');
    assert.equal(Permissions.process.spawn, 'process.spawn');
    assert.equal(Permissions.process.execute, 'process.execute');
    assert.equal(Permissions.environment.read, 'environment.read');
    assert.equal(Permissions.secrets.read, 'secrets.read');
    assert.equal(Permissions.secrets.write, 'secrets.write');
    assert.equal(Permissions.clipboard.read, 'clipboard.read');
    assert.equal(Permissions.clipboard.write, 'clipboard.write');
    assert.equal(Permissions.device.camera, 'device.camera');
    assert.equal(Permissions.device.microphone, 'device.microphone');
    assert.equal(Permissions.ai.inference, 'ai.inference');
    assert.equal(Permissions.ai.externalProvider, 'ai.external-provider');
    assert.equal(Permissions.data.read, 'data.read');
    assert.equal(Permissions.data.write, 'data.write');
    assert.equal(Permissions.package.install, 'package.install');
    assert.equal(Permissions.package.publish, 'package.publish');
    assert.equal(Permissions.runtime.execute, 'runtime.execute');
    assert.equal(Permissions.runtime.workflow, 'runtime.workflow');
});
//# sourceMappingURL=permission-id.test.js.map