/**
 * UW-9 (UAC-14) — connection credentials over HTTP: OAuth with PKCE and least privilege, encrypted per workspace, refresh and
 * revocation, and the cross-tenant matrix (another workspace, another person, a lower role, a replayed or forged callback).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EgressDeps, VettedRequest } from '@xo/connectors';
import type { CredentialsConfig } from '../src/credentials/credentials.js';
import { TestServer, withTempDir } from './test-helpers.js';

const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const idToken = (claims: Record<string, unknown>): string => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

interface Fake {
  readonly deps: EgressDeps;
  readonly calls: { url: string; form: URLSearchParams }[];
  grant: (form: URLSearchParams) => { status: number; body: unknown };
}
function fakeGoogle(): Fake {
  const f: Fake = {
    calls: [],
    grant: () => ({
      status: 200,
      body: {
        access_token: 'ya29.ACCESS-SECRET',
        refresh_token: '1//REFRESH-SECRET',
        expires_in: 3599,
        token_type: 'Bearer',
        scope: `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_SEND}`,
        id_token: idToken({ iss: 'https://accounts.google.com', aud: 'cid.apps', sub: '1098', email: 'ops@acme.example' }),
      },
    }),
    deps: {
      resolve: async () => ['142.250.80.10'],
      transport: async (req: VettedRequest) => {
        const form = new URLSearchParams(req.body ?? '');
        f.calls.push({ url: req.url.toString(), form });
        const a = req.url.pathname === '/revoke' ? { status: 200, body: {} } : f.grant(form);
        return { status: a.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.body) };
      },
    },
  };
  return f;
}

async function withCreds(fn: (s: TestServer, fake: Fake, dataDir: string) => Promise<void>): Promise<void> {
  await withTempDir('xo-api-cred-', async (dataDir) => {
    const fake = fakeGoogle();
    const credentials: CredentialsConfig = {
      masterKey: randomBytes(32),
      clients: { google: { clientId: 'cid.apps', clientSecret: 'client-secret' }, microsoft: undefined },
      redirectUri: 'https://xo.acme.example/oauth/callback',
      oauth: fake.deps,
    };
    const server = await TestServer.start({ workspaceDataDir: dataDir, credentials });
    try {
      await fn(server, fake, dataDir);
    } finally {
      await server.stop();
    }
  });
}

async function startConsent(s: TestServer, ws: string, headers?: Readonly<Record<string, string>>) {
  const r = await s.request('POST', `/workspaces/${ws}/credentials/oauth`, { provider: 'google', capabilities: ['message.send'] }, headers);
  assert.equal(r.status, 201, r.bodyText);
  const body = r.json<{ authorizationUrl: string; scopes: string[] }>();
  const url = new URL(body.authorizationUrl);
  return { state: url.searchParams.get('state')!, url, scopes: body.scopes };
}

const NO_AUTH = { authorization: '' };

test('connect with OAuth: PKCE, least-privilege scopes, tokens sealed, nothing secret ever returned', async () => {
  await withCreds(async (s, fake, dataDir) => {
    const ws = (await s.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const providers = (await s.request('GET', `/workspaces/${ws}/credentials/providers`)).json<{
      oauth: { provider: string; configured: boolean; capabilities: { capability: string; scopes: string[] }[] }[];
    }>();
    assert.deepEqual(providers.oauth.find((p) => p.provider === 'google')?.capabilities, [
      { capability: 'message.send', scopes: ['openid', 'email', GMAIL_SEND] },
    ]);
    assert.equal(providers.oauth.find((p) => p.provider === 'microsoft')?.configured, false);

    const { state, url, scopes } = await startConsent(s, ws);
    assert.deepEqual(scopes, ['openid', 'email', GMAIL_SEND], 'send only: no read, no full mailbox');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://xo.acme.example/oauth/callback');

    // The provider redirects the browser back: no API key on that request.
    const cb = await s.request('GET', `/oauth/callback?state=${state}&code=4%2Fabc&scope=x`, undefined, NO_AUTH);
    assert.equal(cb.status, 200, cb.bodyText);
    assert.match(cb.bodyText, /ops@acme\.example is connected/);
    assert.equal(cb.headers['content-security-policy'], "default-src 'none'");
    const tokenCall = fake.calls[0]!;
    assert.equal(tokenCall.url, 'https://oauth2.googleapis.com/token');
    assert.equal(tokenCall.form.get('grant_type'), 'authorization_code');
    assert.match(tokenCall.form.get('code_verifier') ?? '', /^[A-Za-z0-9_-]{43}$/, 'the PKCE verifier went with the code');

    const list = await s.request('GET', `/workspaces/${ws}/credentials`);
    const creds = list.json<{ credentials: { credentialId: string; scopes: string[]; accountLabel: string; state: string }[] }>()
      .credentials;
    assert.equal(creds.length, 1);
    assert.deepEqual(creds[0]!.scopes, ['https://www.googleapis.com/auth/userinfo.email', GMAIL_SEND, 'openid'].sort());
    assert.equal(creds[0]!.state, 'active');
    // No secret anywhere: not in the API, not on disk in the clear, not in the audit trail.
    assert.ok(!list.bodyText.includes('SECRET'));
    const files: string[] = [];
    for (const e of await readdir(dataDir, { recursive: true, withFileTypes: true }))
      if (e.isFile()) files.push(join(e.parentPath, e.name));
    for (const f of files) assert.ok(!(await readFile(f, 'utf8')).includes('SECRET'), `no token in ${f}`);

    // A replayed callback (the same state) gets nothing.
    const again = await s.request('GET', `/oauth/callback?state=${state}&code=4%2Fabc`, undefined, NO_AUTH);
    assert.equal(again.status, 400);
    assert.equal(fake.calls.length, 1, 'the code was never exchanged twice');
    // A forged state gets nothing.
    assert.equal((await s.request('GET', `/oauth/callback?state=${'A'.repeat(43)}&code=x`, undefined, NO_AUTH)).status, 400);

    // Revocation: at Google, and here.
    const id = creds[0]!.credentialId;
    const rv = await s.request('POST', `/workspaces/${ws}/credentials/${id}/revoke`, {});
    assert.equal(rv.status, 200, rv.bodyText);
    assert.equal(rv.json<{ providerRevocation: string }>().providerRevocation, 'performed');
    assert.equal(fake.calls.at(-1)!.url, 'https://oauth2.googleapis.com/revoke');
    assert.equal(fake.calls.at(-1)!.form.get('token'), '1//REFRESH-SECRET');
    assert.equal(
      (await s.request('GET', `/workspaces/${ws}/credentials`)).json<{ credentials: { state: string }[] }>().credentials[0]!.state,
      'revoked',
    );
  });
});

test('a grant broader than asked, a missing scope, or a refused consent stores nothing', async () => {
  await withCreds(async (s, fake) => {
    const ws = (await s.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const base = fake.grant;
    fake.grant = (f) => {
      const g = base(f) as { status: number; body: Record<string, unknown> };
      return { ...g, body: { ...g.body, scope: `openid email ${GMAIL_SEND} https://mail.google.com/` } };
    };
    let st = (await startConsent(s, ws)).state;
    let r = await s.request('GET', `/oauth/callback?state=${st}&code=c`, undefined, NO_AUTH);
    assert.equal(r.status, 422);
    assert.match(r.bodyText, /granted more than XO asked for \(https:\/\/mail\.google\.com\/\)/);

    fake.grant = (f) => {
      const g = base(f) as { status: number; body: Record<string, unknown> };
      return { ...g, body: { ...g.body, scope: 'openid email' } };
    };
    st = (await startConsent(s, ws)).state;
    r = await s.request('GET', `/oauth/callback?state=${st}&code=c`, undefined, NO_AUTH);
    assert.equal(r.status, 422);
    assert.match(r.bodyText, /without https:\/\/www\.googleapis\.com\/auth\/gmail\.send/);

    st = (await startConsent(s, ws)).state;
    r = await s.request('GET', `/oauth/callback?state=${st}&error=access_denied`, undefined, NO_AUTH);
    assert.equal(r.status, 400);
    assert.match(r.bodyText, /did not grant access \(access_denied\)/);

    st = (await startConsent(s, ws)).state;
    r = await s.request('GET', `/oauth/callback?state=${st}&code=c&iss=https%3A%2F%2Fevil.example`, undefined, NO_AUTH);
    assert.equal(r.status, 400, 'an answer naming another issuer (RFC 9207) is refused');

    assert.deepEqual((await s.request('GET', `/workspaces/${ws}/credentials`)).json<{ credentials: unknown[] }>().credentials, []);
  });
});

test('cross-tenant matrix: another workspace, another person and a lower role cannot see, use, revoke or complete', async () => {
  await withCreds(async (s) => {
    const a = (await s.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const basic = await s.request('POST', `/workspaces/${a}/credentials/basic`, {
      provider: 'smtp',
      capabilities: ['message.send'],
      username: 'ops@acme.example',
      host: 'smtp.acme.example',
      password: 'app-password-SECRET',
    });
    assert.equal(basic.status, 201, basic.bodyText);
    assert.ok(!basic.bodyText.includes('SECRET'));
    const id = basic.json<{ credential: { credentialId: string } }>().credential.credentialId;

    // Another person with their own workspace.
    const other = await s.issueAdditionalIdentity('mallory');
    const asOther = TestServer.authHeader(other.apiKey);
    const b = (await s.request('POST', '/workspaces', {}, asOther)).json<{ workspaceId: string }>().workspaceId;
    assert.equal((await s.request('GET', `/workspaces/${a}/credentials`, undefined, asOther)).status, 404, 'not a member of A');
    assert.equal((await s.request('POST', `/workspaces/${a}/credentials/${id}/revoke`, {}, asOther)).status, 404);
    // Through their own workspace, A's credential does not exist.
    assert.equal((await s.request('POST', `/workspaces/${b}/credentials/${id}/revoke`, {}, asOther)).status, 404);
    assert.equal((await s.request('POST', `/workspaces/${b}/credentials/${id}/rotate`, { password: 'x' }, asOther)).status, 404);
    assert.deepEqual(
      (await s.request('GET', `/workspaces/${b}/credentials`, undefined, asOther)).json<{ credentials: unknown[] }>().credentials,
      [],
    );
    // Nor can it be bound to a connector there.
    const bind = await s.request(
      'PUT',
      `/workspaces/${b}/connector-bindings`,
      {
        bindings: [
          {
            capability: 'send email',
            connector: 'mail',
            kind: 'smtp',
            operation: 'send',
            sideEffect: 'irreversible',
            adapter: 'smtp',
            credentialId: id,
          },
        ],
      },
      asOther,
    );
    assert.equal(bind.status, 400, bind.bodyText);
    assert.match(bind.bodyText, /not a connection of this workspace/);

    // A member of A with the publisher role (author, not manage) may list but not connect, rotate or revoke.
    const author = await s.issueAdditionalIdentity('alice');
    assert.equal((await s.request('POST', `/workspaces/${a}/members`, { identityId: 'alice', role: 'publisher' })).status, 201);
    const asAuthor = TestServer.authHeader(author.apiKey);
    assert.equal((await s.request('GET', `/workspaces/${a}/credentials`, undefined, asAuthor)).status, 200);
    assert.equal((await s.request('POST', `/workspaces/${a}/credentials/${id}/revoke`, {}, asAuthor)).status, 403);
    assert.equal(
      (await s.request('POST', `/workspaces/${a}/credentials/oauth`, { provider: 'google', capabilities: ['message.send'] }, asAuthor))
        .status,
      403,
    );

    // A consent started by someone who loses the manage role before the callback is not completed.
    assert.equal((await s.request('POST', `/workspaces/${a}/members`, { identityId: 'mallory', role: 'admin' })).status, 201);
    const { state } = await startConsent(s, a, asOther);
    assert.equal((await s.request('PATCH', `/workspaces/${a}/members/mallory`, { role: 'viewer' })).status, 200);
    const late = await s.request('GET', `/oauth/callback?state=${state}&code=c`, undefined, NO_AUTH);
    assert.equal(late.status, 403);
    assert.equal((await s.request('GET', `/workspaces/${a}/credentials`)).json<{ credentials: unknown[] }>().credentials.length, 1);

    // In A it binds, while active; once revoked it cannot be bound.
    const ok = await s.request('PUT', `/workspaces/${a}/connector-bindings`, {
      bindings: [
        {
          capability: 'send email',
          connector: 'mail',
          kind: 'smtp',
          operation: 'send',
          sideEffect: 'irreversible',
          adapter: 'smtp',
          credentialId: id,
        },
      ],
    });
    assert.equal(ok.status, 200, ok.bodyText);
    await s.request('POST', `/workspaces/${a}/credentials/${id}/revoke`, {});
    const revoked = await s.request('PUT', `/workspaces/${a}/connector-bindings`, {
      bindings: [
        {
          capability: 'send email',
          connector: 'mail',
          kind: 'smtp',
          operation: 'send',
          sideEffect: 'irreversible',
          adapter: 'smtp',
          credentialId: id,
        },
      ],
    });
    assert.equal(revoked.status, 409);
  });
});

test('an instance without a credentials key refuses connections instead of storing them unsealed', async () => {
  await withTempDir('xo-api-cred-', async (dataDir) => {
    const s = await TestServer.start({ workspaceDataDir: dataDir, credentials: null });
    try {
      const ws = (await s.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const r = await s.request('GET', `/workspaces/${ws}/credentials`);
      assert.equal(r.status, 503);
      assert.equal(r.json<{ error: { code: string } }>().error.code, 'XO_CREDENTIALS_NOT_CONFIGURED');
    } finally {
      await s.stop();
    }
  });
});
