/**
 * F1 - descriptor-anchored traversal. Adversarial tests that inject filesystem races through the internal
 * `FsOps` seam at exact points between a check and the following use.
 *
 * Each test is labelled NEGATIVE CONTROL (fails against the path-based implementation, which is how it was
 * confirmed to detect the bug) or REGRESSION GUARD (also passes on the old code; protects behavior that must
 * not regress). Residual races that the design does NOT close are pinned by tests that say so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import {
  DiscoveryErrorCode,
  LocalFilesystemConnector,
  type AcquisitionOutcome,
  type DiscoveryOutcome,
  type FilesystemScope,
} from '../src/index.js';
import { NODE_FS_OPS, type FsOps } from '../src/filesystem/fd-walk.js';
import { allowRoot, ctxFor, put, withSandbox } from './helpers.js';

const scopeOf = (root: string, extra: Record<string, unknown> = {}): FilesystemScope =>
  ({ kind: 'filesystem_root', root, ...extra }) as FilesystemScope;
const BOTH = ['filesystem.list', 'filesystem.read'];
const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

type Hooks = {
  /** Runs after the real lstat of a path ending in `name` returned (before the caller sees it). */
  afterLstat?: (path: string) => Promise<void>;
  afterReaddir?: (path: string, names: string[]) => Promise<void>;
  beforeOpen?: (path: string, flags: number) => Promise<void>;
  /** Runs before the FIRST filesystem call the connector makes after authorization. */
  first?: () => Promise<void>;
  lstatDev?: (path: string) => bigint | undefined;
  openStatDev?: (path: string) => bigint | undefined;
};

function opsWith(hooks: Hooks, base: Partial<FsOps> = {}): { ops: FsOps; opened: FileHandle[]; calls: string[] } {
  const opened: FileHandle[] = [];
  const calls: string[] = [];
  let firstDone = false;
  const first = async (): Promise<void> => {
    if (firstDone || hooks.first === undefined) return;
    firstDone = true;
    await hooks.first();
  };
  const ops: FsOps = {
    ...NODE_FS_OPS,
    ...base,
    async readdir(p) {
      calls.push(`readdir ${p}`);
      await first();
      const r = await NODE_FS_OPS.readdir(p);
      await hooks.afterReaddir?.(p, r);
      return r;
    },
    async readdirLimited(p, limit) {
      calls.push(`readdir ${p}`);
      await first();
      const r = await NODE_FS_OPS.readdirLimited(p, limit);
      await hooks.afterReaddir?.(p, r.names);
      return r;
    },
    async lstat(p) {
      calls.push(`lstat ${p}`);
      await first();
      const st = await NODE_FS_OPS.lstat(p);
      await hooks.afterLstat?.(p);
      const dev = hooks.lstatDev?.(p);
      return dev === undefined ? st : (Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev }) as typeof st);
    },
    async open(p, flags) {
      calls.push(`open ${p}`);
      await first();
      await hooks.beforeOpen?.(p, flags);
      const h = await NODE_FS_OPS.open(p, flags);
      opened.push(h);
      const dev = hooks.openStatDev?.(p);
      if (dev === undefined) return h;
      return new Proxy(h, {
        get(t, prop) {
          if (prop === 'stat')
            return async (o?: { bigint?: boolean }) => {
              const st = await t.stat(o as never);
              return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: o?.bigint ? dev : Number(dev) });
            };
          const v = Reflect.get(t, prop) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    },
  };
  return { ops, opened, calls };
}

async function discover(root: string, ops: FsOps, extra: Record<string, unknown> = {}, fdBudget?: number, signal?: AbortSignal) {
  const c = new LocalFilesystemConnector({ fsOps: ops, ...(fdBudget !== undefined ? { fdBudget } : {}) });
  return c.discover(
    { sourceType: 'local_filesystem', scope: scopeOf(root, extra) },
    ctxFor(allowRoot(root, BOTH), new MockClock(), signal),
  );
}

