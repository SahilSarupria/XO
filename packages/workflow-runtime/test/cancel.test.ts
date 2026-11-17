/**
 * UW-7 (ADR 0024, ADR 0033) — cancellation: recorded first, no dispatch after, settled work stands, an in-flight call becomes an
 * unknown outcome (never "cancelled"), a repeat is harmless; a 300-item batch (UAC-31); orphaned run ids; partial batches.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConnectorError, ConnectorHost, MapVault, type Connector } from '@xo/connectors';
import { validateWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import {
  ApprovalError,
  CancelUnsupportedError,
  LeaseAuthority,
  LeasedRunStore,
  RunStore,
  StaticReviewerRegistry,
  WorkflowRunner,
  effectsOf,
  generateReviewerKeys,
  itemRunId,
  reconcile,
  signDecision,
  type RunStoreLike,
} from '../src/index.js';

const reviewer = generateReviewerKeys();

/** A connector whose calls can be held open, so a test can act while a call is in flight. */
function gatedConnector(o: { failRefs?: readonly string[]; onCall?: (n: number, ref: string) => void } = {}) {
  const sent: string[] = [];
  const entered: { ref: string; at: number }[] = [];
  const gates: (() => void)[] = [];
  let hold = false;
  let n = 0;
  const conn: Connector = {
    kind: 'http',
    operations: {
      send: {
        sideEffect: 'write',
        idempotency: 'none',
        execute: async (a) => {
          const ref = String(a['ref']);
          entered.push({ ref, at: Date.now() });
          o.onCall?.(++n, ref);
          if (hold) await new Promise<void>((r) => gates.push(r));
          if (o.failRefs?.includes(ref)) throw new ConnectorError('INVALID', 'refused by the destination');
          sent.push(ref);
          return { id: `m_${ref}` };
        },
      },
      undo: {
        sideEffect: 'write',
        idempotency: 'supports_key',
        execute: async (a) => (sent.push(`undo:${String(a['ref'])}`), { ok: true }),
      },
    },
  };
  return {
    conn,
    sent,
    entered,
    holdCalls: (v: boolean) => (hold = v),
    releaseAll: () => gates.splice(0).forEach((g) => g()),
    heldCount: () => gates.length,
  };
}

function component(
  o: {
    forEach?: { maxItems: number; concurrency: number };
    approval?: boolean;
    onCancel?: 'abandon' | 'compensate';
    second?: boolean;
  } = {},
): WorkflowComponent {
  const ref = o.forEach !== undefined ? 'item.ref' : 'input.ref';
  const steps: any[] = [];
  if (o.approval === true)
    steps.push({
      id: 'gate',
      type: 'approve',
      determinism: 'human',
      timeoutMs: 600_000,
      roles: ['reviewer'],
      onTimeout: 'escalate',
      onError: 'escalate',
      summary: 'Send {{' + ref + '}}?',
      inputs: { ref: { from: ref } },
      outputs: { decision: { type: 'enum', enum: ['approved', 'rejected'] } },
    });
  steps.push({
    id: 'send',
    type: 'act',
    determinism: 'deterministic',
    ...(o.approval === true ? { needs: ['gate'] } : {}),
    timeoutMs: 5000,
    connector: 'mail',
    operation: 'send',
    sideEffect: 'write',
    inputs: { ref: { from: ref } },
    outputs: { id: { type: 'string' } },
    idempotencyKey: o.forEach !== undefined ? 'send:{{run.index}}' : 'send:{{run.id}}',
    ...(o.onCancel === 'compensate' ? { compensatedBy: 'unsend' } : {}),
  });
  if (o.onCancel === 'compensate')
    steps.push({
      id: 'unsend',
      type: 'compensate',
      determinism: 'deterministic',
      timeoutMs: 5000,
      connector: 'mail',
      operation: 'undo',
      sideEffect: 'write',
      compensates: 'send',
      inputs: { ref: { from: ref } },
      idempotencyKey: 'undo:{{run.id}}',
    });
  if (o.second === true)
    steps.push({
      id: 'again',
      type: 'act',
      determinism: 'deterministic',
      needs: ['send'],
      timeoutMs: 5000,
      connector: 'mail',
      operation: 'send',
      sideEffect: 'write',
      inputs: { ref: { from: ref } },
      idempotencyKey: 'again:{{run.id}}',
    });
  const features = new Set<string>();
  if (o.approval === true) features.add('approve');
  if (o.forEach !== undefined) features.add('for_each');
  if (o.onCancel === 'compensate') features.add('compensation');
  const c = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [
      {
        id: 'mail',
        kind: 'http',
        operations: [
          { name: 'send', sideEffect: 'write' },
          { name: 'undo', sideEffect: 'write' },
        ],
      },
    ],
    workflows: [
      {
        id: 'wf',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs:
          o.forEach !== undefined
            ? { items: { type: 'json', required: true, maxBytes: 200_000 } }
            : { ref: { type: 'string', required: true } },
        steps,
        ...(o.forEach !== undefined ? { forEach: { over: 'items', ...o.forEach } } : {}),
        maxConcurrency: Math.max(2, o.forEach?.concurrency ?? 0),
        runTimeoutMs: 600_000,
        cancellation: { onCancel: o.onCancel ?? 'abandon' },
        requiresFeatures: [...features].sort(),
      },
    ],
  } as unknown as WorkflowComponent;
  assert.deepEqual(
    validateWorkflowComponent(c).issues.filter((i) => i.severity === 'error'),
    [],
  );
  return c;
}

