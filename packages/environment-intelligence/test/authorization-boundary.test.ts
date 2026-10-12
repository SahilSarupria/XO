/**
 * M2.1 - Authorization Boundary.
 *
 * Detection, validation, discovery and authorization are separate operations; discovery never implies
 * authorization; identity comes only from an authenticated principal; an allow must answer THIS request and stay
 * inside the granted scope; and anything else (missing policy, malformed or unavailable decision, a throwing
 * dependency) fails closed.
 *
 * Every rejection test is paired with a positive control under the same policy, and ordering is proven by using
 * roots that do not exist: a gate rejection must surface as the GATE's error, never as a later path error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import {
  InMemoryAuditSink,
  PermissionId,
  PermissionManager,
  RuleBasedPolicy,
  establishAuthenticatedPrincipal,
  globalScope,
  hostScope,
  isAuthenticatedPrincipal,
  pathScope,
  resourceScope,
  toPrincipalSnapshot,
  type PermissionScope,
  type PolicyRule,
} from '@xo/permissions';
import * as pkg from '../src/index.js';
import {
  DiscoveryErrorCode,
  ENVIRONMENT_INTELLIGENCE_REQUESTER,
  InMemoryAuditRecorder,
  LocalFilesystemConnector,
  PermissionManagerAuthorization,
  SourceId,
  acquireSourceContent,
  discoverSource,
  registerDeclaredSources,
  stableId,
  type AuthorizationDecision,
  type AuthorizationPort,
  type AuthorizationRequest,
  type ConnectorContext,
  type DetectedSource,
  type FilesystemScope,
} from '../src/index.js';
import { requireAuthorization } from '../src/authorization-gate.js';
import { mintBoundDevelopmentDecision, mintPlatformDecision } from '../src/trusted-decision.js';
import { ConnectorId } from '../src/ids.js';
import { TEST_PRINCIPAL, allowRoot, authenticated, ctxFor, failClosed, makeDeps, put, withSandbox } from './helpers.js';

const scopeOf = (root: string): FilesystemScope =>
  ({ kind: 'filesystem_root', root, includeExtensions: [], maxDepth: 4 }) as FilesystemScope;
const request = (root: string) => ({ sourceType: 'local_filesystem' as const, scope: scopeOf(root) });
const LIST = 'filesystem.list';
const READ = 'filesystem.read';

/** Wraps a port, counting how often the gate actually consulted it. */
function counting(inner: AuthorizationPort): AuthorizationPort & { readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async decide(req) {
      calls += 1;
      return inner.decide(req);
    },
  };
}

const withPrincipal = (ctx: ConnectorContext, principal: unknown): ConnectorContext => ({
  ...ctx,
  principal: principal as ConnectorContext['principal'],
});

/** Everything a caller could present as "who I am" that is NOT an authenticated principal. */
const NOT_AUTHENTICATED: ReadonlyArray<readonly [string, () => unknown]> = [
  ['missing', () => undefined],
  ['plain object with a valid shape', () => ({ kind: 'human', id: 'operator-1' })],
  ['spread copy of an authenticated principal', () => ({ ...TEST_PRINCIPAL })],
  ['structuredClone of an authenticated principal', () => structuredClone(TEST_PRINCIPAL)],
  ['JSON round trip of an authenticated principal', () => JSON.parse(JSON.stringify(TEST_PRINCIPAL))],
  ['object inheriting from an authenticated principal', () => Object.create(TEST_PRINCIPAL)],
  ['authority-bearing extras', () => ({ kind: 'service', id: 'root', roles: ['admin'], authority: 'platform', orgId: 'victim' })],
  ['empty object', () => ({})],
  ['null', () => null],
  ['a bare string id', () => 'operator-1'],
];

// ---------------------------------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------------------------------