async function acquire(root: string, keys: string[], ops: FsOps, extra: Record<string, unknown> = {}, fdBudget?: number) {
  const c = new LocalFilesystemConnector({ fsOps: ops, ...(fdBudget !== undefined ? { fdBudget } : {}) });
  const ctx = ctxFor(allowRoot(root, BOTH));
  const scope = scopeOf(root, extra);
  const detected = await c.detectSource({ sourceType: 'local_filesystem', scope }, ctx);
  assert.ok(detected.ok);
  const sourceId = detected.ok ? detected.value.sourceId : ('x' as never);
  return c.acquireContent({ sourceId, kind: 'document_content', resourceKeys: keys, scope }, ctx);
}

const keysOf = (o: DiscoveryOutcome | AcquisitionOutcome): string[] =>
  o.evidence.filter((e) => e.resourceKey !== '').map((e) => e.resourceKey);
const reasonCount = (o: DiscoveryOutcome | AcquisitionOutcome, ...reasons: string[]): number =>
  reasons.reduce((n, r) => n + (o.skipped.byReason[r] ?? 0), 0);
const fdCount = (): number => readdirSync('/proc/self/fd').length;

async function swapDirForSymlink(root: string, name: string, target: string): Promise<void> {
  await rename(join(root, name), join(root, `${name}.moved`));
  await symlink(target, join(root, name));
}

async function tree(root: string, outside: string): Promise<void> {
  await put(join(root, 'top.txt'), 'top');
  await put(join(root, 'sub', 'inner', 'inside.txt'), 'inside-content');
  await put(join(root, 'sub', 'x.txt'), 'inside-content');
  await put(join(outside, 'OUTSIDE-SECRET.txt'), 'outside-secret');
  await put(join(outside, 'x.txt'), 'outside-secret');
  await put(join(outside, 'inner', 'OUTSIDE-DEEP.txt'), 'outside-deep');
}

test('positive control: an unraced tree is discovered and acquired normally', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    const d = await discover(root, opsWith({}).ops);
    assert.ok(d.ok);
    assert.deepEqual(d.ok ? keysOf(d.value) : [], ['sub/inner/inside.txt', 'sub/x.txt', 'top.txt']);
    const a = await acquire(root, ['sub/x.txt'], opsWith({}).ops);
    assert.ok(a.ok);
    assert.equal(a.ok ? a.value.evidence[0]?.payload['digest'] : '', sha('inside-content'));
  });
});

test('NEGATIVE CONTROL: a directory swapped for a symlink between lstat and descent is not followed (discovery)', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    let done = false;
    const { ops } = opsWith({
      afterLstat: async (p) => {
        if (!done && p.endsWith('/sub')) {
          done = true;
          await swapDirForSymlink(root, 'sub', outside);
        }
      },
    });
    const d = await discover(root, ops);
    assert.ok(done, 'the race was injected');
    assert.ok(d.ok);
    const keys = d.ok ? keysOf(d.value) : [];
    assert.ok(!keys.some((k) => k.includes('OUTSIDE')), `outside content leaked: ${keys.join(',')}`);
    assert.ok(d.ok && reasonCount(d.value, 'symlink_not_followed', 'entry_changed') > 0, 'the swapped entry is reported as skipped');
  });
});

test('NEGATIVE CONTROL: renaming a directory already being walked cannot redirect later lookups outside the root (discovery)', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    let done = false;
    const { ops } = opsWith({
      // The listing of `sub` (identified by its entries, so it works for path and descriptor addressing) just returned.
      afterReaddir: async (_p, names) => {
        if (!done && names.includes('inner') && names.includes('x.txt')) {
          done = true;
          await swapDirForSymlink(root, 'sub', outside);
        }
      },
    });
    const d = await discover(root, ops);
    assert.ok(done, 'the race was injected');
    assert.ok(d.ok);
    const keys = d.ok ? keysOf(d.value) : [];
    assert.ok(!keys.some((k) => k.includes('OUTSIDE')), `outside content leaked: ${keys.join(',')}`);
    assert.ok(keys.includes('sub/inner/inside.txt'), 'the held descriptor still refers to the original directory');
  });
});

