/**
 * F2 - behavior through the REAL `@xo/permissions` PermissionManager (rules, grants, revocation, audit sink),
 * not a test gate. Every denial test is paired with a positive control under the same policy/principal.
 *
 * C0.2: the verified principal is forwarded as `PermissionRequest.principal`, so a principal-scoped rule
 * (`principalId`) matches only the authenticated principal it names. Stored GRANTS remain package-keyed
 * (`PermissionGrant` has no principal), so a grant to the label still applies to every caller (D2/C0.3 scope).
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
  isAuthenticatedPrincipal,
  pathScope,
  type PermissionPolicy,
  type PermissionRequest,
  type PolicyRule,
} from '@xo/permissions';
import {
  InMemoryAuditRecorder,
  DiscoveryErrorCode,
  LocalFilesystemConnector,
  ENVIRONMENT_INTELLIGENCE_REQUESTER,
  PermissionManagerAuthorization,
  SourceId,
  acquireSourceContent,
  discoverSource,
  registerDeclaredSources,
  stableId,
  type AuthorizationRequest,
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
    audit: new InMemoryAuditRecorder(),
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
      // M2.1: identity is checked before the port/manager is consulted, so the code is the precise one (not a policy denial).
      if (!run.ok) assert.equal(run.error.code, DiscoveryErrorCode.UNAUTHENTICATED);
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

/** A rule that allows `permission` under `root` only for the principal with this id (P1.0 M2 `principalId` matching). */
const principalRule = (principalId: string, permission: PermissionId, path: string): PolicyRule => ({
  id: `allow-${permission}-for-${principalId}`,
  effect: 'ALLOW',
  match: { permission, packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER, principalId, scope: pathScope(path) },
});

const mint = (input: { kind: 'human' | 'service'; id: string; orgId?: string }) => {
  const minted = establishAuthenticatedPrincipal(input);
  assert.ok(minted.ok);
  return minted.value;
};

/** Wraps a policy, recording every `PermissionRequest` the manager actually evaluates (what the policy SEES). */
function recording(inner: PermissionPolicy): PermissionPolicy & { readonly seen: PermissionRequest[] } {
  const seen: PermissionRequest[] = [];
  return {
    seen,
    evaluate(request) {
      seen.push(request);
      return inner.evaluate(request);
    },
  };
}

const adapterRequest = (root: string, principal: unknown): AuthorizationRequest => ({
  connectorId: ConnectorId('xo.test-connector'),
  operation: 'discover',
  permission: 'filesystem.list',
  scope: pathScope(root),
  principal: principal as AuthorizationRequest['principal'],
  reason: 'c0.2 test',
});

test('principal-scoped rule: the named principal is allowed; another principal under the same label is denied with no side effects', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    const { ctx, audit } = setup([principalRule('operator-1', LIST, root)]);

    const deps = makeDeps();
    const asA = await discoverSource(deps, req(root), ctx);
    assert.ok(asA.ok, 'positive control: the principal the rule names is authorized');
    assert.equal(deps.inventory.list().length, 1);
    const allowedBefore = audit.ofType('permission.allowed').length;
    assert.ok(allowedBefore >= 1);

    const lookalikes = [
      mint({ kind: 'service', id: 'someone-else' }),
      mint({ kind: 'human', id: 'someone-else', orgId: 'operator-1' }), // an org label naming A confers nothing
      mint({ kind: 'human', id: 'operator-10' }), // id match is exact, not a prefix
    ];
    for (const other of lookalikes) {
      const bDeps = makeDeps();
      const deniedBefore = audit.ofType('permission.denied').length;
      const statSpy = mock.method(fsp, 'realpath');
      syncBuiltinESMExports();
      try {
        const asB = await discoverSource(bDeps, req(root), { ...ctx, principal: other });
        assert.ok(!asB.ok && asB.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED, `${other.id} must not use ${'operator-1'}'s rule`);
        assert.equal(statSpy.mock.callCount(), 0, 'a denied principal caused no filesystem probe');
      } finally {
        statSpy.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(bDeps.inventory.list().length, 0, 'a denied principal leaves no inventory record');
      assert.equal(audit.ofType('permission.denied').length, deniedBefore + 1, 'the denial is recorded by the existing manager audit sink');
    }
    assert.equal(audit.ofType('permission.allowed').length, allowedBefore, 'no further allow was recorded');
  });
});

