import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { packBundle } from '../src/archive/package-writer.js';
import { unpackArchive } from '../src/archive/package-reader.js';
import { tarBufferToEntries } from '../src/archive/tar-codec.js';
import { buildSampleBundle } from './fixtures.js';

interface RawEntry {
  readonly name: string;
  readonly data?: Uint8Array;
  readonly typeflag?: string;
  readonly prefix?: string;
  readonly badChecksum?: boolean;
  readonly sizeField?: string;
}

function rawTar(entries: readonly RawEntry[], opts: { readonly terminate?: boolean; readonly trailing?: Buffer } = {}): Uint8Array {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? new Uint8Array());
    const h = Buffer.alloc(512, 0);
    h.write(e.name, 0, 100, 'utf8');
    h.write('0000644\0', 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii');
    h.write('0000000\0', 116, 8, 'ascii');
    h.write(e.sizeField ?? `${data.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    h.write('00000000000\0', 136, 12, 'ascii');
    h.fill(0x20, 148, 156);
    h.write(e.typeflag ?? '0', 156, 1, 'ascii');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    h.write(e.prefix ?? '', 345, 155, 'utf8');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${(e.badChecksum ? sum + 1 : sum).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(h, data, Buffer.alloc((512 - (data.byteLength % 512)) % 512, 0));
  }
  if (opts.terminate !== false) blocks.push(Buffer.alloc(1024, 0));
  if (opts.trailing) blocks.push(opts.trailing);
  return new Uint8Array(Buffer.concat(blocks));
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

async function validEntries(): Promise<{ name: string; data: Uint8Array }[]> {
  const archive = await packBundle(buildSampleBundle());
  const { zstdDecompressSync } = await import('node:zlib');
  const tar = new Uint8Array(zstdDecompressSync(archive));
  const parsed = await tarBufferToEntries(tar);
  assert.ok(parsed.ok);
  return parsed.ok ? parsed.value.map((e) => ({ name: e.path, data: e.data })) : [];
}

const compress = (tar: Uint8Array): Uint8Array => new Uint8Array(zstdCompressSync(tar));

test('baseline: a rebuilt archive from raw entries still unpacks (fixture sanity)', async () => {
  const entries = await validEntries();
  const r = await unpackArchive(compress(rawTar(entries)));
  assert.equal(r.ok, true);
});

test('hostile entry names are rejected before any entry is interpreted', async () => {
  const base = await validEntries();
  const hostile = [
    '../../etc/passwd',
    '../victim/1.0.0/safety/rules.json',
    '/etc/passwd',
    'C:\\Windows\\evil.dll',
    'C:/evil',
    '\\\\server\\share\\x',
    'knowledge/../../x',
    'a\\b',
    'x/./y',
    'a//b',
    'con:stream',
    'bad\u0001name',
    'Manifest.json', // case-variant of the installer-owned file
  ];
  for (const name of hostile) {
    const r = await unpackArchive(compress(rawTar([...base, { name, data: enc('x') }])));
    assert.equal(r.ok, false, `accepted ${JSON.stringify(name)}`);
  }
});

test('duplicate and case-colliding entry paths are rejected', async () => {
  const base = await validEntries();
  const dup = await unpackArchive(compress(rawTar([...base, { name: 'safety/rules.json', data: enc('{"rules":["evil"]}') }])));
  assert.equal(dup.ok, false);
  const ci = await unpackArchive(compress(rawTar([...base, { name: 'SAFETY/Rules.json', data: enc('x') }])));
  assert.equal(ci.ok, false);
  const nested = await unpackArchive(compress(rawTar([...base, { name: 'safety/rules.json/inner', data: enc('x') }])));
  assert.equal(nested.ok, false);
});

test('symlinks, hard links, directories, devices and pax/GNU headers are rejected, not silently skipped', async () => {
  const base = await validEntries();
  for (const typeflag of ['1', '2', '3', '4', '5', '6', 'x', 'g', 'L', 'K']) {
    const r = await unpackArchive(compress(rawTar([...base, { name: 'link', typeflag }])));
    assert.equal(r.ok, false, `typeflag ${typeflag}`);
  }
});

test('corrupt tar structure fails closed: bad checksum, malformed size, truncation, missing end marker, trailing data', async () => {
  const base = await validEntries();
  assert.equal((await unpackArchive(compress(rawTar(base.map((e, i) => ({ ...e, badChecksum: i === 0 })))))).ok, false);
  assert.equal(
    (await unpackArchive(compress(rawTar(base.map((e, i) => ({ ...e, sizeField: i === 0 ? 'zzzzzzzzzzz\0' : undefined })))))).ok,
    false,
  );
  const whole = rawTar(base);
  assert.equal((await unpackArchive(compress(whole.subarray(0, 700)))).ok, false); // truncated mid-entry
  assert.equal((await unpackArchive(compress(rawTar(base, { terminate: false })))).ok, false); // no end-of-archive marker
  assert.equal((await unpackArchive(compress(rawTar(base, { trailing: Buffer.from('smuggled') })))).ok, false);
  assert.equal((await unpackArchive(compress(rawTar(base.map((e, i) => (i === 0 ? { ...e, sizeField: '77777777777\0' } : e)))))).ok, false); // size past end
});

test('decompression size cap: an archive that expands beyond the limit is refused', async () => {
  const bomb = compress(new Uint8Array(8 * 1024 * 1024)); // 8 MiB of zeros compresses to a few bytes
  const r = await unpackArchive(bomb, { maxDecompressedBytes: 1024 * 1024 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'XO_PACKAGE_CORRUPT');
});

test('non-UTF-8 and empty entry names are rejected', async () => {
  const base = await validEntries();
  assert.equal((await unpackArchive(compress(rawTar([...base, { name: '', data: enc('x') }])))).ok, false);
  const bad = rawTar([...base, { name: 'placeholder', data: enc('x') }]);
  const buf = Buffer.from(bad);
  const at = buf.indexOf(Buffer.from('placeholder'));
  buf[at] = 0xff; // invalid UTF-8 lead byte; checksum fixed up below
  const hdr = at - (at % 512);
  buf.fill(0x20, hdr + 148, hdr + 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[hdr + i]!;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, hdr + 148, 8, 'ascii');
  assert.equal((await unpackArchive(compress(new Uint8Array(buf)))).ok, false);
});
