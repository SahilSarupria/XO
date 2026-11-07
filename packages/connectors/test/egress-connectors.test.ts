import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ConnectorError,
  databaseConnector,
  egress,
  escapeChatText,
  hostAllowed,
  isPrivateAddress,
  readOnlySqlProblem,
  slackWebhookConnector,
  sqliteReadOnlyDriver,
  webhookOutConnector,
  type Connector,
  type DbDriver,
  type EgressDeps,
  type Json,
  type OperationContext,
  type StatementDef,
} from '../src/index.js';

/** Everything here is offline: a recording fake transport, or a throwaway server on loopback. Nothing reaches a real network. */

const HOOK_SECRET = 'https://hooks.example.com/services/T000/B000/SUPERSECRETTOKEN';
const SIGN_SECRET = 'whsec_0123456789abcdef';
const ctx = (over: Partial<OperationContext> = {}, secrets: Record<string, string> = {}): OperationContext => ({
  idempotencyKey: 'idem-123',
  runId: 'r',
  stepId: 's',
  secret: (n) => {
    const v = secrets[n];
    if (v === undefined) throw new Error(`secret ${n} not declared`);
    return v;
  },
  signal: new AbortController().signal,
  ...over,
});
const run = (c: Connector, op: string, args: Record<string, Json>, x: OperationContext = ctx()) => c.operations[op]!.execute(args, x);
const denied = async (p: Promise<unknown>, re?: RegExp) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ConnectorError, `expected a ConnectorError, got ${String(e)}`);
    if (re !== undefined) assert.match(e.message, re);
    return true;
  });

