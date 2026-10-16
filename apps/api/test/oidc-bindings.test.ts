import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode } from '@xo/errors';
import { withTempDir } from './test-helpers.js';
import { FsIdentityBindingStore, computeBindingId } from '../src/auth/oidc/fs-binding-store.js';
import type { IdentityBinding } from '../src/auth/oidc/binding-store.interface.js';

const run = promisify(execFile);
const ISS = 'https://idp.example';
const recordsDir = (root: string): string => join(root, 'identity-bindings', 'by-subject');

function binding(subject: string, identityId = 'alice', issuer = ISS): IdentityBinding {
  return {
    bindingId: computeBindingId(issuer, subject),
    issuer,
    subject,
    identityId,
    principalKind: 'human',
    createdAt: new Date().toISOString(),
  };
}

test('bindings: create, find, revoke and list round-trip; the pair is exact; duplicates and re-binding behave as documented', async () => {
  await withTempDir('xo-bind-', async (root) => {
    const store = new FsIdentityBindingStore(root);
    assert.ok((await store.create(binding('s1'))).ok);
    const dup = await store.create(binding('s1', 'mallory'));
    assert.ok(!dup.ok && dup.error.code === ErrorCode.ALREADY_EXISTS, 'an active binding cannot be overwritten');

    const found = await store.find(ISS, 's1');
    assert.ok(found.ok && found.value?.identityId === 'alice');
    // Exact pair: another subject, a different issuer, a trailing slash or a case change are all different identities.
    for (const [iss, sub] of [
      [ISS, 'S1'],
      [ISS, 's1 '],
      [`${ISS}/`, 's1'],
      ['https://other.example', 's1'],
    ] as const) {
      const miss = await store.find(iss, sub);
      assert.ok(miss.ok && miss.value === undefined, `${iss} ${sub}`);
    }

    const revoked = await store.revoke(ISS, 's1');
    assert.ok(revoked.ok && !revoked.value.alreadyRevoked);
    assert.ok((await store.revoke(ISS, 's1')).ok, 'idempotent');
    const missing = await store.revoke(ISS, 'never-bound');
    assert.ok(!missing.ok);

    // An operator can bind a revoked pair again, explicitly.
    assert.ok((await store.create(binding('s1', 'bob'))).ok);
    const again = await store.find(ISS, 's1');
    assert.ok(again.ok && again.value?.identityId === 'bob' && again.value.revokedAt === undefined);

    const listed = await store.list();
    assert.ok(listed.ok && listed.value.length === 1);
  });
});

test('bindings: files are private (0600/0700), writes leave no temp files, and a binding never reads as torn while it is rewritten', async () => {
  await withTempDir('xo-bind-', async (root) => {
    const store = new FsIdentityBindingStore(root);
    assert.ok((await store.create(binding('s1'))).ok);
    const dir = recordsDir(root);
    const [name] = await readdir(dir);
    assert.ok(name !== undefined);
    assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);

    // A reader hammering the record while it is rewritten must always see a whole record, never an absent or partial one.
    let stop = false;
    let torn = 0;
    let reads = 0;
    const reader = (async (): Promise<void> => {
      while (!stop) {
        const r = await store.find(ISS, 's1');
        reads++;
        if (!r.ok || r.value === undefined) torn++;
      }
    })();
    for (let i = 0; i < 150; i++) {
      assert.ok((await store.revoke(ISS, 's1')).ok);
      assert.ok((await store.create(binding('s1', `id-${i}`))).ok);
    }
    stop = true;
    await reader;
    assert.ok(reads > 50, 'the reader really ran');
    assert.equal(torn, 0, 'no torn or missing reads during rewrites');
    assert.deepEqual(
      (await readdir(dir)).filter((n) => !/^[0-9a-f]{64}\.json$/.test(n)),
      [],
      'no leftover temp files',
    );
  });
});

