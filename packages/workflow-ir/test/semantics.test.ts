import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DETERMINISTIC_HOST,
  approvalIdentity,
  backoffDelayMs,
  canonicalJson,
  compensationPlan,
  determinismReport,
  evaluateDecide,
  externalIdempotencyKey,
  isLegalRunTransition,
  isLegalStepTransition,
  negotiateWorkflows,
  readySteps,
  renderIdempotencyKey,
  startBudget,
  type DecideStep,
  type StepState,
  type WorkflowComponent,
  type WorkflowDef,
} from '../src/index.js';

const wf = (steps: any[], extra: any = {}): WorkflowDef =>
  ({
    id: 'w',
    version: '1.0.0',
    triggers: [{ id: 't', kind: 'api' }],
    inputs: {},
    steps,
    maxConcurrency: 2,
    runTimeoutMs: 1000,
    cancellation: { onCancel: 'abandon' },
    ...extra,
  }) as WorkflowDef;
const s = (id: string, needs: string[] = [], extra: any = {}): any => ({
  id,
  type: 'decide',
  determinism: 'deterministic',
  needs,
  timeoutMs: 1,
  ...extra,
});

describe('state machine', () => {
  it('only allows legal transitions', () => {
    assert.ok(isLegalStepTransition('pending', 'ready'));
    assert.ok(isLegalStepTransition('failed', 'ready')); // retry
    assert.ok(!isLegalStepTransition('succeeded', 'running'));
    assert.ok(!isLegalStepTransition('skipped', 'running'));
    assert.ok(isLegalRunTransition('running', 'compensating'));
    assert.ok(!isLegalRunTransition('completed', 'running'));
    assert.ok(!isLegalRunTransition('escalated', 'completed'));
  });
});

describe('scheduling', () => {
  const w = wf([s('a'), s('b', ['a']), s('c', ['a']), s('d', ['b', 'c'])]);
  it('is ready when every need is succeeded or skipped, in document order', () => {
    const st = new Map<string, StepState>();
    assert.deepEqual(readySteps(w, st), ['a']);
    st.set('a', 'succeeded');
    assert.deepEqual(readySteps(w, st), ['b', 'c']);
    st.set('b', 'succeeded').set('c', 'skipped');
    assert.deepEqual(readySteps(w, st), ['d']);
    st.set('c', 'failed');
    assert.deepEqual(readySteps(w, st), []);
  });
  it('bounds concurrency', () => {
    const st = new Map<string, StepState>([
      ['a', 'running'],
      ['b', 'running'],
    ]);
    assert.equal(startBudget(w, st), 0);
    st.set('b', 'succeeded');
    assert.equal(startBudget(w, st), 1);
  });
});

describe('compensation order', () => {
  it('compensates completed write steps in reverse completion order and names uncompensatable ones', () => {
    const w = wf([
      { id: 'a', type: 'act', sideEffect: 'write', compensatedBy: 'ua' },
      { id: 'b', type: 'act', sideEffect: 'irreversible' },
      { id: 'c', type: 'act', sideEffect: 'write', compensatedBy: 'uc' },
      { id: 'r', type: 'act', sideEffect: 'read' },
    ]);
    assert.deepEqual(compensationPlan(w, ['a', 'r', 'b', 'c']), { compensate: ['uc', 'ua'], uncompensatable: ['b'] });
  });
});

describe('identities and keys', () => {
  const idw = { id: 'w', version: '1.0.0' };
  it('approval identity is derived and differs per run, step and item', () => {
    const a = approvalIdentity(idw, 's', { runId: 'r1', index: 0 });
    assert.equal(a, approvalIdentity(idw, 's', { runId: 'r1', index: 0 }));
    assert.notEqual(a, approvalIdentity(idw, 's', { runId: 'r2', index: 0 }));
    assert.notEqual(a, approvalIdentity(idw, 't', { runId: 'r1', index: 0 }));
    assert.notEqual(a, approvalIdentity(idw, 's', { runId: 'r1', index: 1 }));
  });
  it('renders keys and refuses to render when a placeholder cannot be resolved', () => {
    const resolve = (r: string) => ({ 'run.id': 'r9', 'input.who': 'ann' })[r];
    assert.equal(renderIdempotencyKey('n:{{run.id}}:{{input.who}}:{{step.id}}', idw, 'x', resolve), 'n:r9:ann:x');
    assert.equal(renderIdempotencyKey('n:{{input.missing}}', idw, 'x', resolve), undefined);
    assert.equal(renderIdempotencyKey('n:{{oops', idw, 'x', resolve), undefined);
  });
  it('external keys are stable, namespaced by step, and hide the business key', () => {
    const k = externalIdempotencyKey(idw, 'pay', 'claim:42');
    assert.equal(k, externalIdempotencyKey(idw, 'pay', 'claim:42'));
    assert.notEqual(k, externalIdempotencyKey(idw, 'refund', 'claim:42'));
    assert.ok(!k.includes('claim'));
  });
  it('canonical JSON is order independent', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    assert.throws(() => canonicalJson({ a: NaN }));
  });
});

describe('backoff', () => {
  const step = s('x', [], { retry: { maxAttempts: 5, backoff: { kind: 'exponential', baseMs: 100, maxMs: 1000, jitter: 'none' } } });
  it('grows exponentially, caps, and jitters within [0, delay]', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => backoffDelayMs(step, n, () => 0)),
      [100, 200, 400, 800, 1000],
    );
    const j = { ...step, retry: { ...step.retry, backoff: { ...step.retry.backoff, jitter: 'full' } } };
    assert.equal(
      backoffDelayMs(j, 3, () => 0.5),
      200,
    );
    assert.equal(
      backoffDelayMs(j, 3, () => 0.999999),
      400,
    ); // inclusive upper bound
  });
});