interface Seen {
  url: string;
  address: string;
  headers: Record<string, string>;
  body?: string;
}
function recorder(status = 200, body = 'ok', headers: Record<string, string> = {}) {
  const seen: Seen[] = [];
  const resolved: string[] = [];
  const deps: EgressDeps = {
    resolve: async (h) => (resolved.push(h), ['93.184.216.34']),
    transport: async (req, pinned) => {
      seen.push({
        url: req.url.href,
        address: pinned.address,
        headers: { ...req.headers },
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      return { status, headers, body };
    },
  };
  return { seen, resolved, deps };
}
const POLICY = { allowedHosts: ['hooks.example.com', '*.chat.example.org'], maxRequestBytes: 1000, maxResponseBytes: 1000 };
const send = (url: string, deps: EgressDeps, policy = POLICY) =>
  egress({ url, method: 'POST', headers: {}, body: '{}', signal: new AbortController().signal }, policy, deps);

describe('egress: allowlist bypass attempts', () => {
  const must = [
    'https://hooks.example.com@evil.example/', // userinfo trick
    'https://hooks.example.com:443@evil.example/',
    'https://evil.example/hooks.example.com',
    'https://evil.example/?h=hooks.example.com',
    'https://evil.example/#hooks.example.com',
    'https://hooks.example.com.evil.example/', // suffix trick
    'https://xhooks.example.com/', // prefix trick
    'https://example.com/', // apex of a wildcard is not a subdomain
    'https://evilchat.example.org/', // wildcard needs the dot
    'https://chat.example.org/', // wildcard does not cover the apex
    'https://h\u043e\u043eks.example.com/', // homograph (Cyrillic o): punycodes to a different name
    'http://hooks.example.com/', // scheme
    'ftp://hooks.example.com/',
    'javascript:alert(1)',
    'https://hooks.example.com:8443/', // port not listed
    'https://hooks.example.com:0/',
    '//hooks.example.com/',
    'not a url',
    '',
  ];
  for (const url of must)
    it(`refuses ${JSON.stringify(url).slice(0, 60)}`, async () => {
      const r = recorder();
      await denied(send(url, r.deps));
      assert.equal(r.seen.length, 0, 'a request was sent');
      assert.equal(r.resolved.length, 0, 'DNS was consulted for a refused destination');
    });
  it('accepts the exact host, case-insensitively and with a trailing dot, and wildcard subdomains', async () => {
    for (const url of [
      'https://hooks.example.com/a',
      'https://HOOKS.Example.COM/a',
      'https://hooks.example.com./a',
      'https://a.b.chat.example.org/x',
    ]) {
      const r = recorder();
      await send(url, r.deps);
      assert.equal(r.seen.length, 1, url);
    }
  });
  it('hostAllowed is exact or "*.suffix", never a substring', () => {
    assert.equal(hostAllowed('a.example.com', ['*.example.com']), true);
    assert.equal(hostAllowed('example.com', ['*.example.com']), false);
    assert.equal(hostAllowed('notexample.com', ['*.example.com']), false);
    assert.equal(hostAllowed('example.com.evil.io', ['example.com']), false);
  });
});

describe('egress: SSRF, rebinding, redirects, bounds', () => {
  const PRIVATE = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.9',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '2002:a00:1::',
    '2001:0:4136:e378::1',
    '224.0.0.1',
  ];
  for (const addr of PRIVATE)
    it(`refuses an allowed name that resolves to ${addr}`, async () => {
      assert.equal(isPrivateAddress(addr), true);
      const seen: unknown[] = [];
      await denied(
        send('https://hooks.example.com/', {
          resolve: async () => [addr],
          transport: async () => (seen.push(1), { status: 200, headers: {}, body: '' }),
        }),
        /private|unusable/,
      );
      assert.equal(seen.length, 0);
    });
  it('refuses a name with ONE public and ONE private record (multi-record rebinding)', async () => {
    await denied(
      send('https://hooks.example.com/', {
        resolve: async () => ['93.184.216.34', '10.0.0.5'],
        transport: async () => ({ status: 200, headers: {}, body: '' }),
      }),
    );
  });
  it('refuses a name that does not resolve', async () => {
    await denied(
      send('https://hooks.example.com/', { resolve: async () => [], transport: async () => ({ status: 200, headers: {}, body: '' }) }),
      /does not resolve/,
    );
  });
  it('resolves ONCE and connects to that vetted address: a second, different DNS answer cannot take over', async () => {
    let calls = 0;
    const seen: string[] = [];
    await send('https://hooks.example.com/', {
      resolve: async () => (calls++ === 0 ? ['93.184.216.34'] : ['10.0.0.1']),
      transport: async (_r, pinned) => (seen.push(pinned.address), { status: 200, headers: {}, body: 'ok' }),
    });
    assert.equal(calls, 1);
    assert.deepEqual(seen, ['93.184.216.34']);
  });
  for (const status of [301, 302, 303, 307, 308])
    it(`refuses a ${status} redirect (it could point anywhere)`, async () => {
      const r = recorder(status, '', { location: 'http://169.254.169.254/latest/meta-data' });
      await denied(send('https://hooks.example.com/', r.deps), /redirect/);
      assert.equal(r.seen.length, 1, 'the redirect target must never be followed');
    });
  it('refuses an oversized request before DNS or the network', async () => {
    const r = recorder();
    await denied(
      egress(
        { url: 'https://hooks.example.com/', method: 'POST', headers: {}, body: 'x'.repeat(2000), signal: new AbortController().signal },
        POLICY,
        r.deps,
      ),
      /too large/,
    );
    assert.equal(r.resolved.length, 0);
  });

  describe('the real transport, against a local server (loopback is permitted ONLY via allowPrivateNetwork)', () => {
    const serve = (
      handler: (req: IncomingMessage, send: (status: number, body: string, headers?: Record<string, string>) => void) => void,
    ) =>
      new Promise<{ server: Server; port: number }>((resolve) => {
        const server = createServer((req, res) =>
          handler(req, (status, body, headers = {}) => (res.writeHead(status, headers), res.end(body))),
        );
        server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
      });
    const local = (port: number) => ({
      allowedHosts: ['hook.test'],
      allowedPorts: [port],
      allowPrivateNetwork: true,
      maxRequestBytes: 1000,
      maxResponseBytes: 100,
    });

    it('connects to the PINNED address while sending the original Host, and bounds the response', async () => {
      let hostHeader = '';
      const { server, port } = await serve((req, reply) => ((hostHeader = String(req.headers.host)), reply(200, 'fine')));
      try {
        const res = await egress(
          { url: `http://hook.test:${port}/p?q=1`, method: 'POST', headers: {}, body: '{}', signal: new AbortController().signal },
          local(port),
          { resolve: async () => ['127.0.0.1'] },
        );
        assert.equal(res.body, 'fine');
        assert.equal(hostHeader, `hook.test:${port}`);
      } finally {
        server.close();
      }
    });
    it('refuses a response larger than the limit (declared or streamed) and a redirect from a real server', async () => {
      const { server, port } = await serve((req, reply) => {
        if (req.url === '/big') reply(200, 'x'.repeat(5000));
        else if (req.url === '/hop') reply(302, '', { location: 'http://127.0.0.1:1/' });
        else reply(200, 'ok');
      });
      try {
        const deps = { resolve: async () => ['127.0.0.1'] };
        const go = (path: string) =>
          egress(
            { url: `http://hook.test:${port}${path}`, method: 'POST', headers: {}, body: '{}', signal: new AbortController().signal },
            local(port),
            deps,
          );
        await denied(go('/big'), /exceeds maxResponseBytes/);
        await denied(go('/hop'), /redirect/);
      } finally {
        server.close();
      }
    });
    it('honours the abort signal', async () => {
      const { server, port } = await serve(() => undefined); // never answers
      try {
        const ac = new AbortController();
        const p = egress({ url: `http://hook.test:${port}/`, method: 'POST', headers: {}, body: '{}', signal: ac.signal }, local(port), {
          resolve: async () => ['127.0.0.1'],
        });
        setTimeout(() => ac.abort(), 30);
        await assert.rejects(p, (e: unknown) => e instanceof ConnectorError && e.code === 'TIMEOUT');
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });
    it('without allowPrivateNetwork the same loopback server is unreachable', async () => {
      const { server, port } = await serve((_r, reply) => reply(200, 'ok'));
      try {
        await denied(
          egress(
            { url: `https://hook.test:${port}/`, method: 'POST', headers: {}, body: '{}', signal: new AbortController().signal },
            { ...local(port), allowPrivateNetwork: false },
            { resolve: async () => ['127.0.0.1'] },
          ),
          /private/,
        );
      } finally {
        server.close();
      }
    });
  });
});

describe('webhook_out', () => {
  const cfg = { url: 'https://hooks.example.com/in', allowedHosts: ['hooks.example.com'], signingSecret: 'sign' };
  const secrets = { sign: SIGN_SECRET };

  it('sends JSON with an idempotency key and a verifiable HMAC signature', async () => {
    const r = recorder(200, '{"received":true}', { 'content-type': 'application/json' });
    const out = await run(webhookOutConnector(cfg, r.deps), 'post', { body: { a: 1 }, event: 'case.decided' }, ctx({}, secrets));
    assert.deepEqual(out, { status: 200, ok: true, body: { received: true } });
    const s = r.seen[0]!;
    assert.equal(s.headers['idempotency-key'], 'idem-123');
    assert.equal(s.headers['x-xo-event'], 'case.decided');
    assert.equal(s.address, '93.184.216.34');
    const expected = createHmac('sha256', SIGN_SECRET).update(`${s.headers['x-xo-timestamp']}.${s.body}`).digest('hex');
    assert.equal(s.headers['x-xo-signature'], `v1=${expected}`);
    assert.ok(Math.abs(Number(s.headers['x-xo-timestamp']) - Date.now() / 1000) < 5);
  });
  it('is unsigned when no secret is configured, and never sends the secret itself', async () => {
    const r = recorder();
    await run(webhookOutConnector({ url: cfg.url, allowedHosts: cfg.allowedHosts }, r.deps), 'post', { body: 1 });
    assert.equal('x-xo-signature' in r.seen[0]!.headers, false);
    const r2 = recorder();
    await run(webhookOutConnector(cfg, r2.deps), 'post', { body: { a: 1 } }, ctx({}, secrets));
    assert.equal(JSON.stringify(r2.seen[0]).includes(SIGN_SECRET), false, 'the signing key was transmitted');
  });
  it('a workflow cannot choose the host, path, headers or method: any extra argument is refused', async () => {
    const c = webhookOutConnector(cfg, recorder().deps);
    for (const extra of [
      { url: 'https://evil.example/' },
      { headers: { authorization: 'x' } },
      { path: '/../admin' },
      { method: 'DELETE' },
      { host: 'evil.example' },
    ])
      await denied(run(c, 'post', { body: 1, ...extra } as Record<string, Json>, ctx({}, secrets)), /unknown argument/);
    await denied(run(c, 'post', {}, ctx({}, secrets)), /body is required/);
  });
  it('header injection through event is refused', async () => {
    const c = webhookOutConnector(cfg, recorder().deps);
    for (const ev of ['x\r\nx-evil: 1', 'a b', '', 'a'.repeat(129), 'é', 5 as unknown as string])
      await denied(run(c, 'post', { body: 1, event: ev }, ctx({}, secrets)), /event/);
  });
  it('refuses to be built with a destination off its own allowlist, or with a sloppy allowlist', () => {
    assert.throws(() => webhookOutConnector({ url: 'https://evil.example/', allowedHosts: ['hooks.example.com'] }), /not on allowedHosts/);
    assert.throws(() => webhookOutConnector({ url: cfg.url, allowedHosts: [] }), /at least one host/);
    assert.throws(() => webhookOutConnector({ url: 'http://hooks.example.com/in', allowedHosts: ['hooks.example.com'] }), /must be https/);
    assert.throws(
      () => webhookOutConnector({ url: 'https://u:p@hooks.example.com/in', allowedHosts: ['hooks.example.com'] }),
      /credentials/,
    );
    assert.throws(() => webhookOutConnector({ url: 'nope', allowedHosts: ['hooks.example.com'] }), /valid URL/);
    for (const bad of [
      '10.0.0.1',
      'https://hooks.example.com',
      'hooks.example.com/path',
      'hooks.example.com:443',
      'com',
      '*',
      '*.com.',
      '',
    ])
      assert.throws(
        () => webhookOutConnector({ url: cfg.url, allowedHosts: [bad, 'hooks.example.com'] }),
        /allowedHosts|not a host name|is an IP address/,
        bad,
      );
  });
  it('5xx is a retryable failure; 4xx is returned to the workflow as not-ok; a transport error never carries the signing key', async () => {
    await denied(run(webhookOutConnector(cfg, recorder(503).deps), 'post', { body: 1 }, ctx({}, secrets)), /status 503/);
    assert.equal(
      ((await run(webhookOutConnector(cfg, recorder(404, 'nope').deps), 'post', { body: 1 }, ctx({}, secrets))) as { ok: boolean }).ok,
      false,
    );
    const leaky: EgressDeps = {
      resolve: async () => ['93.184.216.34'],
      transport: async () => {
        throw new Error(`boom while using ${SIGN_SECRET}`);
      },
    };
    await assert.rejects(run(webhookOutConnector(cfg, leaky), 'post', { body: 1 }, ctx({}, secrets)), (e: unknown) => {
      assert.ok(e instanceof ConnectorError);
      assert.equal(e.message.includes(SIGN_SECRET), false, 'the key leaked into an error');
      return true;
    });
  });
  it('an upstream that answers with a body of any size or shape cannot break the result (untrusted text stays text)', async () => {
    const r = recorder(200, '<script>alert(1)</script>', { 'content-type': 'text/html' });
    const out = (await run(webhookOutConnector(cfg, r.deps), 'post', { body: 1 }, ctx({}, secrets))) as { body: string };
    assert.equal(out.body, '<script>alert(1)</script>');
    const bad = recorder(200, '{not json', { 'content-type': 'application/json' });
    assert.equal(
      ((await run(webhookOutConnector(cfg, bad.deps), 'post', { body: 1 }, ctx({}, secrets))) as { body: string }).body,
      '{not json',
    );
  });
});

describe('slack_webhook', () => {
  const secrets = { hook: HOOK_SECRET };
  const cfg = { webhookSecret: 'hook', allowedHosts: ['hooks.example.com'] };

  it('posts escaped plain text to the secret URL, with an idempotency key', async () => {
    const r = recorder(200, 'ok');
    const out = await run(slackWebhookConnector(cfg, r.deps), 'post_message', { text: 'Case 7 approved' }, ctx({}, secrets));
    assert.deepEqual(out, { status: 200, ok: true, body: 'ok' });
    assert.equal(r.seen[0]!.url, HOOK_SECRET);
    assert.deepEqual(JSON.parse(r.seen[0]!.body!), { text: 'Case 7 approved' });
    assert.equal(r.seen[0]!.headers['idempotency-key'], 'idem-123');
  });
  it('neutralises mention and link injection from untrusted text', async () => {
    for (const evil of [
      '<!channel> pay now',
      '<!here>',
      '<!everyone>',
      '<@U12345>',
      '<!subteam^S123|admins>',
      '<https://evil.example|your invoice>',
      'a & b <c>',
    ]) {
      const r = recorder();
      await run(slackWebhookConnector(cfg, r.deps), 'post_message', { text: evil }, ctx({}, secrets));
      const sent = (JSON.parse(r.seen[0]!.body!) as { text: string }).text;
      assert.equal(/[<>]/.test(sent), false, `markup survived: ${sent}`);
      assert.equal(sent, escapeChatText(evil));
    }
  });
  it('the hook URL is a secret: only on the allowlist (default hooks.slack.com) and never in an error', async () => {
    const c = slackWebhookConnector({ webhookSecret: 'hook' }, recorder().deps); // default allowlist: hooks.slack.com only
    await assert.rejects(run(c, 'post_message', { text: 'x' }, ctx({}, secrets)), (e: unknown) => {
      assert.ok(e instanceof ConnectorError);
      assert.match(e.message, /allowlist/); // hooks.example.com is not hooks.slack.com
      assert.equal(e.message.includes('SUPERSECRETTOKEN'), false);
      return true;
    });
    const ok = slackWebhookConnector(cfg, recorder().deps);
    assert.equal(((await run(ok, 'post_message', { text: 'x' }, ctx({}, secrets))) as { ok: boolean }).ok, true);
  });
  it('a transport error that mentions the URL is scrubbed', async () => {
    const leaky: EgressDeps = {
      resolve: async () => ['93.184.216.34'],
      transport: async () => {
        throw new Error(`connect failed for ${HOOK_SECRET}`);
      },
    };
    await assert.rejects(run(slackWebhookConnector({ ...cfg }, leaky), 'post_message', { text: 'x' }, ctx({}, secrets)), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.message.includes('SUPERSECRETTOKEN'), false, 'the webhook token leaked into an error');
      return true;
    });
  });
  it('refuses empty, oversized, non-string text and extra arguments', async () => {
    const c = slackWebhookConnector({ ...cfg, maxTextChars: 20 }, recorder().deps);
    for (const text of ['', '   ', 'x'.repeat(21), 5, null, { a: 1 }] as Json[])
      await denied(run(c, 'post_message', { text }, ctx({}, secrets)), /text|characters/);
    await denied(run(c, 'post_message', { text: 'hi', channel: '#ops' }, ctx({}, secrets)), /unknown argument/);
    await denied(run(c, 'post_message', { text: 'hi', url: 'https://evil.example/' }, ctx({}, secrets)), /unknown argument/);
  });
  it('a revoked hook (404/410) is reported as not delivered, 5xx is retryable', async () => {
    const mk = (status: number) => slackWebhookConnector({ ...cfg }, recorder(status, 'no_service').deps);
    assert.equal(((await run(mk(404), 'post_message', { text: 'x' }, ctx({}, secrets))) as { ok: boolean }).ok, false);
    assert.equal(((await run(mk(410), 'post_message', { text: 'x' }, ctx({}, secrets))) as { ok: boolean }).ok, false);
    await denied(run(mk(502), 'post_message', { text: 'x' }, ctx({}, secrets)), /502/);
  });
});