test('NEGATIVE CONTROL: a directory swapped for a symlink between the pre-check and the read cannot redirect the read (acquisition)', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    let done = false;
    const { ops } = opsWith({
      // Fires when the FINAL component is about to be opened (by path in the old code, relative to a descriptor in the new).
      beforeOpen: async (p) => {
        if (!done && /(^|\/)x\.txt$/.test(p)) {
          done = true;
          await swapDirForSymlink(root, 'sub', outside);
        }
      },
    });
    const a = await acquire(root, ['sub/x.txt'], ops);
    assert.ok(done, 'the race was injected');
    assert.ok(a.ok);
    const digest = a.ok ? a.value.evidence[0]?.payload['digest'] : undefined;
    assert.notEqual(digest, sha('outside-secret'), 'the swapped-in outside file was read');
    assert.equal(digest, sha('inside-content'));
  });
});

test('REGRESSION GUARD: a final component swapped for a symlink is refused by O_NOFOLLOW (acquisition)', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    let done = false;
    const { ops } = opsWith({
      beforeOpen: async (p) => {
        if (!done && /\/top\.txt$/.test(p)) {
          done = true;
          await rename(join(root, 'top.txt'), join(root, 'top.moved'));
          await symlink(join(outside, 'OUTSIDE-SECRET.txt'), join(root, 'top.txt'));
        }
      },
    });
    const a = await acquire(root, ['top.txt'], ops);
    assert.ok(done);
    assert.ok(a.ok);
    assert.equal(a.ok ? a.value.evidence.length : -1, 0, 'no evidence from the outside file');
  });
});

test('NEGATIVE CONTROL: an ancestor of the root swapped before the first access is detected (anchor check)', async () => {
  await withSandbox(async ({ base, outside }) => {
    const parent = join(base, 'p');
    const root = join(parent, 'approved');
    await put(join(root, 'top.txt'), 'inside');
    await put(join(outside, 'approved', 'OUTSIDE-SECRET.txt'), 'outside');
    const { ops } = opsWith({
      first: async () => {
        await rename(parent, join(base, 'p.moved'));
        await symlink(outside, parent);
      },
    });
    const d = await discover(root, ops);
    if (d.ok) assert.ok(!keysOf(d.value).some((k) => k.includes('OUTSIDE')), 'outside tree was listed through the swapped ancestor');
    else assert.equal(d.error.code, DiscoveryErrorCode.SCOPE_VIOLATION);
    assert.equal(d.ok, false, 'the swapped root must be refused, not silently re-rooted');
  });
});

test('NEGATIVE CONTROL: a directory on another device is a mount boundary and is skipped (discovery)', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    const { ops } = opsWith({ openStatDev: (p) => (/\/sub$|\/proc\/self\/fd\/\d+\/sub$/.test(p) ? 999_999n : undefined) });
    const d = await discover(root, ops);
    assert.ok(d.ok);
    const keys = d.ok ? keysOf(d.value) : [];
    assert.ok(!keys.some((k) => k.startsWith('sub/')), `entered a directory on another device: ${keys.join(',')}`);
    assert.ok(d.ok && reasonCount(d.value, 'mount_boundary') > 0);
  });
});

test('NEGATIVE CONTROL: a file on another device is refused (acquisition)', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    const { ops } = opsWith({ lstatDev: (p) => (p.endsWith('/top.txt') ? 999_999n : undefined) });
    const a = await acquire(root, ['top.txt'], ops);
    assert.equal(a.ok, false);
    if (!a.ok) {
      assert.equal(a.error.code, DiscoveryErrorCode.SCOPE_VIOLATION);
      assert.equal(a.error.context['reason'], 'mount_boundary');
    }
  });
});