async function setup(c: WorkflowComponent, g = gatedConnector()) {
  const dir = await mkdtemp(join(tmpdir(), 'xo-cancel-'));
  const mk = (store: RunStoreLike = new RunStore(dir), extra: Record<string, unknown> = {}) =>
    new WorkflowRunner({
      component: c,
      workflowId: 'wf',
      store,
      connectors: new ConnectorHost({
        component: c,
        policy: { connectors: { mail: { grant: ['send', 'undo'] } } },
        implementations: { mail: g.conn },
        vault: new MapVault({}),
      }),
      approvals: { reviewers: new StaticReviewerRegistry([{ id: 'ann', roles: ['reviewer'], publicKeyPem: reviewer.publicKeyPem }]) },
      sleep: async () => undefined,
      ...extra,
    });
  return { dir, mk, g, store: new RunStore(dir) };
}

/** A store for a process that is about to die: once `kill` is called it writes nothing more (as a crashed process cannot). */
function mortal(dir: string) {
  const inner = new RunStore(dir);
  let dead = false;
  const store: RunStoreLike = {
    create: (id) => inner.create(id),
    append: (id, t, d) => (dead ? new Promise(() => undefined) : inner.append(id, t, d)),
    read: (id) => inner.read(id),
    list: () => inner.list(),
    requestCancel: (id, r) => inner.requestCancel(id, r),
    cancelRequest: (id) => inner.cancelRequest(id),
  };
  return { store, kill: () => (dead = true) };
}
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(cond(), `timed out waiting for ${what}`);
}

