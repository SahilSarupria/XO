/**
 * C0.4 owner-review hardening. Written FAILING first against the reviewed tree, then fixed. Covers:
 *  (1) revoke/purge outcome handling and same-operationId retries before and after restart, against the REAL audit chain;
 *  (2) malformed (path-like) ids: rejected at the public boundary before any mutation, never truncated or normalized.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import { InMemoryAuditSink, PermissionId, PermissionManager, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { CHAIN_LOG_FILE, readClosedChainedLog, type AuditEvent, type FileOps } from '@xo/audit';
import {
  AuditErrorCode,
  CanonicalAuditRecorder,
  ConnectorRegistry,
  DiscoveryErrorCode,
  EI_AUDIT_EXTENSION_SCHEMA,
  EI_AUDIT_NAMESPACE,
  ENVIRONMENT_INTELLIGENCE_REQUESTER,
  EnvironmentInventory,
  EvidenceId,
  EvidenceLedger,
  EiStateStore,
  LocalFilesystemConnector,
  PermissionManagerAuthorization,
  SourceId,
  acquireSourceContent,
  crossCheckState,
  openEiAuditStore,
  purgeSourceEvidence,
  revokeSourceEvidence,
  type AuditRecorder,
  type ConnectorContext,
  type FilesystemScope,
} from '../src/index.js';
import { TEST_PRINCIPAL, withSandbox } from './helpers.js';
import { readGrant } from './support/audit-grants.js';
import { SRC, SRC2, T, boot, ev, faultOps, hex, lineHas, raw, recIs, seed, trust } from './support/state-fixtures.js';

const auditSchemas = { [EI_AUDIT_NAMESPACE]: EI_AUDIT_EXTENSION_SCHEMA };
const rules: PolicyRule[] = ['data.write', 'data.delete'].map((p) => ({
  id: `allow-${p}`,
  effect: 'ALLOW',
  match: { permission: PermissionId(p), packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER },
}));

/** One "process": a real audit chain + a real state journal, both started. `restart()` is a fresh process over the same files. */
interface World {
  auditDir: string;
  stateDir: string;
  audit: NonNullable<
    Awaited<ReturnType<typeof openEiAuditStore>> extends infer R ? (R extends { ok: true; value: infer V } ? V : never) : never
  >;
  store: EiStateStore;
  inventory: EnvironmentInventory;
  ledger: EvidenceLedger;
  ctx: ConnectorContext;
  started: Awaited<ReturnType<EiStateStore['start']>>;
  close(): Promise<void>;
}
async function world(
  base: string,
  over: { stateOps?: FileOps; wrapAudit?: (r: AuditRecorder) => AuditRecorder; auditEvents?: readonly AuditEvent[] } = {},
): Promise<World> {
  const auditDir = join(base, 'audit');
  const stateDir = join(base, 'state');
  const audit = await openEiAuditStore({ dir: auditDir });
  assert.ok(audit.ok, 'audit chain opens');
  if (!audit.ok) throw new Error('unreachable');
  const opened = await EiStateStore.open({ dir: stateDir, ...(over.stateOps !== undefined ? { ops: over.stateOps } : {}) });
  assert.ok(opened.ok, `state journal opens (${opened.ok ? '' : opened.error.code})`);
  if (!opened.ok) throw new Error('unreachable');
  const inventory = new EnvironmentInventory();
  const ledger = new EvidenceLedger();
  const started = await opened.value.start({
    grant: await readGrant(),
    trust,
    inventory,
    ledger,
    ...(over.auditEvents !== undefined ? { audit: over.auditEvents } : {}),
  });
  const clock = new MockClock();
  const manager = new PermissionManager({ policy: new RuleBasedPolicy(rules), auditSink: new InMemoryAuditSink(), clock });
  const recorder: AuditRecorder =
    over.wrapAudit !== undefined ? over.wrapAudit(new CanonicalAuditRecorder(audit.value)) : new CanonicalAuditRecorder(audit.value);
  const ctx: ConnectorContext = {
    clock,
    authorization: new PermissionManagerAuthorization(manager),
    principal: TEST_PRINCIPAL,
    audit: recorder,
    ledger,
    state: opened.value,
    auditOptions: { acceptTimeoutMs: 2000, attempts: 1 },
  };
  return {
    auditDir,
    stateDir,
    audit: audit.value,
    store: opened.value,
    inventory,
    ledger,
    ctx,
    started,
    close: async () => {
      await opened.value.close();
      await audit.value.close();
    },
  };
}
/** Seed one authorized source with two released evidence ids directly through the store API. */
async function seeded(w: World): Promise<void> {
  assert.ok(w.started.ok);
  seed(w);
  assert.ok((await w.store.syncInventory(trust)).ok);
  assert.ok((await w.store.release(trust, 'op_seed', [ev(1), ev(2)])).ok);
}
async function auditEvents(w: Pick<World, 'auditDir'>): Promise<readonly AuditEvent[]> {
  const r = await readClosedChainedLog(w.auditDir, await readGrant(), { extensionSchemas: auditSchemas });
  assert.ok(r.ok, 'audit chain reads');
  return r.ok ? r.value : [];
}
const forOp = (events: readonly AuditEvent[], op: string, phase: 'attempt' | 'terminal') =>
  events.filter((e) => e.lifecycle?.operationId === op && e.lifecycle.phase === phase);
