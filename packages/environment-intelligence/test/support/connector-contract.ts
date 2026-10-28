/**
 * C1 connector contract kit. ONE suite, run against every connector that has a harness (the real filesystem connector and the
 * mock). It proves the behaviour the orchestrator guarantees for ANY connector, so a new connector earns trust by passing the same
 * suite rather than by convention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockClock } from '@xo/testing';
import { err } from '@xo/types';
import {
  AuditErrorCode,
  ConnectorRegistry,
  DiscoveryErrorCode,
  EvidenceLedger,
  InMemoryAuditRecorder,
  acquireSourceContent,
  auditError,
  checkSourceHealth,
  connectorContractProblems,
  discoverSource,
  revokeSourceEvidence,
  syncSource,
  type AuditRecorder,
  type AuthorizationPort,
  type ConnectorContext,
  type ConnectorId,
  type DiscoveryDeps,
  type DiscoveryScopeBase,
  type SourceId,
  type SourceType,
} from '../../src/index.js';
import { TEST_PRINCIPAL } from '../helpers.js';
import { allowing } from './scripted-authorization.js';

export interface ContractHarness {
  readonly deps: DiscoveryDeps;
  readonly connectorId: ConnectorId;
  readonly sourceType: SourceType;
  /** The scope every request uses. */
  readonly scope: DiscoveryScopeBase;
  /** Resource keys that exist and may be acquired. */
  readonly readKeys: readonly string[];
  /** Mirrors the descriptor: which optional operations this connector really supports. */
  readonly supportsSync: boolean;
  readonly supportsHealth: boolean;
  cleanup(): Promise<void>;
}

const LIST = 'filesystem.list';
const READ = 'filesystem.read';
const REVOKE = 'data.write';

interface Env {
  readonly ctx: ConnectorContext;
  readonly audit: InMemoryAuditRecorder;
  readonly ledger: EvidenceLedger;
}

function envFor(authorization: AuthorizationPort, recorder?: AuditRecorder): Env {
  const clock = new MockClock('2026-10-10T00:00:00.000Z');
  const audit = new InMemoryAuditRecorder(() => clock.now());
  const ledger = new EvidenceLedger();
  return { audit, ledger, ctx: { clock, authorization, principal: TEST_PRINCIPAL, audit: recorder ?? audit, ledger } };
}

