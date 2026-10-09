import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { searchCommand } from '../src/commands/registry/search.js';
import { publishCommand } from '../src/commands/registry/publish.js';
import { withTempDir, buildTestBundle } from './helpers.js';
import { packBundle } from '@xo/package-sdk';
import { writeFile } from 'node:fs/promises';

async function publishFixture(dir: string, registryDir: string, name: string): Promise<void> {
  const bundle = buildTestBundle({ name });
  const bytes = await packBundle(bundle);
  const archivePath = join(dir, `${name}.xo`);
  await writeFile(archivePath, bytes);
  const result = await publishCommand({ archivePath, registryDir });
  assert.equal(result.exitCode, 0, `fixture publish for "${name}" should succeed: ${result.lines.join('\n')}`);
}

test('search finds a published package by name', async () => {
  await withTempDir('xo-search-test-', async (dir) => {
    const registryDir = join(dir, 'registry');
    await publishFixture(dir, registryDir, 'xo_contract_helper');

    const result = await searchCommand({ query: 'contract', registryDir });
    assert.equal(result.exitCode, 0);
    assert.match(result.lines.join('\n'), /xo_contract_helper@1\.0\.0/);
  });
});

test('search on a query with no matches reports zero results, not an error', async () => {
  await withTempDir('xo-search-test-', async (dir) => {
    const registryDir = join(dir, 'registry');
    await publishFixture(dir, registryDir, 'xo_contract_helper');

    const result = await searchCommand({ query: 'nonexistent-xyz', registryDir });
    assert.equal(result.exitCode, 0);
    assert.match(result.lines.join('\n'), /No packages/);
  });
});

test('search rejects a blank query', async () => {
  await withTempDir('xo-search-test-', async (dir) => {
    const result = await searchCommand({ query: '   ', registryDir: join(dir, 'registry') });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /must not be blank/);
  });
});