test('NEGATIVE CONTROL: a same-filesystem bind mount under the root is detected through mountinfo', async (t) => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    await mkdir(join(root, 'mnt'));
    try {
      execSync(`mount --bind ${outside} ${join(root, 'mnt')}`, { stdio: 'pipe' });
    } catch {
      t.skip('cannot create a bind mount here (needs privilege); the mountinfo parser is covered by fixture tests');
      return;
    }
    try {
      const d = await discover(root, opsWith({}).ops);
      assert.ok(d.ok);
      const keys = d.ok ? keysOf(d.value) : [];
      assert.ok(!keys.some((k) => k.includes('OUTSIDE')), `bind-mounted content leaked: ${keys.join(',')}`);
      assert.ok(d.ok && reasonCount(d.value, 'mount_boundary') > 0);
      const a = await acquire(root, ['mnt/x.txt'], opsWith({}).ops);
      assert.equal(a.ok, false);
      if (!a.ok) assert.equal(a.error.context['reason'], 'mount_boundary');
    } finally {
      execSync(`umount -l ${join(root, 'mnt')}`, { stdio: 'pipe' });
    }
  });
});

test('NEGATIVE CONTROL: without procfs the hardened operations fail closed, with no path-based fallback', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    const d1 = opsWith({}, { procFdDir: '/nonexistent/proc-fd', platform: 'linux' });
    const d = await discover(root, d1.ops);
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.equal(d.error.code, DiscoveryErrorCode.UNSUPPORTED_OPERATION);
      assert.equal(d.error.context['reason'], 'fd_traversal_unavailable');
    }
    assert.ok(
      !d1.calls.some((c) => c.includes(root) && !c.includes('lstat')),
      `path-based access after the probe failed: ${d1.calls.join(' | ')}`,
    );
    const a1 = opsWith({}, { procFdDir: '/nonexistent/proc-fd', platform: 'linux' });
    const a = await acquire(root, ['top.txt'], a1.ops);
    assert.equal(a.ok, false);
    if (!a.ok) assert.equal(a.error.context['reason'], 'fd_traversal_unavailable');
    assert.ok(!a1.calls.some((c) => c.startsWith('open ')), 'no file was opened');
  });
});

test('NEGATIVE CONTROL: on a non-Linux platform discovery is path-based and labelled unhardened, acquisition fails closed', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    const mac = { procFdDir: '/nonexistent/proc-fd', platform: 'darwin' as const };
    const d = await discover(root, opsWith({}, mac).ops);
    assert.ok(d.ok, 'D1: discovery keeps working on the current path-based code');
    const steps = d.ok ? d.value.evidence.flatMap((e) => e.provenance.transformationChain.map((s) => s.step)) : [];
    assert.ok(
      steps.some((s) => s.includes('path_based_unhardened')),
      `unhardened mode must be labelled: ${steps.join(',')}`,
    );
    const meta = d.ok ? d.value.evidence.find((e) => e.kind === 'metadata') : undefined;
    assert.equal(meta?.payload['traversal'], 'path_based_unhardened');
    const a = await acquire(root, ['top.txt'], opsWith({}, mac).ops);
    assert.equal(a.ok, false, 'D1: hardened content acquisition must not run without /proc/self/fd');
    if (!a.ok) assert.equal(a.error.context['reason'], 'fd_traversal_unavailable');
  });
});

test('NEGATIVE CONTROL: unreadable mountinfo fails closed for both operations', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    const bad = {
      async readText(): Promise<string> {
        throw new Error('EACCES');
      },
    };
    const d = await discover(root, opsWith({}, bad).ops);
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.error.context['reason'], 'mountinfo_unavailable');
    const a = await acquire(root, ['top.txt'], opsWith({}, bad).ops);
    assert.equal(a.ok, false);
    if (!a.ok) assert.equal(a.error.context['reason'], 'mountinfo_unavailable');
    const garbled = { readText: async () => 'this is not a mountinfo line\n' };
    const g = await discover(root, opsWith({}, garbled).ops);
    assert.equal(g.ok, false, 'an unparseable mountinfo is not treated as "no mounts"');
  });
});

test('NEGATIVE CONTROL: the descriptor budget is enforced before opening and exhaustion is a structured error, never truncation', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a', 'b', 'c', 'd', 'e', 'deep.txt'), 'x');
    await put(join(root, 'top.txt'), 'x');
    const t = opsWith({});
    const d = await discover(root, t.ops, {}, 3);
    assert.equal(d.ok, false, 'not a partial success');
    if (!d.ok) {
      assert.equal(d.error.code, DiscoveryErrorCode.LIMIT_EXCEEDED);
      assert.equal(d.error.context['reason'], 'fd_budget');
    }
    assert.ok(t.opened.length <= 3, `opened ${t.opened.length} descriptors with a budget of 3`);
    assert.ok(
      t.opened.every((h) => h.fd === -1),
      'every descriptor was closed on the error path',
    );
  });
});