const revoke = (w: World, operationId: string) =>
  revokeSourceEvidence({ inventory: w.inventory, ledger: w.ledger }, { sourceId: SourceId(SRC), operationId }, w.ctx);
const purge = (w: World, targets: { purge(ids: readonly EvidenceId[]): Promise<void> }[], operationId?: string) =>
  purgeSourceEvidence(
    { inventory: w.inventory, ledger: w.ledger },
    { sourceId: SourceId(SRC), targets, ...(operationId !== undefined ? { operationId } : {}) },
    w.ctx,
  );

// ═════════════════════════ Decision 1: audit attempt left open after journal failure ═════════════════════════

test('REVOKE / indeterminate INTENT (bytes landed, fsync failed): attempt stays open, nothing reported as success; after restart the intent is replayed as a revoke; the same-operationId retry completes with exactly ONE attempt and ONE terminal', async () => {
  await withSandbox(async ({ base }) => {
    const w1 = await world(base, { stateOps: faultOps(recIs('intent'), 'failSync') });
    await seeded(w1);
    const first = await revoke(w1, 'op_rev');
    assert.ok(!first.ok && first.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE, 'never reported as success');
    assert.equal(w1.store.operational, false);
    assert.equal(w1.ledger.isEligible(ev(1).id), false, 'nothing is eligible while the outcome is unknown');
    await w1.close();
    let events = await auditEvents(w1);
    assert.equal(forOp(events, 'op_rev', 'attempt').length, 1, 'the write-ahead attempt exists');
    assert.equal(forOp(events, 'op_rev', 'terminal').length, 0, 'NO terminal: an unknown outcome is not recorded as failed or completed');

    const w2 = await world(base);
    assert.ok(
      w2.started.ok && w2.started.value.reconciledIntents === 1,
      'the DURABLE intent (not the open audit attempt) is what recovery replays',
    );
    assert.equal(w2.ledger.stateOf(ev(1).id), 'revoked');
    const retry = await revoke(w2, 'op_rev');
    assert.ok(retry.ok && retry.value.outcome === 'revoked');
    assert.equal(w2.ledger.stateOf(ev(1).id), 'revoked', 'the retry cannot release revoked evidence');
    await w2.close();
    events = await auditEvents(w2);
    assert.equal(forOp(events, 'op_rev', 'attempt').length, 1, 'no duplicate attempt');
    assert.equal(forOp(events, 'op_rev', 'terminal').length, 1, 'no duplicate terminal');
    assert.equal(forOp(events, 'op_rev', 'terminal')[0]?.outcome, 'revoked');
    const w3 = await world(base);
    assert.equal(w3.ledger.stateOf(ev(2).id), 'revoked');
    assert.equal(w3.store.diagnostics().openIntents.length, 0);
    await w3.close();
  });
});

