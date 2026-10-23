import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import {
  BlobDispatchLedger,
  ExternalToolDispatcher,
  type AdapterInvokeRequest,
  type AdapterInvokeResult,
  type ExternalToolAdapter,
} from '../src/index.js';

/** Test clock: two hours ahead of the real one, so approval times built with `later()`/FUTURE are not in the dispatcher's future. */
const skewedClock = (): Date => new Date(Date.now() + 7_200_000);

/**
 * P3 (design decision of this implementation, not a recovered requirement): after a dispatch settles as `confirmed_failure_no_effect`,
 * a NEW attempt on the same capability needs a human approval granted AFTER that settlement. Real durable ledger, real temp directory.
 */
class Adapter implements ExternalToolAdapter {
  readonly calls: AdapterInvokeRequest[] = [];
  constructor(
    readonly id: string,
    private readonly result: () => AdapterInvokeResult,
  ) {}
  async invoke(req: AdapterInvokeRequest): Promise<AdapterInvokeResult> {
    this.calls.push(req);
    return this.result();
  }
}
const noEffect = (): AdapterInvokeResult => ({ kind: 'confirmed_failure_no_effect', code: 'rejected', message: 'provider rejected' });
const success = (): AdapterInvokeResult => ({ kind: 'confirmed_success', output: { done: true } });
const unknown = (): AdapterInvokeResult => ({ kind: 'outcome_unknown', reason: 'lost' });
const human = { id: 'h1', kind: 'human' as const };

const later = (ms = 3_600_000): string => new Date(Date.now() + ms).toISOString();
const earlier = (): string => new Date(Date.now() - 3_600_000).toISOString();

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-fresh-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const boot = (dir: string, adapter: ExternalToolAdapter) => {
  const ledger = new BlobDispatchLedger(new LocalFsBlobStore(dir));
  return { ledger, dispatcher: new ExternalToolDispatcher({ adapters: new Map([['cap', adapter]]), ledger, now: skewedClock }) };
};

test('P3: a confirmed no-effect failure cannot be retried without a fresh approval (none, or one older than the settlement)', async () => {
  await withDir(async (dir) => {
    const first = boot(dir, new Adapter('a', noEffect));
    assert.equal((await first.dispatcher.dispatch('cap', 'e1:s', {}, { approvedAt: earlier() })).kind, 'confirmed_failure_no_effect');
    const next = new Adapter('a', success);
    const w = boot(dir, next); // restart
    const none = await w.dispatcher.dispatch('cap', 'e2:s', {});
    assert.equal(none.kind, 'fresh_approval_required');
    if (none.kind === 'fresh_approval_required') assert.equal(none.previousDispatchKey, 'e1:s');
    assert.equal((await w.dispatcher.dispatch('cap', 'e2:s', {}, { approvedAt: earlier() })).kind, 'fresh_approval_required');
    assert.equal((await w.dispatcher.dispatch('cap', 'e2:s', {}, { approvedAt: 'not a date' })).kind, 'fresh_approval_required');
    assert.equal(next.calls.length, 0, 'the adapter was never called');
    assert.deepEqual(await w.ledger.read('e2:s'), [], 'a refused attempt leaves no claim behind');
  });
});

test('P3: with a fresh approval the new attempt gets a distinct identity and references the prior attempt and its confirmed outcome', async () => {
  await withDir(async (dir) => {
    await boot(dir, new Adapter('a', noEffect)).dispatcher.dispatch('cap', 'e1:s', {});
    const next = new Adapter('a', success);
    const w = boot(dir, next);
    assert.equal((await w.dispatcher.dispatch('cap', 'e2:s', {}, { approvedAt: later() })).kind, 'confirmed_success');
    assert.equal(next.calls.length, 1);
    assert.equal(next.calls[0]!.dispatchKey, 'e2:s');
    const ev = await w.ledger.read('e2:s');
    assert.deepEqual(
      ev.map((e) => e.state),
      ['dispatch_attempted', 'confirmed_success'],
    );
    assert.deepEqual(ev[0]!.follows, { dispatchKey: 'e1:s', outcome: 'confirmed_failure_no_effect' });
    // The old identity is untouched and still refuses redispatch, even with a fresh approval.
    assert.equal((await w.dispatcher.dispatch('cap', 'e1:s', {}, { approvedAt: later() })).kind, 'blocked_prior_dispatch');
    assert.equal(next.calls.length, 1);
    assert.equal((await w.ledger.read('e1:s')).length, 2);
    // The reference survives a restart (strict parse accepts it).
    assert.deepEqual((await boot(dir, next).ledger.read('e2:s'))[0]!.follows?.dispatchKey, 'e1:s');
  });
});

