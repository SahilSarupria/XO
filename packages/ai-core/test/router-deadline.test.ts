import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, ErrorCode } from '@xo/errors';
import { AiCapabilityLayer } from '../src/router.js';
import { ScriptableTestProvider, jsonResponse, type ScriptedOutcome } from '../src/providers/scriptable-test-provider.js';
import { providerFailure } from '../src/provider-errors.js';
import { InferenceGuard } from '../src/inference-policy.js';
import { getCallCancellation } from '../src/call-scope.js';
import { singleProviderPolicy } from '../src/inference-config.js';
import type { CapabilityCache } from '../src/cache.js';
import type { ModelSelectionPolicy } from '../src/model-selection.js';
import type { CapabilityRequest } from '../src/capability-types.js';
import type { EntityExtractionInput } from '../src/capabilities/entities.js';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderRequest, ProviderResponse } from '../src/provider-types.js';
import type { CircuitBreaker } from '../src/circuit-breaker.js';

const EMPTY = { entities: [] };
const MODEL = 'claude-sonnet-4-6';
const request = (extra: Partial<CapabilityRequest<EntityExtractionInput>> = {}): CapabilityRequest<EntityExtractionInput> => ({
  input: {},
  excerpt: { text: 'Sample contract text', documentPath: 'contract.pdf', page: 1 },
  traceId: 'trace-deadline',
  ...extra,
});
const flush = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const instantRetry = { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 };

/** A provider whose calls stay pending until the test settles them. It records every request and whether it saw an abort. */
class ControlledProvider implements ModelProvider {
  readonly calls: ProviderRequest[] = [];
  private readonly pending: { resolve: (r: ProviderResponse) => void; reject: (e: unknown) => void }[] = [];
  constructor(
    readonly id: string,
    private readonly honourSignal = false,
  ) {}
  describeCapabilities(): ProviderCapabilityDescriptor {
    return {
      providerId: this.id,
      models: [MODEL],
      supportsStreaming: false,
      supportsStructuredOutput: true,
      supportsVision: false,
      maxContextTokens: 1000,
    };
  }
  complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    return new Promise<ProviderResponse>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      if (this.honourSignal)
        req.signal?.addEventListener('abort', () => reject(providerFailure('aborted', this.id, 'aborted by caller')), { once: true });
    });
  }
  resolveCall(index: number, value: unknown = EMPTY, usage = { inputTokens: 1000, outputTokens: 500 }): void {
    this.pending[index]!.resolve({ ...jsonResponse(value, usage, MODEL), finishReason: 'stop' });
  }
  rejectCall(index: number, error: unknown): void {
    this.pending[index]!.reject(error);
  }
}

function build(
  providers: ModelProvider[],
  extra: Partial<ConstructorParameters<typeof AiCapabilityLayer>[0]> = {},
  policy?: ModelSelectionPolicy,
): { layer: AiCapabilityLayer; cacheWrites: string[] } {
  const cacheWrites: string[] = [];
  const cache: CapabilityCache = { get: () => undefined, set: (key: string) => void cacheWrites.push(key) };
  const layer = new AiCapabilityLayer({
    providers,
    policy: policy ?? singleProviderPolicy(providers[0]!.id, MODEL),
    retryOptions: instantRetry,
    cache,
    ...extra,
  });
  return { layer, cacheWrites };
}

const twoProviders = (): ModelSelectionPolicy => ({
  rules: [{ capability: '*', providerOrder: ['primary', 'backup'], modelByProvider: { primary: MODEL, backup: MODEL } }],
});

function useFakeTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

const breakerState = (layer: AiCapabilityLayer, id: string): string | undefined =>
  (layer as unknown as { circuitBreakers: Map<string, CircuitBreaker> }).circuitBreakers.get(id)?.getState();

// ---- option validation & default behaviour ---------------------------------------------------
test('totalDeadlineMs must be a positive integer within the timer range; omitted means no deadline', () => {
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(EMPTY) }]);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
    assert.throws(
      () => new AiCapabilityLayer({ providers: [provider], policy: singleProviderPolicy('anthropic', MODEL), totalDeadlineMs: bad }),
      (e: unknown) => e instanceof ConfigError && e.code === ErrorCode.CONFIG_INVALID_VALUE,
      String(bad),
    );
  }
  assert.doesNotThrow(
    () => new AiCapabilityLayer({ providers: [provider], policy: singleProviderPolicy('anthropic', MODEL), totalDeadlineMs: 1000 }),
  );
});

