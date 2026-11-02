import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConnectorHost, MapVault, type Connector } from '@xo/connectors';
import { validateWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import {
  ExtractionMemo,
  RunStore,
  StaticReviewerRegistry,
  UsageCaps,
  WorkflowRunner,
  applyPatch,
  compareShadow,
  generateReviewerKeys,
  parseCsv,
  proposeRules,
  signPatchAcceptance,
  validatePatch,
  type Extractor,
  type LoggedCase,
} from '../src/index.js';

const comp = (): WorkflowComponent => {
  const c = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [{ id: 'bank', kind: 'http', operations: [{ name: 'pay', sideEffect: 'write' }] }],
    workflows: [
      {
        id: 'wf',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs: {
          claim: { type: 'string', required: true },
          amount: { type: 'number', required: true },
          region: { type: 'string', required: true },
          note: { type: 'string', maxBytes: 1000 },
        },
        steps: [
          {
            id: 'decide_it',
            type: 'decide',
            determinism: 'deterministic',
            timeoutMs: 1000,
            inputs: { amount: { from: 'input.amount' } },
            method: { kind: 'rules', rules: [{ id: 'tiny', when: 'amount <= 10', set: { verdict: 'approved' } }], onNoMatch: 'escalate' },
            outputs: { verdict: { type: 'enum', enum: ['approved', 'rejected'] } },
          },
          {
            id: 'pay',
            type: 'act',
            determinism: 'deterministic',
            needs: ['decide_it'],
            timeoutMs: 1000,
            connector: 'bank',
            operation: 'pay',
            sideEffect: 'write',
            idempotencyKey: 'pay:{{input.claim}}',
            inputs: { amount: { from: 'input.amount' } },
          },
        ],
        result: { verdict: { from: 'steps.decide_it.verdict' } },
        maxConcurrency: 2,
        runTimeoutMs: 60000,
        cancellation: { onCancel: 'abandon' },
        requiresFeatures: ['rules'],
      },
    ],
  } as unknown as WorkflowComponent;
  assert.deepEqual(
    validateWorkflowComponent(c).issues.filter((i) => i.severity === 'error'),
    [],
  );
  return c;
};

async function rig(over: Record<string, unknown> = {}, c = comp()) {
  const dir = await mkdtemp(join(tmpdir(), 'xo-learn-'));
  const calls: unknown[] = [];
  const conn: Connector = {
    kind: 'http',
    operations: { pay: { sideEffect: 'write', execute: async (a) => (calls.push(a), { ok: true }) } },
  };
  const mk = (extra: Record<string, unknown> = {}) =>
    new WorkflowRunner({
      component: c,
      workflowId: 'wf',
      store: new RunStore(join(dir, 'runs')),
      connectors: new ConnectorHost({
        component: c,
        policy: { connectors: { bank: { grant: ['pay'] } } },
        implementations: { bank: conn },
        vault: new MapVault({}),
      }),
      ...over,
      ...extra,
    });
  return { dir, calls, mk, c };
}

describe('shadow mode', () => {
  it('decides but executes nothing, journals what it would have done, and compares with human decisions from a CSV', async () => {
    const r = await rig({ shadow: true });
    const runner = r.mk();
    await runner.start({ inputs: { claim: 'a', amount: 5, region: 'x' } });
    await runner.start({ inputs: { claim: 'b', amount: 8, region: 'x' } });
    await runner.start({ inputs: { claim: 'c', amount: 500, region: 'x' } }); // workflow cannot decide: defers
    await runner.start({ inputs: { claim: 'd', amount: 9, region: 'x' } });
    assert.equal(r.calls.length, 0);
    const store = new RunStore(join(r.dir, 'runs'));
    const journals = await Promise.all((await store.list()).map((id) => store.read(id)));
    assert.ok(journals.some((j) => j.some((e) => e.type === 'shadow_action')));
    const csv = 'claim,verdict\na,approved\nb,rejected\nc,rejected\nd,approved\nzzz,approved\n';
    const rep = await compareShadow(store, r.c.workflows[0]!, csv, { keyInput: 'claim', resultField: 'verdict' });
    assert.equal(rep.total, 4);
    assert.equal(rep.agree, 2);
    assert.equal(rep.disagree, 1);
    assert.equal(rep.deferred, 1);
    assert.deepEqual(rep.unmatchedHuman, ['zzz']);
    assert.equal(rep.agreementWhenDeciding, 2 / 3);
  });
  it('parses quoted CSV', () => {
    assert.deepEqual(parseCsv('a,b\n"x,1","he said ""hi"""\r\n'), [{ a: 'x,1', b: 'he said "hi"' }]);
  });
});

