/**
 * C0.4 final owner review. Written FAILING first against the previously reported tree. Each test names the path it covers:
 *  R1  a revoke/purge whose inventory SNAPSHOT is lost after the ledger transition was journaled must not lose the revoked
 *      authorization axis or the purge obligation (acquisition checks `axes.authorization === 'granted'`);
 *  R2  an operation id the journal cannot represent must be refused BEFORE the audit attempt, never leaving an uncompletable open attempt;
 *  R3  a declared source whose id the journal cannot represent must be refused before it enters the inventory, never wedging later operations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import { InMemoryAuditSink, PermissionId, PermissionManager, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import {
  CanonicalAuditRecorder,
  ConnectorRegistry,
  DiscoveryErrorCode,
  ENVIRONMENT_INTELLIGENCE_REQUESTER,
  EnvironmentInventory,
  EvidenceLedger,
  EiStateStore,
  LocalFilesystemConnector,
  PermissionManagerAuthorization,
  SourceId,
  openEiAuditStore,
  registerDeclaredSources,
  revokeSourceEvidence,
  type ConnectorContext,
} from '../src/index.js';
import { TEST_PRINCIPAL, withSandbox } from './helpers.js';
import { readGrant } from './support/audit-grants.js';
import { SRC, T, boot, ev, faultOps, recIs, seed, source, trust } from './support/state-fixtures.js';

const rules: PolicyRule[] = ['data.write', 'data.delete'].map((p) => ({
  id: `allow-${p}`,
  effect: 'ALLOW',
  match: { permission: PermissionId(p), packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER },
}));

test('R1 REVOKE: if the inventory snapshot is lost after the transition was journaled, restart still shows the source REVOKED with its purge obligation (and acquisition stays refused)', async () => {
  for (const mode of ['failWrite', 'failSync'] as const) {
    await withSandbox(async ({ base }) => {
      const dir = join(base, 'state');
      let armed = false;
      const a = await boot(dir, { ops: faultOps((l) => armed && recIs('source')(l), mode) });
      seed(a);
      assert.ok((await a.store.syncInventory(trust)).ok);
      assert.ok((await a.store.release(trust, 'op_rel', [ev(1)])).ok);
      assert.ok((await a.store.beginLifecycle(trust, { kind: 'revoke', operationId: 'op_rev', sourceId: SourceId(SRC) })).ok);
      armed = true; // from here on, inventory snapshots cannot be persisted
      const r = await a.store.applyRevoke(trust, { operationId: 'op_rev', sourceId: SourceId(SRC), at: T });
      assert.ok(!r.ok, `${mode}: reported as a failure`);
      assert.equal(a.store.operational, false);
      await a.store.close();

      const b = await boot(dir);
      assert.equal(b.ledger.stateOf(ev(1).id), 'revoked');
      const rec = b.inventory.get(SourceId(SRC));
      assert.equal(rec?.axes.authorization, 'revoked', `${mode}: the revoked authorization axis must survive (acquire requires 'granted')`);
      assert.equal(rec?.purgeRequired, true, `${mode}: the purge obligation must survive`);
      await b.store.close();
      const c = await boot(dir);
      assert.equal(c.inventory.get(SourceId(SRC))?.axes.authorization, 'revoked', 'and it is now durable (the correction was journaled)');
      assert.equal(c.inventory.get(SourceId(SRC))?.purgeRequired, true);
      await c.store.close();
    });
  }
});

test('R1 PURGE: if the snapshot is lost after the purged transition, restart shows purged (obligation cleared), not an eternal pending purge', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    let armed = false;
    const a = await boot(dir, { ops: faultOps((l) => armed && recIs('source')(l), 'failWrite') });
    seed(a);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_rel', [ev(1)])).ok);
    assert.ok((await a.store.beginLifecycle(trust, { kind: 'purge', operationId: 'op_p', sourceId: SourceId(SRC) })).ok);
    assert.ok((await a.store.applyRevoke(trust, { operationId: 'op_p', sourceId: SourceId(SRC), at: T })).ok);
    armed = true;
    const r = await a.store.applyPurge(trust, { operationId: 'op_p', sourceId: SourceId(SRC), at: T });
    assert.ok(!r.ok);
    await a.store.close();
    const b = await boot(dir);
    assert.equal(b.ledger.stateOf(ev(1).id), 'purged');
    assert.equal(b.inventory.get(SourceId(SRC))?.axes.authorization, 'revoked');
    assert.equal(
      b.inventory.get(SourceId(SRC))?.purgeRequired,
      false,
      'holders confirmed; the journaled purged transition clears the obligation',
    );
    await b.store.close();
  });
});

test('R1 NEGATIVE: a source that was revoked and later RE-AUTHORIZED is not re-revoked by recovery (a later snapshot supersedes the transition)', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await boot(dir);
    seed(a);
    assert.ok((await a.store.syncInventory(trust)).ok);
    assert.ok((await a.store.release(trust, 'op_rel', [ev(1)])).ok);
    assert.ok((await a.store.beginLifecycle(trust, { kind: 'revoke', operationId: 'op_rev', sourceId: SourceId(SRC) })).ok);
    assert.ok((await a.store.applyRevoke(trust, { operationId: 'op_rev', sourceId: SourceId(SRC), at: T })).ok);
    // The source is detected and authorized again (a deliberate, later action); the journaled snapshot reflects it.
    a.inventory.apply(SourceId(SRC), 'authorization_granted', T);
    assert.ok((await a.store.syncInventory(trust)).ok);
    const granted = a.inventory.get(SourceId(SRC))?.axes.authorization;
    assert.equal(granted, 'granted');
    await a.store.close();
    const b = await boot(dir);
    assert.equal(b.inventory.get(SourceId(SRC))?.axes.authorization, 'granted', 'recovery must not undo a later authorization');
    assert.equal(b.ledger.stateOf(ev(1).id), 'revoked', 'the old evidence stays revoked');
    await b.store.close();
  });
});

test('R2 an operation id the journal cannot represent (101-200 chars: valid for audit, too long for a journal key) is refused BEFORE any audit attempt — no uncompletable open attempt, bounded error, store stays operational', async () => {
  await withSandbox(async ({ base }) => {
    const auditDir = join(base, 'audit');
    const audit = await openEiAuditStore({ dir: auditDir });
    assert.ok(audit.ok);
    if (!audit.ok) return;
    const store = await EiStateStore.open({ dir: join(base, 'state') });
    assert.ok(store.ok);
    if (!store.ok) return;
    const inventory = new EnvironmentInventory();
    const ledger = new EvidenceLedger();
    assert.ok((await store.value.start({ grant: await readGrant(), trust, inventory, ledger })).ok);
    seed({ inventory });
    assert.ok((await store.value.syncInventory(trust)).ok);
    assert.ok((await store.value.release(trust, 'op_seed', [ev(1)])).ok);
    const clock = new MockClock();
    const manager = new PermissionManager({ policy: new RuleBasedPolicy(rules), auditSink: new InMemoryAuditSink(), clock });
    const ctx: ConnectorContext = {
      clock,
      authorization: new PermissionManagerAuthorization(manager),
      principal: TEST_PRINCIPAL,
      audit: new CanonicalAuditRecorder(audit.value),
      ledger,
      state: store.value,
      auditOptions: { acceptTimeoutMs: 2000, attempts: 1 },
    };
    const before = audit.value.checkpoint().events;
    // 110 chars: the audit chain ACCEPTS it (`<id>:attempt` is 118 <= 128) but the journal key budget is 100. Before the fix the
    // attempt was written and the journal then rejected the intent: an open attempt that no retry could ever complete.
    const midOp = 'o'.repeat(110);
    const r = await revokeSourceEvidence({ inventory, ledger }, { sourceId: SourceId(SRC), operationId: midOp }, ctx);
    assert.ok(!r.ok);
    assert.equal(audit.value.checkpoint().events, before, 'NO audit event of any kind was written for an id the journal cannot represent');
    const shown = JSON.stringify(r.ok ? {} : r.error);
    assert.ok(!shown.includes('oooooooooooo') && shown.length < 700, 'refused without echoing the id; bounded');
    // 150 chars: the audit chain itself rejects it (key limit) — also nothing written, error stays bounded.
    const longOp = 'o'.repeat(150);
    const r2 = await revokeSourceEvidence({ inventory, ledger }, { sourceId: SourceId(SRC), operationId: longOp }, ctx);
    assert.ok(!r2.ok);
    assert.equal(audit.value.checkpoint().events, before, 'nothing written');
    assert.ok(JSON.stringify(r2.ok ? {} : r2.error).length < 700, 'bounded');
    assert.equal(store.value.operational, true);
    assert.equal(ledger.isEligible(ev(1).id), true, 'nothing was revoked by a refused request');
    // a normal operation id still works end to end
    const ok = await revokeSourceEvidence({ inventory, ledger }, { sourceId: SourceId(SRC), operationId: 'op_normal' }, ctx);
    assert.ok(ok.ok);
    await store.value.close();
    await audit.value.close();
  });
});

test('R3 a declared source whose id the journal cannot represent is refused BEFORE it enters the inventory; later valid declarations are not wedged', async () => {
  await withSandbox(async ({ base }) => {
    const audit = await openEiAuditStore({ dir: join(base, 'audit') });
    assert.ok(audit.ok);
    if (!audit.ok) return;
    const store = await EiStateStore.open({ dir: join(base, 'state') });
    assert.ok(store.ok);
    if (!store.ok) return;
    const inventory = new EnvironmentInventory();
    const ledger = new EvidenceLedger();
    assert.ok((await store.value.start({ grant: await readGrant(), trust, inventory, ledger })).ok);
    const registry = new ConnectorRegistry();
    registry.register(new LocalFilesystemConnector());
    const clock = new MockClock();
    const manager = new PermissionManager({ policy: new RuleBasedPolicy(rules), auditSink: new InMemoryAuditSink(), clock });
    const ctx: ConnectorContext = {
      clock,
      authorization: new PermissionManagerAuthorization(manager),
      principal: TEST_PRINCIPAL,
      audit: new CanonicalAuditRecorder(audit.value),
      ledger,
      state: store.value,
      auditOptions: { acceptTimeoutMs: 2000, attempts: 1 },
    };
    const deps = { registry, inventory };
    const bad = registerDeclaredSources(deps, [{ ...source(), sourceId: SourceId(`src_${'z'.repeat(140)}`) }], ctx);
    const r1 = await bad;
    assert.ok(!r1.ok && r1.error.code === DiscoveryErrorCode.STATE_UNAVAILABLE && r1.error.context['outcome'] === 'rejected');
    assert.equal(inventory.list().length, 0, 'the unrepresentable source never entered the inventory');
    assert.ok(!JSON.stringify(r1.error).includes('zzzzzzzz'), 'never echoed');
    const good = await registerDeclaredSources(deps, [source(`src_${'d'.repeat(24)}`)], ctx);
    assert.ok(good.ok, 'a later valid declaration is not wedged');
    assert.equal(inventory.list().length, 1);
    assert.equal(store.value.operational, true);
    await store.value.close();
    await audit.value.close();
  });
});
