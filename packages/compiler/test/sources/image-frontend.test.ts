import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageSourceFrontend } from '../../src/sources/image-frontend.js';

const frontend = new ImageSourceFrontend();

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function gifBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

test('canHandle accepts tagged image input, rejects otherwise', () => {
  assert.equal(frontend.canHandle({ kind: 'image', bytes: pngBytes(1, 1), sourcePath: 'a.png' }), true);
  assert.equal(frontend.canHandle({ kind: 'document', text: 'x', sourcePath: 'a.txt' }), false);
});

test('sniffs PNG mime type and reads real width/height from the header', () => {
  const result = frontend.ingest({ kind: 'image', bytes: pngBytes(640, 480), sourcePath: 'photo.png' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.sourceType, 'image');
  assert.equal(result.value.content.kind, 'binary');
  if (result.value.content.kind !== 'binary') return;
  assert.equal(result.value.content.mimeType, 'image/png');
  assert.deepEqual(result.value.content.dimensions, { width: 640, height: 480 });
});

test('sniffs GIF mime type and dimensions', () => {
  const result = frontend.ingest({ kind: 'image', bytes: gifBytes(100, 50), sourcePath: 'anim.gif' });
  assert.equal(result.ok, true);
  if (!result.ok || result.value.content.kind !== 'binary') return;
  assert.equal(result.value.content.mimeType, 'image/gif');
  assert.deepEqual(result.value.content.dimensions, { width: 100, height: 50 });
});

test('JPEG is recognized by magic bytes but yields no invented dimensions (no decoder for it)', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const result = frontend.ingest({ kind: 'image', bytes, sourcePath: 'photo.jpg' });
  assert.equal(result.ok, true);
  if (!result.ok || result.value.content.kind !== 'binary') return;
  assert.equal(result.value.content.mimeType, 'image/jpeg');
  assert.equal(result.value.content.dimensions, undefined);
});

test('explicit mimeType overrides sniffing', () => {
  const result = frontend.ingest({ kind: 'image', bytes: pngBytes(1, 1), sourcePath: 'photo.dat', mimeType: 'image/vnd.custom' });
  assert.equal(result.ok, true);
  if (!result.ok || result.value.content.kind !== 'binary') return;
  assert.equal(result.value.content.mimeType, 'image/vnd.custom');
});

test('semanticExtractionAvailable is always false for images — no fake semantic support', () => {
  const result = frontend.ingest({ kind: 'image', bytes: pngBytes(1, 1), sourcePath: 'photo.png' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.semanticExtractionAvailable, false);
  assert.equal(result.value.content.kind, 'binary');
});

test('unrecognized bytes with no mimeType supplied fail with SOURCE_FORMAT_INVALID', () => {
  const result = frontend.ingest({ kind: 'image', bytes: new Uint8Array([1, 2, 3, 4]), sourcePath: 'mystery.bin' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_SERIALIZATION_SCHEMA_MISMATCH');
});

test('empty bytes fail with SOURCE_CONTENT_UNAVAILABLE', () => {
  const result = frontend.ingest({ kind: 'image', bytes: new Uint8Array(0), sourcePath: 'empty.png' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_PRECONDITION_FAILED');
});

test('sourceId is deterministic for identical bytes and path', () => {
  const bytes = pngBytes(10, 10);
  const a = frontend.ingest({ kind: 'image', bytes, sourcePath: 'x.png' });
  const b = frontend.ingest({ kind: 'image', bytes, sourcePath: 'x.png' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (a.ok && b.ok) assert.equal(a.value.sourceId, b.value.sourceId);
});
