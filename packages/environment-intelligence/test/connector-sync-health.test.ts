/**
 * C1 D1/D2: the OPTIONAL incremental_sync and health contracts, proven with the mock (the filesystem connector stays unsupported,
 * covered by the shared contract suite). No cursor is persisted by Environment Intelligence: the caller holds it.
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
  MAX_SYNC_CURSOR_LENGTH,
  checkSourceHealth,
  discoverSource,
  syncSource,
  type ConnectorContext,
  type DiscoveryDeps,
  type SourceId,
} from '../src/index.js';
import { TEST_PRINCIPAL } from './helpers.js';
import { MOCK_SOURCE_TYPE, MockConnector, type MockScope } from './support/mock-connector.js';
import { allowing } from './support/scripted-authorization.js';

const scope: MockScope = { kind: 'mock_source', path: '/mock/alpha' };

async function setup(permissions: readonly string[], options: ConstructorParameters<typeof MockConnector>[0] = {}) {
  const connector = new MockConnector(options);
  const registry = new ConnectorRegistry();
  registry.register(connector);
  const deps: DiscoveryDeps = { registry, inventory: new EnvironmentInventory() };
  const clock = new MockClock('2026-10-10T00:00:00.000Z');
  const audit = new InMemoryAuditRecorder(() => clock.now());
  const ledger = new EvidenceLedger();
  const authorization = allowing(permissions);
  const ctx: ConnectorContext = { clock, authorization, principal: TEST_PRINCIPAL, audit, ledger };
  const run = await discoverSource(deps, { sourceType: MOCK_SOURCE_TYPE, scope }, ctx);
  assert.ok(run.ok && run.value.outcome !== undefined, 'positive control: discovery works');
  const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
  connector.calls.length = 0;
  return { connector, deps, ctx, audit, ledger, sourceId, authorization };
}

const syncReq = (sourceId: SourceId, cursor?: string) => ({
  sourceId,
  kind: 'document_content' as const,
  scope,
  ...(cursor !== undefined ? { cursor } : {}),
});

test('sync is gated by the READ permission, not list; a denial leaves a denied audit record for incremental_sync', async () => {
  const s = await setup(['filesystem.list']);
  const denied = await syncSource(s.deps, syncReq(s.sourceId), s.ctx);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
  const events = s.audit.events().filter((e) => e.operation === 'incremental_sync');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.phase, 'standalone');
  assert.equal(events[0]?.outcome, 'denied');
  assert.equal(events[0]?.permission, 'filesystem.read');
});

test('sync leaves an accepted attempt and terminal record and releases its evidence only after completion', async () => {
  const s = await setup(['filesystem.list', 'filesystem.read']);
  const r = await syncSource(s.deps, syncReq(s.sourceId), s.ctx);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.evidence.length, 2);
  const events = s.audit.events().filter((e) => e.operation === 'incremental_sync');
  assert.deepEqual(
    events.map((e) => `${e.phase}:${e.outcome}`),
    ['attempt:attempted', 'terminal:completed'],
  );
  assert.equal(events[0]?.operationId, events[1]?.operationId);
  assert.equal(s.ledger.counts().released, 2 + 2, 'discovery evidence (2) plus the synced evidence (2) are released');
});

test('replaying a cursor gives the same result; a newer cursor yields only what changed; nothing is persisted', async () => {
  const s = await setup(['filesystem.list', 'filesystem.read']);
  const first = await syncSource(s.deps, syncReq(s.sourceId), s.ctx);
  assert.ok(first.ok);
  if (!first.ok) return;
  const cursor = first.value.nextCursor;
  assert.equal(cursor, 'c2');
  s.connector.append('c.txt', 'gamma');
  const before = JSON.stringify(s.deps.inventory.get(s.sourceId));
  const a = await syncSource(s.deps, syncReq(s.sourceId, cursor), s.ctx);
  const b = await syncSource(s.deps, syncReq(s.sourceId, cursor), s.ctx);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(
    a.value.evidence.map((e) => e.resourceKey),
    ['c.txt'],
  );
  assert.deepEqual(
    a.value.evidence.map((e) => e.id),
    b.value.evidence.map((e) => e.id),
    'same cursor, same evidence ids',
  );
  assert.equal(a.value.nextCursor, 'c3');
  assert.equal(JSON.stringify(s.deps.inventory.get(s.sourceId)), before, 'sync does not touch inventory state (no persisted cursor)');
});

test('a malformed or oversized cursor is refused before the connector is reached', async () => {
  const s = await setup(['filesystem.list', 'filesystem.read']);
  for (const bad of ['has space', 'nul\u0000byte', '', 'x'.repeat(MAX_SYNC_CURSOR_LENGTH + 1), 'new\nline']) {
    const r = await syncSource(s.deps, syncReq(s.sourceId, bad), s.ctx);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.MALFORMED_INPUT);
  }
  assert.deepEqual(s.connector.calls, []);
  assert.equal(s.authorization.requests.filter((q) => q.operation === 'incremental_sync').length, 0);
});

test('a connector that declares sync unsupported (and has no method) is refused with UNSUPPORTED_OPERATION and never consulted', async () => {
  const s = await setup(['filesystem.list', 'filesystem.read'], { sync: false, health: false });
  const before = s.authorization.requests.length;
  const r1 = await syncSource(s.deps, syncReq(s.sourceId), s.ctx);
  const r2 = await checkSourceHealth(s.deps, { sourceId: s.sourceId, scope }, s.ctx);
  for (const r of [r1, r2]) {
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.UNSUPPORTED_OPERATION);
  }
  assert.equal(s.authorization.requests.length, before);
  assert.deepEqual(s.connector.calls, []);
});

test('health is an authorized probe: denied without the list permission (denial-only audit), and a healthy report changes no state', async () => {
  const s = await setup(['filesystem.list']);
  const before = JSON.stringify(s.deps.inventory.get(s.sourceId));
  const ok = await checkSourceHealth(s.deps, { sourceId: s.sourceId, scope }, s.ctx);
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.value.status, 'healthy');
  assert.equal(JSON.stringify(s.deps.inventory.get(s.sourceId)), before);
  assert.equal(s.audit.events().filter((e) => e.operation === 'health').length, 0, 'success writes no attempt/terminal pair');

  const denyHealth = await setup(['filesystem.list']);
  const stricter = { ...denyHealth.ctx, authorization: allowing(['filesystem.list'], ['health']) };
  const denied = await checkSourceHealth(denyHealth.deps, { sourceId: denyHealth.sourceId, scope }, stricter);
  assert.equal(denied.ok, false);
  const events = denyHealth.audit.events().filter((e) => e.operation === 'health');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.outcome, 'denied');
});

test('a source that was never discovered cannot be synced or probed', async () => {
  const s = await setup(['filesystem.list', 'filesystem.read']);
  const unknown = 'src_unknown' as SourceId;
  const a = await syncSource(s.deps, syncReq(unknown), s.ctx);
  const b = await checkSourceHealth(s.deps, { sourceId: unknown, scope }, s.ctx);
  for (const r of [a, b]) {
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.INVALID_TRANSITION);
  }
});
