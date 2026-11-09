import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  FileTokenStore,
  StaticTokenAuthority,
  TokenFileError,
  createXoServer,
  fileAuditSink,
  hasScope,
  newToken,
  requiredScope,
  type Scope,
  SCOPES,
} from '../src/index.js';
import { CLIENTS, call, json, makePki, start, stubs } from './harness.js';

/**
 * Real sockets, real TLS. Nothing leaves the machine. These establish what the server REFUSES; they say nothing about the strength of an operator's
 * certificates or the safety of an exposed deployment, which still needs an independent review (see docs/SERVER_HARDENING.md).
 */

const construct = (over: Record<string, unknown>) => {
  const s = stubs();
  return createXoServer({ runners: s.runners, store: s.store, authority: s.authority, replica: s.replica, ...over } as never);
};
const GOOD_TOKEN = 'x'.repeat(32);

describe('construction refuses unsafe configurations', () => {
  it('no authentication at all', () => assert.throws(() => construct({}), /no authentication configured/));
  it('a short legacy token', () => assert.throws(() => construct({ token: 'short' }), /at least 24/));
  it('a non-loopback address without allowRemote', () =>
    assert.throws(() => construct({ token: GOOD_TOKEN, host: '0.0.0.0' }), /loopback unless allowRemote/));
  it('the legacy shared token on a non-loopback address (it cannot expire, be revoked or be scoped)', () =>
    assert.throws(() => construct({ token: GOOD_TOKEN, host: '0.0.0.0', allowRemote: true, behindTlsProxy: true }), /legacy shared token/));
  const tokens = new StaticTokenAuthority([]);
  it('a non-loopback address without TLS and without an explicit statement that a proxy terminates it', () =>
    assert.throws(() => construct({ tokens, host: '0.0.0.0', allowRemote: true }), /without TLS/));
  it('tls together with behindTlsProxy (they are alternatives)', () =>
    assert.throws(
      () => construct({ tokens, host: '0.0.0.0', allowRemote: true, behindTlsProxy: true, tls: { key: 'k', cert: 'c' } }),
      /alternatives/,
    ));
  it('mutual TLS without a CA to check client certificates against', () =>
    assert.throws(() => construct({ tokens, tls: { key: 'k', cert: 'c', requireClientCert: true } }), /needs the `ca`/));
  it('accepts a remote binding that states a TLS proxy, and a loopback binding with tokens', () => {
    assert.doesNotThrow(() => construct({ tokens, host: '0.0.0.0', allowRemote: true, behindTlsProxy: true }));
    assert.doesNotThrow(() => construct({ tokens }));
  });
});

describe('scopes: deny by default, decided from method and path before any body is read', () => {
  const table: [string, string, Scope | 'public'][] = [
    ['GET', '/v1/health', 'public'],
    ['POST', '/v1/health', 'admin'],
    ['POST', '/v1/decide', 'read'],
    ['GET', '/v1/receipts', 'read'],
    ['POST', '/v1/loader/resolve', 'read'],
    ['GET', '/v1/runs/run_abc', 'read'],
    ['GET', '/v1/workflows/wf/runs', 'read'],
    ['POST', '/v1/workflows/wf/runs', 'run'],
    ['POST', '/v1/runs/run_abc/lease', 'lease'],
    ['GET', '/v1/ledger/run_abc', 'ledger-sync'],
    ['POST', '/v1/ledger/run_abc', 'ledger-sync'],
    ['GET', '/v1/approvals', 'read'],
    ['POST', '/v1/approvals/appr_x', 'approve'],
    ['DELETE', '/v1/receipts', 'admin'],
    ['GET', '/v1/anything/new', 'admin'],
    ['GET', '/v2/health', 'admin'],
    ['GET', '/', 'admin'],
    ['GET', '/V1/health', 'admin'],
    ['GET', '/v1/health/', 'admin'],
    ['GET', '//v1/health', 'admin'],
    ['GET', '/v1/healthz', 'admin'],
  ];
  for (const [m, p, need] of table) it(`${m} ${p} needs ${need}`, () => assert.equal(requiredScope(m, p), need));
  it('admin satisfies any scope; nothing else satisfies another', () => {
    for (const s of SCOPES) assert.equal(hasScope(new Set<Scope>(['admin']), s), true);
    for (const a of SCOPES.filter((x) => x !== 'admin'))
      for (const b of SCOPES.filter((x) => x !== a)) assert.equal(hasScope(new Set<Scope>([a]), b), false, `${a} must not satisfy ${b}`);
  });
});