describe('decide evaluator is pure and fails closed', () => {
  const rules: DecideStep = {
    id: 'd',
    type: 'decide',
    determinism: 'deterministic',
    timeoutMs: 1,
    outputs: { tier: { type: 'enum', enum: ['high', 'low'] } },
    method: { kind: 'rules', rules: [{ id: 'r1', when: 'amount > 100', set: { tier: 'high' } }], onNoMatch: 'escalate' },
  };
  it('first matching rule wins; no match is a refusal, not a default', () => {
    assert.deepEqual(evaluateDecide(rules, { amount: 500 }), { ok: true, outputs: { tier: 'high' }, rulesFired: ['r1'] });
    const r = evaluateDecide(rules, { amount: 5 });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'no_match');
  });
  it('a missing fact is a refusal', () => {
    const r = evaluateDecide(rules, {});
    assert.equal(r.ok === false && r.code, 'missing_fact');
  });
  it('formulas chain earlier outputs and check output types', () => {
    const f: DecideStep = {
      id: 'f',
      type: 'decide',
      determinism: 'deterministic',
      timeoutMs: 1,
      outputs: { net: { type: 'number' }, big: { type: 'boolean' } },
      method: { kind: 'formula', set: { net: 'gross - 150', big: 'net > 1000' } },
    };
    assert.deepEqual(evaluateDecide(f, { gross: 1200 }), { ok: true, outputs: { net: 1050, big: true }, rulesFired: ['net', 'big'] });
    const bad: DecideStep = { ...f, outputs: { net: { type: 'integer' }, big: { type: 'boolean' } } };
    const r = evaluateDecide(bad, { gross: 1200.5 });
    assert.equal(r.ok === false && r.code, 'invalid_output');
  });
  it('lookups are exact, type-strict, and a miss escalates', () => {
    const l: DecideStep = {
      id: 'l',
      type: 'decide',
      determinism: 'deterministic',
      timeoutMs: 1,
      outputs: { rate: { type: 'number' } },
      method: {
        kind: 'lookup',
        keys: ['cls'],
        rows: [
          { cls: 'a', rate: 2.5 },
          { cls: 'b', rate: 4 },
        ],
        onMiss: 'escalate',
      },
    };
    assert.deepEqual(evaluateDecide(l, { cls: 'b' }), { ok: true, outputs: { rate: 4 }, rulesFired: ['row:1'] });
    assert.equal((evaluateDecide(l, { cls: 'z' }) as any).code, 'lookup_miss');
    assert.equal((evaluateDecide(l, { cls: null }) as any).code, 'missing_fact');
  });
  it('is deterministic: same inputs, same bytes', () => {
    const a = JSON.stringify(evaluateDecide(rules, { amount: 500 }));
    for (let i = 0; i < 50; i++) assert.equal(JSON.stringify(evaluateDecide(rules, { amount: 500 })), a);
  });
});

describe('negotiation', () => {
  const comp = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [{ id: 'm', kind: 'smtp', operations: [{ name: 'send', sideEffect: 'write' }] }],
    workflows: [
      wf([s('a')], { id: 'pure' }),
      wf([{ id: 'e', type: 'extract', determinism: 'model_assisted', timeoutMs: 1, requires: ['structured_output'] }], {
        id: 'needs_model',
        requiresFeatures: ['model_extract'],
      }),
    ],
  } as unknown as WorkflowComponent;
  it('a deterministic-only host runs model-free workflows and refuses the rest with reasons, never half-running them', () => {
    const n = negotiateWorkflows(comp, DETERMINISTIC_HOST);
    assert.deepEqual(n.runnable, ['pure']);
    assert.deepEqual(n.modelFree, ['pure']);
    assert.equal(n.refused[0]?.workflow, 'needs_model');
    assert.match(n.refused[0]?.reasons.join(' ') ?? '', /model_extract/);
  });
  it('refuses every workflow on an unknown semantics version', () => {
    const n = negotiateWorkflows({ ...comp, semanticsVersion: '1.9' }, DETERMINISTIC_HOST);
    assert.deepEqual(n.runnable, []);
  });
});

describe('determinism report', () => {
  it('counts declared classes and keeps provenance', () => {
    const w = wf([s('a', [], { provenance: ['sec 4.2'] }), { id: 'h', type: 'escalate', determinism: 'human', timeoutMs: 1 }]);
    const r = determinismReport(w);
    assert.equal(r.ratio, 0.5);
    assert.deepEqual(r.steps[0]?.provenance, ['sec 4.2']);
    assert.equal(r.steps[1]?.reason, 'hands the case to a human');
  });
});

describe('conformance vectors (what another runtime must reproduce)', () => {
  const vec = JSON.parse(readFileSync(new URL('../conformance/semantics-vectors-1.0.json', import.meta.url), 'utf8'));
  it('decide steps', () => {
    assert.ok(vec.decide.length >= 10);
    for (const c of vec.decide) assert.deepEqual(JSON.parse(JSON.stringify(evaluateDecide(c.step, c.inputs))), c.expected);
  });
  it('identities, external keys and canonical JSON', () => {
    for (const i of vec.identities) assert.equal(approvalIdentity(i.workflow, i.step, i.instance), i.approvalIdentity);
    for (const k of vec.externalKeys) assert.equal(externalIdempotencyKey(k.workflow, k.step, k.rendered), k.key);
    for (const c of vec.canonicalJson) assert.equal(canonicalJson(c.value), c.canonical);
  });
});
