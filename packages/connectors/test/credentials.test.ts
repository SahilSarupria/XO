/**
 * UW-9 (UAC-14) — the credential store, the broker and OAuth: encrypted per tenant at rest, least privilege, refresh and
 * revocation, cross-tenant access denied, provider calls only through pinned egress.
 */
import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import type { CredentialError, CredentialStoreError, OAuthError } from '../src/index.js';
import {
  CredentialBroker,
  CredentialStore,
  GOOGLE,
  MICROSOFT,
  Secret,
  accountOf,
  authorizationUrl,
  checkGrantedScopes,
  exchangeCode,
  httpConnector,
  newPkce,
  requestedScopes,
  revealSecret,
  type EgressDeps,
  type TokenSet,
  type VettedRequest,
} from '../src/index.js';

const KEY = randomBytes(32);
const BY = { kind: 'user', id: 'u-admin' };
const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'xo-cred-'));
const idToken = (claims: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

/** A fake provider behind the pinned transport: records every request, answers from a script. */
function provider(answer: (req: VettedRequest, form: URLSearchParams) => { status: number; body: unknown }) {
  const calls: { url: string; pinned: string; form: URLSearchParams }[] = [];
  const deps: EgressDeps = {
    resolve: async () => ['142.250.80.1'],
    transport: async (req, pinned) => {
      const form = new URLSearchParams(req.body ?? '');
      calls.push({ url: req.url.toString(), pinned: pinned.address, form });
      const a = answer(req, form);
      return { status: a.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.body) };
    },
  };
  return { deps, calls };
}

const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const tokens = (over: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresInSec: 3600,
  scopes: ['openid', 'email', GMAIL_SEND],
  ...over,
});

async function brokerFor(tenant: string, root: string, deps: EgressDeps = {}, now = () => new Date()) {
  const events: string[] = [];
  const b = new CredentialBroker({
    store: new CredentialStore(root, tenant, KEY),
    clients: { google: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh' } },
    oauth: deps,
    now,
    onEvent: (e) => void events.push(`${e.type}${e.reason !== undefined ? `:${e.reason}` : ''}`),
  });
  return { b, events };
}
const connect = (b: CredentialBroker, over: Partial<TokenSet> = {}) =>
  b.storeOAuth({
    provider: 'google',
    capabilities: ['message.send'],
    scopes: ['openid', 'email', GMAIL_SEND],
    account: { id: 'g-123', label: 'ops@acme.example' },
    tokens: tokens(over),
    by: BY,
  });

describe('UW-9 credential store: encrypted per tenant', () => {
  it('no secret is on disk in the clear; the record names no secret', async () => {
    const root = await tmp();
    const { b } = await brokerFor('ws_a', root);
    const c = await connect(b);
    const files = await readdir(join(root, c.credentialId));
    const raw = await readFile(join(root, c.credentialId, files[0]!), 'utf8');
    assert.ok(!raw.includes('at-1') && !raw.includes('rt-1'), 'tokens are sealed');
    assert.ok(raw.includes('"sealed"'));
    assert.ok(!JSON.stringify(c).includes('at-1'));
  });

  it('another tenant cannot read a credential, even with the file copied into its own store', async () => {
    const root = await tmp();
    const { b: a } = await brokerFor('ws_a', join(root, 'ws_a'));
    const c = await connect(a);
    const { b: other } = await brokerFor('ws_b', join(root, 'ws_b'));
    await assert.rejects(other.describe(c.credentialId), (e: CredentialError) => e.code === 'not_found');
    // The file itself, copied over: it names tenant ws_a, so it is not ws_b's.
    await cp(join(root, 'ws_a', c.credentialId), join(root, 'ws_b', c.credentialId), { recursive: true });
    await assert.rejects(
      other.use(c.credentialId, { purpose: 't' }, async () => 1),
      (e: CredentialError) => e.code === 'not_found',
    );
    assert.deepEqual(await other.list(), []);
    // Edited to name ws_b: the authenticated data no longer matches, so it does not open.
    const dir = join(root, 'ws_b', c.credentialId);
    const f = join(dir, (await readdir(dir))[0]!);
    await writeFile(f, (await readFile(f, 'utf8')).replace('"tenantId":"ws_a"', '"tenantId":"ws_b"'));
    await assert.rejects(
      new CredentialStore(join(root, 'ws_b'), 'ws_b', KEY).load(c.credentialId),
      (e: CredentialStoreError) => e.code === 'tampered',
    );
    // A different master key opens nothing.
    await assert.rejects(
      new CredentialStore(join(root, 'ws_a'), 'ws_a', randomBytes(32)).load(c.credentialId),
      (e: CredentialStoreError) => e.code === 'tampered',
    );
  });

  it('two writers of the same version: exactly one wins', async () => {
    const root = await tmp();
    const s = new CredentialStore(root, 'ws_a', KEY);
    const { b } = await brokerFor('ws_a', root);
    const c = await connect(b);
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((i) => s.write({ ...c, updatedAt: `t${i}` }, { accessToken: `x${i}` }, c.version)),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results) if (r.status === 'rejected') assert.equal((r.reason as CredentialStoreError).code, 'conflict');
  });

  it('a Secret never prints, serialises or inspects its value', () => {
    const s = new Secret('hunter2');
    assert.equal(String(s), '[redacted]');
    assert.equal(JSON.stringify({ s }), '{"s":"[redacted]"}');
    assert.ok(!inspect(s).includes('hunter2'));
    assert.equal(revealSecret(s), 'hunter2');
  });
});

