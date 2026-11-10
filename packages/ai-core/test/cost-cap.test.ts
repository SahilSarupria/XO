import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiCapabilityLayer } from '../src/router.js';
import { InferenceGuard, estimateInputTokensUpperBound, getInferenceDenial, type AuthorizeInput } from '../src/inference-policy.js';
import { findPricing, DEFAULT_PRICING_TABLE } from '../src/cost.js';
import type { ModelProvider, ProviderId, ProviderRequest } from '../src/provider-types.js';
import type { CapabilityRequest } from '../src/capability-types.js';
import type { EntityExtractionInput } from '../src/capabilities/entities.js';

const SONNET = 'claude-sonnet-4-6'; // $0.003 in / $0.015 out per 1k tokens in the default table
const call = (over: Partial<AuthorizeInput> = {}): AuthorizeInput => ({
  requirement: 'required',
  nodeId: 'n',
  providerId: 'anthropic',
  requestedMaxOutputTokens: 4096,
  model: SONNET,
  inputTokensUpperBound: 1000,
  ...over,
});
const cap = (maxCostUsd: number, run?: { maxCostUsd: number }) =>
  new InferenceGuard({ enabled: true, allowUndeclared: false, maxCostUsd }).beginRun(run);
const reason = (r: ReturnType<ReturnType<typeof cap>['authorize']>) => (r.ok ? 'granted' : r.denial.reason);

test('UNKNOWN PRICE IS NOT FREE: under a cost cap an unpriced model is refused, not metered at $0', () => {
  assert.equal(findPricing(DEFAULT_PRICING_TABLE, 'gemini', 'gemini-3.5-flash-lite'), undefined);
  assert.equal(reason(cap(1).authorize(call({ providerId: 'gemini', model: 'gemini-3.5-flash-lite' }))), 'cost_unestimable');
  assert.equal(reason(cap(1).authorize(call({ providerId: 'openai', model: 'a-model-nobody-priced' }))), 'cost_unestimable');
});

test('a call whose cost cannot be bounded (no model or no input estimate) is refused under a cost cap', () => {
  assert.equal(reason(cap(1).authorize({ ...call(), model: undefined } as AuthorizeInput)), 'cost_unestimable');
  assert.equal(reason(cap(1).authorize({ ...call(), inputTokensUpperBound: undefined } as AuthorizeInput)), 'cost_unestimable');
});

test('without a cost cap, unpriced models are unaffected (token budgets still apply)', () => {
  const g = new InferenceGuard({ enabled: true, allowUndeclared: false, maxTotalTokens: 10_000 }).beginRun();
  assert.equal(reason(g.authorize(call({ providerId: 'gemini', model: undefined } as never))), 'granted');
});

test('explicitly free providers (local models, replay) are priceable at $0 and usable under a cost cap', () => {
  assert.equal(reason(cap(0.5).authorize(call({ providerId: 'ollama', model: 'llama3' }))), 'granted');
  assert.equal(reason(cap(0.5).authorize(call({ providerId: 'deterministic-replay', model: 'fixture' }))), 'granted');
});

test('the worst case is reserved up front: output is clamped so (input bound + output) can never exceed the cap', () => {
  const scope = cap(0.05);
  const a = scope.authorize(call());
  assert.ok(a.ok);
  if (!a.ok) return;
  // 1000 input tokens = $0.003; remaining $0.047 buys floor(0.047/0.015*1000) = 3133 output tokens.
  assert.equal(a.grant.maxOutputTokens, 3133);
  const worst = (1000 / 1000) * 0.003 + (a.grant.maxOutputTokens / 1000) * 0.015;
  assert.ok(worst <= 0.05 + 1e-12, `worst case ${worst} must not exceed the cap`);
  assert.equal(
    reason(scope.authorize(call())),
    'budget_exhausted',
    'a concurrent in-flight call cannot fit: the reservation holds the budget',
  );
});

test('settling with real usage releases the unused reservation', () => {
  const scope = cap(0.05);
  const a = scope.authorize(call());
  assert.ok(a.ok);
  if (!a.ok) return;
  a.grant.settle({ providerId: 'anthropic', model: SONNET, usage: { inputTokens: 100, outputTokens: 50 } });
  const snap = scope.snapshot();
  assert.ok(Math.abs(snap.costSpentUsd - (0.1 * 0.003 + 0.05 * 0.015)) < 1e-12);
  assert.equal(snap.costReserved, 0);
  assert.equal(reason(scope.authorize(call())), 'granted');
});

