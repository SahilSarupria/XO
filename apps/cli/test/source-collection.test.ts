import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { collectSources, resolveSourceArg } from '../src/commands/compiler/source-collection.js';
import { withTempDir } from './helpers.js';

/**
 * `adm-zip`'s own `addFile` sanitizes traversal segments and leading
 * slashes out of an entry name at *write* time (verified empirically:
 * `addFile('../../evil.txt', ...)` round-trips as `"evil.txt"`), so it
 * cannot be used to construct a genuinely malicious test fixture — the
 * library's own defense would make the zip-slip test pass for the wrong
 * reason (never exercising `extractZipToTempDir`'s own check at all).
 * This hand-rolls the minimal ZIP format (single STORED, uncompressed
 * entry) so the malicious entry name reaches `AdmZip`'s *reader*
 * unmodified, which is what `extractZipToTempDir` actually reads from.
 */
function buildRawZipWithMaliciousEntry(entryName: string, content: string): Buffer {
  const nameBytes = Buffer.from(entryName, 'utf8');
  const dataBytes = Buffer.from(content, 'utf8');
  const crc = crc32(dataBytes) >>> 0;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(0, 8); // method: stored
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(dataBytes.length, 18);
  localHeader.writeUInt32LE(dataBytes.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const localEntry = Buffer.concat([localHeader, nameBytes, dataBytes]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0, 8); // flags
  centralHeader.writeUInt16LE(0, 10); // method
  centralHeader.writeUInt16LE(0, 12); // mod time
  centralHeader.writeUInt16LE(0, 14); // mod date
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(dataBytes.length, 20);
  centralHeader.writeUInt32LE(dataBytes.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30); // extra length
  centralHeader.writeUInt16LE(0, 32); // comment length
  centralHeader.writeUInt16LE(0, 34); // disk number
  centralHeader.writeUInt16LE(0, 36); // internal attrs
  centralHeader.writeUInt32LE(0, 38); // external attrs
  centralHeader.writeUInt32LE(0, 42); // offset of local header

  const centralEntry = Buffer.concat([centralHeader, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralEntry.length, 12); // central dir size
  eocd.writeUInt32LE(localEntry.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localEntry, centralEntry, eocd]);
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(root, ...relativePath.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

let cachedAdmZip: (new () => { addFile(name: string, data: Buffer): void; toBuffer(): Buffer }) | undefined;
async function getAdmZip() {
  if (cachedAdmZip === undefined) cachedAdmZip = (await import('adm-zip')).default;
  return cachedAdmZip;
}

async function buildZip(files: Record<string, string>): Promise<Buffer> {
  const AdmZip = await getAdmZip();
  const zip = new AdmZip();
  for (const [entryName, content] of Object.entries(files)) {
    zip.addFile(entryName, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

// ---------- Directory ----------

test('directory: a single supported file is discovered', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    await writeFiles(dir, { 'policy.txt': 'The insurer shall pay the claim within 30 days.' });
    const resolved = await resolveSourceArg(dir);
    assert.equal(resolved.argKind, 'directory');
    assert.deepEqual(
      resolved.sources.map((s) => s.declaredPath),
      ['policy.txt'],
    );
    await resolved.cleanup();
  });
});

test('directory: multiple files at the top level are all discovered', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    await writeFiles(dir, { 'a.txt': 'A shall do X.', 'b.txt': 'B shall do Y.', 'c.html': '<p>C shall do Z.</p>' });
    const resolved = await resolveSourceArg(dir);
    assert.equal(resolved.sources.length, 3);
    await resolved.cleanup();
  });
});

test('directory: nested subdirectories are walked recursively and relative paths preserved', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    await writeFiles(dir, {
      'top.txt': 'Top level shall apply.',
      'sub/nested.txt': 'Nested shall also apply.',
      'sub/deeper/deepest.txt': 'Deepest shall still apply.',
    });
    const resolved = await resolveSourceArg(dir);
    assert.deepEqual(
      resolved.sources.map((s) => s.declaredPath).sort(),
      ['sub/deeper/deepest.txt', 'sub/nested.txt', 'top.txt'],
    );
    await resolved.cleanup();
  });
});