test('REVOKE / INTENT write fails with nothing landed: after restart NOTHING was revoked and recovery does NOT infer a revoke from the open audit attempt; the retry then completes once', async () => {
  await withSandbox(async ({ base }) => {
    const w1 = await world(base, { stateOps: faultOps(recIs('intent'), 'failWrite') });
    await seeded(w1);
    const first = await revoke(w1, 'op_rev');
    assert.ok(!first.ok);
    await w1.close();
    assert.equal(forOp(await auditEvents(w1), 'op_rev', 'attempt').length, 1, 'an open attempt exists in the audit chain');

    const w2 = await world(base);
    assert.ok(w2.started.ok && w2.started.value.reconciledIntents === 0, 'no journal intent => nothing to replay');
    assert.equal(w2.ledger.stateOf(ev(1).id), 'released', 'an open audit attempt ALONE never revokes (and never un-revokes)');
    assert.equal(w2.ledger.isEligible(ev(1).id), true);
    assert.deepEqual(w2.store.diagnostics().openIntents, []);
    const retry = await revoke(w2, 'op_rev');
    assert.ok(retry.ok);
    await w2.close();
    const events = await auditEvents(w2);
    assert.equal(forOp(events, 'op_rev', 'attempt').length, 1);
    assert.equal(forOp(events, 'op_rev', 'terminal').length, 1);
  });
});

test('REVOKE / indeterminate TRANSITION: memory is revoked first, the store goes non-operational, restart ends revoked either way; the retry completes with one terminal', async () => {
  await withSandbox(async ({ base }) => {
    const w1 = await world(base, { stateOps: faultOps(recIs('transition'), 'failSync') });
    await seeded(w1);
    const first = await revoke(w1, 'op_rev');
    assert.ok(!first.ok && first.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE);
    assert.equal(w1.ledger.stateOf(ev(1).id), 'revoked');
    assert.equal(w1.store.operational, false);
    await w1.close();
    assert.equal(forOp(await auditEvents(w1), 'op_rev', 'terminal').length, 0);

    const w2 = await world(base);
    assert.equal(w2.ledger.stateOf(ev(1).id), 'revoked');
    assert.ok((await revoke(w2, 'op_rev')).ok);
    await w2.close();
    assert.equal(forOp(await auditEvents(w2), 'op_rev', 'terminal').length, 1);
  });
});

test('REVOKE / confirmed journal but the completion audit fails: reported as AUDIT_UNAVAILABLE (never success); a retry after restart records exactly one terminal', async () => {
  await withSandbox(async ({ base }) => {
    let failTerminal = true;
    const w1 = await world(base, {
      wrapAudit: (r) => ({
        record: async (e, t) =>
          failTerminal && e.phase === 'terminal'
            ? { ok: false as const, error: { code: AuditErrorCode.UNAVAILABLE, message: 'x', retryable: true, context: {} } as never }
            : r.record(e, t),
      }),
    });
    await seeded(w1);
    const first = await revoke(w1, 'op_rev');
    assert.ok(!first.ok && first.error.code === DiscoveryErrorCode.AUDIT_UNAVAILABLE, 'applied but not reported as audited');
    assert.equal(w1.ledger.stateOf(ev(1).id), 'revoked');
    await w1.close();
    failTerminal = false;
    const w2 = await world(base);
    assert.equal(w2.ledger.stateOf(ev(1).id), 'revoked', 'durable');
    const retry = await revoke(w2, 'op_rev');
    assert.ok(retry.ok);
    await w2.close();
    const events = await auditEvents(w2);
    assert.equal(forOp(events, 'op_rev', 'terminal').length, 1, 'exactly one terminal');
    assert.equal(forOp(events, 'op_rev', 'attempt').length, 1);
  });
});

