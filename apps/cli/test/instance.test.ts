// UW-17 — `xo up`, `xo instance ...`, `xo secrets ...` and `xo config check`, run as a user would: the built CLI as a child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/xo.js', import.meta.url));

interface Ran {
  readonly code: number;
  readonly out: string;
}

function xo(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, out }));
    child.stdin.end(stdin ?? '');
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a !== null && typeof a !== 'string' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

async function withHome<T>(fn: (home: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'xo-cli-instance-'));
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], XO_HOME: join(home, 'xo-home'), XO_OCR: 'off', XO_SCHEDULER: 'off' };
  try {
    return await fn(home, env);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('xo instance: create, status, secrets, config check, backup, verify, restore, and delete with a verified receipt', async () => {
  await withHome(async (home, env) => {
    const data = join(home, 'data');
    const created = await xo(['instance', 'create', '--data', data], env);
    assert.equal(created.code, 0, created.out);
    const id = /created (xoi_[0-9a-f]{32})/.exec(created.out)?.[1];
    assert.ok(id !== undefined, created.out);
    assert.equal((await xo(['instance', 'create', '--data', data], env)).code, 1, 'never created twice');

    const status = await xo(['instance', 'status', '--data', data, '--json'], env);
    assert.equal(status.code, 0, status.out);
    const s = JSON.parse(status.out) as { state: string; schemaVersion: number; pendingMigrations: number[] };
    assert.deepEqual([s.state, s.schemaVersion, s.pendingMigrations], ['stopped', 1, []]);

    assert.equal((await xo(['secrets', 'set', 'ANTHROPIC_API_KEY', '--data', data], env, 'sk-ant-secret-value\n')).code, 0);
    const bad = await xo(['secrets', 'set', 'PORT', '--data', data], env, '4000\n');
    assert.equal(bad.code, 1);
    assert.match(bad.out, /not a secret setting/);
    const listed = await xo(['secrets', 'list', '--data', data], env);
    assert.equal(listed.out.trim(), 'ANTHROPIC_API_KEY');
    assert.ok(!(await readFile(join(data, 'secrets.enc'), 'utf8')).includes('sk-ant-secret-value'));

    await writeFile(join(data, 'xo.env'), 'XO_OCR_WORKER=3\n');
    const check = await xo(['config', 'check', '--data', data, '--json'], env);
    assert.equal(check.code, 0, check.out);
    const c = JSON.parse(check.out) as {
      settings: { name: string; value: string; source: string }[];
      warnings: { name: string; message: string }[];
    };
    assert.deepEqual(
      c.settings.find((x) => x.name === 'ANTHROPIC_API_KEY'),
      { name: 'ANTHROPIC_API_KEY', group: 'models', value: '(set, hidden)', source: 'secrets' },
    );
    assert.match(c.warnings.find((w) => w.name === 'XO_OCR_WORKER')!.message, /did you mean XO_OCR_WORKERS/);
    assert.ok(!check.out.includes('sk-ant-secret-value'));
    const broken = await xo(['config', 'check', '--data', data], { ...env, PORT: 'eighty' });
    assert.equal(broken.code, 1);
    assert.match(broken.out, /✘ PORT must be a whole number from 1 to 65535 \(got "eighty"\)/);

    const archive = join(home, 'b.tar.gz');
    const b = await xo(['instance', 'backup', '--data', data, '--out', archive], env);
    assert.equal(b.code, 0, b.out);
    assert.match(b.out, /The secrets key is not in the backup/);
    assert.match((await xo(['instance', 'verify-backup', archive], env)).out, new RegExp(`^ok: ${id}, schema 1`));
    const restored = join(home, 'restored');
    const r = await xo(['instance', 'restore', archive, '--data', restored], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`restored ${id} into`));

    assert.equal((await xo(['instance', 'delete', '--data', data], env)).code, 1, 'never without confirmation');
    assert.match((await xo(['instance', 'delete', '--data', data, '--confirm', 'xoi_nope'], env)).out, /does not match this instance/);
    const receiptFile = join(home, 'receipt.json');
    const del = await xo(['instance', 'delete', '--data', data, '--confirm', id, '--receipt', receiptFile], env);
    assert.equal(del.code, 0, del.out);
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as {
      verified: boolean;
      paths: { role: string; absentAfter: boolean }[];
    };
    assert.equal(receipt.verified, true);
    assert.deepEqual(
      receipt.paths.map((p) => p.role),
      ['data directory', 'secrets key', 'owner access key', 'audit anchors'],
    );
    assert.equal(existsSync(data), false);
    assert.equal(existsSync(join(env['XO_HOME']!, 'keys', `${id}.key`)), false, 'the key went with it');
  });
});