test('directory: a root path with a trailing separator discovers the same, correctly-named files as one without (regression — trailing separator must not shift declaredPath by one character)', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    await writeFiles(dir, { 'top.txt': 'Top level shall apply.', 'sub/nested.txt': 'Nested shall also apply.' });

    const withoutTrailingSep = await resolveSourceArg(dir);
    const withTrailingSep = await resolveSourceArg(dir + sep);
    try {
      const expected = ['sub/nested.txt', 'top.txt'];
      assert.deepEqual(withoutTrailingSep.sources.map((s) => s.declaredPath).sort(), expected);
      assert.deepEqual(withTrailingSep.sources.map((s) => s.declaredPath).sort(), expected);
    } finally {
      await withoutTrailingSep.cleanup();
      await withTrailingSep.cleanup();
    }
  });
});

test('directory: mixed supported source types (txt, html, json, csv) are all discovered', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    await writeFiles(dir, {
      'doc.txt': 'The team shall generate a report.',
      'page.html': '<html><body>The reviewer shall approve drafts.</body></html>',
      'data.json': '{"clause": "The vendor shall deliver goods within 10 days."}',
      'table.csv': 'clause\nThe buyer shall pay within 30 days.',
    });
    const resolved = await resolveSourceArg(dir);
    assert.deepEqual(
      resolved.sources.map((s) => s.declaredPath).sort(),
      ['data.json', 'doc.txt', 'page.html', 'table.csv'],
    );
    await resolved.cleanup();
  });
});

test('directory: unsupported files are ignored (not compiled) but reported', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    await writeFiles(dir, { 'policy.txt': 'The insurer shall pay.' });
    await writeFile(join(dir, 'binary.exe'), Buffer.from([0x4d, 0x5a, 0x00, 0x01]));
    await writeFile(join(dir, 'notes.docx'), Buffer.from('not really a docx'));
    const resolved = await resolveSourceArg(dir);
    assert.equal(resolved.sources.length, 1);
    assert.equal(resolved.unsupported.length, 2);
    assert.ok(resolved.unsupported.some((u) => u.relativePath === 'binary.exe'));
    assert.ok(resolved.unsupported.some((u) => u.relativePath === 'notes.docx'));
    await resolved.cleanup();
  });
});

test('directory: dotfiles/dot-directories are skipped entirely (not even reported as unsupported)', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    await writeFiles(dir, { 'policy.txt': 'The insurer shall pay.', '.git/config': 'noise' });
    await writeFile(join(dir, '.DS_Store'), 'noise');
    const resolved = await resolveSourceArg(dir);
    assert.equal(resolved.sources.length, 1);
    assert.equal(resolved.unsupported.length, 0);
    await resolved.cleanup();
  });
});

test('directory: empty directory yields zero sources (caller decides how to fail)', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    const resolved = await resolveSourceArg(dir);
    assert.equal(resolved.sources.length, 0);
    await resolved.cleanup();
  });
});

test('collectSources on an empty directory fails clearly, not silently', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    await assert.rejects(collectSources([dir]), /no supported source files were found/);
  });
});

test('directory: discovery order is deterministic and sorted by path regardless of write order', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    await writeFiles(dir, { 'zebra.txt': 'Z shall apply.', 'alpha.txt': 'A shall apply.', 'mid/beta.txt': 'B shall apply.' });
    const resolved = await resolveSourceArg(dir);
    assert.deepEqual(
      resolved.sources.map((s) => s.declaredPath),
      ['alpha.txt', 'mid/beta.txt', 'zebra.txt'],
    );
    await resolved.cleanup();
  });
});

test('directory: a real PDF file inside a directory is discovered and typed correctly', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    const realPdf = await readFile(new URL('../../../examples/vertical-test/burglary-policy.pdf', import.meta.url));
    await writeFile(join(dir, 'policy.pdf'), realPdf);
    const resolved = await resolveSourceArg(dir);
    assert.deepEqual(
      resolved.sources.map((s) => s.declaredPath),
      ['policy.pdf'],
    );
    await resolved.cleanup();
  });
});

