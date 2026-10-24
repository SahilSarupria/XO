import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExternalToolDispatcher,
  InMemoryDispatchLedger,
  type AdapterInvokeRequest,
  type AdapterInvokeResult,
  type DispatchLedger,
  type ExternalToolAdapter,
} from '../src/index.js';

/** Local deterministic fake (this package's tests must not depend on @xo/testing, which depends on this package). */
class Fake implements ExternalToolAdapter {
  readonly calls: AdapterInvokeRequest[] = [];
  readonly approvalMode = 'definition' as const;
  constructor(
    readonly id: string,
    private readonly behave: (req: AdapterInvokeRequest) => Promise<unknown> | unknown,
    private readonly ledger?: InMemoryDispatchLedger,
    readonly seenLedgerAtCall: string[] = [],
  ) {}
  async invoke(req: AdapterInvokeRequest): Promise<AdapterInvokeResult> {
    this.calls.push(req);
    if (this.ledger !== undefined) this.seenLedgerAtCall.push(...this.ledger.read(req.dispatchKey).map((e) => e.state));
    return (await this.behave(req)) as AdapterInvokeResult;
  }
}
const make = (adapter: ExternalToolAdapter, ledger: DispatchLedger = new InMemoryDispatchLedger(), cap = 'cap'): ExternalToolDispatcher =>
  new ExternalToolDispatcher({ adapters: new Map([[cap, adapter]]), ledger, unsafeAllowVolatileLedger: true });

test('no configured adapter: nothing is dispatched (fail closed), even for an id that resembles a configured one', async () => {
  const a = new Fake('a', () => ({ kind: 'confirmed_success', output: 1 }));
  const d = make(a);
  for (const id of ['other', 'cap ', 'CAP', '__proto__', 'constructor', 'toString']) {
    const r = await d.dispatch(id, 'k', {});
    assert.equal(r.kind, 'not_configured', id);
    assert.equal(r.dispatched, false);
  }
  assert.equal(a.calls.length, 0);
  assert.equal(d.isConfigured('cap'), true);
  assert.equal(d.isConfigured('toString'), false);
});

test('invalid request: missing dispatch key or non-object input never reaches the adapter', async () => {
  const a = new Fake('a', () => ({ kind: 'confirmed_success', output: 1 }));
  const d = make(a);
  assert.equal((await d.dispatch('cap', '', {})).kind, 'invalid_request');
  for (const bad of [null, undefined, 'x', 3, [1], true]) assert.equal((await d.dispatch('cap', 'k', bad)).kind, 'invalid_request');
  assert.equal(a.calls.length, 0);
});

test('write-ahead evidence: dispatch_attempted is in the ledger BEFORE the adapter runs; terminal evidence follows; exactly one call', async () => {
  const ledger = new InMemoryDispatchLedger();
  const seen: string[] = [];
  const a = new Fake('a', () => ({ kind: 'confirmed_success', output: { ok: true } }), ledger, seen);
  const r = await make(a, ledger).dispatch('cap', 'k1', { x: 1 });
  assert.equal(r.kind, 'confirmed_success');
  assert.deepEqual(seen, ['dispatch_attempted']);
  assert.deepEqual(
    ledger.all().map((e) => e.state),
    ['dispatch_attempted', 'confirmed_success'],
  );
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0]!.dispatchKey, 'k1');
});

test('confirmed failure with no effect is reported as such, with evidence, after one call', async () => {
  const ledger = new InMemoryDispatchLedger();
  const a = new Fake('a', () => ({ kind: 'confirmed_failure_no_effect', code: 'E1', message: 'refused' }));
  const r = await make(a, ledger).dispatch('cap', 'k', {});
  assert.equal(r.kind, 'confirmed_failure_no_effect');
  assert.deepEqual(
    ledger.all().map((e) => e.state),
    ['dispatch_attempted', 'confirmed_failure_no_effect'],
  );
  assert.equal(a.calls.length, 1);
});

test('ambiguity is never success: a throw, a rejection, an unknown report and every malformed reply are outcome_unknown; one call each', async () => {
  const replies: Array<[string, () => unknown]> = [
    [
      'throw',
      () => {
        throw new Error('boom');
      },
    ],
    ['reject', () => Promise.reject(new Error('nope'))],
    ['reported unknown', () => ({ kind: 'outcome_unknown', reason: 'timeout' })],
    ['undefined', () => undefined],
    ['string', () => 'ok'],
    ['success without output', () => ({ kind: 'confirmed_success' })],
    ['failure without code', () => ({ kind: 'confirmed_failure_no_effect', message: 'm' })],
    ['unknown kind', () => ({ kind: 'confirmed_succes', output: 1 })],
    ['array', () => [{ kind: 'confirmed_success', output: 1 }]],
  ];
  for (const [label, behave] of replies) {
    const ledger = new InMemoryDispatchLedger();
    const a = new Fake('a', behave);
    const r = await make(a, ledger).dispatch('cap', 'k', {});
    assert.equal(r.kind, 'outcome_unknown', label);
    assert.equal(r.dispatched, true, label);
    assert.equal(a.calls.length, 1, `${label}: no automatic retry`);
    assert.equal(ledger.all().at(-1)!.state, 'outcome_unknown', label);
  }
});

