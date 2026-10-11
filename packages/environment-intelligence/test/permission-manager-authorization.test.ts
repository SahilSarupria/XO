/**
 * F2 - behavior through the REAL `@xo/permissions` PermissionManager (rules, grants, revocation, audit sink),
 * not a test gate. Every denial test is paired with a positive control under the same policy/principal.
 *
 * Known limitation pinned by a test below: on `main`, grants and rules match on the requester PACKAGE LABEL
 * (`xo.environment-intelligence`), not on the principal, so the principal is a precondition and provenance
 * input only. Binding principal to requester is unresolved (P1.0).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { mock } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import {
  InMemoryAuditSink,
  PermissionId,
  PermissionManager,
  RuleBasedPolicy,
  establishAuthenticatedPrincipal,
  pathScope,
  type PolicyRule,
} from '@xo/permissions';
import {
  DiscoveryErrorCode,
  ENVIRONMENT_INTELLIGENCE_REQUESTER,
  PermissionManagerAuthorization,
  SourceId,
  acquireSourceContent,
  discoverSource,
  registerDeclaredSources,
  stableId,
  type ConnectorContext,
  type FilesystemScope,
} from '../src/index.js';
import { ConnectorId } from '../src/index.js';
import { makeDeps, put, withSandbox } from './helpers.js';
import type { DetectedSource } from '../src/index.js';

const scopeOf = (root: string): FilesystemScope =>
  ({ kind: 'filesystem_root', root, includeExtensions: [], maxDepth: 4 }) as FilesystemScope;
const req = (root: string) => ({ sourceType: 'local_filesystem' as const, scope: scopeOf(root) });
const LIST = PermissionId('filesystem.list');
const READ = PermissionId('filesystem.read');

const allowRule = (permission: PermissionId, path?: string): PolicyRule => ({
  id: `allow-${permission}-${path ?? 'any'}`,
  effect: 'ALLOW',
  match: { permission, packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER, ...(path !== undefined ? { scope: pathScope(path) } : {}) },
});

function setup(rules: readonly PolicyRule[] = []) {
  const audit = new InMemoryAuditSink();
  const clock = new MockClock();
  const manager = new PermissionManager({ policy: new RuleBasedPolicy(rules), auditSink: audit, clock });
  const principal = establishAuthenticatedPrincipal({ kind: 'human', id: 'operator-1' });
  assert.ok(principal.ok);
  const ctx: ConnectorContext = {
    clock,
    authorization: new PermissionManagerAuthorization(manager),
    ...(principal.ok ? { principal: principal.value } : {}),
  };
  return { audit, manager, ctx, clock };
}

test('policy ALLOW through the real manager authorizes discovery with derived platform authority', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const { ctx, audit } = setup([allowRule(LIST, root)]);
    const deps = makeDeps();
    const run = await discoverSource(deps, req(root), ctx);
    assert.ok(run.ok);
    const authorities = run.ok ? run.value.evidence.map((e) => e.provenance.access.authority) : [];
    assert.ok(authorities.length > 0);
    for (const a of authorities) assert.equal(a, 'platform');
    assert.ok(audit.ofType('permission.allowed').length >= 1, 'the manager recorded the allow in its own audit sink');
    assert.equal(deps.inventory.list().length, 1);
  });
});

test('default deny through the real manager: no record, no probing, a denial in the manager audit sink', async () => {
  await withSandbox(async ({ root }) => {
    const { ctx, audit } = setup([]);
    const deps = makeDeps();
    const statSpy = mock.method(fsp, 'realpath');
    syncBuiltinESMExports();
    try {
      const run = await discoverSource(deps, req(root), ctx);
      assert.equal(run.ok, false);
      if (!run.ok) assert.equal(run.error.code, DiscoveryErrorCode.AUTHORIZATION_DENIED);
      assert.equal(statSpy.mock.callCount(), 0, 'the denied request caused no realpath probe');
    } finally {
      statSpy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(deps.inventory.list().length, 0);
    assert.ok(
      audit.ofType('permission.denied').length >= 1,
      'denial is recorded by the existing manager audit mechanism (no new one added)',
    );
  });
});

test('an unauthenticated principal is denied under a policy that allows an authenticated one', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    const { ctx } = setup([allowRule(LIST, root)]);
    const spoof = { kind: 'human', id: 'operator-1' } as unknown as ConnectorContext['principal'];
    const attacks: ConnectorContext[] = [
      { clock: ctx.clock, authorization: ctx.authorization },
      { clock: ctx.clock, authorization: ctx.authorization, ...(spoof !== undefined ? { principal: spoof } : {}) },
    ];
    for (const attack of attacks) {
      const deps = makeDeps();
      const run = await discoverSource(deps, req(root), attack);
      assert.equal(run.ok, false);
      if (!run.ok) assert.equal(run.error.code, DiscoveryErrorCode.AUTHORIZATION_DENIED);
      assert.equal(deps.inventory.list().length, 0);
    }
    assert.ok((await discoverSource(makeDeps(), req(root), ctx)).ok, 'positive control: authenticated principal, same policy');
  });
});

test('a list-only policy authorizes discovery but not content acquisition', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const acquire = async (rules: readonly PolicyRule[]) => {
      const { ctx } = setup(rules);
      const deps = makeDeps();
      const run = await discoverSource(deps, req(root), ctx);
      assert.ok(run.ok, 'discovery is authorized by the list rule');
      const sourceId = run.ok ? run.value.record.source.sourceId : SourceId('x');
      return acquireSourceContent(deps, { sourceId, kind: 'document_content', resourceKeys: ['a.txt'], scope: scopeOf(root) }, ctx);
    };
    const listOnly = await acquire([allowRule(LIST, root)]);
    assert.equal(listOnly.ok, false, 'read permission is separate');
    if (!listOnly.ok) assert.equal(listOnly.error.code, DiscoveryErrorCode.AUTHORIZATION_DENIED);
    const withRead = await acquire([allowRule(LIST, root), allowRule(READ, root)]);
    assert.ok(withRead.ok, 'positive control: same flow with a read rule');
  });
});

test('a policy for a different path denies; a parent-path policy allows', async () => {
  await withSandbox(async ({ root, outside, base }) => {
    await put(join(root, 'a.txt'), 'x');
    assert.ok(!(await discoverSource(makeDeps(), req(root), setup([allowRule(LIST, outside)]).ctx)).ok);
    assert.ok((await discoverSource(makeDeps(), req(root), setup([allowRule(LIST, base)]).ctx)).ok);
  });
});

test('a grant then revoke: the next operation is denied (no stale allow)', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    const { ctx, manager } = setup([]);
    const granted = await manager.grant({ packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER, permission: LIST, scope: pathScope(root) });
    assert.ok(granted.ok);
    assert.ok((await discoverSource(makeDeps(), req(root), ctx)).ok, 'allowed while the grant stands');
    const revoked = await manager.revoke({ kind: 'package', packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER });
    assert.ok(revoked.ok);
    const after = await discoverSource(makeDeps(), req(root), ctx);
    assert.ok(!after.ok && after.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED);
  });
});

test('a PROMPT policy is a denial: this adapter never prompts', async () => {
  await withSandbox(async ({ root }) => {
    const rule: PolicyRule = { id: 'p', effect: 'PROMPT', match: { permission: LIST, packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER } };
    const deps = makeDeps();
    const run = await discoverSource(deps, req(root), setup([rule]).ctx);
    assert.equal(run.ok, false);
    if (!run.ok) assert.equal(run.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    assert.equal(deps.inventory.list().length, 0);
  });
});

test('a throwing manager yields a generic internal error without leaking the message', async () => {
  await withSandbox(async ({ root }) => {
    const { ctx, manager } = setup([allowRule(LIST, root)]);
    mock.method(manager, 'check', async () => {
      throw new Error('DB-PASSWORD-xyz');
    });
    const deps = makeDeps();
    const run = await discoverSource(deps, req(root), ctx);
    assert.equal(run.ok, false);
    if (!run.ok) assert.ok(!JSON.stringify(run.error).includes('DB-PASSWORD-xyz'));
    assert.equal(deps.inventory.list().length, 0);
  });
});

test('the adapter refuses a duck-typed stand-in for PermissionManager', () => {
  const fake = { check: async () => ({ effect: 'allow' }) } as unknown as PermissionManager;
  assert.throws(() => new PermissionManagerAuthorization(fake), TypeError);
});

test('LIMITATION: grants match the package label, not the principal - two principals get the same decision', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    const { ctx } = setup([allowRule(LIST, root)]);
    const other = establishAuthenticatedPrincipal({ kind: 'service', id: 'someone-else' });
    assert.ok(other.ok);
    const asOther = { ...ctx, ...(other.ok ? { principal: other.value } : {}) };
    assert.ok((await discoverSource(makeDeps(), req(root), ctx)).ok);
    assert.ok(
      (await discoverSource(makeDeps(), req(root), asOther)).ok,
      'documents the gap: the principal cannot restrict what the label may do',
    );
  });
});

const declared: DetectedSource = {
  sourceId: SourceId(stableId('src', ['saas_application', 'acme-crm'])),
  sourceType: 'saas_application',
  displayName: 'Acme CRM',
  locator: 'acme-crm',
  detectedBy: ConnectorId('xo.admin-inventory'),
  detectedAt: '2000-01-01T00:00:00.000Z',
  fingerprint: 'declared',
};

test('registerDeclaredSources through the real manager: default deny writes nothing; a data.write policy allows', async () => {
  const denied = setup([]);
  const deps = makeDeps();
  const r = await registerDeclaredSources(deps, [declared], denied.ctx);
  assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED);
  assert.equal(deps.inventory.list().length, 0);
  assert.ok(denied.audit.ofType('permission.denied').length >= 1);

  const rule: PolicyRule = {
    id: 'w',
    effect: 'ALLOW',
    match: { permission: PermissionId('data.write'), packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER },
  };
  const allowed = setup([rule]);
  const deps2 = makeDeps();
  const ok2 = await registerDeclaredSources(deps2, [declared], allowed.ctx);
  assert.ok(ok2.ok);
  assert.equal(deps2.inventory.list().length, 1);

  const noPrincipal = await registerDeclaredSources(makeDeps(), [declared], {
    clock: allowed.clock,
    authorization: allowed.ctx.authorization,
  });
  assert.equal(noPrincipal.ok, false, 'unauthenticated callers cannot declare sources even under an allow rule');
});

test('AUDIT GAP (pinned, not fixed): denials before the manager is consulted leave no audit event; manager denials do', async () => {
  await withSandbox(async ({ root }) => {
    const { ctx, audit } = setup([allowRule(LIST, root)]);
    // Unauthenticated: denied by the adapter before the manager is reached -> nothing recorded anywhere.
    const noPrincipal = await discoverSource(makeDeps(), req(root), { clock: ctx.clock, authorization: ctx.authorization });
    assert.equal(noPrincipal.ok, false);
    assert.equal(audit.all().length, 0, 'no audit event for an unauthenticated denial (needs the M2.2 audit port / P1.0 M4 decision)');
    // Control: a request that reaches the manager IS recorded by the manager's own sink.
    const denied = setup([]);
    await discoverSource(makeDeps(), req(root), denied.ctx);
    assert.ok(denied.audit.all().length > 0);
  });
});
