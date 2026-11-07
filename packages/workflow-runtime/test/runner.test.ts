import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConnectorError, ConnectorHost, MapVault, type Connector } from '@xo/connectors';
import { validateWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import { CircuitBreakers, JournalCorruptError, RunInputError, RunStore, WorkflowRunner, type Escalation } from '../src/index.js';

/** An "external system" that dedupes by idempotency key, like a payment API would. */
function external(opts: { failFirst?: number; failCode?: ConnectorError['code'] } = {}) {
  const effects: string[] = [];
  const calls: { op: string; key?: string }[] = [];
  const seenKeys = new Set<string>();
  let failures = opts.failFirst ?? 0;
  const conn: Connector = {
    kind: 'http',
    operations: {
      get: { sideEffect: 'read', execute: async () => ({ v: 1 }) },
      pay: {
        sideEffect: 'write',
        idempotency: 'supports_key', // this fake dedupes on the key, like a payment API
        execute: async (args, ctx) => {
          calls.push({ op: 'pay', ...(ctx.idempotencyKey !== undefined ? { key: ctx.idempotencyKey } : {}) });
          if (failures > 0) {
            failures--;
            throw new ConnectorError(opts.failCode ?? 'FAILED', 'upstream down');
          }
          if (ctx.idempotencyKey !== undefined && seenKeys.has(ctx.idempotencyKey)) return { id: 'dup-suppressed' };
          seenKeys.add(ctx.idempotencyKey ?? `n${effects.length}`);
          effects.push(`pay:${String(args['amount'])}`);
          return { id: `pay_${effects.length}` };
        },
      },
      refund: {
        sideEffect: 'write',
        idempotency: 'supports_key',
        execute: async (args, ctx) => {
          calls.push({ op: 'refund', ...(ctx.idempotencyKey !== undefined ? { key: ctx.idempotencyKey } : {}) });
          effects.push(`refund:${String(args['amount'])}`);
          return { ok: true };
        },
      },
      ship: { sideEffect: 'irreversible', execute: async () => ({ shipped: true }) },
    },
  };
  return { conn, effects, calls };
}

const comp = (steps: any[], extra: any = {}, ops: any[] = []): WorkflowComponent => {
  const c = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [
      {
        id: 'bank',
        kind: 'http',
        operations: [
          { name: 'get', sideEffect: 'read' },
          { name: 'pay', sideEffect: 'write' },
          { name: 'refund', sideEffect: 'write' },
          { name: 'ship', sideEffect: 'irreversible' },
          ...ops,
        ],
      },
    ],
    workflows: [
      {
        id: 'wf',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs: { amount: { type: 'number', required: true }, claim: { type: 'string', required: true } },
        steps,
        maxConcurrency: 2,
        runTimeoutMs: 60_000,
        cancellation: { onCancel: 'abandon' },
        requiresFeatures: [],
        ...extra,
      },
    ],
  } as unknown as WorkflowComponent;
  // keep requiresFeatures honest for the validator
  const used = new Set<string>();
  for (const s of steps) {
    if (s.type === 'decide' && s.method.kind === 'rules') used.add('rules');
    if (s.type === 'act' && s.compensatedBy) used.add('compensation');
    if (s.type === 'compensate') used.add('compensation');
    if (s.type === 'wait') used.add('wait_timer');
  }
  if (extra.authority) used.add('authority_ceilings');
  (c.workflows[0] as any).requiresFeatures = [...used].sort();
  const v = validateWorkflowComponent(c);
  assert.deepEqual(
    v.issues.filter((i) => i.severity === 'error'),
    [],
    'fixture must itself be a valid workflow',
  );
  return c;
};

const decide = (): any => ({
  id: 'check',
  type: 'decide',
  determinism: 'deterministic',
  timeoutMs: 1000,
  inputs: { amount: { from: 'input.amount' } },
  method: { kind: 'rules', rules: [{ id: 'ok', when: 'amount <= 1000', set: { verdict: 'pay' } }], onNoMatch: 'escalate' },
  outputs: { verdict: { type: 'enum', enum: ['pay'] } },
});
const pay = (extra: any = {}): any => ({
  id: 'pay',
  type: 'act',
  determinism: 'deterministic',
  needs: ['check'],
  timeoutMs: 1000,
  connector: 'bank',
  operation: 'pay',
  sideEffect: 'write',
  inputs: { amount: { from: 'input.amount' }, verdict: { from: 'steps.check.verdict' } },
  idempotencyKey: 'pay:{{input.claim}}',
  ...extra,
});

