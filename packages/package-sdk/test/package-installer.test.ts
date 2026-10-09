import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageInstaller } from '../src/install/package-installer.js';
import type { Clock } from '../src/install/clock.js';
import { buildSampleBundle } from './fixtures.js';

class FixedClock implements Clock {
  now(): Date {
    return new Date('2026-01-01T00:00:00.000Z');
  }
}

async function withTempStore<T>(fn: (store: LocalFsBlobStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-package-sdk-'));
  try {
    return await fn(new LocalFsBlobStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('install() writes every component and creates an installed-package record', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store, { clock: new FixedClock() });
    const bundle = buildSampleBundle();
    const result = await installer.install(bundle);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.name, bundle.manifest.name);
    assert.equal(result.value.installedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(result.value.componentPaths.length, bundle.components.length);

    const installed = await installer.listInstalled();
    assert.equal(installed.length, 1);
    assert.equal(installed[0]?.version, '1.0.0');
  });
});

test('install() refuses to reinstall the same version without force', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle();
    await installer.install(bundle);
    const second = await installer.install(bundle);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, 'XO_PACKAGE_ALREADY_INSTALLED');
  });
});

test('install() rejects a bundle that fails validation (tampered component)', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle();
    const tampered = { ...bundle, components: bundle.components.map((c) => (c.kind === 'safety_rules' ? { ...c, data: new TextEncoder().encode('tampered') } : c)) };
    const result = await installer.install(tampered);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_VALIDATION_FAILED');
  });
});

test('uninstall() removes all files and the active-version pointer', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle();
    await installer.install(bundle);
    const result = await installer.uninstall(bundle.manifest.name, bundle.manifest.version);
    assert.equal(result.ok, true);
    assert.equal((await installer.listInstalled()).length, 0);

    const again = await installer.uninstall(bundle.manifest.name, bundle.manifest.version);
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.error.code, 'XO_PACKAGE_NOT_INSTALLED');
  });
});

test('upgrade() accepts a valid version bump and becomes the new active version', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const v1 = buildSampleBundle({ version: '1.0.0' });
    const v2 = buildSampleBundle({ version: '1.1.0' });
    await installer.install(v1);
    const result = await installer.upgrade(v2);
    assert.equal(result.ok, true);

    const installed = await installer.listInstalled();
    assert.equal(installed[0]?.version, '1.1.0');
  });
});

test('upgrade() rejects a downgrade and a same-version "upgrade"', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const v2 = buildSampleBundle({ version: '2.0.0' });
    await installer.install(v2);

    const downgrade = await installer.upgrade(buildSampleBundle({ version: '1.0.0' }));
    assert.equal(downgrade.ok, false);
    if (!downgrade.ok) assert.equal(downgrade.error.code, 'XO_PACKAGE_UPGRADE_INVALID');

    const same = await installer.upgrade(buildSampleBundle({ version: '2.0.0' }));
    assert.equal(same.ok, false);
  });
});

test('rollback() re-points the active version to a previously installed (but no longer active) version', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const v1 = buildSampleBundle({ version: '1.0.0' });
    const v2 = buildSampleBundle({ version: '1.1.0' });
    await installer.install(v1);
    await installer.upgrade(v2);
    assert.equal((await installer.listInstalled())[0]?.version, '1.1.0');

    const rollback = await installer.rollback(v1.manifest.name, '1.0.0');
    assert.equal(rollback.ok, true);
    assert.equal((await installer.listInstalled())[0]?.version, '1.0.0');
  });
});

test('rollback() fails for a version whose files were removed via uninstall', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const v1 = buildSampleBundle({ version: '1.0.0' });
    await installer.install(v1);
    await installer.uninstall(v1.manifest.name, '1.0.0');
    const result = await installer.rollback(v1.manifest.name, '1.0.0');
    assert.equal(result.ok, false);
  });
});

