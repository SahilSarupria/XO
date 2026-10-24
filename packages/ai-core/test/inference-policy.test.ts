import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SERVER_INFERENCE_POLICY,
  InferenceGuard,
  type AuthorizeInput,
  type ServerInferencePolicy,
} from '../src/inference-policy.js';

const input = (over: Partial<AuthorizeInput> = {}): AuthorizeInput => ({
  requirement: 'required',
  nodeId: 'cap#1',
  providerId: 'gemini',
  requestedMaxOutputTokens: 100,
  ...over,
});
const guard = (policy: Partial<ServerInferencePolicy> = {}) => new InferenceGuard({ ...DEFAULT_SERVER_INFERENCE_POLICY, ...policy });
const denied = (r: ReturnType<ReturnType<InferenceGuard['beginRun']>['authorize']>) => (r.ok ? 'granted' : r.denial.reason);

test('default policy: only nodes that declare "required" may infer; "none" and undeclared are denied', () => {
  const scope = guard().beginRun();
  assert.equal(denied(scope.authorize(input())), 'granted');
  assert.equal(denied(scope.authorize(input({ requirement: 'none' }))), 'node_declares_none');
  assert.equal(denied(scope.authorize(input({ requirement: 'undeclared' }))), 'node_undeclared');
});

test('allowUndeclared is an explicit server opt-in and never overrides "none"', () => {
  const scope = guard({ allowUndeclared: true }).beginRun();
  assert.equal(denied(scope.authorize(input({ requirement: 'undeclared' }))), 'granted');
  assert.equal(denied(scope.authorize(input({ requirement: 'none' }))), 'node_declares_none');
});

test('server kill-switch and provider allow-list deny regardless of node or run', () => {
  assert.equal(denied(guard({ enabled: false }).beginRun().authorize(input())), 'server_disabled');
  const scope = guard({ allowedProviders: ['anthropic'] }).beginRun();
  assert.equal(denied(scope.authorize(input({ providerId: 'gemini' }))), 'provider_not_allowed');
  assert.equal(denied(scope.authorize(input({ providerId: 'anthropic' }))), 'granted');
});

test('a per-run restriction can disable inference', () => {
  assert.equal(denied(guard().beginRun({ disabled: true }).authorize(input())), 'run_disabled');
});

test('a per-run restriction can NEVER grant: it cannot defeat node "none", undeclared, server-disabled or allow-list', () => {
  const generous = { disabled: false, maxTotalTokens: 1e9, maxCostUsd: 1e9 };
  assert.equal(
    denied(
      guard()
        .beginRun(generous)
        .authorize(input({ requirement: 'none' })),
    ),
    'node_declares_none',
  );
  assert.equal(
    denied(
      guard()
        .beginRun(generous)
        .authorize(input({ requirement: 'undeclared' })),
    ),
    'node_undeclared',
  );
  assert.equal(denied(guard({ enabled: false }).beginRun(generous).authorize(input())), 'server_disabled');
  assert.equal(
    denied(
      guard({ allowedProviders: ['openai'] })
        .beginRun(generous)
        .authorize(input()),
    ),
    'provider_not_allowed',
  );
  // Even with extra, non-type-checked fields smuggled in, nothing grants:
  const smuggled = { enabled: true, allowUndeclared: true, requirement: 'required' } as never;
  assert.equal(
    denied(
      guard()
        .beginRun(smuggled)
        .authorize(input({ requirement: 'undeclared' })),
    ),
    'node_undeclared',
  );
});

test('effective token limit is the MIN of server and run limits and clamps the grant', () => {
  const a = guard({ maxTotalTokens: 50 }).beginRun({ maxTotalTokens: 1000 }).authorize(input());
  assert.ok(a.ok && a.grant.maxOutputTokens === 50);
  const b = guard({ maxTotalTokens: 1000 }).beginRun({ maxTotalTokens: 30 }).authorize(input());
  assert.ok(b.ok && b.grant.maxOutputTokens === 30);
  const c = guard()
    .beginRun()
    .authorize(input({ requestedMaxOutputTokens: 7 }));
  assert.ok(c.ok && c.grant.maxOutputTokens === 7, 'never raised above the request');
});

test('budget exhaustion prevents further calls (server and run level)', () => {
  const g = guard({ maxTotalTokens: 100 });
  const s1 = g.beginRun();
  const first = s1.authorize(input({ requestedMaxOutputTokens: 100 }));
  assert.ok(first.ok);
  if (first.ok) first.grant.settle({ providerId: 'gemini', model: 'm', usage: { inputTokens: 60, outputTokens: 40 } });
  assert.equal(denied(g.beginRun().authorize(input())), 'budget_exhausted', 'server budget is shared across runs');

  const run = guard().beginRun({ maxTotalTokens: 10 });
  const r1 = run.authorize(input());
  assert.ok(r1.ok);
  if (r1.ok) r1.grant.settle({ providerId: 'gemini', model: 'm', usage: { inputTokens: 5, outputTokens: 5 } });
  assert.equal(denied(run.authorize(input())), 'budget_exhausted');
});

test('reservations stop concurrent calls from jointly overshooting; release/settle reconcile', () => {
  const scope = guard({ maxTotalTokens: 100 }).beginRun();
  const a = scope.authorize(input({ requestedMaxOutputTokens: 80 }));
  const b = scope.authorize(input({ requestedMaxOutputTokens: 80 }));
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.equal(a.grant.maxOutputTokens, 80);
  assert.equal(b.grant.maxOutputTokens, 20, 'second concurrent call only gets what is left');
  assert.equal(denied(scope.authorize(input())), 'budget_exhausted');
  a.grant.release(); // first call never happened
  const c = scope.authorize(input({ requestedMaxOutputTokens: 80 }));
  assert.ok(c.ok && c.grant.maxOutputTokens === 80);
});

test('settle is idempotent; unknown usage is charged at the reservation (never treated as free)', () => {
  const g = guard({ maxTotalTokens: 100 });
  const scope = g.beginRun();
  const a = scope.authorize(input({ requestedMaxOutputTokens: 60 }));
  assert.ok(a.ok);
  if (!a.ok) return;
  a.grant.settle({ providerId: 'gemini', model: 'm', usage: undefined });
  a.grant.settle({ providerId: 'gemini', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } });
  assert.equal(g.budgetSnapshot().tokensSpent, 60);
  assert.equal(g.budgetSnapshot().costSpentUsd, 0);
});

test('cost budget: once spend reaches the cap, no further calls (priced model, input bound supplied)', () => {
  const g = guard({ maxCostUsd: 0.001 });
  const scope = g.beginRun();
  const priced = input({ providerId: 'anthropic', model: 'claude-sonnet-4-6', inputTokensUpperBound: 10 });
  const a = scope.authorize(priced);
  assert.ok(a.ok);
  if (a.ok) a.grant.settle({ providerId: 'anthropic', model: 'claude-sonnet-4-6', usage: { inputTokens: 10_000, outputTokens: 1000 } });
  assert.ok(g.budgetSnapshot().costSpentUsd > 0.001);
  assert.equal(denied(scope.authorize(priced)), 'budget_exhausted');
  g.resetBudget();
  assert.equal(denied(g.beginRun().authorize(priced)), 'granted');
});

test('invalid limits are rejected at construction', () => {
  assert.throws(() => guard({ maxTotalTokens: -1 }), /maxTotalTokens/);
  assert.throws(() => guard({ maxCostUsd: Number.NaN }), /maxCostUsd/);
  assert.throws(() => guard().beginRun({ maxTotalTokens: -5 }), /run maxTotalTokens/);
});
