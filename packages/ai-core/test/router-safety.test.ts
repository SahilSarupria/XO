import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiError, ErrorCode } from '@xo/errors';
import { AiCapabilityLayer } from '../src/router.js';
import { ScriptableTestProvider, jsonResponse, type ScriptedOutcome } from '../src/providers/scriptable-test-provider.js';
import { providerFailure } from '../src/provider-errors.js';
import { CircuitBreaker } from '../src/circuit-breaker.js';
import { InferenceGuard } from '../src/inference-policy.js';
import { singleProviderPolicy } from '../src/inference-config.js';
import { CACHE_FORMAT_VERSION, computeCacheKey, computeSchemaHash, type CapabilityCache } from '../src/cache.js';
import { CAPABILITY_OUTPUT_SCHEMAS } from '../src/capability-schemas.js';
import { createDefaultPromptRegistry } from '../src/prompt/index.js';
import type { ModelSelectionPolicy } from '../src/model-selection.js';
import type { CapabilityRequest } from '../src/capability-types.js';
import type { EntityExtractionInput } from '../src/capabilities/entities.js';
import type { ProviderResponse } from '../src/provider-types.js';
import { GeminiProvider } from '../src/providers/gemini-provider.js';
import { TEST_API_KEY, capturingLogger, okText, scriptedFetch, noSleep } from './providers/gemini-helpers.js';

const EMPTY = { entities: [] };
const MODEL = 'claude-sonnet-4-6'; // priced in the default table, so billed-but-discarded attempts are visible in cost
const request = (text = 'Sample contract text'): CapabilityRequest<EntityExtractionInput> => ({
  input: {},
  excerpt: { text, documentPath: 'contract.pdf', page: 1 },
  traceId: 'trace-safety',
});
const noRetry = { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} };
const threeAttempts = { ...noRetry, maxAttempts: 3 };

const withFinish = (
  finishReason: ProviderResponse['finishReason'],
  value: unknown = EMPTY,
  usage = { inputTokens: 100, outputTokens: 50 },
): ScriptedOutcome => ({
  kind: 'success',
  response: { ...jsonResponse(value, usage, MODEL), finishReason },
});
const ok = (): ScriptedOutcome => ({ kind: 'success', response: jsonResponse(EMPTY, { inputTokens: 100, outputTokens: 50 }, MODEL) });
const fail = (error: unknown): ScriptedOutcome => ({ kind: 'failure', error });
const pf = (category: Parameters<typeof providerFailure>[0]): ScriptedOutcome =>
  fail(providerFailure(category, 'anthropic', `scripted ${category}`, { model: MODEL }));

function layerFor(script: ScriptedOutcome[], extra: Partial<ConstructorParameters<typeof AiCapabilityLayer>[0]> = {}) {
  const provider = new ScriptableTestProvider('anthropic', script);
  const log = capturingLogger();
  const layer = new AiCapabilityLayer({
    providers: [provider],
    policy: singleProviderPolicy('anthropic', MODEL),
    retryOptions: noRetry,
    logger: log.logger,
    ...extra,
  });
  return { layer, provider, log };
}

const breakerState = (layer: AiCapabilityLayer): string | undefined =>
  (layer as unknown as { circuitBreakers: Map<string, CircuitBreaker> }).circuitBreakers.get('anthropic')?.getState();

const loggedFailures = (log: ReturnType<typeof capturingLogger>): string[] =>
  log.records.filter((r) => r.message === 'ai_core provider attempt failed, trying next candidate').map((r) => String(r.fields['error']));

// 3. finishReason guard -------------------------------------------------------------------------
test("finishReason 'length' is rejected even when the body is valid-looking JSON, and is not retried", async () => {
  const { layer, provider, log } = layerFor([withFinish('length', EMPTY), ok()], { retryOptions: threeAttempts });
  const res = await layer.extractEntities(request());
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, ErrorCode.AI_ALL_PROVIDERS_FAILED);
  assert.equal(
    provider.callLog.length,
    1,
    'a truncated answer is deterministic: never retried, never "fixed" by the next scripted success',
  );
  assert.match(loggedFailures(log)[0]!, /output-token limit/);
});

test("finishReason 'content_filter' is rejected as content_blocked even with valid-looking JSON, and is not retried", async () => {
  const { layer, provider, log } = layerFor([withFinish('content_filter', EMPTY), ok()], { retryOptions: threeAttempts });
  const res = await layer.extractEntities(request());
  assert.equal(res.ok, false);
  assert.equal(provider.callLog.length, 1);
  assert.match(loggedFailures(log)[0]!, /filtered the output/);
});