test('REGRESSION GUARD: every descriptor is closed on success, cancellation, limit and error paths', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    const before = fdCount();
    const check = (label: string, t: { opened: FileHandle[] }) =>
      assert.ok(
        t.opened.every((h) => h.fd === -1),
        `${label}: leaked descriptor`,
      );
    const s = opsWith({});
    assert.ok((await discover(root, s.ops)).ok);
    check('success', s);
    const ac = new AbortController();
    const c = opsWith({ afterReaddir: async () => ac.abort() });
    await discover(root, c.ops, {}, undefined, ac.signal);
    check('abort', c);
    const l = opsWith({});
    await discover(root, l.ops, { limits: { maxEntries: 2 } });
    check('max_entries', l);
    const a = opsWith({});
    await acquire(root, ['sub/x.txt', 'top.txt'], a.ops);
    check('acquire', a);
    const bad = opsWith({}, { readdir: async () => Promise.reject(new Error('boom')) });
    await discover(root, bad.ops);
    check('readdir failure', bad);
    assert.equal(fdCount(), before, 'process descriptor count is unchanged');
  });
});

test('REGRESSION GUARD: hardened discovery returns the same sorted inventory as the path-based mode', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    await put(join(root, 'b', 'z.txt'), 'z');
    await put(join(root, 'a', 'y.txt'), 'y');
    await writeFile(join(root, 'Zed.md'), 'm');
    const hard = await discover(root, opsWith({}).ops);
    const soft = await discover(root, opsWith({}, { procFdDir: '/nonexistent', platform: 'darwin' }).ops);
    assert.ok(hard.ok && soft.ok);
    const inv = (r: typeof hard) => (r.ok ? r.value.evidence.filter((e) => e.kind === 'resource_inventory').map((e) => e.resourceKey) : []);
    assert.deepEqual(inv(hard), inv(soft));
    assert.deepEqual(inv(hard), [...inv(hard)].sort());
  });
});

test('mountinfo parser: escapes are decoded, malformed or empty input is an error (never "no mounts")', async () => {
  const { parseMountPoints } = await import('../src/filesystem/fd-walk.js');
  const good = [
    '36 35 98:0 /mnt1 /mnt/with\\040space rw,noatime master:1 - ext3 /dev/root rw,errors=continue',
    '37 36 0:25 / /mnt/tab\\011ed rw - tmpfs tmpfs rw',
    '',
  ].join('\n');
  const r = parseMountPoints(good);
  assert.ok(r.ok);
  assert.deepEqual(r.ok ? r.value : [], ['/mnt/with space', '/mnt/tab\ted']);
  for (const bad of [
    '',
    '\n',
    'garbage',
    '1 2 3:4 / /x rw',
    'a b 3:4 / /x rw - ext4 /dev/x rw',
    '1 2 3:4 / relative rw - ext4 /dev/x rw',
  ]) {
    assert.equal(parseMountPoints(bad).ok, false, JSON.stringify(bad));
  }
});

test('walker refuses hostile components itself (defense in depth: `..` under a /proc fd path opens the parent)', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'x');
    const { AnchoredTree, FdWalkFatal, isValidComponent } = await import('../src/filesystem/fd-walk.js');
    for (const bad of ['', '.', '..', 'a/b', '../x', 'a\0b']) assert.equal(isValidComponent(bad), false, JSON.stringify(bad));
    assert.equal(isValidComponent('ok name.txt'), true);
    const tree = await AnchoredTree.open(NODE_FS_OPS, root);
    try {
      for (const bad of ['..', 'a/b', '.', '']) {
        await assert.rejects(tree.lstatChild(tree.root, bad), (e: unknown) => e instanceof FdWalkFatal);
        await assert.rejects(tree.openChildDir(tree.root, bad), (e: unknown) => e instanceof FdWalkFatal);
      }
    } finally {
      await tree.close();
    }
  });
});