describe('cancelling one run', () => {
  it('a waiting run: cancelled at once, the approval disappears, a decision is refused, a repeat changes nothing', async () => {
    const { mk, g, store } = await setup(component({ approval: true }));
    const runner = mk();
    const started = await runner.start({ inputs: { ref: 'a' }, runId: 'r1' });
    assert.equal(started.state, 'waiting');
    const [request] = await runner.listApprovals();
    const first = await runner.cancel('r1', { by: 'ops-1', reason: 'wrong list' });
    assert.equal(first.state, 'cancelled');
    assert.deepEqual(
      first.cancellation && { by: first.cancellation.by, applied: first.cancellation.applied, reason: first.cancellation.reason },
      {
        by: 'ops-1',
        applied: true,
        reason: 'wrong list',
      },
    );
    assert.deepEqual(await runner.listApprovals(), []);
    assert.deepEqual(g.sent, [], 'nothing was sent');
    const types = (await store.read('r1')).map((e) => e.type);
    assert.ok(types.indexOf('cancel_recorded') < types.indexOf('run_finished'));
    assert.ok(types.includes('step_cancelled'));

    const len = (await store.read('r1')).length;
    const again = await runner.cancel('r1', { by: 'ops-2' });
    assert.equal(again.state, 'cancelled');
    assert.equal(again.cancellation?.by, 'ops-1', 'the first request stands');
    assert.equal((await store.read('r1')).length, len, 'a repeat writes nothing');

    const decision = signDecision(reviewer.privateKeyPem, {
      v: 1,
      approvalId: request!.approvalId,
      runId: 'r1',
      step: 'gate',
      action: 'approve',
      edits: {},
      reviewerId: 'ann',
      at: new Date().toISOString(),
    });
    await assert.rejects(runner.decideApproval('r1', decision), (e) => e instanceof ApprovalError);
    assert.deepEqual(g.sent, []);
  });

  it('a call in flight in this process finishes and is recorded as confirmed; nothing after it is sent', async () => {
    const { mk, g, store, dir } = await setup(component({ second: true }));
    const runner = mk();
    g.holdCalls(true);
    const driving = runner.start({ inputs: { ref: 'a' }, runId: 'r2' });
    await until(() => g.heldCount() === 1, 'the first call');
    const asked = await runner.cancel('r2', { by: 'ops-1' });
    assert.equal(asked.cancellation?.applied, false, 'recorded; the driving loop applies it');
    assert.ok(existsSync(join(dir, 'r2', 'cancel.json')), 'the request is on disk before the run acts on it');
    g.releaseAll();
    const done = await driving;
    assert.equal(done.state, 'cancelled');
    assert.deepEqual(g.sent, ['a'], 'the in-flight call completed; the second step never ran');
    const effects = effectsOf(await store.read('r2'));
    assert.deepEqual(
      effects.map((e) => [e.step, e.state]),
      [['send', 'confirmed_success']],
    );
  });

  it('a call that was sent before a crash becomes outcome_unknown: escalated, never cancelled, never re-sent; a person reconciles it', async () => {
    const { mk, g, store, dir } = await setup(component({ second: true }));
    g.holdCalls(true);
    const doomed = mortal(dir);
    void mk(doomed.store).start({ inputs: { ref: 'a' }, runId: 'r3' }); // this "process" dies with the call open
    await until(() => g.heldCount() === 1, 'the call');
    doomed.kill();
    const other = mk(); // a fresh runner, as after a restart
    const result = await other.cancel('r3', { by: 'ops-1' });
    assert.equal(result.state, 'escalated');
    assert.equal(result.escalation?.code, 'CANCELLED_OUTCOME_UNKNOWN');
    const entries = await store.read('r3');
    assert.ok(!entries.some((e) => e.type === 'step_cancelled' && e.data['step'] === 'send'), 'the sent step is not "cancelled"');
    assert.deepEqual(
      effectsOf(entries).map((e) => e.state),
      ['outcome_unknown'],
    );
    const report = await reconcile(store);
    assert.equal(report.needsAttention, true);
    assert.equal(report.effects[0]?.status, 'ambiguous');

    await assert.rejects(other.recordReconciliation('r3', 'send', { decision: 'confirmed_success', by: 'ops-2', reason: '  ' }));
    const after = await other.recordReconciliation('r3', 'send', {
      decision: 'confirmed_failure_no_effect',
      by: 'ops-2',
      reason: 'not in the Sent folder',
    });
    assert.equal(after.state, 'confirmed_failure_no_effect');
    assert.equal(after.reconciledBy, 'ops-2');
    assert.equal((await reconcile(store)).needsAttention, false);
    await assert.rejects(
      other.recordReconciliation('r3', 'send', { decision: 'confirmed_success', by: 'x', reason: 'y' }),
      /only an unknown/,
    );
    assert.equal(g.entered.length, 1, 'reconciling never re-sends');
    assert.equal((await other.resume('r3')).state, 'escalated', 'the case stays with a person');
    assert.equal(g.entered.length, 1);
  });

  it('onCancel: compensate undoes the completed write and ends compensated, marked as a cancel', async () => {
    const { mk, g } = await setup(component({ approval: true, onCancel: 'compensate', second: true }));
    const runner = mk();
    // approve first so the write happens, then hold the run on a second approval is not available: cancel after completion of send
    await runner.start({ inputs: { ref: 'a' }, runId: 'r4' });
    const [req] = await runner.listApprovals();
    g.holdCalls(true);
    const deciding = runner.decideApproval(
      'r4',
      signDecision(reviewer.privateKeyPem, {
        v: 1,
        approvalId: req!.approvalId,
        runId: 'r4',
        step: 'gate',
        action: 'approve',
        edits: {},
        reviewerId: 'ann',
        at: new Date().toISOString(),
      }),
    );
    await until(() => g.heldCount() === 1, 'the send');
    await runner.cancel('r4', { by: 'ops-1' });
    g.holdCalls(false);
    g.releaseAll();
    const done = await deciding;
    assert.equal(done.state, 'compensated');
    assert.equal((done.outputs as { cancelled?: boolean } | undefined)?.cancelled, true);
    assert.deepEqual(g.sent, ['a', 'undo:a']);
  });

  it('a store that cannot record a cancel refuses it; an unknown run is refused', async () => {
    const { mk, store } = await setup(component());
    const bare: RunStoreLike = {
      create: (id) => store.create(id),
      append: (a, b, c) => store.append(a, b, c),
      read: (id) => store.read(id),
      list: () => store.list(),
    };
    const runner = mk(bare);
    await runner.start({ inputs: { ref: 'a' }, runId: 'r5' });
    await assert.rejects(runner.cancel('r5', { by: 'x' }), (e) => e instanceof CancelUnsupportedError);
    await assert.rejects(mk().cancel('nope', { by: 'x' }), /unknown run/);
  });

  it('a cancel asked while another runner holds the lease is recorded, and that runner stops before its next call', async () => {
    const c = component({ second: true });
    const g = gatedConnector();
    const { dir } = await setup(c, g);
    const base = new RunStore(dir);
    const authority = new LeaseAuthority(join(dir, 'leases'), base);
    const leasedFor = (owner: string) => {
      const leased = new LeasedRunStore(authority, base);
      return {
        store: leased,
        lease: {
          client: authority,
          owner,
          ttlMs: 30_000,
          heartbeatEveryMs: 0,
          attach: (id: string, t: number) => leased.attach(id, owner, t),
          detach: (id: string) => leased.detach(id),
        },
      };
    };
    const mkLeased = (owner: string) => {
      const l = leasedFor(owner);
      return new WorkflowRunner({
        component: c,
        workflowId: 'wf',
        store: l.store,
        lease: l.lease,
        connectors: new ConnectorHost({
          component: c,
          policy: { connectors: { mail: { grant: ['send', 'undo'] } } },
          implementations: { mail: g.conn },
          vault: new MapVault({}),
        }),
        sleep: async () => undefined,
      });
    };
    g.holdCalls(true);
    const a = mkLeased('instance-a');
    const driving = a.start({ inputs: { ref: 'a' }, runId: 'r6' });
    await until(() => g.heldCount() === 1, 'the first call');
    const b = mkLeased('instance-b');
    const asked = await b.cancel('r6', { by: 'ops-1' });
    assert.equal(asked.cancellation?.applied, false, 'instance B recorded it; A holds the run');
    g.holdCalls(false);
    g.releaseAll();
    assert.equal((await driving).state, 'cancelled', 'A applied it before its next call');
    assert.deepEqual(g.sent, ['a']);
  });
});

