import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryDispatchLedger, assessRetention } from '../src/index.js';

const L = () => new InMemoryDispatchLedger();
const mk = (
  ledger: InMemoryDispatchLedger,
  key: string,
  states: ('dispatch_attempted' | 'confirmed_success' | 'confirmed_failure_no_effect' | 'outcome_unknown')[],
  extra = {},
) => {
  for (const state of states) ledger.append({ dispatchKey: key, capabilityId: 'cap', adapterId: 'a', state, ...extra });
};
const far = new Date(Date.now() + 10 * 24 * 3_600_000);

test('retention: with no operator period nothing is ever a candidate (no built-in default)', async () => {
  const l = L();
  mk(l, 'ok', ['dispatch_attempted', 'confirmed_success']);
  const r = await assessRetention(l, ['cap'], {}, far);
  assert.equal(
    r.some((i) => i.candidate),
    false,
  );
});

test('retention: unresolved / pending-reconciliation / in-flight evidence is never a candidate, however old', async () => {
  const l = L();
  mk(l, 'unknown', ['dispatch_attempted', 'outcome_unknown']);
  mk(l, 'inflight', ['dispatch_attempted']);
  mk(l, 'done', ['dispatch_attempted', 'confirmed_success']);
  const r = await assessRetention(l, ['cap'], { retentionMs: 1000 }, far);
  const by = Object.fromEntries(r.map((i) => [i.dispatchKey, i]));
  assert.equal(by['unknown']!.candidate, false);
  assert.equal(by['inflight']!.candidate, false);
  assert.equal(by['done']!.candidate, true);
});

test('retention: within the period, or referenced by a later attempt, or the newest no-effect failure, is retained', async () => {
  const l = L();
  mk(l, 'old-fail', ['dispatch_attempted', 'confirmed_failure_no_effect']);
  mk(l, 'retry', ['dispatch_attempted', 'confirmed_success'], {});
  l.append({
    dispatchKey: 'retry2',
    capabilityId: 'cap',
    adapterId: 'a',
    state: 'dispatch_attempted',
    follows: { dispatchKey: 'old-fail', outcome: 'confirmed_failure_no_effect' },
  });
  l.append({ dispatchKey: 'retry2', capabilityId: 'cap', adapterId: 'a', state: 'confirmed_success' });
  const r = Object.fromEntries((await assessRetention(l, ['cap'], { retentionMs: 1000 }, far)).map((i) => [i.dispatchKey, i]));
  assert.equal(r['old-fail']!.candidate, false);
  assert.ok(r['old-fail']!.retainedBecause.some((w) => w.includes('referenced')));
  const young = await assessRetention(l, ['cap'], { retentionMs: 30 * 24 * 3_600_000 }, far);
  assert.equal(
    young.some((i) => i.candidate),
    false,
  );
});

test('retention: the assessment is read-only (the ledger is unchanged)', async () => {
  const l = L();
  mk(l, 'k', ['dispatch_attempted', 'confirmed_success']);
  const before = l.all().length;
  await assessRetention(l, ['cap'], { retentionMs: 1 }, far);
  assert.equal(l.all().length, before);
});