test(
  'xo up: a complete local instance on one port; locked while it runs; a live backup works; Ctrl+C stops it cleanly',
  { timeout: 120_000 },
  async () => {
    await withHome(async (home, env) => {
      const data = join(home, 'data');
      const studio = join(home, 'studio');
      await mkdir(join(studio, 'assets'), { recursive: true });
      await writeFile(join(studio, 'index.html'), '<!doctype html><html><head></head><body>studio</body></html>');
      const port = await freePort();
      const child: ChildProcess = spawn(process.execPath, [BIN, 'up', '--data', data, '--port', String(port), '--studio-dir', studio], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
      try {
        for (let i = 0; i < 300 && !out.includes('XO is running') && child.exitCode === null; i++)
          await new Promise((r) => setTimeout(r, 100));
        assert.match(out, /XO is running \(new instance\): xoi_/, out);
        assert.match(out, new RegExp(`Open    http://127\\.0\\.0\\.1:${port}\\n`));
        const key = /(xoak_[A-Za-z0-9_-]+)/.exec(out)?.[1];
        assert.ok(key !== undefined, 'the owner access key is shown on first start');
        const base = `http://127.0.0.1:${port}`;
        assert.equal((await fetch(`${base}/readyz`)).status, 200);
        assert.match(await (await fetch(`${base}/`)).text(), /studio/);
        assert.equal((await fetch(`${base}/api/workspaces`, { headers: { authorization: `Bearer ${key}` } })).status, 200);

        const st = JSON.parse((await xo(['instance', 'status', '--data', data, '--json'], env)).out) as { state: string };
        assert.match(st.state, /^running \(instance, process \d+/);
        const held = await xo(['instance', 'backup', '--data', data, '--out', join(home, 'x.tar.gz')], env);
        assert.equal(held.code, 1);
        assert.match(held.out, /this instance is in use \(instance/);
        assert.equal((await xo(['instance', 'backup', '--data', data, '--out', join(home, 'live.tar.gz'), '--live'], env)).code, 0);
        const second = await xo(['up', '--data', data, '--port', String(await freePort()), '--no-studio'], env);
        assert.equal(second.code, 1);
        assert.match(second.out, /this instance is in use/);
      } finally {
        child.kill('SIGINT');
        await new Promise((r) => (child.exitCode !== null ? r(undefined) : child.once('exit', r)));
      }
      assert.equal(child.exitCode, 0, out);
      assert.equal(JSON.parse((await xo(['instance', 'status', '--data', data, '--json'], env)).out).state, 'stopped');
      const again = await xo(['up', '--data', data, '--studio-dir', join(home, 'missing')], env);
      assert.equal(again.code, 1);
      assert.match(again.out, /Studio is not built at .*missing\. Build it with: npm run build -w @xo\/studio/);
    });
  },
);

test(
  'xo instance access-key issues a sign-in key for an instance not started by xo up; the smoke test passes against the running instance',
  { timeout: 120_000 },
  async () => {
    await withHome(async (home, env) => {
      const data = join(home, 'data');
      assert.equal((await xo(['instance', 'create', '--data', data], env)).code, 0);
      const issued = await xo(['instance', 'access-key', '--data', data, '--identity', 'ops', '--days', '7'], env);
      assert.equal(issued.code, 0, issued.out);
      const key = /(xoak_[A-Za-z0-9_-]+)/.exec(issued.out)?.[1];
      assert.ok(key !== undefined);
      const port = await freePort();
      const child = spawn(process.execPath, [BIN, 'up', '--data', data, '--port', String(port), '--no-studio'], {
        env: { ...env, XO_METRICS_TOKEN: 'm-token' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      try {
        for (let i = 0; i < 300 && !out.includes('XO is running') && child.exitCode === null; i++)
          await new Promise((r) => setTimeout(r, 100));
        assert.match(out, /XO is running/, out);
        const smoke = await new Promise<Ran>((resolve) => {
          const s = spawn(
            process.execPath,
            [
              fileURLToPath(new URL('../../../scripts/smoke-instance.mjs', import.meta.url)),
              '--url',
              `http://127.0.0.1:${port}`,
              '--key',
              key,
              '--metrics-token',
              'm-token',
            ],
            { env },
          );
          let o = '';
          s.stdout.on('data', (d: Buffer) => (o += d.toString()));
          s.stderr.on('data', (d: Buffer) => (o += d.toString()));
          s.on('exit', (code) => resolve({ code: code ?? -1, out: o }));
        });
        assert.equal(smoke.code, 0, smoke.out);
        assert.match(smoke.out, /✔ the emailed certificate was opened as its own source/);
        assert.match(smoke.out, /✔ it was recognised as a certificate/);
        assert.match(smoke.out, /smoke test passed/);
      } finally {
        child.kill('SIGTERM');
        await new Promise((r) => (child.exitCode !== null ? r(undefined) : child.once('exit', r)));
      }
    });
  },
);
