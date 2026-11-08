import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackageTrustPolicy, packBundle, unpackArchive } from '@xo/package-sdk';
import { resolveForHost } from '@xo/server';
import { CommandRegistry } from '../src/command-registry.js';
import { registerCommands } from '../src/commands/flow/index.js';
import { loadWorkflowBundle } from '../src/commands/flow/bundle.js';
import { createCommand } from '../src/commands/compiler/create.js';
import { withTempDir } from './helpers.js';

const LOAN = fileURLToPath(new URL('../../../packages/compiler/test/fixtures/loan-desk-policy.md', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/xo.js', import.meta.url));
const DEV = PackageTrustPolicy.development();

async function makePackage(tmp: string, name = 'pkg.xo'): Promise<string> {
  const out = join(tmp, name);
  const res = await createCommand({ sources: [LOAN], name: 'desk', version: '1.0.0', out, sign: true });
  assert.equal(res.exitCode, 0, res.lines.join('\n'));
  return out;
}

async function flow(positionals: string[], flags: Record<string, string | boolean>): Promise<{ code: number; text: string }> {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const chunks: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => (chunks.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => (chunks.push(String(c)), true)) as typeof process.stderr.write;
  const prev = process.env['XO_TRUST_MODE'];
  process.env['XO_TRUST_MODE'] = 'development';
  try {
    const code = await registry.get('flow')!.run({ positionals, flags } as never);
    return { code: Number(code), text: chunks.join('') };
  } finally {
    process.stdout.write = real;
    process.stderr.write = realErr;
    if (prev === undefined) delete process.env['XO_TRUST_MODE'];
    else process.env['XO_TRUST_MODE'] = prev;
  }
}

test('loads workflows and trees from a verified package; development mode is announced, never dressed up as trust', async () => {
  await withTempDir('xo-fb-', async (tmp) => {
    const out = await makePackage(tmp);
    const r = await loadWorkflowBundle(out, DEV);
    assert.ok(r.ok, r.ok ? '' : r.error);
    assert.equal(r.value.component.workflows.length, 2);
    assert.equal(r.value.trees.length, 1);
    assert.match(r.value.trust, /^unverified \[mode=development\]/);
    assert.ok(r.value.warnings.length > 0 && /TRUST IS DISABLED/.test(r.value.warnings[0]!));
    // a directory holding exactly one package works too
    const dir = join(tmp, 'release');
    await mkdir(dir);
    await writeFile(join(dir, 'desk-1.0.0.xo'), await readFile(out));
    assert.ok((await loadWorkflowBundle(dir, DEV)).ok);
  });
});

test('FAILS CLOSED: no trust policy configured, an enforcing policy that does not trust the signer, a tampered package, and bad paths', async () => {
  await withTempDir('xo-fb-bad-', async (tmp) => {
    const out = await makePackage(tmp);

    // 1. nothing configured: not development mode by omission
    const prev = { mode: process.env['XO_TRUST_MODE'], file: process.env['XO_PACKAGE_TRUST_POLICY'] };
    delete process.env['XO_TRUST_MODE'];
    delete process.env['XO_PACKAGE_TRUST_POLICY'];
    try {
      const none = await loadWorkflowBundle(out);
      assert.equal(none.ok, false);
      assert.match((none as { error: string }).error, /trust/i);
    } finally {
      if (prev.mode !== undefined) process.env['XO_TRUST_MODE'] = prev.mode;
      if (prev.file !== undefined) process.env['XO_PACKAGE_TRUST_POLICY'] = prev.file;
    }

    // 2. an enforcing policy that trusts nobody: a signed package is still refused
    const enforcing = PackageTrustPolicy.create({
      mode: 'enforce',
      requireSignature: true,
      requiredRoles: ['creator'],
      bindPublisher: true,
      keys: [],
    });
    assert.ok(enforcing.ok);
    const untrusted = await loadWorkflowBundle(out, enforcing.value);
    assert.equal(untrusted.ok, false);
    assert.match((untrusted as { error: string }).error, /SIGNER_UNTRUSTED|not trusted/);

    // 3. a tampered package: change the workflows component, keep the manifest
    const un = await unpackArchive(new Uint8Array(await readFile(out)));
    assert.ok(un.ok);
    const tampered = {
      ...un.value,
      components: un.value.components.map((c) =>
        c.path === 'workflows/workflows.json'
          ? { ...c, data: new TextEncoder().encode(Buffer.from(c.data).toString('utf8').replace('decisions/', 'elsewhere/')) }
          : c,
      ),
    };
    await writeFile(join(tmp, 'tampered.xo'), await packBundle(tampered));
    const t = await loadWorkflowBundle(join(tmp, 'tampered.xo'), DEV);
    assert.equal(t.ok, false);
    assert.match((t as { error: string }).error, /HASH_MISMATCH|MERKLE|failed validation/);

    // 4. paths
    assert.match(((await loadWorkflowBundle(join(tmp, 'nope.xo'), DEV)) as { error: string }).error, /no such file/);
    await mkdir(join(tmp, 'empty'));
    assert.match(((await loadWorkflowBundle(join(tmp, 'empty'), DEV)) as { error: string }).error, /exactly one \.xo/);
    await mkdir(join(tmp, 'two'));
    await writeFile(join(tmp, 'two', 'a.xo'), await readFile(out));
    await writeFile(join(tmp, 'two', 'b.xo'), await readFile(out));
    assert.match(((await loadWorkflowBundle(join(tmp, 'two'), DEV)) as { error: string }).error, /exactly one \.xo/);
    await writeFile(join(tmp, 'garbage.xo'), 'not an archive');
    assert.equal((await loadWorkflowBundle(join(tmp, 'garbage.xo'), DEV)).ok, false);
  });
});

test('a package without workflows says how to get some, rather than failing obscurely', async () => {
  await withTempDir('xo-fb-none-', async (tmp) => {
    const out = join(tmp, 'plain.xo');
    const res = await createCommand({ sources: [LOAN], name: 'desk', version: '1.0.0', out, sign: true, noWorkflows: true });
    assert.equal(res.exitCode, 0);
    const r = await loadWorkflowBundle(out, DEV);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /no workflows component/);
  });
});

test('xo flow resolve answers exactly what /v1/loader/resolve answers (one implementation), and prints the degradation reasons', async () => {
  await withTempDir('xo-fb-resolve-', async (tmp) => {
    const out = await makePackage(tmp);
    const un = await unpackArchive(new Uint8Array(await readFile(out)));
    assert.ok(un.ok);
    for (const [family, caps] of [
      ['claude', 'chat,tool_use'],
      ['claude', 'chat'],
      ['nobody_knows', 'chat'],
      ['claude', ''],
    ] as const) {
      const r = await flow(['resolve'], { bundle: out, family, capabilities: caps, json: true });
      assert.equal(r.code, 0);
      const cli = JSON.parse(r.text.slice(r.text.indexOf('{'))) as Record<string, unknown>;
      const direct = resolveForHost(un.value, { family, capabilities: caps === '' ? [] : caps.split(',') });
      assert.deepEqual(
        { level: cli['level'], consumed: cli['consumed'], skipped: cli['skipped'], workflows: cli['workflows'] },
        JSON.parse(
          JSON.stringify({ level: direct.level, consumed: direct.consumed, skipped: direct.skipped, workflows: direct.workflows }),
        ),
      );
    }
    const text = await flow(['resolve'], { bundle: out, family: 'claude', capabilities: 'chat' });
    assert.match(text.text, /reaches L[0-3]/);
    assert.match(text.text, /skips decision_trees: host lacks tool_use/);
    assert.equal((await flow(['resolve'], { bundle: out })).code, 1, 'family is required');
  });
});

test("xo flow run --bundle runs the package's own workflow with no loose files; mixing --bundle with loose files is refused", async () => {
  await withTempDir('xo-fb-run-', async (tmp) => {
    const out = await makePackage(tmp);
    const policy = join(tmp, 'policy.json');
    await writeFile(
      policy,
      JSON.stringify({
        connectors: { decision_records: { grant: ['write_record'] } },
        bindings: { decision_records: { roots: { records: join(tmp, 'records') } } },
      }),
    );
    const un = await unpackArchive(new Uint8Array(await readFile(out)));
    assert.ok(un.ok);
    const wfId = (
      JSON.parse(Buffer.from(un.value.components.find((c) => c.path === 'workflows/workflows.json')!.data).toString('utf8')) as {
        workflows: { id: string }[];
      }
    ).workflows.find((w) => w.id.endsWith('_structured'))!.id;
    const r = await flow(['run'], {
      bundle: out,
      workflow: wfId,
      runs: join(tmp, 'runs'),
      policy,
      input: JSON.stringify({ case_id: 'B-1', library_card: true, borrower_with_3_or_more_overdue: false, loan_usd: 100 }),
    });
    assert.equal(r.code, 0, `code ${r.code}: ${r.text}`);
    assert.match(r.text, /package: desk@1\.0\.0 — trust: unverified \[mode=development\]/);
    assert.match(r.text, /"decision": "approve"/);
    assert.equal(
      await readFile(join(tmp, 'records', 'decisions', 'approve', 'B-1.json'), 'utf8'),
      'decision=approve;reason_code=APPROVED;amount=0;case_id=B-1',
    );

    const mixed = await flow(['run', join(tmp, 'x.json')], { bundle: out, workflow: wfId, runs: join(tmp, 'runs2'), input: '{}' });
    assert.equal(mixed.code, 1);
    assert.match(mixed.text, /do not pass both/);
  });
});

test('xo serve --bundle starts from the verified package and answers /v1/loader/resolve and /v1/receipts from it (real process, real socket)', async () => {
  await withTempDir('xo-fb-serve-', async (tmp) => {
    const out = await makePackage(tmp);
    const token = 'x'.repeat(32);
    const child = spawn(process.execPath, [BIN, 'serve', '--bundle', out, '--runs', join(tmp, 'runs'), '--port', '0'], {
      env: { ...process.env, XO_SERVER_TOKEN: token, XO_TRUST_MODE: 'development' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`server did not start: ${stdout} ${stderr}`)), 20_000);
        const poll = setInterval(() => {
          const m = /listening on http:\/\/[^:]+:(\d+)/.exec(stdout);
          if (m !== null) {
            clearTimeout(t);
            clearInterval(poll);
            resolve(Number(m[1]));
          }
        }, 50);
        child.on('exit', () => {
          clearTimeout(t);
          clearInterval(poll);
          reject(new Error(`server exited: ${stdout} ${stderr}`));
        });
      });
      assert.match(stdout, /package: desk@1\.0\.0 — trust: unverified \[mode=development\]/);
      const call = (path: string, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
        });
      const res = await call('/v1/loader/resolve', {
        method: 'POST',
        body: JSON.stringify({ host: { family: 'claude', capabilities: ['chat'] } }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { level: string; skipped: { kind: string }[] };
      assert.ok(body.skipped.some((s) => s.kind === 'decision_trees'));
      const rec = (await (await call('/v1/receipts')).json()) as { receipts: unknown[] };
      assert.equal(rec.receipts.length, 1, 'the resolve was not recorded');
      assert.equal((await fetch(`http://127.0.0.1:${port}/v1/receipts`)).status, 401, 'no token must not work');
    } finally {
      child.kill('SIGINT');
    }
  });
});
