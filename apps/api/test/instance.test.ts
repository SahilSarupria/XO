// UW-17 — one instance: settings checked up front, one data directory, Studio and the API on one port, readiness and metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { readInstance, SettingsInvalidError } from '@xo/instance';
import { startInstance } from '../src/instance/start.js';
import { InstanceMetrics, metricsTokenMatches } from '../src/instance/metrics.js';
import { assertCodeExchangeInput } from '../src/auth/session/service.js';
import { publicRedirectUriFrom } from '../src/auth/session/config.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { FsApiKeyStore } from '../src/auth/fs-api-key-store.js';
import { LocalFsBlobStore } from '@xo/storage';

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
} as never;

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'xo-instance-api-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function studioBuild(root: string): Promise<string> {
  const dir = join(root, 'studio-dist');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html><head><title>XO Studio</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>',
  );
  await writeFile(join(dir, 'assets', 'index-abc.js'), 'console.log("studio")');
  await writeFile(join(root, 'outside.txt'), 'secret');
  return dir;
}

/** Sends the path exactly as written (fetch would normalise it first). */
function rawStatus(base: string, path: string): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function issueKey(apiKeysDir: string): Promise<string> {
  const key = generateApiKey();
  const r = await new FsApiKeyStore(new LocalFsBlobStore(apiKeysDir)).create({
    keyHash: hashApiKey(key),
    identityId: 'owner',
    principalKind: 'human',
    createdAt: new Date().toISOString(),
  });
  if (!r.ok) throw r.error;
  return key;
}

test('UW-17: the instance starts from one data directory, serves Studio at / and the API under /api on one port, and stops cleanly', async () => {
  await withRoot(async (root) => {
    const data = join(root, 'data');
    const env: NodeJS.ProcessEnv = {
      XO_DATA_DIR: data,
      XO_STUDIO_DIR: await studioBuild(root),
      XO_TRUST_MODE: 'development',
      XO_SCHEDULER: 'off',
      XO_OCR: 'off',
      XO_METRICS_TOKEN: 'scrape-token-123',
      XO_AUDIT_ANCHOR_DIR: join(root, 'anchors'),
    };
    const instance = await startInstance({ env, logger: silent, listen: { port: 0, host: '127.0.0.1' } });
    try {
      assert.equal(instance.opened.created, true);
      assert.equal(env['API_KEYS_DIR'], join(data, 'api-keys'), 'every part of the instance reads the same resolved settings');
      const meta = await readInstance(data);
      assert.equal(meta?.schemaVersion, 1);
      const key = await issueKey(env['API_KEYS_DIR']!);
      const get = (path: string, headers: Record<string, string> = {}) => fetch(`${instance.url}${path}`, { headers });

      const page = await get('/workspaces/ws_1/sources');
      assert.equal(page.status, 200, 'a Studio route gets the app');
      const html = await page.text();
      assert.match(html, /<script src="\/xo-config\.js"><\/script>\s*<\/head>/);
      assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'; script-src 'self'/);
      assert.equal(page.headers.get('x-frame-options'), 'DENY');
      assert.equal(await (await get('/xo-config.js')).text(), 'window.__XO_CONFIG__ = {"apiBaseUrl":"/api","devSignIn":true};\n');
      const asset = await get('/assets/index-abc.js');
      assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal((await get('/assets/missing.js')).status, 404, 'a missing asset is a 404, not the app');
      for (const path of ['/assets/../../outside.txt', '/assets/%2e%2e/%2e%2e/outside.txt'])
        assert.equal(await rawStatus(instance.url, path), 404);
      assert.equal(await rawStatus(instance.url, '/assets/..%2F..%2Foutside.txt'), 400, 'nothing outside the build is reachable');
      assert.equal((await fetch(`${instance.url}/workspaces`, { method: 'POST' })).status, 405, 'Studio paths take no writes');

      const unauth = await get('/api/workspaces');
      assert.equal(unauth.status, 401, 'the API is under /api, behind sign-in');
      const listed = await get('/api/workspaces', { authorization: `Bearer ${key}` });
      assert.equal(listed.status, 200, await listed.clone().text());
      assert.equal((await get('/health')).status, 200);

      const readyz = await get('/readyz');
      assert.equal(readyz.status, 200);
      assert.deepEqual(await readyz.json(), {
        status: 'ready',
        checks: [
          { name: 'storage', ok: true },
          { name: 'schema', ok: true },
          { name: 'instance-lock', ok: true },
          { name: 'scheduler', ok: true },
        ],
      });
      const ready = (await (await get('/ready', { authorization: `Bearer ${key}` })).json()) as {
        checks: { name: string; detail?: string }[];
      };
      assert.equal(ready.checks.find((c) => c.name === 'scheduler')?.detail, 'off on this instance', 'reasons only with a credential');

      assert.equal((await get('/metrics')).status, 401);
      assert.equal((await get('/metrics', { authorization: `Bearer ${key}` })).status, 401, 'an API key is not a metrics token');
      const metrics = await (await get('/metrics', { authorization: 'Bearer scrape-token-123' })).text();
      assert.match(metrics, new RegExp(`xo_build_info\\{version="0\\.1\\.0",instance="${meta!.instanceId}"\\} 1`));
      assert.match(metrics, /xo_http_requests_total\{method="GET",route="\/workspaces",status="2xx"\} 1/);
      assert.match(metrics, /xo_http_requests_total\{method="GET",route="studio",status="2xx"\}/);
      assert.doesNotMatch(metrics, /ws_1/, 'ids never become labels');

      await assert.rejects(
        startInstance({ env: { ...env }, logger: silent, listen: { port: 0, host: '127.0.0.1' } }),
        /this instance is in use/,
      );
    } finally {
      await instance.stop();
    }
    const again = await startInstance({ env: { ...env }, logger: silent, listen: { port: 0, host: '127.0.0.1' } });
    assert.equal(again.opened.created, false, 'the lock was released and the same instance reopens');
    await again.stop();
  });
});

