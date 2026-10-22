import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer } from '../src/router.js';
import { GeminiProvider } from '../src/providers/gemini-provider.js';
import { singleProviderPolicy } from '../src/inference-config.js';
import type { CapabilityRequest } from '../src/capability-types.js';
import type { EntityExtractionInput } from '../src/capabilities/entities.js';
import { TEST_API_KEY, capturingLogger, errorBody, noSleep, okText, scriptedFetch, type Step } from './providers/gemini-helpers.js';

const MODEL = 'gemini-3.5-flash-lite';
const request = (text = 'ROUTER-EXCERPT-SENTINEL'): CapabilityRequest<EntityExtractionInput> => ({
  input: {},
  excerpt: { text, documentPath: 'a.pdf' },
  traceId: 'trace-gem-1',
});
const retry = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} };

function layerWith(steps: Step[], providerRetries = 0) {
  const f = scriptedFetch(steps);
  const log = capturingLogger();
  const provider = new GeminiProvider({
    apiKey: TEST_API_KEY,
    fetchImpl: f.fetchImpl,
    retry: { maxRetries: providerRetries, ...noSleep },
    logger: log.logger,
  });
  const layer = new AiCapabilityLayer({
    providers: [provider],
    policy: singleProviderPolicy('gemini', MODEL),
    retryOptions: retry,
    logger: log.logger,
  });
  return { layer, ...f, log };
}

// 16. existing AI-core consumers remain compatible ------------------------------
test('AiCapabilityLayer works end-to-end over the Gemini adapter and reports provider/model/usage', async () => {
  const { layer, calls } = layerWith([okText('{"entities":[]}', { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 })]);
  const res = await layer.extractEntities(request());
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.deepEqual(res.value.output, { entities: [] });
  assert.equal(res.value.meta.providerUsed, 'gemini');
  assert.equal(res.value.meta.modelUsed, MODEL);
  assert.deepEqual(res.value.meta.usage, { inputTokens: 7, outputTokens: 3 });
  assert.equal(res.value.meta.usageKnown, undefined);
  assert.equal((calls[0]!.body['generationConfig'] as Record<string, unknown>)['responseMimeType'], 'application/json');
});

test('unknown usage is surfaced in capability metadata rather than disguised as zero', async () => {
  const { layer } = layerWith([okText('{"entities":[]}', null)]);
  const res = await layer.extractEntities(request());
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.value.meta.usageKnown, false);
});

test('auth / invalid / blocked failures are NOT retried by the router (one network call each)', async () => {
  for (const step of [
    errorBody(401, 'UNAUTHENTICATED', 'bad'),
    errorBody(400, 'INVALID_ARGUMENT', 'bad'),
    errorBody(404, 'NOT_FOUND', 'm'),
    okText('x', undefined, 'SAFETY'),
  ]) {
    const { layer, calls } = layerWith([step]);
    const res = await layer.extractEntities(request());
    assert.equal(res.ok, false);
    assert.equal(calls.length, 1);
  }
});

test('transient failures are retried only by the adapter (bounded), never multiplied by the router', async () => {
  const { layer, calls } = layerWith([errorBody(503, 'UNAVAILABLE', 'busy')], 2);
  assert.equal((await layer.extractEntities(request())).ok, false);
  assert.equal(calls.length, 3, 'adapter: 1 + 2 retries; router adds none');
});

test('a malformed/schema-invalid body is retried (a fresh sample may succeed)', async () => {
  const { layer, calls } = layerWith([okText('{"entities":"wrong"}'), okText('{"entities":[]}')]);
  const res = await layer.extractEntities(request());
  assert.ok(res.ok);
  assert.equal(calls.length, 2);
});

test('no silent fallback: with Gemini as the only provider, failure is a failure', async () => {
  const { layer } = layerWith([errorBody(429, 'RESOURCE_EXHAUSTED', 'slow')]);
  const res = await layer.extractEntities(request());
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'XO_AI_ALL_PROVIDERS_FAILED');
});

test('router + adapter logs never contain excerpt text, prompts or the key', async () => {
  const { layer, log } = layerWith([errorBody(400, 'INVALID_ARGUMENT', `echo ${TEST_API_KEY}`), okText('x')]);
  await layer.extractEntities(request());
  const dump = JSON.stringify(log.records);
  assert.ok(!dump.includes('ROUTER-EXCERPT-SENTINEL'));
  assert.ok(!dump.includes(TEST_API_KEY));
});

test('the trace id is propagated as the request id for correlation', async () => {
  const { layer, log } = layerWith([okText('{"entities":[]}')]);
  await layer.extractEntities(request());
  assert.equal(log.records.find((r) => r.message === 'inference.request.completed')?.fields['requestId'], 'trace-gem-1');
});