test('every protected entry point rejects every non-authenticated principal, before the port is consulted or anything is probed', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const missing = join(base, 'does-not-exist'); // a gate rejection must NOT degrade into SOURCE_UNAVAILABLE
    const declared: DetectedSource = {
      sourceId: SourceId(stableId('src', ['declared', 'x'])),
      sourceType: 'saas_application',
      displayName: 'x',
      locator: 'x',
      detectedBy: ConnectorId('admin'),
      detectedAt: '2026-10-12T00:00:00.000Z',
      fingerprint: 'f',
    };
    const connector = new LocalFilesystemConnector();

    for (const [name, make] of NOT_AUTHENTICATED) {
      const port = counting(allowRoot(base, [LIST, READ]));
      const ctx = withPrincipal(ctxFor(port), make());

      const deps = makeDeps();
      const run = await discoverSource(deps, request(missing), ctx);
      assert.ok(!run.ok && run.error.code === DiscoveryErrorCode.UNAUTHENTICATED, `discoverSource: ${name}`);
      assert.equal(deps.inventory.list().length, 0, `${name}: no inventory record`);

      const acq = await acquireSourceContent(
        deps,
        { sourceId: SourceId('src_unknown'), kind: 'document_content', resourceKeys: ['a.txt'], scope: scopeOf(root) },
        ctx,
      );
      assert.ok(!acq.ok && acq.error.code === DiscoveryErrorCode.UNAUTHENTICATED, `acquireSourceContent: ${name} (not INVALID_TRANSITION)`);

      const decl = await registerDeclaredSources(deps, [declared], ctx);
      assert.ok(!decl.ok && decl.error.code === DiscoveryErrorCode.UNAUTHENTICATED, `registerDeclaredSources: ${name}`);
      assert.equal(deps.inventory.list().length, 0, `${name}: declaration created nothing`);

      const results = [
        await connector.detectSource(request(missing), ctx),
        await connector.validateConnection(request(missing), ctx),
        await connector.discover(request(missing), ctx),
        await connector.acquireContent(
          { sourceId: SourceId('src_x'), kind: 'document_content', resourceKeys: ['a.txt'], scope: scopeOf(missing) },
          ctx,
        ),
      ];
      for (const r of results) assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.UNAUTHENTICATED, `connector: ${name}`);
      assert.equal(port.calls(), 0, `${name}: the authorization port was never consulted`);
    }

    // Positive control: the same calls with a genuinely authenticated principal reach the port and succeed.
    const port = counting(allowRoot(base, [LIST, READ]));
    const deps = makeDeps();
    const good = await discoverSource(deps, request(root), ctxFor(port));
    assert.ok(good.ok, 'authenticated discovery succeeds');
    assert.ok(port.calls() > 0, 'and it consulted the port');
    const nowhere = await discoverSource(makeDeps(), request(missing), ctxFor(allowRoot(base)));
    assert.ok(
      !nowhere.ok && nowhere.error.code === DiscoveryErrorCode.SOURCE_UNAVAILABLE,
      'control: the missing root fails at the PATH once identity is fine',
    );
  });
});

test('an unauthenticated rejection is identical whatever was asked, so it cannot be used to learn what exists', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const deps = makeDeps();
    assert.ok((await discoverSource(deps, request(root), ctxFor(allowRoot(base, [LIST])))).ok);
    const sourceId = deps.inventory.list()[0]?.source.sourceId as ReturnType<typeof SourceId>;
    const anon = withPrincipal(ctxFor(allowRoot(base, [LIST, READ])), undefined);
    const known = await acquireSourceContent(
      deps,
      { sourceId, kind: 'document_content', resourceKeys: ['a.txt'], scope: scopeOf(root) },
      anon,
    );
    const unknown = await acquireSourceContent(
      deps,
      { sourceId: SourceId('src_nope'), kind: 'document_content', resourceKeys: ['a.txt'], scope: scopeOf(root) },
      anon,
    );
    assert.ok(!known.ok && !unknown.ok);
    if (!known.ok && !unknown.ok) assert.deepEqual(known.error, unknown.error, 'a known and an unknown source are indistinguishable');
  });
});