test('REVOKE / definite REJECTION at the intent (same operationId for a different source): nothing changes anywhere and the store stays operational', async () => {
  await withSandbox(async ({ base }) => {
    const a = await boot(join(base, 'state'));
    seed(a);
    seed(a, SRC2);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_1', [ev(1)])).ok);
    assert.ok((await a.store.release(trust, 'op_2', [ev(2, SRC2)])).ok);
    assert.ok((await a.store.beginLifecycle(trust, { kind: 'revoke', operationId: 'op_same', sourceId: SourceId(SRC) })).ok);
    const clash = await a.store.beginLifecycle(trust, { kind: 'revoke', operationId: 'op_same', sourceId: SourceId(SRC2) });
    assert.ok(!clash.ok && clash.error.context['outcome'] === 'rejected');
    assert.equal(a.store.operational, true);
    assert.equal(a.ledger.stateOf(ev(2, SRC2).id), 'released', 'the OTHER source was not revoked in memory by a rejected request');
    assert.ok(
      (await a.store.beginLifecycle(trust, { kind: 'revoke', operationId: 'op_same', sourceId: SourceId(SRC) })).ok,
      'the exact retry is idempotent',
    );
    await a.store.close();
  });
});

test('REVOKE / a REJECTED transition after the in-memory apply poisons the store: memory is never left silently ahead of the journal while "operational"', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    seed(a);
    seed(a, SRC2);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_1', [ev(1)])).ok);
    assert.ok((await a.store.release(trust, 'op_2', [ev(2, SRC2)])).ok);
    assert.ok((await a.store.beginLifecycle(trust, { kind: 'revoke', operationId: 'op_x', sourceId: SourceId(SRC) })).ok);
    assert.ok((await a.store.applyRevoke(trust, { operationId: 'op_x', sourceId: SourceId(SRC), at: T })).ok);
    const clash = await a.store.applyRevoke(trust, { operationId: 'op_x', sourceId: SourceId(SRC2), at: T });
    assert.ok(!clash.ok);
    assert.equal(a.store.operational, false, 'divergence between memory and journal fails closed');
    assert.equal(a.ledger.isEligible(ev(2, SRC2).id), false);
    await a.store.close();
    const b = await boot(dir);
    assert.equal(b.ledger.stateOf(ev(2, SRC2).id), 'released', 'the journal is the truth after restart; the caller was told it failed');
    assert.equal(b.ledger.stateOf(ev(1).id), 'revoked');
    await b.store.close();
  });
});

test('RELEASE retry with the SAME operationId after a revoke can never re-release revoked evidence (memory and after restart)', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    seed(a);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_rel', [ev(1)])).ok);
    assert.ok((await a.store.beginLifecycle(trust, { kind: 'revoke', operationId: 'op_rev', sourceId: SourceId(SRC) })).ok);
    assert.ok((await a.store.applyRevoke(trust, { operationId: 'op_rev', sourceId: SourceId(SRC), at: T })).ok);
    const retry = await a.store.release(trust, 'op_rel', [ev(1)]);
    assert.ok(!retry.ok, 'a duplicate release of revoked evidence is withheld, not delivered');
    assert.equal(a.ledger.stateOf(ev(1).id), 'revoked');
    assert.equal(a.ledger.isEligible(ev(1).id), false);
    await a.store.close();
    const b = await boot(dir);
    assert.equal(b.ledger.stateOf(ev(1).id), 'revoked', 'and the journal agrees');
    assert.equal((await b.store.release(trust, 'op_rel', [ev(1)])).ok, false);
    assert.equal(b.ledger.isEligible(ev(1).id), false);
    assert.equal((await raw(dir)).split('\n').filter((l) => l.includes('"rec":"release"')).length, 1, 'no second release record');
    await b.store.close();
  });
});