test('without a deadline or caller signal the provider request is exactly what it was before (no signal member)', async () => {
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(EMPTY, undefined, MODEL) }]);
  const layer = new AiCapabilityLayer({
    providers: [provider],
    policy: singleProviderPolicy('anthropic', MODEL),
    retryOptions: instantRetry,
  });
  assert.ok((await layer.extractEntities(request())).ok);
  assert.equal('signal' in provider.callLog[0]!, false);
});

test('a call that finishes before the deadline succeeds, is cached, and the timer is gone afterwards', async (t) => {
  useFakeTimers(t);
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(EMPTY, undefined, MODEL) }]);
  const { layer, cacheWrites } = build([provider], { totalDeadlineMs: 1000 });
  const res = await layer.extractEntities(request());
  assert.ok(res.ok);
  assert.equal(cacheWrites.length, 1);
  t.mock.timers.tick(5000);
  const signal = provider.callLog[0]!.signal!;
  assert.equal(signal.aborted, false, 'the deadline timer was cleared on commit: a later tick aborts nothing');
});

// ---- deadline while a provider is in flight --------------------------------------------------
test('deadline expiry stops waiting at once even when the provider ignores its abort signal; typed outcome; no failover', async (t) => {
  useFakeTimers(t);
  const primary = new ControlledProvider('primary', false);
  const backup = new ScriptableTestProvider('backup', [{ kind: 'success', response: jsonResponse(EMPTY, undefined, MODEL) }]);
  const { layer, cacheWrites } = build([primary, backup], { totalDeadlineMs: 1000 }, twoProviders());
  const pending = layer.extractEntities(request());
  await flush();
  assert.equal(primary.calls.length, 1);
  t.mock.timers.tick(1000);
  const res = await pending;
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, ErrorCode.AI_ALL_PROVIDERS_FAILED, 'existing code reused');
  assert.deepEqual(getCallCancellation(res.error), { reason: 'deadline', deadlineMs: 1000 });
  assert.equal(backup.callLog.length, 0, 'time is exhausted: the fallback candidate is never called');
  assert.equal(cacheWrites.length, 0);
  assert.equal(primary.calls[0]!.signal?.aborted, true, 'a compliant provider is told to stop');
});

test('a LATE successful response is discarded (not returned, not cached) but its real usage is still charged', async (t) => {
  useFakeTimers(t);
  const scope = new InferenceGuard({ enabled: true, allowUndeclared: false, maxTotalTokens: 1_000_000 }).beginRun();
  const primary = new ControlledProvider('anthropic', false); // a provider/model the default pricing table prices
  const { layer, cacheWrites } = build([primary], { totalDeadlineMs: 500, inferenceScope: scope });
  const pending = layer.extractEntities(request());
  await flush();
  t.mock.timers.tick(500);
  const res = await pending;
  assert.equal(res.ok, false);
  const heldDuring = scope.snapshot();
  assert.ok(heldDuring.tokensReserved > 0, 'while the provider call is unresolved the reservation is HELD, not released');
  assert.equal(heldDuring.tokensSpent, 0);

  primary.resolveCall(0, EMPTY, { inputTokens: 1000, outputTokens: 500 });
  await flush();
  const after = scope.snapshot();
  assert.equal(after.tokensSpent, 1500, 'late usage is charged exactly');
  assert.equal(after.tokensReserved, 0);
  assert.ok(layer.totalCostUsd() > 0, 'cost total reflects the billed late call');
  assert.equal(cacheWrites.length, 0, 'a late response never reaches the cache');
});

test('a late response with unknown usage is charged at the reservation (never $0)', async (t) => {
  useFakeTimers(t);
  const scope = new InferenceGuard({ enabled: true, allowUndeclared: false, maxTotalTokens: 1_000_000 }).beginRun();
  const primary = new ControlledProvider('primary', false);
  const { layer } = build([primary], { totalDeadlineMs: 500, inferenceScope: scope });
  const pending = layer.extractEntities(request());
  await flush();
  t.mock.timers.tick(500);
  await pending;
  const reserved = scope.snapshot().tokensReserved;
  primary['pending'][0]!.resolve({
    text: '{"entities":[]}',
    usage: { inputTokens: 0, outputTokens: 0 },
    usageKnown: false,
    modelUsed: MODEL,
    finishReason: 'stop',
  });
  await flush();
  assert.equal(scope.snapshot().tokensSpent, reserved);
  assert.equal(scope.snapshot().tokensReserved, 0);
});

