import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandRegistry } from '../src/command-registry.js';
import { registerCommands } from '../src/commands/token/index.js';
import { parseDuration } from '../src/commands/token/index.js';
import { createCommand } from '../src/commands/compiler/create.js';
import { makePki } from '../../../packages/server/test/harness.js';
import { withTempDir } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/xo.js', import.meta.url));
const LOAN = fileURLToPath(new URL('../../../packages/compiler/test/fixtures/loan-desk-policy.md', import.meta.url));

async function token(positionals: string[], flags: Record<string, string | boolean>): Promise<{ code: number; text: string }> {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => (chunks.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => (chunks.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await registry.get('token')!.run({ positionals, flags } as never);
    return { code: Number(code), text: chunks.join('') };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}
const tokenOf = (text: string): string => /(xo_[A-Za-z0-9_-]{43})/.exec(text)![1]!;

test('parseDuration accepts only m/h/d with a positive integer', () => {
  assert.equal(parseDuration('90m'), 90 * 60_000);
  assert.equal(parseDuration('12h'), 12 * 3_600_000);
  assert.equal(parseDuration('30d'), 30 * 86_400_000);
  for (const bad of ['', '0d', '-1d', '1.5h', '30', '30days', 'd', '1w', ' 5m', '5m ', '999999999d'])
    assert.equal(parseDuration(bad), undefined, JSON.stringify(bad));
});

test('xo token: create shows the token once, list never does, revoke and rotate work, the file is owner-only', async () => {
  await withTempDir('xo-tokcli-', async (tmp) => {
    const file = join(tmp, 'tokens.json');
    const created = await token(['create', 'svc-a'], { tokens: file, scopes: 'read,run', ttl: '30d', note: 'ci runner' });
    assert.equal(created.code, 0, created.text);
    const t1 = tokenOf(created.text);
    assert.match(created.text, /shown once/);
    assert.equal((await readFile(file, 'utf8')).includes(t1), false, 'the token was written to disk');
    assert.equal((await stat(file)).mode & 0o077, 0);

    const list = await token(['list'], { tokens: file });
    assert.match(list.text, /svc-a\s+scopes=read,run/);
    assert.equal(list.text.includes(t1), false, 'list printed a token');
    assert.match(list.text, /# ci runner/);

    const rot = await token(['rotate', 'svc-a'], { tokens: file, ttl: '30d', overlap: '1h' });
    assert.equal(rot.code, 0, rot.text);
    assert.match(rot.text, /svc-a -> svc-a~2; the old token works for 1h more/);
    assert.notEqual(tokenOf(rot.text), t1);
    assert.match((await token(['list'], { tokens: file })).text, /svc-a~2/);

    assert.equal((await token(['revoke', 'svc-a~2'], { tokens: file })).code, 0);
    assert.match((await token(['list'], { tokens: file })).text, /svc-a~2.*REVOKED=/);
    assert.equal((await token(['revoke', 'ghost'], { tokens: file })).code, 1);
  });
});

test('xo token refuses careless input: no expiry unless deliberate, unknown scopes, bad ttl, duplicates, wrong permissions', async () => {
  await withTempDir('xo-tokcli-bad-', async (tmp) => {
    const file = join(tmp, 'tokens.json');
    const no = await token(['create', 'a'], { tokens: file, scopes: 'read' });
    assert.equal(no.code, 1);
    assert.match(no.text, /--ttl.*--no-expiry/);
    assert.equal((await token(['create', 'a'], { tokens: file, scopes: 'read', 'no-expiry': true })).code, 0);
    assert.equal((await token(['create', 'a'], { tokens: file, scopes: 'read', ttl: '1d' })).code, 1, 'duplicate');
    for (const scopes of ['', 'superuser', 'read,root', 'READ'])
      assert.equal((await token(['create', 'b'], { tokens: file, scopes, ttl: '1d' })).code, 1, scopes);
    assert.equal((await token(['create', 'b'], { tokens: file, scopes: 'read', ttl: 'soon' })).code, 1);
    for (const id of ['', '-x', 'a b', 'a/b', '../x', 'x'.repeat(65)])
      assert.equal((await token(['create', id], { tokens: file, scopes: 'read', ttl: '1d' })).code, 1, id);
    await writeFile(file, await readFile(file), { mode: 0o644 });
    await import('node:fs/promises').then((fs) => fs.chmod(file, 0o644));
    const perm = await token(['list'], { tokens: file });
    assert.equal(perm.code, 1);
    assert.match(perm.text, /must be 0600/);
    assert.equal((await token(['list'], {})).code, 1, 'no file given');
  });
});

interface Serving {
  child: ChildProcess;
  port: number;
  stdout: () => string;
  stderr: () => string;
  stop: () => void;
}
async function serve(args: string[], env: Record<string, string> = {}): Promise<Serving> {
  const child = spawn(process.execPath, [BIN, 'serve', ...args, '--port', '0'], {
    env: { ...process.env, XO_TRUST_MODE: 'development', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`did not start: ${stdout} ${stderr}`)), 20_000);
    const poll = setInterval(() => {
      const m = /listening on https?:\/\/[^:]+:(\d+)/.exec(stdout);
      if (m !== null) {
        clearTimeout(t);
        clearInterval(poll);
        resolve(Number(m[1]));
      }
    }, 50);
    child.on('exit', () => {
      clearTimeout(t);
      clearInterval(poll);
      reject(new Error(`exited: ${stdout} ${stderr}`));
    });
  });
  return { child, port, stdout: () => stdout, stderr: () => stderr, stop: () => child.kill('SIGINT') };
}
const get = (port: number, path: string, tok?: string) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: tok !== undefined ? { authorization: `Bearer ${tok}` } : {} });