describe('database: statements are vetted when built', () => {
  const GOOD: [string, number][] = [
    ['SELECT id, name FROM people WHERE id = ?', 1],
    ['select * from t where a = $1 and b = $2', 2],
    ['WITH x AS (SELECT 1 AS n) SELECT n FROM x', 0],
    ["select 'a;b' as s", 0], // a semicolon inside text is text
    ["select '; drop table t' as s", 0],
    ['select 1 /* ; drop table t */', 0], // a comment is not code
    ['select 1 -- delete from t', 0],
    ['select 1;', 0],
    ["select 'it''s' as s", 0],
    ['select "delete" from t', 0], // an identifier that merely looks like a keyword
    ['select count(*) from updates', 0], // a word that merely contains one
  ];
  for (const [sql, n] of GOOD)
    it(`accepts: ${sql}`, () => assert.equal(readOnlySqlProblem(sql, n), undefined, String(readOnlySqlProblem(sql, n))));

  const BAD: [string, number, RegExp][] = [
    ['DELETE FROM t', 0, /SELECT or WITH/],
    ['select 1; drop table t', 0, /more than one/],
    ['select 1; select 2', 0, /more than one/],
    ['select * from t into outfile "/tmp/x"', 0, /into/],
    ['select * into newtable from t', 0, /into/],
    ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 0, /delete/],
    ['select 1 where 1 = (insert into t values (1))', 0, /insert/],
    ['select pg_sleep(30)', 0, /pg_sleep/],
    ['select load_extension("x")', 0, /load_extension/],
    ['select readfile("/etc/passwd")', 0, /readfile/],
    ['select lo_import("/etc/passwd")', 0, /lo_import/],
    ['select * from dblink("x", "y") as t(a int)', 0, /dblink/],
    ['pragma writable_schema = 1', 0, /SELECT or WITH/],
    ['select 1 /* unterminated', 0, /unterminated comment/],
    ["select 'unterminated", 0, /unterminated/],
    ["select 'a\\' ; drop table t; --'", 0, /backslash/],
    ['select $$ ; drop table t; $$', 0, /dollar/],
    ['select $tag$x$tag$', 0, /dollar/],
    ['select [a] from t', 0, /bracket/],
    ['select * from t where a = ?', 0, /placeholder/],
    ['select * from t where a = ? and b = ?', 1, /placeholder/],
    ['select * from t where a = $1 and b = $3', 2, /\$1\.\.\$2/],
    ['select * from t where a = ? and b = $1', 2, /mixes/],
    ['', 0, /non-empty/],
    ['select 1\u0000; drop table t', 0, /control/],
    ['x'.repeat(9000), 0, /8192/],
    ['SeLeCt 1 WHERE 1=1 AND EXEC(1)', 0, /exec/],
    ['select 1 where x in (call foo())', 0, /call/],
    ['select 1 for update', 0, /SELECT|update/],
    ['select * from t; --', 0, /./],
  ];
  for (const [sql, n, re] of BAD)
    it(`refuses: ${sql.slice(0, 60).replace(/\u0000/g, '\\0')}`, () => {
      const p = readOnlySqlProblem(sql, n);
      if (sql === 'select * from t; --') return assert.equal(p, undefined, 'a trailing empty statement and a comment are harmless');
      assert.ok(p !== undefined, 'accepted');
      assert.match(p, re);
    });

  it('a bad statement stops the connector from being built, naming it', () => {
    const driver: DbDriver = { query: async () => ({ rows: [] }) };
    assert.throws(
      () => databaseConnector({ driver, statements: { ok: { sql: 'select 1', params: [] }, bad: { sql: 'delete from t', params: [] } } }),
      /statement "bad" refused/,
    );
    assert.throws(() => databaseConnector({ driver, statements: {} }), /at least one/);
    assert.throws(() => databaseConnector({ driver, statements: { 'Bad-Id': { sql: 'select 1', params: [] } } }), /must match/);
    assert.throws(
      () =>
        databaseConnector({
          driver,
          statements: {
            a: {
              sql: 'select ?',
              params: [
                { name: 'x', type: 'string' },
                { name: 'x', type: 'string' },
              ],
            },
          },
        }),
      /duplicate/,
    );
    assert.throws(() => databaseConnector({ driver, maxRows: 0, statements: { a: { sql: 'select 1', params: [] } } }), /maxRows/);
  });
});