test('identity cannot be spoofed through environment variables, request metadata, or discovery results', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const saved = { ...process.env };
    Object.assign(process.env, {
      XO_PRINCIPAL_ID: 'operator-1',
      XO_PRINCIPAL_KIND: 'human',
      XO_USER: 'operator-1',
      XO_AUTHENTICATED: 'true',
    });
    try {
      const anon = withPrincipal(ctxFor(allowRoot(base, [LIST, READ])), undefined);
      const viaEnv = await discoverSource(makeDeps(), request(root), anon);
      assert.ok(!viaEnv.ok && viaEnv.error.code === DiscoveryErrorCode.UNAUTHENTICATED, 'environment variables are not identity');

      // Principal-shaped and authority-shaped fields smuggled into the request scope are inert data.
      const smuggled = {
        sourceType: 'local_filesystem' as const,
        scope: { ...scopeOf(root), principal: TEST_PRINCIPAL, authority: 'platform', authenticated: true } as unknown as FilesystemScope,
      };
      const viaScope = await discoverSource(makeDeps(), smuggled, anon);
      assert.ok(!viaScope.ok && viaScope.error.code === DiscoveryErrorCode.UNAUTHENTICATED, 'request metadata is not identity');
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }

    // A principal read back out of a discovery result is a plain snapshot, not an authenticated principal.
    const deps = makeDeps();
    const first = await discoverSource(deps, request(root), ctxFor(allowRoot(base, [LIST])));
    assert.ok(first.ok);
    const fromResult = first.ok ? first.value.evidence[0]?.provenance.access.principal : undefined;
    assert.ok(fromResult !== undefined);
    assert.equal(isAuthenticatedPrincipal(fromResult), false, 'provenance carries a plain snapshot');
    const replayed = await discoverSource(makeDeps(), request(root), withPrincipal(ctxFor(allowRoot(base, [LIST])), fromResult));
    assert.ok(!replayed.ok && replayed.error.code === DiscoveryErrorCode.UNAUTHENTICATED, 'a discovery result cannot be used as identity');
    assert.deepEqual(fromResult, { kind: 'human', id: TEST_PRINCIPAL.id }, 'and it is exactly the verified principal, nothing more');
  });
});