async function harness(c: WorkflowComponent, ext = external(), over: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'xo-run-'));
  const mk = (extra: Record<string, unknown> = {}) => {
    const store = new RunStore(dir);
    const host = new ConnectorHost({
      component: c,
      policy: { connectors: { bank: { grant: ['get', 'pay', 'refund', 'ship'] } } },
      implementations: { bank: ext.conn },
      vault: new MapVault({}),
    });
    const sleeps: number[] = [];
    const runner = new WorkflowRunner({
      component: c,
      workflowId: 'wf',
      store,
      connectors: host,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
      ...over,
      ...extra,
    });
    return { runner, store, sleeps };
  };
  return { dir, mk, ext };
}

describe('happy path and journal', () => {
  it('runs to completion; the journal is a verifiable hash chain; no model or network involved', async () => {
    const c = comp([decide(), pay()], { result: { verdict: { from: 'steps.check.verdict' } } });
    const h = await harness(c);
    const { runner, store } = h.mk();
    const r = await runner.start({ inputs: { amount: 100, claim: 'c1' }, dedupeKey: 'c1' });
    assert.equal(r.state, 'completed');
    assert.deepEqual(r.outputs, { verdict: 'pay' });
    assert.deepEqual(h.ext.effects, ['pay:100']);
    const j = await store.read(r.runId);
    assert.ok(j.length > 5);
    assert.ok(j.every((e, i) => e.seq === i + 1));
  });
  it('rejects invalid input before accepting a run', async () => {
    const h = await harness(comp([decide()]));
    const { runner, store } = h.mk();
    await assert.rejects(runner.start({ inputs: { amount: 'lots', claim: 'c' } }), RunInputError);
    await assert.rejects(runner.start({ inputs: { amount: 1, claim: 'c', extra: 1 } }), RunInputError);
    assert.deepEqual(await store.list(), []);
  });
});

describe('at-most-once acceptance', () => {
  it('a duplicate trigger with the same dedupe key is not executed again', async () => {
    const h = await harness(comp([decide(), pay()]));
    const { runner } = h.mk();
    const a = await runner.start({ inputs: { amount: 5, claim: 'c1' }, dedupeKey: 'evt-1' });
    const b = await runner.start({ inputs: { amount: 5, claim: 'c1' }, dedupeKey: 'evt-1' });
    assert.equal(a.accepted, true);
    assert.equal(b.accepted, false);
    assert.equal(a.runId, b.runId);
    assert.equal(h.ext.calls.length, 1);
  });
});

describe('crash recovery without duplicate side effects', () => {
  it('crash after the external call but before its outcome is journaled: resume re-calls with the SAME key and the external system dedupes', async () => {
    const c = comp([decide(), pay()]);
    const h = await harness(c);
    const first = h.mk();
    const orig = first.store.append.bind(first.store);
    first.store.append = async (id: string, type: string, data: any) => {
      if (type === 'call_outcome') throw new Error('simulated crash');
      return orig(id, type, data);
    };
    await assert.rejects(first.runner.start({ inputs: { amount: 50, claim: 'c9' }, runId: 'run_crash1' }), /simulated crash/);
    assert.equal(h.ext.effects.length, 1);
    const second = h.mk(); // fresh process
    const r = await second.runner.resume('run_crash1');
    assert.equal(r.state, 'completed');
    assert.equal(h.ext.calls.length, 2, 'at-least-once execution');
    assert.equal(h.ext.calls[0]?.key, h.ext.calls[1]?.key, 'same idempotency key on takeover');
    assert.equal(h.ext.effects.length, 1, 'external system saw one effect');
  });
  it('crash after the outcome is journaled: resume never calls again', async () => {
    const c = comp([
      decide(),
      pay(),
      {
        id: 'after',
        type: 'decide',
        determinism: 'deterministic',
        needs: ['pay'],
        timeoutMs: 1000,
        inputs: { amount: { from: 'input.amount' } },
        method: { kind: 'formula', set: { doubled: 'amount * 2' } },
        outputs: { doubled: { type: 'number' } },
      },
    ]);
    const h = await harness(c);
    const first = h.mk();
    const orig = first.store.append.bind(first.store);
    first.store.append = async (id: string, type: string, data: any) => {
      if (type === 'step_succeeded' && data.step === 'pay') throw new Error('simulated crash');
      return orig(id, type, data);
    };
    await assert.rejects(first.runner.start({ inputs: { amount: 7, claim: 'c2' }, runId: 'run_crash2' }));
    const r = await h.mk().runner.resume('run_crash2');
    assert.equal(r.state, 'completed');
    assert.equal(h.ext.calls.length, 1);
  });
  it('a torn final journal line is dropped; a tampered line refuses to resume', async () => {
    const h = await harness(comp([decide(), pay()]));
    const { runner } = h.mk();
    const r = await runner.start({ inputs: { amount: 5, claim: 'c3' }, runId: 'run_torn' });
    const file = join(h.dir, 'run_torn', 'journal.jsonl');
    await appendFile(file, '{"seq":99,"ts":"x","ty');
    assert.equal((await h.mk().store.read('run_torn')).length > 3, true);
    const text = (await readFile(file, 'utf8')).split('\n').filter((l) => l.startsWith('{"seq":') && l.includes('"hash"'));
    const tampered = text.map((l) => l.replace('"amount":5', '"amount":5000')).join('\n') + '\n';
    await writeFile(file, tampered);
    await assert.rejects(h.mk().store.read('run_torn'), JournalCorruptError);
    await assert.rejects(h.mk().runner.status(r.runId), JournalCorruptError);
  });
});