async function bundle(tmp: string): Promise<string> {
  const out = join(tmp, 'pkg.xo');
  const r = await createCommand({ sources: [LOAN], name: 'desk', version: '1.0.0', out, sign: true });
  assert.equal(r.exitCode, 0);
  return out;
}

test('xo serve --tokens: scoped tokens are enforced, revocation reaches the RUNNING server, refusals are audited without credentials', async () => {
  await withTempDir('xo-serve-tok-', async (tmp) => {
    const pkg = await bundle(tmp);
    const file = join(tmp, 'tokens.json');
    const reader = tokenOf((await token(['create', 'reader'], { tokens: file, scopes: 'read', ttl: '1d' })).text);
    const runner = tokenOf((await token(['create', 'runner'], { tokens: file, scopes: 'run', ttl: '1d' })).text);
    const s = await serve(['--bundle', pkg, '--runs', join(tmp, 'runs'), '--tokens', file, '--audit-log', join(tmp, 'audit.jsonl')]);
    try {
      assert.equal((await get(s.port, '/v1/health')).status, 200);
      assert.equal((await get(s.port, '/v1/receipts', reader)).status, 200);
      assert.equal((await get(s.port, '/v1/receipts', runner)).status, 403, 'a run-only token must not read');
      assert.equal((await get(s.port, '/v1/receipts')).status, 401);
      assert.equal((await get(s.port, '/v1/receipts', `xo_${'z'.repeat(43)}`)).status, 401);

      assert.equal((await token(['revoke', 'reader'], { tokens: file })).code, 0);
      await new Promise((r) => setTimeout(r, 1300)); // the store re-checks its file about once a second
      assert.equal((await get(s.port, '/v1/receipts', reader)).status, 401, 'revocation did not reach the running server');

      const log = await readFile(join(tmp, 'audit.jsonl'), 'utf8');
      assert.equal(log.includes(reader) || log.includes(runner), false, 'a token reached the audit log');
      const kinds = log
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string; reason?: string; clientId?: string });
      assert.ok(kinds.some((k) => k.kind === 'forbidden' && k.clientId === 'runner'));
      assert.ok(kinds.some((k) => k.kind === 'auth_failure' && k.reason === 'missing'));
      assert.ok(kinds.some((k) => k.kind === 'auth_failure' && k.reason === 'revoked'));
    } finally {
      s.stop();
    }
  });
});

