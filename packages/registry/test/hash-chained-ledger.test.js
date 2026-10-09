import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HashChainedLedger } from '../src/ledger/hash-chained-ledger.js';
import { withTempStore, FixedClock } from './test-helpers.js';
test('append() returns an entry whose entryHash verifies', async () => {
    await withTempStore(async (store) => {
        const ledger = new HashChainedLedger(store, { clock: new FixedClock() });
        const result = await ledger.append('sha256:aaaa');
        assert.equal(result.ok, true);
        if (!result.ok)
            return;
        assert.equal(result.value.payloadHash, 'sha256:aaaa');
        assert.equal(result.value.recordedAt, '2026-01-01T00:00:00.000Z');
        assert.match(result.value.entryHash, /^sha256:[0-9a-f]{64}$/);
        assert.equal(await ledger.verify(result.value.entryHash), true);
    });
});
test('two entries chain together — the second entry depends on the first', async () => {
    await withTempStore(async (store) => {
        const ledger = new HashChainedLedger(store, { clock: new FixedClock() });
        const first = await ledger.append('sha256:aaaa');
        const second = await ledger.append('sha256:bbbb');
        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        if (!first.ok || !second.ok)
            return;
        assert.notEqual(first.value.entryHash, second.value.entryHash);
        assert.equal(await ledger.verify(first.value.entryHash), true);
        assert.equal(await ledger.verify(second.value.entryHash), true);
    });
});
test('verify() returns false for an entry hash that was never appended', async () => {
    await withTempStore(async (store) => {
        const ledger = new HashChainedLedger(store, { clock: new FixedClock() });
        assert.equal(await ledger.verify('sha256:' + '0'.repeat(64)), false);
    });
});
test('verify() detects a tampered payloadHash on the entry itself', async () => {
    await withTempStore(async (store) => {
        const ledger = new HashChainedLedger(store, { clock: new FixedClock() });
        const result = await ledger.append('sha256:aaaa');
        assert.equal(result.ok, true);
        if (!result.ok)
            return;
        // Tamper directly with the persisted entry, bypassing the ledger's
        // own API — simulating someone editing the backing store by hand.
        const key = `ledger/entries/${result.value.entryHash.replace(/^sha256:/, '')}.json`;
        const raw = await store.get(key);
        assert.equal(raw.ok, true);
        if (!raw.ok)
            return;
        const entry = JSON.parse(new TextDecoder().decode(raw.value));
        entry.payloadHash = 'sha256:tampered';
        await store.put(key, JSON.stringify(entry));
        assert.equal(await ledger.verify(result.value.entryHash), false);
    });
});
test('verify() detects tampering on an earlier entry in the chain', async () => {
    await withTempStore(async (store) => {
        const ledger = new HashChainedLedger(store, { clock: new FixedClock() });
        const first = await ledger.append('sha256:aaaa');
        const second = await ledger.append('sha256:bbbb');
        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        if (!first.ok || !second.ok)
            return;
        // Tamper with the FIRST entry only — verify() on the SECOND entry
        // should still catch it, since the chain links back to genesis.
        const key = `ledger/entries/${first.value.entryHash.replace(/^sha256:/, '')}.json`;
        const raw = await store.get(key);
        assert.equal(raw.ok, true);
        if (!raw.ok)
            return;
        const entry = JSON.parse(new TextDecoder().decode(raw.value));
        entry.payloadHash = 'sha256:tampered';
        await store.put(key, JSON.stringify(entry));
        assert.equal(await ledger.verify(first.value.entryHash), false);
        assert.equal(await ledger.verify(second.value.entryHash), false);
    });
});
test('append() persists a recoverable head across ledger instances', async () => {
    await withTempStore(async (store) => {
        const ledgerA = new HashChainedLedger(store, { clock: new FixedClock() });
        const first = await ledgerA.append('sha256:aaaa');
        assert.equal(first.ok, true);
        if (!first.ok)
            return;
        // A fresh instance over the same store should chain off the same head.
        const ledgerB = new HashChainedLedger(store, { clock: new FixedClock('2026-01-02T00:00:00.000Z') });
        const second = await ledgerB.append('sha256:bbbb');
        assert.equal(second.ok, true);
        if (!second.ok)
            return;
        assert.equal(await ledgerB.verify(second.value.entryHash), true);
    });
});
//# sourceMappingURL=hash-chained-ledger.test.js.map