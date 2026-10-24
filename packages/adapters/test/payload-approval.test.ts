import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import {
  BlobDispatchLedger,
  BlobPayloadApprovalStore,
  ExternalToolDispatcher,
  InMemoryDispatchLedger,
  InMemoryPayloadApprovalStore,
  type AdapterInvokeRequest,
  type AdapterInvokeResult,
  type ApprovalMode,
  type ExternalToolAdapter,
} from '../src/index.js';

/**
 * Approval modes (host-declared, interim policy source until the unavailable O-2 spec) and PAYLOAD-LEVEL approval: a human approves the
 * exact canonical input digest for one dispatch key; the approval is single-use, consumed atomically in the durable store; it never
 * unblocks an unknown outcome. Real durable stores on a temp directory; deterministic fake adapters; no external service.
 */
class Adapter implements ExternalToolAdapter {
  readonly calls: AdapterInvokeRequest[] = [];
  constructor(
    readonly id: string,
    readonly approvalMode: ApprovalMode,
    readonly securityConfig: Readonly<Record<string, unknown>> = {},
    private readonly result: () => AdapterInvokeResult = () => ({ kind: 'confirmed_success', output: 1 }),
    readonly summarize?: (input: Readonly<Record<string, unknown>>) => string,
  ) {}
  async invoke(req: AdapterInvokeRequest): Promise<AdapterInvokeResult> {
    this.calls.push(req);
    return this.result();
  }
}
const human = { kind: 'human' as const, id: 'approver-1' };
const wait = (ms = 8): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-payload-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
/** A "process": brand-new store objects over the same directory. */
function boot(dir: string, adapter: ExternalToolAdapter, opts: { approvalsNow?: () => Date } = {}) {
  const store = new LocalFsBlobStore(dir);
  const ledger = new BlobDispatchLedger(store);
  const approvals = new BlobPayloadApprovalStore(store, opts.approvalsNow !== undefined ? { now: opts.approvalsNow } : {});
  const dispatcher = new ExternalToolDispatcher({ adapters: new Map([['cap', adapter]]), ledger, payloadApprovals: approvals });
  return { ledger, approvals, dispatcher };
}
/** Server-side grant exactly as the API does it: the approver supplies the digest and summary computed for the real input. */
async function grant(d: ExternalToolDispatcher, dispatchKey: string, input: Record<string, unknown>) {
  const preview = d.previewAction('cap', input)!;
  return d.grantPayloadApproval({
    dispatchKey,
    capabilityId: 'cap',
    input,
    expectedActionDigest: preview.actionDigest,
    expectedActionSummary: preview.actionSummary,
    approver: human,
  });
}

test('approval mode is REQUIRED and has no default: a missing/invalid mode, or a payload adapter without a durable store, fails construction', () => {
  const ledger = new InMemoryDispatchLedger();
  const noMode = { id: 'a', invoke: async () => ({ kind: 'confirmed_success', output: 1 }) } as unknown as ExternalToolAdapter;
  const badMode = { ...noMode, approvalMode: 'whatever' } as unknown as ExternalToolAdapter;
  for (const a of [noMode, badMode]) {
    assert.throws(
      () => new ExternalToolDispatcher({ adapters: new Map([['cap', a]]), ledger, unsafeAllowVolatileLedger: true }),
      /approvalMode/,
    );
  }
  const payload = new Adapter('a', 'payload');
  assert.throws(
    () => new ExternalToolDispatcher({ adapters: new Map([['cap', payload]]), ledger, unsafeAllowVolatileLedger: true }),
    /no payloadApprovals store/,
  );
  assert.throws(
    () =>
      new ExternalToolDispatcher({
        adapters: new Map([['cap', payload]]),
        ledger,
        unsafeAllowVolatileLedger: false,
        payloadApprovals: new InMemoryPayloadApprovalStore(),
      }),
    /durable|durability/i,
  );
  // The explicit test opt-in still works (and a definition-mode adapter never needs a store).
  assert.doesNotThrow(
    () =>
      new ExternalToolDispatcher({
        adapters: new Map([['cap', payload]]),
        ledger,
        unsafeAllowVolatileLedger: true,
        payloadApprovals: new InMemoryPayloadApprovalStore(),
      }),
  );
});

