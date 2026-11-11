/**
 * F3 - safe handling of special files and acquisition cancellation.
 *
 * Every test is time-bounded (node:test `timeout` plus an explicit race) so a regression that blocks on a FIFO or
 * ignores an abort fails the test instead of hanging the suite.
 *
 * PLATFORM: these tests need Linux (the F1 anchored traversal is Linux-only and fails closed elsewhere) and `mkfifo`.
 * Real device files cannot be created without privileges (`mknod`); the real-device test runs only when the sandbox
 * allows it and is otherwise skipped with that reason. The simulated-device tests exercise the same validation
 * logic through the FsOps seam and are labelled SIMULATED - they do not claim a device was opened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { constants, readdirSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import { DiscoveryErrorCode, LocalFilesystemConnector, type FilesystemScope } from '../src/index.js';
import { NODE_FS_OPS, type FsOps } from '../src/filesystem/fd-walk.js';
import { allowRoot, ctxFor, put, withSandbox } from './helpers.js';

const T = 15_000;
const BOTH = ['filesystem.list', 'filesystem.read'];
const scopeOf = (root: string): FilesystemScope => ({ kind: 'filesystem_root', root }) as FilesystemScope;
const fdCount = (): number => readdirSync('/proc/self/fd').length;
const linux = process.platform === 'linux';

function bounded<T>(p: Promise<T>, ms = 5_000, what = 'operation'): Promise<T> {
  let t: NodeJS.Timeout;
  const timer = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what} did not settle within ${ms}ms (hang)`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Spy = { opens: { path: string; flags: number }[]; reads: number; handles: FileHandle[] };

function spyOps(
  over: Partial<FsOps> = {},
  wrap?: (h: FileHandle, path: string) => FileHandle,
  gate?: (path: string) => Promise<void> | undefined,
): { ops: FsOps; spy: Spy } {
  const spy: Spy = { opens: [], reads: 0, handles: [] };
  const ops: FsOps = {
    ...NODE_FS_OPS,
    ...over,
    async open(path, flags) {
      spy.opens.push({ path, flags });
      await gate?.(path);
      let h = await NODE_FS_OPS.open(path, flags);
      spy.handles.push(h);
      if (wrap !== undefined) h = wrap(h, path);
      return h;
    },
  };
  return { ops, spy };
}

async function acquire(root: string, keys: string[], ops: FsOps, signal?: AbortSignal) {
  const c = new LocalFilesystemConnector({ fsOps: ops });
  const ctx = ctxFor(allowRoot(root, BOTH), new MockClock(), signal);
  const scope = scopeOf(root);
  const detected = await c.detectSource({ sourceType: 'local_filesystem', scope }, ctx);
  assert.ok(detected.ok);
  const sourceId = detected.ok ? detected.value.sourceId : ('x' as never);
  return c.acquireContent({ sourceId, kind: 'document_content', resourceKeys: keys, scope }, ctx);
}

const mkfifo = (path: string): void => {
  execSync(`mkfifo ${JSON.stringify(path)}`);
};

test('F3 FIFO: acquisition does not hang, is rejected, nothing read, no descriptor leaked', { timeout: T, skip: !linux }, async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'ok.txt'), 'hello');
    mkfifo(join(root, 'pipe.txt'));
    const before = fdCount();
    const { ops, spy } = spyOps();
    const out = await bounded(acquire(root, ['pipe.txt', 'ok.txt'], ops), 5_000, 'FIFO acquisition');
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.value.skipped.byReason['not_regular_file'], 1);
    assert.deepEqual(
      out.value.evidence.map((e) => e.resourceKey),
      ['ok.txt'],
    );
    // The pre-open lstat check means the FIFO was never opened at all.
    assert.equal(spy.opens.filter((o) => o.path.endsWith('/pipe.txt')).length, 0);
    assert.equal(fdCount(), before);
  });
});

test(
  'F3 FIFO swapped in AFTER the lstat check: O_NONBLOCK open cannot block; post-open fstat rejects it',
  { timeout: T, skip: !linux },
  async () => {
    await withSandbox(async ({ root }) => {
      await put(join(root, 'swap.txt'), 'regular at lstat time');
      const before = fdCount();
      let swapped = false;
      const { ops, spy } = spyOps({}, undefined, async (p) => {
        if (swapped || !p.endsWith('/swap.txt')) return;
        swapped = true;
        // Replace the regular file by a FIFO between the connector's lstat and its open.
        execSync(`rm -f ${JSON.stringify(join(root, 'swap.txt'))} && mkfifo ${JSON.stringify(join(root, 'swap.txt'))}`);
      });
      const out = await bounded(acquire(root, ['swap.txt'], ops), 5_000, 'swapped-FIFO acquisition');
      assert.ok(out.ok);
      if (!out.ok) return;
      const o = spy.opens.find((x) => x.path.endsWith('/swap.txt'));
      assert.ok(o, 'the file was opened (the swap happened after the pre-open check)');
      assert.ok((o.flags & constants.O_NONBLOCK) !== 0, 'opened O_NONBLOCK');
      assert.ok((o.flags & constants.O_NOFOLLOW) !== 0, 'opened O_NOFOLLOW');
      assert.equal(out.value.skipped.byReason['not_regular_file'], 1, 'rejected by post-open fstat');
      assert.equal(out.value.evidence.length, 0);
      assert.equal(fdCount(), before, 'descriptor closed');
    });
  },
);

test('F3 discovery: a FIFO in the tree does not hang discovery and is never opened', { timeout: T, skip: !linux }, async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'a');
    mkfifo(join(root, 'p.txt'));
    const { ops, spy } = spyOps();
    const c = new LocalFilesystemConnector({ fsOps: ops });
    const out = await bounded(
      c.discover({ sourceType: 'local_filesystem', scope: scopeOf(root) }, ctxFor(allowRoot(root, BOTH), new MockClock())),
      5_000,
      'discovery with FIFO',
    );
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.value.skipped.byReason['not_regular_file'], 1);
    assert.equal(spy.opens.filter((o) => o.path.endsWith('/p.txt')).length, 0);
  });
});

test('F3 non-regular (directory named like a file) is rejected without being read', { timeout: T, skip: !linux }, async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'dir.txt', 'inner.txt'), 'x');
    const { ops, spy } = spyOps();
    const out = await bounded(acquire(root, ['dir.txt'], ops));
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.value.skipped.byReason['not_regular_file'], 1);
    assert.equal(out.value.evidence.length, 0);
    assert.equal(spy.opens.filter((o) => o.path.endsWith('/dir.txt')).length, 0);
  });
});

test('F3 device file (SIMULATED via lstat seam): rejected before open, never opened or read', { timeout: T, skip: !linux }, async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'dev.txt'), 'really a regular file on disk; the seam reports a char device');
    const { ops, spy } = spyOps({
      async lstat(p) {
        const st = await NODE_FS_OPS.lstat(p);
        if (!p.endsWith('/dev.txt')) return st;
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          isFile: () => false,
          isCharacterDevice: () => true,
        }) as typeof st;
      },
    });
    const out = await bounded(acquire(root, ['dev.txt'], ops));
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.value.skipped.byReason['not_regular_file'], 1);
    assert.equal(spy.opens.filter((o) => o.path.endsWith('/dev.txt')).length, 0);
    assert.equal(out.value.evidence.length, 0);
  });
});

test(
  'F3 post-open fstat is authoritative (SIMULATED device behind a regular lstat): rejected, closed, zero reads',
  { timeout: T, skip: !linux },
  async () => {
    await withSandbox(async ({ root }) => {
      await put(join(root, 'late.txt'), 'content that must never be read');
      const before = fdCount();
      let reads = 0;
      const { ops, spy } = spyOps({}, (h, p) =>
        !p.endsWith('/late.txt')
          ? h
          : (new Proxy(h, {
              get(t, prop) {
                if (prop === 'stat')
                  return async (o?: { bigint?: boolean }) => {
                    const st = await t.stat(o as never);
                    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
                      isFile: () => false,
                      isCharacterDevice: () => true,
                    });
                  };
                if (prop === 'read')
                  return () => {
                    reads += 1;
                    throw new Error('read must not be called on a non-regular descriptor');
                  };
                const v = Reflect.get(t, prop) as unknown;
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
              },
            }) as FileHandle),
      );
      const out = await bounded(acquire(root, ['late.txt'], ops));
      assert.ok(out.ok);
      if (!out.ok) return;
      assert.equal(reads, 0);
      assert.equal(out.value.skipped.byReason['not_regular_file'], 1);
      assert.equal(out.value.evidence.length, 0);
      assert.equal(
        spy.handles.every((h) => h.fd === -1),
        true,
        'every opened handle was closed',
      );
      assert.equal(fdCount(), before);
    });
  },
);

let canMknod = false;
try {
  execSync('mknod /tmp/xo-f3-probe c 1 3 2>/dev/null && rm -f /tmp/xo-f3-probe');
  canMknod = true;
} catch {
  /* unprivileged: real device test is skipped, and reported as skipped */
}
test(
  'F3 REAL device file rejected without reading (runs only when mknod is permitted)',
  {
    timeout: T,
    skip: !linux ? 'not linux' : !canMknod ? 'mknod not permitted in this environment (unprivileged); see SIMULATED device tests' : false,
  },
  async () => {
    await withSandbox(async ({ root }) => {
      execSync(`mknod ${JSON.stringify(join(root, 'zero.txt'))} c 1 5`);
      const { ops, spy } = spyOps();
      const out = await bounded(acquire(root, ['zero.txt'], ops));
      assert.ok(out.ok);
      if (!out.ok) return;
      assert.equal(out.value.skipped.byReason['not_regular_file'], 1);
      assert.equal(spy.opens.filter((o) => o.path.endsWith('/zero.txt')).length, 0);
    });
  },
);

