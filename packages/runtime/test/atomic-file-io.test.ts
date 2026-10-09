import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteJson, canonicalStringify, deleteFile, KeyedAsyncLock, listJsonFiles, readJsonChecked } from '../src/persistence/file/atomic-file-io.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-fileio-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('canonicalStringify produces the same output regardless of key insertion order', () => {
  const a = canonicalStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonicalStringify({ a: 2, c: { y: 2, z: 1 }, b: 1 });
  assert.equal(a, b);
});

test('canonicalStringify preserves array element order', () => {
  const result = canonicalStringify({ items: [3, 1, 2] });
  assert.ok(result.includes('[3,1,2]'));
});

test('atomicWriteJson + readJsonChecked round-trips data exactly', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'record.json');
    await atomicWriteJson(path, { foo: 'bar', nested: { n: 1 } });
    const result = await readJsonChecked(path);
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') assert.deepEqual(result.payload, { foo: 'bar', nested: { n: 1 } });
  });
});

test('atomicWriteJson creates parent directories as needed', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'a', 'b', 'c', 'record.json');
    await atomicWriteJson(path, { ok: true });
    const result = await readJsonChecked(path);
    assert.equal(result.kind, 'ok');
  });
});

test('readJsonChecked reports "missing" (not an error) for a never-written path', async () => {
  await withTempDir(async (dir) => {
    const result = await readJsonChecked(join(dir, 'nope.json'));
    assert.equal(result.kind, 'missing');
  });
});

test('readJsonChecked detects a tampered payload via checksum mismatch', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'record.json');
    await atomicWriteJson(path, { foo: 'bar' });
    const raw = await readFile(path, 'utf8');
    const tampered = raw.replace('bar', 'TAMPERED');
    await writeFile(path, tampered, 'utf8');
    const result = await readJsonChecked(path);
    assert.equal(result.kind, 'corrupt');
  });
});

test('readJsonChecked detects truncated/malformed JSON', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'record.json');
    await writeFile(path, '{ "not": "valid json"', 'utf8');
    const result = await readJsonChecked(path);
    assert.equal(result.kind, 'corrupt');
  });
});

test('atomicWriteJson leaves no partial file visible: a write is all-or-nothing', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'record.json');
    await atomicWriteJson(path, { version: 1 });
    await atomicWriteJson(path, { version: 2 });
    const result = await readJsonChecked(path);
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') assert.deepEqual(result.payload, { version: 2 });
  });
});

test('deleteFile returns true when a file existed, false when it did not', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'record.json');
    await atomicWriteJson(path, {});
    assert.equal(await deleteFile(path), true);
    assert.equal(await deleteFile(path), false);
  });
});

test('listJsonFiles returns [] for a directory that was never created, never throws', async () => {
  await withTempDir(async (dir) => {
    const files = await listJsonFiles(join(dir, 'never-created'));
    assert.deepEqual(files, []);
  });
});

test('listJsonFiles lists only .json files directly in the directory', async () => {
  await withTempDir(async (dir) => {
    await atomicWriteJson(join(dir, 'a.json'), {});
    await atomicWriteJson(join(dir, 'b.json'), {});
    await writeFile(join(dir, 'ignore.txt'), 'x', 'utf8');
    const files = await listJsonFiles(dir);
    assert.deepEqual(files.slice().sort(), ['a.json', 'b.json']);
  });
});

test('KeyedAsyncLock serializes operations on the same key', async () => {
  const lock = new KeyedAsyncLock();
  const order: number[] = [];
  const op = (n: number, delayMs: number) => lock.withLock('key', async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    order.push(n);
  });
  await Promise.all([op(1, 20), op(2, 5), op(3, 1)]);
  assert.deepEqual(order, [1, 2, 3]); // started-order, not completion-order, because each waits for the previous
});

test('KeyedAsyncLock lets different keys run fully concurrently', async () => {
  const lock = new KeyedAsyncLock();
  const started: string[] = [];
  const finished: string[] = [];
  const op = (key: string, delayMs: number) => lock.withLock(key, async () => {
    started.push(key);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    finished.push(key);
  });
  await Promise.all([op('a', 30), op('b', 10)]);
  // 'b' (shorter delay, different key) finishes before 'a' despite starting after —
  // proof they ran concurrently rather than being serialized behind one global lock.
  assert.deepEqual(finished, ['b', 'a']);
});

test('KeyedAsyncLock does not permanently wedge a key after a failed operation', async () => {
  const lock = new KeyedAsyncLock();
  await assert.rejects(lock.withLock('key', async () => {
    throw new Error('boom');
  }));
  const result = await lock.withLock('key', async () => 'still works');
  assert.equal(result, 'still works');
});