test('the approval mode is part of the adapter-config digest, so switching modes invalidates earlier approvals; definition mode records that it was permitted', async () => {
  const { adapterConfigDigest } = await import('../src/index.js');
  assert.notEqual(adapterConfigDigest(new Adapter('a', 'definition')), adapterConfigDigest(new Adapter('a', 'payload')));
  await withDir(async (dir) => {
    const a = new Adapter('a', 'definition');
    const { dispatcher, ledger } = boot(dir, a);
    assert.equal((await dispatcher.dispatch('cap', 'k', { x: 1 })).kind, 'confirmed_success');
    const ev = await ledger.read('k');
    assert.equal(ev[0]!.approvalMode, 'definition');
    assert.equal(ev[0]!.payloadApprovalId, undefined);
  });
});

test('payload mode: without an approval nothing is claimed or dispatched, and a fresh procedure approval cannot downgrade it', async () => {
  await withDir(async (dir) => {
    const a = new Adapter('a', 'payload');
    const { dispatcher, ledger } = boot(dir, a);
    const out = await dispatcher.dispatch('cap', 'k', { amount: 5 }, { approvedAt: new Date().toISOString() });
    assert.equal(out.kind, 'payload_approval_required');
    assert.equal(a.calls.length, 0);
    assert.deepEqual(await ledger.read('k'), [], 'no write-ahead claim was made');
  });
});

test('payload mode: the approved digest must match the actual input exactly; equivalent input passes, any change or config change does not', async () => {
  await withDir(async (dir) => {
    const a = new Adapter('a', 'payload', { account: 'acct-1' });
    const { dispatcher, approvals, ledger } = boot(dir, a);
    const granted = await grant(dispatcher, 'k', { amount: 5, to: 'x' });
    assert.equal(granted.kind, 'granted');
    // A changed input is refused, and the approval is NOT spent.
    for (const changed of [{ amount: 6, to: 'x' }, { amount: 5 }, { amount: '5', to: 'x' }, { amount: 5, to: 'x', extra: 1 }]) {
      const out = await dispatcher.dispatch('cap', 'k', changed);
      assert.equal(out.kind, 'payload_approval_required', JSON.stringify(changed));
    }
    // A changed adapter configuration (same input) is a different action: refused too.
    const otherCfg = boot(dir, new Adapter('a', 'payload', { account: 'acct-2' }));
    assert.equal((await otherCfg.dispatcher.dispatch('cap', 'k', { amount: 5, to: 'x' })).kind, 'payload_approval_required');
    assert.equal(a.calls.length, 0);
    const grants = await approvals.grantsFor('k');
    assert.equal(await approvals.consumptionOf(grants[0]!.approvalId), undefined, 'refused attempts do not consume the approval');
    // The same values in a different key order: dispatches exactly once.
    const out = await dispatcher.dispatch('cap', 'k', { to: 'x', amount: 5 });
    assert.equal(out.kind, 'confirmed_success');
    assert.equal(a.calls.length, 1);
    const ev = await ledger.read('k');
    assert.equal(ev[0]!.approvalMode, 'payload');
    assert.equal(ev[0]!.payloadApprovalId, grants[0]!.approvalId);
    assert.equal(
      (await approvals.consumptionOf(grants[0]!.approvalId))?.dispatchKey,
      'k',
      'the consumption record references the dispatch',
    );
  });
});

test('payload mode: an approval is bound to its dispatch key (execution + step) and cannot be used for another', async () => {
  await withDir(async (dir) => {
    const a = new Adapter('a', 'payload');
    const { dispatcher } = boot(dir, a);
    await grant(dispatcher, 'exec1:s', { amount: 5 });
    assert.equal((await dispatcher.dispatch('cap', 'exec2:s', { amount: 5 })).kind, 'payload_approval_required');
    assert.equal(a.calls.length, 0);
  });
});

