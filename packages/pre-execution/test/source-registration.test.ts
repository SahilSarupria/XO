/**
 * PX-1 — content checks at the door, archive limits, and source-set identity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildSourceSet,
  checkArchiveEntries,
  classifySourceContent,
  detectFormat,
  isSafeArchivePath,
  verifySourceSet,
  DEFAULT_ARCHIVE_LIMITS,
  type SourceSetEntry,
} from '../src/index.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const PDF = bytes('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff]);

test('content is decided from the bytes: signatures first, then a text test', () => {
  assert.equal(detectFormat(PDF), 'pdf');
  assert.equal(detectFormat(new Uint8Array([...bytes('\n\n  '), ...PDF])), 'pdf', 'a PDF header may follow up to 1 KiB of junk');
  assert.equal(detectFormat(ZIP), 'zip');
  assert.equal(detectFormat(PNG), 'png');
  assert.equal(detectFormat(JPEG), 'jpeg');
  assert.equal(detectFormat(bytes('GIF89a....')), 'gif');
  assert.equal(detectFormat(bytes('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(detectFormat(EXE), 'binary');
  assert.equal(detectFormat(bytes('# Heading\n\nBody text, café.\n')), 'text');
  assert.equal(detectFormat(new Uint8Array([0xff, 0xfe, 0x41, 0x00])), 'utf16-text');
});

test('accepted: each extension with the content it should hold', () => {
  for (const [ext, b] of [
    ['.pdf', PDF],
    ['.docx', ZIP],
    ['.xlsx', ZIP],
    ['.png', PNG],
    ['.jpg', JPEG],
    ['.md', bytes('# Title')],
    ['.csv', bytes('a,b\n1,2\n')],
    ['.eml', bytes('From: a@example.gov\r\nSubject: x\r\n\r\nbody')],
    ['.json', bytes('{"a":1}')],
  ] as const) {
    const r = classifySourceContent(b, ext);
    assert.ok(r.ok, `${ext}: ${r.ok ? '' : r.message}`);
  }
});

test('refused with a structured code: empty, too large, unsupported, and content that contradicts the extension', () => {
  const codes = (b: Uint8Array, ext: string, max?: number): string => {
    const r = classifySourceContent(b, ext, max !== undefined ? { maxBytes: max } : {});
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(codes(new Uint8Array(), '.pdf'), 'SOURCE_EMPTY');
  assert.equal(codes(PDF, '.pdf', 10), 'SOURCE_TOO_LARGE');
  assert.equal(codes(PDF, '.exe'), 'SOURCE_UNSUPPORTED');
  assert.equal(codes(bytes('<html><body>not a pdf</body></html>'), '.pdf'), 'SOURCE_SIGNATURE_MISMATCH');
  assert.equal(codes(EXE, '.docx'), 'SOURCE_SIGNATURE_MISMATCH');
  assert.equal(codes(EXE, '.txt'), 'SOURCE_SIGNATURE_MISMATCH', 'a renamed executable is not text');
  assert.equal(codes(PDF, '.png'), 'SOURCE_SIGNATURE_MISMATCH');
  // Any image under any image extension is accepted: the detected format decides the stored media type.
  const renamed = classifySourceContent(PNG, '.jpg');
  assert.ok(renamed.ok && renamed.detected === 'png');
  // A polyglot: a PDF header inside an HTML file is read as the PDF it claims to be, so it is not text.
  assert.equal(codes(bytes('<html>%PDF-1.4 trailer</html>'), '.html'), 'SOURCE_SIGNATURE_MISMATCH');
  const mismatch = classifySourceContent(bytes('<html>x</html>'), '.pdf');
  assert.ok(!mismatch.ok && /not what a "\.pdf" file holds/.test(mismatch.message));
});

test('archives: entry count, inflated size, compression ratio, nesting and paths outside the root are refused', () => {
  const ok = (name: string, size = 1000, compressed = 500) => ({ name, uncompressedSize: size, compressedSize: compressed });
  assert.deepEqual(checkArchiveEntries([ok('a.pdf'), ok('docs/b.md')]), { ok: true });
  const refused = (r: ReturnType<typeof checkArchiveEntries>): string => (r.ok ? 'ok' : r.message);
  assert.match(refused(checkArchiveEntries([ok('../escape.pdf')])), /outside the extraction root/);
  assert.match(refused(checkArchiveEntries([ok('/etc/passwd')])), /outside/);
  assert.match(refused(checkArchiveEntries([ok('C:\\win.ini')])), /outside/);
  assert.match(refused(checkArchiveEntries([ok('bomb.txt', 900 * 1024 * 1024, 1024 * 1024)])), /inflates to more than/);
  assert.match(refused(checkArchiveEntries([ok('ratio.txt', 40 * 1024 * 1024, 10 * 1024)])), /compression ratio/);
  assert.match(
    refused(checkArchiveEntries(Array.from({ length: DEFAULT_ARCHIVE_LIMITS.maxEntries + 1 }, (_, k) => ok(`f${k}.txt`, 1, 1)))),
    /entries/,
  );
  assert.match(
    refused(checkArchiveEntries(Array.from({ length: 5 }, (_, k) => ok(`f${k}.pdf`, 45 * 1024 * 1024, 40 * 1024 * 1024)))),
    /in total/,
  );
  assert.match(refused(checkArchiveEntries([ok('a.pdf')], 3)), /nested/);
  assert.equal(isSafeArchivePath('a/b/c.pdf'), true);
  assert.equal(isSafeArchivePath('a/../../c.pdf'), false);
  assert.equal(isSafeArchivePath('a\0b'), false);
});

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const entry = (name: string, content: string, extra: Partial<SourceSetEntry> = {}): SourceSetEntry => ({
  sourceId: `src_${sha(name).slice(0, 32)}`,
  digestSha256: sha(content),
  name,
  byteSize: content.length,
  role: 'primary',
  ...extra,
});

test('source sets: same versions, same id; any changed byte, name, role or order gives a new id; upload records do not count', () => {
  const a = buildSourceSet([entry('policy.pdf', 'A'), entry('manual.md', 'B')]);
  const again = buildSourceSet([entry('policy.pdf', 'A', { sourceId: 'src_other_upload' }), entry('manual.md', 'B')]);
  assert.equal(a.sourceSetId, again.sourceSetId, 'a re-upload of the same bytes is the same version');
  assert.match(a.sourceSetId, /^ss_[0-9a-f]{24}$/);
  assert.notEqual(buildSourceSet([entry('policy.pdf', 'A2'), entry('manual.md', 'B')]).sourceSetId, a.sourceSetId);
  assert.notEqual(buildSourceSet([entry('manual.md', 'B'), entry('policy.pdf', 'A')]).sourceSetId, a.sourceSetId, 'order is significant');
  assert.notEqual(buildSourceSet([entry('policy.pdf', 'A', { role: 'supporting' }), entry('manual.md', 'B')]).sourceSetId, a.sourceSetId);
  assert.notEqual(buildSourceSet([entry('renamed.pdf', 'A'), entry('manual.md', 'B')]).sourceSetId, a.sourceSetId);
  assert.deepEqual(verifySourceSet(a), { ok: true });
  assert.equal(verifySourceSet({ ...a, entries: [a.entries[0]!] }).ok, false, 'a manifest whose entries were edited fails verification');
  assert.throws(() => buildSourceSet([]), /at least one/);
  assert.throws(() => buildSourceSet([{ ...entry('x.pdf', 'X'), digestSha256: 'ABC' }]), /64 lowercase hex/);
});
