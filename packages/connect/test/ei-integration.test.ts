/**
 * Integration against the REAL Environment Intelligence local-filesystem path (real registry, inventory, connector, audit recorder).
 * Authorization here is EI's DEVELOPMENT-ONLY operator allow-list: it proves Connect honours the gate's answer, NOT that the platform
 * PermissionManager gate is wired (that is a host composition concern; see docs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConnectorRegistry,
  DevelopmentOperatorAuthorization,
  EnvironmentInventory,
  FailClosedAuthorization,
  InMemoryAuditRecorder,
  LocalFilesystemConnector,
  type AuthorizationPort,
  type ConnectorContext,
} from '@xo/environment-intelligence';
import { createConnectService, createEiLocalFolderBackend, InMemoryConnectStateStore } from '../src/index.js';
import { principal } from './support.js';

const alice = principal('alice');

async function withTree(fn: (t: { root: string; outside: string }) => Promise<void>): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'xo-connect-int-')));
  const root = join(base, 'claims');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'policies'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(join(root, 'private'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'a.txt'), 'Invoice INV-1042 approved');
  await writeFile(join(root, 'policies', 'b.md'), '# Policy\nlimit 500');
  await writeFile(join(root, 'private', 'c.txt'), 'private');
  await writeFile(join(root, 'photo.png'), 'not text');
  await writeFile(join(root, 'node_modules', 'dep.txt'), 'dep');
  await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');
  await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
  try {
    await fn({ root, outside });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const build = (authorization: AuthorizationPort) => {
  const registry = new ConnectorRegistry();
  registry.register(new LocalFilesystemConnector());
  const deps = { registry, inventory: new EnvironmentInventory() };
  const audit = new InMemoryAuditRecorder();
  const contextFor = (p: ConnectorContext['principal']): ConnectorContext => ({
    clock: { now: () => new Date() },
    principal: p,
    audit,
    authorization,
  });
  const backend = createEiLocalFolderBackend({ deps, contextFor });
  const svc = createConnectService({ localFolders: true, backend, store: new InMemoryConnectStateStore() });
  return { svc, backend, deps };
};
const allow = (root: string) =>
  new DevelopmentOperatorAuthorization([
    { permission: 'filesystem.list', path: root },
    { permission: 'filesystem.read', path: root },
  ]);

test('real journey: preview lists metadata only, built-in exclusions and symlinks are not offered; connect; read; state is platform-derived', async () => {
  await withTree(async ({ root }) => {
    const { svc } = build(allow(root));
    const pv = await svc.previewFolder(alice, { root });
    assert.ok(pv.ok);
    const keys = pv.value.entries.map((e) => e.key);
    assert.ok(keys.includes('a.txt') && keys.includes('policies/b.md'));
    assert.ok(!keys.some((k) => k.startsWith('node_modules')), 'built-in exclusion');
    assert.ok(!keys.includes('link.txt'), 'symlink out of the root is not listed');
    assert.equal(pv.value.entries.find((e) => e.key === 'photo.png')?.contentAcquirable, false);
    assert.doesNotMatch(JSON.stringify(pv.value), /INV-1042|TOP SECRET/);

    const c = await svc.connectFolder(alice, { root, includeKeys: ['a.txt', 'policies/b.md', 'photo.png'], excludedNames: ['private'] });
    assert.ok(c.ok);
    assert.equal(c.value.source.state, 'awaiting_first_read', 'listing alone is not a read');
    const r = await svc.readNow(alice, c.value.source.id);
    assert.ok(r.ok);
    const rep = r.value.source.history.at(-1)?.read;
    assert.equal(rep?.read, 2);
    assert.equal(rep?.skipped.notAcquirable, 1);
    assert.equal(rep?.status, 'complete');
    assert.equal(r.value.source.state, 'read_complete');
    assert.doesNotMatch(JSON.stringify(r.value), /INV-1042|TOP SECRET/);
    assert.ok(!JSON.stringify(r.value).includes(root), 'the approved path is never returned');
  });
});

test('excluded names are honoured end to end: an excluded folder is neither listed nor selectable', async () => {
  await withTree(async ({ root }) => {
    const { svc } = build(allow(root));
    const pv = await svc.previewFolder(alice, { root, excludedNames: ['private'] });
    assert.ok(pv.ok && !pv.value.entries.some((e) => e.key.startsWith('private')));
    const c = await svc.connectFolder(alice, { root, includeKeys: ['private/c.txt'], excludedNames: ['private'] });
    assert.ok(!c.ok && c.error.code === 'invalid_request');
  });
});

test('fail closed: without an authorization decision nothing is listed, connected or read', async () => {
  await withTree(async ({ root }) => {
    const { svc } = build(new FailClosedAuthorization());
    const pv = await svc.previewFolder(alice, { root });
    assert.ok(!pv.ok && pv.error.code === 'denied');
    const c = await svc.connectFolder(alice, { root, includeKeys: ['a.txt'] });
    assert.ok(!c.ok && c.error.code === 'denied');
    const l = await svc.listSources(alice);
    assert.ok(l.ok && l.value.length === 0);
  });
});

test('scope is enforced by the backend, not only by Connect validation: a key escaping the root reads nothing', async () => {
  await withTree(async ({ root }) => {
    const { backend } = build(allow(root));
    const pv = await backend.list(alice, { root, excludedNames: [] });
    assert.ok(pv.ok);
    for (const key of ['../outside/secret.txt', 'link.txt', '/etc/passwd']) {
      const r = await backend.read(alice, { sourceId: pv.value.sourceId, root, excludedNames: [], keys: [key] });
      assert.ok(!r.ok || r.value.itemsRead === 0, `key ${key} must not be read`);
    }
  });
});

test('a grant for a different folder does not authorize this one', async () => {
  await withTree(async ({ root, outside }) => {
    const { svc } = build(allow(outside));
    const pv = await svc.previewFolder(alice, { root });
    assert.ok(!pv.ok && pv.error.code === 'denied');
  });
});

test('home directory and filesystem root are refused by the platform, surfaced without leaking details', async () => {
  const { svc } = build(allow('/'));
  const r = await svc.previewFolder(alice, { root: '/' });
  assert.ok(!r.ok);
  assert.ok(!JSON.stringify(r).includes('/proc'));
});
