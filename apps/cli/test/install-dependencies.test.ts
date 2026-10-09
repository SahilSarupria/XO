import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { packBundle, PackageInstaller, parseLockfile } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import { installCommand } from '../src/commands/package/install.js';
import { withTempDir, buildTestBundle } from './helpers.js';

async function writeArchive(dir: string, bundle: ReturnType<typeof buildTestBundle>, filename: string): Promise<string> {
  const bytes = await packBundle(bundle);
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return path;
}

async function lockFileExists(storeDir: string, name: string, version: string): Promise<boolean> {
  try {
    await stat(join(storeDir, name, version, 'xo.lock'));
    return true;
  } catch {
    return false;
  }
}

test('install with no dependencies field behaves exactly as before: no resolution, no xo.lock written', async () => {
  await withTempDir('xo-install-deps-test-', async (dir) => {
    const archivePath = await writeArchive(dir, buildTestBundle(), 'pkg.xo');
    const storeDir = join(dir, 'store');

    const result = await installCommand({ archivePath, storeDir });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /Installed "xo_cli_test_pkg@1\.0\.0"/);
    assert.doesNotMatch(output, /Resolved and locked/);
    assert.equal(await lockFileExists(storeDir, 'xo_cli_test_pkg', '1.0.0'), false);
  });
});

test('install with an empty dependencies array behaves exactly as before too', async () => {
  await withTempDir('xo-install-deps-test-', async (dir) => {
    const archivePath = await writeArchive(dir, buildTestBundle({ dependencies: [] }), 'pkg.xo');
    const storeDir = join(dir, 'store');

    const result = await installCommand({ archivePath, storeDir });
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.lines.join('\n'), /Resolved and locked/);
    assert.equal(await lockFileExists(storeDir, 'xo_cli_test_pkg', '1.0.0'), false);
  });
});

test('install resolves and locks a real dependency chain already present in the store', async () => {
  await withTempDir('xo-install-deps-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const store = new LocalFsBlobStore(storeDir);
    const installer = new PackageInstaller(store);

    // Install the dependency first, on its own (it has no dependencies of its own).
    const coreMath = buildTestBundle({ name: 'xo_core_math', version: '1.4.0' });
    const coreInstall = await installer.install(coreMath);
    assert.ok(coreInstall.ok);

    // Now install a root package that depends on it.
    const rootBundle = buildTestBundle({
      name: 'xo_finance',
      version: '1.0.0',
      dependencies: [{ name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' }],
    });
    const archivePath = await writeArchive(dir, rootBundle, 'finance.xo');

    const result = await installCommand({ archivePath, storeDir });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /Installed "xo_finance@1\.0\.0"/);
    assert.match(output, /Resolved and locked 1 dependency:/);
    assert.match(output, /xo_core_math@1\.4\.0/);
    assert.match(output, /Lockfile written to/);

    assert.equal(await lockFileExists(storeDir, 'xo_finance', '1.0.0'), true);
    const lockRaw = await readFile(join(storeDir, 'xo_finance', '1.0.0', 'xo.lock'), 'utf8');
    const lockResult = parseLockfile(lockRaw);
    assert.ok(lockResult.ok);
    assert.equal(lockResult.value.rootName, 'xo_finance');
    assert.equal(lockResult.value.rootVersion, '1.0.0');
    assert.deepEqual(
      lockResult.value.dependencies.map((d) => `${d.name}@${d.version}`),
      ['xo_core_math@1.4.0'],
    );
  });
});

test('install fails cleanly, without installing the root package, when a required dependency is not in the store', async () => {
  await withTempDir('xo-install-deps-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const rootBundle = buildTestBundle({
      name: 'xo_finance',
      version: '1.0.0',
      dependencies: [{ name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' }],
    });
    const archivePath = await writeArchive(dir, rootBundle, 'finance.xo');

    const result = await installCommand({ archivePath, storeDir });
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /\[XO_PACKAGE_DEPENDENCY_UNRESOLVED\]/);
    assert.match(output, /xo_core_math/);
    assert.match(output, /nothing was installed/);

    // The root package must genuinely not be installed — check via a
    // fresh installer/store, not just by trusting the message.
    const installer = new PackageInstaller(new LocalFsBlobStore(storeDir));
    const manifestResult = await installer.getManifest('xo_finance', '1.0.0');
    assert.equal(manifestResult.ok, false);
    assert.equal(await lockFileExists(storeDir, 'xo_finance', '1.0.0'), false);
  });
});

