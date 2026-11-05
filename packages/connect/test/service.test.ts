import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectService, FileConnectStateStore, InMemoryConnectStateStore, ConnectStateError } from '../src/index.js';
import { FakeBackend, FlakyStore, entry, principal } from './support.js';

const alice = principal('alice');
const bob = principal('bob');
const setup = () => {
  const backend = new FakeBackend();
  backend.entries = [entry('a.txt'), entry('b.txt'), entry('c.txt'), entry('sub/d.txt'), entry('img.bin', false)];
  const store = new FlakyStore(new InMemoryConnectStateStore());
  const svc = createConnectService({ backend, store, clock: { now: () => new Date('2026-11-02T00:00:00Z') } });
  return { backend, store, svc };
};
const connect = async (s: ReturnType<typeof setup>, keys = ['a.txt', 'b.txt', 'c.txt', 'sub/d.txt', 'img.bin'], who = alice) => {
  const r = await s.svc.connectFolder(who, { root: '/data/claims', includeKeys: keys });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value.source;
};

test('catalog: cloud sources are coming soon, never available', () => {
  const { svc } = setup();
  const c = svc.catalog();
  assert.equal(c.find((e) => e.kind === 'local_folder')?.availability, 'available');
  for (const k of ['microsoft_365', 'google_workspace']) assert.equal(c.find((e) => e.kind === k)?.availability, 'coming_soon');
  assert.doesNotMatch(JSON.stringify(c), /Outlook|SharePoint/);
});

test('unauthenticated callers are refused everywhere and nothing is touched', async () => {
  const s = setup();
  const plain = { kind: 'human', id: 'alice' } as never;
  for (const r of [
    await s.svc.listSources(plain),
    await s.svc.dashboard(plain),
    await s.svc.getSource(plain, 'x'),
    await s.svc.previewFolder(plain, { root: '/a' }),
    await s.svc.connectFolder(plain, { root: '/a', includeKeys: ['a'] }),
    await s.svc.readNow(plain, 'x'),
    await s.svc.disconnect(plain, 'x'),
    await s.svc.reconnect(plain, 'x'),
    await s.svc.updateSelection(plain, 'x', { includeKeys: ['a'] }),
  ])
    assert.ok(!r.ok && r.error.code === 'unauthenticated');
  assert.equal(s.backend.listCalls, 0);
});

test('nothing is preselected and invalid input never reaches the backend', async () => {
  const s = setup();
  const bad: [unknown, string][] = [
    [[], 'empty'],
    [['../x'], 'traversal'],
    [['/etc/passwd'], 'absolute'],
    [['a/../b'], 'dotdot'],
    [['a//b'], 'empty segment'],
    [['a\0'], 'nul'],
    [[1], 'type'],
    ['a.txt', 'not array'],
  ];
  for (const [keys, why] of bad) {
    const r = await s.svc.connectFolder(alice, { root: '/data', includeKeys: keys as never });
    assert.ok(!r.ok && r.error.code === 'invalid_request', why);
  }
  for (const root of ['relative', '/a/../b', '', '/a\0']) {
    const r = await s.svc.connectFolder(alice, { root, includeKeys: ['a.txt'] });
    assert.ok(!r.ok && r.error.code === 'invalid_request', root);
  }
  const bn = await s.svc.connectFolder(alice, { root: '/data', includeKeys: ['a.txt'], excludedNames: ['x/y'] });
  assert.ok(!bn.ok && bn.error.code === 'invalid_request');
  assert.equal(s.backend.listCalls, 0);
  const unknown = await s.svc.connectFolder(alice, { root: '/data', includeKeys: ['nope.txt'] });
  assert.ok(!unknown.ok && unknown.error.code === 'invalid_request');
});

test('preview is listing only and returns real entries with counts', async () => {
  const { svc } = setup();
  const r = await svc.previewFolder(alice, { root: '/data' });
  assert.ok(r.ok);
  assert.equal(r.value.listingOnly, true);
  assert.equal(r.value.summary.files, 5);
  assert.equal(r.value.summary.acquirableFiles, 4);
});