test('a late FAILURE releases the reservation (no usage to charge) and never surfaces as an unhandled rejection', async (t) => {
  useFakeTimers(t);
  const scope = new InferenceGuard({ enabled: true, allowUndeclared: false, maxTotalTokens: 1_000_000 }).beginRun();
  const primary = new ControlledProvider('primary', false);
  const { layer } = build([primary], { totalDeadlineMs: 500, inferenceScope: scope });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const pending = layer.extractEntities(request());
    await flush();
    t.mock.timers.tick(500);
    await pending;
    primary.rejectCall(0, new Error('socket closed'));
    await flush();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.deepEqual(scope.snapshot(), { tokensSpent: 0, tokensReserved: 0, costSpentUsd: 0, costReserved: 0 });
});

test('a provider that honours the signal rejects on abort: reservation released, deadline outcome unchanged', async (t) => {
  useFakeTimers(t);
  const scope = new InferenceGuard({ enabled: true, allowUndeclared: false, maxTotalTokens: 1_000_000 }).beginRun();
  const primary = new ControlledProvider('primary', true);
  const { layer } = build([primary], { totalDeadlineMs: 500, inferenceScope: scope });
  const pending = layer.extractEntities(request());
  await flush();
  t.mock.timers.tick(500);
  const res = await pending;
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(getCallCancellation(res.error)?.reason, 'deadline');
  await flush();
  assert.equal(scope.snapshot().tokensReserved, 0);
  assert.equal(scope.snapshot().tokensSpent, 0);
});

test('a deadline or abort never trips the circuit breaker', async (t) => {
  useFakeTimers(t);
  const primary = new ControlledProvider('primary', false);
  const { layer } = build([primary], { totalDeadlineMs: 100, circuitBreakerOptions: { failureThreshold: 1, cooldownMs: 60_000 } });
  for (let i = 0; i < 3; i += 1) {
    const pending = layer.extractEntities(request({ traceId: `t${i}` }));
    await flush();
    t.mock.timers.tick(100);
    await pending;
  }
  assert.equal(primary.calls.length, 3, 'every call still reached the provider: the circuit stayed closed');
  assert.equal(breakerState(layer, 'primary'), 'closed');
});

// ---- deadline covers retries, backoff and fallback ---------------------------------------------
test('the deadline interrupts router backoff: no sleeping past it, no further attempt', async (t) => {
  useFakeTimers(t);
  const badBody: ScriptedOutcome = {
    kind: 'success',
    response: { text: 'not json', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: MODEL, finishReason: 'stop' },
  };
  const provider = new ScriptableTestProvider('anthropic', [badBody]);
  const { layer } = build([provider], {
    totalDeadlineMs: 1500,
    retryOptions: { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 10_000, backoffMultiplier: 2 }, // real (abortable) default sleep
  });
  const pending = layer.extractEntities(request());
  await flush();
  assert.equal(provider.callLog.length, 1, 'first attempt, now backing off for 1000ms');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(provider.callLog.length, 2, 'second attempt, now backing off for 2000ms (would end at 3000ms)');
  t.mock.timers.tick(500); // deadline at 1500ms
  const res = await pending;
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(getCallCancellation(res.error)?.reason, 'deadline');
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(provider.callLog.length, 2, 'no attempt after the deadline, even after the old backoff would have ended');
});

test('an injected sleep is raced against the deadline too', async (t) => {
  useFakeTimers(t);
  const badBody: ScriptedOutcome = {
    kind: 'success',
    response: { text: 'not json', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: MODEL, finishReason: 'stop' },
  };
  const provider = new ScriptableTestProvider('anthropic', [badBody]);
  const { layer } = build([provider], {
    totalDeadlineMs: 100,
    retryOptions: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: () => new Promise<void>(() => {}) },
  });
  const pending = layer.extractEntities(request());
  await flush();
  t.mock.timers.tick(100);
  const res = await pending;
  assert.equal(res.ok, false);
  assert.equal(provider.callLog.length, 1);
});

test('time spent on a failing primary counts against the deadline: fallback is only tried while time remains', async (t) => {
  useFakeTimers(t);
  const primary = new ScriptableTestProvider('primary', [
    { kind: 'failure', error: providerFailure('invalid_request', 'primary', 'nope') },
  ]);
  const backup = new ControlledProvider('backup', false);
  const { layer } = build([primary, backup], { totalDeadlineMs: 300 }, twoProviders());
  const pending = layer.extractEntities(request());
  await flush();
  assert.equal(backup.calls.length, 1, 'primary failed quickly; the backup is called within the budget');
  t.mock.timers.tick(300);
  const res = await pending;
  assert.equal(res.ok, false);
  if (!res.ok) assert.deepEqual(getCallCancellation(res.error), { reason: 'deadline', deadlineMs: 300 });
});

