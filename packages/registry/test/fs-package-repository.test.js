import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FsPackageRepository } from '../src/package/fs-package-repository.js';
import { withTempStore } from './test-helpers.js';
import { buildFixtureManifest } from './manifest-fixtures.js';
test('publish() then get() round-trips a real, verified manifest', async () => {
    await withTempStore(async (store) => {
        const repo = new FsPackageRepository(store);
        const manifest = buildFixtureManifest();
        const id = manifest.merkleRoot;
        const published = await repo.publish({ id, manifest, publishedAt: '2026-01-01T00:00:00.000Z' });
        assert.equal(published.ok, true);
        const fetched = await repo.get(id);
        assert.equal(fetched.ok, true);
        if (!fetched.ok)
            return;
        assert.equal(fetched.value.id, id);
        assert.equal(fetched.value.manifest.name, manifest.name);
    });
});
test('publish() rejects a manifest with no merkleRoot', async () => {
    await withTempStore(async (store) => {
        const repo = new FsPackageRepository(store);
        const manifest = { ...buildFixtureManifest(), merkleRoot: undefined };
        const published = await repo.publish({ id: 'sha256:' + '0'.repeat(64), manifest, publishedAt: '2026-01-01T00:00:00.000Z' });
        assert.equal(published.ok, false);
        if (published.ok)
            return;
        assert.equal(published.error.code, 'XO_REGISTRY_PACKAGE_UNVERIFIED');
    });
});
test('publish() rejects a manifest that fails schema validation', async () => {
    await withTempStore(async (store) => {
        const repo = new FsPackageRepository(store);
        const badManifest = { formatVersion: '1.0' };
        const published = await repo.publish({ id: 'sha256:' + '1'.repeat(64), manifest: badManifest, publishedAt: '2026-01-01T00:00:00.000Z' });
        assert.equal(published.ok, false);
        if (published.ok)
            return;
        assert.equal(published.error.code, 'XO_REGISTRY_PACKAGE_UNVERIFIED');
    });
});
test('publish() rejects a record whose id does not match manifest.merkleRoot', async () => {
    await withTempStore(async (store) => {
        const repo = new FsPackageRepository(store);
        const manifest = buildFixtureManifest();
        const published = await repo.publish({ id: 'sha256:' + 'f'.repeat(64), manifest, publishedAt: '2026-01-01T00:00:00.000Z' });
        assert.equal(published.ok, false);
        if (published.ok)
            return;
        assert.equal(published.error.code, 'XO_REGISTRY_PACKAGE_UNVERIFIED');
    });
});
test('publish() rejects a duplicate publish of the same content-addressed id', async () => {
    await withTempStore(async (store) => {
        const repo = new FsPackageRepository(store);
        const manifest = buildFixtureManifest();
        const id = manifest.merkleRoot;
        const record = { id, manifest, publishedAt: '2026-01-01T00:00:00.000Z' };
        const first = await repo.publish(record);
        assert.equal(first.ok, true);
        const second = await repo.publish(record);
        assert.equal(second.ok, false);
        if (second.ok)
            return;
        assert.equal(second.error.code, 'XO_REGISTRY_PACKAGE_ALREADY_PUBLISHED');
    });
});
test('get() on an unpublished id returns NotFoundError', async () => {
    await withTempStore(async (store) => {
        const repo = new FsPackageRepository(store);
        const result = await repo.get('sha256:' + '0'.repeat(64));
        assert.equal(result.ok, false);
        if (result.ok)
            return;
        assert.equal(result.error.code, 'XO_NOT_FOUND');
    });
});
test('listByCreator() returns every package published by that creator, and none from others', async () => {
    await withTempStore(async (store) => {
        const repo = new FsPackageRepository(store);
        const alice1 = buildFixtureManifest({ name: 'xo_alice_one', creatorDid: 'did:xo:alice' });
        const alice2 = buildFixtureManifest({ name: 'xo_alice_two', creatorDid: 'did:xo:alice' });
        const bob1 = buildFixtureManifest({ name: 'xo_bob_one', creatorDid: 'did:xo:bob' });
        for (const manifest of [alice1, alice2, bob1]) {
            const id = manifest.merkleRoot;
            const result = await repo.publish({ id, manifest, publishedAt: '2026-01-01T00:00:00.000Z' });
            assert.equal(result.ok, true);
        }
        const aliceRecords = await repo.listByCreator('did:xo:alice');
        assert.equal(aliceRecords.length, 2);
        assert.deepEqual(aliceRecords.map((r) => r.manifest.name).sort(), ['xo_alice_one', 'xo_alice_two']);
        const bobRecords = await repo.listByCreator('did:xo:bob');
        assert.equal(bobRecords.length, 1);
        assert.equal(bobRecords[0]?.manifest.name, 'xo_bob_one');
    });
});
test('listByCreator() for an unknown creator returns an empty list, not an error', async () => {
    await withTempStore(async (store) => {
        const repo = new FsPackageRepository(store);
        const records = await repo.listByCreator('did:xo:nobody');
        assert.deepEqual(records, []);
    });
});
//# sourceMappingURL=fs-package-repository.test.js.map