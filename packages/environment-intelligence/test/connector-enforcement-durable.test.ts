/**
 * C1 follow-up: containment of rejected connector results against the ACTUAL durable `EiStateStore` (not just the in-memory
 * ledger). A non-conforming connector that audits properly but skips authorization has its evidence RELEASED (and journaled) by
 * its own completion step before the framework can reject the result. Containment must leave that evidence quarantined in the
 * ledger AND in the journal, so it is still ineligible after the store is closed and reopened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import {
  ConnectorRegistry,
  DiscoveryErrorCode,
  EiStateStore,
  EnvironmentInventory,
  EvidenceLedger,
  InMemoryAuditRecorder,
  acquireSourceContent,
  discoverSource,
  type AuditTrust,
  type ConnectorContext,
  type DiscoveryDeps,
  type EvidenceId,
  type SourceId,
} from '../src/index.js';
import { TEST_PRINCIPAL, authenticated, withSandbox } from './helpers.js';
import { MOCK_SOURCE_TYPE, MockConnector, type MockConnectorOptions, type MockScope } from './support/mock-connector.js';
import { readGrant } from './support/audit-grants.js';
import { allowing } from './support/scripted-authorization.js';

const scope: MockScope = { kind: 'mock_source', path: '/mock/alpha' };
const OP = authenticated('operator-1');
const trust: AuditTrust = { principal: OP };

async function bootStore(dir: string) {
  const opened = await EiStateStore.open({ dir });
  assert.ok(opened.ok, 'the durable store opens');
  if (!opened.ok) throw new Error('unreachable');
  const inventory = new EnvironmentInventory();
  const ledger = new EvidenceLedger();
  const started = await opened.value.start({ grant: await readGrant(), trust, inventory, ledger });
  assert.ok(started.ok, 'the durable store starts');
  return { store: opened.value, inventory, ledger };
}

function durableEnv(booted: Awaited<ReturnType<typeof bootStore>>, options: MockConnectorOptions) {
  const registry = new ConnectorRegistry();
  registry.register(new MockConnector(options));
  const deps: DiscoveryDeps = { registry, inventory: booted.inventory };
  const clock = new MockClock('2026-10-10T00:00:00.000Z');
  const ctx: ConnectorContext = {
    clock,
    authorization: allowing(['filesystem.list', 'filesystem.read']),
    principal: TEST_PRINCIPAL,
    audit: new InMemoryAuditRecorder(() => clock.now()),
    ledger: booted.ledger,
    state: booted.store,
  };
  return { deps, ctx };
}

const idsOf = (ledger: EvidenceLedger): readonly EvidenceId[] => ledger.exportEntries().map((e) => e.id);

test('control: with an honest connector the released evidence is durable across a restart (so the quarantine cases below are not vacuous)', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await bootStore(dir);
    const { deps, ctx } = durableEnv(a, {});
    const run = await discoverSource(deps, { sourceType: MOCK_SOURCE_TYPE, scope }, ctx);
    assert.ok(run.ok && run.value.outcome !== undefined);
    assert.deepEqual(a.ledger.counts(), { released: 2, quarantined: 0, revoked: 0, purged: 0 });
    await a.store.close();
    const b = await bootStore(dir);
    assert.deepEqual(b.ledger.counts(), { released: 2, quarantined: 0, revoked: 0, purged: 0 });
    for (const id of idsOf(b.ledger)) assert.equal(b.ledger.isEligible(id), true);
    await b.store.close();
  });
});

test('skipped authorization in discover: the journaled release is superseded by a journaled quarantine that survives restart', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await bootStore(dir);
    const { deps, ctx } = durableEnv(a, { rogue: { discover: 'skip_authorization' } });
    const run = await discoverSource(deps, { sourceType: MOCK_SOURCE_TYPE, scope }, ctx);
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED);
    assert.equal(run.value.evidence.length, 0);
    assert.deepEqual(a.ledger.counts(), { released: 0, quarantined: 2, revoked: 0, purged: 0 });
    assert.deepEqual(a.store.diagnostics().ledgerCounts, { released: 0, quarantined: 2, revoked: 0, purged: 0 });
    const ids = idsOf(a.ledger);
    for (const id of ids) assert.equal(a.ledger.isEligible(id), false);
    await a.store.close();

    const b = await bootStore(dir);
    assert.deepEqual(b.ledger.counts(), { released: 0, quarantined: 2, revoked: 0, purged: 0 }, 'quarantine is what the journal replays');
    assert.deepEqual(idsOf(b.ledger), ids);
    for (const id of ids) assert.equal(b.ledger.isEligible(id), false);
    await b.store.close();
  });
});

test('foreign-source evidence from acquire is quarantined durably while the honest discovery evidence stays released', async () => {
  await withSandbox(async ({ base }) => {
    const dir = join(base, 'state');
    const a = await bootStore(dir);
    const { deps, ctx } = durableEnv(a, { rogue: { acquire_content: 'foreign_source' } });
    const run = await discoverSource(deps, { sourceType: MOCK_SOURCE_TYPE, scope }, ctx);
    assert.ok(run.ok && run.value.outcome !== undefined);
    const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
    const before = a.ledger.counts();
    const acq = await acquireSourceContent(deps, { sourceId, kind: 'document_content', resourceKeys: ['a.txt', 'b.txt'], scope }, ctx);
    assert.equal(acq.ok, false);
    if (!acq.ok) assert.equal(acq.error.code, DiscoveryErrorCode.MALFORMED_INPUT);
    assert.equal(a.ledger.counts().quarantined, 2);
    assert.equal(a.ledger.counts().released, before.released, 'the honest discovery evidence is untouched');
    await a.store.close();

    const b = await bootStore(dir);
    assert.equal(b.ledger.counts().quarantined, 2, 'durable');
    assert.equal(b.ledger.counts().released, before.released);
    await b.store.close();
  });
});

test('when the durable store is not operational the rejected operation is refused before the connector runs: nothing is released, so nothing needs containing', async () => {
  await withSandbox(async ({ base }) => {
    const a = await bootStore(join(base, 'state'));
    const { deps, ctx } = durableEnv(a, { rogue: { discover: 'skip_authorization' } });
    await a.store.close();
    const run = await discoverSource(deps, { sourceType: MOCK_SOURCE_TYPE, scope }, ctx);
    assert.equal(run.ok, false);
    if (!run.ok) assert.equal(run.error.code, DiscoveryErrorCode.STATE_UNAVAILABLE);
    assert.deepEqual(a.ledger.counts(), { released: 0, quarantined: 0, revoked: 0, purged: 0 });
  });
});
