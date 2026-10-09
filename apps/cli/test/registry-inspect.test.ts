import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { packBundle } from '@xo/package-sdk';
import { publishCommand } from '../src/commands/registry/publish.js';
import { registryInspectCommand } from '../src/commands/registry/inspect.js';
import { withTempDir, buildTestBundle } from './helpers.js';

test('registry inspect prints a published package and notes it has no benchmark runs yet', async () => {
  await withTempDir('xo-registry-inspect-test-', async (dir) => {
    const bundle = buildTestBundle();
    const bytes = await packBundle(bundle);
    const archivePath = join(dir, 'pkg.xo');
    await writeFile(archivePath, bytes);
    const registryDir = join(dir, 'registry');

    const published = await publishCommand({ archivePath, registryDir });
    assert.equal(published.exitCode, 0);
    const id = published.lines.join('\n').match(/id:\s+(sha256:[0-9a-f]{64})/)?.[1];
    assert.ok(id, 'publish output should include the package id');

    const result = await registryInspectCommand({ id: id!, registryDir });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');
    assert.match(output, /xo_cli_test_pkg@1\.0\.0/);
    assert.match(output, /No benchmark runs recorded/);
    assert.match(output, /Capabilities:/);
    assert.match(output, /echo: Echo/);
  });
});

test('registry inspect on an unpublished id fails clearly', async () => {
  await withTempDir('xo-registry-inspect-test-', async (dir) => {
    const result = await registryInspectCommand({ id: 'sha256:' + '0'.repeat(64), registryDir: join(dir, 'registry') });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /XO_NOT_FOUND/);
  });
});