test('payload mode: an approval is single-use — concurrent consumption has exactly one winner, and concurrent dispatchers dispatch once', async () => {
  await withDir(async (dir) => {
    const a = new Adapter('a', 'payload');
    const { dispatcher, approvals } = boot(dir, a);
    await grant(dispatcher, 'k', { amount: 5 });
    const id = (await approvals.grantsFor('k'))[0]!.approvalId;
    // The authoritative store decides: 12 independent store objects racing to consume one approval.
    const racers = await Promise.all(
      Array.from({ length: 12 }, () => new BlobPayloadApprovalStore(new LocalFsBlobStore(dir)).consume(id, 'k')),
    );
    assert.equal(racers.filter((r) => r.consumed).length, 1);
    // A spent approval does not authorize a dispatch.
    assert.equal((await dispatcher.dispatch('cap', 'k', { amount: 5 })).kind, 'payload_approval_required');
    assert.equal(a.calls.length, 0);
  });
  await withDir(async (dir) => {
    const a = new Adapter('a', 'payload');
    const workers = Array.from({ length: 6 }, () => boot(dir, a));
    await grant(workers[0]!.dispatcher, 'k', { amount: 5 });
    const outs = await Promise.all(workers.map((w) => w.dispatcher.dispatch('cap', 'k', { amount: 5 })));
    assert.equal(outs.filter((o) => o.kind === 'confirmed_success').length, 1);
    assert.equal(a.calls.length, 1, 'one approval, one dispatch, however many concurrent attempts');
  });
});

test('payload mode: a new approval never unblocks an unknown outcome (nor a settled key)', async () => {
  await withDir(async (dir) => {
    const unknown = new Adapter('a', 'payload', {}, () => ({ kind: 'outcome_unknown', reason: 'lost' }));
    const w = boot(dir, unknown);
    await grant(w.dispatcher, 'k1', { amount: 1 });
    assert.equal((await w.dispatcher.dispatch('cap', 'k1', { amount: 1 })).kind, 'outcome_unknown');
    await wait();
    await grant(w.dispatcher, 'k2', { amount: 2 });
    const next = new Adapter('a', 'payload');
    const again = boot(dir, next);
    assert.equal((await again.dispatcher.dispatch('cap', 'k2', { amount: 2 })).kind, 'blocked_prior_dispatch');
    assert.equal(next.calls.length, 0);
    const g = (await again.approvals.grantsFor('k2'))[0]!;
    assert.equal(await again.approvals.consumptionOf(g.approvalId), undefined, 'the blocked attempt did not spend the approval');
    // The unknown key itself cannot be re-approved into a re-dispatch, and a grant for it is refused.
    const regrant = await grant(again.dispatcher, 'k1', { amount: 1 });
    assert.equal(regrant.kind, 'refused');
    if (regrant.kind === 'refused') assert.equal(regrant.reason, 'already_dispatched');
  });
});

test('payload mode after a confirmed no-effect failure: an approval granted before the settlement is stale; one granted after satisfies fresh approval and the new attempt references the old one', async () => {
  await withDir(async (dir) => {
    const noEffect = new Adapter('a', 'payload', {}, () => ({ kind: 'confirmed_failure_no_effect', code: 'rejected', message: 'no' }));
    const first = boot(dir, noEffect);
    // An approval for the NEXT execution is granted before the failure settles.
    const early = boot(dir, noEffect, { approvalsNow: () => new Date(Date.now() - 5_000) });
    await grant(early.dispatcher, 'k2', { amount: 2 });
    await grant(first.dispatcher, 'k1', { amount: 1 });
    assert.equal((await first.dispatcher.dispatch('cap', 'k1', { amount: 1 })).kind, 'confirmed_failure_no_effect');
    await wait();
    const next = new Adapter('a', 'payload');
    const w = boot(dir, next);
    const stale = await w.dispatcher.dispatch('cap', 'k2', { amount: 2 });
    assert.equal(stale.kind, 'payload_approval_required');
    if (stale.kind === 'payload_approval_required') assert.match(stale.reason, /predates the last confirmed no-effect/);
    assert.equal(next.calls.length, 0);
    // A fresh approval, bound to this attempt and exact payload, satisfies the fresh-approval rule.
    await grant(w.dispatcher, 'k2', { amount: 2 });
    assert.equal((await w.dispatcher.dispatch('cap', 'k2', { amount: 2 })).kind, 'confirmed_success');
    const ev = await w.ledger.read('k2');
    assert.deepEqual(ev[0]!.follows, { dispatchKey: 'k1', outcome: 'confirmed_failure_no_effect' });
    assert.ok(ev[0]!.payloadApprovalId);
  });
});

