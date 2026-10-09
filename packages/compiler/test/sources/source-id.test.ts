import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSourceId } from '../../src/sources/source-id.js';

test('computeSourceId is deterministic for identical inputs', () => {
  const a = computeSourceId('pdf', 'contract.pdf', new TextEncoder().encode('hello world'));
  const b = computeSourceId('pdf', 'contract.pdf', new TextEncoder().encode('hello world'));
  assert.equal(a, b);
});

test('computeSourceId differs when content differs', () => {
  const a = computeSourceId('pdf', 'contract.pdf', 'hello world');
  const b = computeSourceId('pdf', 'contract.pdf', 'hello mars');
  assert.notEqual(a, b);
});

test('computeSourceId differs when sourceType differs, even with identical content/path', () => {
  const a = computeSourceId('pdf', 'x', 'same content');
  const b = computeSourceId('document', 'x', 'same content');
  assert.notEqual(a, b);
});

test('computeSourceId differs when sourcePath differs, even with identical content/type', () => {
  const a = computeSourceId('document', 'a.txt', 'same content');
  const b = computeSourceId('document', 'b.txt', 'same content');
  assert.notEqual(a, b);
});

test('computeSourceId accepts both string and Uint8Array content and is stable in form', () => {
  const id = computeSourceId('image', 'photo.png', new Uint8Array([1, 2, 3]));
  assert.match(id, /^src_[0-9a-f]{32}$/);
});

test('computeSourceId never depends on wall-clock or randomness (repeated calls stay identical)', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 5; i++) {
    ids.add(computeSourceId('document', 'stable.txt', 'stable content'));
  }
  assert.equal(ids.size, 1);
});