test('acquisition holds at most root + current + next descriptors, so a deep key fits a budget of 3 and not 2', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a', 'b', 'c', 'd', 'e', 'deep.txt'), 'deep-content');
    const ok3 = await acquire(root, ['a/b/c/d/e/deep.txt'], opsWith({}).ops, {}, 3);
    assert.ok(ok3.ok);
    assert.equal(ok3.ok ? ok3.value.evidence.length : 0, 1);
    const t2 = opsWith({});
    const no2 = await acquire(root, ['a/b/c/d/e/deep.txt'], t2.ops, {}, 2);
    assert.equal(no2.ok, false);
    if (!no2.ok) assert.equal(no2.error.context['reason'], 'fd_budget');
    assert.ok(t2.opened.every((h) => h.fd === -1));
  });
});

test('default descriptor budget is 64 and a directory with control characters in its name is still skipped as unsafe', async () => {
  const { DEFAULT_FD_BUDGET } = await import('../src/filesystem/fd-walk.js');
  assert.equal(DEFAULT_FD_BUDGET, 64);
  await withSandbox(async ({ root }) => {
    await mkdir(join(root, 'bad\nname'));
    await put(join(root, 'bad\nname', 'f.txt'), 'x');
    await put(join(root, 'good.txt'), 'x');
    const d = await discover(root, opsWith({}).ops);
    assert.ok(d.ok);
    assert.deepEqual(d.ok ? keysOf(d.value) : [], ['good.txt']);
    assert.ok(d.ok && reasonCount(d.value, 'unsafe_name') === 1);
  });
});

test('RESIDUAL RACE R3 (documented, not closed): a directory renamed out of the root after its descriptor is held is still read', async () => {
  await withSandbox(async ({ base, root, outside }) => {
    await tree(root, outside);
    let done = false;
    const { ops } = opsWith({
      afterReaddir: async (_p, names) => {
        if (!done && names.includes('inner') && names.includes('x.txt')) {
          done = true;
          await rename(join(root, 'sub'), join(base, 'moved-out-of-root'));
        }
      },
    });
    const d = await discover(root, ops);
    assert.ok(d.ok);
    // Containment is NOT claimed here: content of a directory that left the root is still listed. The test pins the
    // limitation so a future change cannot silently start (or stop) relying on it.
    assert.ok(done && keysOf(d.ok ? d.value : ({ evidence: [] } as never)).includes('sub/inner/inside.txt'));
  });
});

test('NEGATIVE CONTROL: a file on another device is not inventoried (discovery metadata does not cross mounts)', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    const { ops } = opsWith({ lstatDev: (p) => (p.endsWith('/top.txt') ? 999_999n : undefined) });
    const d = await discover(root, ops);
    assert.ok(d.ok);
    const keys = d.ok ? keysOf(d.value) : [];
    assert.ok(!keys.includes('top.txt'), `metadata of a file on another device was inventoried: ${keys.join(',')}`);
    assert.ok(d.ok && reasonCount(d.value, 'mount_boundary') > 0);
  });
});

test('NEGATIVE CONTROL: a same-filesystem bind-mounted FILE is not inventoried', async (t) => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    await writeFile(join(root, 'mf.txt'), 'placeholder');
    try {
      execSync(`mount --bind ${join(outside, 'OUTSIDE-SECRET.txt')} ${join(root, 'mf.txt')}`, { stdio: 'pipe' });
    } catch {
      t.skip('cannot create a bind mount here (needs privilege)');
      return;
    }
    try {
      const d = await discover(root, opsWith({}).ops);
      assert.ok(d.ok);
      assert.ok(!(d.ok ? keysOf(d.value) : []).includes('mf.txt'), 'bind-mounted file metadata was inventoried');
      const a = await acquire(root, ['mf.txt'], opsWith({}).ops);
      assert.equal(a.ok, false);
      if (!a.ok) assert.equal(a.error.context['reason'], 'mount_boundary');
    } finally {
      execSync(`umount -l ${join(root, 'mf.txt')}`, { stdio: 'pipe' });
    }
  });
});