test('unknown usage is charged the reserved worst-case COST (not $0) when a cost cap is active', () => {
  const scope = cap(0.05);
  const a = scope.authorize(call());
  assert.ok(a.ok);
  if (!a.ok) return;
  a.grant.settle({ providerId: 'anthropic', model: SONNET, usage: undefined });
  assert.ok(scope.snapshot().costSpentUsd > 0.049, `charged ${scope.snapshot().costSpentUsd}`);
  assert.equal(reason(scope.authorize(call())), 'budget_exhausted');
});

test('release (failed call) returns the cost reservation', () => {
  const scope = cap(0.05);
  const a = scope.authorize(call());
  assert.ok(a.ok);
  if (a.ok) a.grant.release();
  assert.deepEqual({ spent: scope.snapshot().costSpentUsd, reserved: scope.snapshot().costReserved }, { spent: 0, reserved: 0 });
});

test('the tighter of server and run cost caps wins; a run cap cannot raise the server cap', () => {
  assert.equal(reason(cap(10, { maxCostUsd: 0.0001 }).authorize(call())), 'budget_exhausted');
  const g = cap(0.0001, { maxCostUsd: 100 });
  assert.equal(reason(g.authorize(call())), 'budget_exhausted');
});

test('even a provider that spends exactly what was granted cannot push total spend past the cap', () => {
  const scope = cap(0.2);
  let spent = 0;
  for (let i = 0; i < 50; i += 1) {
    const a = scope.authorize(call());
    if (!a.ok) break;
    const usage = { inputTokens: 1000, outputTokens: a.grant.maxOutputTokens };
    a.grant.settle({ providerId: 'anthropic', model: SONNET, usage });
    spent += (usage.inputTokens / 1000) * 0.003 + (usage.outputTokens / 1000) * 0.015;
  }
  assert.ok(spent <= 0.2 + 1e-9, `spent ${spent} exceeded the cap`);
  assert.ok(spent > 0.1, 'the cap is actually used, not wastefully tiny');
});

test('estimateInputTokensUpperBound is at least the UTF-8 byte length and counts extra input', () => {
  const text = 'héllo — wörld 你好';
  const bytes = Buffer.byteLength(text, 'utf8');
  assert.ok(estimateInputTokensUpperBound([{ content: text }]) >= bytes);
  assert.ok(estimateInputTokensUpperBound([{ content: text }], '{"schema":true}') > estimateInputTokensUpperBound([{ content: text }]));
});

// --- end to end through the compile router -------------------------------------
function layerFor(providerId: ProviderId, model: string, guard: InferenceGuard) {
  const calls: ProviderRequest[] = [];
  const provider: ModelProvider = {
    id: providerId,
    describeCapabilities: () => ({
      providerId,
      models: [model],
      supportsStreaming: false,
      supportsStructuredOutput: true,
      supportsVision: false,
      maxContextTokens: 100000,
    }),
    complete: async (r) => {
      calls.push(r);
      return { text: '{"entities":[]}', usage: { inputTokens: 50, outputTokens: 10 }, modelUsed: model, finishReason: 'stop' };
    },
  };
  const scope = guard.beginRun();
  const layer = new AiCapabilityLayer({
    providers: [provider],
    policy: { rules: [{ capability: '*', providerOrder: [providerId], modelByProvider: { [providerId]: model } }] },
    retryOptions: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, sleep: async () => {} },
    inferenceScope: scope,
  });
  return { layer, calls, scope };
}
const req: CapabilityRequest<EntityExtractionInput> = { input: {}, excerpt: { text: 'hello', documentPath: 'a.pdf' }, traceId: 't' };

test('router: a cost-capped compile with an UNPRICED model is denied (cost_unestimable) before any provider call', async () => {
  const { layer, calls } = layerFor(
    'gemini',
    'gemini-3.5-flash-lite',
    new InferenceGuard({ enabled: true, allowUndeclared: false, maxCostUsd: 1 }),
  );
  const r = await layer.extractEntities(req);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
  if (!r.ok) assert.equal(getInferenceDenial(r.error)?.reason, 'cost_unestimable');
});

test('router: a cost-capped compile with a priced model clamps maxOutputTokens to the affordable amount', async () => {
  const { layer, calls, scope } = layerFor(
    'anthropic',
    SONNET,
    new InferenceGuard({ enabled: true, allowUndeclared: false, maxCostUsd: 0.02 }),
  );
  const r = await layer.extractEntities(req);
  assert.ok(r.ok);
  assert.ok(calls[0]!.maxOutputTokens < 4096, `clamped, got ${calls[0]!.maxOutputTokens}`);
  assert.ok(scope.snapshot().costSpentUsd <= 0.02);
  assert.equal(scope.snapshot().costReserved, 0);
});