test(
  'F3 cancellation: a stalled open is abandoned promptly; late descriptor is closed; slot freed',
  { timeout: T, skip: !linux },
  async () => {
    await withSandbox(async ({ root }) => {
      await put(join(root, 'stall.txt'), 'x');
      await put(join(root, 'never.txt'), 'y');
      const before = fdCount();
      let release!: () => void;
      const gateP = new Promise<void>((r) => (release = r));
      const { ops, spy } = spyOps({}, undefined, (p) => (p.endsWith('/stall.txt') ? gateP : undefined));
      const ac = new AbortController();
      const started = Date.now();
      const run = acquire(root, ['stall.txt', 'never.txt'], ops, ac.signal);
      await sleep(100);
      ac.abort();
      const out = await bounded(run, 2_000, 'cancelled acquisition');
      assert.ok(Date.now() - started < 2_000);
      assert.ok(out.ok, 'partial result, not a thrown/hung failure');
      if (!out.ok) return;
      assert.equal(out.value.status, 'partial');
      assert.ok(out.value.limits.hit.includes('cancelled'));
      assert.ok(out.value.errors.some((e) => e.code === DiscoveryErrorCode.CANCELLED));
      assert.equal(out.value.evidence.length, 0);
      assert.equal(spy.opens.filter((o) => o.path.endsWith('/never.txt')).length, 0, 'no further key attempted after cancel');
      // Now let the abandoned open finish: its descriptor must be closed, never read.
      release();
      await bounded(
        (async () => {
          while (spy.handles.length === 0 || spy.handles.some((h) => h.fd !== -1)) await sleep(10);
        })(),
        2_000,
        'abandoned-descriptor cleanup',
      );
      assert.equal(fdCount(), before, 'no leaked descriptor');
    });
  },
);