describe('database: calls', () => {
  const STATEMENTS: Record<string, StatementDef> = {
    by_id: { sql: 'select id, name from people where id = ?', params: [{ name: 'id', type: 'integer' }] },
    by_name: { sql: 'select id, name from people where name = ?', params: [{ name: 'name', type: 'string' }] },
    maybe: {
      sql: 'select id from people where team = ? and score > ?',
      params: [
        { name: 'team', type: 'string', nullable: true },
        { name: 'score', type: 'number' },
      ],
    },
    flag: { sql: 'select id from people where active = ?', params: [{ name: 'active', type: 'boolean' }] },
    all: { sql: 'select id, name from people', params: [], maxRows: 3 },
  };
  const fake = (rows: Record<string, unknown>[] = [{ id: 1, name: 'a' }]) => {
    const calls: { sql: string; values: readonly unknown[]; maxRows: number }[] = [];
    const driver: DbDriver = { query: async (sql, values, o) => (calls.push({ sql, values, maxRows: o.maxRows }), { rows }) };
    return { calls, c: databaseConnector({ driver, statements: STATEMENTS, maxRows: 5 }) };
  };

  it("binds declared parameters positionally; the SQL the driver sees is exactly the operator's", async () => {
    const { calls, c } = fake();
    const out = await run(c, 'query', { statement: 'maybe', params: { score: 3.5, team: null } });
    assert.deepEqual(out, { rows: [{ id: 1, name: 'a' }], rowCount: 1, truncated: false });
    assert.deepEqual(calls[0]!.values, [null, 3.5], "values must follow the DECLARED order, not the caller's");
    assert.equal(calls[0]!.sql, STATEMENTS['maybe']!.sql);
  });
  it('refuses unknown statements (including inherited object keys), unknown/missing/mistyped parameters, and any attempt to send SQL', async () => {
    const { calls, c } = fake();
    for (const statement of [
      'nope',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      '',
      'BY_ID',
      'by_id ',
      5 as unknown as string,
    ])
      await denied(run(c, 'query', { statement, params: {} }), /unknown statement/);
    await denied(run(c, 'query', { statement: 'by_id', params: {} }), /missing/);
    await denied(run(c, 'query', { statement: 'by_id', params: { id: 1, extra: 2 } }), /unknown parameter/);
    await denied(run(c, 'query', { statement: 'by_id', params: { id: '1' } }), /safe integer/);
    await denied(run(c, 'query', { statement: 'by_id', params: { id: 1.5 } }), /safe integer/);
    await denied(run(c, 'query', { statement: 'by_id', params: { id: 2 ** 60 } }), /safe integer/);
    await denied(run(c, 'query', { statement: 'by_id', params: { id: null } }), /null is not allowed/);
    await denied(run(c, 'query', { statement: 'maybe', params: { team: 'x', score: Number.NaN } }), /finite/);
    await denied(run(c, 'query', { statement: 'flag', params: { active: 'true' } }), /boolean/);
    await denied(run(c, 'query', { statement: 'by_name', params: { name: 'a\u0000b' } }), /NUL/);
    await denied(run(c, 'query', { statement: 'by_name', params: { name: 'x'.repeat(5000) } }), /4096/);
    await denied(run(c, 'query', { statement: 'by_name', params: [] as unknown as Json }), /must be an object/);
    for (const extra of [{ sql: 'drop table people' }, { query: 'select 1' }, { raw: 'x' }])
      await denied(run(c, 'query', { statement: 'by_id', params: { id: 1 }, ...extra } as Record<string, Json>), /cannot send SQL/);
    assert.equal(calls.length, 0, 'the driver was reached by a refused call');
  });
  it('a hostile string value is DATA: it is bound, never spliced into SQL', async () => {
    const { calls, c } = fake();
    const hostile = "x'; DROP TABLE people; --";
    await run(c, 'query', { statement: 'by_name', params: { name: hostile } });
    assert.equal(calls[0]!.sql, STATEMENTS['by_name']!.sql);
    assert.deepEqual(calls[0]!.values, [hostile]);
  });
  it('row limits: asks the driver for limit+1, refuses overflow by default, truncates only when told to, honours per-statement ceilings', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: i, name: 'n' }));
    const { calls, c } = fake(many);
    await denied(run(c, 'query', { statement: 'all' }), /more than 3 rows/);
    assert.equal(calls[0]!.maxRows, 4);
    await denied(run(c, 'query', { statement: 'by_id', params: { id: 1 } }), /more than 5 rows/);
    const driver: DbDriver = { query: async () => ({ rows: many }) };
    const t = databaseConnector({ driver, statements: STATEMENTS, maxRows: 5, onOverflow: 'truncate' });
    const out = (await run(t, 'query', { statement: 'all' })) as { rowCount: number; truncated: boolean };
    assert.deepEqual([out.rowCount, out.truncated], [3, true]);
  });
  it('refuses oversized results and cells that cannot be returned as data', async () => {
    const big = databaseConnector({
      driver: { query: async () => ({ rows: [{ id: 1, name: 'x'.repeat(5000) }] }) },
      statements: STATEMENTS,
      maxResultBytes: 1000,
    });
    await denied(run(big, 'query', { statement: 'by_id', params: { id: 1 } }), /exceeds 1000 bytes/);
    for (const cell of [10n, new Date(), new Uint8Array(2), { a: 1 }, [1], undefined, () => 1]) {
      const c = databaseConnector({ driver: { query: async () => ({ rows: [{ v: cell }] }) }, statements: STATEMENTS });
      await denied(run(c, 'query', { statement: 'by_id', params: { id: 1 } }), /cannot be returned/);
    }
  });
  it('a driver failure is reported coarsely: no SQL text, connection string or bound value leaves the connector', async () => {
    const failing = (e: unknown): DbDriver => ({
      query: async () => {
        throw e;
      },
    });
    const secret = 'postgres://user:hunter2@db.internal/prod';
    const personal = 'jane.doe@example.com';
    const c = databaseConnector({
      driver: failing(Object.assign(new Error(`connect failed ${secret}; value ${personal}; sql select`), { code: 'ECONNREFUSED' })),
      statements: STATEMENTS,
    });
    await assert.rejects(run(c, 'query', { statement: 'by_name', params: { name: personal } }), (e: unknown) => {
      assert.ok(e instanceof ConnectorError);
      assert.equal(e.code, 'FAILED');
      assert.match(e.message, /database query failed \(ECONNREFUSED\)/);
      assert.equal(/hunter2|jane\.doe|select/i.test(e.message), false, e.message);
      return true;
    });
    const weird = databaseConnector({
      driver: failing(Object.assign(new Error('x'), { code: 'has spaces and secret=hunter2' })),
      statements: STATEMENTS,
    });
    await assert.rejects(
      run(weird, 'query', { statement: 'by_id', params: { id: 1 } }),
      (e: unknown) => e instanceof ConnectorError && e.message === 'database query failed',
    );
  });
  it('the time limit holds: an abort stops waiting on a driver that never answers', async () => {
    const hang = databaseConnector({ driver: { query: () => new Promise(() => undefined) }, statements: STATEMENTS });
    const ac = new AbortController();
    const p = run(hang, 'query', { statement: 'by_id', params: { id: 1 } }, ctx({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(p, (e: unknown) => e instanceof ConnectorError && e.code === 'TIMEOUT');
    const done = new AbortController();
    done.abort();
    await assert.rejects(run(hang, 'query', { statement: 'by_id', params: { id: 1 } }, ctx({ signal: done.signal })));
  });
});

describe('database: the bundled SQLite driver is read-only at the ENGINE, not just by our checks', () => {
  const setup = async () => {
    const mod = (await import('node:sqlite' as string)) as { DatabaseSync: new (p: string) => { exec(s: string): void; close(): void } };
    const dir = await mkdtemp(join(tmpdir(), 'xo-db-'));
    const path = join(dir, 'd.sqlite');
    const db = new mod.DatabaseSync(path);
    db.exec(
      "create table people(id integer primary key, name text, team text); insert into people values (1,'Ann','red'),(2,'Bo','blue'),(3,'x''; DROP TABLE people; --','red');",
    );
    db.close();
    return path;
  };
  it('answers allowlisted queries; a hostile value only ever matches literally; the table survives', async () => {
    const driver = await sqliteReadOnlyDriver(await setup());
    const c = databaseConnector({
      driver,
      statements: {
        by_name: { sql: 'select id, name from people where name = ?', params: [{ name: 'name', type: 'string' }] },
        in_team: { sql: 'select id, name from people where team = ? order by id', params: [{ name: 'team', type: 'string' }] },
      },
    });
    assert.deepEqual(((await run(c, 'query', { statement: 'in_team', params: { team: 'red' } })) as { rows: unknown[] }).rows, [
      { id: 1, name: 'Ann' },
      { id: 3, name: "x'; DROP TABLE people; --" },
    ]);
    for (const evil of ["Ann' OR '1'='1", "'; DROP TABLE people; --", 'Ann" --', '%', 'Ann\\']) {
      assert.deepEqual(
        ((await run(c, 'query', { statement: 'by_name', params: { name: evil } })) as { rowCount: number }).rowCount,
        evil === "'; DROP TABLE people; --" ? 0 : 0,
        evil,
      );
    }
    assert.equal(
      ((await run(c, 'query', { statement: 'in_team', params: { team: 'red' } })) as { rowCount: number }).rowCount,
      2,
      'the data changed',
    );
  });
  it('even a statement that bypassed our checks cannot write: the engine refuses', async () => {
    const driver = await sqliteReadOnlyDriver(await setup());
    const q = (sql: string) => driver.query(sql, [], { maxRows: 10, signal: new AbortController().signal });
    for (const sql of [
      'delete from people',
      "insert into people values (9,'z','z')",
      'drop table people',
      'create table t(a)',
      'update people set name = 1',
    ])
      await assert.rejects(q(sql), undefined, sql);
    // the engine lets a PRAGMA switch off its query_only convenience flag, which is exactly why the FILE is opened read-only: writes still fail afterwards
    await q('pragma query_only = off');
    await assert.rejects(q('delete from people'), /readonly|read-only/i);
    const rows = (await driver.query('select count(*) as n from people', [], { maxRows: 10, signal: new AbortController().signal })).rows;
    assert.equal((rows[0] as { n: number }).n, 3);
  });
  it('stops reading at the row limit', async () => {
    const driver = await sqliteReadOnlyDriver(await setup());
    const r = await driver.query('select id from people', [], { maxRows: 2, signal: new AbortController().signal });
    assert.equal(r.rows.length, 2);
  });
  it('refuses to open a path that does not exist (it would otherwise create an empty database)', async () => {
    await assert.rejects(sqliteReadOnlyDriver(join(tmpdir(), 'xo-does-not-exist', 'x.sqlite')));
  });
});

describe('through the ConnectorHost (declared -> granted -> implemented -> secrets -> idempotency -> dry-run)', () => {
  const manifest = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    workflows: [],
    connectors: [
      { id: 'chat', kind: 'slack_webhook', operations: [{ name: 'post_message', sideEffect: 'write', secrets: ['HOOK'] }] },
      { id: 'notify', kind: 'webhook_out', operations: [{ name: 'post', sideEffect: 'write', secrets: ['SIGN'] }] },
      { id: 'lookup', kind: 'database', operations: [{ name: 'query', sideEffect: 'read' }] },
    ],
  } as never;
  const build = async (grant: Record<string, string[]> = { chat: ['post_message'], notify: ['post'], lookup: ['query'] }) => {
    const { ConnectorHost, MapVault } = await import('../src/index.js');
    const web = recorder(200, 'ok');
    const driver: DbDriver = { query: async () => ({ rows: [{ n: 1 }] }) };
    const host = new ConnectorHost({
      component: manifest,
      policy: { connectors: Object.fromEntries(Object.entries(grant).map(([k, v]) => [k, { grant: v }])) },
      implementations: {
        chat: slackWebhookConnector({ webhookSecret: 'HOOK', allowedHosts: ['hooks.example.com'] }, web.deps),
        notify: webhookOutConnector(
          { url: 'https://hooks.example.com/in', allowedHosts: ['hooks.example.com'], signingSecret: 'SIGN' },
          web.deps,
        ),
        lookup: databaseConnector({ driver, statements: { one: { sql: 'select 1 as n', params: [] } } }),
      },
      vault: new MapVault({ HOOK: HOOK_SECRET, SIGN: SIGN_SECRET }),
    });
    return { host, web };
  };
  const base = { runId: 'r', stepId: 's', timeoutMs: 2000 };
  const codeOf = async (p: Promise<unknown>) =>
    (
      (await p.then(
        () => ({ code: 'ok' }),
        (e: unknown) => e,
      )) as { code: string }
    ).code;

  it('writes need an idempotency key; a granted, declared call goes out exactly once', async () => {
    const { host, web } = await build();
    assert.equal(
      await codeOf(host.call({ ...base, connector: 'chat', operation: 'post_message', args: { text: 'hi' } })),
      'MISSING_IDEMPOTENCY_KEY',
    );
    assert.equal(web.seen.length, 0);
    await host.call({ ...base, connector: 'chat', operation: 'post_message', args: { text: 'hi' }, idempotencyKey: 'k1' });
    await host.call({ ...base, connector: 'notify', operation: 'post', args: { body: { a: 1 } }, idempotencyKey: 'k2' });
    assert.equal(web.seen.length, 2);
  });
  it('an operation the operator did not grant, or one the manifest did not declare, never runs', async () => {
    const { host, web } = await build({ chat: [], notify: ['post'], lookup: ['query'] });
    assert.equal(
      await codeOf(host.call({ ...base, connector: 'chat', operation: 'post_message', args: { text: 'hi' }, idempotencyKey: 'k' })),
      'NOT_GRANTED',
    );
    assert.equal(
      await codeOf(host.call({ ...base, connector: 'notify', operation: 'delete', args: {}, idempotencyKey: 'k' })),
      'UNDECLARED',
    );
    assert.equal(await codeOf(host.call({ ...base, connector: 'nope', operation: 'post', args: {}, idempotencyKey: 'k' })), 'UNDECLARED');
    assert.equal(web.seen.length, 0);
  });
  it('dry-run: the database read runs, the writes are recorded as would-have-done and send nothing', async () => {
    const { host, web } = await build();
    const read = await host.call({ ...base, connector: 'lookup', operation: 'query', args: { statement: 'one' }, dryRun: true });
    assert.deepEqual((read as { data: unknown }).data, { rows: [{ n: 1 }], rowCount: 1, truncated: false });
    await host.call({ ...base, connector: 'chat', operation: 'post_message', args: { text: 'hi' }, idempotencyKey: 'k', dryRun: true });
    await host.call({ ...base, connector: 'notify', operation: 'post', args: { body: 1 }, idempotencyKey: 'k', dryRun: true });
    assert.equal(web.seen.length, 0, 'a dry run sent something');
  });
});

