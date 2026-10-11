/**
 * F4 - bounded directory enumeration. Discovery streams entries with opendir and never collects more than the
 * remaining global entry budget per directory (plus one probe entry that is counted but not retained). Only that
 * bounded set is sorted. A truncated listing is reported as partial with `limits.filesystemOrderUsed = true`:
 * the retained entries are the first ones in filesystem order, so WHICH entries were kept is not deterministic.
 * Note: the existing budget is global (`maxEntries`); there is no separate per-directory cap, so the per-directory
 * limit handed to the listing is the remaining global budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import { DiscoveryErrorCode, LocalFilesystemConnector, type FilesystemScope } from '../src/index.js';
import { NODE_FS_OPS, type FsOps } from '../src/filesystem/fd-walk.js';
import { allowRoot, ctxFor, put, withSandbox } from './helpers.js';

const BOTH = ['filesystem.list', 'filesystem.read'];
const scopeOf = (root: string, maxEntries?: number): FilesystemScope =>
  ({ kind: 'filesystem_root', root, ...(maxEntries !== undefined ? { limits: { maxEntries } } : {}) }) as FilesystemScope;
const linux = process.platform === 'linux';
const fdCount = (): number => readdirSync('/proc/self/fd').length;

type Listing = { limit: number; returned: number; truncated: boolean };
function spyOps(over: Partial<FsOps> = {}): { ops: FsOps; listings: Listing[]; unboundedReads: number } {
  const state = { listings: [] as Listing[], unboundedReads: 0 };
  const ops: FsOps = {
    ...NODE_FS_OPS,
    async readdir(p) {
      state.unboundedReads += 1;
      return NODE_FS_OPS.readdir(p);
    },
    async readdirLimited(p, limit) {
      const r = await NODE_FS_OPS.readdirLimited(p, limit);
      state.listings.push({ limit, returned: r.names.length, truncated: r.truncated });
      return r;
    },
    ...over,
  };
  return {
    ops,
    get listings() {
      return state.listings;
    },
    get unboundedReads() {
      return state.unboundedReads;
    },
  };
}

const run = (root: string, ops: FsOps, maxEntries?: number, signal?: AbortSignal) =>
  new LocalFilesystemConnector({ fsOps: ops }).discover(
    { sourceType: 'local_filesystem', scope: scopeOf(root, maxEntries) },
    ctxFor(allowRoot(root, BOTH), new MockClock(), signal),
  );
const keys = (r: Awaited<ReturnType<typeof run>>): string[] =>
  r.ok ? r.value.evidence.filter((e) => e.kind === 'resource_inventory').map((e) => e.resourceKey) : [];

async function fill(dir: string, n: number, prefix = 'f'): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i += 2000) {
    await Promise.all(
      Array.from({ length: Math.min(2000, n - i) }, (_, j) => writeFile(join(dir, `${prefix}${String(i + j).padStart(6, '0')}.txt`), '')),
    );
  }
}

test('F4 below the cap: lexical order retained, complete, no filesystem-order flag', { timeout: 20_000 }, async () => {
  await withSandbox(async ({ root }) => {
    for (const n of ['b.txt', 'a.txt', 'C.txt', 'a10.txt', 'a2.txt']) await put(join(root, n), 'x');
    await put(join(root, 'sub', 'z.txt'), 'x');
    const s = spyOps();
    const r = await run(root, s.ops);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(keys(r), ['C.txt', 'a.txt', 'a10.txt', 'a2.txt', 'b.txt', 'sub/z.txt']);
    assert.equal(r.value.status, 'complete');
    assert.equal(r.value.limits.filesystemOrderUsed, undefined);
    assert.equal(s.unboundedReads, 0, 'discovery never uses the unbounded readdir');
  });
});

test('F4 exactly at the cap is complete (probe finds nothing more)', { timeout: 20_000 }, async () => {
  await withSandbox(async ({ root }) => {
    await fill(root, 20);
    const r = await run(root, spyOps().ops, 20);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.status, 'complete');
    assert.equal(r.value.limits.entriesVisited, 20);
    assert.equal(r.value.limits.filesystemOrderUsed, undefined);
  });
});

test('F4 large directory, maxEntries 100: bounded collection, partial, flag set, output sorted', { timeout: 30_000 }, async () => {
  await withSandbox(async ({ root }) => {
    await fill(root, 3_000);
    const s = spyOps();
    const r = await run(root, s.ops, 100);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.status, 'partial');
    assert.deepEqual(r.value.limits.hit, ['max_entries']);
    assert.equal(r.value.limits.filesystemOrderUsed, true);
    assert.equal(r.value.limits.entriesVisited, 100);
    assert.ok(
      s.listings.every((l) => l.returned <= 100),
      `collected ${JSON.stringify(s.listings)}`,
    );
    assert.equal(s.listings[0]?.truncated, true);
    assert.equal(s.unboundedReads, 0);
    const got = keys(r);
    assert.equal(got.length, 100);
    assert.deepEqual(got, [...got].sort(), 'the bounded set is sorted');
  });
});

test('F4 global budget is shared across directories and each listing is limited to what remains', { timeout: 20_000 }, async () => {
  await withSandbox(async ({ root }) => {
    for (const d of ['a', 'b', 'c']) await fill(join(root, d), 30, d);
    const s = spyOps();
    const r = await run(root, s.ops, 50);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(r.value.limits.entriesVisited <= 50);
    assert.equal(r.value.limits.entriesVisited, 50);
    assert.equal(r.value.status, 'partial');
    assert.equal(r.value.limits.filesystemOrderUsed, true);
    // root lists 3 dirs (limit 50), then a (limit 47 -> all 30), then b (limit 17 -> truncated).
    assert.deepEqual(
      s.listings.map((l) => l.limit),
      [50, 47, 17],
    );
    assert.ok(s.listings.every((l) => l.returned <= l.limit));
  });
});

test('F4 STRESS: 50,000 entries with maxEntries 100 collects at most 100 names', { timeout: 120_000 }, async () => {
  await withSandbox(async ({ root }) => {
    await fill(root, 50_000);
    const s = spyOps();
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const rss0 = process.memoryUsage().rss;
    const t0 = Date.now();
    const r = await run(root, s.ops, 100);
    const boundedMs = Date.now() - t0;
    const rss1 = process.memoryUsage().rss;
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.status, 'partial');
    assert.equal(r.value.limits.filesystemOrderUsed, true);
    assert.equal(s.listings.length, 1);
    const l = s.listings[0]!;
    assert.ok(l.returned <= 100 && l.limit === 100, 'collection bounded by the cap, not by directory size');
    // Reference measurement only (logged, never asserted: RSS varies by host): what the old readdir().sort() holds.
    const t1 = Date.now();
    const all = (await readdir(root)).sort();
    const unboundedMs = Date.now() - t1;
    const rss2 = process.memoryUsage().rss;
    assert.equal(all.length, 50_000);
    console.log(
      `# F4 stress (50,000 entries, maxEntries=100): bounded collected=${l.returned} names, rssDelta=${((rss1 - rss0) / 1048576).toFixed(1)}MiB, ${boundedMs}ms; ` +
        `unbounded readdir+sort held ${all.length} names, rssDelta=${((rss2 - rss1) / 1048576).toFixed(1)}MiB, ${unboundedMs}ms`,
    );
  });
});

test('F4 cancellation during/after a listing keeps the existing partial-result behaviour', { timeout: 20_000 }, async () => {
  await withSandbox(async ({ root }) => {
    await fill(root, 50);
    const ac = new AbortController();
    const s = spyOps({
      async readdirLimited(p, limit) {
        const r = await NODE_FS_OPS.readdirLimited(p, limit);
        ac.abort();
        return r;
      },
    });
    const r = await run(root, s.ops, undefined, ac.signal);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.status, 'partial');
    assert.ok(r.value.limits.hit.includes('cancelled'));
    assert.ok(r.value.errors.some((e) => e.code === DiscoveryErrorCode.CANCELLED));
    assert.equal(r.value.limits.filesystemOrderUsed, undefined, 'not truncated by the budget');
    const pre = new AbortController();
    pre.abort();
    const early = await run(root, spyOps().ops, undefined, pre.signal);
    assert.ok(!early.ok && early.error.code === DiscoveryErrorCode.CANCELLED);
  });
});

test(
  'F4 enumeration errors: unreadable root fails closed; unreadable subdirectory is skipped and counted',
  { timeout: 20_000 },
  async () => {
    await withSandbox(async ({ root }) => {
      await put(join(root, 'ok.txt'), 'x');
      await put(join(root, 'bad', 'in.txt'), 'x');
      const before = linux ? fdCount() : 0;
      const failing = (match: (p: string) => boolean): Partial<FsOps> => ({
        async readdirLimited(p, limit) {
          if (match(p)) throw Object.assign(new Error('boom'), { code: 'EIO' });
          return NODE_FS_OPS.readdirLimited(p, limit);
        },
      });
      // Subdirectory: the F1 walk lists children through /proc/self/fd/<n>; the root is listed first, so fail the 2nd call.
      let n = 0;
      const sub = await run(
        root,
        spyOps({
          async readdirLimited(p, limit) {
            n += 1;
            if (n === 2) throw Object.assign(new Error('boom'), { code: 'EIO' });
            return NODE_FS_OPS.readdirLimited(p, limit);
          },
        }).ops,
      );
      assert.ok(sub.ok);
      if (!sub.ok) return;
      assert.equal(sub.value.skipped.byReason['unreadable_directory'], 1);
      assert.deepEqual(keys(sub), ['ok.txt']);
      const rootFail = await run(root, spyOps(failing(() => true)).ops);
      assert.ok(!rootFail.ok && rootFail.error.code === DiscoveryErrorCode.CONNECTION_FAILED);
      if (linux) assert.equal(fdCount(), before, 'no descriptor leaked on enumeration errors');
    });
  },
);

test('F4 readdirLimited unit: limit 0, exactly-limit, limit+1, and the directory handle is closed', { timeout: 20_000 }, async () => {
  await withSandbox(async ({ root }) => {
    await fill(root, 10);
    const before = linux ? fdCount() : 0;
    assert.deepEqual(await NODE_FS_OPS.readdirLimited(root, 0).then((r) => [r.names.length, r.truncated]), [0, true]);
    assert.deepEqual(await NODE_FS_OPS.readdirLimited(root, 10).then((r) => [r.names.length, r.truncated]), [10, false]);
    assert.deepEqual(await NODE_FS_OPS.readdirLimited(root, 9).then((r) => [r.names.length, r.truncated]), [9, true]);
    assert.deepEqual(await NODE_FS_OPS.readdirLimited(root, 11).then((r) => [r.names.length, r.truncated]), [10, false]);
    if (linux) assert.equal(fdCount(), before);
    await mkdir(join(root, 'empty'));
    assert.deepEqual(await NODE_FS_OPS.readdirLimited(join(root, 'empty'), 0).then((r) => [r.names.length, r.truncated]), [0, false]);
  });
});
