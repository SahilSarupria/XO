import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import {
  BlobDispatchLedger,
  ExternalToolDispatcher,
  fingerprintOf,
  reconcileDispatch,
  type AdapterInvokeRequest,
  type AdapterInvokeResult,
  type ExternalToolAdapter,
} from '../src/index.js';

/**
 * The REAL durable path: every test here runs the dispatcher against a `BlobDispatchLedger` backed by `LocalFsBlobStore` on a real
 * temp directory. A "restart" builds a brand-new store, ledger and dispatcher over the same directory (no shared memory), which is
 * what a process restart or a second worker looks like. Adapters are deterministic fakes; nothing calls an external service.
 */

class Adapter implements ExternalToolAdapter {
  readonly calls: AdapterInvokeRequest[] = [];
  constructor(
    readonly id: string,
    private readonly behave: (req: AdapterInvokeRequest) => Promise<unknown> | unknown,
  ) {}
  async invoke(req: AdapterInvokeRequest): Promise<AdapterInvokeResult> {
    this.calls.push(req);
    return (await this.behave(req)) as AdapterInvokeResult;
  }
}
const ok = (): AdapterInvokeResult => ({ kind: 'confirmed_success', output: { done: true } });

/** Controllable failure injection around the real store. */
class FlakyStore extends LocalFsBlobStore {
  failPutIfAbsent: (key: string) => boolean = () => false;
  override async putIfAbsent(key: string, data: Uint8Array | string, options?: { readonly contentType?: string }) {
    if (this.failPutIfAbsent(key)) {
      const { err } = await import('@xo/types');
      const { StorageError, ErrorCode } = await import('@xo/errors');
      return err(new StorageError(ErrorCode.STORAGE_WRITE_FAILED, 'injected store failure'));
    }
    return super.putIfAbsent(key, data, options);
  }
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-ledger-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const boot = (dir: string, adapter: ExternalToolAdapter, cap = 'cap', store: LocalFsBlobStore = new LocalFsBlobStore(dir)) => {
  const ledger = new BlobDispatchLedger(store);
  return { ledger, dispatcher: new ExternalToolDispatcher({ adapters: new Map([[cap, adapter]]), ledger }) };
};
const human = { kind: 'human', id: 'alice' } as const;

/** An approval time later than any settlement made while these tests run. */
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

test('1. success: write-ahead evidence precedes the call, success evidence is durable, and survives a restart', async () => {
  await withDir(async (dir) => {
    const seenAtCall: string[] = [];
    const a = new Adapter('a', async (req) => {
      seenAtCall.push(...(await ledgerOf(dir).read(req.dispatchKey)).map((e) => e.state));
      return ok();
    });
    const { dispatcher } = boot(dir, a);
    const r = await dispatcher.dispatch('cap', 'exec1:s1', { to: 'x' });
    assert.equal(r.kind, 'confirmed_success');
    assert.deepEqual(seenAtCall, ['dispatch_attempted']); // the evidence existed (on disk) BEFORE the adapter ran
    const restarted = boot(dir, new Adapter('a', ok));
    const ev = await restarted.dispatcher.evidenceFor('exec1:s1');
    assert.deepEqual(
      ev.map((e) => e.state),
      ['dispatch_attempted', 'confirmed_success'],
    );
    assert.equal(ev[0]!.inputFingerprint, fingerprintOf({ to: 'x' }));
    assert.ok(ev.every((e) => typeof e.recordedAt === 'string'));
    assert.equal(JSON.stringify(ev).includes('"to"'), false, 'the input itself is never written to the ledger');
  });
});
const ledgerOf = (dir: string): BlobDispatchLedger => new BlobDispatchLedger(new LocalFsBlobStore(dir));

test('2. confirmed external rejection is durable and distinct', async () => {
  await withDir(async (dir) => {
    const a = new Adapter('a', () => ({ kind: 'confirmed_failure_no_effect', code: 'E_REJ', message: 'nope' }));
    const { dispatcher } = boot(dir, a);
    assert.equal((await dispatcher.dispatch('cap', 'k', {})).kind, 'confirmed_failure_no_effect');
    const ev = await boot(dir, a).dispatcher.evidenceFor('k');
    assert.equal(ev.at(-1)!.state, 'confirmed_failure_no_effect');
    assert.equal(ev.at(-1)!.detail, 'E_REJ: nope');
  });
});

test('3. connection loss after the effect occurred is unknown, never success, and is durable', async () => {
  await withDir(async (dir) => {
    let applied = 0;
    const a = new Adapter('a', () => {
      applied++; // the external system DID apply the effect...
      throw new Error('socket hang up'); // ...but the reply never arrived
    });
    const { dispatcher } = boot(dir, a);
    const r = await dispatcher.dispatch('cap', 'k', {});
    assert.equal(r.kind, 'outcome_unknown');
    assert.equal(applied, 1);
    assert.equal((await boot(dir, a).dispatcher.evidenceFor('k')).at(-1)!.state, 'outcome_unknown');
  });
});

test('4. restart after dispatch but before confirmation (crash window): the key and the capability stay blocked; zero adapter calls after restart', async () => {
  await withDir(async (dir) => {
    // First "process": the adapter never answers (the process dies mid-call). Only the write-ahead entry exists.
    const never = new Adapter('a', () => new Promise(() => undefined));
    const first = boot(dir, never);
    void first.dispatcher.dispatch('cap', 'exec1:s1', {});
    await waitFor(async () => (await first.ledger.read('exec1:s1')).length === 1);

    const second = new Adapter('a', ok);
    const restarted = boot(dir, second);
    const same = await restarted.dispatcher.dispatch('cap', 'exec1:s1', {});
    assert.equal(same.kind, 'blocked_prior_dispatch');
    if (same.kind === 'blocked_prior_dispatch') {
      assert.equal(same.priorState, 'dispatch_attempted');
      assert.equal(same.requiresReconciliation, true);
    }
    const other = await restarted.dispatcher.dispatch('cap', 'exec2:s1', {}); // a NEW key is blocked by the unsettled capability
    assert.equal(other.kind, 'blocked_prior_dispatch');
    assert.equal(second.calls.length, 0);
  });
});

test('5. restart after an ambiguous outcome: still blocked, zero adapter calls', async () => {
  await withDir(async (dir) => {
    const { dispatcher } = boot(dir, new Adapter('a', () => ({ kind: 'outcome_unknown', reason: 'timeout' })));
    assert.equal((await dispatcher.dispatch('cap', 'k', {})).kind, 'outcome_unknown');
    const after = new Adapter('a', ok);
    const restarted = boot(dir, after);
    for (const key of ['k', 'k2']) assert.equal((await restarted.dispatcher.dispatch('cap', key, {})).kind, 'blocked_prior_dispatch');
    assert.equal(after.calls.length, 0);
  });
});

test('6. repeated requests with the same dispatch identity never dispatch twice (success and failure alike)', async () => {
  await withDir(async (dir) => {
    const a = new Adapter('a', ok);
    const { dispatcher } = boot(dir, a);
    assert.equal((await dispatcher.dispatch('cap', 'k', {})).kind, 'confirmed_success');
    for (let i = 0; i < 3; i++) assert.equal((await dispatcher.dispatch('cap', 'k', {})).kind, 'blocked_prior_dispatch');
    assert.equal((await boot(dir, a).dispatcher.dispatch('cap', 'k', {})).kind, 'blocked_prior_dispatch');
    assert.equal(a.calls.length, 1);
  });
});

test('7. concurrent workers (separate ledgers/dispatchers over one store) racing for one identity: exactly one adapter call', async () => {
  await withDir(async (dir) => {
    const calls: string[] = [];
    const slow = (name: string) =>
      new Adapter('a', async () => {
        calls.push(name);
        await new Promise((r) => setTimeout(r, 40));
        return ok();
      });
    const workers = Array.from({ length: 6 }, (_, i) => boot(dir, slow(`w${i}`)));
    const results = await Promise.all(workers.map((w) => w.dispatcher.dispatch('cap', 'exec:s', { n: 1 })));
    assert.equal(calls.length, 1, 'only the claim winner may call the adapter');
    assert.equal(results.filter((r) => r.dispatched).length, 1);
    assert.equal(results.filter((r) => r.kind === 'blocked_prior_dispatch').length, 5);
    const ev = await boot(dir, slow('z')).dispatcher.evidenceFor('exec:s');
    assert.deepEqual(
      ev.map((e) => e.state),
      ['dispatch_attempted', 'confirmed_success'],
    );
  });
});

test('8. evidence-store failure BEFORE dispatch: zero adapter calls, nothing recorded as dispatched', async () => {
  await withDir(async (dir) => {
    const store = new FlakyStore(dir);
    store.failPutIfAbsent = (key) => key.includes('/events/');
    const a = new Adapter('a', ok);
    const { dispatcher } = boot(dir, a, 'cap', store);
    const r = await dispatcher.dispatch('cap', 'k', {});
    assert.equal(r.kind, 'ledger_unavailable');
    assert.equal(r.dispatched, false);
    assert.equal(a.calls.length, 0);
    // And an unreadable/corrupt ledger also refuses (fail closed on read).
    const healthy = boot(dir, a);
    assert.equal((await healthy.dispatcher.evidenceFor('k')).length, 0);
  });
});

test('9. evidence-store failure WHILE RECORDING the result: reported unknown, and after a restart the key is still blocked (the write-ahead entry is durable)', async () => {
  await withDir(async (dir) => {
    const store = new FlakyStore(dir);
    store.failPutIfAbsent = (key) => key.endsWith('0000000002.json');
    const a = new Adapter('a', ok);
    const { dispatcher } = boot(dir, a, 'cap', store);
    const r = await dispatcher.dispatch('cap', 'k', {});
    assert.equal(r.kind, 'outcome_unknown'); // the adapter ran, but XO could not record it => never claimed as success
    assert.equal(r.dispatched, true);
    const after = new Adapter('a', ok);
    const restarted = boot(dir, after);
    assert.equal((await restarted.dispatcher.dispatch('cap', 'k', {})).kind, 'blocked_prior_dispatch');
    assert.equal((await restarted.dispatcher.dispatch('cap', 'k2', {})).kind, 'blocked_prior_dispatch');
    assert.equal(after.calls.length, 0);
    assert.equal(a.calls.length, 1);
  });
});

test('corrupt or out-of-sequence evidence fails closed: nothing is dispatched', async () => {
  await withDir(async (dir) => {
    const a = new Adapter('a', ok);
    const { dispatcher } = boot(dir, a);
    assert.equal((await dispatcher.dispatch('cap', 'k', {})).kind, 'confirmed_success');
    const evDir = join(dir, 'external-effects', 'events');
    const [keyDir] = await readdir(evDir);
    await writeFile(join(evDir, keyDir!, '0000000002.json'), '{ not json');
    const r = await boot(dir, a).dispatcher.dispatch('cap', 'k', {});
    assert.equal(r.kind, 'ledger_unavailable');
    await writeFile(join(evDir, keyDir!, '0000000002.json'), JSON.stringify({ schemaVersion: 1, seq: 2, extra: 1 }));
    assert.equal((await boot(dir, a).dispatcher.dispatch('cap', 'k', {})).kind, 'ledger_unavailable');
    assert.equal(a.calls.length, 1);
  });
});

test("an in-flight writer's private staging file (or a crash orphan) in the evidence directory is not evidence and never reads as corruption", async () => {
  await withDir(async (dir) => {
    const a = new Adapter('a', ok);
    const { dispatcher } = boot(dir, a);
    assert.equal((await dispatcher.dispatch('cap', 'k', {})).kind, 'confirmed_success');
    const evDir = join(dir, 'external-effects', 'events');
    const [keyDir] = await readdir(evDir);
    await writeFile(join(evDir, keyDir!, '0000000003.json.1234.deadbeef.tmp'), '{ half written');
    const markerDir = join(dir, 'external-effects', 'by-capability');
    const [capDir] = await readdir(markerDir);
    await writeFile(join(markerDir, capDir!, 'x.json.1234.deadbeef.tmp'), '{ half');
    assert.equal((await boot(dir, a).dispatcher.evidenceFor('k')).length, 2);
    assert.equal((await boot(dir, a).dispatcher.dispatch('cap', 'k2', {})).kind, 'confirmed_success');
  });
});

test('14. reconciliation of an externally confirmed success settles the key durably, records actor/reason/evidence, and unblocks the capability', async () => {
  await withDir(async (dir) => {
    const a = new Adapter('a', () => ({ kind: 'outcome_unknown', reason: 'timeout' }));
    const { dispatcher } = boot(dir, a);
    await dispatcher.dispatch('cap', 'k', { v: 1 });
    const restarted = boot(dir, new Adapter('a', ok));
    const r = await restarted.dispatcher.reconcile({
      dispatchKey: 'k',
      actor: human,
      decision: 'confirmed_success',
      reason: 'checked the provider dashboard',
      evidenceExamined: 'provider message id m-123 shows delivered',
    });
    assert.equal(r.kind, 'recorded');
    const ev = await boot(dir, a).dispatcher.evidenceFor('k');
    assert.deepEqual(
      ev.map((e) => e.state),
      ['dispatch_attempted', 'outcome_unknown', 'confirmed_success'],
    ); // history is preserved, never rewritten
    const rec = ev.at(-1)!.reconciliation!;
    assert.equal(rec.actorId, 'alice');
    assert.equal(rec.evidenceExamined, 'provider message id m-123 shows delivered');
    assert.ok(ev.at(-1)!.recordedAt);
    // Same key can NEVER be dispatched again, even though it is settled as success.
    const next = new Adapter('a', ok);
    const again = boot(dir, next);
    assert.equal((await again.dispatcher.dispatch('cap', 'k', {})).kind, 'blocked_prior_dispatch');
    // A NEW dispatch identity is no longer blocked by the (now settled) capability.
    assert.equal((await again.dispatcher.dispatch('cap', 'k-new', {})).kind, 'confirmed_success');
    assert.equal(next.calls.length, 1);
  });
});

test('15. reconciliation of an externally confirmed failure settles it; the same key stays refused, a NEW identity may proceed', async () => {
  await withDir(async (dir) => {
    const { dispatcher } = boot(dir, new Adapter('a', () => ({ kind: 'outcome_unknown', reason: 'lost' })));
    await dispatcher.dispatch('cap', 'k', {});
    const next = new Adapter('a', ok);
    const w = boot(dir, next);
    const r = await w.dispatcher.reconcile({
      dispatchKey: 'k',
      actor: human,
      decision: 'confirmed_failure_no_effect',
      reason: 'provider confirms nothing was sent',
      evidenceExamined: 'provider log shows no message for idempotency key k',
    });
    assert.equal(r.kind, 'recorded');
    assert.equal(
      (await w.dispatcher.dispatch('cap', 'k', {})).kind,
      'blocked_prior_dispatch',
      'a human clicking retry on the same identity must not redispatch',
    );
    assert.equal(next.calls.length, 0);
    // P3: the settled no-effect failure means a new attempt needs a human approval newer than the settlement (none supplied => blocked).
    assert.equal((await w.dispatcher.dispatch('cap', 'k2', {})).kind, 'fresh_approval_required');
    assert.equal(next.calls.length, 0);
    assert.equal((await w.dispatcher.dispatch('cap', 'k2', {}, { approvedAt: FUTURE })).kind, 'confirmed_success');
  });
});

test('16. an unresolved reconciliation records the attempt but keeps dispatch blocked (key and capability), across restarts', async () => {
  await withDir(async (dir) => {
    const { dispatcher } = boot(dir, new Adapter('a', () => ({ kind: 'outcome_unknown', reason: 'lost' })));
    await dispatcher.dispatch('cap', 'k', {});
    const next = new Adapter('a', ok);
    const w = boot(dir, next);
    const r = await w.dispatcher.reconcile({
      dispatchKey: 'k',
      actor: human,
      decision: 'unresolved',
      reason: 'provider has no API to look it up',
      evidenceExamined: '',
    });
    assert.equal(r.kind, 'recorded');
    if (r.kind === 'recorded') assert.equal(r.state, 'outcome_unknown');
    const again = boot(dir, next);
    assert.equal((await again.dispatcher.dispatch('cap', 'k', {})).kind, 'blocked_prior_dispatch');
    assert.equal((await again.dispatcher.dispatch('cap', 'k2', {})).kind, 'blocked_prior_dispatch');
    assert.equal(next.calls.length, 0);
    assert.equal((await again.dispatcher.evidenceFor('k')).length, 3);
  });
});

test('reconciliation refuses: unknown key (absence of evidence is not proof), missing evidence for a resolving decision, bad input, contradictions', async () => {
  await withDir(async (dir) => {
    const { dispatcher, ledger } = boot(dir, new Adapter('a', () => ({ kind: 'outcome_unknown', reason: 'x' })));
    const base = { actor: human, reason: 'r', evidenceExamined: 'e' } as const;
    assert.equal((await dispatcher.reconcile({ ...base, dispatchKey: 'nope', decision: 'confirmed_failure_no_effect' })).kind, 'not_found');
    await dispatcher.dispatch('cap', 'k', {});
    assert.equal(
      (await dispatcher.reconcile({ ...base, dispatchKey: 'k', decision: 'confirmed_success', evidenceExamined: '  ' })).kind,
      'invalid_request',
    );
    assert.equal(
      (await dispatcher.reconcile({ ...base, dispatchKey: 'k', decision: 'confirmed_success', reason: '' })).kind,
      'invalid_request',
    );
    assert.equal((await dispatcher.reconcile({ ...base, dispatchKey: 'k', decision: 'retry' as never })).kind, 'invalid_request');
    assert.equal(
      (await dispatcher.reconcile({ ...base, actor: { kind: 'human', id: '' }, dispatchKey: 'k', decision: 'confirmed_success' })).kind,
      'invalid_request',
    );
    assert.equal((await ledger.read('k')).length, 2, 'nothing was written by any refused request');
    assert.equal((await dispatcher.reconcile({ ...base, dispatchKey: 'k', decision: 'confirmed_success' })).kind, 'recorded');
    assert.equal((await dispatcher.reconcile({ ...base, dispatchKey: 'k', decision: 'confirmed_failure_no_effect' })).kind, 'conflict');
    assert.equal((await dispatcher.reconcile({ ...base, dispatchKey: 'k', decision: 'unresolved' })).kind, 'conflict');
    assert.equal((await ledger.read('k')).at(-1)!.state, 'confirmed_success', 'a settled dispatch is never reopened or flipped');
    // A ledger that cannot compare-and-append cannot reconcile at all.
    const noCas = await reconcileDispatch(
      { read: () => [], readByCapability: () => [], append: () => undefined },
      { ...base, dispatchKey: 'k', decision: 'confirmed_success' },
    );
    assert.equal(noCas.kind, 'ledger_unavailable');
  });
});

test('18. concurrent reconciliation is safe: identical decisions are idempotent (one entry), contradictory decisions cannot both win', async () => {
  await withDir(async (dir) => {
    const { dispatcher } = boot(dir, new Adapter('a', () => ({ kind: 'outcome_unknown', reason: 'x' })));
    await dispatcher.dispatch('cap', 'k', {});
    const base = { actor: human, reason: 'r', evidenceExamined: 'e', dispatchKey: 'k' } as const;
    const same = await Promise.all(
      Array.from({ length: 6 }, () => boot(dir, new Adapter('a', ok)).dispatcher.reconcile({ ...base, decision: 'confirmed_success' })),
    );
    assert.equal(same.filter((r) => r.kind === 'recorded').length, 1);
    assert.equal(same.filter((r) => r.kind === 'already_resolved').length, 5);
  });
  await withDir(async (dir) => {
    const { dispatcher } = boot(dir, new Adapter('a', () => ({ kind: 'outcome_unknown', reason: 'x' })));
    await dispatcher.dispatch('cap', 'k', {});
    const base = { actor: human, reason: 'r', evidenceExamined: 'e', dispatchKey: 'k' } as const;
    const mixed = await Promise.all(
      (['confirmed_success', 'confirmed_failure_no_effect', 'confirmed_success', 'confirmed_failure_no_effect'] as const).map((decision) =>
        boot(dir, new Adapter('a', ok)).dispatcher.reconcile({ ...base, decision }),
      ),
    );
    assert.equal(mixed.filter((r) => r.kind === 'recorded').length, 1, 'exactly one decision wins');
    const finalState = (await boot(dir, new Adapter('a', ok)).dispatcher.evidenceFor('k')).at(-1)!.state;
    for (const r of mixed) {
      if (r.kind === 'already_resolved') assert.equal(r.state, finalState);
      if (r.kind === 'conflict') assert.equal(r.state, finalState);
    }
  });
});

test('a reconciliation that lands while the adapter is still in flight is kept alongside the adapter result and the outcome is reported unknown (accounts conflict)', async () => {
  await withDir(async (dir) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = new Adapter('a', async () => {
      await gate;
      return ok();
    });
    const w = boot(dir, a);
    const pending = w.dispatcher.dispatch('cap', 'k', {});
    await waitFor(async () => (await w.ledger.read('k')).length === 1);
    const rec = await boot(dir, new Adapter('a', ok)).dispatcher.reconcile({
      dispatchKey: 'k',
      actor: human,
      decision: 'confirmed_failure_no_effect',
      reason: 'looked too early',
      evidenceExamined: 'nothing visible yet',
    });
    assert.equal(rec.kind, 'recorded');
    release();
    const r = await pending;
    assert.equal(r.kind, 'outcome_unknown');
    const ev = await w.ledger.read('k');
    assert.deepEqual(
      ev.map((e) => e.state),
      ['dispatch_attempted', 'confirmed_failure_no_effect', 'outcome_unknown'],
    );
  });
});

