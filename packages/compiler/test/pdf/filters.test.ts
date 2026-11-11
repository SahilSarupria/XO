import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAscii85, decodeAsciiHex, decodeLzw, decodeRunLength, decodeStream } from '../../src/pdf/filters.js';
import type { PdfStream } from '../../src/pdf/types.js';

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'latin1'));
const text = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

/** Reference ASCII85 encoder (test only). */
function encode85(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const n = Math.min(4, data.length - i);
    let v = 0;
    for (let k = 0; k < 4; k += 1) v = v * 256 + (k < n ? data[i + k]! : 0);
    if (n === 4 && v === 0) {
      out += 'z';
      continue;
    }
    const chars: string[] = [];
    for (let k = 0; k < 5; k += 1) {
      chars.unshift(String.fromCharCode((v % 85) + 33));
      v = Math.floor(v / 85);
    }
    out += chars.slice(0, n + 1).join('');
  }
  return `${out}~>`;
}

/** Reference LZW encoder (test only), EarlyChange = 1. */
function encodeLzw(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let buf = 0;
  let nbits = 0;
  let width = 9;
  const put = (code: number): void => {
    buf = (buf << width) | code;
    nbits += width;
    while (nbits >= 8) {
      out.push((buf >> (nbits - 8)) & 0xff);
      nbits -= 8;
      buf &= (1 << nbits) - 1;
    }
  };
  let dict = new Map<string, number>();
  const init = (): void => {
    dict = new Map();
    for (let c = 0; c < 256; c += 1) dict.set(String.fromCharCode(c), c);
  };
  init();
  let next = 258;
  put(256);
  let w = '';
  for (const b of data) {
    const c = String.fromCharCode(b);
    if (dict.has(w + c)) w += c;
    else {
      put(dict.get(w)!);
      dict.set(w + c, next);
      next += 1;
      const size = next; // encoder is one entry ahead of the decoder
      width = size >= 2048 ? 12 : size >= 1024 ? 11 : size >= 512 ? 10 : 9;
      if (next >= 4094) {
        put(256);
        init();
        next = 258;
        width = 9;
      }
      w = c;
    }
  }
  if (w !== '') put(dict.get(w)!);
  put(257);
  if (nbits > 0) out.push((buf << (8 - nbits)) & 0xff);
  return Uint8Array.from(out);
}

test('ASCIIHexDecode: whitespace, terminator, odd final digit', () => {
  assert.equal(text(decodeAsciiHex(bytes('48 65 6c 6C 6f>'))), 'Hello');
  assert.deepEqual([...decodeAsciiHex(bytes('7>'))], [0x70]);
  assert.throws(() => decodeAsciiHex(bytes('4g>')));
});

test('ASCII85Decode round-trips every tail length, z shortcut, and the <~ prefix', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'Do not create a missing receipt.']) {
    assert.equal(text(decodeAscii85(bytes(encode85(bytes(s))))), s, JSON.stringify(s));
  }
  assert.deepEqual([...decodeAscii85(bytes('z~>'))], [0, 0, 0, 0]);
  assert.equal(text(decodeAscii85(bytes(`<~${encode85(bytes('hi'))}`))), 'hi');
  assert.throws(() => decodeAscii85(bytes('a~>')));
  assert.throws(() => decodeAscii85(bytes('ab\x7f~>')));
});

test('ASCII85Decode round-trips random binary', () => {
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 0xff;
  const data = Uint8Array.from({ length: 1000 }, rnd);
  assert.deepEqual([...decodeAscii85(bytes(encode85(data)))], [...data]);
});

test('RunLengthDecode: literal and repeat runs, EOD', () => {
  const enc = Uint8Array.from([2, 65, 66, 67, 254, 68, 128, 99]);
  assert.equal(text(decodeRunLength(enc)), 'ABCDDD');
});

test('LZWDecode round-trips text longer than one code-width change', () => {
  const s = Array.from({ length: 3000 }, (_, i) => `rule ${i % 37} applies when claim ${i % 11} is late; `).join('');
  assert.equal(text(decodeLzw(encodeLzw(bytes(s)))), s);
});

test('decodeStream applies a chained /Filter [ASCII85Decode ...] (the P0.9A blocker)', () => {
  const payload = 'BT /F1 12 Tf 72 700 Td (Never promise what the insurer has not confirmed) Tj ET';
  const stream = {
    dictionary: { entries: new Map([['Filter', { kind: 'name', name: 'ASCII85Decode' }]]) },
    rawBytes: bytes(encode85(bytes(payload))),
  } as unknown as PdfStream;
  assert.equal(text(decodeStream(stream)), payload);
});

// ---- from main (resource-limited filters) ----

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

test('ASCII85: decodes the canonical example, whitespace and the end marker', () => {
  assert.equal(text(decodeAscii85(enc('<~87cURD]i,"Ebo8@~>'))), 'Hello World1');
  assert.equal(text(decodeAscii85(enc('87cUR D]i,"\nEbo8@~>'))), 'Hello World1');
});

test('ASCII85: `z` is four zero bytes; a short final group yields n-1 bytes', () => {
  assert.deepEqual([...decodeAscii85(enc('z~>'))], [0, 0, 0, 0]);
  assert.equal(text(decodeAscii85(enc('87cURDZ~>'))), 'Hello');
});

test('ASCII85: invalid characters and a dangling digit are errors, never silent garbage', () => {
  assert.throws(() => decodeAscii85(enc('87cUR{~>')), /invalid character/);
  assert.throws(() => decodeAscii85(enc('8~>')), /dangling/);
});

test('ASCIIHex: pairs, whitespace, odd final digit padded, > ends', () => {
  assert.equal(text(decodeAsciiHex(enc('48 65 6c6C 6f>ignored'))), 'Hello');
  assert.deepEqual([...decodeAsciiHex(enc('7>'))], [0x70]);
  assert.throws(() => decodeAsciiHex(enc('4g>')), /invalid character/);
});

test('RunLength: literal and repeat runs, EOD, truncation is an error', () => {
  assert.equal(text(decodeRunLength(Uint8Array.from([2, 65, 66, 67, 254, 68, 128, 99]))), 'ABCDDD');
  assert.throws(() => decodeRunLength(Uint8Array.from([5, 65])), /overruns/);
});

test('LZWDecode: output is bounded (an LZW bomb is a resource-limit error, not an allocation)', () => {
  const big = new Uint8Array(200_000); // compresses to a tiny stream
  const packed = encodeLzw(big);
  assert.ok(packed.length < big.length / 10);
  assert.throws(() => decodeLzw(packed, 1, 10_000), /decodes beyond/);
  assert.equal(decodeLzw(packed, 1, 1_000_000).length, big.length);
});