test('PURGE: a failing holder means `purged` is never journaled or claimed; the failure is audited exactly as without a durable store; a later retry purges only after the holders succeed', async () => {
  await withSandbox(async ({ base }) => {
    const w = await world(base);
    await seeded(w);
    let calls = 0;
    const failing = {
      purge: async () => {
        calls += 1;
        throw new Error('holder offline');
      },
    };
    const r = await purge(w, [failing], 'op_purge');
    assert.ok(!r.ok, 'not reported as success');
    assert.equal(calls, 1);
    assert.equal(w.ledger.stateOf(ev(1).id), 'revoked', 'revoked (durable) but NOT purged');
    assert.ok(!(await raw(w.stateDir)).includes('"kind":"purged"'), 'no purged transition was journaled');
    assert.equal(w.inventory.get(SourceId(SRC))?.purgeRequired, true, 'the purge obligation is still on record');
    await w.close();
    const events = await auditEvents(w);
    assert.equal(forOp(events, 'op_purge', 'terminal').length, 1);
    assert.equal(
      forOp(events, 'op_purge', 'terminal')[0]?.outcome,
      'failed',
      'a definite holder failure is recorded as failed (unchanged behaviour)',
    );

    const w2 = await world(base);
    assert.equal(w2.ledger.stateOf(ev(1).id), 'revoked', 'still revoked, still not purged, after restart');
    // The terminal for op_purge is final (one terminal per operation): the retry uses a new operation.
    const seenAtCall: boolean[] = [];
    const good = {
      purge: async () => {
        seenAtCall.push((await raw(w2.stateDir)).includes('"kind":"purged"'));
      },
    };
    const retry = await purge(w2, [good]);
    assert.ok(retry.ok && retry.value.outcome === 'purged');
    assert.deepEqual(seenAtCall, [false], 'the holder was asked BEFORE purged was journaled');
    assert.equal(w2.ledger.stateOf(ev(1).id), 'purged');
    await w2.close();
  });
});

test('PURGE / indeterminate or failed `purged` write: never claimed; the attempt stays open; restart ends revoked or purged (both ineligible); a same-operationId retry re-asks the holders and completes once', async () => {
  for (const mode of ['failWrite', 'failSync'] as const) {
    await withSandbox(async ({ base }) => {
      const w1 = await world(base, { stateOps: faultOps(lineHas('"kind":"purged"'), mode) });
      await seeded(w1);
      let asked = 0;
      const holder = {
        purge: async () => {
          asked += 1;
        },
      };
      const first = await purge(w1, [holder], 'op_purge');
      assert.ok(!first.ok && first.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE, `${mode}: not reported as success`);
      assert.equal(asked, 1);
      assert.equal(w1.ledger.isEligible(ev(1).id), false);
      await w1.close();
      assert.equal(forOp(await auditEvents(w1), 'op_purge', 'terminal').length, 0, 'unknown outcome: no terminal recorded');

      const w2 = await world(base);
      assert.ok(['revoked', 'purged'].includes(w2.ledger.stateOf(ev(1).id) ?? ''), `${mode}: restart is revoked or purged`);
      assert.equal(w2.ledger.isEligible(ev(1).id), false);
      const retry = await purge(w2, [holder], 'op_purge');
      assert.ok(retry.ok && retry.value.outcome === 'purged');
      assert.equal(asked, 2, 'the holders are asked again (their contract is idempotent)');
      assert.equal(w2.ledger.stateOf(ev(1).id), 'purged');
      await w2.close();
      const events = await auditEvents(w2);
      assert.equal(forOp(events, 'op_purge', 'terminal').length, 1, 'exactly one terminal');
      assert.equal(forOp(events, 'op_purge', 'attempt').length, 1);
    });
  }
});