test('R2: a directory replaced by a DIFFERENT directory between lstat and descent is detected by the dev/ino check', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    let done = false;
    const { ops } = opsWith({
      afterLstat: async (p) => {
        if (!done && p.endsWith('/sub')) {
          done = true;
          await rename(join(root, 'sub'), join(root, 'sub.orig'));
          await put(join(root, 'sub', 'REPLACEMENT.txt'), 'new inode, still inside the root');
        }
      },
    });
    const d = await discover(root, ops);
    assert.ok(done && d.ok);
    const keys = d.ok ? keysOf(d.value) : [];
    assert.ok(!keys.includes('sub/REPLACEMENT.txt'), 'the swapped-in directory was walked as if it were the enumerated one');
    assert.ok(d.ok && reasonCount(d.value, 'entry_changed') > 0);
  });
});

test('RESIDUAL R1 (documented, not closed): the root replaced by another directory AT THE SAME PATH before it is opened is indistinguishable and is walked', async () => {
  await withSandbox(async ({ base, root }) => {
    await put(join(root, 'original.txt'), 'x');
    const { ops } = opsWith({
      first: async () => {
        await rename(root, join(base, 'approved.orig'));
        await put(join(root, 'replacement.txt'), 'x');
      },
    });
    const d = await discover(root, ops);
    assert.ok(d.ok);
    // The anchor check compares paths, so a different directory at the authorized path passes. Pinned as a limitation.
    assert.deepEqual(d.ok ? keysOf(d.value) : [], ['replacement.txt']);
  });
});

test('RESIDUAL R4 (documented, not closed): a same-filesystem bind mount created AFTER the mountinfo snapshot is entered', async (t) => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    await mkdir(join(root, 'late'));
    let mounted = false;
    const real = NODE_FS_OPS.readText;
    const { ops } = opsWith(
      {},
      {
        readText: async (p: string) => {
          const text = await real(p);
          try {
            execSync(`mount --bind ${outside} ${join(root, 'late')}`, { stdio: 'pipe' });
            mounted = true;
          } catch {
            /* unprivileged: skipped below */
          }
          return text;
        },
      },
    );
    try {
      const d = await discover(root, ops);
      if (!mounted) {
        t.skip('cannot create a bind mount here (needs privilege)');
        return;
      }
      assert.ok(d.ok);
      // Same st_dev and not in the snapshot, so it is NOT detected. Pinned so nobody assumes it is.
      assert.ok(
        (d.ok ? keysOf(d.value) : []).some((k) => k.startsWith('late/OUTSIDE')),
        'expected the documented residual (mount after snapshot)',
      );
    } finally {
      if (mounted) execSync(`umount -l ${join(root, 'late')}`, { stdio: 'pipe' });
    }
  });
});

test('validateConnection is authorization-first and metadata-only: it returns no evidence or content and opens no file', async () => {
  await withSandbox(async ({ root, outside }) => {
    await tree(root, outside);
    const c1 = opsWith({});
    const denied = await new LocalFilesystemConnector({ fsOps: c1.ops }).validateConnection(
      { sourceType: 'local_filesystem', scope: scopeOf(root) },
      ctxFor(allowRoot(outside, ['filesystem.list'])),
    );
    assert.equal(denied.ok, false);
    assert.equal(c1.calls.length, 0, 'a denied validation touched the filesystem');
    const c2 = opsWith({});
    const okv = await new LocalFilesystemConnector({ fsOps: c2.ops }).validateConnection(
      { sourceType: 'local_filesystem', scope: scopeOf(root) },
      ctxFor(allowRoot(root, ['filesystem.list'])),
    );
    assert.ok(okv.ok);
    assert.deepEqual(Object.keys(okv.ok ? okv.value : {}).sort(), ['details', 'sourceId', 'validatedAt']);
    assert.deepEqual(okv.ok ? okv.value.details : {}, { readable: true });
    assert.ok(!c2.calls.some((c) => c.startsWith('open ')), 'validation opened a file');
  });
});