describe('UAC-31: cancelling a 300-item batch mid-run', () => {
  it('no item starts after the cancel; settled items stand; in-flight items are confirmed; the rest are stopped; a repeat is harmless', async () => {
    const c = component({ forEach: { maxItems: 300, concurrency: 4 } });
    let runner!: WorkflowRunner;
    let cancelling: Promise<unknown> | undefined;
    const g = gatedConnector({
      onCall: (n) => {
        if (n === 60) cancelling = runner.cancel('batch', { by: 'ops-1', reason: 'wrong attachment' });
      },
    });
    const { mk, store } = await setup(c, g);
    runner = mk();
    const items = Array.from({ length: 300 }, (_, i) => ({ ref: `c${i}` }));
    const result = await runner.start({ inputs: { items }, runId: 'batch' });
    await cancelling;
    const sentAtEnd = g.sent.length;
    assert.ok(sentAtEnd >= 60 && sentAtEnd <= 60 + 4, `only the calls already under way finished (${sentAtEnd})`);
    assert.equal(result.state, 'cancelled', JSON.stringify(result.escalation));
    const summary = result.outputs as {
      completed: number;
      cancelledItems: number;
      notStarted: number;
      escalated: number;
      items: { state: string }[];
    };
    assert.equal(summary.completed, sentAtEnd, 'every item that sent is completed and stands');
    assert.equal(summary.completed + summary.cancelledItems + summary.notStarted, 300);
    assert.equal(summary.escalated, 0);
    // Nothing is sent afterwards, whatever resumes the batch.
    await runner.tick();
    await runner.resume('batch');
    assert.equal(g.sent.length, sentAtEnd);
    const repeat = await runner.cancel('batch', { by: 'ops-2' });
    assert.equal(repeat.state, 'cancelled');
    assert.equal(repeat.cancellation?.by, 'ops-1');
    // Every completed item's call is confirmed; no item was both sent and cancelled.
    for (let i = 0; i < 300; i++) {
      const id = itemRunId('batch', i);
      const entries = await store.read(id).catch(() => []);
      const fx = effectsOf(entries);
      if (g.sent.includes(`c${i}`))
        assert.deepEqual(
          fx.map((e) => e.state),
          ['confirmed_success'],
          `item ${i}`,
        );
      else
        assert.ok(
          fx.every((e) => e.state === 'confirmed_failure_no_effect'),
          `item ${i} was not sent`,
        );
    }
  });

  it('an item whose call was in flight when its process died becomes outcome_unknown, and the batch needs a person', async () => {
    const c = component({ forEach: { maxItems: 10, concurrency: 2 } });
    const g = gatedConnector();
    const { mk, dir } = await setup(c, g);
    g.holdCalls(true);
    const doomed = mortal(dir);
    void mk(doomed.store).start({ inputs: { items: Array.from({ length: 10 }, (_, i) => ({ ref: `c${i}` })) }, runId: 'b2' });
    await until(() => g.heldCount() === 2, 'two calls in flight');
    doomed.kill();
    const result = await mk().cancel('b2', { by: 'ops-1' });
    assert.equal(result.state, 'escalated');
    assert.equal(result.escalation?.code, 'ITEMS_NEED_ATTENTION');
    const summary = result.outputs as { outcomeUnknown: number; notStarted: number };
    assert.equal(summary.outcomeUnknown, 2);
    assert.equal(summary.notStarted, 8);
  });
});

