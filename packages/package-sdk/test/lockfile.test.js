import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDependencies } from '../src/resolver/resolver.js';
import { createLockfile, isLockfileStale, parseLockfile, serializeLockfile } from '../src/resolver/lockfile.js';
import { buildSampleManifest } from './fixtures.js';
function lookupFrom(registry) {
    return async (name) => registry.filter((m) => m.name === name);
}
async function resolveChain() {
    const coreMath = buildSampleManifest({ name: 'xo_core_math', version: '1.4.0' });
    const accountingToolkit = buildSampleManifest({
        name: 'xo_accounting_toolkit',
        version: '2.0.0',
        dependencies: [{ name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' }],
    });
    const financeXo = buildSampleManifest({
        name: 'xo_finance',
        version: '1.0.0',
        dependencies: [{ name: 'xo_accounting_toolkit', versionRange: '^2.0.0', kind: 'required' }],
    });
    const result = await resolveDependencies(financeXo, lookupFrom([coreMath, accountingToolkit]));
    if (!result.ok)
        throw new Error('fixture resolution unexpectedly failed');
    return { financeXo, resolution: result.value };
}
test('createLockfile records every resolved dependency (direct and transitive) with an exact version and a content hash', async () => {
    const { resolution } = await resolveChain();
    const lockfile = createLockfile(resolution);
    assert.equal(lockfile.rootName, 'xo_finance');
    assert.equal(lockfile.rootVersion, '1.0.0');
    assert.equal(lockfile.dependencies.length, 2);
    for (const dependency of lockfile.dependencies) {
        assert.match(dependency.version, /^\d+\.\d+\.\d+$/);
        assert.match(dependency.contentHash, /^sha256:[0-9a-f]{64}$/);
    }
});
test('createLockfile output is sorted by name regardless of resolution order', async () => {
    const { resolution } = await resolveChain();
    const lockfile = createLockfile(resolution);
    const names = lockfile.dependencies.map((d) => d.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});
test('serializeLockfile is deterministic: two lockfiles built from the same resolution serialize byte-for-byte identically', async () => {
    const { resolution } = await resolveChain();
    const first = serializeLockfile(createLockfile(resolution));
    const second = serializeLockfile(createLockfile(resolution));
    assert.equal(first, second);
});
test('serializeLockfile / parseLockfile round-trip preserves every field', async () => {
    const { resolution } = await resolveChain();
    const lockfile = createLockfile(resolution);
    const serialized = serializeLockfile(lockfile);
    const parsed = parseLockfile(serialized);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value, lockfile);
});
test('parseLockfile returns an err Result for invalid JSON', () => {
    const result = parseLockfile('{ not valid json');
    assert.equal(result.ok, false);
    if (!result.ok)
        assert.equal(result.error.code, 'XO_PACKAGE_LOCKFILE_INVALID');
});
test('parseLockfile returns an err Result for well-formed JSON that does not match the lockfile shape', () => {
    const result = parseLockfile(JSON.stringify({ hello: 'world' }));
    assert.equal(result.ok, false);
    if (!result.ok)
        assert.equal(result.error.code, 'XO_PACKAGE_LOCKFILE_INVALID');
});
test('isLockfileStale is false immediately after resolving and locking', async () => {
    const { financeXo, resolution } = await resolveChain();
    const lockfile = createLockfile(resolution);
    const staleResult = isLockfileStale(financeXo, lockfile);
    assert.deepEqual(staleResult, { ok: true, value: false });
});
test('isLockfileStale is true when the manifest declares a range the locked version no longer satisfies', async () => {
    const { financeXo, resolution } = await resolveChain();
    const lockfile = createLockfile(resolution);
    const bumpedRange = {
        ...financeXo,
        dependencies: [{ name: 'xo_accounting_toolkit', versionRange: '^3.0.0', kind: 'required' }],
    };
    const staleResult = isLockfileStale(bumpedRange, lockfile);
    assert.deepEqual(staleResult, { ok: true, value: true });
});
test('isLockfileStale is true when a newly declared required dependency is entirely absent from the lock', async () => {
    const { financeXo, resolution } = await resolveChain();
    const lockfile = createLockfile(resolution);
    const withNewDep = {
        ...financeXo,
        dependencies: [...(financeXo.dependencies ?? []), { name: 'xo_brand_new_dep', versionRange: '^1.0.0', kind: 'required' }],
    };
    const staleResult = isLockfileStale(withNewDep, lockfile);
    assert.deepEqual(staleResult, { ok: true, value: true });
});
test('isLockfileStale is true when the root package name or version itself changed', async () => {
    const { financeXo, resolution } = await resolveChain();
    const lockfile = createLockfile(resolution);
    const rebumped = { ...financeXo, version: '1.1.0' };
    assert.deepEqual(isLockfileStale(rebumped, lockfile), { ok: true, value: true });
});
test('isLockfileStale ignores peer dependencies (never independently locked)', async () => {
    const { financeXo, resolution } = await resolveChain();
    const lockfile = createLockfile(resolution);
    const withPeer = {
        ...financeXo,
        dependencies: [...(financeXo.dependencies ?? []), { name: 'xo_some_peer', versionRange: '^1.0.0', kind: 'peer' }],
    };
    assert.deepEqual(isLockfileStale(withPeer, lockfile), { ok: true, value: false });
});
test('isLockfileStale tolerates a missing optional dependency in the lock (it may have been legitimately unresolvable)', async () => {
    const { financeXo, resolution } = await resolveChain();
    const lockfile = createLockfile(resolution);
    const withOptional = {
        ...financeXo,
        dependencies: [...(financeXo.dependencies ?? []), { name: 'xo_optional_thing', versionRange: '^1.0.0', kind: 'optional' }],
    };
    assert.deepEqual(isLockfileStale(withOptional, lockfile), { ok: true, value: false });
});
//# sourceMappingURL=lockfile.test.js.map