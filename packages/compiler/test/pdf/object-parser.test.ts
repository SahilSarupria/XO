import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectParser } from '../../src/pdf/object-parser.js';
import { isArray, isDictionary, isName, isReference } from '../../src/pdf/types.js';

test('parses a simple indirect dictionary object', () => {
  const buf = new Uint8Array(Buffer.from('12 0 obj\n<< /Type /Catalog /Count 3 >>\nendobj', 'latin1'));
  const parser = new ObjectParser(buf, 0);
  const indirect = parser.parseIndirectObject();
  assert.equal(indirect.objectNumber, 12);
  assert.equal(indirect.generation, 0);
  assert.ok(isDictionary(indirect.value));
  if (!isDictionary(indirect.value)) return;
  const type = indirect.value.entries.get('Type');
  assert.ok(type && isName(type) && type.name === 'Catalog');
  assert.equal(indirect.value.entries.get('Count'), 3);
});

test('parses an indirect reference (n g R) inside an array', () => {
  const buf = new Uint8Array(Buffer.from('1 0 obj\n[2 0 R 3 0 R]\nendobj', 'latin1'));
  const parser = new ObjectParser(buf, 0);
  const indirect = parser.parseIndirectObject();
  assert.ok(isArray(indirect.value));
  if (!isArray(indirect.value)) return;
  assert.equal(indirect.value.items.length, 2);
  assert.ok(isReference(indirect.value.items[0]!));
  if (isReference(indirect.value.items[0]!)) assert.equal(indirect.value.items[0].objectNumber, 2);
});

test('does not misinterpret two bare numbers followed by something other than R as a reference', () => {
  const buf = new Uint8Array(Buffer.from('1 0 obj\n[5 10]\nendobj', 'latin1'));
  const parser = new ObjectParser(buf, 0);
  const indirect = parser.parseIndirectObject();
  assert.ok(isArray(indirect.value));
  if (!isArray(indirect.value)) return;
  assert.deepEqual(indirect.value.items, [5, 10]);
});

test('parses a stream object using an explicit /Length', () => {
  const streamData = 'hello world';
  const buf = new Uint8Array(Buffer.from(`1 0 obj\n<< /Length ${streamData.length} >>\nstream\n${streamData}\nendstream\nendobj`, 'latin1'));
  const parser = new ObjectParser(buf, 0);
  const indirect = parser.parseIndirectObject();
  assert.equal(indirect.value !== null && typeof indirect.value === 'object' && 'kind' in indirect.value && indirect.value.kind, 'stream');
  if (typeof indirect.value === 'object' && indirect.value !== null && 'kind' in indirect.value && indirect.value.kind === 'stream') {
    assert.equal(Buffer.from(indirect.value.rawBytes).toString('latin1'), streamData);
  }
});

test('recovers a stream body via endstream-scanning when /Length is wrong', () => {
  const streamData = 'recovered content';
  const buf = new Uint8Array(Buffer.from(`1 0 obj\n<< /Length 99999 >>\nstream\n${streamData}\nendstream\nendobj`, 'latin1'));
  const parser = new ObjectParser(buf, 0);
  const indirect = parser.parseIndirectObject();
  if (typeof indirect.value === 'object' && indirect.value !== null && 'kind' in indirect.value && indirect.value.kind === 'stream') {
    assert.equal(Buffer.from(indirect.value.rawBytes).toString('latin1'), streamData);
  } else {
    assert.fail('expected a stream value');
  }
});

test('resolves an indirect /Length via the provided resolver', () => {
  const streamData = 'via indirect length';
  const buf = new Uint8Array(Buffer.from(`1 0 obj\n<< /Length 2 0 R >>\nstream\n${streamData}\nendstream\nendobj`, 'latin1'));
  const parser = new ObjectParser(buf, 0);
  const indirect = parser.parseIndirectObject((objNum) => (objNum === 2 ? streamData.length : undefined));
  if (typeof indirect.value === 'object' && indirect.value !== null && 'kind' in indirect.value && indirect.value.kind === 'stream') {
    assert.equal(Buffer.from(indirect.value.rawBytes).toString('latin1'), streamData);
  } else {
    assert.fail('expected a stream value');
  }
});

test('throws PdfError on malformed object syntax', () => {
  const buf = new Uint8Array(Buffer.from('not a valid object', 'latin1'));
  const parser = new ObjectParser(buf, 0);
  assert.throws(() => parser.parseIndirectObject());
});
