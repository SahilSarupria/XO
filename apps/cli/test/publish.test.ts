import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packBundle } from '@xo/package-sdk';
import { publishCommand } from '../src/commands/registry/publish.js';
import { withTempDir, buildTestBundle } from './helpers.js';

async function writeArchive(dir: string, filename = 'pkg.xo'): Promise<string> {
  const bundle = buildTestBundle();
  const bytes = await packBundle(bundle);
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return path;
}

test('publish verifies and publishes a well-formed package, printing its id and ledger entry', async () => {
  await withTempDir('xo-publish-test-', async (dir) => {
    const archivePath = await writeArchive(dir);
    const registryDir = join(dir, 'registry');

    const result = await publishCommand({ archivePath, registryDir });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /Published "xo_cli_test_pkg@1\.0\.0"/);
    assert.match(output, /id:\s+sha256:[0-9a-f]{64}/);
    assert.match(output, /ledgerEntry:\s+sha256:[0-9a-f]{64}/);
  });
});

test('publish rejects a duplicate publish of the same archive', async () => {
  await withTempDir('xo-publish-test-', async (dir) => {
    const archivePath = await writeArchive(dir);
    const registryDir = join(dir, 'registry');

    const first = await publishCommand({ archivePath, registryDir });
    assert.equal(first.exitCode, 0);

    const second = await publishCommand({ archivePath, registryDir });
    assert.equal(second.exitCode, 1);
    assert.match(second.lines.join('\n'), /XO_REGISTRY_PACKAGE_ALREADY_PUBLISHED/);
  });
});

test('publish on a nonexistent archive fails with a read error, not a crash', async () => {
  await withTempDir('xo-publish-test-', async (dir) => {
    const result = await publishCommand({ archivePath: '/nonexistent/pkg.xo', registryDir: join(dir, 'registry') });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /could not read/);
  });
});

test('publish on a truncated/corrupt archive fails clearly', async () => {
  await withTempDir('xo-publish-test-', async (dir) => {
    const archivePath = await writeArchive(dir);
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(archivePath);
    await writeFile(archivePath, bytes.subarray(0, Math.floor(bytes.byteLength / 2)));

    const result = await publishCommand({ archivePath, registryDir: join(dir, 'registry') });
    assert.equal(result.exitCode, 1);
  });
});
