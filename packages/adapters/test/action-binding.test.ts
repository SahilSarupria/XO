import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import {
  BlobDispatchLedger,
  CanonicalizationError,
  ExternalToolDispatcher,
  actionDigestOf,
  adapterConfigDigest,
  canonicalJson,
  fingerprintOf,
  parseInstant,
  type AdapterInvokeRequest,
  type AdapterInvokeResult,
  type ExternalToolAdapter,
} from '../src/index.js';

/**
 * Approval/evidence binding to the EXACT external action: strict canonical serialization, adapter security-config digest, per-dispatch
 * action digest, audit correlation references, strict timestamps. Real durable ledger on a temp directory; deterministic fake adapters.
 */
class Adapter implements ExternalToolAdapter {
  readonly calls: AdapterInvokeRequest[] = [];
  constructor(
    readonly id: string,
    readonly securityConfig?: Readonly<Record<string, unknown>>,
  ) {}
  async invoke(req: AdapterInvokeRequest): Promise<AdapterInvokeResult> {
    this.calls.push(req);
    return { kind: 'confirmed_success', output: 1 };
  }
}
async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-binding-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const boot = (dir: string, adapter: ExternalToolAdapter) => {
  const ledger = new BlobDispatchLedger(new LocalFsBlobStore(dir));
  return { ledger, dispatcher: new ExternalToolDispatcher({ adapters: new Map([['cap', adapter]]), ledger }) };
};

test('canonical form: key order and nesting order do not matter; value, type and array-order changes do', () => {
  assert.equal(fingerprintOf({ a: 1, b: { c: [1, 2], d: 'x' } }), fingerprintOf({ b: { d: 'x', c: [1, 2] }, a: 1 }));
  assert.notEqual(fingerprintOf({ a: 1 }), fingerprintOf({ a: 2 }));
  assert.notEqual(fingerprintOf({ a: 1 }), fingerprintOf({ a: '1' }));
  assert.notEqual(fingerprintOf({ a: [1, 2] }), fingerprintOf({ a: [2, 1] }));
  assert.notEqual(fingerprintOf({ a: null }), fingerprintOf({}));
  assert.equal(canonicalJson({ n: -0 }), canonicalJson({ n: 0 }));
});

test('canonical form: unsupported values are refused (never collapsed to null or dropped), and errors never echo the value', () => {
  const secret = 'S3CRET-VALUE-123';
  const cyc: Record<string, unknown> = { token: secret };
  cyc['self'] = cyc;
  const bad: unknown[] = [
    { a: undefined },
    { a: Number.NaN },
    { a: Number.POSITIVE_INFINITY },
    { a: () => 1 },
    { a: Symbol('x') },
    { a: 10n },
    { a: new Date() },
    { a: new Map() },
    { a: [1, , 3] },
    cyc,
  ];
  for (const b of bad) {
    assert.throws(() => canonicalJson(b), CanonicalizationError);
  }
  try {
    canonicalJson({ token: secret, f: () => 1 });
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(!(e as Error).message.includes(secret));
  }
  const deep: Record<string, unknown> = {};
  let cur = deep;
  for (let i = 0; i < 40; i++) cur = (cur['n'] = {}) as Record<string, unknown>;
  assert.throws(() => canonicalJson(deep), CanonicalizationError);
});

test('an input that cannot be canonicalized is refused before any claim or adapter call', async () => {
  await withDir(async (dir) => {
    const adapter = new Adapter('a');
    const { dispatcher, ledger } = boot(dir, adapter);
    const out = await dispatcher.dispatch('cap', 'k', { when: new Date() });
    assert.equal(out.kind, 'invalid_request');
    assert.equal(adapter.calls.length, 0);
    assert.deepEqual(await ledger.read('k'), []);
  });
});

test('adapter security config: any change alters the config digest; key order and absent-vs-empty do not; unsupported config fails construction', () => {
  const base = new Adapter('a', { endpoint: 'https://pay.example', region: 'eu', scopes: ['charge'] });
  const same = new Adapter('a', { scopes: ['charge'], region: 'eu', endpoint: 'https://pay.example' });
  assert.equal(adapterConfigDigest(base), adapterConfigDigest(same));
  assert.equal(adapterConfigDigest(new Adapter('a')), adapterConfigDigest(new Adapter('a', {})));
  for (const changed of [
    new Adapter('a', { endpoint: 'https://pay.example.evil', region: 'eu', scopes: ['charge'] }),
    new Adapter('a', { endpoint: 'https://pay.example', region: 'us', scopes: ['charge'] }),
    new Adapter('a', { endpoint: 'https://pay.example', region: 'eu', scopes: ['charge', 'refund'] }),
    new Adapter('b', { endpoint: 'https://pay.example', region: 'eu', scopes: ['charge'] }),
  ]) {
    assert.notEqual(adapterConfigDigest(base), adapterConfigDigest(changed));
  }
  const keyed = 'sk_live_NEVER_IN_ERRORS';
  assert.throws(
    () =>
      new ExternalToolDispatcher({
        adapters: new Map([['cap', new Adapter('a', { fn: () => keyed, apiKey: keyed })]]),
        ledger: new BlobDispatchLedger(new LocalFsBlobStore('/nonexistent-never-used')),
      }),
    (e: Error) => /cannot be canonicalized/.test(e.message) && !e.message.includes(keyed),
  );
});

