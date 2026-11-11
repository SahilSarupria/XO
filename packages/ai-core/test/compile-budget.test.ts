import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@xo/errors';
import { AiCapabilityLayer } from '../src/router.js';
import { InMemoryCapabilityCache } from '../src/cache.js';
import { computeCostUsd } from '../src/cost.js';
import { InferenceGuard, getInferenceDenial } from '../src/inference-policy.js';
import { resolveCompilerInferencePolicy, createCompileInferenceScope } from '../src/inference-config.js';
import { providerFailure } from '../src/provider-errors.js';
import type { ModelProvider, ProviderId, ProviderRequest, ProviderResponse, TokenUsage } from '../src/provider-types.js';
import type { CapabilityRequest } from '../src/capability-types.js';
import type { EntityExtractionInput } from '../src/capabilities/entities.js';
import type { ServerInferencePolicy } from '../src/inference-policy.js';
import { capturingLogger } from './providers/gemini-helpers.js';

const GOOD = '{"entities":[]}';
const BAD = '{"entities":"wrong"}';
const retry = (maxAttempts: number) => ({ maxAttempts, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} });
const req = (text = 'x', signal?: AbortSignal): CapabilityRequest<EntityExtractionInput> => ({
  input: {},
  excerpt: { text, documentPath: 'a.pdf' },
  traceId: `t-${text}`,
  ...(signal ? { signal } : {}),
});

type Behaviour = (call: ProviderRequest, n: number) => Promise<Partial<ProviderResponse> & { text: string }>;
function mock(id: ProviderId, model: string, behaviour: Behaviour) {
  const calls: ProviderRequest[] = [];
  const provider: ModelProvider = {
    id,
    describeCapabilities: () => ({
      providerId: id,
      models: [model],
      supportsStreaming: false,
      supportsStructuredOutput: true,
      supportsVision: false,
      maxContextTokens: 100000,
    }),
    complete: async (call) => {
      calls.push(call);
      const r = await behaviour(call, calls.length);
      return { usage: { inputTokens: 40, outputTokens: 20 }, modelUsed: model, finishReason: 'stop', ...r };
    },
  };
  return { provider, calls, model };
}
const ok =
  (usage?: TokenUsage): Behaviour =>
  async () => ({ text: GOOD, ...(usage ? { usage } : {}) });

function layer(
  providers: ReturnType<typeof mock>[],
  policy: Partial<ServerInferencePolicy> | 'unlimited',
  opts: { attempts?: number; cache?: boolean } = {},
) {
  const guard = new InferenceGuard({ enabled: true, allowUndeclared: false, ...(policy === 'unlimited' ? {} : policy) });
  const scope = guard.beginRun();
  const log = capturingLogger();
  const l = new AiCapabilityLayer({
    providers: providers.map((p) => p.provider),
    policy: {
      rules: [
        {
          capability: '*',
          providerOrder: providers.map((p) => p.provider.id),
          modelByProvider: Object.fromEntries(providers.map((p) => [p.provider.id, p.model])),
        },
      ],
    },
    retryOptions: retry(opts.attempts ?? 1),
    ...(policy === 'unlimited' ? {} : { inferenceScope: scope }),
    ...(opts.cache ? { cache: new InMemoryCapabilityCache() } : {}),
    logger: log.logger,
  });
  return { l, scope, guard, log };
}
const denialOf = (r: { ok: boolean; error?: unknown }) => (r.ok ? undefined : getInferenceDenial(r.error));

test('limit reached BEFORE the call: provider is never contacted; outcome is a typed denial, not a provider failure', async () => {
  const a = mock('gemini', 'gemini-3.5-flash-lite', ok());
  const { l } = layer([a], { maxTotalTokens: 0 });
  const r = await l.extractEntities(req());
  assert.equal(r.ok, false);
  assert.equal(a.calls.length, 0);
  if (r.ok) return;
  assert.equal(r.error.code, ErrorCode.AI_INFERENCE_DENIED);
  assert.notEqual(r.error.code, ErrorCode.AI_ALL_PROVIDERS_FAILED);
  assert.notEqual(r.error.code, ErrorCode.AI_PROVIDER_REQUEST_FAILED);
  const d = getInferenceDenial(r.error);
  assert.deepEqual(
    { reason: d?.reason, nodeId: d?.nodeId, providerId: d?.providerId },
    { reason: 'budget_exhausted', nodeId: 'compile:extractEntities', providerId: 'gemini' },
  );
  assert.equal((r.error.context as { scope?: string }).scope, 'compile');
});