describe('daily caps (fail closed)', () => {
  it('escalates once the daily limit on side effects is reached, and the limit survives a restart', async () => {
    const r = await rig();
    const caps = () => new UsageCaps(join(r.dir, 'usage'), { effectsPerDay: 2 });
    for (const id of ['a', 'b'])
      assert.equal((await r.mk({ caps: caps() }).start({ inputs: { claim: id, amount: 1, region: 'x' } })).state, 'completed');
    const third = await r.mk({ caps: caps() }).start({ inputs: { claim: 'c', amount: 1, region: 'x' } });
    assert.equal(third.escalation?.code, 'DAILY_CAP');
    assert.equal(r.calls.length, 2);
  });
  it('an unreadable counter file means the cap is unknown, so the run escalates instead of acting', async () => {
    const r = await rig();
    const day = new Date().toISOString().slice(0, 10);
    await import('node:fs/promises').then((m) => m.mkdir(join(r.dir, 'usage'), { recursive: true }));
    await writeFile(join(r.dir, 'usage', `usage-${day}.json`), '{not json');
    const res = await r
      .mk({ caps: new UsageCaps(join(r.dir, 'usage'), { effectsPerDay: 5 }) })
      .start({ inputs: { claim: 'a', amount: 1, region: 'x' } });
    assert.equal(res.escalation?.code, 'CAPS_UNAVAILABLE');
    assert.equal(r.calls.length, 0);
  });
});

describe('structured-first extraction with memoization', () => {
  const withExtract = (): WorkflowComponent => {
    const c = comp();
    const wf: any = c.workflows[0];
    wf.inputs.text = { type: 'string', maxBytes: 2000 };
    wf.inputs.facts = { type: 'json', maxBytes: 1000 };
    wf.inputs.amount.required = false;
    wf.inputs.region.required = false;
    wf.steps.unshift({
      id: 'read',
      type: 'extract',
      determinism: 'model_assisted',
      timeoutMs: 1000,
      instruction: 'extract',
      structuredFirst: true,
      requires: ['structured_output'],
      inputs: { text: { from: 'input.text', optional: true }, structured: { from: 'input.facts', optional: true } },
      outputs: { amount: { type: 'number' } },
    });
    // steps are now [read, decide_it, pay]: both downstream steps take the extracted amount
    wf.steps[1].needs = ['read'];
    wf.steps[1].inputs = { amount: { from: 'steps.read.amount' } };
    wf.steps[2].inputs = { amount: { from: 'steps.read.amount' } };
    wf.requiresFeatures = ['model_extract', 'rules'];
    const v = validateWorkflowComponent(c);
    assert.deepEqual(
      v.issues.filter((i) => i.severity === 'error'),
      [],
    );
    return c;
  };
  it('structured input never calls the model; an identical free-text case calls it once', async () => {
    let calls = 0;
    const extractor: Extractor = { extract: async () => (calls++, { facts: { amount: 7 }, modelCalls: 1 }) };
    const c = withExtract();
    const r = await rig({ extractor, memoDir: undefined }, c);
    const memoDir = join(r.dir, 'memo');
    const runner = r.mk({ memoDir });
    assert.equal((await runner.start({ inputs: { claim: 'a', facts: { amount: 3 } } })).state, 'completed');
    assert.equal(calls, 0, 'structured-first: zero model calls');
    await runner.start({ inputs: { claim: 'b', text: 'Refund   for order 7' } });
    await runner.start({ inputs: { claim: 'c', text: ' Refund for order 7 ' } }); // same case after whitespace normalization
    assert.equal(calls, 1, 'identical normalized case reused the validated facts');
    await runner.start({ inputs: { claim: 'd', text: 'a different case' } });
    assert.equal(calls, 2);
  });
  it('a damaged or invalid memo entry is a miss, never a wrong answer; a model-call cap escalates', async () => {
    const extractor: Extractor = { extract: async () => ({ facts: { amount: 7 }, modelCalls: 1 }) };
    const c = withExtract();
    const r = await rig({ extractor }, c);
    const memoDir = join(r.dir, 'memo');
    await new ExtractionMemo(memoDir).set(ExtractionMemo.key('extract', (c.workflows[0]!.steps[0] as any).outputs, 'poisoned'), {
      amount: 'not-a-number' as any,
    });
    const ok = await r.mk({ memoDir }).start({ inputs: { claim: 'p', text: 'poisoned' } });
    assert.equal(ok.state, 'completed');
    const capped = await r
      .mk({ caps: new UsageCaps(join(r.dir, 'u2'), { modelCallsPerDay: 0 }) })
      .start({ inputs: { claim: 'q', text: 'new text' } });
    assert.equal(capped.escalation?.code, 'DAILY_CAP');
  });
});

