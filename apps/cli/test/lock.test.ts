import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PackageInstaller, parseLockfile } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import { lockCommand } from '../src/commands/package/lock.js';
import { withTempDir, buildTestBundle } from './helpers.js';

test('lock writes an xo.lock for an already-installed package with no dependencies (zero to lock, but still succeeds)', async () => {
  await withTempDir('xo-lock-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const installer = new PackageInstaller(new LocalFsBlobStore(storeDir));
    const installed = await installer.install(buildTestBundle({ name: 'xo_lonely', version: '1.0.0' }));
    assert.ok(installed.ok);

    const result = await lockCommand({ nameAtVersion: 'xo_lonely@1.0.0', storeDir });
    assert.equal(result.exitCode, 0);
    assert.match(result.lines.join('\n'), /Wrote xo\.lock for "xo_lonely@1\.0\.0" \(0 dependencies\)/);

    const lockRaw = await readFile(join(storeDir, 'xo_lonely', '1.0.0', 'xo.lock'), 'utf8');
    const lockResult = parseLockfile(lockRaw);
    assert.ok(lockResult.ok);
    assert.deepEqual(lockResult.value.dependencies, []);
  });
});

test('lock re-resolves against the store\'s CURRENT contents, not what was resolved at install time', async () => {
  await withTempDir('xo-lock-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const store = new LocalFsBlobStore(storeDir);
    const installer = new PackageInstaller(store);

    const depV1 = await installer.install(buildTestBundle({ name: 'xo_dep', version: '1.0.0' }));
    assert.ok(depV1.ok);
    const root = await installer.install(
      buildTestBundle({ name: 'xo_root', version: '1.0.0', dependencies: [{ name: 'xo_dep', versionRange: '^1.0.0', kind: 'required' }] }),
    );
    assert.ok(root.ok);

    const firstLock = await lockCommand({ nameAtVersion: 'xo_root@1.0.0', storeDir });
    assert.equal(firstLock.exitCode, 0);
    const firstLockRaw = await readFile(join(storeDir, 'xo_root', '1.0.0', 'xo.lock'), 'utf8');
    const firstParsed = parseLockfile(firstLockRaw);
    assert.ok(firstParsed.ok);
    assert.deepEqual(
      firstParsed.value.dependencies.map((d) => `${d.name}@${d.version}`),
      ['xo_dep@1.0.0'],
    );

    // A newer, still-compatible version of the dependency shows up in the store...
    const depV2 = await installer.install(buildTestBundle({ name: 'xo_dep', version: '1.5.0' }));
    assert.ok(depV2.ok);

    // ...and re-running `xo lock` (no reinstall of xo_root at all) picks it up.
    const secondLock = await lockCommand({ nameAtVersion: 'xo_root@1.0.0', storeDir });
    assert.equal(secondLock.exitCode, 0);
    assert.match(secondLock.lines.join('\n'), /xo_dep@1\.5\.0/);
    const secondLockRaw = await readFile(join(storeDir, 'xo_root', '1.0.0', 'xo.lock'), 'utf8');
    const secondParsed = parseLockfile(secondLockRaw);
    assert.ok(secondParsed.ok);
    assert.deepEqual(
      secondParsed.value.dependencies.map((d) => `${d.name}@${d.version}`),
      ['xo_dep@1.5.0'],
    );
  });
});

test('lock fails cleanly with the real DependencyError code when the package still cannot resolve', async () => {
  await withTempDir('xo-lock-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const installer = new PackageInstaller(new LocalFsBlobStore(storeDir));
    const root = await installer.install(
      buildTestBundle({ name: 'xo_root', version: '1.0.0', dependencies: [{ name: 'xo_missing', versionRange: '^1.0.0', kind: 'required' }] }),
      { skipValidation: false },
    );
    assert.ok(root.ok);

    const result = await lockCommand({ nameAtVersion: 'xo_root@1.0.0', storeDir });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /\[XO_PACKAGE_DEPENDENCY_UNRESOLVED\]/);
  });
});

test('lock fails with a clear message (not a crash) for a package that is not installed', async () => {
  await withTempDir('xo-lock-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const result = await lockCommand({ nameAtVersion: 'xo_never_installed@1.0.0', storeDir });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /\[XO_PACKAGE_NOT_INSTALLED\]/);
  });
});

test('lock rejects a malformed "<name>@<version>" argument before touching the store', async () => {
  await withTempDir('xo-lock-test-', async (dir) => {
    const result = await lockCommand({ nameAtVersion: 'not-a-valid-spec', storeDir: join(dir, 'store') });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /expected "<name>@<version>"/);
  });
});