test('bindings: corrupt, oversize, swapped, symlinked and non-regular records are treated as unbound, and never listed', async () => {
  await withTempDir('xo-bind-', async (root) => {
    await withTempDir('xo-bind-outside-', async (outside) => {
      const store = new FsIdentityBindingStore(root);
      const dir = recordsDir(root);
      await mkdir(dir, { recursive: true });
      const file = (sub: string): string => join(dir, `${computeBindingId(ISS, sub)}.json`);

      await writeFile(file('corrupt'), '{not json');
      await writeFile(file('oversize'), JSON.stringify({ ...binding('oversize'), pad: 'x'.repeat(40_000) }));
      await writeFile(file('wrong-id'), JSON.stringify({ ...binding('wrong-id'), bindingId: 'f'.repeat(64) }));
      await writeFile(file('null-revoked'), JSON.stringify({ ...binding('null-revoked'), revokedAt: null }));

      // A valid record for another subject copied over this subject's file name.
      assert.ok((await store.create(binding('victim', 'victim-id'))).ok);
      await writeFile(file('swapped'), await readFile(file('victim')));

      // A symlink to an otherwise valid record outside the directory.
      const external = join(outside, 'record.json');
      await writeFile(external, JSON.stringify(binding('linked', 'attacker-id')));
      await symlink(external, file('linked'));

      // A directory where a record should be.
      await mkdir(file('dir'));

      for (const sub of ['corrupt', 'oversize', 'wrong-id', 'swapped', 'linked', 'dir']) {
        const r = await store.find(ISS, sub);
        assert.ok(r.ok && r.value === undefined, sub);
      }
      // A parseable record with a null revokedAt is not "active": the middleware refuses anything but undefined.
      const nul = await store.find(ISS, 'null-revoked');
      assert.ok(nul.ok && nul.value?.revokedAt !== undefined);

      const listed = await store.list();
      assert.ok(listed.ok);
      assert.deepEqual(listed.value.map((b) => b.subject).sort(), ['null-revoked', 'victim']);
      // Nothing outside the directory was touched.
      assert.equal(JSON.parse(await readFile(external, 'utf8')).identityId, 'attacker-id');
    });
  });
});

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', 'scripts/manage-oidc-bindings.ts', ...args], {
      env: { ...process.env, XO_API_OIDC_BINDINGS_DIR: '' },
    });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

test('bindings CLI: bind, list, revoke work; malformed arguments fail without writing anything', async () => {
  await withTempDir('xo-bind-cli-', async (dir) => {
    const ok = await cli([
      'bind',
      '--issuer',
      ISS,
      '--subject',
      'u-1',
      '--identity',
      'alice',
      '--kind',
      'human',
      '--org',
      'acme',
      '--dir',
      dir,
    ]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /grants no permission/);

    const list = await cli(['list', '--dir', dir]);
    assert.match(list.out, /active\s+https:\/\/idp\.example\s+u-1\s+->\s+human:alice\s+org=acme/);

    const bad: string[][] = [
      ['bind', '--issuer', 'http://idp.example', '--subject', 'u-2', '--identity', 'x', '--kind', 'human'], // insecure issuer
      ['bind', '--issuer', 'not a url', '--subject', 'u-2', '--identity', 'x', '--kind', 'human'],
      ['bind', '--issuer', ISS, '--subject', '', '--identity', 'x', '--kind', 'human'], // empty subject
      ['bind', '--issuer', ISS, '--subject', 'a\u001b[31mb', '--identity', 'x', '--kind', 'human'], // control characters
      ['bind', '--issuer', ISS, '--subject', 'x'.repeat(256), '--identity', 'x', '--kind', 'human'], // longer than a verified subject can be
      ['bind', '--issuer', ISS, '--subject', 'u-2', '--identity', 'x', '--kind', 'root'], // unknown kind
      ['bind', '--issuer', ISS, '--subject', 'u-2', '--kind', 'human'], // missing identity
      ['bind', '--issuer', ISS, '--subject', 'u-2', '--identity', 'x', '--kind'], // flag without value
      ['bind', 'positional'],
      ['frobnicate'],
    ];
    for (const args of bad) {
      const r = await cli([...args, '--dir', dir]);
      assert.notEqual(r.code, 0, args.join(' '));
    }
    const after = await cli(['list', '--dir', dir]);
    assert.equal(after.out.trim().split('\n').length, 1, 'only the one valid binding exists');

    const dup = await cli(['bind', '--issuer', ISS, '--subject', 'u-1', '--identity', 'other', '--kind', 'human', '--dir', dir]);
    assert.notEqual(dup.code, 0);

    const rev = await cli(['revoke', '--issuer', ISS, '--subject', 'u-1', '--dir', dir]);
    assert.equal(rev.code, 0, rev.out);
    assert.match((await cli(['list', '--dir', dir])).out, /^revoked/);
    assert.notEqual((await cli(['revoke', '--issuer', ISS, '--subject', 'nobody', '--dir', dir])).code, 0);
  });
});
