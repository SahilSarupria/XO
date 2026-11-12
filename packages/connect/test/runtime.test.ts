/**
 * Through the PRODUCTION authorization gate: a real PermissionManager with a RuleBasedPolicy behind `createConnectRuntime`, real
 * connector, real files. Covers D-4 (capabilities), D-6 (composition root) and D-7 (gated listing).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryAuditRecorder } from '@xo/environment-intelligence';
import { PermissionManager, RuleBasedPolicy, parsePermissionId, type PolicyRule } from '@xo/permissions';
import { createConnectRuntime, createConnectService, failResult, okResult, type CapabilityProbe } from '../src/index.js';
import { FakeBackend, entry, principal } from './support.js';
import { InMemoryConnectStateStore } from '../src/index.js';

const allow = (id: string, permission: string, principalId: string): PolicyRule => {
  const p = parsePermissionId(permission);
  if (!p.ok) throw new Error(permission);
  return { id, effect: 'ALLOW', match: { permission: p.value.id, principalId } };
};
const rulesFor = (who: string, perms: string[]): PolicyRule[] => perms.map((p, i) => allow(`${who}-${i}`, p, who));
const ALL = ['filesystem.list', 'filesystem.read', 'data.read', 'data.write'];

async function withDir(fn: (d: { root: string; state: string }) => Promise<void>): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'xo-connect-rt-')));
  const root = join(base, 'docs');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.txt'), 'hello');
  try {
    await fn({ root, state: join(base, 'state') });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
const runtime = (rules: PolicyRule[], state: string) =>
  createConnectRuntime({
    localFolders: true,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy(rules) }),
    audit: new InMemoryAuditRecorder(),
    stateDir: state,
  });

test('production gate: a principal with grants completes the journey; capabilities reflect the grants', async () => {
  await withDir(async ({ root, state }) => {
    const { service } = runtime(rulesFor('alice', ALL), state);
    const alice = principal('alice');
    const caps = await service.capabilities(alice);
    assert.ok(caps.ok);
    assert.deepEqual(caps.value, { viewSources: true, manageSources: true, readKnowledge: true, reviewKnowledge: true, advisory: true });
    const c = await service.connectFolder(alice, { root, includeKeys: ['a.txt'] });
    assert.ok(c.ok, JSON.stringify(c));
    const r = await service.readNow(alice, c.value.source.id);
    assert.ok(r.ok);
    assert.equal(r.value.source.history.at(-1)?.read?.read, 1);
    assert.equal(r.value.source.state, 'read_complete');
  });
});

test('production gate: no grants means no capabilities, no listing, no preview, no connect', async () => {
  await withDir(async ({ root, state }) => {
    const { service } = runtime(rulesFor('alice', ALL), state);
    const mallory = principal('mallory');
    const caps = await service.capabilities(mallory);
    assert.ok(caps.ok && !caps.value.viewSources && !caps.value.manageSources && !caps.value.readKnowledge && !caps.value.reviewKnowledge);
    for (const r of [
      await service.listSources(mallory),
      await service.dashboard(mallory),
      await service.previewFolder(mallory, { root }),
      await service.connectFolder(mallory, { root, includeKeys: ['a.txt'] }),
    ])
      assert.ok(!r.ok && r.error.code === 'denied');
  });
});

test('capabilities are independent: view without manage can list but not change', async () => {
  await withDir(async ({ root, state }) => {
    const owner = runtime(rulesFor('alice', ALL), state).service;
    const alice = principal('alice');
    const c = await owner.connectFolder(alice, { root, includeKeys: ['a.txt'] });
    assert.ok(c.ok);
    // Same state dir, a policy that lets alice view but not manage.
    const viewer = runtime(rulesFor('alice', ['data.read']), state).service;
    const list = await viewer.listSources(alice);
    assert.ok(list.ok && list.value.length === 1);
    for (const r of [
      await viewer.readNow(alice, c.value.source.id),
      await viewer.disconnect(alice, c.value.source.id),
      await viewer.updateSelection(alice, c.value.source.id, { includeKeys: ['a.txt'] }),
    ])
      assert.ok(!r.ok && r.error.code === 'denied');
  });
});

test('connect state survives a restart; the platform record does not, and says so instead of guessing healthy', async () => {
  await withDir(async ({ root, state }) => {
    const alice = principal('alice');
    const first = runtime(rulesFor('alice', ALL), state).service;
    const c = await first.connectFolder(alice, { root, includeKeys: ['a.txt'] });
    assert.ok(c.ok);
    await first.disconnect(alice, c.value.source.id);
    const second = runtime(rulesFor('alice', ALL), state).service;
    const list = await second.listSources(alice);
    assert.ok(list.ok && list.value[0]?.state === 'disconnected', 'the stop flag is durable');
    await second.reconnect(alice, c.value.source.id);
    const again = await second.getSource(alice, c.value.source.id);
    assert.ok(again.ok);
    assert.ok(['awaiting_first_read', 'setup_incomplete'].includes(again.value.state));
  });
});

test('a failing or non-allow gate never yields capabilities', async () => {
  const mk = (probe: CapabilityProbe) =>
    createConnectService({ localFolders: true, backend: new FakeBackend(), store: new InMemoryConnectStateStore(), access: probe });
  const p = principal('alice');
  const down = mk({ probe: async () => failResult('unavailable', 'x', true) });
  const r = await down.listSources(p);
  assert.ok(!r.ok && r.error.code === 'unavailable');
  const none = mk({
    probe: async () =>
      okResult({ viewSources: false, manageSources: false, readKnowledge: false, reviewKnowledge: false, advisory: true as const }),
  });
  assert.ok(!(await none.listSources(p)).ok);
  const noGate = createConnectService({ localFolders: true, backend: new FakeBackend(), store: new InMemoryConnectStateStore() });
  const c = await noGate.capabilities(p);
  assert.ok(!c.ok && c.error.code === 'unavailable', 'no gate configured is unavailable, not allowed');
  const fb = new FakeBackend();
  fb.entries = [entry('a.txt')];
  const view = createConnectService({
    localFolders: true,
    backend: fb,
    store: new InMemoryConnectStateStore(),
    access: {
      probe: async () =>
        okResult({ viewSources: true, manageSources: false, readKnowledge: false, reviewKnowledge: false, advisory: true as const }),
    },
  });
  assert.ok(!(await view.connectFolder(p, { root: '/x', includeKeys: ['a.txt'] })).ok);
  assert.equal(fb.listCalls, 0, 'denied before the backend is touched');
});