describe('scope escalation over HTTP', () => {
  it('every token can do exactly its own scope and nothing else; the handler is never reached when refused', async () => {
    const f = await start();
    try {
      const routes: { scope: Scope; method: string; path: string; body?: string; reaches: string }[] = [
        { scope: 'run', method: 'POST', path: '/v1/workflows/wf/runs', body: '{"inputs":{}}', reaches: 'runner.start' },
        {
          scope: 'lease',
          method: 'POST',
          path: '/v1/runs/run_aaaaaaaaaaaaaaaaaaaaaaaa/lease',
          body: '{"owner":"o","ttlMs":5000,"action":"acquire"}',
          reaches: 'lease.acquire',
        },
        {
          scope: 'ledger-sync',
          method: 'POST',
          path: '/v1/ledger/run_aaaaaaaaaaaaaaaaaaaaaaaa',
          body: '{"owner":"o","token":1,"entries":[]}',
          reaches: 'ledger.ingest',
        },
      ];
      for (const r of routes)
        for (const c of CLIENTS) {
          f.reached.length = 0;
          const res = await call(f, r.method, r.path, { token: f.tokens[c.id]!, ...(r.body !== undefined ? { body: r.body } : {}) });
          const allowed = c.scopes.includes(r.scope) || c.scopes.includes('admin');
          if (allowed) assert.notEqual(res.status, 403, `${c.id} should be allowed ${r.scope}`);
          else {
            assert.equal(res.status, 403, `${c.id} (${c.scopes}) must not ${r.method} ${r.path}`);
            assert.equal(f.reached.includes(r.reaches), false, `${c.id} reached ${r.reaches} while forbidden`);
            assert.equal(json(res)['error'], 'FORBIDDEN');
          }
        }
      assert.ok(f.audit.some((e) => e.kind === 'forbidden' && e.clientId === 'reader' && e.need === 'run'));
    } finally {
      await f.close();
    }
  });
  it('a read token cannot be talked into more: claims in the body, headers or query string are ignored', async () => {
    const f = await start();
    try {
      const attempts = [
        {
          path: '/v1/workflows/wf/runs?scope=admin&role=run',
          body: '{"inputs":{},"scope":"admin","scopes":["run","admin"]}',
          headers: { 'x-xo-scope': 'admin', 'x-scope': 'admin', 'x-forwarded-user': 'root' },
        },
        { path: '/v1/receipts/../workflows/wf/runs', body: '{"inputs":{}}', headers: {} }, // dot segments normalise to the run route
        { path: '/v1/workflows/wf/runs/', body: '{"inputs":{}}', headers: {} },
        { path: '/v1/workflows/wf/runs', body: '{"inputs":{}}', headers: { 'x-http-method-override': 'GET', 'x-method-override': 'GET' } },
      ];
      for (const a of attempts) {
        f.reached.length = 0;
        const res = await call(f, 'POST', a.path, { token: f.tokens['reader']!, body: a.body, headers: a.headers });
        assert.ok([403, 404].includes(res.status), `${a.path}: ${res.status}`);
        assert.equal(f.reached.includes('runner.start'), false, `${a.path} reached the runner`);
      }
    } finally {
      await f.close();
    }
  });
  it('routes nobody mapped are admin-only: a normal token gets 403, admin gets 404', async () => {
    const f = await start();
    try {
      assert.equal((await call(f, 'GET', '/v1/brand/new', { token: f.tokens['runner']! })).status, 403);
      assert.equal((await call(f, 'GET', '/v1/brand/new', { token: f.tokens['root']! })).status, 404);
    } finally {
      await f.close();
    }
  });
});

