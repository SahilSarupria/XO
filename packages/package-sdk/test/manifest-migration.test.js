import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManifestMigrationRegistry } from '../src/manifest/manifest-migration.js';
test('migrate() is a no-op when already at the target version', () => {
    const registry = new ManifestMigrationRegistry();
    const raw = { formatVersion: '1.0', name: 'x' };
    const result = registry.migrate(raw, '1.0');
    assert.ok(result.ok);
    assert.deepEqual(result.value, raw);
});
test('migrate() applies a single registered step', () => {
    const registry = new ManifestMigrationRegistry();
    registry.register({
        from: '1.0',
        to: '2.0',
        migrate: (raw) => ({ ...raw, newField: 'default-value' }),
    });
    const result = registry.migrate({ formatVersion: '1.0', name: 'x' }, '2.0');
    assert.ok(result.ok);
    assert.equal(result.value.newField, 'default-value');
    assert.equal(result.value.formatVersion, '2.0');
});
test('migrate() chains multiple registered steps in sequence', () => {
    const registry = new ManifestMigrationRegistry();
    registry.register({ from: '1.0', to: '1.1', migrate: (raw) => ({ ...raw, a: 1 }) });
    registry.register({ from: '1.1', to: '2.0', migrate: (raw) => ({ ...raw, b: 2 }) });
    const result = registry.migrate({ formatVersion: '1.0' }, '2.0');
    assert.ok(result.ok);
    assert.equal(result.value.a, 1);
    assert.equal(result.value.b, 2);
    assert.equal(result.value.formatVersion, '2.0');
});
test('migrate() fails when no path exists to the target version', () => {
    const registry = new ManifestMigrationRegistry();
    registry.register({ from: '1.0', to: '1.1', migrate: (raw) => raw });
    const result = registry.migrate({ formatVersion: '1.0' }, '3.0');
    assert.equal(result.ok, false);
    if (!result.ok)
        assert.match(result.error.message, /No registered migration/);
});
test('migrate() detects a migration cycle instead of looping forever', () => {
    const registry = new ManifestMigrationRegistry();
    registry.register({ from: '1.0', to: '1.1', migrate: (raw) => ({ ...raw, formatVersion: '1.1' }) });
    registry.register({ from: '1.1', to: '1.0', migrate: (raw) => ({ ...raw, formatVersion: '1.0' }) });
    const result = registry.migrate({ formatVersion: '1.0' }, '9.9');
    assert.equal(result.ok, false);
    if (!result.ok)
        assert.match(result.error.message, /cycle/);
});
//# sourceMappingURL=manifest-migration.test.js.map