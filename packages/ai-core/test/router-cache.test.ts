import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiCapabilityLayer } from '../src/router.js';
import { FileCapabilityCache } from '../src/file-cache.js';
import { InMemoryCapabilityCache, type CapabilityCache } from '../src/cache.js';
import { singleProviderPolicy } from '../src/inference-config.js';
import { GeminiProvider } from '../src/providers/gemini-provider.js';
import type { CapabilityRequest } from '../src/capability-types.js';
import type { EntityExtractionInput } from '../src/capabilities/entities.js';
import { TEST_API_KEY, errorBody, noSleep, okText, scriptedFetch, type Step } from './providers/gemini-helpers.js';

const MODEL = 'gemini-3.5-flash-lite';
const retry = { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} };
const request = (text = 'same excerpt', traceId = 't1'): CapabilityRequest<EntityExtractionInput> => ({
  input: {},
  excerpt: { text, documentPath: 'a.pdf' },
  traceId,
});
const GOOD = '{"entities":[]}';

function build(steps: Step[], cache: CapabilityCache, model = MODEL) {
  const f = scriptedFetch(steps);
  const provider = new GeminiProvider({ apiKey: TEST_API_KEY, fetchImpl: f.fetchImpl, retry: { maxRetries: 0, ...noSleep } });
  const layer = new AiCapabilityLayer({ providers: [provider], policy: singleProviderPolicy('gemini', model), retryOptions: retry, cache });
  return { layer, ...f };
}

test('second identical request is served from cache with ZERO provider calls and zero spend', async () => {
  const { layer, calls } = build(
    [okText(GOOD, { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 })],
    new InMemoryCapabilityCache(),
  );
  const first = await layer.extractEntities(request());
  const second = await layer.extractEntities(request('same excerpt', 't2'));
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(calls.length, 1);
  assert.equal(first.value.meta.cacheHit, false);
  assert.equal(first.value.meta.provenance?.source, 'generated');
  assert.equal(second.value.meta.cacheHit, true);
  assert.equal(second.value.meta.provenance?.source, 'cache');
  assert.deepEqual(second.value.meta.usage, { inputTokens: 0, outputTokens: 0 });
  assert.equal(second.value.meta.costUsd, 0);
  assert.equal(second.value.meta.attempts, 0);
  // The ORIGINAL generation is preserved and not misrepresented as new.
  const g = second.value.meta.provenance!.generation;
  assert.equal(g.traceId, 't1');
  assert.deepEqual(g.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(g.providerUsed, 'gemini');
  assert.equal(second.value.meta.provenance?.origin, 'llm');
});

test('reuse works across a "process restart": a brand-new layer + cache instance on the same directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-rc-'));
  try {
    const a = build([okText(GOOD)], new FileCapabilityCache({ directory: dir, secrets: [TEST_API_KEY] }));
    assert.ok((await a.layer.extractEntities(request())).ok);
    assert.equal(a.calls.length, 1);

    const b = build([errorBody(500, 'INTERNAL', 'must not be called')], new FileCapabilityCache({ directory: dir }));
    const res = await b.layer.extractEntities(request());
    assert.ok(res.ok);
    assert.equal(b.calls.length, 0, 'no provider call after restart');
    if (res.ok) assert.equal(res.value.meta.provenance?.source, 'cache');

    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const contents = await readFile(join(dir, files[0]!), 'utf8');
    assert.ok(!contents.includes(TEST_API_KEY) && !contents.includes('same excerpt'), 'no secret and no source text in the cache file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a different model, input, or excerpt is a miss (no stale cross-model answers)', async () => {
  const cache = new InMemoryCapabilityCache();
  const a = build([okText(GOOD)], cache);
  await a.layer.extractEntities(request());
  const otherModel = build([okText(GOOD)], cache, 'gemini-3.8-flash');
  await otherModel.layer.extractEntities(request());
  assert.equal(otherModel.calls.length, 1, 'model identity is part of the key');
  const otherExcerpt = build([okText(GOOD)], cache);
  await otherExcerpt.layer.extractEntities(request('different'));
  assert.equal(otherExcerpt.calls.length, 1);
});

test('failures and schema-invalid outputs are never cached', async () => {
  const cache = new InMemoryCapabilityCache();
  const bad = build([errorBody(400, 'INVALID_ARGUMENT', 'x'), okText('{"entities":"wrong"}')], cache);
  assert.equal((await bad.layer.extractEntities(request())).ok, false);
  assert.equal((await bad.layer.extractEntities(request())).ok, false);
  const good = build([okText(GOOD)], cache);
  assert.ok((await good.layer.extractEntities(request())).ok);
  assert.equal(good.calls.length, 1, 'earlier failures left nothing behind');
});

test('a corrupt or schema-invalid cache entry is revalidated as a miss and regenerated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-rc-'));
  try {
    const seed = build([okText(GOOD)], new FileCapabilityCache({ directory: dir }));
    await seed.layer.extractEntities(request());
    const file = join(dir, (await readdir(dir))[0]!);

    await writeFile(file, 'garbage');
    const afterCorrupt = build([okText(GOOD)], new FileCapabilityCache({ directory: dir }));
    assert.ok((await afterCorrupt.layer.extractEntities(request())).ok);
    assert.equal(afterCorrupt.calls.length, 1);

    // Tamper: valid envelope, output no longer matches the schema.
    const env = JSON.parse(await readFile(file, 'utf8')) as { value: { output: unknown } };
    env.value.output = { entities: 'tampered' };
    await writeFile(file, JSON.stringify(env));
    const afterTamper = build([okText(GOOD)], new FileCapabilityCache({ directory: dir }));
    const res = await afterTamper.layer.extractEntities(request());
    assert.ok(res.ok);
    assert.equal(afterTamper.calls.length, 1);
    if (res.ok) assert.deepEqual(res.value.output, { entities: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a throwing cache backend never fails the request (read or write)', async () => {
  const exploding: CapabilityCache = {
    get: () => {
      throw new Error('disk on fire');
    },
    set: async () => {
      throw new Error('disk on fire');
    },
  };
  const { layer, calls } = build([okText(GOOD)], exploding);
  assert.ok((await layer.extractEntities(request())).ok);
  assert.equal(calls.length, 1);
});

test('explicit invalidation forces regeneration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-rc-'));
  try {
    const cache = new FileCapabilityCache({ directory: dir });
    const a = build([okText(GOOD)], cache);
    await a.layer.extractEntities(request());
    assert.equal(await cache.clear(), 1);
    const b = build([okText(GOOD)], cache);
    await b.layer.extractEntities(request());
    assert.equal(b.calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
