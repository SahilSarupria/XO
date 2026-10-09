import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileCommand } from '../src/commands/compiler/compile.js';
import { withTempDir } from './helpers.js';

const OBLIGATION_TEXT =
  '# Vendor Agreement\n\n' +
  'Acme Corp shall send a confirmation email to the Client upon completion of each milestone.\n\n' +
  'The team shall generate a summary report weekly and deliver it to the Client.\n';

test('compile summarizes a plain-text source: node/edge counts, validation, graph hash', async () => {
  await withTempDir('xo-compile-test-', async (tmp) => {
    const path = join(tmp, 'agreement.txt');
    await writeFile(path, OBLIGATION_TEXT, 'utf8');

    const result = await compileCommand({ sources: [path] });
    assert.equal(result.exitCode, 0);
    const output = result.lines.join('\n');

    assert.match(output, /Sources:/);
    assert.match(output, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(output, /Compilation:/);
    assert.match(output, /nodes:\s+\d+/);
    assert.match(output, /edges:\s+\d+/);
    assert.match(output, /Validation: valid/);
    assert.match(output, /Graph content hash: sha256:[0-9a-f]+/);
  });
});

test('compile --json emits parseable JSON with sources/stats/graphContentHash', async () => {
  await withTempDir('xo-compile-test-', async (tmp) => {
    const path = join(tmp, 'agreement.txt');
    await writeFile(path, OBLIGATION_TEXT, 'utf8');

    const result = await compileCommand({ sources: [path], json: true });
    assert.equal(result.exitCode, 0);
    assert.equal(result.lines.length, 1);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.sources.length, 1);
    assert.equal(parsed.sources[0].sourcePath, path);
    assert.ok(parsed.stats.nodeCount > 0);
    assert.match(parsed.graphContentHash, /^sha256:[0-9a-f]+$/);
  });
});

test('compile with no sources fails with a usage-level error, not a crash', async () => {
  const result = await compileCommand({ sources: [] });
  assert.equal(result.exitCode, 1);
});

test('compile on a nonexistent file fails with a read error, not a crash', async () => {
  const result = await compileCommand({ sources: ['/nonexistent/path/does-not-exist.txt'] });
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join('\n'), /could not read source/);
});

test('compile accepts multiple sources in one call', async () => {
  await withTempDir('xo-compile-test-', async (tmp) => {
    const a = join(tmp, 'a.txt');
    const b = join(tmp, 'b.txt');
    await writeFile(a, 'The reviewer shall approve the draft before publication.', 'utf8');
    await writeFile(b, 'Acme Corp shall send an invoice to the Client within ten days.', 'utf8');

    const result = await compileCommand({ sources: [a, b], json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.sources.length, 2);
  });
});

test('compile on a directory discovers and compiles every supported file within it', async () => {
  await withTempDir('xo-compile-test-', async (tmp) => {
    const dir = join(tmp, 'docs');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'policy.txt'), 'The insurer shall pay the claim within 30 days.', 'utf8');
    await writeFile(join(dir, 'sub', 'claims.txt'), 'The insured shall notify the insurer within 48 hours.', 'utf8');
    await writeFile(join(dir, 'ignored.bin'), Buffer.from([0x00, 0x01, 0x02]));

    const result = await compileCommand({ sources: [dir], json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.sources.length, 2);
    assert.deepEqual(parsed.discoveredSources.sort(), ['policy.txt', 'sub/claims.txt']);
    assert.equal(parsed.unsupportedFiles.length, 1);
    assert.equal(parsed.unsupportedFiles[0].relativePath, 'ignored.bin');
  });
});

test('compile on a directory prints an "Ignored N unsupported file(s)" section in text output', async () => {
  await withTempDir('xo-compile-test-', async (tmp) => {
    const dir = join(tmp, 'docs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'policy.txt'), 'The insurer shall pay the claim.', 'utf8');
    await writeFile(join(dir, 'notes.exe'), Buffer.from([0x4d, 0x5a]));

    const result = await compileCommand({ sources: [dir] });
    assert.equal(result.exitCode, 0);
    assert.match(result.lines.join('\n'), /Ignored 1 unsupported file\(s\)/);
    assert.match(result.lines.join('\n'), /notes\.exe/);
  });
});

test('compile on an empty directory fails clearly rather than silently compiling nothing', async () => {
  await withTempDir('xo-compile-test-', async (tmp) => {
    const dir = join(tmp, 'empty');
    await mkdir(dir, { recursive: true });
    const result = await compileCommand({ sources: [dir] });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join('\n'), /no supported source files were found/);
  });
});

test('compile on a .zip archive extracts, compiles, and cleans up the temp dir', async (t) => {
  // adm-zip is a real, ordinary dependency (see source-collection.ts's
  // own doc comment on why it's loaded lazily there) — this test skips
  // itself, honestly, rather than failing the whole file to load, in an
  // environment where it genuinely isn't installed.
  let AdmZip: new () => { addFile(name: string, data: Buffer): void; toBuffer(): Buffer };
  try {
    AdmZip = (await import('adm-zip')).default;
  } catch {
    t.skip('adm-zip is not installed in this environment');
    return;
  }
  await withTempDir('xo-compile-test-', async (tmp) => {
    const zip = new AdmZip();
    zip.addFile('policy.txt', Buffer.from('The insurer shall pay the claim within 30 days.'));
    zip.addFile('claims/procedure.txt', Buffer.from('The insured shall notify the insurer within 48 hours.'));
    const zipPath = join(tmp, 'docs.zip');
    await writeFile(zipPath, zip.toBuffer());

    const result = await compileCommand({ sources: [zipPath], json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.sources.length, 2);
    assert.deepEqual(parsed.discoveredSources.sort(), ['claims/procedure.txt', 'policy.txt']);
  });
});

test('compile on a directory + explicit file combined discovers sources from both', async () => {
  await withTempDir('xo-compile-test-', async (tmp) => {
    const explicit = join(tmp, 'explicit.txt');
    await writeFile(explicit, 'The vendor shall deliver goods within 10 days.', 'utf8');
    const dir = join(tmp, 'bundle');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'inner.txt'), 'The buyer shall pay within 30 days.', 'utf8');

    const result = await compileCommand({ sources: [explicit, dir], json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.sources.length, 2);
  });
});
