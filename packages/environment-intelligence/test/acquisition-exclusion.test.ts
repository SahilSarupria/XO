import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import { DiscoveryErrorCode, acquireSourceContent, discoverSource, type AuthorizationPort, type FilesystemScope } from '../src/index.js';
import { allowRoot, ctxFor, makeDeps, put, withSandbox } from './helpers.js';

const rw = (root: string): AuthorizationPort => allowRoot(root, ['filesystem.list', 'filesystem.read']);

async function setup(root: string, extra: Partial<FilesystemScope> = {}) {
  const deps = makeDeps();
  const scope: FilesystemScope = { kind: 'filesystem_root', root, ...extra };
  const ctx = ctxFor(rw(root), new MockClock('2026-10-10T00:00:00.000Z'));
  const run = await discoverSource(deps, { sourceType: 'local_filesystem', scope }, ctx);
  assert.ok(run.ok);
  if (!run.ok) throw new Error('discovery failed');
  const keys = run.value.evidence.filter((e) => e.kind === 'resource_inventory').map((e) => e.resourceKey);
  const acquire = (resourceKeys: readonly string[], auth: AuthorizationPort = rw(root), signal?: AbortSignal) =>
    acquireSourceContent(
      deps,
      { sourceId: run.value.record.source.sourceId, kind: 'document_content', resourceKeys, scope },
      ctxFor(auth, new MockClock('2026-10-10T00:00:00.000Z'), signal),
    );
  return { keys, acquire, run };
}

test('discovery excludes .ssh/notes.txt; a normal file stays discoverable and acquirable', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, '.ssh', 'notes.txt'), 'KEY-12345');
    await put(join(root, 'ok.txt'), 'INV-1042');
    const { keys, acquire } = await setup(root);
    assert.deepEqual(keys, ['ok.txt']);
    const a = await acquire(['ok.txt']);
    assert.ok(a.ok);
    if (a.ok) assert.equal(a.value.evidence.length, 1);
  });
});

test('direct acquisition under an excluded directory is rejected: no read, no evidence, counted', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, '.ssh', 'notes.txt'), 'KEY-12345');
    await put(join(root, 'ok.txt'), 'INV-1042');
    const { acquire } = await setup(root);
    const a = await acquire(['.ssh/notes.txt']);
    assert.ok(a.ok);
    if (!a.ok) return;
    assert.equal(a.value.evidence.length, 0);
    assert.equal(a.value.skipped.byReason['excluded_directory'], 1);
    // the rejected content must not leak anywhere in the outcome
    assert.ok(!JSON.stringify(a.value).includes('KEY-12345'));
    // a mixed request still serves the permitted file only
    const mixed = await acquire(['.ssh/notes.txt', 'ok.txt']);
    assert.ok(mixed.ok);
    if (mixed.ok) {
      assert.equal(mixed.value.evidence.length, 1);
      assert.equal(mixed.value.evidence[0]?.resourceKey, 'ok.txt');
    }
  });
});

test('an in-root symlink alias cannot bypass excluded-directory policy', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, '.ssh', 'notes.txt'), 'DO-NOT-READ-KEY-12345');
    await symlink(join(root, '.ssh'), join(root, 'alias'));
    const { acquire } = await setup(root);
    const result = await acquire(['alias/notes.txt']);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, DiscoveryErrorCode.SCOPE_VIOLATION);
    assert.ok(!JSON.stringify(result).includes('DO-NOT-READ-KEY-12345'));
  });
});

test('excluded NESTED directories are rejected at any depth, case-insensitively', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a', 'b', 'node_modules', 'x.txt'), 'AAA-1111');
    await put(join(root, 'a', '.GIT', 'y.txt'), 'BBB-2222');
    await put(join(root, 'a', '.aws', 'deep', 'z.txt'), 'CCC-3333');
    const { acquire } = await setup(root);
    const a = await acquire(['a/b/node_modules/x.txt', 'a/.GIT/y.txt', 'a/.aws/deep/z.txt']);
    assert.ok(a.ok);
    if (a.ok) {
      assert.equal(a.value.evidence.length, 0);
      assert.equal(a.value.skipped.byReason['excluded_directory'], 3);
    }
  });
});

test('extraExcludedNames is honored identically by discovery and acquisition (directories and files)', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'Private', 'p.txt'), 'PRV-1111');
    await put(join(root, 'keep.txt'), 'KEP-1111');
    await put(join(root, 'hidden-note.txt'), 'HID-1111');
    const extra = { extraExcludedNames: ['private', 'hidden-note.txt'] };
    const { keys, acquire } = await setup(root, extra);
    assert.deepEqual(keys, ['keep.txt']);
    const a = await acquire(['Private/p.txt', 'hidden-note.txt', 'keep.txt']);
    assert.ok(a.ok);
    if (a.ok) {
      assert.deepEqual(
        a.value.evidence.map((e) => e.resourceKey),
        ['keep.txt'],
      );
      assert.equal(a.value.skipped.byReason['excluded_directory'], 1);
      assert.equal(a.value.skipped.byReason['excluded_sensitive_name'], 1);
    }
  });
});

test('existing protections still hold alongside the exclusion check', async () => {
  await withSandbox(async ({ root, outside }) => {
    await put(join(root, 'ok.txt'), 'INV-1042');
    await put(join(root, 'img.png'), 'x');
    await put(join(outside, 'o.txt'), 'x');
    await put(join(root, 'big.txt'), 'INV-1099 ' + 'x'.repeat(2000));
    const { acquire } = await setup(root, { limits: { maxContentBytes: 100 } });
    for (const key of ['../outside/o.txt', '/etc/hostname', '.ssh/../../x.txt']) {
      const r = await acquire([key]);
      assert.equal(r.ok, false, key);
      if (!r.ok) assert.equal(r.error.code, DiscoveryErrorCode.SCOPE_VIOLATION);
    }
    const png = await acquire(['img.png']);
    assert.ok(png.ok);
    if (png.ok) assert.equal(png.value.skipped.byReason['content_type_not_allowed'], 1);
    const big = await acquire(['big.txt']);
    assert.ok(big.ok);
    if (big.ok) assert.equal(big.value.evidence[0]?.payload['truncated'], true);
    const ac = new AbortController();
    ac.abort();
    const cancelled = await acquire(['ok.txt'], rw(root), ac.signal);
    assert.equal(cancelled.ok, false);
    const denied = await acquire(['ok.txt'], allowRoot(root, ['filesystem.list']));
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, DiscoveryErrorCode.AUTHORIZATION_REQUIRED);
    // an excluded key does not bypass authorization either
    const deniedExcluded = await acquire(['.ssh/notes.txt'], allowRoot(root, ['filesystem.list']));
    assert.equal(deniedExcluded.ok, false);
  });
});
