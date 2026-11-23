// UW-17 (ADR 0054): `xo deploy render|check` and `xo instance init-keys`, run as a user would: the built CLI as a child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/xo.js', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../../../deploy/cloud/instance.example.yaml', import.meta.url));

function xo(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, out }));
  });
}
const withDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-deploy-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
const walk = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { withFileTypes: true })).flatMap((e) => (e.isDirectory() ? [] : [join(dir, e.name)]));

test('UW-17: no secret value appears in any rendered file', async () => {
  await withDir(async (dir) => {
    const secrets = ['sk-test-SECRET-value-1', 'cred-SECRET-value-2'];
    const env = {
      ...process.env,
      XO_CREDENTIALS_KEY: secrets[0],
      ANTHROPIC_API_KEY: secrets[1],
      XO_APPROVAL_SIGNING_KEY: 'signing-SECRET-3',
    };
    for (const target of ['vm', 'kubernetes']) {
      const out = join(dir, target);
      const r = await xo(['deploy', 'render', '--config', EXAMPLE, '--target', target, '--out', out], env);
      assert.equal(r.code, 0, r.out);
      for (const f of await walk(out)) {
        const text = readFileSync(f, 'utf8');
        for (const s of [...secrets, 'signing-SECRET-3']) assert.ok(!text.includes(s), `${f} holds a secret`);
        assert.equal(statSync(f).mode & 0o077, 0, `${f} is owner-only`);
      }
      // The names are there; the values are not.
      assert.ok(r.out.includes('XO_CREDENTIALS_KEY'));
    }
  });
});

test('UW-17: render refuses a non-empty output directory unless forced', async () => {
  await withDir(async (dir) => {
    const env = { ...process.env };
    await mkdir(join(dir, 'bundle'));
    await writeFile(join(dir, 'bundle', 'keep.txt'), 'x');
    const refused = await xo(['deploy', 'render', '--config', EXAMPLE, '--target', 'vm', '--out', join(dir, 'bundle')], env);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is not empty/);
    assert.equal(await readFile(join(dir, 'bundle', 'keep.txt'), 'utf8'), 'x');
    const forced = await xo(['deploy', 'render', '--config', EXAMPLE, '--target', 'vm', '--out', join(dir, 'bundle'), '--force'], env);
    assert.equal(forced.code, 0, forced.out);
    assert.ok(existsSync(join(dir, 'bundle', 'cloud-init.yaml')));
    // A bad config lists its problems and writes nothing.
    const bad = join(dir, 'bad.yaml');
    await writeFile(bad, 'format: xo-instance/1\nname: x\n');
    const r = await xo(['deploy', 'check', '--config', bad], env);
    assert.equal(r.code, 1);
    assert.match(r.out, /problem\(s\)/);
  });
});

test('UW-17: init-keys creates missing keys once and never prints them', async () => {
  await withDir(async (dir) => {
    const env = { ...process.env, XO_HOME: join(dir, 'home'), XO_SECRETS_KEY_FILE: join(dir, 'keys', 'secrets.key') };
    delete env['XO_SECRETS_KEY'];
    const data = join(dir, 'data');
    const first = await xo(['instance', 'init-keys', '--data', data], env);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /secrets key: created/);
    assert.match(first.out, /approval signing key: created/);
    const keyText = readFileSync(join(dir, 'keys', 'secrets.key'), 'utf8').trim();
    assert.ok(!first.out.includes(keyText), 'the secrets key is never printed');
    assert.equal(statSync(join(dir, 'keys', 'secrets.key')).mode & 0o077, 0);
    const encrypted = await readFile(join(data, 'secrets.enc'), 'utf8');
    assert.ok(!encrypted.includes('PRIVATE'), 'the signing key is stored encrypted');
    const listed = await xo(['secrets', 'list', '--data', data], env);
    assert.match(listed.out, /XO_APPROVAL_SIGNING_KEY/);
    const before = readFileSync(join(data, 'secrets.enc'), 'utf8');
    const second = await xo(['instance', 'init-keys', '--data', data], env);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /secrets key: already present/);
    assert.match(second.out, /approval signing key: already present/);
    assert.equal(readFileSync(join(data, 'secrets.enc'), 'utf8'), before, 'a second run changes nothing');
    assert.equal(readFileSync(join(dir, 'keys', 'secrets.key'), 'utf8').trim(), keyText);
  });
});