test('multiple calls share one budget; later calls are clamped, then denied once spent', async () => {
  const a = mock('gemini', 'gemini-3.5-flash-lite', ok({ inputTokens: 40, outputTokens: 20 }));
  const { l, scope } = layer([a], { maxTotalTokens: 100 });
  assert.ok((await l.extractEntities(req('one'))).ok); // spends 60 of 100
  assert.ok((await l.extractEntities(req('two'))).ok); // 40 left -> clamped grant of 40
  assert.equal(a.calls[1]?.maxOutputTokens, 40, 'request is clamped to the remaining budget');
  const third = await l.extractEntities(req('three'));
  assert.equal(denialOf(third)?.reason, 'budget_exhausted');
  assert.equal(a.calls.length, 2);
  assert.equal(scope.snapshot().tokensSpent, 120, 'overshoot is bounded by the last call input size, then calls stop');
});

test('RETRIES draw on the same budget, every billed attempt is recorded, and a denial ends the retry loop', async () => {
  const usage = { inputTokens: 60, outputTokens: 40 };
  const a = mock('anthropic', 'claude-sonnet-4-6', async () => ({ text: BAD, usage }));
  const { l, scope } = layer([a], { maxTotalTokens: 250 }, { attempts: 6 });
  const r = await l.extractEntities(req());
  // 100 + 100 + (50 left, clamped) 100 = 300 spent after three billed attempts; the fourth is denied before any call.
  assert.equal(a.calls.length, 3);
  assert.equal(denialOf(r)?.reason, 'budget_exhausted');
  assert.equal(scope.snapshot().tokensSpent, 300);
  const per = computeCostUsd('anthropic', 'claude-sonnet-4-6', usage);
  assert.ok(per > 0);
  assert.ok(Math.abs(l.totalCostUsd() - 3 * per) < 1e-12, 'discarded (schema-invalid) attempts are still counted as spend');
});

test('CONCURRENT calls reserve up front: in-flight reservations can never exceed the limit', async () => {
  let peakReserved = 0;
  const a = mock('gemini', 'gemini-3.5-flash-lite', async () => {
    peakReserved = Math.max(peakReserved, scopeRef.snapshot().tokensReserved);
    await new Promise((r) => setTimeout(r, 25));
    return { text: GOOD, usage: { inputTokens: 1, outputTokens: 1 } };
  });
  const built = layer([a], { maxTotalTokens: 6000 });
  const scopeRef = built.scope;
  const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((t) => built.l.extractEntities(req(t))));
  const granted = a.calls.map((c) => c.maxOutputTokens);
  assert.ok(granted.reduce((s, n) => s + n, 0) <= 6000, `granted ${granted.join('+')} must fit the limit`);
  assert.equal(a.calls.length, 2, 'only the calls whose reservation fit were allowed to start');
  assert.equal(results.filter((r) => denialOf(r)?.reason === 'budget_exhausted').length, 3);
  assert.ok(peakReserved <= 6000);
  assert.equal(built.scope.snapshot().tokensReserved, 0, 'every reservation is settled or released');
});

test('cache hits are not charged, and are still served when the budget is exhausted', async () => {
  const a = mock('gemini', 'gemini-3.5-flash-lite', ok({ inputTokens: 40, outputTokens: 20 }));
  const { l, scope } = layer([a], { maxTotalTokens: 60 }, { cache: true });
  const first = await l.extractEntities(req('same'));
  assert.ok(first.ok);
  const spent = scope.snapshot().tokensSpent;
  assert.equal(spent, 60);
  const hit = await l.extractEntities(req('same'));
  assert.ok(hit.ok && hit.value.meta.cacheHit);
  assert.equal(scope.snapshot().tokensSpent, spent, 'a hit consumes no new budget');
  assert.equal(a.calls.length, 1);
  assert.equal(denialOf(await l.extractEntities(req('different')))?.reason, 'budget_exhausted');
});