test('DISAGREEMENT fails closed: when audit evidence is supplied at start, a journal that is BEHIND the audit chain (rolled back) or AHEAD of it (release without an audited completion) is refused; without audit evidence the limit is documented', async () => {
  await withSandbox(async ({ base }) => {
    const w1 = await world(base);
    await seeded(w1);
    assert.ok((await revoke(w1, 'op_rev')).ok);
    await w1.close();
    const journal = (await raw(w1.stateDir)).split('\n').filter(Boolean);
    const releaseIdx = journal.findIndex((l) => l.includes('"rec":"release"'));
    // Roll the journal back to just after the release: a valid chain PREFIX, so verification alone cannot see it.
    await writeFile(join(w1.stateDir, CHAIN_LOG_FILE), `${journal.slice(0, releaseIdx + 1).join('\n')}\n`);

    const events = await auditEvents(w1);
    assert.ok(
      forOp(events, 'op_rev', 'terminal').some((e) => e.outcome === 'revoked'),
      'the audit chain says it was revoked',
    );
    const blind = await world(base);
    assert.ok(blind.started.ok);
    assert.equal(
      blind.ledger.isEligible(ev(1).id),
      true,
      'LIMIT (documented): with no audit evidence supplied, a rolled-back journal is not detectable',
    );
    await blind.close();

    const informed = await world(base, { auditEvents: events });
    assert.ok(!informed.started.ok && informed.started.error.context['outcome'] === 'disagreement');
    assert.equal(informed.store.operational, false);
    assert.equal(informed.ledger.isEligible(ev(1).id), false, 'fail closed: nothing is eligible');
    assert.equal(informed.ledger.isEligible(ev(2).id), false);
    await informed.close();
  });
  // Journal AHEAD of audit: a release with no audited completion is an eligibility grant nobody audited.
  await withSandbox(async ({ base }) => {
    const w = await world(base);
    await seeded(w); // op_seed is journaled but has no audit terminal
    await w.close();
    const informed = await world(base, { auditEvents: await auditEvents(w) });
    assert.ok(!informed.started.ok && informed.started.error.context['outcome'] === 'disagreement');
    await informed.close();
  });
});

test('CROSS-CHECK classifies benign windows separately from dangerous disagreement', () => {
  const op = (operationId: string, rec: 'release' | 'transition', kind?: 'revoked') =>
    ({ operationId, rec, ...(kind !== undefined ? { kind } : {}), count: 1 }) as never;
  const terminal = (operationId: string, outcome: string, evidence = 0) =>
    ({
      lifecycle: { operationId, phase: 'terminal' },
      outcome,
      extensions: { 'x-ei-audit': { counts: { evidence } } },
    }) as unknown as AuditEvent;
  const findings = crossCheckState([op('op_a', 'release')], [terminal('op_b', 'completed', 2), terminal('op_c', 'revoked')]);
  assert.deepEqual(findings.map((f) => `${f.kind}:${f.operationId}`).sort(), [
    'audited_not_applied:op_c',
    'audited_not_released:op_b',
    'released_without_audit:op_a',
  ]);
});

// ═════════════════════════ Decision 2: malformed / path-like ids ═════════════════════════

const BAD_IDS = [
  '../../etc/passwd',
  'a b',
  '',
  'x'.repeat(300),
  'ev_\u0000nul',
  '..\\windows',
  'Bearer abcdefghijklmnop0123456789',
  '/abs/path',
  'new\nline',
];

test('IDS at the store boundary: every mutation rejects a malformed id BEFORE any memory or journal change, with a bounded error that never echoes the value, and the store stays operational', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    seed(a);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_ok', [ev(1)])).ok);
    const snap = async () =>
      JSON.stringify({
        ledger: a.ledger.exportEntries(),
        inventory: a.inventory.list().map((r) => [r.source.sourceId, r.axes, r.purgeRequired]),
        journal: await raw(dir),
      });
    const before = await snap();
    for (const bad of BAD_IDS) {
      const attempts = [
        a.store.release(trust, bad, [ev(2)]),
        a.store.release(trust, 'op_new', [{ ...ev(2), id: EvidenceId(bad) } as never]),
        a.store.release(trust, 'op_new', [{ ...ev(2), sourceId: SourceId(bad) } as never]),
        a.store.quarantine(trust, 'op_q', [{ ...ev(3), id: EvidenceId(bad) } as never]),
        a.store.beginLifecycle(trust, { kind: 'revoke', operationId: bad, sourceId: SourceId(SRC) }),
        a.store.beginLifecycle(trust, { kind: 'revoke', operationId: 'op_b', sourceId: SourceId(bad) }),
        a.store.applyRevoke(trust, { operationId: bad, sourceId: SourceId(SRC), at: T }),
        a.store.applyRevoke(trust, { operationId: 'op_b', sourceId: SourceId(bad), at: T }),
        a.store.applyPurge(trust, { operationId: bad, sourceId: SourceId(SRC), at: T }),
        a.store.applyPurge(trust, { operationId: 'op_b', sourceId: SourceId(bad), at: T }),
      ];
      for (const r of await Promise.all(attempts)) {
        assert.ok(
          !r.ok && r.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE && r.error.context['outcome'] === 'rejected',
          `rejected: ${JSON.stringify(bad).slice(0, 30)}`,
        );
        const shown = JSON.stringify(r.error);
        assert.ok(shown.length < 400, 'bounded');
        assert.ok(!shown.includes(bad.slice(0, 12)) || bad.length < 12 || bad === '', 'the offending value is never echoed');
      }
    }
    assert.equal(await snap(), before, 'NOTHING changed: no ledger entry (not even a quarantine), no inventory change, no journal byte');
    assert.equal(a.store.operational, true, 'bad input is not a persistence failure');
    assert.ok((await a.store.release(trust, 'op_after', [ev(2)])).ok, 'the store keeps working');
    await a.store.close();
  });
});

