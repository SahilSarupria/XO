import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAscii85, decodeAsciiHex, decodeRunLength } from '../../src/pdf/filters.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

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