test('a platform-looking decision cannot stand in for identity: the principal check precedes the port entirely', async () => {
  await withSandbox(async ({ root }) => {
    const forgingPort: AuthorizationPort = {
      decide: async () => mintPlatformDecision('allow', 'platform says yes', undefined),
    };
    const anon = withPrincipal(ctxFor(forgingPort), undefined);
    const r = await discoverSource(makeDeps(), request(root), anon);
    assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.UNAUTHENTICATED);
    // Control: with an authenticated principal the same port is consulted, and its UNBOUND platform decision is still refused.
    const ctl = await discoverSource(makeDeps(), request(root), ctxFor(forgingPort));
    assert.ok(!ctl.ok && ctl.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED);
    if (!ctl.ok) assert.equal(ctl.error.context['reason'], 'unbound_platform_decision');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Authoritative decisions, through the real platform PermissionManager
// ---------------------------------------------------------------------------------------------------------------------

const allowRule = (permission: string, path: string): PolicyRule => ({
  id: `allow-${permission}-${path.length}`,
  effect: 'ALLOW',
  match: { permission: PermissionId(permission), packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER, scope: pathScope(path) },
});

function platform(rules: readonly PolicyRule[], manager?: PermissionManager) {
  const clock = new MockClock();
  const audit = new InMemoryAuditSink();
  const m = manager ?? new PermissionManager({ policy: new RuleBasedPolicy(rules), auditSink: audit, clock });
  const ctx: ConnectorContext = {
    clock,
    authorization: new PermissionManagerAuthorization(m),
    principal: TEST_PRINCIPAL,
    audit: new InMemoryAuditRecorder(),
  };
  return { ctx, audit };
}

test('platform decisions: authorized vs unauthorized operations, and requested scope within vs outside the granted scope', async () => {
  await withSandbox(async ({ root }) => {
    const sub = join(root, 'sub');
    await put(join(sub, 'a.txt'), 'INV-1042');
    await put(join(root, 'top.txt'), 'x');
    // Policy grants listing for `sub` ONLY.
    const { ctx } = platform([allowRule(LIST, sub)]);

    const inside = await discoverSource(makeDeps(), request(sub), ctx);
    assert.ok(inside.ok, 'positive control: the granted subtree is discoverable');
    if (inside.ok) {
      assert.ok(inside.value.evidence.length > 0);
      for (const e of inside.value.evidence) assert.equal(e.provenance.access.authority, 'platform');
    }

    const outside = await discoverSource(makeDeps(), request(root), ctx);
    assert.ok(
      !outside.ok && outside.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED,
      'the parent of the granted scope is not granted',
    );

    // A path that merely shares a string prefix with the granted scope is outside it.
    const sibling = `${sub}-secret`;
    await put(join(sibling, 'b.txt'), 'x');
    const lookalike = await discoverSource(makeDeps(), request(sibling), ctx);
    assert.ok(!lookalike.ok && lookalike.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED, '/x/sub-secret is not inside /x/sub');

    // Listing granted, reading not: a different permission is a different decision.
    const deps = makeDeps();
    assert.ok((await discoverSource(deps, request(sub), ctx)).ok);
    const sourceId = deps.inventory.list()[0]?.source.sourceId as ReturnType<typeof SourceId>;
    const read = await acquireSourceContent(
      deps,
      { sourceId, kind: 'document_content', resourceKeys: ['a.txt'], scope: scopeOf(sub) },
      ctx,
    );
    assert.ok(!read.ok && read.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED, 'filesystem.read was never granted');
    const readCtl = platform([allowRule(LIST, sub), allowRule(READ, sub)]);
    const deps2 = makeDeps();
    assert.ok((await discoverSource(deps2, request(sub), readCtl.ctx)).ok);
    const id2 = deps2.inventory.list()[0]?.source.sourceId as ReturnType<typeof SourceId>;
    const readOk = await acquireSourceContent(
      deps2,
      { sourceId: id2, kind: 'document_content', resourceKeys: ['a.txt'], scope: scopeOf(sub) },
      readCtl.ctx,
    );
    assert.ok(readOk.ok, 'positive control: with filesystem.read granted the same acquisition succeeds');
  });
});

test('missing policy, an empty policy and the fail-closed default all deny; nothing falls back to allow', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    const none = platform([]);
    const r1 = await discoverSource(makeDeps(), request(root), none.ctx);
    assert.ok(!r1.ok && r1.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED, 'no rule: default deny');
    const r2 = await discoverSource(makeDeps(), request(root), ctxFor(failClosed()));
    assert.ok(!r2.ok && r2.error.code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'no gate configured: fail closed');
    const r3 = await discoverSource(makeDeps(), request(root), ctxFor(allowRoot(join(root, 'elsewhere'))));
    assert.ok(
      !r3.ok && r3.error.code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED,
      'a grant that does not cover the request: not authorized',
    );
    assert.ok((await discoverSource(makeDeps(), request(root), platform([allowRule(LIST, root)]).ctx)).ok, 'positive control');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Missing / malformed / unavailable decisions
// ---------------------------------------------------------------------------------------------------------------------

const malformed: ReadonlyArray<readonly [string, () => unknown]> = [
  ['undefined', () => undefined],
  ['null', () => null],
  ['empty object', () => ({})],
  ['unknown effect', () => ({ effect: 'maybe', reason: 'x' })],
  ['allow without a trusted mint', () => ({ effect: 'allow', reason: 'x' })],
  ['allow claiming platform authority', () => ({ effect: 'allow', reason: 'x', authority: 'platform' })],
  ['array', () => ['allow']],
  ['number', () => 1],
];

test('missing and malformed decisions never authorize', async () => {
  await withSandbox(async ({ base, root }) => {
    for (const [name, make] of malformed) {
      const port: AuthorizationPort = { decide: async () => make() as AuthorizationDecision };
      const deps = makeDeps();
      const r = await discoverSource(deps, request(join(base, 'does-not-exist')), ctxFor(port));
      assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED, `${name}: fails at the gate`);
      assert.equal(deps.inventory.list().length, 0, name);
    }
    assert.ok((await discoverSource(makeDeps(), request(root), ctxFor(allowRoot(root)))).ok, 'positive control');
  });
});

test('an unavailable authorization dependency fails closed without leaking its message or probing the path', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const throwing: ReadonlyArray<readonly [string, AuthorizationPort]> = [
      ['rejecting port', { decide: async () => Promise.reject(new Error('db down at /secret/host/path')) }],
      [
        'throwing port',
        {
          decide: () => {
            throw new Error('cannot reach /secret/host/path');
          },
        },
      ],
    ];
    class DownManager extends PermissionManager {
      override check(): never {
        throw new Error('policy store unreachable /secret/host/path');
      }
    }
    const down = new DownManager({ policy: new RuleBasedPolicy([]), auditSink: new InMemoryAuditSink(), clock: new MockClock() });
    const all: ReadonlyArray<readonly [string, AuthorizationPort]> = [
      ...throwing,
      ['platform manager throwing', new PermissionManagerAuthorization(down)],
    ];
    for (const [name, port] of all) {
      const deps = makeDeps();
      const r = await discoverSource(deps, request(join(base, 'does-not-exist')), ctxFor(port));
      assert.ok(!r.ok, name);
      if (!r.ok) {
        assert.equal(r.error.code, DiscoveryErrorCode.INTERNAL, `${name}: structured internal error`);
        assert.ok(!JSON.stringify(r.error).includes('/secret/host/path'), `${name}: message not leaked`);
        assert.notEqual(r.error.code, DiscoveryErrorCode.SOURCE_UNAVAILABLE, `${name}: not a later path error`);
      }
      assert.equal(deps.inventory.list().length, 0, `${name}: nothing recorded`);
    }
    assert.ok((await discoverSource(makeDeps(), request(root), ctxFor(allowRoot(root)))).ok, 'positive control');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Request shape and scope containment at the enforcement point
// ---------------------------------------------------------------------------------------------------------------------

const baseRequest = (over: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  connectorId: ConnectorId('xo.test'),
  operation: 'discover',
  permission: LIST,
  scope: pathScope('/srv/data'),
  principal: TEST_PRINCIPAL,
  reason: 'test',
  ...over,
});
/** Would genuinely allow any /srv request IF consulted, so "not consulted" is observable and meaningful. */
const everythingAllowed: AuthorizationPort = allowRoot('/srv');

test('ambiguous, global and non-path scopes are refused before the port is consulted; a malformed permission id is malformed input', async () => {
  const ambiguous: ReadonlyArray<readonly [string, PermissionScope]> = [
    ['global', globalScope()],
    ['host', hostScope('example.com')],
    ['relative path', { kind: 'path', path: 'relative/dir' }],
    ['dot segment', { kind: 'path', path: '/srv/data/../etc' }],
    ['current-dir segment', { kind: 'path', path: '/srv/./data' }],
    ['NUL in path', { kind: 'path', path: '/srv/da\u0000ta' }],
    ['empty resource', resourceScope('')],
    ['not a scope at all', { kind: 'wildcard' } as unknown as PermissionScope],
  ];
  for (const [name, scope] of ambiguous) {
    const port = counting(everythingAllowed);
    const r = await requireAuthorization(port, baseRequest({ scope }));
    assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.SCOPE_VIOLATION, name);
    assert.equal(port.calls(), 0, `${name}: port not consulted`);
  }
  for (const permission of ['', 'read', 'FILESYSTEM.READ', 'filesystem.read ', 'nonsense.read', '*']) {
    const port = counting(everythingAllowed);
    const r = await requireAuthorization(port, baseRequest({ permission }));
    assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.MALFORMED_INPUT, `permission ${JSON.stringify(permission)}`);
    assert.equal(port.calls(), 0);
  }
  const ok = await requireAuthorization(counting(allowRoot('/srv')), baseRequest());
  assert.ok(ok.ok, 'positive control: an acceptable request with a genuine allow');
});

const bind = (req: AuthorizationRequest, over: Record<string, unknown> = {}) => ({
  principal: toPrincipalSnapshot(TEST_PRINCIPAL),
  connectorId: req.connectorId,
  operation: req.operation,
  permission: req.permission,
  requestedScope: req.scope,
  grantedScope: pathScope('/srv'),
  ...over,
});

test('scope containment: a granted scope narrower than, disjoint from, or missing relative to the request is refused', async () => {
  const req = baseRequest(); // asks for /srv/data
  const answer = (over: Record<string, unknown>): AuthorizationPort => ({
    decide: async (r) => mintBoundDevelopmentDecision('allow', 'x', bind(r, over) as Parameters<typeof mintBoundDevelopmentDecision>[2]),
  });
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['narrower grant (/srv/data/sub)', { grantedScope: pathScope('/srv/data/sub') }],
    ['disjoint grant', { grantedScope: pathScope('/other') }],
    ['string-prefix lookalike (/srv/dat)', { grantedScope: pathScope('/srv/dat') }],
    ['grant of a different kind', { grantedScope: resourceScope('environment-intelligence/inventory') }],
    ['no granted scope recorded', { grantedScope: undefined }],
  ];
  for (const [name, over] of cases) {
    const r = await requireAuthorization(answer(over), req);
    assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.SCOPE_VIOLATION, name);
    if (!r.ok) assert.equal(r.error.context['reason'], 'granted_scope_does_not_contain_request', name);
  }
  for (const [name, grantedScope] of [
    ['exact grant', pathScope('/srv/data')],
    ['broader grant', pathScope('/srv')],
  ] as const) {
    const r = await requireAuthorization(answer({ grantedScope }), req);
    assert.ok(r.ok, `positive control: ${name}`);
    if (r.ok) assert.deepEqual(r.value.grant.grantedScope, grantedScope);
  }
});