describe('promotion loop (never auto-applied)', () => {
  const keys = generateReviewerKeys();
  const other = generateReviewerKeys();
  const registry = new StaticReviewerRegistry([
    { id: 'pub', roles: ['publisher'], publicKeyPem: keys.publicKeyPem },
    { id: 'rev', roles: ['reviewer'], publicKeyPem: other.publicKeyPem },
  ]);
  const cases = (): LoggedCase[] => [
    ...Array.from({ length: 6 }, (_, i): LoggedCase => ({
      id: `ok${i}`,
      facts: { amount: 20 + i * 10, region: 'eu' },
      outcome: 'approved',
      source: 'human',
    })),
    ...Array.from({ length: 6 }, (_, i): LoggedCase => ({
      id: `no${i}`,
      facts: { amount: 200 + i * 10, region: 'us' },
      outcome: 'rejected',
      source: 'human',
    })),
  ];
  const wf = () => comp().workflows[0]!;

  it('proposes reviewable rules with supporting cases, and validates them against every logged case', () => {
    const patch = proposeRules(cases(), { workflow: wf(), step: 'decide_it', outputField: 'verdict' });
    assert.ok(patch.rules.length > 0);
    assert.ok(patch.rules.some((r) => r.when === 'amount <= 70' && r.outcome === 'approved' && r.support === 6));
    assert.ok(patch.rules.every((r) => r.caseIds.length >= 5));
    assert.equal(validatePatch(patch, cases()).ok, true);
  });
  it('refuses a patch contradicted by a logged case, or proposed from different cases', () => {
    const patch = proposeRules(cases(), { workflow: wf(), step: 'decide_it', outputField: 'verdict' });
    const poisoned = [...cases(), { id: 'bad', facts: { amount: 30, region: 'eu' }, outcome: 'rejected', source: 'human' } as LoggedCase];
    const v = validatePatch(patch, poisoned);
    assert.equal(v.ok, false);
    assert.match(v.reasons.join(' '), /not the ones|contradict/);
  });
  it('applies only with a verifying signature from a trusted publisher, producing a new version that decides the learned case without a human', async () => {
    const component = comp();
    const patch = proposeRules(cases(), { workflow: wf(), step: 'decide_it', outputField: 'verdict' });
    const good = signPatchAcceptance(keys.privateKeyPem, patch, 'pub');
    assert.throws(
      () => applyPatch(component, patch, cases(), signPatchAcceptance(other.privateKeyPem, patch, 'pub'), registry),
      /signature/,
    );
    assert.throws(
      () => applyPatch(component, patch, cases(), signPatchAcceptance(other.privateKeyPem, patch, 'rev'), registry),
      /publisher/,
    );
    assert.throws(
      () => applyPatch(component, { ...patch, rules: patch.rules.slice(1) }, cases(), good, registry),
      /different patch|support|not the ones/,
    );
    assert.equal(component.workflows[0]!.version, '1.0.0', 'the live component was never mutated');
    const next = applyPatch(component, patch, cases(), good, registry);
    assert.equal(next.workflows[0]!.version, '1.0.1');
    const r = await rig({}, next);
    const res = await r.mk().start({ inputs: { claim: 'new', amount: 60, region: 'eu' } }); // 60 > 10: the old rules escalated this
    assert.equal(res.state, 'completed');
    assert.deepEqual(res.outputs, { verdict: 'approved' });
    const old = await (await rig({}, component)).mk().start({ inputs: { claim: 'new', amount: 60, region: 'eu' } });
    assert.equal(old.state, 'escalated');
  });
});