test("finishReason 'error' is treated as transient and retried exactly once", async () => {
  const recovered = layerFor([withFinish('error'), ok()], { retryOptions: threeAttempts });
  const res = await recovered.layer.extractEntities(request());
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.value.meta.attempts, 2);
  assert.equal(recovered.provider.callLog.length, 2);

  const persistent = layerFor([withFinish('error'), withFinish('error'), ok()], { retryOptions: threeAttempts });
  const res2 = await persistent.layer.extractEntities(request());
  assert.equal(res2.ok, false);
  assert.equal(persistent.provider.callLog.length, 2, 'one retry only: the third scripted success is never reached');
});

test("finishReason 'stop' with valid JSON is accepted (the guard is not over-eager)", async () => {
  const { layer, provider } = layerFor([withFinish('stop')]);
  const res = await layer.extractEntities(request());
  assert.ok(res.ok);
  assert.equal(provider.callLog.length, 1);
});

test('a malformed (non-JSON) body is still retried as before — only deterministic finish reasons are exempt', async () => {
  const bad: ScriptedOutcome = {
    kind: 'success',
    response: { text: 'not json', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: MODEL, finishReason: 'stop' },
  };
  const { layer, provider } = layerFor([bad, ok()], { retryOptions: threeAttempts });
  assert.ok((await layer.extractEntities(request())).ok);
  assert.equal(provider.callLog.length, 2);
});

// billed-but-discarded attempts -------------------------------------------------------------------
test('a discarded (length / content_filter / error) attempt is still charged against the InferenceRunScope and the cost total', async () => {
  for (const finish of ['length', 'content_filter', 'error'] as const) {
    const scope = new InferenceGuard({ enabled: true, allowUndeclared: false, maxTotalTokens: 1_000_000 }).beginRun();
    const { layer } = layerFor([withFinish(finish, EMPTY, { inputTokens: 1000, outputTokens: 500 })], { inferenceScope: scope });
    assert.equal((await layer.extractEntities(request())).ok, false, finish);
    assert.equal(scope.snapshot().tokensSpent, 1500, `${finish}: settled with the real usage`);
    assert.ok(layer.totalCostUsd() > 0, `${finish}: the billed attempt is reflected in total cost`);
  }
});

// 4. circuit breaker ----------------------------------------------------------------------------
test('breaker is tripped by repeated transient provider failures', async () => {
  const { layer, provider } = layerFor([pf('transient')], { circuitBreakerOptions: { failureThreshold: 2, cooldownMs: 60_000 } });
  for (let i = 0; i < 4; i += 1) await layer.extractEntities(request());
  assert.equal(provider.callLog.length, 2, 'after 2 transient failures the circuit is open: no further provider calls');
  assert.equal(breakerState(layer), 'open');
});

test('breaker is tripped by timeout, rate_limited and unclassified errors', async () => {
  for (const outcome of [pf('timeout'), pf('rate_limited'), fail(new TypeError('boom'))]) {
    const { layer, provider } = layerFor([outcome], { circuitBreakerOptions: { failureThreshold: 2, cooldownMs: 60_000 } });
    for (let i = 0; i < 4; i += 1) await layer.extractEntities(request());
    assert.equal(provider.callLog.length, 2);
    assert.equal(breakerState(layer), 'open');
  }
});

test('breaker is NOT affected by auth, invalid_request, quota, unsupported_*, content_blocked, aborted, malformed or truncation', async () => {
  const neutral: ScriptedOutcome[] = [
    pf('authentication'),
    pf('permission_denied'),
    pf('invalid_request'),
    pf('quota_exhausted'),
    pf('unsupported_model'),
    pf('unsupported_feature'),
    pf('content_blocked'),
    pf('aborted'),
    pf('malformed_response'),
    pf('empty_response'),
    pf('output_truncated'),
    withFinish('length'),
    withFinish('content_filter'),
  ];
  for (const outcome of neutral) {
    const { layer, provider } = layerFor([outcome], { circuitBreakerOptions: { failureThreshold: 2, cooldownMs: 60_000 } });
    for (let i = 0; i < 4; i += 1) await layer.extractEntities(request());
    assert.equal(
      provider.callLog.length,
      4,
      `every request must still reach the provider (${outcome.kind === 'failure' ? String((outcome.error as Error).message) : 'finish guard'})`,
    );
    assert.equal(breakerState(layer), 'closed');
  }
});