test('verifyInstallation detects on-disk corruption after a successful install', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle();
    await installer.install(bundle);

    const before = await installer.verifyInstallation(bundle.manifest.name, bundle.manifest.version);
    assert.ok(before.ok && before.value.valid);

    // Corrupt an installed file directly on disk, bypassing the installer.
    const knowledgeGraphEntry = bundle.manifest.components.knowledge_graph!;
    await store.put(`${bundle.manifest.name}/${bundle.manifest.version}/${knowledgeGraphEntry.path}`, 'corrupted-on-disk');

    const after = await installer.verifyInstallation(bundle.manifest.name, bundle.manifest.version);
    assert.ok(after.ok);
    if (after.ok) {
      assert.equal(after.value.valid, false);
      assert.ok(after.value.issues.some((i) => i.code === 'HASH_MISMATCH'));
    }
  });
});

test('verifyInstallation reports PACKAGE_NOT_INSTALLED for a package that was never installed', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const result = await installer.verifyInstallation('xo_never_installed', '1.0.0');
    assert.equal(result.ok, false);
  });
});

test('listAllInstalledRecords returns every installed version, unlike listInstalled which returns only the active one', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const v1 = buildSampleBundle({ version: '1.0.0' });
    const v2 = buildSampleBundle({ version: '1.1.0' });
    await installer.install(v1);
    await installer.upgrade(v2);

    assert.equal((await installer.listInstalled()).length, 1);
    const all = await installer.listAllInstalledRecords();
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((r) => r.version).sort(),
      ['1.0.0', '1.1.0'],
    );
  });
});

test('getManifest reads a specific installed version, including a non-active one', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const v1 = buildSampleBundle({ version: '1.0.0' });
    const v2 = buildSampleBundle({ version: '1.1.0' });
    await installer.install(v1);
    await installer.upgrade(v2);

    const manifestV1 = await installer.getManifest(v1.manifest.name, '1.0.0');
    assert.ok(manifestV1.ok);
    if (manifestV1.ok) assert.equal(manifestV1.value.version, '1.0.0');

    const manifestV2 = await installer.getManifest(v2.manifest.name, '1.1.0');
    assert.ok(manifestV2.ok);
    if (manifestV2.ok) assert.equal(manifestV2.value.version, '1.1.0');
  });
});

test('getManifest reports PACKAGE_NOT_INSTALLED for a version that was never installed', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const result = await installer.getManifest('xo_never_installed', '1.0.0');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_NOT_INSTALLED');
  });
});

test('getComponent reads a specific component\'s raw bytes for an installed version', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle();
    await installer.install(bundle);

    const result = await installer.getComponent(bundle.manifest.name, bundle.manifest.version, 'knowledge_graph');
    assert.ok(result.ok);
    if (result.ok) assert.deepEqual(new TextDecoder().decode(result.value), '{"nodes":[]}');
  });
});

test('getComponent reports PACKAGE_COMPONENT_MISSING for a component kind the manifest never declared', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle();
    await installer.install(bundle);

    const result = await installer.getComponent(bundle.manifest.name, bundle.manifest.version, 'lora');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_COMPONENT_MISSING');
  });
});

test('getComponent reports PACKAGE_NOT_INSTALLED for a version that was never installed', async () => {
  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const result = await installer.getComponent('xo_never_installed', '1.0.0', 'knowledge_graph');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_NOT_INSTALLED');
  });
});


test('repairInstallation reinstalls from a known-good bundle over a corrupted install', async () => {

  await withTempStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle();
    await installer.install(bundle);

    const knowledgeGraphEntry = bundle.manifest.components.knowledge_graph!;
    await store.put(`${bundle.manifest.name}/${bundle.manifest.version}/${knowledgeGraphEntry.path}`, 'corrupted-on-disk');
    assert.equal((await installer.verifyInstallation(bundle.manifest.name, bundle.manifest.version)).ok && true, true);

    const repaired = await installer.repairInstallation(bundle);
    assert.equal(repaired.ok, true);
    const verified = await installer.verifyInstallation(bundle.manifest.name, bundle.manifest.version);
    assert.ok(verified.ok && verified.value.valid);
  });
});
