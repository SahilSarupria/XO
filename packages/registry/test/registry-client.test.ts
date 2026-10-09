import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RegistryClient } from '../src/client/registry-client.js';
import { withTempStore, FixedClock } from './test-helpers.js';
import { buildFixtureBundle } from './manifest-fixtures.js';

test('publish() verifies a real bundle, then publish()+get() round-trip it', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });
    const bundle = buildFixtureBundle();

    const published = await client.publish(bundle);
    assert.equal(published.ok, true);
    if (!published.ok) return;
    assert.equal(published.value.id, bundle.manifest.merkleRoot);
    assert.equal(published.value.publishedAt, '2026-01-01T00:00:00.000Z');

    const fetched = await client.get(published.value.id);
    assert.equal(fetched.ok, true);
    if (!fetched.ok) return;
    assert.equal(fetched.value.manifest.name, bundle.manifest.name);
  });
});

test('publish() rejects a bundle with a tampered component (hash/Merkle mismatch), and never writes a record', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });
    const bundle = buildFixtureBundle();

    // Tamper with a component's bytes after the manifest (and its
    // merkleRoot/component hashes) were already computed against the
    // original bytes — this is exactly the "publishing an
    // unverified/tampered package" case the task brief calls out.
    const tamperedComponents = bundle.components.map((component) =>
      component.kind === 'safety_rules' ? { ...component, data: new TextEncoder().encode('{"rules":["tampered"]}') } : component,
    );
    const tamperedBundle = { ...bundle, components: tamperedComponents };

    const published = await client.publish(tamperedBundle);
    assert.equal(published.ok, false);
    if (published.ok) return;
    assert.equal(published.error.code, 'XO_REGISTRY_PACKAGE_UNVERIFIED');

    const fetched = await client.get(bundle.manifest.merkleRoot!);
    assert.equal(fetched.ok, false);
  });
});

test('publish() rejects duplicate publishes of the same bundle', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });
    const bundle = buildFixtureBundle();

    const first = await client.publish(bundle);
    assert.equal(first.ok, true);

    const second = await client.publish(bundle);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.error.code, 'XO_REGISTRY_PACKAGE_ALREADY_PUBLISHED');
  });
});

test('publish() appends a verifiable ledger entry keyed by the package id', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });
    const bundle = buildFixtureBundle();

    const published = await client.publish(bundle);
    assert.equal(published.ok, true);
    if (!published.ok) return;

    assert.equal(await client.verifyLedgerEntry(published.value.ledgerEntryHash), true);
  });
});

test('search() matches on package name, creator DID, and capability text — case-insensitively', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });
    const contractPkg = buildFixtureBundle({ name: 'xo_contract_analyzer', creatorDid: 'did:xo:acme-legal' });
    const fraudPkg = buildFixtureBundle({ name: 'xo_fraud_detector', creatorDid: 'did:xo:acme-legal' });
    const otherPkg = buildFixtureBundle({ name: 'xo_weather_forecaster', creatorDid: 'did:xo:someone-else' });

    for (const bundle of [contractPkg, fraudPkg, otherPkg]) {
      const result = await client.publish(bundle);
      assert.equal(result.ok, true);
    }

    const byName = await client.search('CONTRACT');
    assert.equal(byName.length, 1);
    assert.equal(byName[0]?.manifest.name, 'xo_contract_analyzer');

    const byCreator = await client.search('acme-legal');
    assert.equal(byCreator.length, 2);

    const noMatch = await client.search('nonexistent-term');
    assert.equal(noMatch.length, 0);
  });
});

test('search() with a blank query returns no results rather than the whole catalog', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });
    const bundle = buildFixtureBundle();
    await client.publish(bundle);

    assert.deepEqual(await client.search('   '), []);
  });
});

test('listByCreator() delegates to the package repository', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });
    const bundle = buildFixtureBundle({ creatorDid: 'did:xo:alice' });
    await client.publish(bundle);

    const records = await client.listByCreator('did:xo:alice');
    assert.equal(records.length, 1);
  });
});

test('recordBenchmark() generates an id, records the run, and appends a ledger entry', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });

    const recorded = await client.recordBenchmark({ packageId: 'sha256:' + 'a'.repeat(64), category: 'contract_analysis', score: 0.91 });
    assert.equal(recorded.ok, true);
    if (!recorded.ok) return;
    assert.ok(recorded.value.id.length > 0);
    assert.equal(recorded.value.challengeable, true);
    assert.equal(recorded.value.runAt, '2026-01-01T00:00:00.000Z');

    const fetched = await client.getBenchmark(recorded.value.id);
    assert.equal(fetched.ok, true);

    assert.equal(await client.verifyLedgerEntry(recorded.value.ledgerEntryHash), true);
  });
});

test('recordBenchmark() defaults challengeable to true when unspecified, and honors an explicit false', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });
    const defaultRun = await client.recordBenchmark({ packageId: 'sha256:' + 'a'.repeat(64), category: 'contract_analysis', score: 0.5 });
    assert.equal(defaultRun.ok, true);
    if (defaultRun.ok) assert.equal(defaultRun.value.challengeable, true);

    const explicitRun = await client.recordBenchmark({ packageId: 'sha256:' + 'a'.repeat(64), category: 'contract_analysis', score: 0.5, challengeable: false });
    assert.equal(explicitRun.ok, true);
    if (explicitRun.ok) assert.equal(explicitRun.value.challengeable, false);
  });
});

test('listBenchmarksForPackage() returns every run recorded for that package', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });
    const packageId = 'sha256:' + 'a'.repeat(64);
    await client.recordBenchmark({ packageId, category: 'contract_analysis', score: 0.7 });
    await client.recordBenchmark({ packageId, category: 'fraud_detection', score: 0.8 });

    const runs = await client.listBenchmarksForPackage(packageId);
    assert.equal(runs.length, 2);
  });
});

test('createLicense() generates an id, validates the royalty split, and appends a ledger entry', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });

    const created = await client.createLicense({
      packageId: 'sha256:' + 'a'.repeat(64),
      tier: 'standard',
      royaltySplit: [
        { role: 'creator', basisPoints: 8000 },
        { role: 'platform', basisPoints: 2000 },
      ],
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.ok(created.value.id.length > 0);

    const fetched = await client.getLicense(created.value.id);
    assert.equal(fetched.ok, true);

    assert.equal(await client.verifyLedgerEntry(created.value.ledgerEntryHash), true);
  });
});

test('createLicense() rejects a royalty split that does not sum to 10000', async () => {
  await withTempStore(async (store) => {
    const client = new RegistryClient(store, { clock: new FixedClock() });

    const created = await client.createLicense({
      packageId: 'sha256:' + 'a'.repeat(64),
      tier: 'standard',
      royaltySplit: [{ role: 'creator', basisPoints: 5000 }],
    });
    assert.equal(created.ok, false);
    if (created.ok) return;
    assert.equal(created.error.code, 'XO_REGISTRY_ROYALTY_SPLIT_INVALID');
  });
});