describe('authentication bypass attempts (every one is a 401 and reaches nothing)', () => {
  const variants: [string, (t: string) => { headers?: Record<string, string>; path?: string; token?: string }][] = [
    ['no credential at all', () => ({})],
    ['lower-case scheme', (t) => ({ headers: { authorization: `bearer ${t}` } })],
    ['upper-case scheme', (t) => ({ headers: { authorization: `BEARER ${t}` } })],
    ['two spaces after Bearer', (t) => ({ headers: { authorization: `Bearer  ${t}` } })],
    ['a second word after the token', (t) => ({ headers: { authorization: `Bearer ${t} extra` } })],
    ['trailing characters', (t) => ({ headers: { authorization: `Bearer ${t}x` } })],
    ['truncated token', (t) => ({ headers: { authorization: `Bearer ${t.slice(0, -1)}` } })],
    ['Basic scheme carrying the token', (t) => ({ headers: { authorization: `Basic ${Buffer.from(`u:${t}`).toString('base64')}` } })],
    ['the token alone, no scheme', (t) => ({ headers: { authorization: t } })],
    ['empty bearer', () => ({ headers: { authorization: 'Bearer ' } })],
    ['token in the query string', (t) => ({ path: `/v1/receipts?access_token=${t}&token=${t}&api_key=${t}` })],
    ['token in a cookie', (t) => ({ headers: { cookie: `token=${t}; session=${t}` } })],
    ['token in other headers', (t) => ({ headers: { 'x-api-key': t, 'x-auth-token': t, 'proxy-authorization': `Bearer ${t}` } })],
    ['a 5 kB authorization header', () => ({ headers: { authorization: `Bearer ${'a'.repeat(5000)}` } })],
    ['a well-formed but unknown token', () => ({ token: newToken() })],
    ['null bytes', (t) => ({ headers: { authorization: `Bearer ${t.slice(0, 10)}\u0000${t.slice(10)}` } })],
  ];
  for (const [name, make] of variants)
    it(name, async () => {
      const f = await start();
      try {
        const v = make(f.tokens['root']!);
        let res;
        try {
          res = await call(f, 'GET', v.path ?? '/v1/receipts', {
            ...(v.token !== undefined ? { token: v.token } : {}),
            headers: v.headers ?? {},
          });
        } catch {
          return; // Node refused to even send a malformed header: also safe
        }
        assert.equal(res.status, 401, name);
        assert.equal(res.headers['www-authenticate'], 'Bearer');
        assert.equal(f.reached.length, 0);
        assert.ok(
          f.audit.some((e) => e.kind === 'auth_failure'),
          'the failure was not audited',
        );
      } finally {
        await f.close();
      }
    });

  it('the only public route is exactly GET /v1/health; look-alikes need a token', async () => {
    const f = await start();
    try {
      assert.equal((await call(f, 'GET', '/v1/health')).status, 200);
      assert.equal((await call(f, 'GET', '/v1/health?x=1')).status, 200);
      for (const p of ['/v1/health/', '/v1/healthz', '//v1/health', '/v1/%68ealth', '/V1/health', '/v1/health/..', '/v1//health']) {
        const r = await call(f, 'GET', p);
        assert.ok(r.status === 401, `${p} -> ${r.status}`);
      }
      assert.equal((await call(f, 'POST', '/v1/health')).status, 401);
    } finally {
      await f.close();
    }
  });
  it('verbs other than GET and POST are refused before authentication, with no CORS headers (a browser page on another origin gets nothing)', async () => {
    const f = await start();
    try {
      for (const m of ['OPTIONS', 'HEAD', 'PUT', 'DELETE', 'PATCH', 'TRACE', 'CONNECT']) {
        const r = await call(f, m, '/v1/receipts', {
          token: f.tokens['root']!,
          headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
        }).catch(() => undefined);
        if (r === undefined) continue;
        assert.equal(r.status, 405, m);
        // and WITHOUT credentials: a preflight or probe is refused as a method problem before authentication, so it neither learns anything nor appears as a failed login
        const anon = await call(f, m, '/v1/receipts', {
          headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
        }).catch(() => undefined);
        if (anon !== undefined) assert.equal(anon.status, 405, `${m} without credentials`);
        assert.equal(f.audit.filter((e) => e.kind === 'auth_failure').length, 0, `${m} was counted as a failed login`);
      }
      const ok = await call(f, 'GET', '/v1/receipts', { token: f.tokens['root']!, headers: { origin: 'https://evil.example' } });
      assert.equal(ok.status, 200);
      for (const h of Object.keys(ok.headers)) assert.equal(h.startsWith('access-control-'), false, `unexpected CORS header ${h}`);
    } finally {
      await f.close();
    }
  });
  it('responses carry the hardening headers, never reflect the credential, and never leak internals', async () => {
    const f = await start();
    try {
      const r = await call(f, 'GET', '/v1/receipts', { token: f.tokens['root']! });
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal('strict-transport-security' in r.headers, false, 'HSTS must not be sent over plain http');
      const bad = await call(f, 'GET', '/v1/receipts', { token: `${f.tokens['root']}` + 'z' });
      assert.equal(bad.body.includes(f.tokens['root']!), false);
      assert.deepEqual(json(bad), { error: 'UNAUTHORIZED' }, 'a refusal must not say whether the token was unknown, expired or revoked');
    } finally {
      await f.close();
    }
  });
});

