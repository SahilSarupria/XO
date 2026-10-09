import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '@xo/types';
import { RuntimeCapabilityRegistry } from '../src/capability-authority/runtime-capability-registry.js';
function declaration(overrides = {}) {
    return {
        capabilityId: 'echo',
        inputContract: { description: 'Any string.' },
        outputContract: { description: 'The same string, unchanged.' },
        handler: async (input) => ok(input),
        ...overrides,
    };
}
test('register + resolve: a validly declared capability round-trips exactly', () => {
    const registry = new RuntimeCapabilityRegistry();
    const decl = declaration();
    const registered = registry.register({ declaration: decl });
    assert.ok(registered.ok);
    const resolved = registry.resolve('echo');
    assert.ok(resolved.ok);
    if (resolved.ok)
        assert.equal(resolved.value, decl);
});
test('resolve: unknown capability id fails closed with RUNTIME_CAPABILITY_NOT_FOUND', () => {
    const registry = new RuntimeCapabilityRegistry();
    const resolved = registry.resolve('does-not-exist');
    assert.equal(resolved.ok, false);
    if (!resolved.ok)
        assert.equal(resolved.error.code, 'XO_RUNTIME_CAPABILITY_NOT_FOUND');
});
test('register: empty capabilityId is rejected and never stored', () => {
    const registry = new RuntimeCapabilityRegistry();
    const result = registry.register({ declaration: declaration({ capabilityId: '  ' }) });
    assert.equal(result.ok, false);
    if (!result.ok)
        assert.equal(result.error.code, 'XO_RUNTIME_CAPABILITY_DECLARATION_INVALID');
    assert.equal(registry.size, 0);
});
test('register: non-function handler is rejected (malformed declaration fails closed)', () => {
    const registry = new RuntimeCapabilityRegistry();
    const result = registry.register({ declaration: declaration({ handler: 'not-a-function' }) });
    assert.equal(result.ok, false);
    if (!result.ok)
        assert.equal(result.error.code, 'XO_RUNTIME_CAPABILITY_DECLARATION_INVALID');
    assert.equal(registry.has('echo'), false);
});
test('register: missing input/output contract description is rejected', () => {
    const registry = new RuntimeCapabilityRegistry();
    const missingInput = registry.register({ declaration: declaration({ inputContract: { description: '' } }) });
    assert.equal(missingInput.ok, false);
    const missingOutput = registry.register({ declaration: declaration({ outputContract: { description: '   ' } }) });
    assert.equal(missingOutput.ok, false);
});
test('register: re-registering the same id overwrites the prior declaration', () => {
    const registry = new RuntimeCapabilityRegistry();
    registry.register({ declaration: declaration() });
    const v2 = declaration({ version: '2.0.0' });
    registry.register({ declaration: v2 });
    const resolved = registry.resolve('echo');
    assert.ok(resolved.ok);
    if (resolved.ok)
        assert.equal(resolved.value.version, '2.0.0');
    assert.equal(registry.size, 1);
});
test('register: capability ids are stable/deterministic across repeated lookups', () => {
    const registry = new RuntimeCapabilityRegistry();
    registry.register({ declaration: declaration({ capabilityId: 'stable-id' }) });
    const first = registry.resolve('stable-id');
    const second = registry.resolve('stable-id');
    assert.ok(first.ok && second.ok);
    if (first.ok && second.ok)
        assert.equal(first.value, second.value);
});
test('registeredCapabilities/has/size reflect registered state accurately', () => {
    const registry = new RuntimeCapabilityRegistry();
    assert.equal(registry.size, 0);
    registry.register({ declaration: declaration({ capabilityId: 'a' }) });
    registry.register({ declaration: declaration({ capabilityId: 'b' }) });
    assert.equal(registry.size, 2);
    assert.deepEqual([...registry.registeredCapabilities()].sort(), ['a', 'b']);
    assert.equal(registry.has('a'), true);
    assert.equal(registry.has('c'), false);
});
test('this registry has no dependency on any package/manifest type — structurally cannot be influenced by package content', () => {
    // RuntimeCapabilityRegistry.register/resolve/has take only a
    // RuntimeCapabilityDeclaration/capabilityId string — never a
    // MountedPackage or XoManifest. Demonstrated behaviorally: registering
    // a capability using data that merely *resembles* a package-sourced
    // capability (same id, same-shaped metadata) has no bearing on what a
    // real package's CapabilityRegistry would report — the two are
    // entirely separate stores with no shared state, exercised end-to-end
    // in packager-boundary.test.ts.
    const registry = new RuntimeCapabilityRegistry();
    assert.equal(registry.has('send_email'), false);
    registry.register({ declaration: declaration({ capabilityId: 'send_email' }) });
    assert.equal(registry.has('send_email'), true);
    // Presence here is purely a function of an explicit register() call —
    // there is no other way for an entry to appear.
});
//# sourceMappingURL=runtime-capability-registry.test.js.map