test('connect, list, detail: real state, read-only, no path leaked, owner isolation', async () => {
  const s = setup();
  const src = await connect(s);
  assert.equal(src.displayName, 'claims');
  assert.equal(src.readOnly, true);
  assert.equal(src.dataProvenance, 'live');
  assert.equal(src.state, 'awaiting_first_read');
  assert.doesNotMatch(JSON.stringify(src), /\/data/);
  const list = await s.svc.listSources(alice);
  assert.ok(list.ok && list.value.length === 1);
  const bobList = await s.svc.listSources(bob);
  assert.ok(bobList.ok && bobList.value.length === 0);
  for (const r of [
    await s.svc.getSource(bob, src.id),
    await s.svc.readNow(bob, src.id),
    await s.svc.disconnect(bob, src.id),
    await s.svc.updateSelection(bob, src.id, { includeKeys: ['a.txt'] }),
  ])
    assert.ok(!r.ok && r.error.code === 'not_found');
  const dup = await s.svc.connectFolder(alice, { root: '/data/claims', includeKeys: ['a.txt'] });
  assert.ok(!dup.ok && dup.error.code === 'conflict');
  const dash = await s.svc.dashboard(alice);
  assert.ok(dash.ok && dash.value.connectedSources === 1 && dash.value.knowledge.availability === 'not_available');
});

test('read: only chosen, present, acquirable, non-excluded items reach the backend; chunked; reports counts', async () => {
  const s = setup();
  const src = await connect(s, ['a.txt', 'b.txt', 'sub/d.txt', 'img.bin']);
  const r = await s.svc.readNow(alice, src.id);
  assert.ok(r.ok);
  assert.deepEqual(s.backend.readLog.flat().sort(), ['a.txt', 'b.txt', 'sub/d.txt']);
  assert.ok(s.backend.readLog.every((c) => c.length <= 2));
  const ev = r.value.source.history.at(-1);
  assert.equal(ev?.kind, 'read');
  assert.deepEqual(ev?.read?.skipped, { notIncluded: 0, notAcquirable: 1, vanished: 0 });
  assert.equal(ev?.read?.read, 3);
  assert.equal(ev?.read?.evidence, 'not_retained');
  assert.equal(r.value.source.lastReadAt, '2026-11-02T00:00:00.000Z');
});

test('exclusion by name wins over inclusion and is enforced at read time; vanished items are counted', async () => {
  const s = setup();
  const src = await connect(s, ['a.txt', 'sub/d.txt']);
  const u = await s.svc.updateSelection(alice, src.id, { includeKeys: ['a.txt', 'sub/d.txt'], excludedNames: ['sub'] });
  assert.ok(!u.ok, 'excluded names are filtered out of the listing, so an excluded item is not selectable');
  const u2 = await s.svc.updateSelection(alice, src.id, { includeKeys: ['a.txt'], excludedNames: ['sub'] });
  assert.ok(u2.ok && u2.value.effects.futureReads === 'narrowed' && u2.value.effects.existingKnowledge === 'kept');
  s.backend.entries = s.backend.entries.filter((e) => e.key !== 'a.txt');
  const r = await s.svc.readNow(alice, src.id);
  assert.ok(r.ok);
  assert.equal(r.value.source.history.at(-1)?.read?.skipped.vanished, 1);
  assert.deepEqual(s.backend.readLog, []);
});

test('disconnect stops reading in the backend; knowledge and platform authorization are reported unchanged; reconnect re-checks access', async () => {
  const s = setup();
  const src = await connect(s);
  const d = await s.svc.disconnect(alice, src.id);
  assert.ok(d.ok);
  assert.equal(d.value.source.state, 'disconnected');
  assert.deepEqual(d.value.effects, { futureReads: 'stopped', existingKnowledge: 'kept', platformAuthorization: 'unchanged' });
  const r = await s.svc.readNow(alice, src.id);
  assert.ok(!r.ok && r.error.code === 'conflict');
  assert.deepEqual(s.backend.readLog, []);
  s.backend.listDenied = true;
  const bad = await s.svc.reconnect(alice, src.id);
  assert.ok(!bad.ok && bad.error.code === 'denied');
  const still = await s.svc.getSource(alice, src.id);
  assert.ok(still.ok && still.value.state === 'disconnected');
  s.backend.listDenied = false;
  const ok = await s.svc.reconnect(alice, src.id);
  assert.ok(ok.ok && ok.value.effects.futureReads === 'resumed' && ok.value.source.state === 'awaiting_first_read');
});

test('selection widening and narrowing are reported; no-op changes nothing', async () => {
  const s = setup();
  const src = await connect(s, ['a.txt']);
  const w = await s.svc.updateSelection(alice, src.id, { includeKeys: ['a.txt', 'b.txt'] });
  assert.ok(w.ok && w.value.effects.futureReads === 'widened');
  const same = await s.svc.updateSelection(alice, src.id, { includeKeys: ['b.txt', 'a.txt'] });
  assert.ok(same.ok && same.value.effects.futureReads === 'unchanged');
  assert.equal(same.value.source.history.filter((h) => h.kind === 'selection_changed').length, 1);
  const zero = await s.svc.updateSelection(alice, src.id, { includeKeys: [] });
  assert.ok(!zero.ok && zero.error.code === 'invalid_request');
});

