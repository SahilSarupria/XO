import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode } from '@xo/errors';
import { FsIdentityBindingStore, computeBindingId } from '../src/auth/oidc/fs-binding-store.js';
import type { IdentityBinding } from '../src/auth/oidc/binding-store.interface.js';

const ISS = 'https://accounts.google.com';

function binding(sub: string, identityId = 'usr_a'): IdentityBinding {
  return {
    bindingId: computeBindingId(ISS, sub),
    issuer: ISS,
    subject: sub,
    identityId,
    principalKind: 'human',
    createdAt: new Date().toISOString(),
  };
}

async function withStore<T>(fn: (store: FsIdentityBindingStore, entryDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'xo-bind-cia-'));
  try {
    return await fn(new FsIdentityBindingStore(root), join(root, 'identity-bindings', 'by-subject'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const nameOf = (sub: string): string => `${computeBindingId(ISS, sub)}.json`;

test('createIfAbsent creates a readable active record and leaves no temp files', async () => {
  await withStore(async (store, dir) => {
    assert.ok((await store.createIfAbsent(binding('s1'))).ok);
    const found = await store.find(ISS, 's1');
    assert.ok(found.ok && found.value?.identityId === 'usr_a' && found.value.revokedAt === undefined);
    assert.deepEqual(await readdir(dir), [nameOf('s1')]);
  });
});

test('createIfAbsent refuses an existing active record and does not change it', async () => {
  await withStore(async (store) => {
    assert.ok((await store.create(binding('s2', 'operator-made'))).ok);
    const r = await store.createIfAbsent(binding('s2', 'someone-else'));
    assert.ok(!r.ok && r.error.code === ErrorCode.ALREADY_EXISTS);
    const found = await store.find(ISS, 's2');
    assert.ok(found.ok && found.value?.identityId === 'operator-made');
  });
});

test('createIfAbsent never recreates a revoked record', async () => {
  await withStore(async (store) => {
    assert.ok((await store.create(binding('s3'))).ok);
    assert.ok((await store.revoke(ISS, 's3')).ok);
    const r = await store.createIfAbsent(binding('s3', 'new-identity'));
    assert.ok(!r.ok && r.error.code === ErrorCode.ALREADY_EXISTS);
    const found = await store.find(ISS, 's3');
    assert.ok(found.ok && found.value?.revokedAt !== undefined && found.value.identityId === 'usr_a');
  });
});

test('createIfAbsent refuses a corrupt record, an oversized one and a symlink, byte for byte unchanged', async () => {
  await withStore(async (store, dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, nameOf('c1')), '{corrupt');
    await writeFile(join(dir, nameOf('c2')), 'x'.repeat(40_000));
    await symlink('/nonexistent-target', join(dir, nameOf('c3'))); // dangling symlink
    for (const sub of ['c1', 'c2', 'c3']) {
      const r = await store.createIfAbsent(binding(sub));
      assert.ok(!r.ok && r.error.code === ErrorCode.ALREADY_EXISTS, sub);
      const f = await store.find(ISS, sub);
      assert.ok(f.ok && f.value === undefined, `${sub} must still read as untrusted, not as a fresh record`);
    }
    assert.equal(await readFile(join(dir, nameOf('c1')), 'utf8'), '{corrupt');
    assert.equal((await readFile(join(dir, nameOf('c2')), 'utf8')).length, 40_000);
  });
});

test('createIfAbsent under heavy concurrency has exactly one winner, one intact record and no temp files', async () => {
  await withStore(async (store, dir) => {
    const results = await Promise.all(Array.from({ length: 32 }, (_, i) => store.createIfAbsent(binding('race', `usr_${i}`))));
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1);
    for (const r of results) if (!r.ok) assert.equal(r.error.code, ErrorCode.ALREADY_EXISTS);
    const found = await store.find(ISS, 'race');
    assert.ok(found.ok && found.value !== undefined && /^usr_\d+$/.test(found.value.identityId));
    assert.deepEqual(await readdir(dir), [nameOf('race')]);
  });
});

test('a revocation racing with creation can never be overwritten', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 20; i++) {
      const sub = `rev-${i}`;
      assert.ok((await store.createIfAbsent(binding(sub))).ok);
      // Revoke while many late self-sign-ups (which all started before the revocation landed) try to create.
      const [rev, ...late] = await Promise.all([
        store.revoke(ISS, sub),
        ...Array.from({ length: 8 }, () => store.createIfAbsent(binding(sub, 'usr_late'))),
      ]);
      assert.ok(rev.ok);
      assert.ok(late.every((r) => !r.ok));
      const found = await store.find(ISS, sub);
      assert.ok(found.ok && found.value?.revokedAt !== undefined, `${sub} must stay revoked`);
      assert.equal(found.value?.identityId, 'usr_a');
    }
  });
});