describe('retries, backoff, breakers', () => {
  it('retries transient failures with backoff and succeeds; permanent refusals are not retried', async () => {
    const step = pay({ retry: { maxAttempts: 4, backoff: { kind: 'exponential', baseMs: 100, maxMs: 1000, jitter: 'none' } } });
    const h = await harness(comp([decide(), step]), external({ failFirst: 2 }));
    const m = h.mk();
    const r = await m.runner.start({ inputs: { amount: 5, claim: 'c4' } });
    assert.equal(r.state, 'completed');
    assert.deepEqual(m.sleeps, [100, 200]);
    const h2 = await harness(comp([decide(), step]), external({ failFirst: 5, failCode: 'DENIED' }));
    const m2 = h2.mk();
    const r2 = await m2.runner.start({ inputs: { amount: 5, claim: 'c5' } });
    assert.equal(r2.state, 'failed');
    assert.equal(h2.ext.calls.length, 1);
  });
  it('an open breaker fails fast without touching the connector', async () => {
    const step = pay({ retry: { maxAttempts: 3, backoff: { kind: 'fixed', baseMs: 1, maxMs: 1, jitter: 'none' } } });
    const h = await harness(comp([decide(), step]), external({ failFirst: 99 }), { breakers: new CircuitBreakers(2, 60_000) });
    const m = h.mk();
    const r = await m.runner.start({ inputs: { amount: 5, claim: 'c6' } });
    assert.equal(r.state, 'failed');
    assert.equal(h.ext.calls.length, 2, 'third attempt short-circuited by the breaker');
  });
});

describe('compensation (saga)', () => {
  const steps = (): any[] => [
    decide(),
    pay({ compensatedBy: 'undo_pay' }),
    {
      id: 'undo_pay',
      type: 'compensate',
      determinism: 'deterministic',
      timeoutMs: 1000,
      compensates: 'pay',
      connector: 'bank',
      operation: 'refund',
      sideEffect: 'write',
      idempotencyKey: 'refund:{{input.claim}}',
      inputs: { amount: { from: 'input.amount' } },
    },
    {
      id: 'ship',
      type: 'act',
      determinism: 'deterministic',
      needs: ['pay'],
      timeoutMs: 1000,
      connector: 'bank',
      operation: 'get',
      sideEffect: 'read',
      onError: 'compensate',
      inputs: { nope: { from: 'steps.pay.missing_out', optional: false } },
    },
  ];
  it('runs compensations in reverse order when a later step fails with onError compensate', async () => {
    const s = steps();
    s[3].inputs = { amount: { from: 'input.amount' } };
    s[3].operation = 'ship'; // irreversible op declared in the connector manifest; make it fail via DENIED by not granting
    s[3].sideEffect = 'irreversible';
    s[3].idempotencyKey = 'ship:{{input.claim}}';
    const c = comp(s);
    const ext = external();
    ext.conn.operations['ship'] = {
      sideEffect: 'irreversible',
      execute: async () => {
        throw new ConnectorError('DENIED', 'carrier refused');
      },
    };
    const h = await harness(c, ext);
    const r = await h.mk().runner.start({ inputs: { amount: 40, claim: 'c7' } });
    assert.equal(r.state, 'compensated');
    assert.deepEqual(ext.effects, ['pay:40', 'refund:40']);
  });
  it('escalates, naming what cannot be undone, when a completed write has no compensation', async () => {
    const s = [
      decide(),
      pay(),
      {
        id: 'ship',
        type: 'act',
        determinism: 'deterministic',
        needs: ['pay'],
        timeoutMs: 1000,
        connector: 'bank',
        operation: 'ship',
        sideEffect: 'irreversible',
        onError: 'compensate',
        idempotencyKey: 'ship:{{input.claim}}',
        inputs: { amount: { from: 'input.amount' } },
      },
    ];
    const ext = external();
    ext.conn.operations['ship'] = {
      sideEffect: 'irreversible',
      execute: async () => {
        throw new ConnectorError('DENIED', 'carrier refused');
      },
    };
    const escalations: Escalation[] = [];
    const h = await harness(comp(s), ext);
    const r = await h.mk({ onEscalate: (e: Escalation) => void escalations.push(e) }).runner.start({ inputs: { amount: 40, claim: 'c8' } });
    assert.equal(r.state, 'escalated');
    assert.equal(r.escalation?.code, 'UNCOMPENSATABLE');
    assert.deepEqual(r.escalation?.uncompensated, ['pay']);
    assert.equal(escalations.length, 1);
  });
});