test('the policy sees the verified principal snapshot, never a caller-supplied identity', async () => {
  await withSandbox(async ({ root }) => {
    const policy = recording(new RuleBasedPolicy([principalRule('operator-1', LIST, root)]));
    const manager = new PermissionManager({ policy, auditSink: new InMemoryAuditSink(), clock: new MockClock() });
    const port = new PermissionManagerAuthorization(manager);

    const b = mint({ kind: 'service', id: 'someone-else', orgId: 'org-of-operator-1' });
    // Everything a caller might smuggle in beside the authenticated principal.
    const spoofed = {
      ...adapterRequest(root, b),
      principalId: 'operator-1',
      requester: { packageId: 'xo.environment-intelligence', principal: { kind: 'human', id: 'operator-1' } },
      context: { principal: { kind: 'human', id: 'operator-1' }, environment: 'trusted' },
    } as unknown as AuthorizationRequest;
    const decision = await port.decide(spoofed);
    assert.equal(decision.effect, 'deny', "operator-1's rule does not apply to the authenticated principal");
    assert.equal(policy.seen.length, 1);
    const seen = policy.seen[0] as PermissionRequest;
    assert.deepEqual(seen.principal, { kind: 'service', id: 'someone-else', orgId: 'org-of-operator-1' });
    assert.equal(
      isAuthenticatedPrincipal(seen.principal),
      false,
      'the policy gets a plain attribution snapshot, not the authenticated object',
    );
    assert.equal(seen.context, undefined, 'no caller-supplied context reaches the policy');

    const a = mint({ kind: 'human', id: 'operator-1' });
    assert.equal((await port.decide(adapterRequest(root, a))).effect, 'allow', 'positive control: the named principal is allowed');
    assert.deepEqual((policy.seen[1] as PermissionRequest).principal, { kind: 'human', id: 'operator-1' });
  });
});

test('a missing or merely look-alike principal cannot match a principal-scoped rule, and never reaches the manager', async () => {
  await withSandbox(async ({ root }) => {
    const policy = recording(new RuleBasedPolicy([principalRule('operator-1', LIST, root)]));
    const manager = new PermissionManager({ policy, auditSink: new InMemoryAuditSink(), clock: new MockClock() });
    const port = new PermissionManagerAuthorization(manager);
    const a = mint({ kind: 'human', id: 'operator-1' });

    const notAuthenticated: ReadonlyArray<readonly [string, unknown]> = [
      ['missing', undefined],
      ['plain object with the rule-matching id', { kind: 'human', id: 'operator-1' }],
      ['spread copy of the authenticated principal', { ...a }],
      ['JSON round trip of the authenticated principal', JSON.parse(JSON.stringify(a))],
    ];
    for (const [name, principal] of notAuthenticated) {
      const decision = await port.decide(adapterRequest(root, principal));
      assert.equal(decision.effect, 'deny', name);
    }
    assert.equal(policy.seen.length, 0, 'none of them reached policy evaluation');
    assert.equal((await port.decide(adapterRequest(root, a))).effect, 'allow', 'positive control: the genuinely authenticated principal');
    assert.equal(policy.seen.length, 1);
  });
});

test("cross-principal replay: operator-1's genuine allow cannot be spent by another principal", async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    const { ctx, manager } = setup([principalRule('operator-1', LIST, root)]);
    const port = new PermissionManagerAuthorization(manager);
    const connector = new LocalFilesystemConnector();

    // Observe the exact request the connector makes for operator-1, then obtain a fresh, unspent, genuine allow for it.
    const asked: AuthorizationRequest[] = [];
    const observing = { decide: (r: AuthorizationRequest) => (asked.push(r), port.decide(r)) };
    assert.ok((await connector.discover(req(root), { ...ctx, authorization: observing })).ok);
    const original = asked[0] as AuthorizationRequest;
    const stolen = await port.decide(original);
    assert.equal(stolen.effect, 'allow');

    const b = mint({ kind: 'service', id: 'someone-else' });
    const replayed = await connector.discover(req(root), { ...ctx, principal: b, authorization: { decide: async () => stolen } });
    assert.ok(!replayed.ok && replayed.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED);
    if (!replayed.ok)
      assert.equal(
        replayed.error.context['reason'],
        'decision_binding_mismatch',
        'refused because the decision is bound to another principal',
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