describe('UW-9 broker: use, refresh, revoke', () => {
  it('use hands the token for the call, and only with the scopes the use needs (least privilege at use)', async () => {
    const { b, events } = await brokerFor('ws_a', await tmp());
    const c = await connect(b);
    const got = await b.use(c.credentialId, { scopes: [GMAIL_SEND], purpose: 'connector:email.send' }, async (h) =>
      revealSecret(h.accessToken!),
    );
    assert.equal(got, 'at-1');
    await assert.rejects(
      b.use(c.credentialId, { scopes: ['https://www.googleapis.com/auth/gmail.readonly'], purpose: 'connector:email.read' }, async () => 1),
      (e: CredentialError) => e.code === 'scope_insufficient',
    );
    assert.ok(events.includes('credential.use_denied:scope_insufficient: connector:email.read'));
  });

  it('an expiring token is refreshed once for concurrent uses; a rotated refresh token replaces the old one on disk', async () => {
    let n = 0;
    const p = provider((_r, form) => {
      n++;
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'rt-1');
      return {
        status: 200,
        body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, token_type: 'Bearer', scope: `openid email ${GMAIL_SEND}` },
      };
    });
    const root = await tmp();
    const { b, events } = await brokerFor('ws_a', root, p.deps);
    const c = await connect(b, { expiresInSec: 30 });
    const seen = await Promise.all(
      [1, 2, 3, 4, 5].map(() => b.use(c.credentialId, { purpose: 't' }, async (h) => revealSecret(h.accessToken!))),
    );
    assert.deepEqual(seen, ['at-2', 'at-2', 'at-2', 'at-2', 'at-2']);
    assert.equal(n, 1, 'single-flight: the rotating refresh token is redeemed once');
    assert.equal(p.calls[0]!.url, 'https://oauth2.googleapis.com/token');
    assert.equal(p.calls[0]!.pinned, '142.250.80.1');
    const s = new CredentialStore(root, 'ws_a', KEY);
    assert.equal((await s.load(c.credentialId)).secrets.refreshToken, 'rt-2');
    const onDisk = await Promise.all(
      (await readdir(join(root, c.credentialId))).map((f) => readFile(join(root, c.credentialId, f), 'utf8')),
    );
    assert.equal(onDisk.length, 1, 'the version that held rt-1 is gone');
    assert.ok(events.includes('credential.refreshed'));
  });

  it('a refresh the provider refuses ends the credential; nothing uses it until it is reconnected', async () => {
    const p = provider(() => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked. secret=rt-1' },
    }));
    const { b, events } = await brokerFor('ws_a', await tmp(), p.deps);
    const c = await connect(b, { expiresInSec: 1 });
    await assert.rejects(
      b.use(c.credentialId, { purpose: 't' }, async () => 1),
      (e: CredentialError) => e.code === 'refresh_failed',
    );
    const after = await b.describe(c.credentialId);
    assert.equal(after.state, 'expired');
    assert.equal(after.endedReason, 'refresh_failed');
    await assert.rejects(
      b.use(c.credentialId, { purpose: 't' }, async () => 1),
      (e: CredentialError) => e.code === 'not_active',
    );
    assert.ok(events.some((e) => e.startsWith('credential.refresh_failed')));
    assert.ok(!events.join().includes('rt-1'), 'the provider’s description never reaches the record');
  });

  it('an unreachable provider does not stop a token that is still valid', async () => {
    const deps: EgressDeps = { resolve: async () => ['142.250.80.1'], transport: async () => Promise.reject(new Error('ECONNRESET')) };
    const { b } = await brokerFor('ws_a', await tmp(), deps);
    const c = await connect(b, { expiresInSec: 60 });
    assert.equal(await b.use(c.credentialId, { purpose: 't' }, async (h) => revealSecret(h.accessToken!)), 'at-1');
  });

  it('a refresh that widens the grant ends the credential', async () => {
    const p = provider(() => ({
      status: 200,
      body: { access_token: 'at-2', expires_in: 3600, token_type: 'Bearer', scope: `openid email ${GMAIL_SEND} https://mail.google.com/` },
    }));
    const { b } = await brokerFor('ws_a', await tmp(), p.deps);
    const c = await connect(b, { expiresInSec: 1 });
    await assert.rejects(
      b.use(c.credentialId, { purpose: 't' }, async () => 1),
      (e: CredentialError) => e.code === 'refresh_failed',
    );
    assert.equal((await b.describe(c.credentialId)).state, 'expired');
  });

  it('revocation calls the provider when it can, and always destroys the tokens here', async () => {
    const p = provider((req, form) => {
      assert.equal(req.url.toString(), 'https://oauth2.googleapis.com/revoke');
      assert.equal(form.get('token'), 'rt-1');
      return { status: 200, body: {} };
    });
    const root = await tmp();
    const { b } = await brokerFor('ws_a', root, p.deps);
    const c = await connect(b);
    const r = await b.revoke(c.credentialId, BY);
    assert.equal(r.providerRevocation, 'performed');
    assert.equal(r.credential.state, 'revoked');
    assert.deepEqual((await new CredentialStore(root, 'ws_a', KEY).load(c.credentialId)).secrets, {}, 'no token left on disk');
    await assert.rejects(
      b.use(c.credentialId, { purpose: 't' }, async () => 1),
      (e: CredentialError) => e.code === 'not_active',
    );
    // Microsoft has no revocation endpoint for a client: the result says so instead of pretending.
    const ms = await b.storeOAuth({
      provider: 'microsoft',
      capabilities: ['message.send'],
      scopes: ['Mail.Send'],
      account: { id: 'oid-1' },
      tokens: tokens(),
      by: BY,
    });
    assert.equal((await b.revoke(ms.credentialId, BY)).providerRevocation, 'not_available');
  });

  it('basic credentials rotate; the old password leaves the disk', async () => {
    const root = await tmp();
    const { b } = await brokerFor('ws_a', root);
    const c = await b.storeBasic({
      provider: 'smtp',
      capabilities: ['message.send'],
      username: 'ops@acme.example',
      host: 'smtp.acme.example',
      password: 'old-pass',
      by: BY,
    });
    await b.rotateBasic(c.credentialId, 'new-pass', BY);
    assert.equal(await b.use(c.credentialId, { kind: 'basic', purpose: 't' }, async (h) => revealSecret(h.password!)), 'new-pass');
    const dir = join(root, c.credentialId);
    const all = (await Promise.all((await readdir(dir)).map((f) => readFile(join(dir, f))))).join('');
    assert.ok(!all.includes('old-pass') && !all.includes('new-pass'));
    assert.equal((await readdir(dir)).length, 1);
  });
});

