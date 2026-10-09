import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer } from '../src/router.js';
import { ScriptableTestProvider, jsonResponse } from '../src/providers/scriptable-test-provider.js';
import type { ModelSelectionPolicy } from '../src/model-selection.js';
import type { CapabilityRequest } from '../src/capability-types.js';
import type { EntityExtractionInput } from '../src/capabilities/entities.js';

const emptyEntitiesOutput = { entities: [] };

function makeRequest(text = 'Sample contract text'): CapabilityRequest<EntityExtractionInput> {
  return { input: {}, excerpt: { text, documentPath: 'contract.pdf', page: 1 }, traceId: 'trace-1' };
}

function singleProviderPolicy(providerId: string, model = 'test-model'): ModelSelectionPolicy {
  return { rules: [{ capability: '*', providerOrder: [providerId], modelByProvider: { [providerId]: model } }] };
}

const fastRetryOptions = { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} };

test('a successful call returns the parsed output and correct metadata', async () => {
  const provider = new ScriptableTestProvider('providerA', [{ kind: 'success', response: jsonResponse(emptyEntitiesOutput) }]);
  const layer = new AiCapabilityLayer({ providers: [provider], policy: singleProviderPolicy('providerA'), retryOptions: fastRetryOptions });
  const result = await layer.extractEntities(makeRequest());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.output, emptyEntitiesOutput);
  assert.equal(result.value.meta.providerUsed, 'providerA');
  assert.equal(result.value.meta.cacheHit, false);
  assert.equal(result.value.meta.attempts, 1);
});

test('falls back to the next provider when the primary fails every retry', async () => {
  const failing = new ScriptableTestProvider('primary', [
    { kind: 'failure', error: new Error('boom') },
    { kind: 'failure', error: new Error('boom') },
  ]);
  const backup = new ScriptableTestProvider('backup', [{ kind: 'success', response: jsonResponse(emptyEntitiesOutput) }]);
  const policy: ModelSelectionPolicy = { rules: [{ capability: '*', providerOrder: ['primary', 'backup'], modelByProvider: { primary: 'm1', backup: 'm2' } }] };
  const layer = new AiCapabilityLayer({ providers: [failing, backup], policy, retryOptions: fastRetryOptions });
  const result = await layer.extractEntities(makeRequest());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.meta.providerUsed, 'backup');
});

test('fails with AI_ALL_PROVIDERS_FAILED when every candidate is exhausted', async () => {
  const p1 = new ScriptableTestProvider('p1', [{ kind: 'failure', error: new Error('e1') }, { kind: 'failure', error: new Error('e1') }]);
  const p2 = new ScriptableTestProvider('p2', [{ kind: 'failure', error: new Error('e2') }, { kind: 'failure', error: new Error('e2') }]);
  const policy: ModelSelectionPolicy = { rules: [{ capability: '*', providerOrder: ['p1', 'p2'], modelByProvider: { p1: 'm1', p2: 'm2' } }] };
  const layer = new AiCapabilityLayer({ providers: [p1, p2], policy, retryOptions: fastRetryOptions });
  const result = await layer.extractEntities(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_AI_ALL_PROVIDERS_FAILED');
});

test('a malformed (non-JSON) provider response triggers a retry, then can still succeed', async () => {
  const provider = new ScriptableTestProvider('providerA', [
    { kind: 'success', response: { text: 'not json {{{', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'm', finishReason: 'stop' } },
    { kind: 'success', response: jsonResponse(emptyEntitiesOutput) },
  ]);
  const layer = new AiCapabilityLayer({ providers: [provider], policy: singleProviderPolicy('providerA'), retryOptions: fastRetryOptions });
  const result = await layer.extractEntities(makeRequest());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.meta.attempts, 2);
});

test('a response that fails schema validation is treated as a failure', async () => {
  const provider = new ScriptableTestProvider('providerA', [
    { kind: 'success', response: jsonResponse({ wrongShape: true }) },
    { kind: 'success', response: jsonResponse({ wrongShape: true }) },
  ]);
  const layer = new AiCapabilityLayer({ providers: [provider], policy: singleProviderPolicy('providerA'), retryOptions: fastRetryOptions });
  const result = await layer.extractEntities(makeRequest());
  assert.equal(result.ok, false);
});

test('an identical second call is served from cache without calling the provider again', async () => {
  const provider = new ScriptableTestProvider('providerA', [{ kind: 'success', response: jsonResponse(emptyEntitiesOutput) }]);
  const layer = new AiCapabilityLayer({ providers: [provider], policy: singleProviderPolicy('providerA'), retryOptions: fastRetryOptions });
  const request = makeRequest('identical text');
  const first = await layer.extractEntities(request);
  const second = await layer.extractEntities(request);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(second.value.meta.cacheHit, true);
  assert.equal(provider.callLog.length, 1);
});