test('action digest: bound to capability, adapter identity/config and canonical input; recorded on the claim; carries no values', async () => {
  const a = new Adapter('a', { region: 'eu', account: 'acct-777' });
  const fp = fingerprintOf({ amount: 5, to: 'x' });
  const d = actionDigestOf('cap', a, fp);
  assert.equal(d, actionDigestOf('cap', new Adapter('a', { account: 'acct-777', region: 'eu' }), fingerprintOf({ to: 'x', amount: 5 })));
  assert.notEqual(d, actionDigestOf('cap', a, fingerprintOf({ amount: 6, to: 'x' })));
  assert.notEqual(d, actionDigestOf('cap', new Adapter('a', { region: 'us', account: 'acct-777' }), fp));
  assert.notEqual(d, actionDigestOf('other', a, fp));
  await withDir(async (dir) => {
    const { dispatcher, ledger } = boot(dir, a);
    await dispatcher.dispatch('cap', 'k', { amount: 5, to: 'x' });
    const ev = await ledger.read('k');
    assert.equal(ev[0]!.actionDigest, d);
    assert.equal(ev[0]!.inputFingerprint, fp);
    // Evidence on disk holds identities only: no input value and no config value.
    const files = (await readdir(dir, { recursive: true })).filter((n) => n.endsWith('.json'));
    const text = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('\n');
    for (const forbidden of ['acct-777', '"amount"', '"to"']) assert.ok(!text.includes(forbidden), `ledger leaked ${forbidden}`);
  });
});

test('audit correlation: dispatch entries and reconciliation entries carry the correlation id; invalid ids are refused; survives restart', async () => {
  await withDir(async (dir) => {
    const adapter = new Adapter('a');
    const { dispatcher, ledger } = boot(dir, adapter);
    await dispatcher.dispatch('cap', 'k', {}, { auditCorrelationId: 'req-abc-123' });
    const ev = await ledger.read('k');
    assert.deepEqual(
      ev.map((e) => e.auditCorrelationId),
      ['req-abc-123', 'req-abc-123'],
    );
    const unknownAdapter = new Adapter('a');
    unknownAdapter.invoke = async () => ({ kind: 'outcome_unknown', reason: 'lost' });
    const w = boot(dir, unknownAdapter);
    await w.dispatcher.dispatch('cap', 'k2', {}, { auditCorrelationId: 'req-run-9' });
    const human = { kind: 'human' as const, id: 'h1' };
    const base = { dispatchKey: 'k2', actor: human, decision: 'confirmed_failure_no_effect' as const, reason: 'r', evidenceExamined: 'e' };
    for (const bad of ['', ' bad id', 'x'.repeat(129), '../x']) {
      assert.equal((await w.dispatcher.reconcile({ ...base, auditCorrelationId: bad })).kind, 'invalid_request', JSON.stringify(bad));
    }
    assert.equal((await w.dispatcher.reconcile({ ...base, auditCorrelationId: 'req-recon-1' })).kind, 'recorded');
    const again = await boot(dir, unknownAdapter).ledger.read('k2');
    assert.equal(again.at(-1)!.reconciliation?.auditCorrelationId, 'req-recon-1');
    assert.equal(again[0]!.auditCorrelationId, 'req-run-9');
  });
});

test('timestamps: only exact canonical UTC instants are accepted (no offsets, date-only, missing ms, impossible dates, non-strings)', () => {
  const ok = '2026-10-24T03:51:16.123Z';
  assert.equal(parseInstant(ok), Date.parse(ok));
  for (const bad of [
    '2026-10-24',
    '2026-10-24T03:51:16Z',
    '2026-10-24T09:21:16.123+05:30',
    '2026-02-30T00:00:00.000Z',
    '2026-10-24 03:51:16.123Z',
    'yesterday',
    '',
    undefined,
    null,
    1761277876123,
  ]) {
    assert.equal(parseInstant(bad), undefined, String(bad));
  }
});
