/** C1 acceptance gate 4: every connector operation has an audit counterpart, and a same-operationId retry stays idempotent. */
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
  normalizeAuditRecordRequest,
  syncSource,
  type AuditRecordRequest,
  type ConnectorContext,
  type ConnectorOperation,
  type SourceId,
} from '../src/index.js';
import { TEST_PRINCIPAL } from './helpers.js';
import { MOCK_SOURCE_TYPE, MockConnector, type MockScope } from './support/mock-connector.js';
import { allowing } from './support/scripted-authorization.js';

const scope: MockScope = { kind: 'mock_source', path: '/mock/alpha' };
const OPERATIONS: readonly ConnectorOperation[] = [
  'detect',
  'validate_connection',
  'discover',
  'acquire_content',
  'incremental_sync',
  'health',
];

function build(permissions: readonly string[], exceptOperations: readonly string[] = [], auditOptions?: ConnectorContext['auditOptions']) {
  const registry = new ConnectorRegistry();
  registry.register(new MockConnector());
  const deps = { registry, inventory: new EnvironmentInventory() };
  const clock = new MockClock('2026-10-10T00:00:00.000Z');
  const audit = new InMemoryAuditRecorder(() => clock.now());
  const ctx: ConnectorContext = {
    clock,
    authorization: allowing(permissions, exceptOperations),
    principal: TEST_PRINCIPAL,
    audit,
    ledger: new EvidenceLedger(),
    ...(auditOptions !== undefined ? { auditOptions } : {}),
  };
  return { deps, ctx, audit };
}

test('the audit vocabulary covers every connector operation (an unauditable operation cannot be added silently)', () => {
  const base: Omit<AuditRecordRequest, 'operation'> = {
    idempotencyKey: 'op_x:standalone',
    operationId: 'op_x',
    phase: 'standalone',
    outcome: 'denied',
    occurredAt: '2026-10-10T00:00:00.000Z',
    principal: { kind: 'human', id: 'u1' },
    connectorId: 'xo.connector.test-mock',
    permission: 'filesystem.read',
  };
  for (const operation of OPERATIONS)
    assert.ok(normalizeAuditRecordRequest({ ...base, operation }).ok, `${operation} is a valid audit operation`);
  assert.equal(normalizeAuditRecordRequest({ ...base, operation: 'delete_everything' }).ok, false);
});

test('each operation leaves its audit counterpart: attempt+terminal for discover/acquire/sync, a denial record for the rest', async () => {
  const all = build(['filesystem.list', 'filesystem.read']);
  const run = await discoverSource(all.deps, { sourceType: MOCK_SOURCE_TYPE, scope }, all.ctx);
  assert.ok(run.ok && run.value.outcome !== undefined);
  const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
  assert.ok((await acquireSourceContent(all.deps, { sourceId, kind: 'document_content', resourceKeys: ['a.txt'], scope }, all.ctx)).ok);
  assert.ok((await syncSource(all.deps, { sourceId, kind: 'document_content', scope }, all.ctx)).ok);
  assert.ok((await checkSourceHealth(all.deps, { sourceId, scope }, all.ctx)).ok);
  const phases = (op: string) =>
    all.audit
      .events()
      .filter((e) => e.operation === op)
      .map((e) => `${e.phase}:${e.outcome}`);
  for (const op of ['discover', 'acquire_content', 'incremental_sync'])
    assert.deepEqual(phases(op), ['attempt:attempted', 'terminal:completed'], op);
  for (const op of ['detect', 'validate_connection', 'health']) assert.deepEqual(phases(op), [], `${op}: denial-only, nothing on success`);

  // Denial of each non-audited operation is recorded as a standalone `denied` event naming that operation.
  for (const op of ['detect', 'validate_connection'] as const) {
    const denied = build(['filesystem.list', 'filesystem.read'], [op]);
    await discoverSource(denied.deps, { sourceType: MOCK_SOURCE_TYPE, scope }, denied.ctx);
    assert.deepEqual(
      denied.audit
        .events()
        .filter((e) => e.operation === op)
        .map((e) => `${e.phase}:${e.outcome}`),
      ['standalone:denied'],
      op,
    );
  }
  const noHealth = { ...all.ctx, authorization: allowing(['filesystem.list', 'filesystem.read'], ['health']) };
  const h = await checkSourceHealth(all.deps, { sourceId, scope }, noHealth);
  assert.equal(h.ok, false);
  assert.deepEqual(phases('health'), ['standalone:denied']);
});

test('a retry with the same operation id is idempotent: it succeeds and writes no second attempt or terminal event', async () => {
  const b = build(['filesystem.list', 'filesystem.read'], [], { newOperationId: () => 'op_fixed_1' });
  const { auditOptions: _fixed, ...first } = b.ctx;
  void _fixed;
  const run = await discoverSource(b.deps, { sourceType: MOCK_SOURCE_TYPE, scope }, first);
  assert.ok(run.ok && run.value.outcome !== undefined);
  const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
  const req = { sourceId, kind: 'document_content' as const, resourceKeys: ['a.txt'], scope };
  const a = await acquireSourceContent(b.deps, req, b.ctx);
  const again = await acquireSourceContent(b.deps, req, b.ctx);
  assert.ok(a.ok && again.ok);
  const events = b.audit.events().filter((e) => e.operation === 'acquire_content');
  assert.deepEqual(
    events.map((e) => e.idempotencyKey),
    ['op_fixed_1:attempt', 'op_fixed_1:terminal'],
  );

  // A contradictory event under the same key is refused rather than overwriting history.
  const attempt = events[0] as AuditRecordRequest;
  const conflict = await b.audit.record({ ...attempt, permission: 'filesystem.list' }, { principal: TEST_PRINCIPAL });
  assert.equal(conflict.ok, false);
  assert.equal(b.audit.events().filter((e) => e.operation === 'acquire_content').length, 2);
});

test('acquisition on an unauthorized source writes no acquire_content audit event at all', async () => {
  const b = build(['filesystem.list', 'filesystem.read'], ['validate_connection']);
  const run = await discoverSource(b.deps, { sourceType: MOCK_SOURCE_TYPE, scope }, b.ctx);
  assert.ok(run.ok);
  const sourceId = (run.ok ? run.value.record.source.sourceId : undefined) as SourceId;
  const r = await acquireSourceContent(b.deps, { sourceId, kind: 'document_content', resourceKeys: ['a.txt'], scope }, b.ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
  assert.equal(b.audit.events().filter((e) => e.operation === 'acquire_content').length, 0);
});