describe('UW-9 OAuth: PKCE, least privilege, provider calls', () => {
  it('asks for capabilities, mapped to the narrowest scopes, with PKCE S256', () => {
    assert.deepEqual(requestedScopes(GOOGLE, ['message.send']), ['openid', 'email', GMAIL_SEND]);
    assert.deepEqual(requestedScopes(MICROSOFT, ['message.send']), ['openid', 'email', 'offline_access', 'Mail.Send']);
    const pk = newPkce();
    assert.match(pk.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(pk.challenge, createHash('sha256').update(pk.verifier).digest('base64url'));
    const u = new URL(
      authorizationUrl(
        GOOGLE,
        { clientId: 'cid' },
        {
          redirectUri: 'https://xo.example/oauth/callback',
          state: 's',
          codeChallenge: pk.challenge,
          scopes: requestedScopes(GOOGLE, ['message.send']),
        },
      ),
    );
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('include_granted_scopes'), null, 'no silent widening from earlier consents');
    assert.equal(
      new URL(
        authorizationUrl(
          MICROSOFT,
          { clientId: 'c', tenant: 'organizations' },
          { redirectUri: 'x', state: 's', codeChallenge: 'c', scopes: ['Mail.Send'] },
        ),
      ).pathname,
      '/organizations/oauth2/v2.0/authorize',
    );
  });

  it('a grant that misses a needed scope, or exceeds what was asked, is refused', () => {
    const asked = requestedScopes(GOOGLE, ['message.send']);
    assert.equal(checkGrantedScopes(GOOGLE, asked, ['openid', 'https://www.googleapis.com/auth/userinfo.email', GMAIL_SEND]).ok, true);
    const missing = checkGrantedScopes(GOOGLE, asked, ['openid', 'email']);
    assert.ok(!missing.ok && missing.missing.includes(GMAIL_SEND), 'the user unticked gmail.send on the consent screen');
    const extra = checkGrantedScopes(GOOGLE, asked, ['openid', 'email', GMAIL_SEND, 'https://mail.google.com/']);
    assert.ok(!extra.ok && extra.extra.includes('https://mail.google.com/'));
    // Microsoft reports Graph scopes with or without the resource prefix.
    assert.equal(
      checkGrantedScopes(MICROSOFT, requestedScopes(MICROSOFT, ['message.send']), [
        'https://graph.microsoft.com/Mail.Send',
        'openid',
        'email',
        'profile',
        'offline_access',
      ]).ok,
      true,
    );
    assert.equal(
      checkGrantedScopes(MICROSOFT, requestedScopes(MICROSOFT, ['message.send']), ['Mail.Send', 'Mail.Read', 'openid']).ok,
      false,
    );
  });

  it('exchanges the code with the verifier, at the provider’s token endpoint only, and checks the id_token', async () => {
    const p = provider((_r, form) => {
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('code_verifier'), 'v'.repeat(43));
      return {
        status: 200,
        body: {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3599,
          token_type: 'Bearer',
          scope: `openid ${GMAIL_SEND}`,
          id_token: idToken({ iss: 'https://accounts.google.com', aud: 'cid', sub: 'g-1', email: 'ops@acme.example' }),
        },
      };
    });
    const t = await exchangeCode(GOOGLE, { clientId: 'cid' }, { code: 'c', codeVerifier: 'v'.repeat(43), redirectUri: 'r' }, p.deps);
    assert.deepEqual(accountOf(GOOGLE, { clientId: 'cid' }, t), { id: 'g-1', label: 'ops@acme.example' });
    assert.throws(() => accountOf(GOOGLE, { clientId: 'other' }, t), /not for this client/);
    const forged = { ...t, idTokenClaims: { ...t.idTokenClaims, iss: 'https://evil.example' } };
    assert.throws(() => accountOf(GOOGLE, { clientId: 'cid' }, forged), /not issued by the provider/);
    // Microsoft: issuer is the account's tenant; the stable id is oid.
    const ms = {
      ...t,
      idTokenClaims: {
        iss: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0',
        tid: '9188040d-6c67-4c5b-b112-36a304b66dad',
        aud: 'cid',
        sub: 's',
        oid: 'o-1',
        preferred_username: 'a@b.example',
      },
    };
    assert.deepEqual(accountOf(MICROSOFT, { clientId: 'cid' }, ms), { id: 'o-1', label: 'a@b.example' });
  });

  it('a refused exchange keeps only the error code; a reused code is invalid_grant', async () => {
    const p = provider(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request code=abc' } }));
    await assert.rejects(
      exchangeCode(GOOGLE, { clientId: 'cid' }, { code: 'abc', codeVerifier: 'v', redirectUri: 'r' }, p.deps),
      (e: OAuthError) => e.code === 'invalid_grant' && !e.message.includes('abc'),
    );
  });

  it('provider calls never go to a private address or another host', async () => {
    const calls: string[] = [];
    const deps: EgressDeps = {
      resolve: async () => ['10.0.0.7'],
      transport: async (r) => (calls.push(String(r.url)), { status: 200, headers: {}, body: '{}' }),
    };
    await assert.rejects(exchangeCode(GOOGLE, { clientId: 'cid' }, { code: 'c', codeVerifier: 'v', redirectUri: 'r' }, deps), /private/);
    assert.deepEqual(calls, []);
  });
});

describe('UW-9 http connector on pinned egress', () => {
  it('connects to the vetted address, not to whatever the name resolves to later', async () => {
    let resolves = 0;
    const pinnedTo: string[] = [];
    const c = httpConnector(
      { baseUrl: 'https://api.acme.example', methods: ['GET'], pathPatterns: ['/v1/**'], maxResponseBytes: 10_000 },
      {
        resolve: async () => (resolves++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']),
        transport: async (_r, pinned) => (
          pinnedTo.push(pinned.address),
          { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":1}' }
        ),
      },
    );
    const out = await c.operations['get']!.execute({ path: '/v1/x' }, {
      signal: AbortSignal.timeout(5000),
      secret: () => '',
      idempotencyKey: undefined,
    } as never);
    assert.deepEqual(out, { status: 200, ok: true, body: { ok: 1 } });
    assert.equal(resolves, 1, 'resolved once');
    assert.deepEqual(pinnedTo, ['93.184.216.34']);
  });
});
