import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { packBundle, packBundleStream } from '../src/archive/package-writer.js';
import { unpackArchive, unpackArchiveStream } from '../src/archive/package-reader.js';
import { zstdCompress } from '../src/archive/zstd-codec.js';
import { buildSampleBundle } from './fixtures.js';

test('packBundle -> unpackArchive round-trips manifest, metadata, and every component', async () => {
  const bundle = buildSampleBundle();
  const archive = await packBundle(bundle);
  const result = await unpackArchive(archive);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.manifest.name, bundle.manifest.name);
  assert.equal(result.value.manifest.version, bundle.manifest.version);
  assert.equal(result.value.manifest.merkleRoot, bundle.manifest.merkleRoot);
  assert.equal(result.value.components.length, bundle.components.length);
  for (const component of bundle.components) {
    const roundTripped = result.value.components.find((c) => c.kind === component.kind);
    assert.ok(roundTripped, `component ${component.kind} survived round-trip`);
    assert.deepEqual(roundTripped!.data, component.data);
  }
});

test('packBundleStream -> unpackArchiveStream round-trips identically to the buffer path', async () => {
  const bundle = buildSampleBundle();
  const stream = packBundleStream(bundle);
  const result = await unpackArchiveStream(stream);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.manifest.name, bundle.manifest.name);
  assert.equal(result.value.components.length, bundle.components.length);
});

test('unpackArchive rejects data that is not valid zstd (corruption detection)', async () => {
  const result = await unpackArchive(new TextEncoder().encode('this is not a zstd archive'));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_CORRUPT');
});

test('unpackArchive rejects a valid-zstd, but non-tar, payload', async () => {
  const notATar = zstdCompress(new TextEncoder().encode('hello world, not a tar file'));
  const result = await unpackArchive(notATar);
  assert.equal(result.ok, false);
});

test('unpackArchive rejects an archive missing manifest.json', async () => {
  const bundle = buildSampleBundle();
  const archive = await packBundle(bundle);
  const result = await unpackArchive(archive);
  assert.ok(result.ok);

  // Build a broken archive by re-packing without manifest.json present:
  // simplest way is to corrupt the compressed bytes' tail so extraction fails,
  // which is covered above; here we assert the reader's required-component
  // enforcement using a bundle missing a required component file at write time.
  const { bundleToTarEntries } = await import('../src/archive/package-writer.js');
  const entries = bundleToTarEntries(bundle).filter((e) => e.path !== 'manifest.json');
  const { tarEntriesToBuffer } = await import('../src/archive/tar-codec.js');
  const tarBytes = await tarEntriesToBuffer(entries);
  const brokenArchive = zstdCompress(tarBytes);
  const brokenResult = await unpackArchive(brokenArchive);
  assert.equal(brokenResult.ok, false);
  if (!brokenResult.ok) assert.equal(brokenResult.error.code, 'XO_PACKAGE_MANIFEST_INVALID');
});

test('unpackArchiveStream surfaces a corrupt stream as a Result, not a thrown error', async () => {
  const badStream = Readable.from(Buffer.from('definitely not zstd or tar'));
  const result = await unpackArchiveStream(badStream);
  assert.equal(result.ok, false);
});