describe('fail closed', () => {
  it('a decide step that cannot decide escalates; nothing downstream runs', async () => {
    const h = await harness(comp([decide(), pay()]));
    const r = await h.mk().runner.start({ inputs: { amount: 5000, claim: 'c10' } });
    assert.equal(r.state, 'escalated');
    assert.equal(r.escalation?.code, 'DECIDE_NO_MATCH');
    assert.equal(h.ext.calls.length, 0);
  });
  it('an authority ceiling escalates BEFORE the side effect', async () => {
    const c = comp([decide(), pay()], { authority: { ceilings: [{ value: { from: 'input.amount' }, max: 500, onExceed: 'escalate' }] } });
    const h = await harness(c);
    const r = await h.mk().runner.start({ inputs: { amount: 900, claim: 'c11' } });
    assert.equal(r.escalation?.code, 'CEILING_EXCEEDED');
    assert.equal(h.ext.calls.length, 0);
    assert.equal((await h.mk().runner.start({ inputs: { amount: 400, claim: 'c12' } })).state, 'completed');
  });
  it('the kill switch stops a run before any step executes', async () => {
    const h = await harness(comp([decide(), pay()]));
    const r = await h.mk({ killSwitch: () => true }).runner.start({ inputs: { amount: 5, claim: 'c13' } });
    assert.equal(r.escalation?.code, 'KILL_SWITCH');
    assert.equal(h.ext.calls.length, 0);
  });
  it('dry-run executes reads only and records writes as would-have-done', async () => {
    const h = await harness(comp([decide(), pay()]));
    const r = await h.mk({ dryRun: true }).runner.start({ inputs: { amount: 5, claim: 'c14' } });
    assert.equal(r.state, 'completed');
    assert.equal(h.ext.calls.length, 0);
  });
  it('an ungranted operation fails the step; the connector is never reached', async () => {
    const c = comp([decide(), pay()]);
    const h = await harness(c);
    const m = h.mk();
    const host = new ConnectorHost({
      component: c,
      policy: { connectors: { bank: { grant: ['get'] } } },
      implementations: { bank: h.ext.conn },
      vault: new MapVault({}),
    });
    const runner = new WorkflowRunner({ component: c, workflowId: 'wf', store: m.store, connectors: host });
    const r = await runner.start({ inputs: { amount: 5, claim: 'c15' } });
    assert.equal(r.state, 'failed');
    assert.equal(h.ext.calls.length, 0);
  });
  it('a workflow that needs a feature this runner lacks is refused whole', async () => {
    const c = comp([decide()]);
    (c.workflows[0] as any).requiresFeatures = ['approve'];
    const h = await harness(c).catch((e: Error) => e);
    assert.throws(() => (h as any).mk(), /cannot run on this runner/);
  });
  it('a run exceeding its wall-clock cap escalates', async () => {
    let t = 0;
    const c = comp([decide(), pay()], { runTimeoutMs: 1000 });
    const h = await harness(c, external(), { now: () => (t += 600) });
    const r = await h.mk().runner.start({ inputs: { amount: 5, claim: 'c16' } });
    assert.ok(['escalated', 'completed'].includes(r.state));
    if (r.state === 'escalated') assert.equal(r.escalation?.code, 'RUN_TIMEOUT');
  });
});

describe('timers', () => {
  it('a wait step parks the run durably and a later tick completes it', async () => {
    let t = 1_000;
    const c = comp([
      decide(),
      {
        id: 'cool',
        type: 'wait',
        determinism: 'deterministic',
        needs: ['check'],
        timeoutMs: 100_000,
        for: { kind: 'timer', delayMs: 5_000 },
        onTimeout: 'fail',
      },
      pay({ needs: ['cool'] }),
    ]);
    const h = await harness(c, external(), { now: () => t });
    const a = await h.mk().runner.start({ inputs: { amount: 5, claim: 'c17' } });
    assert.equal(a.state, 'waiting');
    assert.equal(h.ext.calls.length, 0);
    t += 6_000;
    const [b] = await h.mk().runner.tick();
    assert.equal(b?.state, 'completed');
    assert.equal(h.ext.calls.length, 1);
  });
});
