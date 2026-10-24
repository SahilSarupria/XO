import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerInferencePolicy, RunInferenceRestriction } from '@xo/ai-core';
import type { CapabilityDeclaration } from '@xo/types';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { allowAllPermissionGate } from './authz-helpers.js';
import {
  buildContractLawyerBundle,
  contractAnalysisCapability,
  mountBundle,
  ScriptedModelProvider,
  withTempInstaller,
} from './fixtures.js';

const { execution: _x, ...undeclaredBase } = contractAnalysisCapability;
void _x;
const undeclared: CapabilityDeclaration = undeclaredBase;
const declaredModel: CapabilityDeclaration = { ...undeclaredBase, execution: { mode: 'model' } };
const declaredHybridModel: CapabilityDeclaration = {
  ...undeclaredBase,
  execution: { mode: 'hybrid', hybridSteps: [{ stepId: 's1', strategy: 'model', input: { kind: 'request' } }] },
};

const req = (id: string, extra: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  requestId: RequestId(id),
  capabilityId: contractAnalysisCapability.id,
  input: 'Review this NDA.',
  environment: {
    environmentId: EnvironmentId('env_1'),
    hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
    provider: 'anthropic',
    tokenBudget: 8000,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  requestedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

async function harness(
  capability: CapabilityDeclaration,
  inferencePolicy?: ServerInferencePolicy,
  usage = { inputTokens: 5, outputTokens: 5 },
) {
  let teardown: () => void = () => {};
  const done = new Promise<void>((resolve) => (teardown = resolve));
  let ready!: (v: { engine: ExecutionEngine; provider: ScriptedModelProvider }) => void;
  const pair = new Promise<{ engine: ExecutionEngine; provider: ScriptedModelProvider }>((resolve) => (ready = resolve));
  const running = withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [capability] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: 'ok', usage, modelUsed: 'test-model', finishReason: 'stop' });
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      permissionGate: allowAllPermissionGate,
      ...(inferencePolicy ? { inferencePolicy } : {}),
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
    });
    ready({ engine, provider });
    await done;
  });
  const { engine, provider } = await pair;
  return { engine, provider, close: async () => (teardown(), running) };
}

const reasonOf = (r: unknown): string | undefined => /"reason":"(\w+)"/.exec(JSON.stringify(r))?.[1];

test('DEFAULT: an undeclared (no execution field) capability does NOT call the LLM, and the denial is structured and not retried', async () => {
  const h = await harness(undeclared);
  try {
    const r = await h.engine.execute(req('r1'));
    assert.notEqual(r.session.status, 'completed');
    assert.equal(h.provider.requests.length, 0, 'provider must never be contacted');
    assert.equal(reasonOf(r), 'node_undeclared');
    assert.match(JSON.stringify(r), /XO_RUNTIME_PERMISSION_DENIED/);
    assert.ok(!JSON.stringify(r).includes('RETRY_EXHAUSTED'), 'a policy denial is never retried');
  } finally {
    await h.close();
  }
});

test('explicit server opt-in (allowUndeclared) preserves legacy behaviour for undeclared capabilities', async () => {
  const h = await harness(undeclared, { enabled: true, allowUndeclared: true });
  try {
    const r = await h.engine.execute(req('r2'));
    assert.equal(r.session.status, 'completed');
    assert.equal(h.provider.requests.length, 1);
  } finally {
    await h.close();
  }
});

test('a capability that DECLARES a model strategy may infer under the default policy', async () => {
  const h = await harness(declaredModel);
  try {
    const r = await h.engine.execute(req('r3'));
    assert.equal(r.session.status, 'completed');
    assert.equal(h.provider.requests.length, 1);
  } finally {
    await h.close();
  }
});

test('server kill-switch denies a declared model node; nothing else is substituted', async () => {
  const h = await harness(declaredModel, { enabled: false, allowUndeclared: true });
  try {
    const r = await h.engine.execute(req('r4'));
    assert.equal(reasonOf(r), 'server_disabled');
    assert.notEqual(r.session.status, 'completed');
    assert.equal(h.provider.requests.length, 0);
  } finally {
    await h.close();
  }
});