describe('token lifecycle', () => {
  it('expired and revoked tokens are refused; a token revoked in the FUTURE still works until then (rotation overlap)', async () => {
    let t = 1_000_000;
    const f = await start({
      now: () => t,
      tokens: new StaticTokenAuthority([
        { id: 'exp', token: 'xo_' + 'a'.repeat(43), scopes: ['read'], expiresAtMs: 1_000_000 + 60_000 },
        { id: 'rev', token: 'xo_' + 'b'.repeat(43), scopes: ['read'], revokedAtMs: 1_000_000 - 1 },
        { id: 'later', token: 'xo_' + 'c'.repeat(43), scopes: ['read'], revokedAtMs: 1_000_000 + 60_000 },
      ]),
    });
    try {
      assert.equal((await call(f, 'GET', '/v1/receipts', { token: 'xo_' + 'a'.repeat(43) })).status, 200);
      assert.equal((await call(f, 'GET', '/v1/receipts', { token: 'xo_' + 'b'.repeat(43) })).status, 401);
      assert.equal((await call(f, 'GET', '/v1/receipts', { token: 'xo_' + 'c'.repeat(43) })).status, 200);
      t += 60_000;
      assert.equal((await call(f, 'GET', '/v1/receipts', { token: 'xo_' + 'a'.repeat(43) })).status, 401, 'expired');
      assert.equal((await call(f, 'GET', '/v1/receipts', { token: 'xo_' + 'c'.repeat(43) })).status, 401, 'overlap ended');
      const reasons = f.audit.filter((e) => e.kind === 'auth_failure').map((e) => e.reason);
      assert.deepEqual(reasons.sort(), ['expired', 'revoked', 'revoked'].sort());
    } finally {
      await f.close();
    }
  });

  it('a file-backed store: revocation takes effect on the RUNNING server, rotation replaces a token, and the file holds only hashes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xo-tok-'));
    const path = join(dir, 'tokens.json');
    let t = 5_000_000;
    const store = FileTokenStore.open(path, { now: () => t, reloadCheckMs: 0 });
    const a = store.create('svc-a', ['read', 'run'], { ttlMs: 3_600_000 });
    const f = await start({ tokens: store, now: () => t });
    try {
      assert.equal((await call(f, 'GET', '/v1/receipts', { token: a })).status, 200);
      const onDisk = await readFile(path, 'utf8');
      assert.equal(onDisk.includes(a), false, 'the token itself must never be stored');
      assert.match(onDisk, /"hash": "sha256:[0-9a-f]{64}"/);
      assert.equal((await stat(path)).mode & 0o077, 0, 'the token file must be owner-only');

      const rotated = store.rotate('svc-a', { ttlMs: 3_600_000 });
      assert.equal(rotated.id, 'svc-a~2');
      assert.equal(
        (await call(f, 'GET', '/v1/receipts', { token: a })).status,
        401,
        'the old token must stop working at once (no overlap requested)',
      );
      assert.equal((await call(f, 'GET', '/v1/receipts', { token: rotated.token })).status, 200);

      store.revoke('svc-a~2');
      t += 5;
      assert.equal(
        (await call(f, 'GET', '/v1/receipts', { token: rotated.token })).status,
        401,
        'revocation did not reach the running server',
      );
    } finally {
      await f.close();
    }
  });

  it('a token file that becomes corrupt or unreadable DENIES EVERYTHING (it never falls back to anything), and says why in the audit log only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xo-tok-bad-'));
    const path = join(dir, 'tokens.json');
    const store = FileTokenStore.open(path, { reloadCheckMs: 0 });
    const tok = store.create('svc', ['admin']);
    const f = await start({ tokens: store });
    try {
      assert.equal((await call(f, 'GET', '/v1/receipts', { token: tok })).status, 200);
      await writeFile(path, '{ this is not json', { mode: 0o600 });
      const r = await call(f, 'GET', '/v1/receipts', { token: tok });
      assert.equal(r.status, 401);
      assert.deepEqual(json(r), { error: 'UNAUTHORIZED' });
      assert.ok(f.audit.some((e) => e.kind === 'token_store_unavailable'));
      assert.match(store.unavailableReason ?? '', /valid JSON/);
    } finally {
      await f.close();
    }
  });

  it('the token file is refused when it is group/world accessible, has unknown scopes or keys, or duplicates a client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xo-tok-perm-'));
    const path = join(dir, 'tokens.json');
    FileTokenStore.open(path).create('svc', ['read']);
    await chmod(path, 0o644);
    assert.throws(() => FileTokenStore.open(path), /must be 0600/);
    await chmod(path, 0o600);
    const rec = (over: Record<string, unknown>) => ({
      id: 'x',
      hash: `sha256:${'a'.repeat(64)}`,
      scopes: ['read'],
      createdAt: new Date(0).toISOString(),
      ...over,
    });
    const bad: [string, unknown, RegExp][] = [
      ['unknown scope', { version: 1, clients: [rec({ scopes: ['read', 'superuser'] })] }, /unknown scope/],
      ['empty scopes', { version: 1, clients: [rec({ scopes: [] })] }, /non-empty/],
      ['unknown key', { version: 1, clients: [rec({ token: 'plaintext' })] }, /unknown key "token"/],
      ['bad hash', { version: 1, clients: [rec({ hash: 'plain-token' })] }, /hash must be/],
      ['duplicate id', { version: 1, clients: [rec({}), rec({ hash: `sha256:${'b'.repeat(64)}` })] }, /duplicate client id/],
      ['shared hash', { version: 1, clients: [rec({}), rec({ id: 'y' })] }, /share a token hash/],
      ['bad date', { version: 1, clients: [rec({ expiresAt: 'tomorrow-ish' })] }, /not a date/],
      ['wrong version', { version: 2, clients: [] }, /version":1/],
    ];
    for (const [name, content, re] of bad) {
      await writeFile(path, JSON.stringify(content), { mode: 0o600 });
      assert.throws(
        () => FileTokenStore.open(path),
        (e: unknown) => e instanceof TokenFileError && re.test(e.message),
        name,
      );
    }
  });
});

