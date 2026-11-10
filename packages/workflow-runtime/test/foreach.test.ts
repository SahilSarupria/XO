import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConnectorError, ConnectorHost, MapVault, type Connector } from '@xo/connectors';
import { validateWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import {
  RunStore,
  StaticReviewerRegistry,
  WorkflowRunner,
  generateReviewerKeys,
  itemRunId,
  signDecision,
  RUNNER_FEATURES,
  type ApprovalRequest,
  type JournalEntry,
  type RunInputError,
  type RunStoreLike,
} from '../src/index.js';

const ann = generateReviewerKeys();

function build(opts: { withApproval?: boolean; concurrency?: number; maxItems?: number } = {}): WorkflowComponent {
  const steps: any[] = [
    {
      id: 'check',
      type: 'decide',
      determinism: 'deterministic',
      timeoutMs: 1000,
      inputs: { amount: { from: 'item.amount' } },
      method: { kind: 'rules', rules: [{ id: 'ok', when: 'amount <= 1000', set: { verdict: 'pay' } }], onNoMatch: 'escalate' },
      outputs: { verdict: { type: 'enum', enum: ['pay'] } },
    },
  ];
  if (opts.withApproval === true)
    steps.push({
      id: 'gate',
      type: 'approve',
      determinism: 'human',
      needs: ['check'],
      timeoutMs: 60_000,
      roles: ['reviewer'],
      onTimeout: 'escalate',
      onError: 'escalate',
      summary: 'Pay {{item.ref}}?',
      inputs: { amount: { from: 'item.amount' } },
      outputs: { decision: { type: 'enum', enum: ['approved', 'rejected'] } },
    });
  steps.push({
    id: 'pay',
    type: 'act',
    determinism: 'deterministic',
    needs: [opts.withApproval === true ? 'gate' : 'check'],
    timeoutMs: 1000,
    connector: 'bank',
    operation: 'pay',
    sideEffect: 'write',
    idempotencyKey: 'pay:{{run.index}}:{{item.ref}}',
    ...(opts.withApproval === true ? { runIf: "decision == 'approved'" } : {}),
    inputs: {
      amount: { from: 'item.amount' },
      ref: { from: 'item.ref' },
      ...(opts.withApproval === true ? { decision: { from: 'steps.gate.decision' } } : {}),
    },
    outputs: { id: { type: 'string' } },
  });
  const c = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [{ id: 'bank', kind: 'http', operations: [{ name: 'pay', sideEffect: 'write' }] }],
    workflows: [
      {
        id: 'wf',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs: { items: { type: 'json', required: true, maxBytes: 100_000 }, batch: { type: 'string', required: true } },
        steps,
        forEach: { over: 'items', maxItems: opts.maxItems ?? 10, concurrency: opts.concurrency ?? 2 },
        result: { id: { from: 'steps.pay.id', ...(opts.withApproval === true ? { optional: true } : {}) } },
        maxConcurrency: 4,
        runTimeoutMs: 60_000,
        cancellation: { onCancel: 'abandon' },
        requiresFeatures: ['for_each', 'rules', ...(opts.withApproval === true ? ['approve'] : [])].sort(),
      },
    ],
  } as unknown as WorkflowComponent;
  assert.deepEqual(
    validateWorkflowComponent(c).issues.filter((i) => i.severity === 'error'),
    [],
  );
  return c;
}