test('directory: duplicate ingestion via a symlink pointing back into the tree is prevented', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    await writeFiles(dir, { 'real.txt': 'The insurer shall pay the claim.' });
    try {
      await symlink(join(dir, 'real.txt'), join(dir, 'alias.txt'));
    } catch {
      return; // symlinks unavailable in this environment (e.g. restricted CI) — skip rather than fail
    }
    const resolved = await resolveSourceArg(dir);
    assert.equal(resolved.sources.length, 1);
    await resolved.cleanup();
  });
});

// ---------- ZIP ----------

test('zip: multiple files are extracted and discovered', async () => {
  await withTempDir('xo-collect-zip-', async (dir) => {
    const zipPath = join(dir, 'docs.zip');
    await writeFile(zipPath, await buildZip({ 'a.txt': 'A shall apply.', 'b.txt': 'B shall apply.' }));
    const resolved = await resolveSourceArg(zipPath);
    assert.equal(resolved.argKind, 'zip');
    assert.deepEqual(
      resolved.sources.map((s) => s.declaredPath).sort(),
      ['a.txt', 'b.txt'],
    );
    await resolved.cleanup();
  });
});

test('zip: nested paths inside the archive are preserved as declaredPath', async () => {
  await withTempDir('xo-collect-zip-', async (dir) => {
    const zipPath = join(dir, 'docs.zip');
    await writeFile(zipPath, await buildZip({ 'top.txt': 'Top shall apply.', 'nested/deep.txt': 'Deep shall apply.' }));
    const resolved = await resolveSourceArg(zipPath);
    assert.deepEqual(
      resolved.sources.map((s) => s.declaredPath).sort(),
      ['nested/deep.txt', 'top.txt'],
    );
    await resolved.cleanup();
  });
});

test('zip: mixed source types inside the archive are all discovered', async () => {
  await withTempDir('xo-collect-zip-', async (dir) => {
    const zipPath = join(dir, 'docs.zip');
    await writeFile(zipPath, await buildZip({ 'a.txt': 'A shall apply.', 'b.html': '<p>B shall apply.</p>', 'c.json': '{"x": "C shall apply."}' }));
    const resolved = await resolveSourceArg(zipPath);
    assert.equal(resolved.sources.length, 3);
    await resolved.cleanup();
  });
});

test('zip: unsupported entries are ignored but reported', async () => {
  await withTempDir('xo-collect-zip-', async (dir) => {
    const zipPath = join(dir, 'docs.zip');
    await writeFile(zipPath, await buildZip({ 'a.txt': 'A shall apply.', 'readme.exe': 'not really an exe' }));
    const resolved = await resolveSourceArg(zipPath);
    assert.equal(resolved.sources.length, 1);
    assert.equal(resolved.unsupported.length, 1);
    assert.equal(resolved.unsupported[0]?.relativePath, 'readme.exe');
    await resolved.cleanup();
  });
});

test('zip: empty archive yields zero sources', async () => {
  await withTempDir('xo-collect-zip-', async (dir) => {
    const zipPath = join(dir, 'empty.zip');
    await writeFile(zipPath, new (await getAdmZip())().toBuffer());
    const resolved = await resolveSourceArg(zipPath);
    assert.equal(resolved.sources.length, 0);
    await resolved.cleanup();
  });
});

test('zip: path-traversal ("zip-slip") entries are rejected, nothing is written outside the temp root', async () => {
  await withTempDir('xo-collect-zip-', async (dir) => {
    const zipPath = join(dir, 'evil.zip');
    await writeFile(zipPath, buildRawZipWithMaliciousEntry('../../evil.txt', 'should never be written'));

    await assert.rejects(resolveSourceArg(zipPath), /path traversal|outside the extraction root/);
    // Confirm nothing leaked outside this test's own temp dir tree.
    await assert.rejects(readFile(join(dir, '..', '..', 'evil.txt'), 'utf8'));
  });
});