describe('failed-authentication lockout and the audit log', () => {
  it('after the limit, further failures are answered 429 AUTH_LOCKED; a valid token still works; the log has no credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xo-audit-'));
    const log = join(dir, 'audit.jsonl');
    const f = await start({ failedAuthLimitPerMinute: 3, audit: fileAuditSink(log) });
    try {
      const secret = f.tokens['root']!;
      const seen: number[] = [];
      for (let i = 0; i < 6; i++) seen.push((await call(f, 'GET', '/v1/receipts', { token: newToken() })).status);
      assert.deepEqual(seen, [401, 401, 401, 429, 429, 429]);
      assert.equal((await call(f, 'GET', '/v1/receipts', { token: secret })).status, 200, 'a valid credential is not locked out');
      await call(f, 'GET', '/v1/receipts/%0a%0d{"kind":"forged"}', { token: newToken() });
      const text = await readFile(log, 'utf8');
      assert.equal(text.includes(secret), false);
      for (const tok of Object.values(f.tokens)) assert.equal(text.includes(tok), false);
      assert.equal(/Bearer|authorization/i.test(text), false, 'a header value reached the log');
      const lines = text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string; path: string });
      assert.equal(lines.filter((l) => l.kind === 'auth_lockout').length, 1, 'lockout is logged once, not once per attempt');
      assert.equal(
        lines.some((l) => l.kind === 'forged'),
        false,
        'a hostile path forged a log entry',
      );
      assert.equal((await stat(log)).mode & 0o077, 0, 'the audit log must be owner-only');
    } finally {
      await f.close();
    }
  });
  it('rate limiting happens BEFORE authentication, so an unauthenticated flood is cut off cheaply', async () => {
    const f = await start({ rateLimitPerMinute: 5 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await call(f, 'GET', '/v1/health')).status);
      assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429, 429]);
      assert.ok(f.audit.some((e) => e.kind === 'rate_limited'));
    } finally {
      await f.close();
    }
  });
});

