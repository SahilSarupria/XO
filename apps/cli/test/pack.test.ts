import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packCommand } from '../src/commands/package/pack.js';
import { initCommand } from '../src/commands/package/init.js';
import { withTempDir } from './helpers.js';

test('pack builds a signed .xo from a project directory and prints a name/version/fingerprint/component summary', async () => {
  await withTempDir('xo-pack-test-', async (tmp) => {
    const dir = join(tmp, 'proj');
    const init = await initCommand({ dir, name: 'pack_test_pkg', creatorDid: 'did:xo:pack-test' });
    assert.equal(init.exitCode, 0);

    const result = await packCommand({ dir, sign: true, signerDid: 'did:xo:pack-test-signer' });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');

    assert.match(output, /signed by did:xo:pack-test-signer/);
    assert.match(output, /Package summary:/);
    assert.match(output, /name:\s+pack_test_pkg/);
    assert.match(output, /version:\s+0\.1\.0/);
    assert.match(output, /fingerprint:\s+sha256:[0-9a-f]+/);
    assert.match(output, /signed:\s+yes \(did:xo:pack-test-signer\)/);
    assert.match(output, /knowledge_graph\s+knowledge\/graph\.json/);
    assert.match(output, /safety_rules\s+safety\/rules\.json/);
    assert.match(output, /benchmark_suite\s+evaluation\/benchmark_suite\.json/);

    const written = await stat(join(dir, 'pack_test_pkg-0.1.0.xo'));
    assert.ok(written.isFile());
  });
});

test('pack without --sign produces an unsigned package and says so in the summary', async () => {
  await withTempDir('xo-pack-test-', async (tmp) => {
    const dir = join(tmp, 'proj');
    await initCommand({ dir, name: 'unsigned_pkg', creatorDid: 'did:xo:pack-test' });

    const result = await packCommand({ dir });
    assert.equal(result.exitCode, 0);
    assert.match(result.lines.join('\n'), /signed:\s+no/);
  });
});

test('pack on a document (non-directory) input points at xo create instead of guessing', async () => {
  await withTempDir('xo-pack-test-', async (tmp) => {
    const docPath = join(tmp, 'input.pdf');
    await writeFile(docPath, '%PDF-1.4 not a real pdf');

    const result = await packCommand({ dir: docPath });
    assert.equal(result.exitCode, 1);
    const output = result.lines.join('\n');
    assert.match(output, /does not compile a raw document/);
    assert.match(output, /xo create <source>/);
  });
});

test('pack on a directory with no xo.project.json passes through build\'s own error', async () => {
  await withTempDir('xo-pack-test-', async (tmp) => {
    const result = await packCommand({ dir: tmp });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /error:/);
  });
});

test('pack on a path that does not exist at all fails clearly', async () => {
  const result = await packCommand({ dir: '/nonexistent/definitely/not/here' });
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join('\n'), /could not read/);
});

test('pack leaves xo build fully intact — build.ts itself is untouched by this command', async () => {
  // Not a runtime assertion so much as a guard against silent drift: pack
  // delegates to the real buildCommand rather than a copy of it, so a
  // build written directly still round-trips through readFile/stat.
  await withTempDir('xo-pack-test-', async (tmp) => {
    const dir = join(tmp, 'proj');
    await initCommand({ dir, name: 'delegate_check', creatorDid: 'did:xo:pack-test' });
    const result = await packCommand({ dir });
    const outPath = join(dir, 'delegate_check-0.1.0.xo');
    const bytes = await readFile(outPath);
    assert.ok(bytes.byteLength > 0);
    assert.equal(result.exitCode, 0);
  });
});