test('zip: an absolute-path entry is rejected', async () => {
  await withTempDir('xo-collect-zip-', async (dir) => {
    const zipPath = join(dir, 'evil-absolute.zip');
    await writeFile(zipPath, buildRawZipWithMaliciousEntry('/etc/evil-cli-test.txt', 'should never be written'));

    await assert.rejects(resolveSourceArg(zipPath));
    await assert.rejects(readFile('/etc/evil-cli-test.txt', 'utf8'));
  });
});

test('zip: extraction does not modify the original archive file', async () => {
  await withTempDir('xo-collect-zip-', async (dir) => {
    const zipPath = join(dir, 'docs.zip');
    const original = await buildZip({ 'a.txt': 'A shall apply.' });
    await writeFile(zipPath, original);
    const before = await readFile(zipPath);

    const resolved = await resolveSourceArg(zipPath);
    await resolved.cleanup();

    const after = await readFile(zipPath);
    assert.deepEqual(before, after);
  });
});

test('zip: cleanup removes the temp extraction directory', async () => {
  await withTempDir('xo-collect-zip-', async (dir) => {
    const zipPath = join(dir, 'docs.zip');
    await writeFile(zipPath, await buildZip({ 'a.txt': 'A shall apply.' }));
    const resolved = await resolveSourceArg(zipPath);
    const extractedFilePath = resolved.sources[0]!.absolutePath;
    assert.ok(await readFile(extractedFilePath, 'utf8'));

    await resolved.cleanup();
    await assert.rejects(readFile(extractedFilePath, 'utf8'));
  });
});

test('zip: discovery order is deterministic regardless of archive entry order', async () => {
  await withTempDir('xo-collect-zip-', async (dir) => {
    const zipPathA = join(dir, 'a-order.zip');
    const zipPathB = join(dir, 'b-order.zip');
    const AdmZip = await getAdmZip();
    const zipA = new AdmZip();
    zipA.addFile('zebra.txt', Buffer.from('Z shall apply.'));
    zipA.addFile('alpha.txt', Buffer.from('A shall apply.'));
    await writeFile(zipPathA, zipA.toBuffer());

    const zipB = new AdmZip();
    zipB.addFile('alpha.txt', Buffer.from('A shall apply.'));
    zipB.addFile('zebra.txt', Buffer.from('Z shall apply.'));
    await writeFile(zipPathB, zipB.toBuffer());

    const resolvedA = await resolveSourceArg(zipPathA);
    const resolvedB = await resolveSourceArg(zipPathB);
    assert.deepEqual(
      resolvedA.sources.map((s) => s.declaredPath),
      resolvedB.sources.map((s) => s.declaredPath),
    );
    await resolvedA.cleanup();
    await resolvedB.cleanup();
  });
});

// ---------- collectSources (multi-arg, tagging) ----------

test('collectSources tags every discovered file into a compiler-ready SourceInput', async () => {
  await withTempDir('xo-collect-dir-', async (dir) => {
    await writeFiles(dir, { 'policy.txt': 'The insurer shall pay.', 'notes.html': '<p>The reviewer shall approve.</p>' });
    const collected = await collectSources([dir]);
    assert.equal(collected.inputs.length, 2);
    assert.equal(collected.discovered.length, 2);
    await collected.cleanup();
  });
});

test('collectSources combines an explicit file argument with a directory argument, preserving each declaredPath scheme', async () => {
  await withTempDir('xo-collect-dir-', async (outer) => {
    const explicitFile = join(outer, 'explicit.txt');
    await writeFile(explicitFile, 'The explicit file shall apply.');
    const subDir = join(outer, 'bundle');
    await writeFiles(subDir, { 'inner.txt': 'The inner file shall apply.' });

    const collected = await collectSources([explicitFile, subDir]);
    const paths = collected.discovered.map((d) => d.declaredPath).sort();
    assert.deepEqual(paths, [explicitFile, 'inner.txt'].sort());
    await collected.cleanup();
  });
});