test('a different excerpt is not served from another excerpt\'s cache entry', async () => {
  const provider = new ScriptableTestProvider('providerA', [
    { kind: 'success', response: jsonResponse(emptyEntitiesOutput) },
    { kind: 'success', response: jsonResponse(emptyEntitiesOutput) },
  ]);
  const layer = new AiCapabilityLayer({ providers: [provider], policy: singleProviderPolicy('providerA'), retryOptions: fastRetryOptions });
  await layer.extractEntities(makeRequest('text A'));
  await layer.extractEntities(makeRequest('text B'));
  assert.equal(provider.callLog.length, 2);
});

test('the circuit breaker opens after repeated failures and skips the provider on the next call', async () => {
  const failing = new ScriptableTestProvider('primary', Array.from({ length: 10 }, () => ({ kind: 'failure' as const, error: new Error('down') })));
  const backup = new ScriptableTestProvider('backup', [
    { kind: 'success', response: jsonResponse(emptyEntitiesOutput) },
    { kind: 'success', response: jsonResponse(emptyEntitiesOutput) },
  ]);
  const policy: ModelSelectionPolicy = { rules: [{ capability: '*', providerOrder: ['primary', 'backup'], modelByProvider: { primary: 'm1', backup: 'm2' } }] };
  const layer = new AiCapabilityLayer({
    providers: [failing, backup],
    policy,
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
    circuitBreakerOptions: { failureThreshold: 2, cooldownMs: 60_000 },
  });

  // Two calls with different excerpts (to avoid the cache) drive the primary's circuit breaker to open.
  await layer.extractEntities(makeRequest('call 1'));
  await layer.extractEntities(makeRequest('call 2'));
  const callsToPrimaryBeforeOpen = failing.callLog.length;
  assert.equal(callsToPrimaryBeforeOpen, 2);

  await layer.extractEntities(makeRequest('call 3'));
  // The circuit is now open, so the third call should not have reached the primary provider again.
  assert.equal(failing.callLog.length, callsToPrimaryBeforeOpen);
});

test('rate limiting skips a provider without calling it, falling back to the next candidate', async () => {
  const primary = new ScriptableTestProvider('primary', [{ kind: 'success', response: jsonResponse(emptyEntitiesOutput) }]);
  const backup = new ScriptableTestProvider('backup', [{ kind: 'success', response: jsonResponse(emptyEntitiesOutput) }]);
  const policy: ModelSelectionPolicy = { rules: [{ capability: '*', providerOrder: ['primary', 'backup'], modelByProvider: { primary: 'm1', backup: 'm2' } }] };
  const layer = new AiCapabilityLayer({
    providers: [primary, backup],
    policy,
    retryOptions: fastRetryOptions,
    rateLimiterOptionsByProvider: { primary: { capacity: 0, refillPerSecond: 0 } },
  });
  const result = await layer.extractEntities(makeRequest());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.meta.providerUsed, 'backup');
  assert.equal(primary.callLog.length, 0);
});

test('rate limiting every candidate results in AI_ALL_PROVIDERS_FAILED', async () => {
  const provider = new ScriptableTestProvider('providerA', [{ kind: 'success', response: jsonResponse(emptyEntitiesOutput) }]);
  const layer = new AiCapabilityLayer({
    providers: [provider],
    policy: singleProviderPolicy('providerA'),
    retryOptions: fastRetryOptions,
    rateLimiterOptions: { capacity: 0, refillPerSecond: 0 },
  });
  const result = await layer.extractEntities(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_AI_ALL_PROVIDERS_FAILED');
  assert.equal(provider.callLog.length, 0);
});

test('returns AI_NO_ELIGIBLE_PROVIDER when the policy has no matching rule', async () => {
  const layer = new AiCapabilityLayer({ providers: [], policy: { rules: [] } });
  const result = await layer.extractEntities(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_AI_NO_ELIGIBLE_PROVIDER');
});

test('totalCostUsd accumulates after a successful call', async () => {
  const layer = new AiCapabilityLayer({
    providers: [new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(emptyEntitiesOutput, { inputTokens: 1000, outputTokens: 1000 }, 'claude-sonnet-4-6') }])],
    policy: { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'claude-sonnet-4-6' } }] },
    retryOptions: fastRetryOptions,
  });
  assert.equal(layer.totalCostUsd(), 0);
  await layer.extractEntities(makeRequest());
  assert.ok(layer.totalCostUsd() > 0);
});

test('describeProviders reports every registered provider\'s capability descriptor', () => {
  const provider = new ScriptableTestProvider('providerA', []);
  const layer = new AiCapabilityLayer({ providers: [provider], policy: singleProviderPolicy('providerA') });
  const descriptors = layer.describeProviders();
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]!.providerId, 'providerA');
});