async function setup(opts: Parameters<typeof build>[0] = {}, failRefs: string[] = []) {
  const c = build(opts);
  const dir = await mkdtemp(join(tmpdir(), 'xo-fe-'));
  const effects: string[] = [];
  const seen = new Set<string>();
  let live = 0;
  let peak = 0;
  const conn: Connector = {
    kind: 'http',
    operations: {
      pay: {
        sideEffect: 'write',
        idempotency: 'supports_key',
        execute: async (a, ctx) => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          live--;
          if (failRefs.includes(String(a['ref']))) throw new ConnectorError('INVALID', 'rejected by the destination');
          if (ctx.idempotencyKey !== undefined && seen.has(ctx.idempotencyKey)) return { id: 'dup-suppressed' };
          seen.add(ctx.idempotencyKey ?? '');
          effects.push(String(a['ref']));
          return { id: `p_${a['ref']}` };
        },
      },
    },
  };
  const sunk: ApprovalRequest[] = [];
  const mk = (store: RunStoreLike = new RunStore(join(dir, 'runs')), extra: Record<string, unknown> = {}) =>
    new WorkflowRunner({
      component: c,
      workflowId: 'wf',
      store,
      connectors: new ConnectorHost({
        component: c,
        policy: { connectors: { bank: { grant: ['pay'] } } },
        implementations: { bank: conn },
        vault: new MapVault({}),
      }),
      sleep: async () => undefined,
      ...(opts.withApproval === true
        ? {
            approvals: {
              reviewers: new StaticReviewerRegistry([{ id: 'ann', roles: ['reviewer'], publicKeyPem: ann.publicKeyPem }]),
              sink: (r: ApprovalRequest) => void sunk.push(r),
            },
          }
        : {}),
      ...extra,
    });
  return { dir, effects, sunk, mk, peak: () => peak };
}

const rows = (n: number, over: Record<number, number> = {}) =>
  Array.from({ length: n }, (_, i) => ({ ref: `r${i}`, amount: over[i] ?? 10 + i }));

