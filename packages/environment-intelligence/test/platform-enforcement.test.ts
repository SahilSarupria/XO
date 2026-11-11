/**
 * F6 - platform-level filesystem enforcement. Platform behaviour is driven through the internal FsOps seam
 * (`platform`, `procFdDir`) so every case is deterministic on any host. Only the two cases that exercise the REAL
 * Linux procfs are skipped, and only on a host that is not Linux.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import { DiscoveryErrorCode, LocalFilesystemConnector, type FilesystemScope } from '../src/index.js';
import { NODE_FS_OPS, type FsOps } from '../src/filesystem/fd-walk.js';
import { allowRoot, ctxFor, put, withSandbox } from './helpers.js';

const T = 15_000;
const BOTH = ['filesystem.list', 'filesystem.read'];
const scopeOf = (root: string): FilesystemScope => ({ kind: 'filesystem_root', root }) as FilesystemScope;
const linux = process.platform === 'linux';

function recording(over: Partial<FsOps>): { ops: FsOps; opens: string[]; reads: string[] } {
  const opens: string[] = [];
  const reads: string[] = [];
  const ops: FsOps = {
    ...NODE_FS_OPS,
    ...over,
    async open(p, f) {
      opens.push(p);
      return NODE_FS_OPS.open(p, f);
    },
    async readText(p) {
      reads.push(p);
      return NODE_FS_OPS.readText(p);
    },
  };
  return { ops, opens, reads };
}

async function discover(root: string, ops: FsOps) {
  const c = new LocalFilesystemConnector({ fsOps: ops });
  return c.discover({ sourceType: 'local_filesystem', scope: scopeOf(root) }, ctxFor(allowRoot(root, BOTH), new MockClock()));
}
async function acquire(root: string, keys: string[], ops: FsOps) {
  const c = new LocalFilesystemConnector({ fsOps: ops });
  const ctx = ctxFor(allowRoot(root, BOTH), new MockClock());
  const scope = scopeOf(root);
  const d = await c.detectSource({ sourceType: 'local_filesystem', scope }, ctx);
  assert.ok(d.ok);
  return c.acquireContent({ sourceId: d.ok ? d.value.sourceId : ('x' as never), kind: 'document_content', resourceKeys: keys, scope }, ctx);
}

test('F6 Linux with procfs: hardened discovery and content acquisition are allowed', { timeout: T, skip: !linux }, async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'hello');
    const d = await discover(root, NODE_FS_OPS);
    assert.ok(d.ok);
    const meta = d.ok ? d.value.evidence.find((e) => e.kind === 'metadata') : undefined;
    assert.equal(meta?.payload['traversal'], 'fd_anchored');
    assert.equal(meta?.payload['hardened'], true);
    const a = await acquire(root, ['a.txt'], NODE_FS_OPS);
    assert.ok(a.ok);
    assert.equal(a.ok ? a.value.evidence.length : -1, 1);
  });
});

test(
  'F6 Linux WITHOUT /proc: both operations fail closed, no file opened, no path-based fallback',
  { timeout: T, skip: !linux },
  async () => {
    await withSandbox(async ({ root }) => {
      await put(join(root, 'a.txt'), 'hello');
      const noProc = { platform: 'linux' as const, procFdDir: '/nonexistent/proc-fd' };
      const d = recording(noProc);
      const dr = await discover(root, d.ops);
      assert.ok(!dr.ok && dr.error.code === DiscoveryErrorCode.UNSUPPORTED_OPERATION);
      assert.equal(!dr.ok ? dr.error.context['reason'] : '', 'fd_traversal_unavailable');
      const a = recording(noProc);
      const ar = await acquire(root, ['a.txt'], a.ops);
      assert.ok(!ar.ok && ar.error.code === DiscoveryErrorCode.UNSUPPORTED_OPERATION);
      assert.equal(!ar.ok ? ar.error.context['detail'] : '', 'proc_fd_unreadable');
      assert.deepEqual([...d.opens, ...a.opens], [], 'nothing was opened');
      assert.deepEqual([...d.reads, ...a.reads], [], 'mountinfo/content never read after the probe failed');
    });
  },
);

test('F6 macOS: discovery allowed but labelled unhardened; hardened content acquisition fails closed', { timeout: T }, async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'hello');
    const mac = { platform: 'darwin' as const, procFdDir: '/nonexistent/proc-fd' };
    const d = await discover(root, recording(mac).ops);
    assert.ok(d.ok, 'discovery stays available');
    const meta = d.ok ? d.value.evidence.find((e) => e.kind === 'metadata') : undefined;
    assert.equal(meta?.payload['traversal'], 'path_based_unhardened');
    assert.equal(meta?.payload['hardened'], false);
    const steps = d.ok ? d.value.evidence.flatMap((e) => e.provenance.transformationChain.map((s) => s.step)) : [];
    assert.ok(
      steps.every((s) => !s.includes('fd_walk')),
      'never presented as the hardened walk',
    );
    const a = recording(mac);
    const ar = await acquire(root, ['a.txt'], a.ops);
    assert.ok(!ar.ok && ar.error.code === DiscoveryErrorCode.UNSUPPORTED_OPERATION);
    assert.equal(!ar.ok ? ar.error.context['detail'] : '', 'platform_not_linux');
    assert.deepEqual(a.opens, [], 'no content file opened');
  });
});

test('F6 macOS even with a /proc-like directory present: still no hardened acquisition', { timeout: T, skip: !linux }, async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'hello');
    const a = recording({ platform: 'darwin' as const }); // real /proc present, platform says darwin
    const ar = await acquire(root, ['a.txt'], a.ops);
    assert.ok(!ar.ok);
    assert.equal(!ar.ok ? ar.error.context['detail'] : '', 'platform_not_linux');
    assert.deepEqual(a.opens, []);
  });
});

test('F6 Windows: content acquisition is explicitly refused (distinct reason), nothing opened', { timeout: T }, async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'a.txt'), 'hello');
    const win = recording({ platform: 'win32' as const, procFdDir: 'C:\\nonexistent' });
    const ar = await acquire(root, ['a.txt'], win.ops);
    assert.ok(!ar.ok);
    if (ar.ok) return;
    assert.equal(ar.error.code, DiscoveryErrorCode.UNSUPPORTED_OPERATION);
    assert.equal(ar.error.context['detail'], 'platform_windows_unsupported');
    assert.match(ar.error.message, /Windows/);
    assert.deepEqual(win.opens, []);
    assert.deepEqual(win.reads, []);
  });
});

test(
  'F6 refusal happens AFTER authorization (F12 ordering preserved): unauthorized callers get the authorization error',
  { timeout: T },
  async () => {
    await withSandbox(async ({ root }) => {
      await put(join(root, 'a.txt'), 'hello');
      const win = recording({ platform: 'win32' as const });
      const c = new LocalFilesystemConnector({ fsOps: win.ops });
      const scope = scopeOf(root);
      const ctx = ctxFor(allowRoot(root, BOTH), new MockClock());
      const d = await c.detectSource({ sourceType: 'local_filesystem', scope }, ctx);
      assert.ok(d.ok);
      const denied = await c.acquireContent(
        { sourceId: d.ok ? d.value.sourceId : ('x' as never), kind: 'document_content', resourceKeys: ['a.txt'], scope },
        ctxFor(allowRoot(root, ['filesystem.list']), new MockClock()),
      );
      assert.ok(!denied.ok);
      assert.notEqual(!denied.ok ? denied.error.context['detail'] : '', 'platform_windows_unsupported');
      assert.deepEqual(win.opens, []);
    });
  },
);
