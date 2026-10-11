/**
 * F5 - hard-link policy. POLICY: a regular file with st_nlink > 1 is neither inventoried (discovery) nor acquired
 * (acquisition), reported only as a `hard_linked_file` count. Rationale: other links may sit outside the approved
 * tree and link count cannot say where they are; nlink > 1 is not proof of malice, so this is a conservative
 * fail-closed choice, not a detection. Directories are unaffected. Races (a link or inode swap after the final
 * check) are narrowed by re-checking on the descriptor before and after the read, not eliminated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import { LocalFilesystemConnector, type FilesystemScope } from '../src/index.js';
import { NODE_FS_OPS, type FsOps } from '../src/filesystem/fd-walk.js';
import { allowRoot, ctxFor, put, withSandbox } from './helpers.js';

const T = 15_000;
const BOTH = ['filesystem.list', 'filesystem.read'];
const scopeOf = (root: string): FilesystemScope => ({ kind: 'filesystem_root', root }) as FilesystemScope;
const linux = process.platform === 'linux';

function ops(hooks: { beforeOpen?: (p: string) => Promise<void>; afterRead?: (p: string) => Promise<void> } = {}): {
  ops: FsOps;
  opens: string[];
} {
  const opens: string[] = [];
  return {
    opens,
    ops: {
      ...NODE_FS_OPS,
      async open(p, f) {
        opens.push(p);
        await hooks.beforeOpen?.(p);
        const h = await NODE_FS_OPS.open(p, f);
        if (hooks.afterRead === undefined) return h;
        return new Proxy(h, {
          get(t, prop) {
            if (prop === 'read')
              return async (...a: unknown[]) => {
                const r = await (t.read as (...x: unknown[]) => Promise<unknown>)(...a);
                await hooks.afterRead?.(p);
                return r;
              };
            const v = Reflect.get(t, prop) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          },
        });
      },
    },
  };
}

const discover = (root: string, o: FsOps) =>
  new LocalFilesystemConnector({ fsOps: o }).discover(
    { sourceType: 'local_filesystem', scope: scopeOf(root) },
    ctxFor(allowRoot(root, BOTH), new MockClock()),
  );

async function acquire(root: string, keys: string[], o: FsOps) {
  const c = new LocalFilesystemConnector({ fsOps: o });
  const ctx = ctxFor(allowRoot(root, BOTH), new MockClock());
  const scope = scopeOf(root);
  const d = await c.detectSource({ sourceType: 'local_filesystem', scope }, ctx);
  assert.ok(d.ok);
  return c.acquireContent({ sourceId: d.ok ? d.value.sourceId : ('x' as never), kind: 'document_content', resourceKeys: keys, scope }, ctx);
}

test('F5 single-link files are unaffected (discovery and acquisition)', { timeout: T, skip: !linux }, async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'hello');
    const d = await discover(root, ops().ops);
    assert.ok(d.ok);
    assert.equal(d.ok ? d.value.evidence.filter((e) => e.resourceKey === 'a.txt').length : 0, 1);
    assert.equal(d.ok ? d.value.skipped.byReason['hard_linked_file'] : 1, undefined);
    const a = await acquire(root, ['a.txt'], ops().ops);
    assert.ok(a.ok && a.value.evidence.length === 1 && a.value.status === 'complete');
  });
});

test(
  'F5 hard link to a path OUTSIDE the tree: skipped in discovery, refused in acquisition, never opened',
  { timeout: T, skip: !linux },
  async () => {
    await withSandbox(async ({ root, outside }) => {
      await put(join(outside, 'secret.txt'), 'outside content');
      await link(join(outside, 'secret.txt'), join(root, 'doc.txt'));
      await put(join(root, 'ok.txt'), 'fine');
      const d = await discover(root, ops().ops);
      assert.ok(d.ok);
      if (!d.ok) return;
      assert.deepEqual(
        d.value.evidence.filter((e) => e.kind !== 'metadata').map((e) => e.resourceKey),
        ['ok.txt'],
      );
      assert.equal(d.value.skipped.byReason['hard_linked_file'], 1);
      const o = ops();
      const a = await acquire(root, ['doc.txt', 'ok.txt'], o.ops);
      assert.ok(a.ok);
      if (!a.ok) return;
      assert.deepEqual(
        a.value.evidence.map((e) => e.resourceKey),
        ['ok.txt'],
      );
      assert.equal(a.value.skipped.byReason['hard_linked_file'], 1);
      assert.equal(o.opens.filter((p) => p.endsWith('/doc.txt')).length, 0, 'pre-open lstat check: never opened');
      // Reporting leaks nothing about the other link: no path, inode or count appears in the outcome.
      const text = JSON.stringify(a.value) + JSON.stringify(d.value);
      assert.ok(!text.includes('secret.txt') && !text.includes(outside));
    });
  },
);

test(
  'F5 two links INSIDE the tree are both skipped (link count alone cannot show both are in scope)',
  { timeout: T, skip: !linux },
  async () => {
    await withSandbox(async ({ root }) => {
      await put(join(root, 'one.txt'), 'x');
      await link(join(root, 'one.txt'), join(root, 'two.txt'));
      const d = await discover(root, ops().ops);
      assert.ok(d.ok);
      assert.equal(d.ok ? d.value.skipped.byReason['hard_linked_file'] : 0, 2);
      const a = await acquire(root, ['one.txt', 'two.txt'], ops().ops);
      assert.ok(a.ok && a.value.evidence.length === 0 && a.value.skipped.byReason['hard_linked_file'] === 2);
    });
  },
);

test(
  'F5 once the extra link is removed the file is acquirable again (policy is on current state, not history)',
  { timeout: T, skip: !linux },
  async () => {
    await withSandbox(async ({ root, outside }) => {
      await put(join(outside, 's.txt'), 'x');
      await link(join(outside, 's.txt'), join(root, 'd.txt'));
      const a1 = await acquire(root, ['d.txt'], ops().ops);
      assert.ok(a1.ok && a1.value.evidence.length === 0);
      await unlink(join(outside, 's.txt'));
      const a2 = await acquire(root, ['d.txt'], ops().ops);
      assert.ok(a2.ok && a2.value.evidence.length === 1);
    });
  },
);

test(
  'F5 RACE: link created after the lstat check but before open is caught by the descriptor fstat',
  { timeout: T, skip: !linux },
  async () => {
    await withSandbox(async ({ root, outside }) => {
      await put(join(root, 'r.txt'), 'content');
      const o = ops({
        beforeOpen: async (p) => {
          if (p.endsWith('/r.txt')) await link(join(root, 'r.txt'), join(outside, 'r-alias.txt'));
        },
      });
      const a = await acquire(root, ['r.txt'], o.ops);
      assert.ok(a.ok);
      if (!a.ok) return;
      assert.equal(a.value.evidence.length, 0);
      assert.equal(a.value.skipped.byReason['hard_linked_file'], 1);
      assert.ok(
        o.opens.some((p) => p.endsWith('/r.txt')),
        'it WAS opened (race window), then rejected before any read',
      );
    });
  },
);

test('F5 RACE: link created while the file is being read: content is discarded', { timeout: T, skip: !linux }, async () => {
  await withSandbox(async ({ root, outside }) => {
    await put(join(root, 'r.txt'), 'content');
    const o = ops({
      afterRead: async () => {
        await link(join(root, 'r.txt'), join(outside, 'late-alias.txt'));
      },
    });
    const a = await acquire(root, ['r.txt'], o.ops);
    assert.ok(a.ok);
    if (!a.ok) return;
    assert.equal(a.value.evidence.length, 0, 'no evidence derived from a file whose boundary changed mid-read');
    assert.equal(a.value.skipped.byReason['hard_linked_file'], 1);
  });
});

test('F5 RACE: different inode swapped in between lstat and open is rejected as entry_changed', { timeout: T, skip: !linux }, async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 's.txt'), 'original');
    await put(join(root, 'other.tmp'), 'replacement');
    const o = ops({
      beforeOpen: async (p) => {
        if (p.endsWith('/s.txt')) await rename(join(root, 'other.tmp'), join(root, 's.txt'));
      },
    });
    const a = await acquire(root, ['s.txt'], o.ops);
    assert.ok(a.ok);
    if (!a.ok) return;
    assert.equal(a.value.evidence.length, 0);
    assert.equal(a.value.skipped.byReason['entry_changed'], 1);
  });
});

test('F5 directories (nlink > 1 is normal) are unaffected', { timeout: T, skip: !linux }, async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'd', 'e', 'f.txt'), 'x');
    await writeFile(join(root, 'top.txt'), 't');
    const d = await discover(root, ops().ops);
    assert.ok(d.ok);
    assert.equal(d.ok ? d.value.evidence.filter((e) => e.kind !== 'metadata').length : 0, 2);
  });
});
