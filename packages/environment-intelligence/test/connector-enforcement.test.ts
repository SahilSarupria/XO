/**
 * C1 D6(A): connector success alone cannot establish authorization. Each case runs a deliberately NON-CONFORMING mock connector
 * and asserts the framework rejects it with a typed error WITHOUT advancing source state; every case has an honest control.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockClock } from '@xo/testing';
import {
  ConnectorRegistry,
  DiscoveryErrorCode,
  EnvironmentInventory,
  EvidenceLedger,
  InMemoryAuditRecorder,
  acquireSourceContent,
  checkSourceHealth,
  discoverSource,
  summarize,
  syncSource,
  type ConnectorContext,
  type DiscoveryDeps,
  type SourceId,
} from '../src/index.js';
import { TEST_PRINCIPAL, authenticated } from './helpers.js';
import { MOCK_SOURCE_TYPE, MockConnector, type MockConnectorOptions, type MockScope } from './support/mock-connector.js';
import { allowing } from './support/scripted-authorization.js';

const scope: MockScope = { kind: 'mock_source', path: '/mock/alpha' };
const PERMS = ['filesystem.list', 'filesystem.read'];

function build(options: MockConnectorOptions = {}) {
  const connector = new MockConnector(options);
  const registry = new ConnectorRegistry();
  registry.register(connector);
  const deps: DiscoveryDeps = { registry, inventory: new EnvironmentInventory() };
  const clock = new MockClock('2026-10-10T00:00:00.000Z');
  const audit = new InMemoryAuditRecorder(() => clock.now());
  const ledger = new EvidenceLedger();
  const ctx: ConnectorContext = { clock, authorization: allowing(PERMS), principal: TEST_PRINCIPAL, audit, ledger };
  return { connector, deps, ctx, audit, ledger };
}
const discover = (b: ReturnType<typeof build>) => discoverSource(b.deps, { sourceType: MOCK_SOURCE_TYPE, scope }, b.ctx);
const acquireReq = (sourceId: SourceId) => ({ sourceId, kind: 'document_content' as const, resourceKeys: ['a.txt', 'b.txt'], scope });

test('control: an honest mock passes discover, acquire, sync and health', async () => {
  const b = build();
  const run = await discover(b);
  assert.ok(run.ok && run.value.outcome !== undefined);
  const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
  assert.equal(summarize(b.deps.inventory.get(sourceId)!.axes), 'acquisition_successful');
  assert.ok((await acquireSourceContent(b.deps, acquireReq(sourceId), b.ctx)).ok);
  assert.ok((await syncSource(b.deps, { sourceId, kind: 'document_content', scope }, b.ctx)).ok);
  assert.ok((await checkSourceHealth(b.deps, { sourceId, scope }, b.ctx)).ok);
});

test('a connector that skips authorization in validate_connection does not get the source authorized or validated', async () => {
  const b = build({ rogue: { validate_connection: 'skip_authorization' } });
  const run = await discover(b);
  assert.ok(run.ok);
  if (!run.ok) return;
  assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED);
  assert.equal(run.value.outcome, undefined);
  const axes = run.value.record.axes;
  assert.notEqual(axes.authorization, 'granted');
  assert.notEqual(axes.connection, 'validated');
  assert.notEqual(summarize(axes), 'connected_and_validated');
  assert.equal(b.connector.calls.includes('discover'), false, 'discovery was never reached');
  // ... and therefore acquisition is refused for that source.
  const acq = await acquireSourceContent(b.deps, acquireReq(run.value.record.source.sourceId), b.ctx);
  assert.equal(acq.ok, false);
  if (!acq.ok) assert.equal(acq.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
});

test('a connector that skips authorization in detect leaves NO inventory record', async () => {
  const b = build({ rogue: { detect: 'skip_authorization' } });
  const run = await discover(b);
  assert.equal(run.ok, false);
  if (!run.ok) assert.equal(run.error.code, DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED);
  assert.equal(b.deps.inventory.list().length, 0);
});

test('a connector that skips authorization in discover does not get acquisition recorded or evidence released', async () => {
  const b = build({ rogue: { discover: 'skip_authorization' } });
  const run = await discover(b);
  assert.ok(run.ok);
  if (!run.ok) return;
  assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED);
  assert.equal(run.value.evidence.length, 0);
  assert.equal(run.value.record.axes.acquisition, 'not_attempted');
  // The connector audited properly, so its own completion step released the evidence in the ledger before verification could run.
  // The framework contains that: the rejected evidence ends up quarantined (ineligible), never released.
  assert.deepEqual(b.ledger.counts(), { released: 0, quarantined: 2, revoked: 0, purged: 0 });
});

test('spending the LIST permission where READ is required is rejected: list never stands in for read', async () => {
  const honest = build();
  const run = await discover(honest);
  assert.ok(run.ok && run.value.outcome !== undefined);
  const b = build({ rogue: { acquire_content: 'list_instead_of_read' } });
  const run2 = await discover(b);
  assert.ok(run2.ok && run2.value.outcome !== undefined, 'discovery of the rogue is honest');
  const sourceId = (run2.ok ? run2.value.record.source.sourceId : undefined) as SourceId;
  const acq = await acquireSourceContent(b.deps, acquireReq(sourceId), b.ctx);
  assert.equal(acq.ok, false);
  if (!acq.ok) {
    assert.equal(acq.error.code, DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED);
    assert.equal(acq.error.context['reason'], 'other_permission_authorized');
  }
});

test('asking the port directly and ignoring the enforcement point is not "spending" the permission', async () => {
  const b = build({ rogue: { validate_connection: 'direct_port_call' } });
  const run = await discover(b);
  assert.ok(run.ok);
  if (!run.ok) return;
  assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED);
  assert.equal(run.value.stoppedBecause?.context['reason'], 'decision_not_honoured');
  assert.notEqual(run.value.record.axes.connection, 'validated');
});

test('connector-supplied identity is ignored: authorizing as a different principal is rejected', async () => {
  const b = build({ rogue: { validate_connection: 'foreign_principal' }, otherPrincipal: authenticated('someone-else') });
  const run = await discover(b);
  assert.ok(run.ok);
  if (!run.ok) return;
  assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED);
  assert.equal(run.value.stoppedBecause?.context['reason'], 'other_principal');
  assert.notEqual(run.value.record.axes.authorization, 'granted');
});

test("connector-supplied identity is ignored: a connector cannot claim to be another connector or return another source's evidence", async () => {
  const detect = build({ rogue: { detect: 'foreign_connector' } });
  const r1 = await discover(detect);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.error.code, DiscoveryErrorCode.MALFORMED_INPUT);
  assert.equal(detect.deps.inventory.list().length, 0);

  const acquire = build({ rogue: { acquire_content: 'foreign_source' } });
  const run = await discover(acquire);
  assert.ok(run.ok && run.value.outcome !== undefined);
  const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
  const r2 = await acquireSourceContent(acquire.deps, acquireReq(sourceId), acquire.ctx);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.error.code, DiscoveryErrorCode.MALFORMED_INPUT);
  assert.equal(acquire.ledger.counts().quarantined, 2, 'the foreign evidence was contained');

  const disc = build({ rogue: { discover: 'foreign_source' } });
  const r3 = await discover(disc);
  assert.ok(r3.ok);
  if (!r3.ok) return;
  assert.equal(r3.value.stoppedBecause?.code, DiscoveryErrorCode.MALFORMED_INPUT);
  assert.equal(r3.value.evidence.length, 0);
  assert.equal(r3.value.record.axes.acquisition, 'failed', 'recorded as a failed acquisition, never as a success');
  assert.equal(disc.ledger.counts().released, 0);
});

test('a connector that reads without any audit record is rejected for discover, acquire and sync, and nothing succeeds', async () => {
  const d = build({ rogue: { discover: 'skip_audit' } });
  const run = await discover(d);
  assert.ok(run.ok);
  if (!run.ok) return;
  assert.equal(run.value.outcome, undefined);
  assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.AUDIT_UNAVAILABLE);
  assert.notEqual(run.value.record.axes.acquisition, 'succeeded');

  const a = build({ rogue: { acquire_content: 'skip_audit', incremental_sync: 'skip_audit' } });
  const ok = await discover(a);
  assert.ok(ok.ok && ok.value.outcome !== undefined);
  const sourceId = (ok.ok ? ok.value.record.source.sourceId : undefined) as SourceId;
  const acq = await acquireSourceContent(a.deps, acquireReq(sourceId), a.ctx);
  const syn = await syncSource(a.deps, { sourceId, kind: 'document_content', scope }, a.ctx);
  for (const r of [acq, syn]) {
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.AUDIT_UNAVAILABLE);
  }
});

test('sync and health get the same framework checks as acquisition', async () => {
  const b = build({ rogue: { incremental_sync: 'list_instead_of_read', health: 'skip_authorization' } });
  const run = await discover(b);
  assert.ok(run.ok && run.value.outcome !== undefined);
  const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
  const syn = await syncSource(b.deps, { sourceId, kind: 'document_content', scope }, b.ctx);
  const hl = await checkSourceHealth(b.deps, { sourceId, scope }, b.ctx);
  for (const r of [syn, hl]) {
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED);
  }
  const hs = build({ rogue: { health: 'foreign_source' } });
  const r = await discover(hs);
  assert.ok(r.ok && r.value.outcome !== undefined);
  const id = (r.ok ? r.value.record.source.sourceId : undefined) as SourceId;
  const bad = await checkSourceHealth(hs.deps, { sourceId: id, scope }, hs.ctx);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, DiscoveryErrorCode.MALFORMED_INPUT);
});