describe('spike defects (ADR 0011)', () => {
  it('a run directory with no first entry is recovered by a start with the same id', async () => {
    const { mk, store, g } = await setup(component());
    assert.equal(await store.create('orphan'), true); // a crash between acceptance and run_started
    const r = await mk().start({ inputs: { ref: 'a' }, runId: 'orphan' });
    assert.equal(r.accepted, true);
    assert.equal(r.state, 'completed');
    assert.deepEqual(g.sent, ['a']);
    const again = await mk().start({ inputs: { ref: 'a' }, runId: 'orphan' });
    assert.equal(again.accepted, false, 'a later start is the same run');
    assert.deepEqual(g.sent, ['a']);
  });

  it('a batch where some items fail is partially completed, not just failed', async () => {
    const c = component({ forEach: { maxItems: 5, concurrency: 2 } });
    const { mk } = await setup(c, gatedConnector({ failRefs: ['c1'] }));
    const r = await mk().start({ inputs: { items: Array.from({ length: 5 }, (_, i) => ({ ref: `c${i}` })) }, runId: 'p' });
    assert.equal(r.state, 'failed');
    assert.equal((r.outputs as { outcome: string; completed: number }).outcome, 'partially_completed');
    assert.equal((r.outputs as { completed: number }).completed, 4);
  });
});