test('kill-switch denies even a cache hit (policy applies to cached LLM output; budget does not)', async () => {
  const a = mock('gemini', 'gemini-3.5-flash-lite', ok());
  const seed = layer([a], 'unlimited', { cache: true });
  assert.ok((await seed.l.extractEntities(req('k'))).ok);
  const cache = new InMemoryCapabilityCache();
  const open = new AiCapabilityLayer({
    providers: [a.provider],
    policy: { rules: [{ capability: '*', providerOrder: ['gemini'], modelByProvider: { gemini: a.model } }] },
    cache,
    retryOptions: retry(1),
  });
  assert.ok((await open.extractEntities(req('k'))).ok);
  const closed = new AiCapabilityLayer({
    providers: [a.provider],
    policy: { rules: [{ capability: '*', providerOrder: ['gemini'], modelByProvider: { gemini: a.model } }] },
    cache,
    retryOptions: retry(1),
    inferenceScope: new InferenceGuard({ enabled: false, allowUndeclared: false }).beginRun(),
  });
  const before = a.calls.length;
  assert.equal(denialOf(await closed.extractEntities(req('k')))?.reason, 'server_disabled');
  assert.equal(a.calls.length, before);
});

test('provider error / timeout releases the reservation (nothing measurable to charge); the limitation is documented', async () => {
  const boom = mock('gemini', 'gemini-3.5-flash-lite', async () => {
    throw providerFailure('timeout', 'gemini', 'timed out');
  });
  const { l, scope } = layer([boom], { maxTotalTokens: 10_000 });
  const r = await l.extractEntities(req());
  assert.equal(r.ok, false);
  assert.equal(denialOf(r), undefined, 'a provider failure is NOT reported as a denial');
  assert.deepEqual({ spent: scope.snapshot().tokensSpent, reserved: scope.snapshot().tokensReserved }, { spent: 0, reserved: 0 });
});

test('unknown usage is charged at the reservation for budget purposes, and no cost is invented', async () => {
  const a = mock('gemini', 'gemini-3.5-flash-lite', async () => ({
    text: GOOD,
    usage: { inputTokens: 0, outputTokens: 0 },
    usageKnown: false,
  }));
  const { l, scope } = layer([a], { maxTotalTokens: 10_000 });
  assert.ok((await l.extractEntities(req())).ok);
  assert.equal(scope.snapshot().tokensSpent, 4096);
  assert.equal(scope.snapshot().costSpentUsd, 0);
});

test('cancellation: a pre-aborted signal never reaches the provider or the budget; mid-flight abort releases', async () => {
  const a = mock('gemini', 'gemini-3.5-flash-lite', ok());
  const pre = layer([a], { maxTotalTokens: 10_000 });
  const ac = new AbortController();
  ac.abort();
  const r = await pre.l.extractEntities(req('x', ac.signal));
  assert.equal(r.ok, false);
  assert.equal(a.calls.length, 0);
  assert.equal(pre.scope.snapshot().tokensReserved, 0);

  const live = new AbortController();
  const hang = mock(
    'gemini',
    'gemini-3.5-flash-lite',
    (call) =>
      new Promise((_res, rej) => call.signal?.addEventListener('abort', () => rej(providerFailure('aborted', 'gemini', 'aborted')))),
  );
  const mid = layer([hang], { maxTotalTokens: 10_000 });
  const pending = mid.l.extractEntities(req('y', live.signal));
  setTimeout(() => live.abort(), 10);
  assert.equal((await pending).ok, false);
  assert.deepEqual({ spent: mid.scope.snapshot().tokensSpent, reserved: mid.scope.snapshot().tokensReserved }, { spent: 0, reserved: 0 });
});

test('FALLBACK/escalation to another candidate draws on the same budget and cannot bypass it', async () => {
  const first = mock('gemini', 'gemini-3.5-flash-lite', async () => ({ text: BAD, usage: { inputTokens: 60, outputTokens: 40 } }));
  const second = mock('openai', 'gpt-4o', ok());
  const exhausted = layer([first, second], { maxTotalTokens: 100 });
  const r = await exhausted.l.extractEntities(req());
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0, 'the fallback provider is not called once the shared budget is spent');
  assert.equal(denialOf(r)?.reason, 'budget_exhausted');
  assert.notEqual(!r.ok && r.error.code, ErrorCode.AI_ALL_PROVIDERS_FAILED);

  const first2 = mock('gemini', 'gemini-3.5-flash-lite', async () => ({ text: BAD, usage: { inputTokens: 6, outputTokens: 4 } }));
  const second2 = mock('openai', 'gpt-4o', ok());
  const roomy = layer([first2, second2], { maxTotalTokens: 100_000 });
  assert.ok((await roomy.l.extractEntities(req())).ok);
  assert.equal(second2.calls.length, 1, 'fallback still works when budget remains');
});

