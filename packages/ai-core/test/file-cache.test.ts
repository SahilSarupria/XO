import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeCacheKey, computeSchemaHash } from '../src/cache.js';
import { FileCapabilityCache } from '../src/file-cache.js';
import type { Clock } from '../src/clock.js';
import { TEST_API_KEY } from './providers/gemini-helpers.js';

const KEY = computeCacheKey({ capability: 'extractEntities', promptVersion: 'v1', input: {}, excerptText: 'x' });
const FILE = `${KEY.replace('sha256:', '')}.json`;
const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'xo-cache-'));

class FakeClock implements Clock {
  ms = 1000;
  now(): number {
    return this.ms;
  }
}

test('entries survive a new cache instance (process restart) and report storedAtMs', async () => {
  const dir = await tmp();
  try {
    await new FileCapabilityCache({ directory: dir }).set(KEY, { answer: 42 });
    const entry = await new FileCapabilityCache({ directory: dir }).get<{ answer: number }>(KEY);
    assert.deepEqual(entry?.value, { answer: 42 });
    assert.equal(typeof entry?.storedAtMs, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('files are private (0600) in a private directory (0700) and writes leave no temp files', async () => {
  const dir = join(await tmp(), 'nested');
  try {
    const cache = new FileCapabilityCache({ directory: dir });
    await cache.set(KEY, { a: 1 });
    assert.equal((await stat(join(dir, FILE))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(dir), [FILE]);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('corrupt, truncated, mismatched or wrong-version entries are misses, never errors', async () => {
  const dir = await tmp();
  try {
    const cache = new FileCapabilityCache({ directory: dir });
    await cache.set(KEY, { a: 1 });
    const file = join(dir, FILE);
    for (const bad of [
      '{"formatVersion":2,"key":"' + KEY,
      'not json',
      '{}',
      JSON.stringify({ formatVersion: 1, key: KEY, storedAtMs: 1, value: 1 }),
      JSON.stringify({ formatVersion: 2, key: `sha256:${'f'.repeat(64)}`, storedAtMs: 1, value: 1 }),
    ]) {
      await writeFile(file, bad);
      assert.equal(await cache.get(KEY), undefined, bad.slice(0, 30));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-digest keys are rejected (no path traversal) on every operation', async () => {
  const dir = await tmp();
  try {
    const cache = new FileCapabilityCache({ directory: dir });
    for (const bad of ['../../etc/passwd', '..', 'a/b', '', 'ZZ'.repeat(20)]) {
      await cache.set(bad, { a: 1 });
      assert.equal(await cache.get(bad), undefined);
      assert.equal(await cache.invalidate(bad), false);
    }
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('values containing a configured secret or a Google-key-shaped string are never written', async () => {
  const dir = await tmp();
  try {
    const cache = new FileCapabilityCache({ directory: dir, secrets: [TEST_API_KEY] });
    await cache.set(KEY, { leaked: `key=${TEST_API_KEY}` });
    assert.equal(await cache.get(KEY), undefined);
    const other = computeCacheKey({ capability: 'extractEntities', promptVersion: 'v1', input: {}, excerptText: 'y' });
    await cache.set(other, { leaked: 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ' });
    assert.equal(await cache.get(other), undefined);
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ttl expiry is a miss; invalidate and clear are explicit and only touch cache entries', async () => {
  const dir = await tmp();
  try {
    const clock = new FakeClock();
    const cache = new FileCapabilityCache({ directory: dir, ttlMs: 100, clock });
    await cache.set(KEY, { a: 1 });
    clock.ms += 50;
    assert.ok(await cache.get(KEY));
    clock.ms += 100;
    assert.equal(await cache.get(KEY), undefined);

    const fresh = new FileCapabilityCache({ directory: dir });
    const k2 = computeCacheKey({ capability: 'extractEntities', promptVersion: 'v1', input: {}, excerptText: 'k2' });
    await fresh.set(KEY, { a: 1 });
    await fresh.set(k2, { a: 2 });
    await writeFile(join(dir, 'README.txt'), 'not mine');
    assert.equal(await fresh.invalidate(KEY), true);
    assert.equal(await fresh.invalidate(KEY), false);
    assert.equal(await fresh.clear(), 1);
    assert.equal(await readFile(join(dir, 'README.txt'), 'utf8'), 'not mine');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an uncreatable directory degrades to "no cache" instead of throwing', async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, 'a-file'), 'x');
    const cache = new FileCapabilityCache({ directory: join(dir, 'a-file', 'sub') }); // a path beneath a regular file can never be created
    await cache.set(KEY, { a: 1 });
    assert.equal(await cache.get(KEY), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent writers to one key never produce a torn entry', async () => {
  const dir = await tmp();
  try {
    const caches = [new FileCapabilityCache({ directory: dir }), new FileCapabilityCache({ directory: dir })];
    await Promise.all(Array.from({ length: 40 }, (_, i) => caches[i % 2]!.set(KEY, { n: i, pad: 'x'.repeat(5000) })));
    const entry = await caches[0]!.get<{ n: number; pad: string }>(KEY);
    assert.ok(entry && entry.value.pad.length === 5000);
    assert.deepEqual(
      (await readdir(dir)).filter((n) => n.endsWith('.tmp')),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// key identity ------------------------------------------------------------------
test('cache keys change with input, excerpt, prompt version, model identity, schema, generation and format version', () => {
  const base = {
    capability: 'extractEntities' as const,
    promptVersion: 'v1',
    input: { a: 1 },
    excerptText: 'x',
    modelIdentity: ['gemini/gemini-3.5-flash-lite'],
    schemaHash: computeSchemaHash({ type: 'object' }),
    generation: { maxOutputTokens: 4096 },
    formatVersion: 2,
  };
  const k = computeCacheKey(base);
  const variants = [
    { ...base, input: { a: 2 } },
    { ...base, excerptText: 'y' },
    { ...base, promptVersion: 'v2' },
    { ...base, modelIdentity: ['gemini/gemini-3.8-flash'] },
    { ...base, modelIdentity: ['openai/gpt-4o', 'gemini/gemini-3.5-flash-lite'] },
    { ...base, schemaHash: computeSchemaHash({ type: 'array' }) },
    { ...base, generation: { maxOutputTokens: 2048 } },
    { ...base, generation: { maxOutputTokens: 4096, temperature: 0.5 } },
    { ...base, formatVersion: 3 },
  ];
  const keys = new Set([k, ...variants.map((v) => computeCacheKey(v))]);
  assert.equal(keys.size, variants.length + 1);
  assert.equal(computeCacheKey({ ...base }), k, 'stable');
});

test('adding optional identity fields does not disturb legacy keys', () => {
  const legacy = { capability: 'extractEntities' as const, promptVersion: 'v1', input: {}, excerptText: 'x' };
  assert.equal(computeCacheKey(legacy), computeCacheKey({ ...legacy, modelIdentity: undefined, schemaHash: undefined }));
});
