import { test } from 'node:test';
import assert from 'node:assert/strict';
import { err, ok, type Result } from '@xo/types';
import { NotFoundError, type XoError } from '@xo/errors';
import type { PackageRecord, PackageRepository } from '../src/package-repository.interface.js';

/** Contract test only — no registry implementation is provided by this module. */
class InMemoryPackageRepositoryForContractTesting implements PackageRepository {
  private readonly store = new Map<string, PackageRecord>();

  async publish(record: PackageRecord): Promise<Result<void, XoError>> {
    this.store.set(record.id, record);
    return ok(undefined);
  }

  async get(id: string): Promise<Result<PackageRecord, NotFoundError>> {
    const record = this.store.get(id);
    return record ? ok(record) : err(new NotFoundError(`PackageRecord(${id})`));
  }

  async listByCreator(creatorDid: string): Promise<readonly PackageRecord[]> {
    return [...this.store.values()].filter((r) => r.manifest.creatorDid === creatorDid);
  }
}

test('publish then get round-trips a package record', async () => {
  const repo: PackageRepository = new InMemoryPackageRepositoryForContractTesting();
  const manifest = {
    formatVersion: '1.0',
    name: 'xo-corporate-contract-lawyer',
    version: '1.0.0',
    creatorDid: 'did:example:creator',
    compatibility: { modelFamilies: [], fallbackPolicy: 'degrade_gracefully' as const },
    components: {} as never,
  };
  await repo.publish({ id: 'pkg-1', manifest, publishedAt: new Date().toISOString() });
  const result = await repo.get('pkg-1');
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value.manifest.name, 'xo-corporate-contract-lawyer');
});

test('get on an unpublished id returns NotFoundError', async () => {
  const repo: PackageRepository = new InMemoryPackageRepositoryForContractTesting();
  const result = await repo.get('missing');
  assert.equal(result.ok, false);
});
