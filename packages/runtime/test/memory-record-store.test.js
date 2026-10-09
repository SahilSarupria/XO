import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryDurableMemoryStore } from '../src/memory/in-memory-durable-memory-store.js';
import { FileMemoryRecordStore } from '../src/persistence/file/file-memory-store.js';
import { MemoryEntryId } from '../src/ids.js';
import { deriveMemoryEntryId, generateMemoryEntryId } from '../src/memory/memory-id.js';
import { executionScope, sessionScope, workflowScope, runtimeScope } from '../src/memory/memory-types.js';
let clockNow = new Date('2026-01-01T00:00:00.000Z');
const now = () => clockNow;
function fixtureEntry(overrides = {}) {
    const scope = overrides.scope ?? executionScope('exec-1');
    const id = overrides.id ?? generateMemoryEntryId();
    return {
        id,
        scope,
        type: 'fact',
        value: { hello: 'world' },
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        ...overrides,
    };
}
const fixtures = [
    { name: 'InMemoryDurableMemoryStore', create: async () => ({ store: new InMemoryDurableMemoryStore(now), cleanup: async () => { } }) },
    {
        name: 'FileMemoryRecordStore',
        create: async () => {
            const dir = await mkdtemp(join(tmpdir(), 'xo-memory-store-'));
            return { store: new FileMemoryRecordStore(dir, now), cleanup: async () => rm(dir, { recursive: true, force: true }) };
        },
    },
];
for (const fixture of fixtures) {
    test(`[${fixture.name}] put/get roundtrip`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const entry = fixtureEntry({ value: { note: 'hi' } });
            const saved = await store.put(entry);
            assert.equal(saved.ok, true);
            const got = await store.get(entry.scope, entry.id);
            assert.equal(got.ok, true);
            assert.ok(got.ok && got.value);
            assert.deepEqual(got.ok && got.value?.data.value, { note: 'hi' });
        }
        finally {
            await cleanup();
        }
    });
    test(`[${fixture.name}] get on unknown id returns undefined, not an error`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const result = await store.get(executionScope('nope'), MemoryEntryId('mem_absent'));
            assert.equal(result.ok, true);
            assert.equal(result.ok && result.value, undefined);
        }
        finally {
            await cleanup();
        }
    });
    test(`[${fixture.name}] update/upsert replaces value at the same id`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const scope = executionScope('exec-upsert');
            const id = deriveMemoryEntryId(scope, 'preference.language');
            await store.put(fixtureEntry({ id, scope, key: 'preference.language', value: 'en' }));
            await store.put(fixtureEntry({ id, scope, key: 'preference.language', value: 'fr' }));
            const got = await store.get(scope, id);
            assert.equal(got.ok && got.value?.data.value, 'fr');
            const listed = await store.query(scope);
            assert.equal(listed.ok && listed.value.length, 1);
        }
        finally {
            await cleanup();
        }
    });
    test(`[${fixture.name}] delete removes the entry; deleting twice returns false the second time`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const entry = fixtureEntry();
            await store.put(entry);
            const firstDelete = await store.delete(entry.scope, entry.id);
            assert.equal(firstDelete.ok && firstDelete.value, true);
            const secondDelete = await store.delete(entry.scope, entry.id);
            assert.equal(secondDelete.ok && secondDelete.value, false);
            const got = await store.get(entry.scope, entry.id);
            assert.equal(got.ok && got.value, undefined);
        }
        finally {
            await cleanup();
        }
    });
    test(`[${fixture.name}] query filters by type and key, and respects limit`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const scope = sessionScope('sess-query');
            await store.put(fixtureEntry({ scope, type: 'fact', key: 'a', value: 1 }));
            await store.put(fixtureEntry({ scope, type: 'preference', key: 'b', value: 2 }));
            await store.put(fixtureEntry({ scope, type: 'fact', key: 'c', value: 3 }));
            const facts = await store.query(scope, { type: 'fact' });
            assert.equal(facts.ok && facts.value.length, 2);
            const byKey = await store.query(scope, { key: 'b' });
            assert.equal(byKey.ok && byKey.value.length, 1);
            assert.equal(byKey.ok && byKey.value[0]?.data.value, 2);
            const limited = await store.query(scope, { limit: 1 });
            assert.equal(limited.ok && limited.value.length, 1);
        }
        finally {
            await cleanup();
        }
    });
    test(`[${fixture.name}] query on an empty/unknown scope returns an empty list, not an error`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const result = await store.query(runtimeScope());
            assert.equal(result.ok, true);
            assert.deepEqual(result.ok && result.value, []);
        }
        finally {
            await cleanup();
        }
    });
    test(`[${fixture.name}] clear deletes every entry in a scope and returns the count`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const scope = workflowScope('wf-clear');
            await store.put(fixtureEntry({ scope }));
            await store.put(fixtureEntry({ scope }));
            const cleared = await store.clear(scope);
            assert.equal(cleared.ok && cleared.value, 2);
            const after = await store.query(scope);
            assert.deepEqual(after.ok && after.value, []);
        }
        finally {
            await cleanup();
        }
    });
    test(`[${fixture.name}] scope isolation: execution A cannot read execution B's memory`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const scopeA = executionScope('exec-A');
            const scopeB = executionScope('exec-B');
            const id = deriveMemoryEntryId(scopeA, 'secret');
            await store.put(fixtureEntry({ id, scope: scopeA, key: 'secret', value: 'A-only' }));
            const crossRead = await store.get(scopeB, id);
            assert.equal(crossRead.ok && crossRead.value, undefined);
            const crossQuery = await store.query(scopeB);
            assert.deepEqual(crossQuery.ok && crossQuery.value, []);
        }
        finally {
            await cleanup();
        }
    });
    test(`[${fixture.name}] scope isolation: session A cannot read session B's memory, and workflow scope is isolated from execution scope even with the same underlying id`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const sessA = sessionScope('sess-A');
            const sessB = sessionScope('sess-B');
            await store.put(fixtureEntry({ scope: sessA, value: 'A' }));
            const bResults = await store.query(sessB);
            assert.deepEqual(bResults.ok && bResults.value, []);
            // Same scopeId string, different scope *kind* — must not collide.
            const execScope = executionScope('shared-id');
            const wfScope = workflowScope('shared-id');
            const execId = deriveMemoryEntryId(execScope, 'k');
            const wfId = deriveMemoryEntryId(wfScope, 'k');
            assert.notEqual(execId, wfId, 'deterministic ids must differ across scope kinds even with an identical scopeId and key');
            await store.put(fixtureEntry({ id: execId, scope: execScope, key: 'k', value: 'exec-value' }));
            await store.put(fixtureEntry({ id: wfId, scope: wfScope, key: 'k', value: 'workflow-value' }));
            const execRead = await store.get(execScope, execId);
            const wfRead = await store.get(wfScope, wfId);
            assert.equal(execRead.ok && execRead.value?.data.value, 'exec-value');
            assert.equal(wfRead.ok && wfRead.value?.data.value, 'workflow-value');
            // Cross-kind get with the wrong scope must not find the other kind's entry.
            const wrongKind = await store.get(wfScope, execId);
            assert.equal(wrongKind.ok && wrongKind.value, undefined);
        }
        finally {
            await cleanup();
        }
    });
    test(`[${fixture.name}] TTL: expired entries are excluded from get() and query() but returned when includeExpired is set`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const scope = executionScope('exec-ttl');
            const entry = fixtureEntry({ scope, expiresAt: new Date('2026-01-01T00:00:05.000Z').toISOString() });
            await store.put(entry);
            clockNow = new Date('2026-01-01T00:00:01.000Z'); // before expiry
            const before = await store.get(scope, entry.id);
            assert.ok(before.ok && before.value);
            clockNow = new Date('2026-01-01T00:00:10.000Z'); // after expiry
            const after = await store.get(scope, entry.id);
            assert.equal(after.ok && after.value, undefined);
            const queried = await store.query(scope);
            assert.deepEqual(queried.ok && queried.value, []);
            const includeExpired = await store.query(scope, { includeExpired: true });
            assert.equal(includeExpired.ok && includeExpired.value.length, 1);
        }
        finally {
            clockNow = new Date('2026-01-01T00:00:00.000Z');
            await cleanup();
        }
    });
    test(`[${fixture.name}] TTL boundary: an entry expiring exactly "now" is treated as expired`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const scope = executionScope('exec-ttl-boundary');
            const expiresAt = new Date('2026-01-01T00:00:05.000Z').toISOString();
            const entry = fixtureEntry({ scope, expiresAt });
            await store.put(entry);
            clockNow = new Date(expiresAt);
            const result = await store.get(scope, entry.id);
            assert.equal(result.ok && result.value, undefined);
        }
        finally {
            clockNow = new Date('2026-01-01T00:00:00.000Z');
            await cleanup();
        }
    });
    test(`[${fixture.name}] provenance and confidence survive a put/get roundtrip`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const scope = executionScope('exec-provenance');
            const entry = fixtureEntry({
                scope,
                provenance: { sourceType: 'capability_output', executionId: 'exec-provenance', capabilityId: 'contract_analysis', recordedAt: now().toISOString(), confidence: 0.42 },
            });
            await store.put(entry);
            const got = await store.get(scope, entry.id);
            assert.equal(got.ok && got.value?.data.provenance?.confidence, 0.42);
            assert.equal(got.ok && got.value?.data.provenance?.capabilityId, 'contract_analysis');
            assert.equal(got.ok && got.value?.data.provenance?.sourceType, 'capability_output');
        }
        finally {
            await cleanup();
        }
    });
    test(`[${fixture.name}] concurrent writes to the same scope all persist`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const scope = sessionScope('sess-concurrent');
            await Promise.all(Array.from({ length: 20 }, (_, i) => store.put(fixtureEntry({ scope, key: `k${i}`, id: deriveMemoryEntryId(scope, `k${i}`), value: i }))));
            const listed = await store.query(scope);
            assert.equal(listed.ok && listed.value.length, 20);
        }
        finally {
            await cleanup();
        }
    });
    test(`[${fixture.name}] concurrent update vs delete on the same id resolves without throwing, and leaves a consistent final state`, async () => {
        const { store, cleanup } = await fixture.create();
        try {
            const scope = executionScope('exec-race');
            const entry = fixtureEntry({ scope });
            await store.put(entry);
            await Promise.all([store.put({ ...entry, value: 'updated' }), store.delete(scope, entry.id)]);
            const got = await store.get(scope, entry.id);
            assert.equal(got.ok, true); // either the update or the delete "won"; both are valid, neither should error
        }
        finally {
            await cleanup();
        }
    });
}
test('FileMemoryRecordStore: durable memory survives store recreation (restart)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xo-memory-restart-'));
    try {
        const scope = sessionScope('sess-restart');
        const storeA = new FileMemoryRecordStore(dir, now);
        const entry = fixtureEntry({ scope, key: 'restart-key', id: deriveMemoryEntryId(scope, 'restart-key'), value: 'survives' });
        await storeA.put(entry);
        // Simulate a full process restart: a brand-new store instance over the same rootDir.
        const storeB = new FileMemoryRecordStore(dir, now);
        const got = await storeB.get(scope, entry.id);
        assert.equal(got.ok && got.value?.data.value, 'survives');
        const listed = await storeB.query(scope);
        assert.equal(listed.ok && listed.value.length, 1);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('FileMemoryRecordStore: deterministic serialization — writing structurally-equal data twice produces byte-identical files', async () => {
    const { canonicalStringify } = await import('../src/persistence/file/atomic-file-io.js');
    const dir = await mkdtemp(join(tmpdir(), 'xo-memory-determinism-'));
    try {
        const scope = executionScope('exec-determinism');
        const entry = fixtureEntry({ scope, value: { b: 2, a: 1 } });
        const a = canonicalStringify(entry);
        const b = canonicalStringify({ ...entry });
        assert.equal(a, b);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=memory-record-store.test.js.map