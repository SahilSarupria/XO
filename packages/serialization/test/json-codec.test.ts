import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOk, isErr } from '@xo/types';
import { jsonCodec } from '../src/json-codec.js';
import { wrapEnvelope, unwrapEnvelope } from '../src/versioned-envelope.js';

interface Point {
  x: number;
  y: number;
}
function isPoint(value: unknown): value is Point {
  return typeof value === 'object' && value !== null && typeof (value as Point).x === 'number' && typeof (value as Point).y === 'number';
}

test('jsonCodec round-trips a value', () => {
  const codec = jsonCodec<Point>({ validate: isPoint });
  const encoded = codec.encode({ x: 1, y: 2 });
  const decoded = codec.decode(encoded);
  assert.ok(isOk(decoded));
  if (isOk(decoded)) assert.deepEqual(decoded.value, { x: 1, y: 2 });
});

test('jsonCodec.decode fails on malformed JSON', () => {
  const codec = jsonCodec<Point>({ validate: isPoint });
  const decoded = codec.decode('{not json');
  assert.ok(isErr(decoded));
});

test('jsonCodec.decode fails validation when shape does not match', () => {
  const codec = jsonCodec<Point>({ validate: isPoint });
  const decoded = codec.decode(JSON.stringify({ x: 'not-a-number' }));
  assert.ok(isErr(decoded));
});

test('wrapEnvelope/unwrapEnvelope round-trip at the matching version', () => {
  const envelope = wrapEnvelope<Point>({ x: 3, y: 4 }, 1);
  const result = unwrapEnvelope(envelope, 1, isPoint);
  assert.ok(isOk(result));
  if (isOk(result)) assert.deepEqual(result.value, { x: 3, y: 4 });
});

test('unwrapEnvelope rejects a schema-version mismatch', () => {
  const envelope = wrapEnvelope<Point>({ x: 3, y: 4 }, 2);
  const result = unwrapEnvelope(envelope, 1, isPoint);
  assert.ok(isErr(result));
});