test('decision binding: an allow for another principal, operation, permission or scope is not an allow for this request', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const sibling = join(base, 'approved-two');
    await put(join(sibling, 'b.txt'), 'x');
    const inner = allowRoot(base, [LIST, READ]);
    const other = authenticated('someone-else');
    const swaps: ReadonlyArray<readonly [string, (r: AuthorizationRequest) => AuthorizationRequest]> = [
      ['different operation', (r) => ({ ...r, operation: r.operation === 'discover' ? 'detect' : 'discover' })],
      ['different permission', (r) => ({ ...r, permission: r.permission === LIST ? READ : LIST })],
      ['different principal', (r) => ({ ...r, principal: other })],
      ['different scope', (r) => ({ ...r, scope: { kind: 'path', path: sibling } })],
    ];
    const connector = new LocalFilesystemConnector();
    for (const [name, swap] of swaps) {
      // The port answers a DIFFERENT question than the one it was asked, with a genuine, correctly-minted decision.
      const confused: AuthorizationPort = { decide: (r) => inner.decide(swap(r)) };
      const r = await connector.discover(request(root), ctxFor(confused));
      assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED, name);
      if (!r.ok) assert.equal(r.error.context['reason'], 'decision_binding_mismatch', name);
    }
    const honest = await connector.discover(request(root), ctxFor(inner));
    assert.ok(honest.ok, 'positive control: the honestly answered request succeeds');
  });
});