test('xo serve refuses unsafe exposure before listening: remote without TLS, remote with the shared token, half a TLS pair, a bad token file', async () => {
  await withTempDir('xo-serve-refuse-', async (tmp) => {
    const pkg = await bundle(tmp);
    const file = join(tmp, 'tokens.json');
    await token(['create', 'a'], { tokens: file, scopes: 'read', ttl: '1d' });
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [BIN, 'serve', '--bundle', pkg, '--runs', join(tmp, 'runs'), ...args], {
        env: { ...process.env, XO_TRUST_MODE: 'development', ...env },
        encoding: 'utf8',
        timeout: 20_000,
      });
    const msg = (r: ReturnType<typeof run>) => `${r.stdout}${r.stderr}`;

    const noTls = run(['--tokens', file, '--host', '0.0.0.0', '--allow-remote', '--port', '0']);
    assert.notEqual(noTls.status, 0);
    assert.match(msg(noTls), /without TLS/);
    const legacy = run(['--host', '0.0.0.0', '--allow-remote', '--behind-tls-proxy', '--port', '0'], { XO_SERVER_TOKEN: 'y'.repeat(32) });
    assert.notEqual(legacy.status, 0);
    assert.match(msg(legacy), /legacy shared token/);
    const noRemote = run(['--tokens', file, '--host', '0.0.0.0', '--port', '0']);
    assert.match(msg(noRemote), /loopback unless allowRemote/);
    assert.match(msg(run(['--tokens', file, '--tls-cert', 'x.pem'])), /go together/);
    assert.match(msg(run(['--tokens', file, '--tls-ca', 'ca.pem'])), /need --tls-cert/);
    const noAuth = run(['--port', '0'], { XO_SERVER_TOKEN: '' });
    assert.notEqual(noAuth.status, 0);
    assert.match(msg(noAuth), /--tokens/);
    await writeFile(join(tmp, 'broken.json'), '{nope', { mode: 0o600 });
    assert.match(msg(run(['--tokens', join(tmp, 'broken.json'), '--port', '0'])), /not valid JSON/);
  });
});

test('xo serve over TLS with mutual TLS: a client without a certificate cannot connect; with certificate and token it is served', async () => {
  await withTempDir('xo-serve-tls-', async (tmp) => {
    const pkg = await bundle(tmp);
    const pki = makePki();
    for (const [name, data] of [
      ['server.crt', pki.serverCert],
      ['server.key', pki.serverKey],
      ['ca.crt', pki.ca],
    ] as const)
      await writeFile(join(tmp, name), data, { mode: 0o600 });
    const file = join(tmp, 'tokens.json');
    const tok = tokenOf((await token(['create', 'reader'], { tokens: file, scopes: 'read', ttl: '1d' })).text);
    const s = await serve([
      '--bundle',
      pkg,
      '--runs',
      join(tmp, 'runs'),
      '--tokens',
      file,
      '--tls-cert',
      join(tmp, 'server.crt'),
      '--tls-key',
      join(tmp, 'server.key'),
      '--tls-ca',
      join(tmp, 'ca.crt'),
      '--require-client-cert',
    ]);
    try {
      assert.match(s.stdout(), /listening on https:/);
      const https = (opts: { cert?: Buffer; key?: Buffer; token?: string }) =>
        new Promise<number>((resolve, reject) => {
          const r = request(
            {
              host: '127.0.0.1',
              port: s.port,
              path: '/v1/receipts',
              ca: pki.ca,
              servername: 'localhost',
              ...(opts.cert !== undefined ? { cert: opts.cert, key: opts.key } : {}),
              headers: opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {},
            },
            (res) => (res.resume(), resolve(res.statusCode ?? 0)),
          );
          r.on('error', reject);
          r.end();
        });
      await assert.rejects(https({ token: tok }), /./, 'served a client with no certificate');
      assert.equal(await https({ cert: pki.clientCert, key: pki.clientKey, token: tok }), 200);
      assert.equal(await https({ cert: pki.clientCert, key: pki.clientKey }), 401);
    } finally {
      s.stop();
    }
  });
});
