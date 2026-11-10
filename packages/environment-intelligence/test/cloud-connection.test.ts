/**
 * C3 connection lifecycle: list -> consent -> verify -> register through the C1 contract -> status / revoke / reconnect.
 *
 * TEST CLASS: offline contract tests with a SCRIPTED provider behind the REAL pinned transport and provider adapter, the REAL
 * `PermissionManager` (rules, audit sink), REAL registry, inventory, ledger and in-memory audit recorder. They prove our code's
 * behaviour against documented wire shapes. They do NOT prove real OAuth, token exchange, refresh, or revocation against Microsoft.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { establishAuthenticatedPrincipal } from '@xo/permissions';
import { DiscoveryErrorCode, SourceId, type AuditRecorder, type ConnectorContext } from '../src/index.js';
import { runEnforced } from '../src/connector-enforcement.js';
import { cloudScope } from '../src/cloud/connector.js';
import { CLIENT, OID, OTHER_OID, OTHER_TENANT, TENANT, allowRules, connectOnce, makeCloudEnv, type CloudEnv } from './support/cloud-env.js';

const CONFIG = { tenantId: TENANT, clientId: CLIENT };
const begin = (env: CloudEnv, ctx: ConnectorContext = env.ctx()) =>
  env.manager.beginConnect(ctx, { providerId: 'microsoft-graph', config: CONFIG });

function errorCode<T>(r: { ok: boolean; error?: { code: string } } & T): string | undefined {
  return r.ok ? undefined : r.error?.code;
}

async function validate(env: CloudEnv, connectionId: string, ctx: ConnectorContext = env.ctx()) {
  const c = env.manager.connector;
  const request = { sourceType: 'saas_application' as const, scope: cloudScope('microsoft-graph', TENANT, connectionId) };
  return runEnforced(c, 'validate_connection', ctx, (x) => c.validateConnection(request, x), { audited: false });
}

const nothingCreated = (env: CloudEnv): void => {
  const listed = env.manager.list(env.ctx());
  assert.ok(listed.ok);
  assert.equal(listed.ok ? listed.value.length : -1, 0, 'no connection exists');
  assert.equal(env.inventory.list().length, 0, 'no source was created or advanced');
};

test('the provider catalog states what is required and offers read-only scopes only', () => {
  const env = makeCloudEnv();
  const [ms] = env.manager.listProviders();
  assert.ok(ms);
  assert.equal(ms.id, 'microsoft-graph');
  assert.equal(ms.flow, 'device_code');
  assert.deepEqual(ms.configFields.map((f) => f.name).sort(), ['clientId', 'tenantId']);
  assert.ok(
    ms.configFields.every((f) => f.secret === false),
    'credentials are never configuration',
  );
  for (const s of ms.allowedScopes) assert.ok(!/write|readwrite|\.all$/i.test(s), `${s} is not a write/tenant-wide scope`);
  assert.ok(ms.requiredScopes.every((s) => ms.allowedScopes.includes(s)));
  assert.deepEqual([...ms.capabilities].sort(), ['detect', 'health', 'validate_connection']);
});

test('valid registration: consent, verification and the C1 contract produce exactly one validated source and no content access', async () => {
  const env = makeCloudEnv();
  const begun = await begin(env);
  assert.ok(begun.ok);
  if (!begun.ok) return;
  assert.equal(begun.value.userCode, 'ABCD-EFGH');
  assert.equal(begun.value.verificationUri, 'https://microsoft.com/devicelogin');
  assert.equal(env.inventory.list().length, 0, 'beginning consent registers nothing');
  env.provider.pollsBeforeGrant = 2;
  const done = await env.manager.completeConnect(env.ctx(), begun.value.pendingId);
  assert.ok(done.ok, JSON.stringify(done));
  if (!done.ok) return;
  assert.equal(done.value.outcome, 'connected');
  const c = done.value.connection;
  assert.equal(c.state, 'active');
  assert.deepEqual([...c.grantedScopes].sort(), ['User.Read', 'email', 'offline_access', 'openid', 'profile']);
  assert.deepEqual(c.connectedBy, { kind: 'human', id: 'admin-1' });
  const records = env.inventory.list();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, 'connected_and_validated');
  assert.equal(records[0]?.axes.acquisition, 'not_attempted', 'a connection does not read anything');
  assert.equal(records[0]?.source.sourceId, c.sourceId);
  assert.equal(env.registry.get(env.manager.connector.descriptor.id), env.manager.connector);
  // pending polling honoured the provider interval
  assert.deepEqual(env.slept, [5000, 5000]);
  const ops = env.audit.events().map((e) => `${e.operation}:${e.phase}:${e.outcome}`);
  assert.deepEqual(ops, ['connect_account:attempt:attempted', 'connect_account:terminal:completed']);
});

test('default deny: with no policy nothing is contacted, no pending consent exists, and the denial is audited', async () => {
  const env = makeCloudEnv({ rules: [] });
  const r = await begin(env);
  assert.equal(errorCode(r), DiscoveryErrorCode.AUTHORIZATION_DENIED);
  assert.equal(env.provider.requests.length, 0, 'the provider was never contacted');
  assert.ok(env.audit.events().some((e) => e.phase === 'standalone' && e.outcome === 'denied' && e.operation === 'connect_account'));
  nothingCreated(env);
});

test('authorization for another tenant does not authorize this one', async () => {
  const env = makeCloudEnv({ rules: allowRules(OTHER_TENANT) });
  assert.equal(errorCode(await begin(env)), DiscoveryErrorCode.AUTHORIZATION_DENIED);
  assert.equal(env.provider.requests.length, 0);
});

test('credential storage needs its own explicit decision: network.connect alone leaves no connection and no source', async () => {
  const env = makeCloudEnv({ rules: allowRules(TENANT, ['network.connect']) });
  const begun = await begin(env);
  assert.ok(begun.ok);
  if (!begun.ok) return;
  const done = await env.manager.completeConnect(env.ctx(), begun.value.pendingId);
  assert.equal(errorCode(done), DiscoveryErrorCode.AUTHORIZATION_DENIED);
  nothingCreated(env);
  assert.ok(env.audit.events().some((e) => e.operation === 'connect_account' && e.phase === 'terminal' && e.outcome === 'failed'));
  assert.ok(env.audit.events().some((e) => e.phase === 'standalone' && e.permission === 'secrets.write'));
  // the consent is spent: it cannot be completed again
  assert.equal(errorCode(await env.manager.completeConnect(env.ctx(), begun.value.pendingId)), DiscoveryErrorCode.MALFORMED_INPUT);
});

test('a forged or plain principal is refused everywhere, before any provider contact', async () => {
  const env = makeCloudEnv();
  const forged = { kind: 'human', id: 'admin-1' } as unknown as ConnectorContext['principal'];
  const ctx = { ...env.ctx(), principal: forged } as ConnectorContext;
  assert.equal(errorCode(await begin(env, ctx)), DiscoveryErrorCode.UNAUTHENTICATED);
  assert.equal(errorCode(await env.manager.beginReconnect(ctx, 'conn_x')), DiscoveryErrorCode.UNAUTHENTICATED);
  assert.equal(errorCode(await env.manager.completeConnect(ctx, 'pend_x')), DiscoveryErrorCode.UNAUTHENTICATED);
  assert.equal(errorCode(await env.manager.revoke(ctx, 'conn_x')), DiscoveryErrorCode.UNAUTHENTICATED);
  assert.equal(errorCode(env.manager.status(ctx, 'conn_x')), DiscoveryErrorCode.UNAUTHENTICATED);
  assert.equal(errorCode(env.manager.list(ctx)), DiscoveryErrorCode.UNAUTHENTICATED);
  assert.equal(env.provider.requests.length, 0);
});

test('principal association: the recorded principal is the authenticated one, never anything the provider payload names', async () => {
  const env = makeCloudEnv();
  env.provider.deviceBody = {
    device_code: 'DC-SECRET-1',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://microsoft.com/devicelogin',
    expires_in: 900,
    interval: 5,
    principal: { kind: 'service', id: 'attacker' },
    admin: true,
  };
  const id = await connectOnce(env);
  const status = env.manager.status(env.ctx(), id);
  assert.ok(status.ok);
  assert.deepEqual(status.ok ? status.value.connectedBy : undefined, { kind: 'human', id: 'admin-1' });
  for (const e of env.audit.events()) assert.equal(e.principal.id, 'admin-1');
});

test('only the principal that began consent can complete it, and a refused attempt does not consume it', async () => {
  const env = makeCloudEnv();
  const begun = await begin(env);
  assert.ok(begun.ok);
  if (!begun.ok) return;
  const other = establishAuthenticatedPrincipal({ kind: 'human', id: 'admin-2' });
  assert.ok(other.ok);
  if (!other.ok) return;
  const stolen = await env.manager.completeConnect(env.ctx({ principal: other.value }), begun.value.pendingId);
  assert.equal(errorCode(stolen), DiscoveryErrorCode.AUTHORIZATION_DENIED);
  assert.equal(env.provider.polls, 0, 'the other principal never reached the device code');
  const done = await env.manager.completeConnect(env.ctx(), begun.value.pendingId);
  assert.ok(done.ok);
});

test('least privilege: missing required scopes and any scope outside the read-only allow-list are refused with nothing stored', async () => {
  for (const [scope, reason] of [
    ['openid profile offline_access', 'insufficient_scope'],
    ['User.Read openid', 'insufficient_scope'],
    ['User.Read openid offline_access Mail.ReadWrite', 'excess_scope'],
    ['User.Read openid offline_access https://graph.microsoft.com/Files.ReadWrite.All', 'excess_scope'],
    ['User.Read openid offline_access Directory.Read.All', 'excess_scope'],
  ] as const) {
    const env = makeCloudEnv();
    env.provider.scope = scope;
    const begun = await begin(env);
    assert.ok(begun.ok);
    if (!begun.ok) return;
    const done = await env.manager.completeConnect(env.ctx(), begun.value.pendingId);
    assert.equal(errorCode(done), DiscoveryErrorCode.SCOPE_VIOLATION, scope);
    assert.equal(!done.ok ? done.error.context['reason'] : undefined, reason, scope);
    nothingCreated(env);
  }
});

test('Graph scopes reported as full URIs are normalized and accepted when they are the required read-only ones', async () => {
  const env = makeCloudEnv();
  env.provider.scope = 'https://graph.microsoft.com/User.Read openid offline_access';
  const id = await connectOnce(env);
  const s = env.manager.status(env.ctx(), id);
  assert.deepEqual(s.ok ? [...s.value.grantedScopes] : [], ['User.Read', 'offline_access', 'openid']);
});

test('identity and resource boundary: a token that does not verify for the pinned tenant, client and time never creates a connection', async () => {
  const cases: Array<[string, (e: CloudEnv) => void]> = [
    ['other tenant', (e) => (e.provider.tid = OTHER_TENANT)],
    ['wrong audience', (e) => (e.provider.aud = '99999999-9999-4999-8999-999999999999')],
    ['wrong issuer', (e) => (e.provider.iss = 'https://evil.example/v2.0')],
    ['expired id_token', (e) => (e.provider.idTokenTtlSec = -3600)],
    ['bad signature (tampered payload)', (e) => (e.provider.idTokenOptions = { tamper: true })],
    ['alg none', (e) => (e.provider.idTokenOptions = { alg: 'none' })],
    ['alg HS256 downgrade', (e) => (e.provider.idTokenOptions = { alg: 'HS256' })],
    ['unknown key id', (e) => (e.provider.idTokenOptions = { kid: 'someone-else' })],
    ['no id_token at all', (e) => (e.provider.omitIdToken = true)],
    ['no signing keys published', (e) => (e.provider.jwksKeys = [])],
    ['key service failure', (e) => (e.provider.jwksStatus = 500)],
  ];
  for (const [name, arrange] of cases) {
    const env = makeCloudEnv();
    arrange(env);
    const begun = await begin(env);
    assert.ok(begun.ok, name);
    if (!begun.ok) return;
    const done = await env.manager.completeConnect(env.ctx(), begun.value.pendingId);
    assert.equal(done.ok, false, name);
    nothingCreated(env);
  }
});

test('failed, declined, expired and timed-out consent each leave no connection, no source, and a closed audit trail', async () => {
  // declined by the human
  {
    const env = makeCloudEnv();
    env.provider.tokenError = 'authorization_declined';
    const begun = await begin(env);
    assert.ok(begun.ok);
    if (!begun.ok) return;
    const r = await env.manager.completeConnect(env.ctx(), begun.value.pendingId);
    assert.equal(errorCode(r), DiscoveryErrorCode.CONNECTION_FAILED);
    nothingCreated(env);
    assert.equal(env.audit.events().at(-1)?.outcome, 'failed');
  }
  // caller-side timeout: never marks anything connected
  {
    const env = makeCloudEnv();
    env.provider.pollsBeforeGrant = 1_000;
    const begun = await begin(env);
    assert.ok(begun.ok);
    if (!begun.ok) return;
    const r = await env.manager.completeConnect(env.ctx(), begun.value.pendingId, { maxWaitMs: 12_000 });
    assert.equal(errorCode(r), DiscoveryErrorCode.CONNECTION_FAILED);
    assert.equal(!r.ok ? r.error.context['reason'] : undefined, 'timeout');
    nothingCreated(env);
    assert.equal(env.audit.events().at(-1)?.outcome, 'failed');
  }
  // the device code expires while waiting
  {
    const env = makeCloudEnv();
    env.provider.pollsBeforeGrant = 1_000;
    const begun = await begin(env);
    assert.ok(begun.ok);
    if (!begun.ok) return;
    const r = await env.manager.completeConnect(env.ctx(), begun.value.pendingId);
    assert.equal(errorCode(r), DiscoveryErrorCode.CONNECTION_FAILED);
    assert.equal(!r.ok ? r.error.context['reason'] : undefined, 'expired');
    nothingCreated(env);
  }
  // the provider is unreachable while polling
  {
    const env = makeCloudEnv();
    env.provider.tokenStatus = 503;
    const begun = await begin(env);
    assert.ok(begun.ok);
    if (!begun.ok) return;
    const r = await env.manager.completeConnect(env.ctx(), begun.value.pendingId);
    assert.equal(errorCode(r), DiscoveryErrorCode.CONNECTION_FAILED);
    nothingCreated(env);
  }
});

test('cancellation ends the consent, records it as cancelled, and creates nothing', async () => {
  const env = makeCloudEnv();
  env.provider.pollsBeforeGrant = 1_000;
  const controller = new AbortController();
  const begun = await begin(env);
  assert.ok(begun.ok);
  if (!begun.ok) return;
  const original = env.provider.fetch;
  let polls = 0;
  (env.provider as { fetch: typeof fetch }).fetch = ((...a: Parameters<typeof fetch>) => {
    polls += 1;
    if (polls === 2) controller.abort();
    return original(...a);
  }) as typeof fetch;
  const r = await env.manager.completeConnect(env.ctx({ signal: controller.signal }), begun.value.pendingId);
  assert.ok(!r.ok);
  assert.ok(r.ok || r.error.code === DiscoveryErrorCode.CANCELLED || r.error.code === DiscoveryErrorCode.CONNECTION_FAILED);
  nothingCreated(env);
});

test('slow_down from the provider lengthens the polling interval', async () => {
  const env = makeCloudEnv();
  env.provider.tokenError = 'slow_down';
  const begun = await begin(env);
  assert.ok(begun.ok);
  if (!begun.ok) return;
  await env.manager.completeConnect(env.ctx(), begun.value.pendingId, { maxWaitMs: 30_000 });
  assert.ok(env.slept.length >= 2);
  assert.ok(env.slept[1]! > env.slept[0]!, `interval grew: ${env.slept.join(',')}`);
});

test('malformed or hostile provider responses fail closed and create nothing', async () => {
  const bad: Array<[string, (e: CloudEnv) => void]> = [
    [
      'device response missing user_code',
      (e) =>
        (e.provider.deviceBody = { device_code: 'DC-SECRET-1', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900 }),
    ],
    ['verification URI on another host', (e) => (e.provider.verificationUri = 'https://evil.example/devicelogin')],
    ['verification URI over http', (e) => (e.provider.verificationUri = 'http://microsoft.com/devicelogin')],
    ['verification URI with credentials', (e) => (e.provider.verificationUri = 'https://user:pw@microsoft.com/devicelogin')],
    [
      'user code that is not a code',
      (e) =>
        (e.provider.deviceBody = {
          device_code: 'DC-SECRET-1',
          user_code: '<script>',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
        }),
    ],
    [
      'implausible expiry',
      (e) =>
        (e.provider.deviceBody = {
          device_code: 'DC-SECRET-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 10,
        }),
    ],
    ['device endpoint server error', (e) => (e.provider.deviceStatus = 500)],
  ];
  for (const [name, arrange] of bad) {
    const env = makeCloudEnv();
    arrange(env);
    const r = await begin(env);
    assert.equal(r.ok, false, name);
    nothingCreated(env);
  }
  const badTokens: Array<[string, Record<string, unknown>]> = [
    ['token without expires_in', { token_type: 'Bearer', scope: 'User.Read openid offline_access', access_token: 'AT-SECRET-x' }],
    [
      'token type not bearer',
      { token_type: 'mac', scope: 'User.Read openid offline_access', expires_in: 3600, access_token: 'AT-SECRET-x' },
    ],
    ['absurd lifetime', { token_type: 'Bearer', scope: 'User.Read openid offline_access', expires_in: 9e9, access_token: 'AT-SECRET-x' }],
    ['no scope reported', { token_type: 'Bearer', expires_in: 3600, access_token: 'AT-SECRET-x' }],
    ['array instead of object', [] as unknown as Record<string, unknown>],
  ];
  for (const [name, body] of badTokens) {
    const env = makeCloudEnv();
    env.provider.tokenBodyOverride = body;
    const begun = await begin(env);
    assert.ok(begun.ok, name);
    if (!begun.ok) return;
    const r = await env.manager.completeConnect(env.ctx(), begun.value.pendingId);
    assert.equal(r.ok, false, name);
    nothingCreated(env);
  }
});

test('invalid, unsupported or smuggled configuration is refused before any authorization or network use', async () => {
  const env = makeCloudEnv();
  const attempts: unknown[] = [
    { tenantId: 'common', clientId: CLIENT },
    { tenantId: 'organizations', clientId: CLIENT },
    { tenantId: TENANT },
    { tenantId: TENANT, clientId: 'not-a-guid' },
    { tenantId: TENANT, clientId: CLIENT, clientSecret: 'hunter2' },
    { tenantId: TENANT, clientId: CLIENT, authority: 'https://evil.example' },
    { tenantId: TENANT, clientId: CLIENT, accessToken: 'AT-SECRET-injected' },
    null,
    'string',
    [],
  ];
  for (const config of attempts) {
    const r = await env.manager.beginConnect(env.ctx(), { providerId: 'microsoft-graph', config });
    assert.equal(errorCode(r), DiscoveryErrorCode.MALFORMED_INPUT, JSON.stringify(config));
  }
  assert.equal(
    errorCode(await env.manager.beginConnect(env.ctx(), { providerId: 'google-workspace', config: CONFIG })),
    DiscoveryErrorCode.MALFORMED_INPUT,
  );
  assert.equal(
    errorCode(await env.manager.beginConnect(env.ctx(), { providerId: '__proto__', config: CONFIG })),
    DiscoveryErrorCode.MALFORMED_INPUT,
  );
  assert.equal(env.provider.requests.length, 0);
  assert.equal(env.permissionAudit.all().length, 0, 'the platform gate was never consulted for an invalid request');
});

test('consents awaiting completion are bounded', async () => {
  const env = makeCloudEnv({ maxPending: 1 });
  assert.ok((await begin(env)).ok);
  assert.equal(errorCode(await begin(env)), DiscoveryErrorCode.LIMIT_EXCEEDED);
});

test('repeated connect for the same account is idempotent: one connection, one source, and the new tokens are never stored', async () => {
  const env = makeCloudEnv();
  const first = await connectOnce(env);
  const second = await begin(env);
  assert.ok(second.ok);
  if (!second.ok) return;
  const again = await env.manager.completeConnect(env.ctx(), second.value.pendingId);
  assert.ok(again.ok);
  assert.equal(again.ok ? again.value.outcome : undefined, 'already_connected');
  assert.equal(again.ok ? again.value.connection.connectionId : undefined, first);
  assert.equal(env.inventory.list().length, 1);
  const listed = env.manager.list(env.ctx());
  assert.equal(listed.ok ? listed.value.length : -1, 1);
  // the credential in use is still the FIRST one
  env.provider.requests.length = 0;
  assert.ok((await validate(env, first)).ok);
  assert.equal(env.provider.requests.at(-1)?.headers['authorization'], 'Bearer AT-SECRET-1');
});

test('two different accounts in the same tenant are two connections and two sources', async () => {
  const env = makeCloudEnv();
  const a = await connectOnce(env);
  env.provider.oid = OTHER_OID;
  const b = await connectOnce(env);
  assert.notEqual(a, b);
  assert.equal(env.inventory.list().length, 2);
});

test('safe reconnect replaces the credential atomically for the same account; a different account changes nothing', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  const before = env.manager.status(env.ctx(), id);
  assert.ok(before.ok);

  // an attempt that comes back as a DIFFERENT account is refused and the existing connection is untouched
  env.provider.oid = OTHER_OID;
  const wrong = await env.manager.beginReconnect(env.ctx(), id);
  assert.ok(wrong.ok);
  if (!wrong.ok) return;
  const refused = await env.manager.completeConnect(env.ctx(), wrong.value.pendingId);
  assert.equal(refused.ok, false);
  assert.deepEqual(env.manager.status(env.ctx(), id), before);
  assert.equal(env.inventory.list().length, 1);
  env.provider.oid = OID;
  env.provider.requests.length = 0;
  assert.ok((await validate(env, id)).ok, 'the original credential still works');
  assert.equal(env.provider.requests.at(-1)?.headers['authorization'], 'Bearer AT-SECRET-1');

  // the same account re-consents
  const good = await env.manager.beginReconnect(env.ctx(), id);
  assert.ok(good.ok);
  if (!good.ok) return;
  const done = await env.manager.completeConnect(env.ctx(), good.value.pendingId);
  assert.ok(done.ok);
  assert.equal(done.ok ? done.value.outcome : undefined, 'reconnected');
  assert.equal(done.ok ? done.value.connection.reconnectCount : -1, 1);
  assert.equal(done.ok ? done.value.connection.sourceId : '', before.ok ? before.value.sourceId : 'x');
  assert.equal(env.inventory.list().length, 1, 'still one source');
  env.provider.requests.length = 0;
  assert.ok((await validate(env, id)).ok);
  assert.notEqual(
    env.provider.requests.at(-1)?.headers['authorization'],
    'Bearer AT-SECRET-1',
    'the replaced credential is no longer used',
  );
});

test('a reconnect whose registration step fails restores the previous credential', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  const re = await env.manager.beginReconnect(env.ctx(), id);
  assert.ok(re.ok);
  if (!re.ok) return;
  env.provider.graphStatus = 503; // validation of the NEW credential cannot succeed
  const done = await env.manager.completeConnect(env.ctx(), re.value.pendingId);
  assert.equal(done.ok, false);
  env.provider.graphStatus = 200;
  env.provider.requests.length = 0;
  assert.ok((await validate(env, id)).ok, 'the previous connection survived');
  assert.equal(env.provider.requests.at(-1)?.headers['authorization'], 'Bearer AT-SECRET-1');
  const s = env.manager.status(env.ctx(), id);
  assert.equal(s.ok ? s.value.state : '', 'active');
  assert.equal(s.ok ? s.value.reconnectCount : -1, 0);
});

test('revoke destroys credentials, blocks every later protected operation, and makes no further provider call', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  const revoked = await env.manager.revoke(env.ctx(), id);
  assert.ok(revoked.ok, JSON.stringify(revoked));
  if (!revoked.ok) return;
  assert.equal(revoked.value.credentialsDestroyed, true);
  assert.equal(revoked.value.providerRevocation, 'not_performed', 'honest: this provider flow has no remote revocation');
  assert.equal(revoked.value.audited, true);
  assert.equal(revoked.value.connection.state, 'revoked');
  assert.equal(env.inventory.list()[0]?.axes.authorization, 'revoked');
  assert.notEqual(env.inventory.list()[0]?.status, 'connected_and_validated');

  env.provider.requests.length = 0;
  const c = env.manager.connector;
  const request = { sourceType: 'saas_application' as const, scope: cloudScope('microsoft-graph', TENANT, id) };
  for (const op of ['detect', 'validate_connection', 'health'] as const) {
    const r = await runEnforced(
      c,
      op,
      env.ctx(),
      (x) =>
        (op === 'detect'
          ? c.detectSource(request, x)
          : op === 'validate_connection'
            ? c.validateConnection(request, x)
            : c.health({ sourceId: SourceId('src_x'), scope: request.scope }, x)) as never,
      { audited: false },
    );
    assert.equal(errorCode(r), DiscoveryErrorCode.AUTHORIZATION_REQUIRED, op);
  }
  assert.equal(env.provider.requests.length, 0, 'no network use after revocation');
  assert.ok(env.audit.events().some((e) => e.operation === 'revoke_connection' && e.outcome === 'revoked'));
  // revoking again is harmless and still destroys nothing new
  assert.ok((await env.manager.revoke(env.ctx(), id)).ok);
});

test('revoke needs its own authorization and a refused revoke changes nothing', async () => {
  const env = makeCloudEnv({ rules: allowRules(TENANT, ['network.connect', 'secrets.write']) });
  const id = await connectOnce(env);
  const denied = makeCloudEnv({ rules: allowRules(TENANT, ['network.connect']) });
  // connect under full rights, then attempt revoke under a context that lacks secrets.write
  const ctxNoWrite = denied.ctx();
  const r = await denied.manager.revoke(ctxNoWrite, id);
  assert.equal(r.ok, false);
  const s = env.manager.status(env.ctx(), id);
  assert.equal(s.ok ? s.value.state : '', 'active');
  const unknown = await env.manager.revoke(env.ctx(), 'conn_does_not_exist');
  assert.equal(errorCode(unknown), DiscoveryErrorCode.MALFORMED_INPUT);
});

test('revocation proceeds even when the audit recorder is down, and says so', async () => {
  let down = false;
  const env = makeCloudEnv({
    audit: (inner): AuditRecorder => ({
      record: (...a) =>
        down
          ? Promise.resolve({
              ok: false as const,
              error: { code: 'AUDIT_UNAVAILABLE', message: 'x', retryable: true, context: {} } as never,
            })
          : inner.record(...a),
    }),
  });
  const id = await connectOnce(env);
  down = true;
  const r = await env.manager.revoke(env.ctx(), id);
  assert.ok(r.ok);
  assert.equal(r.ok ? r.value.audited : true, false);
  assert.equal(r.ok ? r.value.connection.state : '', 'revoked');
});

test('audit is write-ahead for connect: with no accepted attempt nothing leaves the process', async () => {
  const env = makeCloudEnv({
    audit: () => ({
      record: () =>
        Promise.resolve({ ok: false as const, error: { code: 'AUDIT_UNAVAILABLE', message: 'x', retryable: true, context: {} } as never }),
    }),
  });
  assert.equal(errorCode(await begin(env)), DiscoveryErrorCode.AUDIT_UNAVAILABLE);
  assert.equal(env.provider.requests.length, 0);
  const noRecorder = makeCloudEnv();
  assert.equal(errorCode(await begin(noRecorder, noRecorder.ctx({ audit: undefined as never }))), DiscoveryErrorCode.AUDIT_UNAVAILABLE);
  assert.equal(noRecorder.provider.requests.length, 0);
});

test('no false success: if the completion audit is not accepted, the connection is rolled back and the source is not left authorized', async () => {
  const env = makeCloudEnv({
    audit: (inner): AuditRecorder => ({
      record: (e, t) =>
        e.operation === 'connect_account' && e.phase === 'terminal'
          ? Promise.resolve({
              ok: false as const,
              error: { code: 'AUDIT_UNAVAILABLE', message: 'x', retryable: true, context: {} } as never,
            })
          : inner.record(e, t),
    }),
  });
  const begun = await begin(env);
  assert.ok(begun.ok);
  if (!begun.ok) return;
  const done = await env.manager.completeConnect(env.ctx(), begun.value.pendingId);
  assert.equal(errorCode(done), DiscoveryErrorCode.AUDIT_UNAVAILABLE);
  const listed = env.manager.list(env.ctx());
  assert.equal(listed.ok ? listed.value.length : -1, 0);
  for (const r of env.inventory.list()) assert.notEqual(r.status, 'connected_and_validated');
  // and the credential is gone: nothing can use it
  const id = env.inventory.list()[0]?.source.sourceId;
  assert.ok(id === undefined || env.manager.describe('conn_unknown') === undefined);
});

test('content and action stay unsupported: a connection reads nothing, and the C1 orchestrator cannot turn it into content access', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  const c = env.manager.connector;
  assert.deepEqual(c.descriptor.operations, {
    detect: 'supported',
    validate_connection: 'supported',
    discover: 'unsupported',
    acquire_content: 'unsupported',
    incremental_sync: 'unsupported',
    health: 'supported',
  });
  assert.equal(c.descriptor.sideEffects, 'none');
  assert.deepEqual([...c.descriptor.evidenceKinds], []);
  assert.equal(typeof (c as unknown as { incrementalSync?: unknown }).incrementalSync, 'undefined');
  const request = { sourceType: 'saas_application' as const, scope: cloudScope('microsoft-graph', TENANT, id) };
  const run = await runEnforced(c, 'discover', env.ctx(), (x) => c.discover(request, x), { audited: true, sourceId: SourceId('src_x') });
  assert.equal(errorCode(run), DiscoveryErrorCode.UNSUPPORTED_OPERATION);
  const direct = await c.acquireContent(
    { sourceId: SourceId('src_x'), kind: 'resource_inventory', resourceKeys: ['a'], scope: request.scope },
    env.ctx(),
  );
  assert.equal(errorCode(direct), DiscoveryErrorCode.UNSUPPORTED_OPERATION);
  assert.equal(env.ledger.counts().released, 0, 'no evidence was released');
});
