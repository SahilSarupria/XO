import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSourceInput, looksBinary } from '../src/commands/compiler/source-input.js';
import { withTempDir } from './helpers.js';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);

test('looksBinary: zip/OLE magic and NUL bytes are binary; ordinary and non-ASCII UTF-8 text is not', () => {
  assert.equal(looksBinary(ZIP_MAGIC), true);
  assert.equal(looksBinary(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])), true);
  assert.equal(looksBinary(Buffer.from('plain text\u0000with a NUL')), true);
  assert.equal(looksBinary(Buffer.from('Expenses above \u20b950,000 \u2014 r\u00e9sum\u00e9 \u65e5\u672c\u8a9e', 'utf8')), false);
  assert.equal(looksBinary(Buffer.alloc(0)), false);
});

test('loadSourceInput refuses Office/OpenDocument containers instead of decoding them as text', async () => {
  await withTempDir('xo-binary-', async (dir) => {
    for (const name of ['a.pptx', 'a.odt', 'a.doc', 'a.xls']) {
      const p = join(dir, name);
      await writeFile(p, ZIP_MAGIC);
      await assert.rejects(() => loadSourceInput(p), /binary file.*NOT ingested/s, name);
    }
  });
});

test('loadSourceInput refuses binary content behind an unknown or missing extension', async () => {
  await withTempDir('xo-binary-', async (dir) => {
    const zipLike = join(dir, 'report.dat');
    await writeFile(zipLike, ZIP_MAGIC);
    await assert.rejects(() => loadSourceInput(zipLike), /binary file/);
    const nulBytes = join(dir, 'noext');
    await writeFile(nulBytes, Buffer.from([0x68, 0x69, 0x00, 0x01, 0x02]));
    await assert.rejects(() => loadSourceInput(nulBytes), /binary file/);
  });
});

test('loadSourceInput still accepts plain text, Markdown, and unknown-extension text (incl. non-ASCII)', async () => {
  await withTempDir('xo-binary-', async (dir) => {
    const body = 'Rule one applies above \u20b950,000.\nSecond line \u2014 caf\u00e9.';
    for (const name of ['a.txt', 'a.md', 'a.rtf', 'notes.log', 'README']) {
      const p = join(dir, name);
      await writeFile(p, body, 'utf8');
      const out = (await loadSourceInput(p)) as { kind: string; text: string };
      assert.equal(out.kind, 'document', name);
      assert.equal(out.text, body, name);
    }
  });
});

test('a .docx is routed to the DOCX frontend (bytes), not decoded as text and not refused as unsupported', async () => {
  await withTempDir('xo-docx-', async (dir) => {
    const p = join(dir, 'a.docx');
    await writeFile(p, ZIP_MAGIC);
    const out = (await loadSourceInput(p)) as { kind: string; bytes: Uint8Array; sourcePath: string };
    assert.equal(out.kind, 'docx');
    assert.ok(out.bytes instanceof Uint8Array);
  });
});