test(
  'F3 cancellation: an abort that fires before any open starts is honoured; a stalled open that REJECTS late frees its slot',
  { timeout: T, skip: !linux },
  async () => {
    await withSandbox(async ({ root }) => {
      await put(join(root, 'r.txt'), 'x');
      const before = fdCount();
      let fail!: () => void;
      const gateP = new Promise<void>((_, rej) => (fail = () => rej(Object.assign(new Error('late failure'), { code: 'EIO' }))));
      const { ops } = spyOps({}, undefined, (p) => (p.endsWith('/r.txt') ? gateP : undefined));
      const ac = new AbortController();
      const run = acquire(root, ['r.txt'], ops, ac.signal);
      await sleep(50);
      ac.abort();
      const out = await bounded(run, 2_000, 'cancelled acquisition (late rejection)');
      assert.ok(out.ok);
      fail();
      await sleep(50); // abandoned rejection must be swallowed (no unhandledRejection crashes the runner)
      assert.equal(fdCount(), before);
      const pre = new AbortController();
      pre.abort();
      const c = new LocalFilesystemConnector({ fsOps: ops });
      const detected = await c.detectSource(
        { sourceType: 'local_filesystem', scope: scopeOf(root) },
        ctxFor(allowRoot(root, BOTH), new MockClock()),
      );
      assert.ok(detected.ok);
      const r = await c.acquireContent(
        {
          sourceId: detected.ok ? detected.value.sourceId : ('x' as never),
          kind: 'document_content',
          resourceKeys: ['r.txt'],
          scope: scopeOf(root),
        },
        ctxFor(allowRoot(root, BOTH), new MockClock(), pre.signal),
      );
      assert.ok(!r.ok && r.error.code === DiscoveryErrorCode.CANCELLED);
    });
  },
);

test(
  'F3 cancellation of a stalled DIRECTORY open during discovery returns a partial result promptly',
  { timeout: T, skip: !linux },
  async () => {
    await withSandbox(async ({ root }) => {
      await put(join(root, 'sub', 'f.txt'), 'x');
      const before = fdCount();
      let release!: () => void;
      const gateP = new Promise<void>((r) => (release = r));
      const { ops, spy } = spyOps({}, undefined, (p) => (p.endsWith('/sub') ? gateP : undefined));
      const ac = new AbortController();
      const c = new LocalFilesystemConnector({ fsOps: ops });
      const run = c.discover(
        { sourceType: 'local_filesystem', scope: scopeOf(root) },
        ctxFor(allowRoot(root, BOTH), new MockClock(), ac.signal),
      );
      await sleep(100);
      ac.abort();
      const out = await bounded(run, 2_000, 'cancelled discovery');
      assert.ok(out.ok);
      if (!out.ok) return;
      assert.ok(out.value.limits.hit.includes('cancelled'));
      release();
      await bounded(
        (async () => {
          while (spy.handles.length === 0 || spy.handles.some((h) => h.fd !== -1)) await sleep(10);
        })(),
        2_000,
        'abandoned dir cleanup',
      );
      assert.equal(fdCount(), before);
    });
  },
);

test('F3 platform contract: missing safe-open flags fail closed (no weaker fallback)', { timeout: T, skip: !linux }, async () => {
  const { O_FILE_FLAGS } = await import('../src/filesystem/fd-walk.js');
  const f = O_FILE_FLAGS();
  assert.ok(f !== undefined, 'this host defines the flags');
  assert.ok((f & constants.O_NONBLOCK) !== 0 && (f & constants.O_NOFOLLOW) !== 0);
});