describe('forEach', () => {
  it('is advertised, and each item acts exactly once with its own key', async () => {
    assert.ok(RUNNER_FEATURES.includes('for_each' as never));
    const s = await setup();
    const r = await s.mk().start({ inputs: { items: rows(5), batch: 'b1' } });
    assert.equal(r.state, 'completed');
    assert.deepEqual([...s.effects].sort(), ['r0', 'r1', 'r2', 'r3', 'r4']);
    const out = r.outputs as any;
    assert.equal(out.completed, 5);
    assert.equal(out.items.length, 5);
    assert.deepEqual(
      out.items.map((i: any) => i.outputs.id),
      ['p_r0', 'p_r1', 'p_r2', 'p_r3', 'p_r4'],
    );
    // re-sending the accepted run and resuming it do not repeat any effect
    assert.equal((await s.mk().resume(r.runId)).state, 'completed');
    assert.equal(s.effects.length, 5);
  });

  it('never runs more than forEach.concurrency items at once', async () => {
    const s = await setup({ concurrency: 3, maxItems: 20 });
    await s.mk().start({ inputs: { items: rows(12), batch: 'b' } });
    assert.ok(s.peak() <= 3, `peak ${s.peak()}`);
    assert.ok(s.peak() >= 2, 'items did run in parallel');
  });

  it('one item escalating or failing leaves the others completed; the parent reports every item', async () => {
    const s = await setup({}, ['r2']);
    const r = await s.mk().start({ inputs: { items: rows(5, { 1: 5000 }), batch: 'b' } }); // r1: no rule matches => escalate; r2: destination refuses
    assert.equal(r.state, 'escalated');
    assert.equal(r.escalation?.code, 'ITEMS_NEED_ATTENTION');
    assert.deepEqual([...s.effects].sort(), ['r0', 'r3', 'r4']);
    const out = r.outputs as any;
    assert.deepEqual(
      out.items.map((i: any) => i.state),
      ['completed', 'escalated', 'failed', 'completed', 'completed'],
    );
    assert.equal(out.completed + out.escalated + out.failed, 5); // nothing dropped
  });

  it('only failures (no escalations) make the parent failed', async () => {
    const s = await setup({}, ['r0']);
    const r = await s.mk().start({ inputs: { items: rows(2), batch: 'b' } });
    assert.equal(r.state, 'failed');
    assert.equal(s.effects.length, 1);
  });

  it('an empty list completes with no items', async () => {
    const s = await setup();
    const r = await s.mk().start({ inputs: { items: [], batch: 'b' } });
    assert.equal(r.state, 'completed');
    assert.equal((r.outputs as any).items.length, 0);
  });

  it('a crash in the middle of the fan-out resumes without repeating an effect', async () => {
    const s = await setup({ concurrency: 1 });
    const inner = new RunStore(join(s.dir, 'runs'));
    let appends = 0;
    const flaky: RunStoreLike = {
      create: (id) => inner.create(id),
      read: (id) => inner.read(id),
      list: () => inner.list(),
      append: async (id, type, data): Promise<JournalEntry> => {
        if (++appends === 14) throw new Error('simulated crash');
        return inner.append(id, type, data);
      },
    };
    await assert.rejects(() => s.mk(flaky).start({ inputs: { items: rows(4), batch: 'crash' }, runId: 'parent1' }), /simulated crash/);
    const r = await s.mk(inner).resume('parent1');
    assert.equal(r.state, 'completed');
    assert.deepEqual([...s.effects].sort(), ['r0', 'r1', 'r2', 'r3']); // each exactly once
  });

  it('refuses bad input before anything runs', async () => {
    const s = await setup({ maxItems: 3 });
    const bad = async (items: unknown): Promise<string> =>
      s
        .mk()
        .start({ inputs: { items, batch: 'b' } })
        .then(
          () => 'ACCEPTED',
          (e: RunInputError) => e.problems.join(';'),
        );
    assert.match(await bad(rows(4)), /at most 3/);
    assert.match(await bad('nope'), /must be an array/);
    assert.match(await bad([{ ref: 'a', amount: { nested: 1 } }]), /string, number, boolean or null/);
    assert.match(await bad([[1, 2]]), /flat object/);
    assert.equal(s.effects.length, 0);
  });

  it('a parent run id is stable and item ids do not collide across parents', () => {
    assert.equal(itemRunId('p', 0), itemRunId('p', 0));
    assert.notEqual(itemRunId('p', 0), itemRunId('p', 1));
    assert.notEqual(itemRunId('p', 1), itemRunId('q', 1));
    assert.match(itemRunId('p', 0), /^fe_[0-9a-f]{40}$/);
  });

  it('each item gets its own approval; deciding one releases only that item and updates the parent', async () => {
    const s = await setup({ withApproval: true });
    const r = await s.mk().start({ inputs: { items: rows(3), batch: 'b' } });
    assert.equal(r.state, 'waiting');
    assert.equal(s.sunk.length, 3);
    assert.equal(new Set(s.sunk.map((a) => a.approvalId)).size, 3);
    assert.equal(s.effects.length, 0);
    const decide = (req: ApprovalRequest, action: 'approve' | 'reject') =>
      signDecision(ann.privateKeyPem, {
        v: 1,
        approvalId: req.approvalId,
        runId: req.runId,
        step: req.step,
        action,
        edits: {},
        reviewerId: 'ann',
        at: new Date().toISOString(),
      } as any);
    const runner = s.mk();
    const first = s.sunk.find((a) => a.summary === 'Pay r1?') as ApprovalRequest;
    await runner.decideApproval(first.runId, decide(first, 'approve'));
    assert.deepEqual(s.effects, ['r1']);
    assert.equal((await s.mk().status(r.runId)).state, 'waiting'); // two items still open
    for (const req of s.sunk.filter((a) => a.runId !== first.runId)) await s.mk().decideApproval(req.runId, decide(req, 'reject'));
    const done = await s.mk().status(r.runId);
    assert.equal(done.state, 'completed');
    assert.deepEqual(s.effects, ['r1']);
    // a decision for one item cannot be replayed against another
    const other = s.sunk.find((a) => a.runId !== first.runId) as ApprovalRequest;
    await assert.rejects(() => s.mk().decideApproval(other.runId, decide(first, 'approve')));
  });
});