test('granting: only a human; digest AND summary must be those computed for the actual input; summaries never carry input values by default; a throwing summarizer is harmless', async () => {
  await withDir(async (dir) => {
    const secretish = 'SENTINEL-RECIPIENT-777';
    const a = new Adapter('a', 'payload');
    const { dispatcher, approvals } = boot(dir, a);
    const input = { amount: 5, to: secretish };
    const preview = dispatcher.previewAction('cap', input)!;
    assert.ok(!preview.actionSummary.includes(secretish), 'the default summary is value-free');
    const base = { dispatchKey: 'k', capabilityId: 'cap', input, approver: human };
    const wrongDigest = await dispatcher.grantPayloadApproval({
      ...base,
      expectedActionDigest: 'x'.repeat(64),
      expectedActionSummary: preview.actionSummary,
    });
    const wrongSummary = await dispatcher.grantPayloadApproval({
      ...base,
      expectedActionDigest: preview.actionDigest,
      expectedActionSummary: 'something else',
    });
    assert.deepEqual(
      [wrongDigest, wrongSummary].map((r) => r.kind === 'refused' && r.reason),
      ['digest_mismatch', 'summary_mismatch'],
    );
    const notHuman = { ...base, approver: { kind: 'service', id: 'svc' } } as unknown as Parameters<
      typeof dispatcher.grantPayloadApproval
    >[0];
    assert.equal(
      (
        await dispatcher.grantPayloadApproval({
          ...notHuman,
          expectedActionDigest: preview.actionDigest,
          expectedActionSummary: preview.actionSummary,
        })
      ).kind,
      'refused',
    );
    await assert.rejects(
      async () =>
        approvals.grant({
          ...base,
          adapterId: 'a',
          actionDigest: 'd',
          actionSummary: 's',
          approver: { kind: 'service', id: 'svc' } as never,
        }),
      /human/,
    );
    assert.deepEqual(await approvals.grantsFor('k'), [], 'refused grants leave nothing behind');
    const ok = await dispatcher.grantPayloadApproval({
      ...base,
      expectedActionDigest: preview.actionDigest,
      expectedActionSummary: preview.actionSummary,
    });
    assert.equal(ok.kind, 'granted');
    // Stored approval: approver, summary, digest, time — and no input values.
    const files = (await readdir(dir, { recursive: true })).filter((n) => n.endsWith('.json'));
    const text = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('\n');
    assert.ok(text.includes('approver-1') && text.includes(preview.actionDigest));
    assert.ok(!text.includes(secretish), 'no input value is stored in the approval record');
    // A throwing / oversized summarizer falls back to the generic summary.
    const odd = new Adapter('a', 'payload', {}, undefined, () => {
      throw new Error('boom');
    });
    assert.match(boot(dir, odd).dispatcher.previewAction('cap', { a: 1 })!.actionSummary, /External action via adapter "a"/);
    const long = new Adapter('a', 'payload', {}, undefined, () => 'x'.repeat(5000));
    assert.match(boot(dir, long).dispatcher.previewAction('cap', { a: 1 })!.actionSummary, /External action via adapter/);
    // An adapter-provided summary is used verbatim when valid (host-controlled text the approver sees).
    const custom = new Adapter('a', 'payload', {}, undefined, (i) => `Transfer ${String(i['amount'])} units`);
    assert.equal(boot(dir, custom).dispatcher.previewAction('cap', { amount: 9 })!.actionSummary, 'Transfer 9 units');
  });
});

test('granting is refused for definition-mode adapters and for keys that already have dispatch evidence', async () => {
  await withDir(async (dir) => {
    const def = boot(dir, new Adapter('a', 'definition'));
    const p = def.dispatcher.previewAction('cap', { a: 1 })!;
    const r = await def.dispatcher.grantPayloadApproval({
      dispatchKey: 'k',
      capabilityId: 'cap',
      input: { a: 1 },
      expectedActionDigest: p.actionDigest,
      expectedActionSummary: p.actionSummary,
      approver: human,
    });
    assert.equal(r.kind === 'refused' && r.reason, 'not_payload_mode');
  });
});
