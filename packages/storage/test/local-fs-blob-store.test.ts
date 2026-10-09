import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOk, isErr } from '@xo/types';
import { LocalFsBlobStore } from '../src/local-fs-blob-store.js';

async function withTempStore(fn: (store: LocalFsBlobStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-storage-test-'));
  try {
    await fn(new LocalFsBlobStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('put then get round-trips bytes', async () => {
  await withTempStore(async (store) => {
    const putResult = await store.put('manifest.json', '{"a":1}');
    assert.ok(isOk(putResult));
    const getResult = await store.get('manifest.json');
    assert.ok(isOk(getResult));
    if (isOk(getResult)) assert.equal(Buffer.from(getResult.value).toString('utf8'), '{"a":1}');
  });
});

test('put creates nested directories as needed', async () => {
  await withTempStore(async (store) => {
    const result = await store.put('knowledge/graph.json', '{}');
    assert.ok(isOk(result));
    assert.equal(await store.has('knowledge/graph.json'), true);
  });
});

test('get on a missing key returns an err Result', async () => {
  await withTempStore(async (store) => {
    const result = await store.get('does/not/exist.json');
    assert.ok(isErr(result));
  });
});

test('delete removes a blob', async () => {
  await withTempStore(async (store) => {
    await store.put('a.txt', 'x');
    assert.equal(await store.has('a.txt'), true);
    const del = await store.delete('a.txt');
    assert.ok(isOk(del));
    assert.equal(await store.has('a.txt'), false);
  });
});

test('list returns all keys under a prefix', async () => {
  await withTempStore(async (store) => {
    await store.put('reasoning/decision_trees.json', '{}');
    await store.put('reasoning/case_library.json', '{}');
    await store.put('safety/rules.json', '{}');
    const result = await store.list('reasoning');
    assert.ok(isOk(result));
    if (isOk(result)) {
      assert.equal(result.value.length, 2);
      assert.ok(result.value.every((k) => k.startsWith('reasoning/')));
    }
  });
});

test('a key that attempts path traversal is rejected', async () => {
  await withTempStore(async (store) => {
    const result = await store.put('../escape.txt', 'x');
    assert.ok(isErr(result));
  });
});
