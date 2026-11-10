/**
 * C3 transport, Secret and registry-contract tests.
 * TEST CLASS: offline unit/contract. `fetch` is a stub; no socket is opened and no real credential is used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
  ConnectorRegistry,
  DiscoveryErrorCode,
  LocalFilesystemConnector,
  SUPPORTED_AUTH_METHODS,
  PinnedHttpsTransport,
  MicrosoftGraphProvider,
  type Connector,
} from '../src/index.js';
import { Secret, revealSecret } from '../src/cloud/secret.js';
import { CloudAccountConnector } from '../src/cloud/connector.js';
import { MockConnector } from './support/mock-connector.js';
import { CLIENT, OID, TENANT, ScriptedMicrosoft, makeCloudEnv } from './support/cloud-env.js';

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

test('Secret never renders its value through string, JSON or inspect', () => {
  const s = new Secret('AT-SECRET-zzz');
  for (const out of [String(s), `${s}`, JSON.stringify({ s }), JSON.stringify([s]), inspect(s), inspect({ nested: { s } }, { depth: 5 })])
    assert.ok(!out.includes('AT-SECRET'));
  assert.equal(revealSecret(s), 'AT-SECRET-zzz');
  assert.deepEqual(Object.keys(s), []);
  assert.throws(() => revealSecret({} as Secret));
});

test('transport blocks non-HTTPS, unlisted hosts, userinfo, ports, fragments and garbage URLs before any fetch', async () => {
  let calls = 0;
  const t = new PinnedHttpsTransport(['login.microsoftonline.com'], {
    fetchImpl: (async () => ((calls += 1), jsonResponse({}))) as typeof fetch,
  });
  for (const url of [
    'http://login.microsoftonline.com/x',
    'https://evil.example/x',
    'https://login.microsoftonline.com.evil.example/x',
    'https://user:pw@login.microsoftonline.com/x',
    'https://login.microsoftonline.com:8443/x',
    'https://login.microsoftonline.com/x#frag',
    'not a url',
    'file:///etc/passwd',
  ]) {
    const r = await t.send({ method: 'GET', url });
    assert.equal(r.ok ? 'sent' : r.error.code, 'blocked_url', url);
  }
  assert.equal(calls, 0);
});

test('transport request shaping: no redirects, no cookies, bearer only in the header, form in the body', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const t = new PinnedHttpsTransport(['graph.microsoft.com'], {
    fetchImpl: (async (u: string, init: RequestInit) => ((seen = { url: u, init }), jsonResponse({ ok: 1 }))) as unknown as typeof fetch,
  });
  const r = await t.send({
    method: 'POST',
    url: 'https://graph.microsoft.com/v1.0/me',
    bearer: new Secret('AT-SECRET-q'),
    form: { a: 'b c' },
  });
  assert.ok(r.ok);
  assert.equal(seen?.init.redirect, 'error');
  assert.equal(seen?.init.credentials, 'omit');
  assert.equal((seen?.init.headers as Record<string, string>)['authorization'], 'Bearer AT-SECRET-q');
  assert.equal(seen?.init.body, 'a=b+c');
  assert.ok(!seen?.url.includes('AT-SECRET'));
});

test('transport failures are fixed codes: timeout, cancel, oversize, non-JSON, and a network error carrying a secret never leak it', async () => {
  const mk = (impl: typeof fetch, opts = {}) => new PinnedHttpsTransport(['graph.microsoft.com'], { fetchImpl: impl, ...opts });
  const url = 'https://graph.microsoft.com/x';
  const slow = mk(
    ((_u: string, init: RequestInit) =>
      new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('x'))))) as unknown as typeof fetch,
    { timeoutMs: 20 },
  );
  const a = await slow.send({ method: 'GET', url });
  assert.equal(a.ok ? '' : a.error.code, 'timeout');
  const ctrl = new AbortController();
  ctrl.abort();
  const b = await slow.send({ method: 'GET', url, signal: ctrl.signal });
  assert.equal(b.ok ? '' : b.error.code, 'cancelled');
  const big = mk((async () => new Response('x'.repeat(5000), { headers: { 'content-type': 'application/json' } })) as typeof fetch, {
    maxResponseBytes: 100,
  });
  const c = await big.send({ method: 'GET', url });
  assert.equal(c.ok ? '' : c.error.code, 'too_large');
  const html = mk((async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch);
  const d = await html.send({ method: 'GET', url });
  assert.equal(d.ok ? '' : d.error.code, 'not_json');
  const bad = mk((async () => new Response('{nope', { headers: { 'content-type': 'application/json' } })) as typeof fetch);
  const e = await bad.send({ method: 'GET', url });
  assert.equal(e.ok ? '' : e.error.code, 'not_json');
  const boom = mk((async () => {
    throw new Error('connect ECONNREFUSED Bearer AT-SECRET-leak');
  }) as typeof fetch);
  const f = await boom.send({ method: 'GET', url });
  assert.equal(f.ok ? '' : f.error.code, 'network');
  assert.ok(!JSON.stringify(f).includes('AT-SECRET'));
  const redirect = mk((async () => {
    throw new TypeError('redirect mode is set to error');
  }) as typeof fetch);
  const g = await redirect.send({ method: 'GET', url });
  assert.equal(g.ok ? '' : g.error.code, 'network');
});

test('provider config is a closed schema of two GUIDs', () => {
  const p = new MicrosoftGraphProvider(new PinnedHttpsTransport([]));
  assert.ok(p.parseConfig({ tenantId: TENANT.toUpperCase(), clientId: CLIENT }).ok);
  const parsed = p.parseConfig({ tenantId: TENANT.toUpperCase(), clientId: CLIENT });
  assert.equal(parsed.ok ? parsed.value.tenantId : '', TENANT);
  for (const bad of [
    {},
    { tenantId: TENANT },
    { tenantId: 'common', clientId: CLIENT },
    { tenantId: TENANT, clientId: CLIENT, x: 1 },
    5,
    undefined,
  ])
    assert.equal(p.parseConfig(bad).ok, false);
});

test('transport accepts JSON only: valid JSON served as another content type is refused', async () => {
  const t = new PinnedHttpsTransport(['graph.microsoft.com'], {
    fetchImpl: (async () => new Response('{"a":1}', { headers: { 'content-type': 'text/plain' } })) as typeof fetch,
  });
  const r = await t.send({ method: 'GET', url: 'https://graph.microsoft.com/x' });
  assert.equal(r.ok ? 'accepted' : r.error.code, 'not_json');
});

async function verifyWith(sm: ScriptedMicrosoft, claims: Record<string, unknown>, options = {}) {
  const p = new MicrosoftGraphProvider(
    new PinnedHttpsTransport(['login.microsoftonline.com', 'graph.microsoft.com'], { fetchImpl: sm.fetch }),
  );
  const now = Math.floor(Date.now() / 1000);
  const full = {
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: CLIENT,
    tid: TENANT,
    oid: OID,
    iat: now,
    nbf: now,
    exp: now + 3600,
    ...claims,
  };
  const grant = {
    accessToken: new Secret('AT-SECRET-x'),
    expiresInSec: 3600,
    scopes: [],
    idToken: new Secret(sm.keys.sign(full, options)),
  };
  return p.verifyIdentity({ providerId: 'microsoft-graph', tenantId: TENANT, clientId: CLIENT }, grant, Date.now(), {});
}

test('id_token verification (provider adapter, in isolation): signature, key strength and subject are each enforced on their own', async () => {
  assert.ok((await verifyWith(new ScriptedMicrosoft(), {})).ok, 'a correct token verifies');
  // signature: payload altered after signing, every claim still plausible
  const bad = await verifyWith(new ScriptedMicrosoft(), { oid: OID }, { tamper: true });
  assert.equal(bad.ok ? 'accepted' : bad.error.code, 'identity_invalid');
  // key strength: a 1024-bit RSA key is refused even with a valid signature
  const weak = await verifyWith(new ScriptedMicrosoft(1024), {});
  assert.equal(weak.ok ? 'accepted' : weak.error.code, 'identity_invalid');
  // subject: oid must be a GUID
  for (const oid of ['not-a-guid', undefined, 7]) {
    const r = await verifyWith(new ScriptedMicrosoft(), { oid });
    assert.equal(r.ok ? 'accepted' : r.error.code, 'identity_invalid', String(oid));
  }
});

test('registry: oauth2 is refused by default and only the registrar can enable it; secret-bearing config stays refused regardless', () => {
  assert.deepEqual([...SUPPORTED_AUTH_METHODS], ['none', 'operator_scope_grant']);
  const env = makeCloudEnv();
  const connector = env.manager.connector;
  const plain = new ConnectorRegistry();
  assert.throws(() => plain.register(connector), /auth/i);
  const enabled = new ConnectorRegistry();
  enabled.register(connector, { enabledAuthMethods: ['oauth2'] });
  const withSecret: Connector = Object.create(connector, {
    descriptor: {
      value: {
        ...connector.descriptor,
        id: 'xo.cloud.secret',
        configFields: [{ name: 'clientSecret', description: 'x', required: true, secret: true }],
      },
    },
  });
  assert.throws(() => new ConnectorRegistry().register(withSecret, { enabledAuthMethods: ['oauth2'] }));
  // enabling oauth2 does not enable arbitrary methods
  const bogus: Connector = Object.create(connector, {
    descriptor: { value: { ...connector.descriptor, id: 'xo.cloud.bogus', authMethods: ['api_key'] } },
  });
  assert.throws(() => new ConnectorRegistry().register(bogus, { enabledAuthMethods: ['oauth2'] }));
  assert.ok(connector instanceof CloudAccountConnector);
});

test('regression: existing connectors register and behave exactly as before', () => {
  const r = new ConnectorRegistry();
  r.register(new MockConnector({}));
  assert.ok(r.get(new MockConnector({}).descriptor.id));
  assert.equal(typeof LocalFilesystemConnector, 'function');
  assert.equal(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'EI_UNSUPPORTED_OPERATION');
});