test('breaker is NOT affected by schema-validation failures', async () => {
  const wrongShape: ScriptedOutcome = {
    kind: 'success',
    response: jsonResponse({ entities: 'wrong' }, { inputTokens: 1, outputTokens: 1 }, MODEL),
  };
  const { layer, provider } = layerFor([wrongShape], {
    circuitBreakerOptions: { failureThreshold: 2, cooldownMs: 60_000 },
    retryOptions: { ...noRetry, maxAttempts: 2 },
  });
  for (let i = 0; i < 3; i += 1) assert.equal((await layer.extractEntities(request())).ok, false);
  assert.equal(provider.callLog.length, 6, '3 requests x 2 attempts, none refused by an open circuit');
  assert.equal(breakerState(layer), 'closed');
});

test('breaker is NOT affected by inference denials', async () => {
  // The first call fits the budget; its real usage then exhausts it, so the second call is denied before any provider call.
  const scope = new InferenceGuard({ enabled: true, allowUndeclared: false, maxTotalTokens: 6000 }).beginRun();
  const { layer, provider } = layerFor(
    [{ kind: 'success', response: jsonResponse(EMPTY, { inputTokens: 6000, outputTokens: 0 }, MODEL) }],
    {
      inferenceScope: scope,
      circuitBreakerOptions: { failureThreshold: 1, cooldownMs: 60_000 },
      cache: { get: () => undefined, set: () => undefined } as CapabilityCache,
    },
  );
  assert.ok((await layer.extractEntities(request())).ok);
  const denied = await layer.extractEntities(request());
  assert.equal(denied.ok, false);
  assert.equal(provider.callLog.length, 1);
  assert.ok(Object.keys(layer.inferenceReport().denials).length > 0, 'the second call was denied by the budget');
  assert.equal(breakerState(layer), 'closed');
});

test('CircuitBreaker default behaviour is unchanged: with no predicate every error counts', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
  for (let i = 0; i < 2; i += 1) await assert.rejects(cb.execute(async () => Promise.reject(new Error('x'))));
  assert.equal(cb.getState(), 'open');
});

test('CircuitBreaker with isFailure=false leaves state untouched (no count, no reset, no success)', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, isFailure: (e) => !(e instanceof RangeError) });
  await assert.rejects(cb.execute(async () => Promise.reject(new Error('counted'))));
  await assert.rejects(cb.execute(async () => Promise.reject(new RangeError('ignored'))));
  assert.equal(cb.getState(), 'closed');
  await assert.rejects(cb.execute(async () => Promise.reject(new Error('counted'))));
  assert.equal(cb.getState(), 'open', 'the ignored error neither reset nor advanced the consecutive-failure count');
});

// 5. fallback control ------------------------------------------------------------------------------
const twoProviderPolicy = (allowFallback?: boolean): ModelSelectionPolicy => ({
  rules: [{ capability: '*', providerOrder: ['primary', 'backup'], modelByProvider: { primary: 'm1', backup: 'm2' } }],
  ...(allowFallback !== undefined ? { allowFallback } : {}),
});

test('allowFallback:false → only the first eligible candidate is used; failure is AI_ALL_PROVIDERS_FAILED and the backup is never called', async () => {
  const primary = new ScriptableTestProvider('primary', [pf('transient')]);
  const backup = new ScriptableTestProvider('backup', [ok()]);
  const layer = new AiCapabilityLayer({ providers: [primary, backup], policy: twoProviderPolicy(false), retryOptions: noRetry });
  const res = await layer.extractEntities(request());
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, ErrorCode.AI_ALL_PROVIDERS_FAILED);
  assert.equal(primary.callLog.length, 1);
  assert.equal(backup.callLog.length, 0, 'no failover to another provider');
});

test('allowFallback omitted or true keeps the existing failover behaviour', async () => {
  for (const allow of [undefined, true]) {
    const primary = new ScriptableTestProvider('primary', [pf('transient')]);
    const backup = new ScriptableTestProvider('backup', [ok()]);
    const layer = new AiCapabilityLayer({ providers: [primary, backup], policy: twoProviderPolicy(allow), retryOptions: noRetry });
    const res = await layer.extractEntities(request());
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.value.meta.providerUsed, 'backup');
  }
});

test('singleProviderPolicy sets allowFallback false explicitly', () => {
  assert.equal(singleProviderPolicy('gemini', 'gemini-3.5-flash-lite').allowFallback, false);
});