export function defineConnectorContract(name: string, makeHarness: () => Promise<ContractHarness>): void {
  const withHarness = async (fn: (h: ContractHarness) => Promise<void>): Promise<void> => {
    const h = await makeHarness();
    try {
      await fn(h);
    } finally {
      await h.cleanup();
    }
  };
  const discover = (h: ContractHarness, ctx: ConnectorContext) => discoverSource(h.deps, { sourceType: h.sourceType, scope: h.scope }, ctx);
  const acquire = (h: ContractHarness, sourceId: SourceId, ctx: ConnectorContext, keys: readonly string[] = h.readKeys) =>
    acquireSourceContent(h.deps, { sourceId, kind: 'document_content', resourceKeys: keys, scope: h.scope }, ctx);
  const sync = (h: ContractHarness, sourceId: SourceId, ctx: ConnectorContext, cursor?: string) =>
    syncSource(h.deps, { sourceId, kind: 'document_content', scope: h.scope, ...(cursor !== undefined ? { cursor } : {}) }, ctx);
  const health = (h: ContractHarness, sourceId: SourceId, ctx: ConnectorContext) =>
    checkSourceHealth(h.deps, { sourceId, scope: h.scope }, ctx);
  const discovered = async (h: ContractHarness, env: Env): Promise<SourceId> => {
    const run = await discover(h, env.ctx);
    assert.ok(run.ok && run.value.outcome !== undefined, 'positive control: authorized discovery succeeds');
    return run.value.record.source.sourceId;
  };
  const t = (title: string, fn: (h: ContractHarness) => Promise<void>): void => {
    test(`[contract:${name}] ${title}`, () => withHarness(fn));
  };

  t('registration: descriptor and methods are consistent, and the connector registers into a fresh registry', async (h) => {
    const connector = h.deps.registry.get(h.connectorId);
    assert.ok(connector);
    assert.deepEqual(connectorContractProblems(connector), []);
    new ConnectorRegistry().register(connector);
    assert.equal(connector.descriptor.operations.incremental_sync === 'supported', h.supportsSync);
    assert.equal(connector.descriptor.operations.health === 'supported', h.supportsHealth);
    assert.equal(typeof connector.incrementalSync === 'function', h.supportsSync);
    assert.equal(typeof connector.health === 'function', h.supportsHealth);
    for (const m of connector.descriptor.authMethods) assert.ok(['none', 'operator_scope_grant'].includes(m));
  });

  t('a structural copy of a principal is refused before the gate is consulted, for every entry point', async (h) => {
    const full = allowing([LIST, READ, REVOKE]);
    const sourceId = await discovered(h, envFor(full));
    const auth = allowing([LIST, READ]);
    const { ctx } = envFor(auth);
    const forged = { ...ctx, principal: { kind: 'human', id: 'test-operator-1' } } as unknown as ConnectorContext;
    const attempts = [
      await discover(h, forged),
      await acquire(h, sourceId, forged),
      await sync(h, sourceId, forged),
      await health(h, sourceId, forged),
    ];
    for (const r of attempts) {
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.UNAUTHENTICATED);
    }
    assert.equal(auth.requests.length, 0, 'the gate was never consulted');
  });

  t('successful detection or validation alone does not authorize acquisition', async (h) => {
    // The caller may detect but not validate: the source is in the inventory, honestly "authorization required".
    const detectOnly = allowing([LIST, READ], ['validate_connection', 'discover', 'acquire_content']);
    const env = envFor(detectOnly);
    const run = await discover(h, env.ctx);
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.equal(run.value.outcome, undefined);
    assert.equal(run.value.record.axes.authorization === 'granted', false);
    assert.equal(run.value.record.axes.connection === 'validated', false);
    const sourceId = run.value.record.source.sourceId;
    // Even a caller who now holds every permission cannot acquire from a source that never completed validation.
    const full = envFor(allowing([LIST, READ]));
    const acquired = await acquire(h, sourceId, full.ctx);
    assert.equal(acquired.ok, false);
    if (!acquired.ok) assert.equal(acquired.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    assert.equal(full.audit.events().filter((e) => e.operation === 'acquire_content').length, 0, 'no acquisition was even attempted');
  });

  t('list permission never implies read: acquisition needs its own decision', async (h) => {
    const listOnly = allowing([LIST]);
    const env = envFor(listOnly);
    const sourceId = await discovered(h, env);
    const denied = await acquire(h, sourceId, env.ctx);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    const both = envFor(allowing([LIST, READ]));
    const granted = await acquire(h, sourceId, both.ctx);
    assert.ok(granted.ok);
    if (!granted.ok) return;
    assert.ok(granted.value.evidence.length > 0);
    for (const e of granted.value.evidence) {
      assert.equal(e.provenance.access.permission, READ);
      assert.equal(e.provenance.access.operation, 'acquire_content');
    }
  });

  t('evidence is attributed to the framework-established identity, whatever the connector says', async (h) => {
    const env = envFor(allowing([LIST, READ]));
    const sourceId = await discovered(h, env);
    const r = await acquire(h, sourceId, env.ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    for (const e of r.value.evidence) {
      assert.equal(e.sourceId, sourceId);
      assert.equal(e.provenance.connectorId, h.connectorId);
      assert.equal(e.provenance.access.principal?.id, TEST_PRINCIPAL.id);
    }
  });

  t('discover and acquire each leave an accepted attempt and terminal audit record (same operation id, right permission)', async (h) => {
    const env = envFor(allowing([LIST, READ]));
    const sourceId = await discovered(h, env);
    assert.ok((await acquire(h, sourceId, env.ctx)).ok);
    const events = env.audit.events();
    for (const [operation, permission] of [
      ['discover', LIST],
      ['acquire_content', READ],
    ] as const) {
      const attempt = events.find((e) => e.operation === operation && e.phase === 'attempt');
      const terminal = events.find((e) => e.operation === operation && e.phase === 'terminal');
      assert.ok(attempt && terminal, `${operation}: attempt and terminal exist`);
      assert.equal(attempt?.outcome, 'attempted');
      assert.equal(terminal?.outcome, 'completed');
      assert.equal(attempt?.operationId, terminal?.operationId);
      assert.equal(attempt?.permission, permission);
      assert.equal(attempt?.sourceId, sourceId);
      assert.equal(events.indexOf(attempt as never) < events.indexOf(terminal as never), true, 'attempt precedes terminal');
    }
  });

  t('detect and validate keep denial-only auditing: a denial is recorded, a success writes no attempt/terminal pair', async (h) => {
    const okEnv = envFor(allowing([LIST, READ]));
    await discovered(h, okEnv);
    for (const op of ['detect', 'validate_connection'] as const)
      assert.equal(okEnv.audit.events().filter((e) => e.operation === op).length, 0, `${op}: success writes nothing`);
    const denyDetect = envFor(allowing([]));
    const refused = await discover(h, denyDetect.ctx);
    assert.equal(refused.ok, false);
    const detectEvents = denyDetect.audit.events().filter((e) => e.operation === 'detect');
    assert.equal(detectEvents.length, 1);
    assert.equal(detectEvents[0]?.phase, 'standalone');
    assert.equal(detectEvents[0]?.outcome, 'denied');
    const denyValidate = envFor(allowing([LIST], ['validate_connection']));
    const stopped = await discover(h, denyValidate.ctx);
    assert.ok(stopped.ok && stopped.value.stoppedBecause !== undefined);
    const validateEvents = denyValidate.audit.events().filter((e) => e.operation === 'validate_connection');
    assert.equal(validateEvents.length, 1);
    assert.equal(validateEvents[0]?.outcome, 'denied');
  });

  t('an audit failure cannot produce a successful transition or released evidence', async (h) => {
    const rejecting: AuditRecorder = {
      record: async () => err(auditError(AuditErrorCode.UNAVAILABLE, 'down')),
    };
    const env = envFor(allowing([LIST, READ]), rejecting);
    const run = await discover(h, env.ctx);
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.equal(run.value.outcome, undefined);
    assert.equal(run.value.evidence.length, 0);
    assert.equal(run.value.stoppedBecause?.code, DiscoveryErrorCode.AUDIT_UNAVAILABLE);
    assert.notEqual(run.value.record.axes.acquisition, 'succeeded');
    assert.notEqual(run.value.record.axes.acquisition, 'partial');
    const sourceId = run.value.record.source.sourceId;
    const acquired = await acquire(h, sourceId, env.ctx);
    assert.equal(acquired.ok, false);
    if (!acquired.ok) assert.equal(acquired.error.code, DiscoveryErrorCode.AUDIT_UNAVAILABLE);
    assert.deepEqual(env.ledger.counts(), { released: 0, quarantined: 0, revoked: 0, purged: 0 }, 'nothing was released');
  });

  t('a revoked source blocks acquire (and sync / health where supported), through the real revoke path', async (h) => {
    const auth = allowing([LIST, READ, REVOKE]);
    const env = envFor(auth);
    const sourceId = await discovered(h, env);
    assert.ok((await acquire(h, sourceId, env.ctx)).ok, 'control: acquisition works before revocation');
    if (h.supportsSync) assert.ok((await sync(h, sourceId, env.ctx)).ok, 'control: sync works before revocation');
    if (h.supportsHealth) assert.ok((await health(h, sourceId, env.ctx)).ok, 'control: health works before revocation');
    const revoked = await revokeSourceEvidence({ inventory: h.deps.inventory, ledger: env.ledger }, { sourceId }, env.ctx);
    assert.ok(revoked.ok);
    const blocked = [await acquire(h, sourceId, env.ctx), await sync(h, sourceId, env.ctx), await health(h, sourceId, env.ctx)];
    for (const r of blocked) {
      assert.equal(r.ok, false);
      if (!r.ok)
        assert.equal(
          r.error.code,
          DiscoveryErrorCode.AUTHORIZATION_REQUIRED,
          'revoked authorization is refused before the connector is reached',
        );
    }
    assert.equal(h.deps.inventory.get(sourceId)?.axes.authorization, 'revoked');
  });

  t(
    'an operation the descriptor declares unsupported is refused without reaching the gate; a supported one works end to end',
    async (h) => {
      const auth = allowing([LIST, READ]);
      const env = envFor(auth);
      const sourceId = await discovered(h, env);
      const before = auth.requests.length;
      const s = await sync(h, sourceId, env.ctx);
      const hl = await health(h, sourceId, env.ctx);
      if (h.supportsSync) {
        assert.ok(s.ok);
        if (s.ok) assert.ok(s.value.nextCursor !== undefined);
      } else {
        assert.equal(s.ok, false);
        if (!s.ok) assert.equal(s.error.code, DiscoveryErrorCode.UNSUPPORTED_OPERATION);
      }
      if (h.supportsHealth) assert.ok(hl.ok && hl.value.sourceId === sourceId);
      else {
        assert.equal(hl.ok, false);
        if (!hl.ok) assert.equal(hl.error.code, DiscoveryErrorCode.UNSUPPORTED_OPERATION);
      }
      if (!h.supportsSync && !h.supportsHealth)
        assert.equal(auth.requests.length, before, 'the gate was not consulted for unsupported operations');
    },
  );
}