test('one dispatch per key, ever: a second call is refused without calling the adapter; after an unknown outcome it demands reconciliation', async () => {
  const ledger = new InMemoryDispatchLedger();
  const a = new Fake('a', () => {
    throw new Error('dropped');
  });
  const d = make(a, ledger);
  assert.equal((await d.dispatch('cap', 'k', {})).kind, 'outcome_unknown');
  const again = await d.dispatch('cap', 'k', {});
  assert.equal(again.kind, 'blocked_prior_dispatch');
  if (again.kind === 'blocked_prior_dispatch') {
    assert.equal(again.requiresReconciliation, true);
    assert.equal(again.priorState, 'outcome_unknown');
  }
  assert.equal(a.calls.length, 1);

  const ok = new Fake('b', () => ({ kind: 'confirmed_success', output: 1 }));
  const d2 = make(ok);
  assert.equal((await d2.dispatch('cap', 'k', {})).kind, 'confirmed_success');
  const blocked = await d2.dispatch('cap', 'k', {});
  assert.equal(blocked.kind, 'blocked_prior_dispatch');
  if (blocked.kind === 'blocked_prior_dispatch') assert.equal(blocked.requiresReconciliation, false);
  assert.equal(ok.calls.length, 1);
  // a different key is an independent dispatch
  assert.equal((await d2.dispatch('cap', 'k2', {})).kind, 'confirmed_success');
});

test('a prior attempt with no terminal evidence (e.g. a hung or crashed dispatch) also blocks and requires reconciliation', async () => {
  const ledger = new InMemoryDispatchLedger();
  ledger.append({ dispatchKey: 'k', capabilityId: 'cap', adapterId: 'a', state: 'dispatch_attempted' });
  const a = new Fake('a', () => ({ kind: 'confirmed_success', output: 1 }));
  const r = await make(a, ledger).dispatch('cap', 'k', {});
  assert.equal(r.kind, 'blocked_prior_dispatch');
  if (r.kind === 'blocked_prior_dispatch') assert.equal(r.requiresReconciliation, true);
  assert.equal(a.calls.length, 0);
});

test('evidence that cannot be written before dispatch means NO dispatch; terminal evidence that cannot be written means outcome_unknown', async () => {
  const noWrite: DispatchLedger = {
    readByCapability: () => [],
    read: () => [],
    append: () => {
      throw new Error('disk full');
    },
  };
  const a = new Fake('a', () => ({ kind: 'confirmed_success', output: 1 }));
  assert.equal((await make(a, noWrite).dispatch('cap', 'k', {})).kind, 'ledger_unavailable');
  assert.equal(a.calls.length, 0);

  const noRead: DispatchLedger = {
    readByCapability: () => [],
    read: () => {
      throw new Error('unreadable');
    },
    append: () => undefined,
  };
  assert.equal((await make(a, noRead).dispatch('cap', 'k', {})).kind, 'ledger_unavailable');
  assert.equal(a.calls.length, 0);

  let n = 0;
  const failsSecond: DispatchLedger = {
    readByCapability: () => [],
    read: () => [],
    append: () => {
      if (++n === 2) throw new Error('disk full');
    },
  };
  const b = new Fake('b', () => ({ kind: 'confirmed_success', output: 1 }));
  const r = await make(b, failsSecond).dispatch('cap', 'k', {});
  assert.equal(r.kind, 'outcome_unknown');
  assert.equal(b.calls.length, 1);
});

test('the adapter receives a frozen copy of the input; mutating the original afterwards changes nothing', async () => {
  const a = new Fake('a', () => ({ kind: 'confirmed_success', output: 1 }));
  const input = { v: 1 };
  await make(a).dispatch('cap', 'k', input);
  input.v = 2;
  assert.equal(a.calls[0]!.input['v'], 1);
  assert.equal(Object.isFrozen(a.calls[0]!.input), true);
});

test('an unsettled earlier dispatch to a capability blocks every further dispatch to it (any key) until the host reconciles; other capabilities and settled history are unaffected', async () => {
  const ledger = new InMemoryDispatchLedger();
  const a = new Fake('a', (req) => {
    if (req.dispatchKey === 'k1') throw new Error('dropped');
    return { kind: 'confirmed_success', output: 1 };
  });
  const other = new Fake('b', () => ({ kind: 'confirmed_success', output: 2 }));
  const d = new ExternalToolDispatcher({
    adapters: new Map<string, ExternalToolAdapter>([
      ['cap', a],
      ['cap2', other],
    ]),
    ledger,
    unsafeAllowVolatileLedger: true,
  });
  assert.equal((await d.dispatch('cap', 'k1', {})).kind, 'outcome_unknown');
  const blocked = await d.dispatch('cap', 'k2', {});
  assert.equal(blocked.kind, 'blocked_prior_dispatch');
  if (blocked.kind === 'blocked_prior_dispatch') assert.equal(blocked.requiresReconciliation, true);
  assert.equal(a.calls.length, 1, 'no second call to the unreconciled capability');
  assert.equal((await d.dispatch('cap2', 'k3', {})).kind, 'confirmed_success', 'an unrelated capability is unaffected');
  // reconciliation is a host action: a ledger without the unsettled evidence allows dispatch again
  const fresh = new ExternalToolDispatcher({
    adapters: new Map<string, ExternalToolAdapter>([['cap', a]]),
    ledger: new InMemoryDispatchLedger(),
    unsafeAllowVolatileLedger: true,
  });
  assert.equal((await fresh.dispatch('cap', 'k2', {})).kind, 'confirmed_success');
});