describe('egress: which failures prove nothing was sent (so a retry cannot duplicate)', () => {
  it('connection refused is "not sent"; a timeout mid-exchange is NOT', async () => {
    const policy = {
      allowedHosts: ['hook.test'],
      allowedPorts: [1],
      allowPrivateNetwork: true,
      maxRequestBytes: 100,
      maxResponseBytes: 100,
    };
    const refused = await egress(
      { url: 'http://hook.test:1/', method: 'POST', headers: {}, body: '{}', signal: new AbortController().signal },
      policy,
      { resolve: async () => ['127.0.0.1'] },
    ).catch((e: unknown) => e);
    assert.ok(refused instanceof ConnectorError);
    assert.equal(refused.effect, 'none', 'ECONNREFUSED can only happen before the request is written');
    const server = createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const hung = await egress(
      { url: `http://hook.test:${port}/`, method: 'POST', headers: {}, body: '{}', signal: ac.signal },
      { ...policy, allowedPorts: [port] },
      { resolve: async () => ['127.0.0.1'] },
    ).catch((e: unknown) => e);
    server.closeAllConnections();
    server.close();
    assert.ok(hung instanceof ConnectorError);
    assert.equal(hung.code, 'TIMEOUT');
    assert.equal(hung.effect, undefined, 'a timeout after the request was written MUST be treated as possibly delivered');
  });
});