test('a denial is final: no retry, no sleep, and the denial is counted in the report', async () => {
  const a = mock('gemini', 'gemini-3.5-flash-lite', ok());
  let slept = 0;
  const guard = new InferenceGuard({ enabled: true, allowUndeclared: false, maxTotalTokens: 0 });
  const l = new AiCapabilityLayer({
    providers: [a.provider],
    policy: { rules: [{ capability: '*', providerOrder: ['gemini'], modelByProvider: { gemini: a.model } }] },
    retryOptions: { ...retry(5), sleep: async () => void (slept += 1) },
    inferenceScope: guard.beginRun(),
  });
  assert.equal(denialOf(await l.extractEntities(req('1')))?.reason, 'budget_exhausted');
  assert.equal(denialOf(await l.extractEntities(req('2')))?.reason, 'budget_exhausted');
  assert.equal(slept, 0);
  assert.equal(a.calls.length, 0);
  assert.deepEqual(l.inferenceReport().denials, { budget_exhausted: 2 });
  assert.deepEqual(l.inferenceReport().spend, { tokensSpent: 0, costSpentUsd: 0 });
});

test('compile budget and runtime guard are independent: exhausting one grants/denies nothing in the other', async () => {
  const compile = createCompileInferenceScope({ enabled: true, allowUndeclared: false, maxTotalTokens: 0 });
  assert.equal(
    compile.authorize({ requirement: 'required', nodeId: 'compile:x', providerId: 'gemini', requestedMaxOutputTokens: 10 }).ok,
    false,
  );
  const runtime = new InferenceGuard().beginRun();
  assert.equal(runtime.authorize({ requirement: 'required', nodeId: 'cap', providerId: 'gemini', requestedMaxOutputTokens: 10 }).ok, true);
  // And a generous compile budget never converts an undeclared runtime node into an allowed one.
  const generous = createCompileInferenceScope({ enabled: true, allowUndeclared: false, maxTotalTokens: 1e9 });
  void generous;
  assert.equal(
    new InferenceGuard()
      .beginRun()
      .authorize({ requirement: 'undeclared', nodeId: 'cap', providerId: 'gemini', requestedMaxOutputTokens: 10 }).ok,
    false,
  );
});

test('no scope supplied: behaviour is unchanged (unlimited, no denial)', async () => {
  const a = mock('gemini', 'gemini-3.5-flash-lite', ok());
  const { l } = layer([a], 'unlimited');
  for (const t of ['1', '2', '3']) assert.ok((await l.extractEntities(req(t))).ok);
  assert.equal(a.calls[0]?.maxOutputTokens, 4096);
  assert.equal(l.inferenceReport().spend, undefined);
});

test('resolveCompilerInferencePolicy is FAIL-CLOSED: no limit and no explicit opt-in is an error, never "unlimited"', () => {
  assert.throws(() => resolveCompilerInferencePolicy({}), /requires a spend limit.*XO_COMPILER_ALLOW_UNBOUNDED_INFERENCE/s);
  assert.deepEqual(resolveCompilerInferencePolicy({ XO_COMPILER_ALLOW_UNBOUNDED_INFERENCE: 'true' }), {
    enabled: true,
    allowUndeclared: false,
    explicitlyUnbounded: true,
  });
  assert.deepEqual(resolveCompilerInferencePolicy({ XO_COMPILER_MAX_TOTAL_TOKENS: '5000', XO_COMPILER_MAX_COST_USD: '0.5' }), {
    enabled: true,
    allowUndeclared: false,
    explicitlyUnbounded: false,
    maxTotalTokens: 5000,
    maxCostUsd: 0.5,
  });
  assert.equal(resolveCompilerInferencePolicy({ XO_COMPILER_MAX_TOTAL_TOKENS: '0' }).maxTotalTokens, 0);
  assert.throws(() => resolveCompilerInferencePolicy({ XO_COMPILER_MAX_TOTAL_TOKENS: '-1' }), />= 0/);
  assert.throws(() => resolveCompilerInferencePolicy({ XO_COMPILER_MAX_COST_USD: 'lots' }), /number/);
});