test('decision replay: a bound decision is single-use', async () => {
  await withSandbox(async ({ root }) => {
    const inner = allowRoot(root, [LIST]);
    let cached: AuthorizationDecision | undefined;
    const replaying: AuthorizationPort = {
      decide: async (r) => {
        cached ??= await inner.decide(r);
        return cached;
      },
    };
    const connector = new LocalFilesystemConnector();
    const first = await connector.detectSource(request(root), ctxFor(replaying));
    assert.ok(first.ok, 'first presentation is honoured');
    const second = await connector.detectSource(request(root), ctxFor(replaying));
    assert.ok(!second.ok && second.error.code === DiscoveryErrorCode.AUTHORIZATION_DENIED, 'the same object presented again is a replay');
    if (!second.ok) assert.equal(second.error.context['reason'], 'decision_replayed');
    const fresh = await connector.detectSource(request(root), ctxFor(inner));
    assert.ok(fresh.ok, 'control: a freshly decided request still succeeds');
  });
});

test('the provenance principal is the gate-verified snapshot, not the context object', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const who = authenticated('operator-7', 'service');
    const ctx = { ...ctxFor(allowRoot(root, [LIST])), principal: who };
    const run = await discoverSource(makeDeps(), request(root), ctx);
    assert.ok(run.ok);
    if (!run.ok) return;
    for (const e of run.value.evidence) {
      const p = e.provenance.access.principal;
      assert.deepEqual(p, { kind: 'service', id: 'operator-7' });
      assert.notEqual(p, who, 'a copy, not the authenticated object itself');
      assert.equal(isAuthenticatedPrincipal(p), false);
    }
    assert.equal(
      establishAuthenticatedPrincipal({ kind: 'human', id: '../escape' }).ok,
      false,
      'invalid identities cannot be minted at all',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Discovery is not authorization
// ---------------------------------------------------------------------------------------------------------------------

test('discovery succeeds without implicitly granting evidence access', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const deps = makeDeps();
    const listOnly = ctxFor(allowRoot(base, [LIST]));
    const run = await discoverSource(deps, request(root), listOnly);
    assert.ok(run.ok);
    if (!run.ok) return;
    assert.ok(run.value.evidence.length > 0, 'discovery produced listing evidence');
    assert.ok(
      run.value.evidence.every((e) => e.kind !== 'document_content' && e.sensitivity === 'metadata'),
      'and none of it is content-derived',
    );
    const record = deps.inventory.get(run.value.record.source.sourceId);
    assert.equal(record?.axes.authorization, 'granted', 'listing authorization is recorded...');

    const sourceId = run.value.record.source.sourceId;
    const attempt = await acquireSourceContent(
      deps,
      { sourceId, kind: 'document_content', resourceKeys: ['a.txt'], scope: scopeOf(root) },
      listOnly,
    );
    assert.ok(
      !attempt.ok && attempt.error.code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED,
      '...but it does not stand in for the read decision',
    );

    const control = await acquireSourceContent(
      deps,
      { sourceId, kind: 'document_content', resourceKeys: ['a.txt'], scope: scopeOf(root) },
      ctxFor(allowRoot(base, [LIST, READ])),
    );
    assert.ok(
      control.ok && control.value.evidence.length === 1,
      'positive control: with a read grant the same call returns content evidence',
    );
  });
});