test('an expired deadline spends no rate-limit token and calls no further candidate', async (t) => {
  useFakeTimers(t);
  const primary = new ControlledProvider('primary', false);
  const backup = new ScriptableTestProvider('backup', [{ kind: 'success', response: jsonResponse(EMPTY, undefined, MODEL) }]);
  const { layer } = build([primary, backup], { totalDeadlineMs: 50 }, twoProviders());
  const pending = layer.extractEntities(request());
  await flush();
  t.mock.timers.tick(50);
  await pending;
  const limiters = (layer as unknown as { rateLimiters: Map<string, unknown> }).rateLimiters;
  assert.equal(limiters.has('backup'), false, 'the backup candidate was never even reached');
});

// ---- commit point --------------------------------------------------------------------------------
test('a response accepted before the deadline stays a success even if the deadline passes while it is being cached', async (t) => {
  useFakeTimers(t);
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(EMPTY, undefined, MODEL) }]);
  let release!: () => void;
  const slowCache: CapabilityCache = {
    get: () => undefined,
    set: () => new Promise<void>((resolve) => void (release = resolve)),
  };
  const layer = new AiCapabilityLayer({
    providers: [provider],
    policy: singleProviderPolicy('anthropic', MODEL),
    retryOptions: instantRetry,
    cache: slowCache,
    totalDeadlineMs: 100,
  });
  const pending = layer.extractEntities(request());
  await flush();
  t.mock.timers.tick(1000); // deadline passes during the cache write
  release();
  const res = await pending;
  assert.ok(res.ok, 'already-validated, already-paid-for output is not thrown away');
});

// ---- caller cancellation --------------------------------------------------------------------------
test('caller abort mid-flight stops waiting even if the provider ignores the signal; typed as caller_abort; late usage still charged', async () => {
  const scope = new InferenceGuard({ enabled: true, allowUndeclared: false, maxTotalTokens: 1_000_000 }).beginRun();
  const primary = new ControlledProvider('primary', false);
  const backup = new ScriptableTestProvider('backup', [{ kind: 'success', response: jsonResponse(EMPTY, undefined, MODEL) }]);
  const { layer, cacheWrites } = build([primary, backup], { inferenceScope: scope }, twoProviders());
  const controller = new AbortController();
  const pending = layer.extractEntities(request({ signal: controller.signal }));
  await flush();
  controller.abort();
  const res = await pending;
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.code, ErrorCode.AI_ALL_PROVIDERS_FAILED);
    assert.deepEqual(getCallCancellation(res.error), { reason: 'caller_abort' });
  }
  assert.equal(backup.callLog.length, 0, 'an abort does not fail over');
  primary.resolveCall(0, EMPTY, { inputTokens: 200, outputTokens: 100 });
  await flush();
  assert.equal(scope.snapshot().tokensSpent, 300);
  assert.equal(cacheWrites.length, 0);
});

test('a pre-aborted signal makes zero provider calls and keeps the AI_ALL_PROVIDERS_FAILED code', async () => {
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(EMPTY, undefined, MODEL) }]);
  const { layer } = build([provider]);
  const controller = new AbortController();
  controller.abort();
  const res = await layer.extractEntities(request({ signal: controller.signal }));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, ErrorCode.AI_ALL_PROVIDERS_FAILED);
  assert.equal(provider.callLog.length, 0);
});

test('a cache hit is returned even if the deadline is tiny or the signal is already aborted (hits spend nothing)', async () => {
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(EMPTY, undefined, MODEL) }]);
  const store = new Map<string, unknown>();
  const cache: CapabilityCache = {
    get: <T>(key: string) => (store.has(key) ? { value: store.get(key) as T, storedAtMs: 0 } : undefined),
    set: (key: string, value: unknown) => void store.set(key, value),
  };
  const layer = new AiCapabilityLayer({
    providers: [provider],
    policy: singleProviderPolicy('anthropic', MODEL),
    retryOptions: instantRetry,
    cache,
    totalDeadlineMs: 1,
  });
  assert.ok((await layer.extractEntities(request())).ok);
  const controller = new AbortController();
  controller.abort();
  const hit = await layer.extractEntities(request({ signal: controller.signal }));
  assert.ok(hit.ok);
  if (hit.ok) assert.equal(hit.value.meta.cacheHit, true);
  assert.equal(provider.callLog.length, 1);
});

test('existing behaviour preserved: abort cancels only that call; the next call on the same layer works', async () => {
  const provider = new ScriptableTestProvider('anthropic', [{ kind: 'success', response: jsonResponse(EMPTY, undefined, MODEL) }]);
  const { layer } = build([provider], { totalDeadlineMs: 60_000 });
  const controller = new AbortController();
  controller.abort();
  assert.equal((await layer.extractEntities(request({ signal: controller.signal }))).ok, false);
  assert.ok((await layer.extractEntities(request({ traceId: 'second' }))).ok);
});
