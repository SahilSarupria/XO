import { test } from 'node:test';
import assert from 'node:assert/strict';
import { err, ok } from '@xo/types';
import { NotFoundError } from '@xo/errors';
/** Contract test only — no registry implementation is provided by this module. */
class InMemoryPackageRepositoryForContractTesting {
    store = new Map();
    async publish(record) {
        this.store.set(record.id, record);
        return ok(undefined);
    }
    async get(id) {
        const record = this.store.get(id);
        return record ? ok(record) : err(new NotFoundError(`PackageRecord(${id})`));
    }
    async listByCreator(creatorDid) {
        return [...this.store.values()].filter((r) => r.manifest.creatorDid === creatorDid);
    }
}
test('publish then get round-trips a package record', async () => {
    const repo = new InMemoryPackageRepositoryForContractTesting();
    const manifest = {
        formatVersion: '1.0',
        name: 'xo-corporate-contract-lawyer',
        version: '1.0.0',
        creatorDid: 'did:example:creator',
        compatibility: { modelFamilies: [], fallbackPolicy: 'degrade_gracefully' },
        components: {},
    };
    await repo.publish({ id: 'pkg-1', manifest, publishedAt: new Date().toISOString() });
    const result = await repo.get('pkg-1');
    assert.ok(result.ok);
    if (result.ok)
        assert.equal(result.value.manifest.name, 'xo-corporate-contract-lawyer');
});
test('get on an unpublished id returns NotFoundError', async () => {
    const repo = new InMemoryPackageRepositoryForContractTesting();
    const result = await repo.get('missing');
    assert.equal(result.ok, false);
});
//# sourceMappingURL=registry-interfaces.test.js.map