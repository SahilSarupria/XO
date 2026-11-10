/**
 * C3 credential handling: expiry/refresh, revocation races, broker proofs, secret non-leakage, durable-state interaction.
 * TEST CLASS: offline contract tests with a SCRIPTED provider (see cloud-connection.test.ts). Real: transport, adapter, manager,
 * PermissionManager, registry, inventory, ledger, audit recorder, durable EiStateStore. NOT proven: real Microsoft refresh/rotation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { join } from 'node:path';
import { resourceScope } from '@xo/permissions';
import {
  DiscoveryErrorCode,
  EiStateStore,
  EnvironmentInventory,
  EvidenceLedger,
  SourceId,
  type AuditTrust,
  type ConnectorContext,
} from '../src/index.js';
import { runEnforced } from '../src/connector-enforcement.js';
import { cloudScope } from '../src/cloud/connector.js';
import { requireAuthorization } from '../src/authorization-gate.js';
import { authenticated, withSandbox } from './helpers.js';
import { readGrant } from './support/audit-grants.js';
import { CLIENT, SECRET_MARKERS, TENANT, OTHER_TENANT, allowRules, connectOnce, makeCloudEnv, type CloudEnv } from './support/cloud-env.js';

const validate = (env: CloudEnv, id: string, ctx: ConnectorContext = env.ctx()) => {
  const c = env.manager.connector;
  const request = { sourceType: 'saas_application' as const, scope: cloudScope('microsoft-graph', TENANT, id) };
  return runEnforced(c, 'validate_connection', ctx, (x) => c.validateConnection(request, x), { audited: false });
};
const code = (r: { ok: boolean; error?: { code: string } }): string | undefined => (r.ok ? undefined : r.error?.code);
const lastBearer = (env: CloudEnv): string | undefined =>
  env.provider.requests.filter((r) => r.url.includes('graph.microsoft.com')).at(-1)?.headers['authorization'];

test('an expired access token is refreshed once, the rotated credential is used, and the old one is not', async () => {
  const env = makeCloudEnv();
  env.provider.expiresIn = 120;
  const id = await connectOnce(env);
  assert.ok((await validate(env, id)).ok);
  assert.equal(env.provider.refreshes, 0, 'still fresh');
  env.clock.advance(61_000);
  assert.ok((await validate(env, id)).ok);
  assert.equal(env.provider.refreshes, 1);
  assert.equal(lastBearer(env), 'Bearer AT-SECRET-2');
});

test('concurrent uses of an expired credential redeem the refresh token exactly once', async () => {
  const env = makeCloudEnv();
  env.provider.expiresIn = 120;
  const id = await connectOnce(env);
  env.clock.advance(120_000);
  const results = await Promise.all([validate(env, id), validate(env, id), validate(env, id)]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(env.provider.refreshes, 1);
});

test('a refresh the provider rejects (revoked/consent withdrawn) ends the connection and blocks every later call without network use', async () => {
  const env = makeCloudEnv();
  env.provider.expiresIn = 120;
  const id = await connectOnce(env);
  env.provider.refreshMode = 'invalid_grant';
  env.clock.advance(120_000);
  assert.equal(code(await validate(env, id)), DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
  const s = env.manager.status(env.ctx(), id);
  assert.equal(s.ok ? s.value.state : '', 'revoked');
  assert.equal(s.ok ? s.value.endedReason : '', 'revoked_by_provider');
  assert.equal(env.inventory.list()[0]?.axes.authorization, 'revoked');
  env.provider.requests.length = 0;
  assert.equal(code(await validate(env, id)), DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
  assert.equal(env.provider.requests.length, 0);
});

test('a transient refresh failure fails the call closed but keeps the connection for a retry', async () => {
  const env = makeCloudEnv();
  env.provider.expiresIn = 120;
  const id = await connectOnce(env);
  env.provider.refreshMode = 'unreachable';
  env.clock.advance(120_000);
  const r = await validate(env, id);
  assert.equal(code(r), DiscoveryErrorCode.CONNECTION_FAILED);
  const s = env.manager.status(env.ctx(), id);
  assert.equal(s.ok ? s.value.state : '', 'active');
  env.provider.refreshMode = 'ok';
  assert.ok((await validate(env, id)).ok);
});

test('no refresh token and an expired access token: the connection expires and fails closed', async () => {
  const env = makeCloudEnv();
  env.provider.expiresIn = 120;
  env.provider.includeRefresh = false;
  const id = await connectOnce(env);
  env.clock.advance(120_000);
  assert.equal(code(await validate(env, id)), DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
  const s = env.manager.status(env.ctx(), id);
  assert.equal(s.ok ? s.value.state : '', 'expired');
});

test('a refresh that widens the grant beyond the read-only allow-list ends the connection', async () => {
  const env = makeCloudEnv();
  env.provider.expiresIn = 120;
  const id = await connectOnce(env);
  env.provider.refreshMode = 'excess_scope';
  env.clock.advance(120_000);
  assert.equal(code(await validate(env, id)), DiscoveryErrorCode.SCOPE_VIOLATION);
  const s = env.manager.status(env.ctx(), id);
  assert.notEqual(s.ok ? s.value.state : 'active', 'active');
});

test('a credential the provider stops honouring (401) is reported as unauthorized, not as healthy', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  env.provider.invalidateAccessTokens();
  assert.equal(code(await validate(env, id)), DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
});

test('health reports an unreachable provider as a status, a revoked credential as an error, and never changes state', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  const c = env.manager.connector;
  const health = () =>
    runEnforced(
      c,
      'health',
      env.ctx(),
      (x) => c.health({ sourceId: SourceId('src_x'), scope: cloudScope('microsoft-graph', TENANT, id) }, x),
      { audited: false },
    );
  const ok1 = await health();
  assert.equal(ok1.ok ? ok1.value.status : '', 'healthy');
  env.provider.graphThrows = true;
  const down = await health();
  assert.equal(down.ok ? down.value.status : '', 'unavailable');
  const s = env.manager.status(env.ctx(), id);
  assert.equal(s.ok ? s.value.state : '', 'active');
});

test('a call in flight when the connection is revoked has its result discarded', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  let release!: () => void;
  env.provider.graphGate = new Promise<void>((r) => (release = r));
  const pending = validate(env, id);
  await new Promise((r) => setTimeout(r, 20));
  const revoked = await env.manager.revoke(env.ctx(), id);
  assert.ok(revoked.ok);
  release();
  assert.equal(code(await pending), DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
});

test('a provider timeout never marks anything connected or healthy', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  env.provider.hangGraph = true;
  const ctrl = new AbortController();
  const p = validate(env, id, env.ctx({ signal: ctrl.signal }));
  setTimeout(() => ctrl.abort(), 30);
  const r = await p;
  assert.equal(r.ok, false);
});

test('the broker releases a credential only against a decision the enforcement point honoured, once, for a covering scope', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  const ctx = env.ctx();
  const use = (allow: never, c = ctx) =>
    env.manager.use({ connectionId: id, allow, ctx: c, fn: async () => ({ ok: true as const, value: 1 as never }) });
  // forged: a plain object shaped like an allow
  const real = await requireAuthorization(ctx.authorization, {
    connectorId: env.manager.connector.descriptor.id,
    operation: 'validate_connection',
    permission: 'network.connect',
    scope: resourceScope(`cloud/microsoft-graph/${TENANT}`),
    principal: ctx.principal!,
    reason: 'test',
  });
  assert.ok(real.ok);
  if (!real.ok) return;
  assert.equal(code(await use({} as never)), DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED);
  assert.equal(
    code(await use({ ...real.value, decision: { ...real.value.decision } } as never)),
    DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED,
    'a forged copy of the decision is not the honoured one',
  );
  assert.ok((await use(real.value as never)).ok, 'the genuine decision works once');
  assert.equal(code(await use(real.value as never)), DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED, 'and only once');
  assert.equal(
    code(await use({ ...real.value } as never)),
    DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED,
    'a shallow copy cannot replay a spent decision',
  );
  // a decision for a different tenant does not cover this connection
  const envB = makeCloudEnv({ rules: [...allowRules(TENANT), ...allowRules(OTHER_TENANT)] });
  const idB = await connectOnce(envB);
  const other = await requireAuthorization(envB.ctx().authorization, {
    connectorId: envB.manager.connector.descriptor.id,
    operation: 'validate_connection',
    permission: 'network.connect',
    scope: resourceScope(`cloud/microsoft-graph/${OTHER_TENANT}`),
    principal: envB.ctx().principal!,
    reason: 'test',
  });
  assert.ok(other.ok);
  if (!other.ok) return;
  const cross = await envB.manager.use({
    connectionId: idB,
    allow: other.value,
    ctx: envB.ctx(),
    fn: async () => ({ ok: true as const, value: 1 as never }),
  });
  assert.equal(code(cross), DiscoveryErrorCode.SCOPE_VIOLATION);
});

test('connector operations authorize the REQUESTED boundary first; a mismatched tenant is refused and nothing is released', async () => {
  const env = makeCloudEnv({ rules: [...allowRules(TENANT), ...allowRules(OTHER_TENANT)] });
  const id = await connectOnce(env);
  const c = env.manager.connector;
  env.provider.requests.length = 0;
  const r = await runEnforced(
    c,
    'validate_connection',
    env.ctx(),
    (x) => c.validateConnection({ sourceType: 'saas_application', scope: cloudScope('microsoft-graph', OTHER_TENANT, id) }, x),
    { audited: false },
  );
  assert.equal(code(r), DiscoveryErrorCode.SCOPE_VIOLATION);
  assert.equal(
    !r.ok ? r.error.context['reason'] : '',
    'tenant_mismatch',
    'refused by the connector boundary check itself, not only by the broker',
  );
  assert.equal(env.provider.requests.length, 0);
  const unauthorised = makeCloudEnv({ rules: allowRules(TENANT, ['secrets.write']) });
  const id2 = await connectOnce(makeCloudEnv()).catch(() => 'x');
  void id2;
  const rr = await runEnforced(
    unauthorised.manager.connector,
    'detect',
    unauthorised.ctx(),
    (x) =>
      unauthorised.manager.connector.detectSource(
        { sourceType: 'saas_application', scope: cloudScope('microsoft-graph', TENANT, 'conn_x') },
        x,
      ),
    { audited: false },
  );
  assert.equal(code(rr), DiscoveryErrorCode.AUTHORIZATION_DENIED, 'denied before any lookup, so existence is not revealed');
});

test('detect is existence-level: no network and no credential use', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  env.provider.requests.length = 0;
  const c = env.manager.connector;
  const r = await runEnforced(
    c,
    'detect',
    env.ctx(),
    (x) => c.detectSource({ sourceType: 'saas_application', scope: cloudScope('microsoft-graph', TENANT, id) }, x),
    { audited: false },
  );
  assert.ok(r.ok);
  assert.equal(env.provider.requests.length, 0);
});

test('invalid connector scopes are refused', async () => {
  const env = makeCloudEnv();
  const c = env.manager.connector;
  for (const scope of [
    { kind: 'x' },
    {},
    { kind: 'cloud_account', providerId: 1, tenantId: TENANT, connectionId: 'a' },
    { kind: 'cloud_account', providerId: 'microsoft-graph', tenantId: '../..', connectionId: 'a' },
  ]) {
    const r = await runEnforced(
      c,
      'detect',
      env.ctx(),
      (x) => c.detectSource({ sourceType: 'saas_application', scope: scope as never }, x),
      { audited: false },
    );
    assert.equal(code(r), DiscoveryErrorCode.INVALID_SCOPE, JSON.stringify(scope));
  }
});

test('secrets never appear in errors, audit records, platform audit, inventory, status, JSON or inspect output - success or failure', async () => {
  const env = makeCloudEnv();
  env.provider.expiresIn = 120;
  const collected: unknown[] = [];
  const id = await connectOnce(env);
  collected.push(await validate(env, id));
  env.provider.refreshMode = 'invalid_grant';
  env.clock.advance(120_000);
  collected.push(await validate(env, id)); // error path carrying provider error_description with SECRET-DETAIL
  collected.push(await env.manager.revoke(env.ctx(), id));
  const failing = makeCloudEnv();
  failing.provider.scope = 'User.Read openid offline_access Mail.ReadWrite';
  const b = await failing.manager.beginConnect(failing.ctx(), {
    providerId: 'microsoft-graph',
    config: { tenantId: TENANT, clientId: CLIENT },
  });
  if (b.ok) collected.push(await failing.manager.completeConnect(failing.ctx(), b.value.pendingId));
  for (const e of [env, failing]) {
    collected.push(e.audit.events(), e.permissionAudit.all(), e.inventory.list(), e.manager.list(e.ctx()), e.manager.listProviders());
    collected.push(inspect(e.manager, { depth: 10 }), inspect(e.manager.connector, { depth: 10 }));
  }
  const blob = JSON.stringify(collected) + collected.map((c) => inspect(c, { depth: 12 })).join('');
  for (const marker of [...SECRET_MARKERS, 'SECRET-DETAIL', 'hunter2']) assert.ok(!blob.includes(marker), `leaked ${marker}`);
});

test('every outbound request is HTTPS to a pinned host, with redirects refused and no cookies', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  await validate(env, id);
  assert.ok(env.provider.requests.length >= 4);
  for (const r of env.provider.requests) {
    const u = new URL(r.url);
    assert.equal(u.protocol, 'https:');
    assert.ok(['login.microsoftonline.com', 'graph.microsoft.com'].includes(u.hostname));
    assert.equal(r.redirect, 'error');
    assert.equal(r.credentials, 'omit');
    assert.ok(!r.url.includes('AT-SECRET') && !r.url.includes('RT-SECRET'), 'tokens never travel in a URL');
  }
});

test('durable state: a restart loses credentials, so a stale "validated" view cannot be used; an unavailable store refuses before any provider contact', async () => {
  await withSandbox(async ({ base }) => {
    const OP = authenticated('admin-1');
    const trust: AuditTrust = { principal: OP };
    const dir = join(base, 'state');
    const opened = await EiStateStore.open({ dir });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const inventory = new EnvironmentInventory();
    const ledger = new EvidenceLedger();
    assert.ok((await opened.value.start({ grant: await readGrant(), trust, inventory, ledger })).ok);
    const env = makeCloudEnv({ inventory, ledger });
    const ctx = env.ctx({ state: opened.value, principal: OP });
    const begun = await env.manager.beginConnect(ctx, { providerId: 'microsoft-graph', config: { tenantId: TENANT, clientId: CLIENT } });
    assert.ok(begun.ok);
    if (!begun.ok) return;
    const done = await env.manager.completeConnect(ctx, begun.value.pendingId);
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal(inventory.list()[0]?.status, 'connected_and_validated');
    await opened.value.close();

    // "restart": a new process has the persisted inventory but NO credentials
    const reopened = await EiStateStore.open({ dir });
    assert.ok(reopened.ok);
    if (!reopened.ok) return;
    const inv2 = new EnvironmentInventory();
    const led2 = new EvidenceLedger();
    assert.ok((await reopened.value.start({ grant: await readGrant(), trust, inventory: inv2, ledger: led2 })).ok);
    assert.equal(inv2.list().length, 1, 'the source view survived');
    assert.equal(inv2.list()[0]?.axes.authorization, 'granted', 'stale: nothing reconciled it yet');
    const env2 = makeCloudEnv({ inventory: inv2, ledger: led2 });
    const id = done.ok ? done.value.connection.connectionId : '';
    assert.equal(code(await validate(env2, id)), DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    assert.equal(env2.provider.requests.length, 0);

    // reconciliation makes the persisted view truthful, and persists that
    const ctx2 = env2.ctx({ state: reopened.value, principal: OP });
    const rec = await env2.manager.reconcileInventory(ctx2, { providerId: 'microsoft-graph', tenantId: TENANT });
    assert.ok(rec.ok, JSON.stringify(rec));
    assert.deepEqual(rec.ok ? rec.value : {}, { reconciled: 1, skipped: 0, unattributed: 1 });
    assert.equal(inv2.list()[0]?.axes.authorization, 'revoked');
    assert.ok(env2.audit.events().some((e) => e.operation === 'revoke_connection' && e.outcome === 'revoked'));
    assert.deepEqual(
      (await env2.manager.reconcileInventory(ctx2, { providerId: 'microsoft-graph', tenantId: TENANT })).ok ? { again: true } : {},
      { again: true },
    );
    await reopened.value.close();
    const third = await EiStateStore.open({ dir });
    assert.ok(third.ok);
    if (!third.ok) return;
    const inv3 = new EnvironmentInventory();
    assert.ok((await third.value.start({ grant: await readGrant(), trust, inventory: inv3, ledger: new EvidenceLedger() })).ok);
    assert.equal(inv3.list()[0]?.axes.authorization, 'revoked', 'the reconciled state survived another restart');
    await third.value.close();

    // a closed store is not operational: nothing starts
    const env3 = makeCloudEnv({ inventory: inv2 });
    const refused = await env3.manager.beginConnect(env3.ctx({ state: reopened.value, principal: OP }), {
      providerId: 'microsoft-graph',
      config: { tenantId: TENANT, clientId: CLIENT },
    });
    assert.equal(refused.ok, false);
    assert.equal(env3.provider.requests.length, 0);
  });
});

test('the broker refuses an ended connection on its own, even for a genuinely honoured decision', async () => {
  const env = makeCloudEnv();
  const id = await connectOnce(env);
  assert.ok((await env.manager.revoke(env.ctx(), id)).ok);
  const ctx = env.ctx();
  const real = await requireAuthorization(ctx.authorization, {
    connectorId: env.manager.connector.descriptor.id,
    operation: 'validate_connection',
    permission: 'network.connect',
    scope: resourceScope(`cloud/microsoft-graph/${TENANT}`),
    principal: ctx.principal!,
    reason: 'test',
  });
  assert.ok(real.ok);
  if (!real.ok) return;
  let ran = false;
  const r = await env.manager.use({
    connectionId: id,
    allow: real.value,
    ctx,
    fn: async () => ((ran = true), { ok: true as const, value: 1 as never }),
  });
  assert.equal(code(r), DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
  assert.equal(ran, false, 'the callback never received a credential');
});

test('a consent cannot be completed twice concurrently', async () => {
  const env = makeCloudEnv();
  env.provider.pollsBeforeGrant = 1;
  const begun = await env.manager.beginConnect(env.ctx(), {
    providerId: 'microsoft-graph',
    config: { tenantId: TENANT, clientId: CLIENT },
  });
  assert.ok(begun.ok);
  if (!begun.ok) return;
  const [a, b] = await Promise.all([
    env.manager.completeConnect(env.ctx(), begun.value.pendingId),
    env.manager.completeConnect(env.ctx(), begun.value.pendingId),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(env.inventory.list().length, 1);
});

test('the manager re-checks the tenant itself: a provider adapter that reports another tenant cannot create a connection', async () => {
  const env = makeCloudEnv({
    wrapProvider: (p) =>
      Object.create(p, {
        verifyIdentity: {
          value: async (...a: Parameters<typeof p.verifyIdentity>) => {
            const r = await p.verifyIdentity(...a);
            return r.ok ? { ok: true as const, value: { ...r.value, tenantId: OTHER_TENANT } } : r;
          },
        },
      }) as typeof p,
  });
  const begun = await env.manager.beginConnect(env.ctx(), {
    providerId: 'microsoft-graph',
    config: { tenantId: TENANT, clientId: CLIENT },
  });
  assert.ok(begun.ok);
  if (!begun.ok) return;
  assert.equal((await env.manager.completeConnect(env.ctx(), begun.value.pendingId)).ok, false);
  assert.equal(env.inventory.list().length, 0);
});

test('reconciliation is authorized per boundary and refuses an invalid boundary', async () => {
  const env = makeCloudEnv({ rules: allowRules(TENANT, ['network.connect', 'secrets.write']) });
  const id = await connectOnce(env);
  void id;
  const bad = await env.manager.reconcileInventory(env.ctx(), { providerId: 'nope', tenantId: TENANT });
  assert.equal(code(bad), DiscoveryErrorCode.MALFORMED_INPUT);
  // a live connection is never reconciled away
  const live = await env.manager.reconcileInventory(env.ctx(), { providerId: 'microsoft-graph', tenantId: TENANT });
  assert.deepEqual(live.ok ? live.value : {}, { reconciled: 0, skipped: 0, unattributed: 0 });
  assert.equal(env.inventory.list()[0]?.axes.authorization, 'granted');
  // a revoked connection: without authority over the named boundary nothing changes
  const denied = makeCloudEnv({ rules: allowRules(TENANT, ['network.connect']), inventory: env.inventory });
  const d = await denied.manager.reconcileInventory(denied.ctx(), { providerId: 'microsoft-graph', tenantId: TENANT });
  assert.deepEqual(d.ok ? d.value : {}, { reconciled: 0, skipped: 1, unattributed: 0 });
  assert.equal(env.inventory.list()[0]?.axes.authorization, 'granted');
});

test('reconciliation never touches a source that is known to belong to another boundary', async () => {
  const env = makeCloudEnv({ rules: [...allowRules(TENANT), ...allowRules(OTHER_TENANT)] });
  const at = env.clock.now().toISOString();
  env.inventory.observe(
    {
      sourceId: SourceId('src_foreign000000000000000000'),
      sourceType: 'saas_application',
      displayName: 'Cloud account',
      locator: `cloud:microsoft-graph/${OTHER_TENANT}`,
      detectedBy: env.manager.connector.descriptor.id,
      detectedAt: at,
      fingerprint: 'a'.repeat(64),
    },
    at,
  );
  const mine = await env.manager.reconcileInventory(env.ctx(), { providerId: 'microsoft-graph', tenantId: TENANT });
  assert.deepEqual(mine.ok ? mine.value : {}, { reconciled: 0, skipped: 0, unattributed: 0 });
  assert.notEqual(env.inventory.list()[0]?.axes.authorization, 'revoked');
  const theirs = await env.manager.reconcileInventory(env.ctx(), { providerId: 'microsoft-graph', tenantId: OTHER_TENANT });
  assert.deepEqual(theirs.ok ? theirs.value : {}, { reconciled: 1, skipped: 0, unattributed: 0 });
  assert.equal(env.inventory.list()[0]?.axes.authorization, 'revoked');
});