test('P3: a no-effect outcome settled by human reconciliation also requires an approval newer than the reconciliation', async () => {
  await withDir(async (dir) => {
    await boot(dir, new Adapter('a', unknown)).dispatcher.dispatch('cap', 'e1:s', {});
    const next = new Adapter('a', success);
    const w = boot(dir, next);
    const r = await w.dispatcher.reconcile({
      dispatchKey: 'e1:s',
      actor: human,
      decision: 'confirmed_failure_no_effect',
      reason: 'provider confirms nothing was sent',
      evidenceExamined: 'provider log has no record for e1:s',
    });
    assert.equal(r.kind, 'recorded');
    // An approval granted BEFORE the reconciliation cannot authorize a retry based on it.
    assert.equal((await w.dispatcher.dispatch('cap', 'e2:s', {}, { approvedAt: earlier() })).kind, 'fresh_approval_required');
    assert.equal(next.calls.length, 0);
    assert.equal((await w.dispatcher.dispatch('cap', 'e2:s', {}, { approvedAt: later() })).kind, 'confirmed_success');
  });
});

test('P3: an unknown outcome stays blocked even with a fresh approval; only a valid reconciliation with evidence settles it', async () => {
  await withDir(async (dir) => {
    await boot(dir, new Adapter('a', unknown)).dispatcher.dispatch('cap', 'e1:s', {});
    const next = new Adapter('a', success);
    const w = boot(dir, next);
    const blocked = await w.dispatcher.dispatch('cap', 'e2:s', {}, { approvedAt: later() });
    assert.equal(blocked.kind, 'blocked_prior_dispatch');
    // Absence of evidence is not a decision: a no-effect reconciliation without evidence examined is refused and changes nothing.
    const bad = await w.dispatcher.reconcile({
      dispatchKey: 'e1:s',
      actor: human,
      decision: 'confirmed_failure_no_effect',
      reason: 'nothing came back',
      evidenceExamined: '',
    });
    assert.equal(bad.kind, 'invalid_request');
    assert.equal((await w.dispatcher.dispatch('cap', 'e2:s', {}, { approvedAt: later() })).kind, 'blocked_prior_dispatch');
    // `unresolved` records the attempt but keeps everything blocked.
    await w.dispatcher.reconcile({
      dispatchKey: 'e1:s',
      actor: human,
      decision: 'unresolved',
      reason: 'no lookup API',
      evidenceExamined: '',
    });
    assert.equal((await w.dispatcher.dispatch('cap', 'e2:s', {}, { approvedAt: later() })).kind, 'blocked_prior_dispatch');
    assert.equal(next.calls.length, 0);
  });
});

test('P3: a later confirmed success supersedes an earlier no-effect failure (no approval needed again), and a different capability is unaffected', async () => {
  await withDir(async (dir) => {
    await boot(dir, new Adapter('a', noEffect)).dispatcher.dispatch('cap', 'e1:s', {});
    const w = boot(dir, new Adapter('a', success));
    assert.equal((await w.dispatcher.dispatch('cap', 'e2:s', {}, { approvedAt: later() })).kind, 'confirmed_success');
    assert.equal((await w.dispatcher.dispatch('cap', 'e3:s', {})).kind, 'confirmed_success');
    assert.equal((await w.ledger.read('e3:s'))[0]!.follows, undefined);
  });
});

test('P3 freshness: ambiguous or implausible timestamps never authorize a retry (non-canonical, offset, future approval)', async () => {
  await withDir(async (dir) => {
    await boot(dir, new Adapter('a', noEffect)).dispatcher.dispatch('cap', 'e1:s', {});
    const next = new Adapter('a', success);
    const w = boot(dir, next);
    const farFuture = new Date(Date.now() + 10 * 3_600_000).toISOString(); // beyond the dispatcher's clock (two hours ahead)
    for (const approvedAt of [
      later().slice(0, 10), // date only
      later().replace(/\.\d{3}Z$/, 'Z'), // no milliseconds
      later().replace('Z', '+00:00'), // offset form
      '2026-13-45T25:61:61.000Z', // impossible
      farFuture, // later than this host's clock: a skewed or forged stamp must not make a stale approval look fresh
    ]) {
      assert.equal((await w.dispatcher.dispatch('cap', 'e2:s', {}, { approvedAt })).kind, 'fresh_approval_required', approvedAt);
    }
    assert.equal(next.calls.length, 0);
    assert.equal((await w.dispatcher.dispatch('cap', 'e2:s', {}, { approvedAt: later() })).kind, 'confirmed_success');
  });
});

test("P3 freshness: a settlement stamped in the dispatcher clock's future (clock went backwards) fails closed", async () => {
  await withDir(async (dir) => {
    await boot(dir, new Adapter('a', noEffect)).dispatcher.dispatch('cap', 'e1:s', {});
    const ledger = new BlobDispatchLedger(new LocalFsBlobStore(dir));
    const behind = new ExternalToolDispatcher({
      adapters: new Map([['cap', new Adapter('a', success)]]),
      ledger,
      now: () => new Date(Date.now() - 3_600_000),
    });
    assert.equal(
      (await behind.dispatch('cap', 'e2:s', {}, { approvedAt: new Date(Date.now() - 1_800_000).toISOString() })).kind,
      'fresh_approval_required',
    );
  });
});