test('per-run restriction can DISABLE inference for a node that is otherwise allowed', async () => {
  const h = await harness(declaredModel);
  try {
    const r = await h.engine.execute(req('r5', { inference: { disabled: true } }));
    assert.equal(reasonOf(r), 'run_disabled');
    assert.notEqual(r.session.status, 'completed');
    assert.equal(h.provider.requests.length, 0);
  } finally {
    await h.close();
  }
});

test('per-run restriction can NEVER enable inference that node or server policy forbids', async () => {
  const generous: RunInferenceRestriction = { disabled: false, maxTotalTokens: 1e9, maxCostUsd: 1e9 };
  const undecl = await harness(undeclared);
  try {
    await undecl.engine.execute(req('r6a', { inference: generous }));
    assert.equal(undecl.provider.requests.length, 0, 'undeclared stays denied despite a generous run restriction');
  } finally {
    await undecl.close();
  }
  const off = await harness(declaredModel, { enabled: false, allowUndeclared: true });
  try {
    await off.engine.execute(req('r6b', { inference: generous }));
    assert.equal(off.provider.requests.length, 0, 'server-disabled stays denied');
  } finally {
    await off.close();
  }
});

test('a per-run token limit clamps the provider request, and exhaustion blocks every further call sharing that restriction', async () => {
  const h = await harness(declaredModel, undefined, { inputTokens: 40, outputTokens: 20 });
  try {
    const shared: RunInferenceRestriction = { maxTotalTokens: 50 };
    const first = await h.engine.execute(req('r7a', { inference: shared }));
    assert.equal(first.session.status, 'completed');
    assert.ok((h.provider.requests[0]?.maxOutputTokens ?? Infinity) <= 50, 'request is clamped to the remaining budget');
    const second = await h.engine.execute(req('r7b', { inference: shared }));
    assert.notEqual(second.session.status, 'completed');
    assert.equal(reasonOf(second), 'budget_exhausted');
    assert.match(JSON.stringify(second), /XO_RUNTIME_BUDGET_EXCEEDED/);
    assert.equal(h.provider.requests.length, 1, 'budget exhausted: no second provider call');
  } finally {
    await h.close();
  }
});

test('server cumulative budget is shared across runs and blocks further calls once spent', async () => {
  const h = await harness(
    declaredModel,
    { enabled: true, allowUndeclared: false, maxTotalTokens: 60 },
    { inputTokens: 40, outputTokens: 20 },
  );
  try {
    assert.equal((await h.engine.execute(req('r8a'))).session.status, 'completed');
    assert.notEqual((await h.engine.execute(req('r8b'))).session.status, 'completed');
    assert.equal(h.provider.requests.length, 1);
  } finally {
    await h.close();
  }
});

test('a hybrid "model" step is an inference node: allowed by default, denied when the run disables inference', async () => {
  const ok = await harness(declaredHybridModel);
  try {
    assert.equal((await ok.engine.execute(req('r9a'))).session.status, 'completed');
    assert.equal(ok.provider.requests.length, 1);
  } finally {
    await ok.close();
  }
  const off = await harness(declaredHybridModel);
  try {
    const r = await off.engine.execute(req('r9b', { inference: { disabled: true } }));
    assert.notEqual(r.session.status, 'completed');
    assert.equal(off.provider.requests.length, 0);
  } finally {
    await off.close();
  }
});

test('streaming goes through the same gate', async () => {
  const h = await harness(undeclared);
  try {
    const stream = h.engine.executeStreaming(req('r10'));
    for await (const _event of stream.events) void _event;
    const result = await stream.result;
    assert.notEqual(result.session.status, 'completed');
    assert.equal(h.provider.requests.length, 0);
  } finally {
    await h.close();
  }
});

test('a server cost cap refuses a model whose price is unknown instead of treating it as free', async () => {
  const h = await harness(declaredModel, { enabled: true, allowUndeclared: false, maxCostUsd: 1 });
  try {
    const r = await h.engine.execute(req('r11'));
    assert.equal(reasonOf(r), 'cost_unestimable');
    assert.notEqual(r.session.status, 'completed');
    assert.equal(h.provider.requests.length, 0);
  } finally {
    await h.close();
  }
});
