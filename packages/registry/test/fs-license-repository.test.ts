import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FsLicenseRepository, validateRoyaltySplit } from '../src/license/fs-license-repository.js';
import { withTempStore } from './test-helpers.js';

function sampleLicense(overrides: Partial<{ id: string; royaltySplit: { role: 'creator' | 'reviewer' | 'dataset_contributor' | 'platform'; basisPoints: number }[] }> = {}) {
  return {
    id: overrides.id ?? 'license-1',
    packageId: 'sha256:' + 'a'.repeat(64),
    tier: 'standard',
    royaltySplit: overrides.royaltySplit ?? [
      { role: 'creator' as const, basisPoints: 7000 },
      { role: 'platform' as const, basisPoints: 3000 },
    ],
  };
}

test('validateRoyaltySplit accepts splits that sum to exactly 10000', () => {
  assert.equal(validateRoyaltySplit([{ role: 'creator', basisPoints: 10000 }]), undefined);
  assert.equal(
    validateRoyaltySplit([
      { role: 'creator', basisPoints: 6000 },
      { role: 'reviewer', basisPoints: 1000 },
      { role: 'dataset_contributor', basisPoints: 1000 },
      { role: 'platform', basisPoints: 2000 },
    ]),
    undefined,
  );
});

test('validateRoyaltySplit rejects a split under 10000', () => {
  const error = validateRoyaltySplit([{ role: 'creator', basisPoints: 9999 }]);
  assert.match(error ?? '', /must sum to exactly 10000, got 9999/);
});

test('validateRoyaltySplit rejects a split over 10000', () => {
  const error = validateRoyaltySplit([
    { role: 'creator', basisPoints: 7000 },
    { role: 'platform', basisPoints: 4000 },
  ]);
  assert.match(error ?? '', /must sum to exactly 10000, got 11000/);
});

test('validateRoyaltySplit rejects an empty split', () => {
  const error = validateRoyaltySplit([]);
  assert.match(error ?? '', /at least one recipient/);
});

test('validateRoyaltySplit rejects a negative basisPoints entry', () => {
  const error = validateRoyaltySplit([
    { role: 'creator', basisPoints: 12000 },
    { role: 'platform', basisPoints: -2000 },
  ]);
  assert.match(error ?? '', /invalid basisPoints/);
});

test('create() persists a license whose split sums to 10000', async () => {
  await withTempStore(async (store) => {
    const repo = new FsLicenseRepository(store);
    const license = sampleLicense();
    const created = await repo.create(license);
    assert.equal(created.ok, true);

    const fetched = await repo.get(license.id);
    assert.equal(fetched.ok, true);
    if (!fetched.ok) return;
    assert.deepEqual(fetched.value, license);
  });
});

test('create() rejects a license whose split does not sum to 10000, and never writes it', async () => {
  await withTempStore(async (store) => {
    const repo = new FsLicenseRepository(store);
    const license = sampleLicense({ royaltySplit: [{ role: 'creator', basisPoints: 5000 }] });

    const created = await repo.create(license);
    assert.equal(created.ok, false);
    if (created.ok) return;
    assert.equal(created.error.code, 'XO_REGISTRY_ROYALTY_SPLIT_INVALID');

    const fetched = await repo.get(license.id);
    assert.equal(fetched.ok, false);
  });
});

test('create() rejects creating the same license id twice', async () => {
  await withTempStore(async (store) => {
    const repo = new FsLicenseRepository(store);
    const license = sampleLicense();

    const first = await repo.create(license);
    assert.equal(first.ok, true);

    const second = await repo.create(license);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.error.code, 'XO_REGISTRY_LICENSE_ALREADY_EXISTS');
  });
});

test('get() on an unknown license id returns NotFoundError', async () => {
  await withTempStore(async (store) => {
    const repo = new FsLicenseRepository(store);
    const result = await repo.get('does-not-exist');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'XO_NOT_FOUND');
  });
});
