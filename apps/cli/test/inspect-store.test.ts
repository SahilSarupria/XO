import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PackageInstaller, createLockfile, serializeLockfile, resolveDependencies } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import { inspectInstalledCommand } from '../src/commands/package/inspect.js';
import { lockCommand } from '../src/commands/package/lock.js';
import { withTempDir, buildTestBundle } from './helpers.js';

test('inspect --store reports n/a for a package with no declared dependencies', async () => {
  await withTempDir('xo-inspect-store-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const installer = new PackageInstaller(new LocalFsBlobStore(storeDir));
    const installed = await installer.install(buildTestBundle({ name: 'xo_lonely', version: '1.0.0' }));
    assert.ok(installed.ok);

    const result = await inspectInstalledCommand({ nameAtVersion: 'xo_lonely@1.0.0', storeDir });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /Dependencies:\s+0/);
    assert.match(output, /Lockfile:\s+n\/a \(no declared dependencies\)/);
  });
});

test('inspect --store reports no lockfile found for a dependent package that has never been locked', async () => {
  await withTempDir('xo-inspect-store-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const installer = new PackageInstaller(new LocalFsBlobStore(storeDir));
    await installer.install(buildTestBundle({ name: 'xo_dep', version: '1.0.0' }));
    await installer.install(
      buildTestBundle({ name: 'xo_root', version: '1.0.0', dependencies: [{ name: 'xo_dep', versionRange: '^1.0.0', kind: 'required' }] }),
    );

    const result = await inspectInstalledCommand({ nameAtVersion: 'xo_root@1.0.0', storeDir });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /Dependencies:\s+1/);
    assert.match(output, /xo_dep \^1\.0\.0 \(required\)/);
    assert.match(output, /Lockfile:\s+none found/);
    assert.match(output, /xo lock xo_root@1\.0\.0/);
  });
});

test('inspect --store reports fresh immediately after xo lock', async () => {
  await withTempDir('xo-inspect-store-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const installer = new PackageInstaller(new LocalFsBlobStore(storeDir));
    await installer.install(buildTestBundle({ name: 'xo_dep', version: '1.0.0' }));
    await installer.install(
      buildTestBundle({ name: 'xo_root', version: '1.0.0', dependencies: [{ name: 'xo_dep', versionRange: '^1.0.0', kind: 'required' }] }),
    );

    const lockResult = await lockCommand({ nameAtVersion: 'xo_root@1.0.0', storeDir });
    assert.equal(lockResult.exitCode, 0);

    const result = await inspectInstalledCommand({ nameAtVersion: 'xo_root@1.0.0', storeDir });
    assert.equal(result.exitCode, 0);
    assert.match(result.lines.join('\n'), /Lockfile:\s+fresh/);
  });
});

test('inspect --store reports STALE when the lock no longer matches the currently-installed dependency', async () => {
  await withTempDir('xo-inspect-store-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const store = new LocalFsBlobStore(storeDir);
    const installer = new PackageInstaller(store);

    const depV1Manifest = buildTestBundle({ name: 'xo_dep', version: '1.0.0' }).manifest;
    await installer.install(buildTestBundle({ name: 'xo_dep', version: '1.0.0' }));
    const rootBundle = buildTestBundle({
      name: 'xo_root',
      version: '1.0.0',
      dependencies: [{ name: 'xo_dep', versionRange: '^1.0.0', kind: 'required' }],
    });
    await installer.install(rootBundle);

    // Lock it while the dependency is still at a range-satisfying version.
    const resolution = await resolveDependencies(rootBundle.manifest, async () => [depV1Manifest]);
    assert.ok(resolution.ok);
    const lockfile = createLockfile(resolution.value);
    await store.put('xo_root/1.0.0/xo.lock', serializeLockfile(lockfile), { contentType: 'application/json' });

    // Now reinstall xo_root with a bumped required range the locked version no longer satisfies.
    const bumpedRootBundle = buildTestBundle({
      name: 'xo_root',
      version: '1.0.0',
      dependencies: [{ name: 'xo_dep', versionRange: '^2.0.0', kind: 'required' }],
    });
    const reinstall = await installer.install(bumpedRootBundle, { force: true });
    assert.ok(reinstall.ok);

    const result = await inspectInstalledCommand({ nameAtVersion: 'xo_root@1.0.0', storeDir });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /Lockfile:\s+STALE/);
    assert.match(output, /xo lock xo_root@1\.0\.0/);
  });
});

test('inspect --store fails with a clear message for a package that is not installed', async () => {
  await withTempDir('xo-inspect-store-test-', async (dir) => {
    const result = await inspectInstalledCommand({ nameAtVersion: 'xo_never_installed@1.0.0', storeDir: join(dir, 'store') });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /\[XO_PACKAGE_NOT_INSTALLED\]/);
  });
});