test('failures: a denied or failing read is recorded and never reported as success; persistence failure changes nothing', async () => {
  const s = setup();
  const src = await connect(s);
  s.backend.listDenied = true;
  const r = await s.svc.readNow(alice, src.id);
  assert.ok(r.ok);
  assert.equal(r.value.source.history.at(-1)?.read?.status, 'failed');
  assert.equal(r.value.source.lastReadAt, undefined);
  s.backend.listDenied = false;
  s.backend.readFails = true;
  const r2 = await s.svc.readNow(alice, src.id);
  assert.ok(r2.ok && r2.value.source.history.at(-1)?.read?.status === 'failed');
  s.backend.readFails = false;
  s.store.failSave = true;
  const d = await s.svc.disconnect(alice, src.id);
  assert.ok(!d.ok && d.error.code === 'unavailable' && d.error.retryable);
  s.store.failSave = false;
  const after = await s.svc.getSource(alice, src.id);
  assert.ok(after.ok && after.value.state !== 'disconnected');
  s.store.failLoad = true;
  const l = await s.svc.listSources(alice);
  assert.ok(!l.ok && l.error.code === 'unavailable');
});

test('a second read while one is running is refused', async () => {
  const s = setup();
  const src = await connect(s);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const orig = s.backend.read.bind(s.backend);
  s.backend.read = async (p, r) => {
    await gate;
    return orig(p, r);
  };
  const first = s.svc.readNow(alice, src.id);
  await new Promise((r) => setTimeout(r, 20));
  const second = await s.svc.readNow(alice, src.id);
  assert.ok(!second.ok && second.error.code === 'conflict');
  release();
  assert.ok((await first).ok);
});

test('file store: durable across instances, atomic, and corrupt state is an error, not empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-connect-'));
  try {
    const backend = new FakeBackend();
    backend.entries = [entry('a.txt')];
    const a = createConnectService({ backend, store: new FileConnectStateStore(dir) });
    const c = await a.connectFolder(alice, { root: '/data/x', includeKeys: ['a.txt'] });
    assert.ok(c.ok);
    const b = createConnectService({ backend, store: new FileConnectStateStore(dir) });
    const l = await b.listSources(alice);
    assert.ok(l.ok && l.value.length === 1);
    await writeFile(join(dir, 'connect-state.json'), '{not json');
    await assert.rejects(new FileConnectStateStore(dir).load(), ConnectStateError);
    const broken = await createConnectService({ backend, store: new FileConnectStateStore(dir) }).listSources(alice);
    assert.ok(!broken.ok && broken.error.code === 'unavailable');
    await writeFile(join(dir, 'connect-state.json'), JSON.stringify({ version: 1, sources: { 'x/y': { ownerId: 'z' } } }));
    await assert.rejects(new FileConnectStateStore(dir).load(), ConnectStateError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check re-establishes a missing platform record without reading content, and respects the stop flag', async () => {
  const s = setup();
  const src = await connect(s);
  s.backend.factsValue = undefined;
  const before = await s.svc.getSource(alice, src.id);
  assert.ok(before.ok && before.value.state === 'setup_incomplete' && before.value.attention?.code === 'platform_record_missing');
  s.backend.factsValue = { authorization: 'granted', connection: 'validated', acquisition: 'not_attempted', unavailable: false };
  const r = await s.svc.checkSource(alice, src.id);
  assert.ok(r.ok && r.value.source.state === 'awaiting_first_read');
  assert.deepEqual(s.backend.readLog, [], 'checking never reads content');
  assert.ok(!(await s.svc.checkSource(bob, src.id)).ok);
  await s.svc.disconnect(alice, src.id);
  const stopped = await s.svc.checkSource(alice, src.id);
  assert.ok(!stopped.ok && stopped.error.code === 'conflict');
});

test('previewSource lists the folder with the current selection, only for the owner, and never when disconnected', async () => {
  const s = setup();
  const src = await connect(s, ['a.txt', 'sub/d.txt']);
  const v = await s.svc.previewSource(alice, src.id);
  assert.ok(v.ok);
  assert.deepEqual(v.value.selectedKeys, ['a.txt', 'sub/d.txt']);
  assert.equal(v.value.preview.listingOnly, true);
  assert.ok(v.value.preview.entries.length >= 4);
  assert.doesNotMatch(JSON.stringify(v.value), /\/data/, 'the approved path is never returned');
  assert.ok(!(await s.svc.previewSource(bob, src.id)).ok);
  assert.deepEqual(s.backend.readLog, [], 'listing reads no content');
  await s.svc.disconnect(alice, src.id);
  const stopped = await s.svc.previewSource(alice, src.id);
  assert.ok(!stopped.ok && stopped.error.code === 'conflict');
});
