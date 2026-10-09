import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packBundle } from '@xo/package-sdk';
import { installCommand } from '../src/commands/package/install.js';
import { withTempDir, buildTestBundle } from './helpers.js';

async function writeArchive(dir: string, filename = 'pkg.xo'): Promise<string> {
  const bytes = await packBundle(buildTestBundle());
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return path;
}

test('install writes a package into the store and reports its manifestHash', async () => {
  await withTempDir('xo-install-test-', async (dir) => {
    const archivePath = await writeArchive(dir);
    const storeDir = join(dir, 'store');

    const result = await installCommand({ archivePath, storeDir });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /Installed "xo_cli_test_pkg@1\.0\.0"/);
    assert.match(output, /manifestHash:\s+sha256:[0-9a-f]+/);
    assert.match(output, /3 component file\(s\) written/);
  });
});

test('installing the same package twice without --force fails with the real InstallError code', async () => {
  await withTempDir('xo-install-test-', async (dir) => {
    const archivePath = await writeArchive(dir);
    const storeDir = join(dir, 'store');

    const first = await installCommand({ archivePath, storeDir });
    assert.equal(first.exitCode, 0);

    const second = await installCommand({ archivePath, storeDir });
    assert.equal(second.exitCode, 1);
    assert.match(second.lines.join('\n'), /\[XO_PACKAGE_ALREADY_INSTALLED\]/);
    assert.match(second.lines.join('\n'), /already installed/);
  });
});

test('--force allows reinstalling over an existing install', async () => {
  await withTempDir('xo-install-test-', async (dir) => {
    const archivePath = await writeArchive(dir);
    const storeDir = join(dir, 'store');

    await installCommand({ archivePath, storeDir });
    const forced = await installCommand({ archivePath, storeDir, force: true });
    assert.equal(forced.exitCode, 0);
    assert.match(forced.lines.join('\n'), /Installed "xo_cli_test_pkg@1\.0\.0"/);
  });
});

test('install on a nonexistent archive fails with a read error, not a stack trace', async () => {
  await withTempDir('xo-install-test-', async (dir) => {
    const result = await installCommand({ archivePath: '/nonexistent/pkg.xo', storeDir: join(dir, 'store') });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /could not read/);
  });
});

test('install on a corrupt archive surfaces the PackageError code from unpackArchive', async () => {
  await withTempDir('xo-install-test-', async (dir) => {
    const archivePath = join(dir, 'corrupt.xo');
    await writeFile(archivePath, Buffer.from('not a real archive'));
    const result = await installCommand({ archivePath, storeDir: join(dir, 'store') });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /\[[A-Z_]+\]/);
  });
});