test('the cache identity follows the effective candidate list (fallback chain vs pinned)', async () => {
  const keysFor = async (allow: boolean | undefined): Promise<string> => {
    const seen: string[] = [];
    const cache: CapabilityCache = { get: () => undefined, set: (k: string) => void seen.push(k) };
    const primary = new ScriptableTestProvider('primary', [ok()]);
    const backup = new ScriptableTestProvider('backup', [ok()]);
    await new AiCapabilityLayer({
      providers: [primary, backup],
      policy: twoProviderPolicy(allow),
      retryOptions: noRetry,
      cache,
    }).extractEntities(request());
    return seen[0]!;
  };
  assert.notEqual(await keysFor(false), await keysFor(undefined));
});

// 6. temperature pin + cache identity ------------------------------------------------------------------
test('temperature 0 is sent on every provider call (first attempt, retry and fallback)', async () => {
  const bad: ScriptedOutcome = {
    kind: 'success',
    response: { text: 'not json', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'm1', finishReason: 'stop' },
  };
  const primary = new ScriptableTestProvider('primary', [bad, pf('transient')]);
  const backup = new ScriptableTestProvider('backup', [ok()]);
  const layer = new AiCapabilityLayer({
    providers: [primary, backup],
    policy: twoProviderPolicy(),
    retryOptions: { ...noRetry, maxAttempts: 2 },
  });
  assert.ok((await layer.extractEntities(request())).ok);
  const all = [...primary.callLog, ...backup.callLog];
  assert.ok(all.length >= 3);
  for (const call of all) assert.strictEqual(call.temperature, 0);
});

test('the cache key includes the format version and the pinned temperature (a format bump invalidates old entries)', async () => {
  assert.equal(CACHE_FORMAT_VERSION, 3);
  const seen: string[] = [];
  const cache: CapabilityCache = { get: () => undefined, set: (k: string) => void seen.push(k) };
  const { layer } = layerFor([ok()], { cache });
  await layer.extractEntities(request());

  const schema = CAPABILITY_OUTPUT_SCHEMAS['extractEntities'];
  const base = {
    capability: 'extractEntities' as const,
    promptVersion: createDefaultPromptRegistry().resolve<EntityExtractionInput>('extractEntities').version,
    input: {},
    excerptText: 'Sample contract text',
    modelIdentity: [`anthropic/${MODEL}`],
    schemaHash: computeSchemaHash(schema),
  };
  const expected = computeCacheKey({ ...base, generation: { maxOutputTokens: 4096, temperature: 0 }, formatVersion: CACHE_FORMAT_VERSION });
  assert.equal(seen[0], expected, 'router key is exactly the documented identity');
  assert.notEqual(
    seen[0],
    computeCacheKey({ ...base, generation: { maxOutputTokens: 4096, temperature: 0 }, formatVersion: 2 }),
    'v2 keys no longer match',
  );
  assert.notEqual(
    seen[0],
    computeCacheKey({ ...base, generation: { maxOutputTokens: 4096 }, formatVersion: CACHE_FORMAT_VERSION }),
    'temperature is part of identity',
  );
});

// Gemini through the router -------------------------------------------------------------------
test('Gemini MAX_TOKENS with parseable JSON is now rejected by the router guard (adapter unchanged); SAFETY is still thrown by the adapter', async () => {
  const run = async (finishReason: string) => {
    const f = scriptedFetch([
      okText('{"entities":[]}', { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }, finishReason),
    ]);
    const provider = new GeminiProvider({ apiKey: TEST_API_KEY, fetchImpl: f.fetchImpl, retry: { maxRetries: 0, ...noSleep } });
    const layer = new AiCapabilityLayer({
      providers: [provider],
      policy: singleProviderPolicy('gemini', 'gemini-3.5-flash-lite'),
      retryOptions: threeAttempts,
    });
    return {
      res: await layer.extractEntities(request()),
      calls: f.calls.length,
      temperature: (f.calls[0]!.body['generationConfig'] as Record<string, unknown>)['temperature'],
    };
  };
  const length = await run('MAX_TOKENS');
  assert.equal(length.res.ok, false);
  assert.equal(length.calls, 1, 'not retried');
  assert.strictEqual(length.temperature, 0, 'the Gemini adapter forwards the pinned temperature');
  const safety = await run('SAFETY');
  assert.equal(safety.res.ok, false);
  assert.equal(safety.calls, 1);
  const stop = await run('STOP');
  assert.ok(stop.res.ok);
});

// sanity: AiError import is used for typing the failure code above
void AiError;