describe('request bodies and slow clients', () => {
  const runBody = '{"inputs":{}}';
  it('an oversized body is refused (declared or streamed), a wrong media type and bad JSON are refused, none of it reaches the runner', async () => {
    const f = await start({ maxBodyBytes: 1000 });
    try {
      const t = f.tokens['runner']!;
      const big = JSON.stringify({ inputs: { pad: 'x'.repeat(5000) } });
      assert.equal((await call(f, 'POST', '/v1/workflows/wf/runs', { token: t, body: big })).status, 413);
      assert.equal(
        (await call(f, 'POST', '/v1/workflows/wf/runs', { token: t, body: runBody, headers: { 'content-type': 'text/plain' } })).status,
        415,
      );
      assert.equal((await call(f, 'POST', '/v1/workflows/wf/runs', { token: t, body: '{nope' })).status, 400);
      assert.equal((await call(f, 'POST', '/v1/workflows/wf/runs', { token: t, body: '[1,2]' })).status, 400);
      // a body that lies about its length (chunked, no content-length) is still cut off at the limit
      const chunked = await new Promise<number>((resolve) => {
        const s = connect(f.port, '127.0.0.1', () => {
          s.write(
            `POST /v1/workflows/wf/runs HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${t}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
          );
          s.write(`${(5000).toString(16)}\r\n${'x'.repeat(5000)}\r\n0\r\n\r\n`);
        });
        let data = '';
        s.on('data', (d: Buffer) => (data += d.toString()));
        s.on('close', () => resolve(Number(/HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)));
        s.on('error', () => resolve(0));
      });
      assert.ok(chunked === 413 || chunked === 0, `chunked overflow answered ${chunked}`);
      assert.equal(f.reached.includes('runner.start'), false);
    } finally {
      await f.close();
    }
  });

  it('an UNAUTHENTICATED request with a huge declared body is answered 401 at once and the connection is closed, without waiting for the body', async () => {
    const f = await start();
    try {
      const started = Date.now();
      const result = await new Promise<{ status: number; closed: boolean }>((resolve) => {
        const s = connect(f.port, '127.0.0.1', () =>
          s.write('POST /v1/workflows/wf/runs HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 104857600\r\n\r\n'),
        );
        let data = '';
        s.on('data', (d: Buffer) => (data += d.toString()));
        s.on('close', () => resolve({ status: Number(/HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0), closed: true }));
        s.on('error', () => resolve({ status: 0, closed: true }));
      });
      assert.equal(result.status, 401);
      assert.ok(Date.now() - started < 3000, 'the server waited for a body it was never going to read');
    } finally {
      await f.close();
    }
  });

  it('slowloris: trickled headers and a trickled body are both cut off by the deadlines', async () => {
    const f = await start({ requestTimeoutMs: 600, headersTimeoutMs: 400, timeoutCheckIntervalMs: 50 });
    try {
      const closedAfter = (write: (s: Socket) => void): Promise<number> =>
        new Promise((resolve) => {
          const t0 = Date.now();
          const s = connect(f.port, '127.0.0.1', () => write(s));
          s.on('close', () => resolve(Date.now() - t0));
          s.on('error', () => undefined);
          setTimeout(() => (s.destroy(), resolve(10_000)), 8000);
        });
      const headers = await closedAfter((s) => {
        s.write('GET /v1/health HTTP/1.1\r\nHost: x\r\n'); // never finishes the header block
        const t = setInterval(() => s.write('X-Slow: 1\r\n'), 100);
        s.on('close', () => clearInterval(t));
      });
      assert.ok(headers < 4000, `trickled headers survived ${headers} ms`);
      const body = await closedAfter((s) => {
        s.write(
          `POST /v1/workflows/wf/runs HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${f.tokens['runner']}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`,
        );
        const t = setInterval(() => s.write(' '), 150);
        s.on('close', () => clearInterval(t));
      });
      assert.ok(body < 4000, `a trickled body survived ${body} ms`);
      assert.equal(f.reached.includes('runner.start'), false);
    } finally {
      await f.close();
    }
  });
});

describe('TLS and mutual TLS (real handshakes, certificates made with openssl)', () => {
  const pki = makePki();
  const tlsOpts = { key: pki.serverKey, cert: pki.serverCert };

  it('serves over TLS with HSTS; a client that does not trust the CA, and a plaintext client, are refused', async () => {
    const f = await start({ tls: tlsOpts });
    try {
      const ok = await call(f, 'GET', '/v1/receipts', { token: f.tokens['root']!, tls: { ca: pki.ca } });
      assert.equal(ok.status, 200);
      assert.match(String(ok.headers['strict-transport-security']), /max-age=\d+/);
      await assert.rejects(call(f, 'GET', '/v1/health', { tls: { ca: pki.strangerCert } }), /self-signed|unable to verify|certificate/i);
      const plain = await call(f, 'GET', '/v1/health').then(
        (r) => r.status,
        () => 0,
      );
      assert.ok(plain === 0 || plain === 400, `a plaintext request to the TLS port got ${plain}`);
    } finally {
      await f.close();
    }
  });

  it('mutual TLS: no client certificate, or one from another CA, cannot complete the handshake; a valid one still needs a valid token', async () => {
    const f = await start({ tls: { ...tlsOpts, ca: pki.ca, requireClientCert: true } });
    try {
      await assert.rejects(call(f, 'GET', '/v1/health', { tls: { ca: pki.ca } }), /./, 'a client without a certificate was served');
      await assert.rejects(
        call(f, 'GET', '/v1/health', { tls: { ca: pki.ca, cert: pki.strangerCert, key: pki.strangerKey } }),
        /./,
        'a certificate from another CA was accepted',
      );
      const good = { ca: pki.ca, cert: pki.clientCert, key: pki.clientKey };
      assert.equal((await call(f, 'GET', '/v1/health', { tls: good })).status, 200);
      assert.equal((await call(f, 'GET', '/v1/receipts', { tls: good })).status, 401, 'a client certificate must not replace the token');
      assert.equal((await call(f, 'GET', '/v1/receipts', { token: f.tokens['reader']!, tls: good })).status, 200);
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(
        f.audit.some((e) => e.kind === 'tls_error'),
        'handshake refusals were not audited',
      );
    } finally {
      await f.close();
    }
  });

  it('a remote binding is allowed with built-in TLS (constructed, not exposed)', () => {
    assert.doesNotThrow(() => construct({ tokens: new StaticTokenAuthority([]), host: '0.0.0.0', allowRemote: true, tls: tlsOpts }));
  });
});