test('IDS: nothing is truncated or normalized — a large quarantine is journaled COMPLETELY, and valid ids round-trip byte for byte', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    const many = Array.from({ length: 5001 }, (_, i) => ev(i + 1));
    assert.ok((await a.store.quarantine(trust, 'op_big', many)).ok);
    await a.store.close();
    const records = (await raw(dir)).split('\n').filter((l) => l.includes('"rec":"quarantine"'));
    const ids = records.flatMap(
      (l) => (JSON.parse(l) as { event: { extensions: { 'x-ei-state': { ids: string[] } } } }).event.extensions['x-ei-state'].ids,
    );
    assert.equal(ids.length, 5001, 'every id was journaled (previously the 5001st was silently dropped)');
    assert.deepEqual([...ids].sort(), many.map((e) => e.id as string).sort(), 'byte for byte');
    const b = await boot(dir);
    assert.equal(b.ledger.counts().quarantined, 5001);
    await b.store.close();
  });
});

test('IDS at the PUBLIC EI boundary: malformed source / operation / evidence ids are refused before any audit attempt, journal write or ledger change', async () => {
  await withSandbox(async ({ base }) => {
    const w = await world(base);
    await seeded(w);
    const journalBefore = await raw(w.stateDir);
    const ledgerBefore = JSON.stringify(w.ledger.exportEntries());
    const auditBefore = w.audit.checkpoint().events;
    const scope = { kind: 'filesystem_root', root: base, includeExtensions: [], maxDepth: 2 } as unknown as FilesystemScope;
    const registry = new ConnectorRegistry();
    registry.register(new LocalFilesystemConnector());
    for (const bad of ['../../etc/passwd', 'a b', 'x'.repeat(300)]) {
      const r1 = await revokeSourceEvidence({ inventory: w.inventory, ledger: w.ledger }, { sourceId: SourceId(bad) }, w.ctx);
      assert.ok(!r1.ok, 'unknown/malformed source');
      const r2 = await revokeSourceEvidence(
        { inventory: w.inventory, ledger: w.ledger },
        { sourceId: SourceId(SRC), operationId: bad },
        w.ctx,
      );
      assert.ok(!r2.ok, 'malformed operation id');
      const r3 = await acquireSourceContent(
        { registry, inventory: w.inventory },
        { sourceId: SourceId(bad), kind: 'document_content', resourceKeys: ['a.txt'], scope } as never,
        w.ctx,
      );
      assert.ok(!r3.ok);
      for (const r of [r1, r2, r3]) {
        if (!r.ok)
          assert.ok(
            !JSON.stringify(r.error).includes(bad.slice(0, 12)) && JSON.stringify(r.error).length < 700,
            'bounded and does not echo the value',
          );
      }
    }
    assert.equal(await raw(w.stateDir), journalBefore, 'no journal write');
    assert.equal(JSON.stringify(w.ledger.exportEntries()), ledgerBefore, 'no ledger change');
    assert.equal(w.store.operational, true);
    assert.equal(w.ctx.ledger?.isEligible(ev(1).id), true, 'existing released evidence is untouched');
    await w.close();
    assert.ok(w.audit.checkpoint().events - auditBefore <= 1, 'at most the best-effort denial/attempt trail; nothing was applied');
    void hex;
    void readFile;
  });
});