test('install fails cleanly on a genuine unsatisfiable version conflict between two dependencies, without installing the root package', async () => {
  await withTempDir('xo-install-deps-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const store = new LocalFsBlobStore(storeDir);
    const installer = new PackageInstaller(store);

    const shared1 = await installer.install(buildTestBundle({ name: 'xo_shared', version: '1.0.0' }));
    assert.ok(shared1.ok);
    const shared2 = await installer.install(buildTestBundle({ name: 'xo_shared', version: '2.0.0' }));
    assert.ok(shared2.ok);
    const left = await installer.install(
      buildTestBundle({ name: 'xo_left', version: '1.0.0', dependencies: [{ name: 'xo_shared', versionRange: '^1.0.0', kind: 'required' }] }),
    );
    assert.ok(left.ok);
    const right = await installer.install(
      buildTestBundle({ name: 'xo_right', version: '1.0.0', dependencies: [{ name: 'xo_shared', versionRange: '^2.0.0', kind: 'required' }] }),
    );
    assert.ok(right.ok);

    const rootBundle = buildTestBundle({
      name: 'xo_root',
      version: '1.0.0',
      dependencies: [
        { name: 'xo_left', versionRange: '^1.0.0', kind: 'required' },
        { name: 'xo_right', versionRange: '^1.0.0', kind: 'required' },
      ],
    });
    const archivePath = await writeArchive(dir, rootBundle, 'root.xo');

    const result = await installCommand({ archivePath, storeDir });
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /\[XO_PACKAGE_DEPENDENCY_CONFLICT\]/);
    assert.match(output, /xo_left/);
    assert.match(output, /xo_right/);

    const freshInstaller = new PackageInstaller(new LocalFsBlobStore(storeDir));
    const manifestResult = await freshInstaller.getManifest('xo_root', '1.0.0');
    assert.equal(manifestResult.ok, false);
  });
});

test('--skip-resolution installs the archive with no resolution at all, even when a required dependency is missing from the store', async () => {
  await withTempDir('xo-install-deps-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const rootBundle = buildTestBundle({
      name: 'xo_finance',
      version: '1.0.0',
      dependencies: [{ name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' }],
    });
    const archivePath = await writeArchive(dir, rootBundle, 'finance.xo');

    const result = await installCommand({ archivePath, storeDir, skipResolution: true });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /Installed "xo_finance@1\.0\.0"/);
    assert.match(output, /--skip-resolution/);
    assert.doesNotMatch(output, /Resolved and locked/);
    assert.equal(await lockFileExists(storeDir, 'xo_finance', '1.0.0'), false);

    const installer = new PackageInstaller(new LocalFsBlobStore(storeDir));
    const manifestResult = await installer.getManifest('xo_finance', '1.0.0');
    assert.ok(manifestResult.ok);
  });
});

test('install resolves an optional dependency gracefully when it is missing, without failing the command', async () => {
  await withTempDir('xo-install-deps-test-', async (dir) => {
    const storeDir = join(dir, 'store');
    const rootBundle = buildTestBundle({
      name: 'xo_root',
      version: '1.0.0',
      dependencies: [{ name: 'xo_nice_to_have', versionRange: '^1.0.0', kind: 'optional' }],
    });
    const archivePath = await writeArchive(dir, rootBundle, 'root.xo');

    const result = await installCommand({ archivePath, storeDir });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /Installed "xo_root@1\.0\.0"/);
    assert.match(output, /Resolved and locked 0 dependencies:/);
    assert.match(output, /Skipped 1 unresolvable optional dependency:/);
    assert.match(output, /xo_nice_to_have/);
    assert.equal(await lockFileExists(storeDir, 'xo_root', '1.0.0'), true);
  });
});