test('a declared or detected source is only a candidate: it confers no access to the target or its contents', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'INV-1042');
    const sourceId = SourceId(stableId('src', ['local_filesystem', root]));
    const declared: DetectedSource = {
      sourceId,
      sourceType: 'local_filesystem',
      displayName: 'approved',
      locator: root,
      detectedBy: ConnectorId('xo.local-filesystem'),
      detectedAt: '2026-10-12T00:00:00.000Z',
      fingerprint: 'declared',
    };
    const deps = makeDeps();
    const registered = await registerDeclaredSources(
      deps,
      [declared],
      ctxFor(
        platform([
          {
            id: 'allow-declare',
            effect: 'ALLOW',
            match: { permission: PermissionId('data.write'), packageId: ENVIRONMENT_INTELLIGENCE_REQUESTER },
          },
        ]).ctx.authorization,
      ),
    );
    assert.ok(registered.ok && deps.inventory.get(sourceId) !== undefined, 'the declaration itself is authorized and recorded');
    const read = await acquireSourceContent(
      deps,
      { sourceId, kind: 'document_content', resourceKeys: ['a.txt'], scope: scopeOf(root) },
      ctxFor(allowRoot(base, [LIST, READ])),
    );
    assert.ok(
      !read.ok && read.error.code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED,
      'declared + detected + even READ-granted still needs the source to be authorized and validated first',
    );
    const run = await discoverSource(deps, request(root), ctxFor(allowRoot(base, [LIST, READ])));
    assert.ok(run.ok, 'positive control: the proper discovery path then succeeds');
    const readOk = await acquireSourceContent(
      deps,
      { sourceId, kind: 'document_content', resourceKeys: ['a.txt'], scope: scopeOf(root) },
      ctxFor(allowRoot(base, [LIST, READ])),
    );
    assert.ok(readOk.ok);
  });
});

test('escalation: a request that names a different source than the approved scope is refused', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'a.txt'), 'x');
    const other = join(base, 'approved-two');
    await put(join(other, 'b.txt'), 'x');
    const deps = makeDeps();
    assert.ok((await discoverSource(deps, request(root), ctxFor(allowRoot(base, [LIST, READ])))).ok);
    const sourceId = deps.inventory.list()[0]?.source.sourceId as ReturnType<typeof SourceId>;
    const r = await acquireSourceContent(
      deps,
      { sourceId, kind: 'document_content', resourceKeys: ['b.txt'], scope: scopeOf(other) },
      ctxFor(allowRoot(base, [LIST, READ])),
    );
    assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.SCOPE_VIOLATION, 'source/scope mismatch');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------------------------------------------------

test('internal authority constructors and the enforcement point are not part of the public surface', () => {
  const surface = pkg as unknown as Record<string, unknown>;
  for (const name of [
    'mintPlatformDecision',
    'mintBoundDevelopmentDecision',
    'bindingOf',
    'consumeDecision',
    'requireAuthorization',
    'requireAuthenticatedPrincipal',
  ]) {
    assert.equal(surface[name], undefined, `${name} must not be exported from the package index`);
  }
  assert.equal(typeof surface['mintDevelopmentDecision'], 'function', 'the documented development constructor remains public');
});