test('UW-17: invalid settings stop start-up before anything is written, with every problem listed', async () => {
  await withRoot(async (root) => {
    const data = join(root, 'data');
    await assert.rejects(
      startInstance({ env: { XO_DATA_DIR: data, PORT: 'eighty', XO_OCR: 'cloud', XO_TRUST_MODE: 'development' }, logger: silent }),
      (e: unknown) => {
        assert.ok(e instanceof SettingsInvalidError);
        assert.deepEqual(e.problems.map((p) => p.name).sort(), ['PORT', 'XO_OCR']);
        return true;
      },
    );
    await assert.rejects(readFile(join(data, 'instance.json')), /ENOENT/);
  });
});

test('UW-17: a Studio build that is missing is a start-up error, and the lock is released', async () => {
  await withRoot(async (root) => {
    const env = { XO_DATA_DIR: join(root, 'data'), XO_STUDIO_DIR: join(root, 'nope'), XO_TRUST_MODE: 'development', XO_SCHEDULER: 'off' };
    await assert.rejects(
      startInstance({ env: { ...env }, logger: silent, listen: { port: 0, host: '127.0.0.1' } }),
      /has no index\.html; build Studio first/,
    );
    const ok = await startInstance({
      env: { ...env, XO_STUDIO_DIR: await studioBuild(root) },
      logger: silent,
      listen: { port: 0, host: '127.0.0.1' },
    });
    await ok.stop();
  });
});

test('UW-17: the public base URL adds exactly one sign-in return address; nothing that merely starts with it', () => {
  const cb = publicRedirectUriFrom({ XO_PUBLIC_BASE_URL: 'https://acme.xo.example/' });
  assert.equal(cb, 'https://acme.xo.example/auth/callback');
  const verifier = 'v'.repeat(43);
  assert.doesNotThrow(() => assertCodeExchangeInput('code', verifier, 'https://acme.xo.example/auth/callback', cb));
  assert.doesNotThrow(() => assertCodeExchangeInput('code', verifier, 'http://127.0.0.1:53123/callback', cb), 'loopback still works');
  assert.throws(() => assertCodeExchangeInput('code', verifier, 'https://acme.xo.example/auth/callback/../../evil', cb), /redirectUri/);
  assert.throws(() => assertCodeExchangeInput('code', verifier, 'https://acme.xo.example.evil.com/auth/callback', cb), /redirectUri/);
  assert.throws(
    () => assertCodeExchangeInput('code', verifier, 'https://acme.xo.example/auth/callback'),
    /redirectUri/,
    'only when configured',
  );
});

test('UW-17: metrics text format escapes labels; the scrape token is compared in constant time', () => {
  const m = new InstanceMetrics({ version: '1"2' });
  m.observeRequest('GET', '/a', 200, 0.02);
  m.observeRequest('GET', '/a', 503, 3);
  m.gauge('xo_queue_depth', 'Queued things.', () => 4);
  m.gauge('xo_unknown', 'Not known yet.', () => undefined);
  const text = m.render();
  assert.match(text, /xo_build_info\{version="1\\"2"\} 1/);
  assert.match(text, /xo_http_request_duration_seconds_bucket\{method="GET",route="\/a",le="0\.025"\} 1/);
  assert.match(text, /xo_http_request_duration_seconds_bucket\{method="GET",route="\/a",le="\+Inf"\} 2/);
  assert.match(text, /xo_queue_depth 4/);
  assert.doesNotMatch(text, /xo_unknown/);
  assert.equal(metricsTokenMatches('Bearer abc', 'abc'), true);
  assert.equal(metricsTokenMatches('Bearer abd', 'abc'), false);
  assert.equal(metricsTokenMatches(undefined, 'abc'), false);
});