test('21. a server restart neither erases evidence nor permits a blind redispatch (full lifecycle across three restarts)', async () => {
  await withDir(async (dir) => {
    const calls: string[] = [];
    const mk = (name: string, result: AdapterInvokeResult) => new Adapter('a', () => (calls.push(name), result));
    assert.equal(
      (await boot(dir, mk('p1', { kind: 'outcome_unknown', reason: 't' })).dispatcher.dispatch('cap', 'k', {})).kind,
      'outcome_unknown',
    );
    assert.equal(
      (await boot(dir, mk('p2', { kind: 'confirmed_success', output: 1 })).dispatcher.dispatch('cap', 'k', {})).kind,
      'blocked_prior_dispatch',
    );
    const p3 = boot(dir, mk('p3', { kind: 'confirmed_success', output: 1 }));
    assert.equal(
      (
        await p3.dispatcher.reconcile({
          dispatchKey: 'k',
          actor: human,
          decision: 'confirmed_failure_no_effect',
          reason: 'r',
          evidenceExamined: 'e',
        })
      ).kind,
      'recorded',
    );
    const p4 = boot(dir, mk('p4', { kind: 'confirmed_success', output: 1 }));
    assert.equal((await p4.dispatcher.dispatch('cap', 'k', {})).kind, 'blocked_prior_dispatch');
    assert.equal((await p4.dispatcher.dispatch('cap', 'k-new', {}, { approvedAt: FUTURE })).kind, 'confirmed_success');
    assert.deepEqual(calls, ['p1', 'p4']);
    assert.equal((await p4.dispatcher.evidenceFor('k')).length, 3);
  });
});

async function waitFor(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not reached');
}
